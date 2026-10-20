package dev.yangshan.schedule

import android.webkit.JavascriptInterface
import org.json.JSONObject

/**
 * 页面 → 壳的唯一入口。注册成 `YangShanNative`，与 shells/shim.js 里那一侧配对：
 *
 *   JS 侧：YangShanNative.post(JSON.stringify(m))
 *   壳 侧：本类的 post(json)  ← @JavascriptInterface
 *
 * 回包走另一条路（壳 evaluateJavascript 调 window.__ysShellReply），因为安卓没有
 * WebView2 那种 postMessage 事件；这个不对称由 shells/shim.js 内部吸收掉了。
 *
 * ★ 注意：@JavascriptInterface 的方法**在 WebView 的 JS 线程上执行**，
 *   所有触及 UI 或 WebView 的动作都必须 post 回主线程（MainActivity 里做了）。
 */
class ShellBridge(private val host: Host) {

    interface Host {
        fun onLogin(id: String, username: String?, password: String?)
        fun onRefresh(id: String)
        fun onStatus(id: String)
        fun onForget(id: String)
        fun onNotify(title: String?, body: String?)
        fun onNotifyReminder(title: String?, body: String?, tag: String?)
        fun onRequestNotifications(id: String)
        fun onRequestBackgroundAccess(id: String)
        fun onOpenAppSettings(id: String)
        fun onPersistState(json: String?, updatedAt: Long)
        fun onOpen(url: String?)
        fun onAnnPush(sourcesJson: String?, base: String?)
    }

    @JavascriptInterface
    fun post(json: String?) {
        if (json.isNullOrBlank()) return
        val m = try {
            JSONObject(json)
        } catch (e: Exception) {
            return
        }

        val cmd = m.optString("cmd")
        val id = m.optString("id")

        when (cmd) {
            "login" -> host.onLogin(id, m.stringOrNull("username"), m.stringOrNull("password"))
            "refresh" -> host.onRefresh(id)
            "status" -> host.onStatus(id)
            "forget" -> host.onForget(id)
            "notify" -> host.onNotify(m.stringOrNull("title"), m.stringOrNull("body"))
            "notifyReminder" -> host.onNotifyReminder(
                m.stringOrNull("title"),
                m.stringOrNull("body"),
                m.stringOrNull("tag"),
            )
            "requestNotifications" -> host.onRequestNotifications(id)
            "requestBackgroundAccess" -> host.onRequestBackgroundAccess(id)
            "openAppSettings" -> host.onOpenAppSettings(id)
            "persistState" -> host.onPersistState(
                m.stringOrNull("json"),
                m.optLong("updatedAt", System.currentTimeMillis()),
            )
            "open" -> host.onOpen(m.stringOrNull("url"))
            // 没有回包：这是单向的设置下发。成功与否由 status 的 annPush 字段反映。
            "annpush" -> host.onAnnPush(
                m.optJSONArray("sources")?.toString() ?: "[]",
                m.stringOrNull("base"),
            )
        }
    }
}

/** org.json 的 optString 缺字段时返回 ""，这里要的是 null（空口令与没有口令不是一回事）。 */
internal fun JSONObject.stringOrNull(name: String): String? =
    if (has(name) && !isNull(name)) getString(name) else null
