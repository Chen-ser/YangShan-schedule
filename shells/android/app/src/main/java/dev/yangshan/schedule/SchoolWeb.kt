package dev.yangshan.schedule

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebChromeClient
import android.webkit.ConsoleMessage
import android.webkit.SslErrorHandler
import android.net.Uri
import android.net.http.SslError
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

        /**
         * ★ 必须报**桌面版** UA，不能报安卓 UA。
         *
         * 教务系统按 UA 分流：安卓 UA 会被 SSO 送到 `normal/login-mobile.html`（Vant 手机版），
         * 而且课表页也走手机分支 —— 手机分支里**没有课表页**。真机上的表现就是
         * 「登录过去了，但页面是空白，什么也抓不到」。Windows 壳用的是桌面版 WebView2，
         * 所以它一直是好的 —— 这就是两边唯一的差别。
         *
         * 顺带一个好处：桌面版登录页 `normal/login-normal.html` 正是 [fillScript] 的
         * 选择器（`input[name=username]` / `button.btn-submit`）照着写的那一版。
         */
        /**
         * 尾部的 `YangShanShell/<版本>` 直接从 BuildConfig 取，不再手写。
         * 手写过一次 `0.2.0`，而全局版本那时是 0.1.9 —— 给教务系统报一个不存在的
         * 版本，查日志时对不上账。
         */
        private val DESKTOP_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 YangShanShell/${BuildConfig.VERSION_NAME}"

        /** 有人盯着的时候给足时间（要过验证码、要手输），没人盯的静默刷新不等那么久。 */
        private const val TIMEOUT_VISIBLE_MS = 300_000L
        private const val TIMEOUT_SILENT_MS = 120_000L

        /** 课表页要等前端把 XHR 拉完才有数据，所以不在 onPageFinished 立刻抓。 */
        private const val SETTLE_MS = 1200L

        /**
         * ★ 登录表单在 iframe 里，比主框架的 onPageFinished 晚几百毫秒才建好
         *   （实测差约 380ms）。只试一次必然拿到 `noform`，所以要轮询。
         *   一旦真的填进去并点过提交就停手，免得覆盖用户自己手输的内容。
         */
        private const val FILL_POLL_MS = 400L
        private const val FILL_MAX_TRIES = 40 // 40 × 400ms ≈ 16s

        /** 抓取失败但可能只是「页面还在换」时，重来几次，别让用户重走一遍登录。 */
        private const val CAPTURE_RETRY_MS = 1500L
        private const val CAPTURE_MAX_TRIES = 5
    }

    @Volatile
    private var finished = false

    private val handler = Handler(Looper.getMainLooper())
    private val timeout =
        Runnable { fail("等教务系统响应超时了。检查一下网络，或者重新点一次。" + where()) }

    /** 最近一次 onPageFinished 的地址：失败时附在原因里，真机上截个图就能定位。 */
    private var lastUrl = ""

    /** 自动填表已经真的动过手了（提交过、或撞上验证码）——之后不再碰表单。 */
    private var fillDone = false
    private var fillTries = 0
    private var captureTries = 0

    /** 必须由调用方在加载之前调一次：装好 WebViewClient 与 JS 接口。 */
    @SuppressLint("SetJavaScriptEnabled")
    fun attach() {
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.databaseEnabled = true
        // 教务登录会在 jwxt 与 sso 两个子域之间跳转；WebView 默认可能拒绝
        // iframe/跨子域 Cookie，表现为“登录成功后接口仍返回登录页”。
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)
        // ★ 直接换成桌面版 UA。这里**不能**再拿 web.settings.userAgentString 去拼尾巴 ——
        //   那样得到的还是「安卓 UA + 后缀」，正好落进要躲开的那条手机分支。
        web.settings.userAgentString = DESKTOP_UA
        // 桌面版页面是定宽的，手机上必须允许缩放并整体缩到屏幕宽，否则只看得到左上角一块。
        web.settings.useWideViewPort = true
        web.settings.loadWithOverviewMode = true
        web.settings.setSupportZoom(true)
        web.settings.builtInZoomControls = true
        web.settings.displayZoomControls = false
        web.addJavascriptInterface(this, "YangShanNative")
        web.webViewClient = Client()
        web.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                if (message.messageLevel() == ConsoleMessage.MessageLevel.ERROR) {
                    DiagLog.event(
                        "console-error source=${DiagLog.url(message.sourceId())} " +
                            "line=${message.lineNumber()} chars=${message.message().length}",
                    )
                }
                return true
            }
        }
    }

    fun start() {
        DiagLog.begin(context, interactive)
        DiagLog.event("start entry=${DiagLog.url(ENTRY)}")
        listener.onStep(if (interactive) "正在打开教务系统…" else "正在后台更新课表…")
        handler.postDelayed(timeout, if (interactive) TIMEOUT_VISIBLE_MS else TIMEOUT_SILENT_MS)
        web.loadUrl(ENTRY)
    }

    fun cancel() {
        if (finished) return
        DiagLog.event("cancel")
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
            lastUrl = url
            DiagLog.event("page-finished url=${DiagLog.url(url)}")
            DiagLog.event(
                "cookies jwxt=${CookieManager.getInstance().getCookie(ENTRY) != null} " +
                    "sso=${CookieManager.getInstance().getCookie("https://$SSO_HOST/") != null}",
            )
            view.evaluateJavascript(
                "JSON.stringify({origin:location.origin,base:document.baseURI," +
                    "online:navigator.onLine,secure:isSecureContext,fetch:typeof fetch})",
            ) { value ->
                if (!finished && !value.isNullOrBlank()) DiagLog.event("document-context $value")
            }
            injectCaptureScript()

            val lower = url.lowercase()
            when {
                lower.contains(SSO_HOST) || lower.contains("/normal/login") -> onLoginPage(url)
                // ★ 只要落在教务系统的域上就抓，不再额外要求路径里有 `/jwapp/`：
                //   抓取脚本只调接口、不看 DOM，登录后落到哪个页面都无所谓。
                lower.contains(SCHOOL_HOST) -> {
                    listener.onStep("正在读取课表…")
                    handler.postDelayed({ triggerCapture() }, SETTLE_MS)
                }
                else -> listener.onStep("正在打开教务系统…")
            }
        }

        override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
            if (!finished) DiagLog.event("page-started url=${DiagLog.url(url)}")
            super.onPageStarted(view, url, favicon)
        }

        override fun onReceivedError(
            view: WebView,
            request: WebResourceRequest,
            error: android.webkit.WebResourceError,
        ) {
            if (!finished && (request.isForMainFrame || request.url.host?.endsWith("bistu.edu.cn") == true)) {
                DiagLog.event(
                    "resource-error mainFrame=${request.isForMainFrame} url=${DiagLog.url(request.url.toString())} " +
                        "code=${error.errorCode} desc=${error.description}",
                )
            }
            super.onReceivedError(view, request, error)
        }

        override fun onReceivedHttpError(
            view: WebView,
            request: WebResourceRequest,
            errorResponse: WebResourceResponse,
        ) {
            if (!finished && (request.isForMainFrame || request.url.host?.endsWith("bistu.edu.cn") == true)) {
                DiagLog.event(
                    "resource-http mainFrame=${request.isForMainFrame} url=${DiagLog.url(request.url.toString())} " +
                        "status=${errorResponse.statusCode}",
                )
            }
            super.onReceivedHttpError(view, request, errorResponse)
        }

        override fun onReceivedSslError(
            view: WebView,
            handler: SslErrorHandler,
            error: SslError,
        ) {
            val url = error.url.orEmpty()
            if (!finished) {
                val cert = error.certificate
                val issuer = cert.issuedBy?.dName.orEmpty().take(180)
                val subject = cert.issuedTo?.dName.orEmpty().take(180)
                DiagLog.event(
                    "ssl-error rejected url=${DiagLog.url(url)} primary=${error.primaryError} " +
                        "subject=$subject issuer=$issuer",
                )
            }
            // 只对学校域名、明确的 SSL_UNTRUSTED、匹配学校通配证书且仍在有效期内的
            // 情况做窄范围恢复。其他错误（过期、主机名不匹配、非学校域名）一律拒绝，
            // 不能为了让登录成功而放行任意证书。
            if (isExpectedSchoolCertificate(error)) {
                DiagLog.event("ssl-error proceed-school-cert url=${DiagLog.url(url)}")
                handler.proceed()
            } else {
                handler.cancel()
            }
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            // 学校站点一律留在壳里（要 cookie）；外面的链接丢给系统浏览器。
            val host = request.url.host ?: return false
            return !(host.endsWith(SCHOOL_HOST) || host.endsWith(SSO_HOST) || host.endsWith("bistu.edu.cn"))
        }

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? = null
    }

    private fun isExpectedSchoolCertificate(error: SslError): Boolean {
        if (error.primaryError != SslError.SSL_UNTRUSTED) return false
        val host = Uri.parse(error.url.orEmpty()).host?.lowercase() ?: return false
        if (host != "bistu.edu.cn" && !host.endsWith(".bistu.edu.cn")) return false
        val cert = error.certificate ?: return false
        val subject = cert.issuedTo?.dName.orEmpty()
        val issuer = cert.issuedBy?.dName.orEmpty()
        val subjectMatches = subject.contains("CN=*.bistu.edu.cn", ignoreCase = true) ||
            subject.contains("CN=$host", ignoreCase = true)
        val issuerMatches = issuer.contains("GlobalSign RSA OV SSL CA 2018", ignoreCase = true)
        val now = java.util.Date()
        val inDateRange = cert.validNotBeforeDate?.before(now) == true &&
            cert.validNotAfterDate?.after(now) == true
        return subjectMatches && issuerMatches && inDateRange
    }

    // ── 登录页 ──────────────────────────────────────────────────────────────

    private fun onLoginPage(url: String) {
        DiagLog.event("login-page url=${DiagLog.url(url)} fillTries=$fillTries")
        if (user.isNullOrBlank() || pass.isNullOrBlank()) {
            listener.onStep("请在这个窗口里登录学校统一身份认证。")
            return
        }
        if (fillDone) {
            // 已经自动提交过一次了（多半是口令不对），现在把窗口交还给用户，不要再抢输入框。
            listener.onStep("请在这个窗口里登录学校统一身份认证。")
            return
        }
        if (fillTries == 0) listener.onStep("正在自动填写账号…")
        fillTries++
        web.evaluateJavascript(fillScript(user, pass)) { value ->
            if (finished) return@evaluateJavascript
            when (val r = value?.trim('"') ?: "") {
                "captcha" -> {
                    DiagLog.event("login-form captcha")
                    fillDone = true
                    listener.onStep("登录页要验证码，麻烦你手动填一下。")
                }
                "submitted" -> {
                    DiagLog.event("login-form submitted")
                    fillDone = true
                    listener.onStep("已经提交登录，正在等课表…")
                }
                "noform" -> {
                    DiagLog.event("login-form not-ready try=$fillTries")
                    // ★ 表单在 iframe 里，比 onPageFinished 晚几百毫秒才建好 ——
                    //   实测 t=647ms 顶层才 complete，t=1025ms 表单才出现（差约 380 ms）。
                    //   所以第一次调这个脚本基本必然落在这里，靠轮询解决。
                    //   排队等下一次的时候要再确认「人还在登录页」——不然跳到课表页之后
                    //   这些迟到的重试会把状态栏文字又改回「请登录」，把真正的进度盖掉。
                    if (fillTries < FILL_MAX_TRIES) {
                        handler.postDelayed({
                            if (!finished && lastUrl.lowercase().contains(SSO_HOST)) onLoginPage(lastUrl)
                        }, FILL_POLL_MS)
                    } else {
                        listener.onStep("请在这个窗口里登录学校统一身份认证。")
                    }
                }
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
     * ★ 桌面版登录页是「扫码 / 账号密码 / 短信」三页签，而且**选中的是哪一个会被记住**：
     *   源码里 `loginType: 'username-password'` 只是初值，紧接着就被
     *   `localStorage.getItem('loginType')` 覆盖 —— 所以完全可能停在扫码或短信页，
     *   那时账号口令表单还在 DOM 里、只是被 v-show 藏着。
     *   填是照样能填（v-model 不挑可见性），但用户接手时要看见对的那一屏，所以先切过去。
     * ★ 验证码框在源码里是 `v-if="showCaptcha"` —— 不需要时**根本不存在**，
     *   所以判「有没有」就够，**不能**判可见性（详见脚本里的注释）。
     * ★ 同一页上 `button.btn-submit` 会同时命中扫码页的「刷新二维码」，
     *   按 DOM 顺序取第一个会点错按钮，所以要按「看得见 + 写着登录」来挑。
     */
    private fun fillScript(u: String, p: String): String = """
        (function () {
          function docs() {
            var out = [];
            function add(doc) {
              if (!doc || out.indexOf(doc) >= 0) return;
              out.push(doc);
              var fs = doc.querySelectorAll('iframe');
              for (var i = 0; i < fs.length; i++) {
                try { add(fs[i].contentDocument); } catch (e) {}
              }
            }
            add(document);
            return out;
          }
          function findAll(sel) {
            var ds = docs(), out = [];
            for (var i = 0; i < ds.length; i++) {
              var ns = ds[i].querySelectorAll(sel);
              for (var j = 0; j < ns.length; j++) out.push(ns[j]);
            }
            return out;
          }
          function find(sel) { var a = findAll(sel); return a.length ? a[0] : null; }
          function visible(el) { return !!el && el.offsetParent !== null; }

          // 页签选中的是哪一个会被 localStorage 记住（可能是扫码/短信页），
          // 而账号口令表单被 v-show 藏着。先切到「账号密码」，
          // 用户接手时才能看见自己该看的那一屏。
          var tabs = findAll('.content-tabs-title > div, [role="tab"], .tabs-title > *');
          for (var i = 0; i < tabs.length; i++) {
            if (/账号密码|帳號密碼|password/i.test(tabs[i].textContent || '')) {
              tabs[i].click();
              break;
            }
          }

          // 有些版本用 v-if，切页签后才把输入框插入 DOM；这次找不到就交给
          // 外层轮询，下一轮会在 Vue 更新完成后重新查找。
          var U = find('input[name="username"], input#username, input[autocomplete="username"]');
          var P = find('input[name="password"], input#password, input[autocomplete="current-password"]');
          if (!U || !P) return 'noform';

          function setValue(el, v) {
            var d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
            if (d && d.set) { d.set.call(el, v); } else { el.value = v; }
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
          setValue(U, ${JSONObject.quote(u)});
          setValue(P, ${JSONObject.quote(p)});

          // ★ 只判「在不在」，不判「看不看得见」：这段标记是 v-if 控制的，
          //   不需要验证码时它压根不在 DOM 里。反过来，用 offsetParent 判会踩两个坑 ——
          //   它所在的「账号密码」面板可能正被 v-show 藏着（页签是 localStorage 记忆的，
          //   可能是扫码/短信页，那就永远判不到），而且 v-show 要下一帧才生效。
          //   结果是盲提交、只剩一句看不懂的「登录失败」。宁可为「要验证码」多问一句。
          if (find('#captchaId, #TencentCaptchaId, #aliCaptchaId, .ali-captcha, .captcha-box')) {
            return 'captcha';
          }

          var btns = findAll('button.btn-submit, .btn-submit, button[type="submit"]');
          for (var i = 0; i < btns.length; i++) {
            if (!visible(btns[i])) continue;
            if (/刷新|Refresh/i.test(btns[i].textContent || '')) continue;
            (function (b) { setTimeout(function () { b.click(); }, 200); })(btns[i]);
            return 'submitted';
          }

          // 兜底：输入框上本来就挂着 @keyup.enter="login"，回车一样能提交，
          // 而且完全不受页签与按钮顺序的影响。
          P.dispatchEvent(new KeyboardEvent('keyup', {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true,
          }));
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
        DiagLog.event("capture-script injected bytes=${src.length}")
        web.evaluateJavascript(src, null)
    }

    /**
     * ★ 安卓的 evaluateJavascript **不会 await Promise**（与 Windows 的 ExecuteScriptAsync 一样），
     *   所以结果不靠返回值，而是让页面抓到之后主动 post 回 ShellBridge 这一侧。
     */
    private fun triggerCapture() {
        if (finished) return
        captureTries++
        CookieManager.getInstance().flush()
        DiagLog.event("capture-call try=$captureTries url=${DiagLog.url(lastUrl)}")
        web.evaluateJavascript(CAPTURE_CALL, null)
    }

    /**
     * 这次失败是不是「再等一下就好」。刚跳完转的页面上常见两种：
     * 脚本还没落地（`__YS_NO_CAPTURE__`），以及接口回了登录页 HTML 而不是 JSON（解析报错）。
     */
    private fun retryable(error: String?): Boolean {
        if (error.isNullOrBlank()) return true
        if (error == "__YS_NO_CAPTURE__") return true
        if (error.contains("HTTP ")) return true
        return error.contains("Unexpected token") || error.contains("JSON")
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
            "log" -> m.stringOrNull("message")?.let { DiagLog.event("capture-log $it") }
            "step" -> {
                val text = m.stringOrNull("message")
                if (!text.isNullOrBlank()) DiagLog.event("capture-step $text")
                if (!text.isNullOrBlank()) listener.onStep(text)
            }
            "captured" -> {
                if (m.optBoolean("ok") && m.stringOrNull("raw") != null) {
                    DiagLog.event("capture-success rawChars=${m.getString("raw").length}")
                    if (finished) return
                    finished = true
                    handler.removeCallbacks(timeout)
                    listener.onCaptured(m.getString("raw"))
                } else {
                    val err = m.stringOrNull("error")
                    DiagLog.event("capture-failure error=${err.orEmpty()}")
                    // ★ 页面刚换过去时脚本可能还没落地、或接口暂时返回登录页 —— 这两种重试就好，
                    //   没必要把用户打回去重走一遍登录。
                    if (retryable(err) && captureTries < CAPTURE_MAX_TRIES) {
                        listener.onStep("课表页还没准备好，正在重试（$captureTries/$CAPTURE_MAX_TRIES）…")
                        handler.postDelayed({
                            if (finished) return@postDelayed
                            injectCaptureScript()
                            triggerCapture()
                        }, CAPTURE_RETRY_MS)
                    } else {
                        fail(friendly(err))
                    }
                }
            }
        }
    }

    private fun fail(reason: String) {
        if (finished) return
        DiagLog.event("failed reason=$reason")
        finished = true
        handler.removeCallbacks(timeout)
        listener.onFailed(reason)
    }

    private fun friendly(error: String?): String = when {
        error.isNullOrBlank() -> "没抓到课表。" + where()
        error == "__YS_NO_CAPTURE__" ->
            "抓取脚本没能在教务页面上跑起来，可能是教务系统换了页面结构。" + where()
        else -> error + where()
    }

    /** 失败原因后面缀上「当时在哪个页面」——真机上截个图就能定位，省一轮来回问。 */
    private fun where(): String = if (lastUrl.isBlank()) "" else "\n（当时停在：$lastUrl）"
}

private const val CAPTURE_CALL = """
(function () {
  if (typeof __ysCapture === 'undefined') {
    YangShanNative.post(JSON.stringify({ cmd: 'captured', ok: false, error: '__YS_NO_CAPTURE__' }));
    return;
  }
  __ysCapture({ source: 'android', onStep: function (m) {
    YangShanNative.post(JSON.stringify({ cmd: 'step', message: String(m) }));
  }, onLog: function (m) {
    YangShanNative.post(JSON.stringify({ cmd: 'log', message: String(m) }));
  } }).then(function (r) {
    YangShanNative.post(JSON.stringify({ cmd: 'captured', ok: true, raw: JSON.stringify(r) }));
  }).catch(function (e) {
    YangShanNative.post(JSON.stringify({ cmd: 'captured', ok: false, error: String((e && e.message) || e) }));
  });
})()
"""
