package dev.yangshan.schedule

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject

/**
 * 「打开教务系统 →（必要时）填账号 → 等课表页 → 调 __ysCapture」这一整套流程。
 *
 * 之所以单独抽一个类：**有界面的学校窗口（SchoolActivity）和没界面的后台刷新（RefreshWorker）
 * 走的是同一份逻辑**，不能让它们各自实现一遍然后在某次改接口时只改了一边。
 *
 * 与 Windows 壳的 `SchoolForm.CaptureAsync` 是同一个角色。
 */
class SchoolWeb(
    private val context: Context,
    private val web: WebView,
    private val user: String?,
    private val pass: String?,
    private val interactive: Boolean,
    private val listener: Listener,
) {

    interface Listener {
        /** 给人看的进度（后台刷新时没人看，忽略即可）。 */
        fun onStep(message: String)

        /** 抓到了：raw 是 JSON 文本，形状与书签小工具交出来的完全一致。 */
        fun onCaptured(raw: String)

        /** 没抓到：reason 是**能直接显示给用户**的中文原因。 */
        fun onFailed(reason: String)
    }

    companion object {
        const val ENTRY = "https://jwxt.bistu.edu.cn/jwapp/sys/kbapp/*default/index.do"
        private const val SCHOOL_HOST = "jwxt.bistu.edu.cn"
        private const val SSO_HOST = "sso.bistu.edu.cn"

        /** 有人盯着的时候给足时间（要过验证码、要手输），没人盯的静默刷新不等那么久。 */
        private const val TIMEOUT_VISIBLE_MS = 300_000L
        private const val TIMEOUT_SILENT_MS = 120_000L

        /** 课表页要等前端把 XHR 拉完才有数据，所以不在 onPageFinished 立刻抓。 */
        private const val SETTLE_MS = 1200L
    }

    @Volatile
    private var finished = false

    private val handler = Handler(Looper.getMainLooper())
    private val timeout = Runnable { fail("等教务系统响应超时了。检查一下网络，或者重新点一次。") }

    /** 必须由调用方在加载之前调一次：装好 WebViewClient 与 JS 接口。 */
    @SuppressLint("SetJavaScriptEnabled")
    fun attach() {
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.databaseEnabled = true
        web.settings.userAgentString = web.settings.userAgentString + " YangShanShell/0.1.0"
        web.addJavascriptInterface(this, "YangShanNative")
        web.webViewClient = Client()
    }

    fun start() {
        listener.onStep(if (interactive) "正在打开教务系统…" else "正在后台更新课表…")
        handler.postDelayed(timeout, if (interactive) TIMEOUT_VISIBLE_MS else TIMEOUT_SILENT_MS)
        web.loadUrl(ENTRY)
    }

    fun cancel() {
        if (finished) return
        finished = true
        handler.removeCallbacks(timeout)
        listener.onFailed("已取消")
    }

    /** 课表页在跟前台共享 cookie，所以登录态能一直用下去。 */
    fun clearSession() {
        android.webkit.CookieManager.getInstance().removeAllCookies(null)
        web.clearCache(true)
    }

    // ── WebViewClient ───────────────────────────────────────────────────────

    private inner class Client : WebViewClient() {
        override fun onPageFinished(view: WebView, url: String) {
            if (finished) return
            injectCaptureScript()

            val lower = url.lowercase()
            when {
                lower.contains(SSO_HOST) -> onLoginPage(url)
                lower.contains(SCHOOL_HOST) && lower.contains("/jwapp/") -> {
                    listener.onStep("正在读取课表…")
                    handler.postDelayed({ triggerCapture() }, SETTLE_MS)
                }
                else -> listener.onStep("正在打开教务系统…")
            }
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            // 学校站点一律留在壳里（要 cookie）；外面的链接丢给系统浏览器。
            val host = request.url.host ?: return false
            return !(host.endsWith(SCHOOL_HOST) || host.endsWith(SSO_HOST) || host.endsWith("bistu.edu.cn"))
        }

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? = null
    }

    // ── 登录页 ──────────────────────────────────────────────────────────────

    private fun onLoginPage(url: String) {
        if (user.isNullOrBlank() || pass.isNullOrBlank()) {
            listener.onStep("请在这个窗口里登录学校统一身份认证。")
            return
        }
        listener.onStep("正在自动填写账号…")
        web.evaluateJavascript(fillScript(user, pass)) { value ->
            val r = value?.trim('"') ?: ""
            when {
                r == "captcha" -> listener.onStep("登录页要验证码，麻烦你手动填一下。")
                r == "noform" -> listener.onStep("请在这个窗口里登录学校统一身份认证。")
                r == "submitted" -> listener.onStep("已经提交登录，正在等课表…")
                else -> listener.onStep("请在这个窗口里登录学校统一身份认证。")
            }
        }
    }

    /**
     * ★ 登录表单在 iframe 里（sso 首页只是个壳，真表单在 normal/login-normal.html）。
     *   好消息是它**同源**，所以主框架的 JS 能直接摸到 contentDocument，
     *   不需要 Android 侧有任何「按 frame 执行」的 API（WebView 也没有）。
     * ★ 登录页是 Vue 的 v-model：直接 el.value = x 不更新 Vue 状态，
     *   必须走原型上的原生 setter，再派发冒泡的 input/change。
     */
    private fun fillScript(u: String, p: String): String = """
        (function () {
          function docs() {
            var out = [document];
            var fs = document.querySelectorAll('iframe');
            for (var i = 0; i < fs.length; i++) {
              try { if (fs[i].contentDocument) out.push(fs[i].contentDocument); } catch (e) {}
            }
            return out;
          }
          function find(sel) {
            var ds = docs();
            for (var i = 0; i < ds.length; i++) {
              var el = ds[i].querySelector(sel);
              if (el) return el;
            }
            return null;
          }
          function setValue(el, v) {
            var d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
            if (d && d.set) { d.set.call(el, v); } else { el.value = v; }
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
          var U = find('input[name="username"]');
          var P = find('input[name="password"]');
          if (!U || !P) return 'noform';
          setValue(U, ${JSONObject.quote(u)});
          setValue(P, ${JSONObject.quote(p)});
          var box = find('#captchaId, #TencentCaptchaId, #aliCaptchaId, .ali-captcha, .captcha-box');
          if (box && box.offsetParent !== null) return 'captcha';
          var btn = find('button.btn-submit') || find('.btn-submit') || find('button[type="submit"]');
          if (!btn) return 'nobutton';
          setTimeout(function () { btn.click(); }, 200);
          return 'submitted';
        })()
    """.trimIndent()

    // ── 抓取 ────────────────────────────────────────────────────────────────

    private fun injectCaptureScript() {
        val src = try {
            context.assets.open("capture.js").bufferedReader().use { it.readText() }
        } catch (e: Exception) {
            fail("客户端里没有内置抓取脚本，这是个打包问题。")
            return
        }
        web.evaluateJavascript(src, null)
    }

    /**
     * ★ 安卓的 evaluateJavascript **不会 await Promise**（与 Windows 的 ExecuteScriptAsync 一样），
     *   所以结果不靠返回值，而是让页面抓到之后主动 post 回 ShellBridge 这一侧。
     */
    private fun triggerCapture() {
        if (finished) return
        web.evaluateJavascript(CAPTURE_CALL, null)
    }

    @JavascriptInterface
    fun post(json: String?) {
        if (json.isNullOrBlank()) return
        // ★ 这个方法在 WebView 的 JS 线程上被调用，回调里要碰 WebView 与 Activity，
        //   所以整段都挪回主线程处理。
        handler.post { handle(json) }
    }

    private fun handle(json: String) {
        if (finished) return
        val m = try {
            JSONObject(json)
        } catch (e: Exception) {
            return
        }
        when (m.optString("cmd")) {
            "step" -> {
                val text = m.stringOrNull("message")
                if (!text.isNullOrBlank()) listener.onStep(text)
            }
            "captured" -> {
                if (m.optBoolean("ok") && m.stringOrNull("raw") != null) {
                    if (finished) return
                    finished = true
                    handler.removeCallbacks(timeout)
                    listener.onCaptured(m.getString("raw"))
                } else {
                    fail(friendly(m.stringOrNull("error")))
                }
            }
        }
    }

    private fun fail(reason: String) {
        if (finished) return
        finished = true
        handler.removeCallbacks(timeout)
        listener.onFailed(reason)
    }

    private fun friendly(error: String?): String = when (error) {
        null, "" -> "没抓到课表。"
        "__YS_NO_CAPTURE__" -> "抓取脚本没能在教务页面上跑起来，可能是教务系统换了页面结构。"
        else -> error
    }
}

private const val CAPTURE_CALL = """
(function () {
  if (typeof __ysCapture === 'undefined') {
    YangShanNative.post(JSON.stringify({ cmd: 'captured', ok: false, error: '__YS_NO_CAPTURE__' }));
    return;
  }
  __ysCapture({ source: 'android', onStep: function (m) {
    YangShanNative.post(JSON.stringify({ cmd: 'step', message: String(m) }));
  } }).then(function (r) {
    YangShanNative.post(JSON.stringify({ cmd: 'captured', ok: true, raw: JSON.stringify(r) }));
  }).catch(function (e) {
    YangShanNative.post(JSON.stringify({ cmd: 'captured', ok: false, error: String((e && e.message) || e) }));
  });
})()
"""
