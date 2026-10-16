package dev.yangshan.schedule

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject

/**
 * 课表内核的主窗口。
 *
 * 它做的事和 Windows 壳的 MainForm 一模一样，只是换了平台：
 *   1. 把内核托在 https://appassets.androidplatform.net/ 这个虚拟源上显示出来；
 *   2. 注入 shells/shim.js（安卓这边在打包时就烘进 index.html 了，见 tools/prepare-assets.mjs）；
 *   3. 收到内核要登录/刷新时，开 SchoolActivity 去学校页面上抓。
 */
class MainActivity : Activity(), ShellBridge.Host {

    companion object {
        private const val ORIGIN = "https://appassets.androidplatform.net"
        private const val ENTRY_URL = "$ORIGIN/assets/index.html"
        private const val REQ_LOGIN = 4001
        private const val REQ_NOTIFY = 4002
    }

    private lateinit var web: WebView

    /** 正在处理的请求 id（来自 shim 那一侧的 id），抓完用它把结果送回去。 */
    private var pendingId: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Android 13 起通知要用户点头。不给也能用，只是后台刷新完没法提示。
        if (Build.VERSION.SDK_INT >= 33) {
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFY)
        }

        web = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true // 内核靠 localStorage 存课表
            settings.databaseEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.mediaPlaybackRequiresUserGesture = true
        }
        web.addJavascriptInterface(ShellBridge(this), "YangShanNative")

        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                loader.shouldInterceptRequest(request.url)

            override fun onPageFinished(view: WebView, url: String) {
                if (url.startsWith(ORIGIN)) restoreIfNeeded()
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                if (url.startsWith(ORIGIN)) return false
                open(url)
                return true
            }
        }

        setContentView(web)
        web.loadUrl(ENTRY_URL)

        AutoRefresh.schedule(this)

        // 服务可能被系统杀过（省电、内存），这里按已存的配置把它恢复回来。
        // 没配过频道时 AnnPush.apply 什么也不做。
        AnnPush.apply(this)
    }

    override fun onResume() {
        super.onResume()
        // 前台时网页端自己会弹通知（点了还能直接跳到那条公告），
        // 告诉服务别重复弹。
        AnnPush.appVisible = true
    }

    override fun onPause() {
        AnnPush.appVisible = false
        super.onPause()
    }

    // ── 内核 → 壳的请求（ShellBridge.Host）────────────────────────────────────

    override fun onLogin(id: String, username: String?, password: String?) {
        if (username.isNullOrBlank() || password.isNullOrBlank()) {
            replyError(id, "账号和密码都要填。")
            return
        }
        pendingId = id
        val i = Intent(this, SchoolActivity::class.java)
            .putExtra(SchoolActivity.EXTRA_USER, username)
            .putExtra(SchoolActivity.EXTRA_PASS, password)
            .putExtra(SchoolActivity.EXTRA_REMEMBER, Creds.remember(this))
        startActivityForResult(i, REQ_LOGIN)
    }

    override fun onRefresh(id: String) {
        val stored = Creds.load(this)
        if (stored == null) {
            replyError(id, "还没有记住账号，先在学校账号那一栏登录一次。")
            return
        }
        pendingId = id
        val i = Intent(this, SchoolActivity::class.java)
            .putExtra(SchoolActivity.EXTRA_USER, stored.first)
            .putExtra(SchoolActivity.EXTRA_PASS, stored.second)
            .putExtra(SchoolActivity.EXTRA_REMEMBER, false)
        startActivityForResult(i, REQ_LOGIN)
    }

    override fun onStatus(id: String) {
        // YangShan.hasSchedule() 是个同步函数，但只有页面里才有它。
        web.evaluateJavascript(
            "(globalThis.YangShan && typeof YangShan.hasSchedule === 'function')" +
                " ? String(YangShan.hasSchedule()) : 'false'"
        ) { value ->
            val creds = Creds.load(this)
            val status = JSONObject()
                .put("name", "android")
                .put("version", "0.1.0")
                .put("hasSchedule", value?.trim('"') == "true")
                .put("remembered", creds != null)
                .put("autoRefresh", true)
                .put("autoRefreshMinutes", 60)
                // 关掉 App 也能收到公告 —— 由前台服务维持一条到 ntfy 的长连接。
                .put("annPush", AnnPush.enabled(this) && AnnPushService.active)
            if (creds != null) status.put("username", creds.first) else status.put("username", JSONObject.NULL)
            val payload = JSONObject()
                .put("id", id)
                .put("ok", true)
                .put("pack", status)
            reply(payload)
        }
    }

    override fun onForget(id: String) {
        Creds.clear(this)
        Store.clear(this)
        replyOk(id, "{}")
    }

    override fun onNotify(title: String?, body: String?) {
        runOnUiThread { Notify.show(this, title ?: "仰山课表", body.orEmpty()) }
    }

    override fun onOpen(url: String?) {
        if (!url.isNullOrBlank()) open(url)
    }

    /**
     * 网页端保存「公告源」时把频道名与公告地址送过来。
     *
     * 单向：不回包。成功与否由下一次 `status` 的 `annPush` 字段说话 ——
     * 前台服务是异步起来的，此刻回「成功」是不诚实。
     */
    override fun onAnnPush(topic: String?, annUrl: String?, base: String?) {
        val t = topic.orEmpty().trim()
        if (t.isBlank()) {
            AnnPush.clear(this)
            return
        }
        AnnPush.save(this, t, annUrl.orEmpty(), base.orEmpty())
    }

    // ── 抓取回来的路上 ──────────────────────────────────────────────────────

    @Deprecated("Activity 自带的回调，用的是老签名")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_LOGIN) return

        val id = pendingId
        pendingId = null
        if (id == null) return

        val raw = data?.getStringExtra(SchoolActivity.EXTRA_RAW)
        if (resultCode == RESULT_OK && !raw.isNullOrBlank()) {
            Store.saveRaw(this, raw)
            replyOk(id, raw)
        } else {
            replyError(id, data?.getStringExtra(SchoolActivity.EXTRA_ERROR) ?: "没有抓到课表。")
        }
    }

    /**
     * 内核自己会把课表存进 localStorage，正常情况下用不上这里。
     * 但换手机、清数据、重装之后 localStorage 会空 —— 那时用 Store 里的备份把它填回去。
     */
    private fun restoreIfNeeded() {
        val raw = Store.raw(this) ?: return
        val rawAt = Store.rawAt(this)
        val js = """
            (function () {
              if (!globalThis.YangShan) return 'no-bridge';
              var localAt = Number(localStorage.getItem('yangshan-schedule/v1/updatedAt') || 0);
              if (YangShan.hasSchedule() && localAt >= ${rawAt} && ${rawAt} > 0) return 'local-newer';
              try { YangShan.importText(${JSONObject.quote(raw)}); return 'restored'; }
              catch (e) { return 'error: ' + e.message; }
            })()
        """.trimIndent()
        web.evaluateJavascript(js, null)
    }

    // ── 回包 ────────────────────────────────────────────────────────────────

    private fun replyOk(id: String, packJson: String) {
        val payload = JSONObject().put("id", id).put("ok", true)
        try {
            payload.put("pack", JSONObject(packJson))
        } catch (e: Exception) {
            replyError(id, "抓到的数据不完整。")
            return
        }
        reply(payload)
    }

    private fun replyError(id: String, message: String) {
        reply(JSONObject().put("id", id).put("ok", false).put("error", message))
    }

    /**
     * ★ 安卓没有 WebView2 那种 postMessage，回包得靠 evaluateJavascript 调 shim 里的
     *   `__ysShellReply`。这个不对称由 shells/shim.js 内部吸收掉了。
     */
    private fun reply(payload: JSONObject) {
        val js = "__ysShellReply(" + JSONObject.quote(payload.toString()) + ")"
        web.post { web.evaluateJavascript(js, null) }
    }

    private fun open(url: String) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        } catch (e: Exception) {
            // 手机上没有能打开它的应用 —— 不是错误，算了。
        }
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }
}
