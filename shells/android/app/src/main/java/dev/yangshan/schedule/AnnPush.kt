package dev.yangshan.schedule

import android.content.Context
import android.content.Intent
import android.os.Build

/**
 * 公告推送的原生侧配置与开关。
 *
 * 网页端（内核）在用户保存「公告源分享码」时把频道名与公告地址传过来，
 * 这里存进普通 SharedPreferences（**不是**机密信息 —— 频道名泄露的后果见下），
 * 然后据此起停前台服务。
 *
 * 安全支点与网页端一致：ntfy 的消息**永远不携带公告内容**，
 * 它只是一声门铃。真正的内容永远来自 annUrl 那个 JSON。所以频道名就算泄露，
 * 别人也只能让我们多刷一次公告，注入不了任何文字。
 */
object AnnPush {

    private const val FILE = "yangshan_ann"
    private const val K_TOPIC = "topic"
    private const val K_URL = "url"
    private const val K_BASE = "base"
    private const val K_LAST = "lastId"

    const val DEFAULT_BASE = "https://ntfy.sh"

    /** App 是否在前台。前台时网页端自己会弹通知，服务就别重复弹了。 */
    @Volatile
    var appVisible: Boolean = false

    private fun prefs(ctx: Context) =
        ctx.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    fun topic(ctx: Context): String = prefs(ctx).getString(K_TOPIC, "").orEmpty()

    fun annUrl(ctx: Context): String = prefs(ctx).getString(K_URL, "").orEmpty()

    fun base(ctx: Context): String =
        prefs(ctx).getString(K_BASE, DEFAULT_BASE).orEmpty().ifBlank { DEFAULT_BASE }

    /** 上一次已经弹过通知的公告 id —— 用来去重，避免重连后重复打扰。 */
    fun lastId(ctx: Context): String = prefs(ctx).getString(K_LAST, "").orEmpty()

    fun setLastId(ctx: Context, id: String) {
        prefs(ctx).edit().putString(K_LAST, id).apply()
    }

    fun enabled(ctx: Context): Boolean = topic(ctx).isNotBlank()

    /** 写入频道与公告地址，并相应地起停服务。 */
    fun save(ctx: Context, topic: String, annUrl: String, base: String) {
        val t = topic.trim()
        val old = topic(ctx)
        prefs(ctx).edit()
            .putString(K_TOPIC, t)
            .putString(K_URL, annUrl.trim())
            .putString(K_BASE, base.trim().ifBlank { DEFAULT_BASE })
            .apply()
        // 换了频道就等于换了身份：旧的已读记录留着会吞掉新频道的第一条公告。
        if (t != old) prefs(ctx).edit().remove(K_LAST).apply()
        apply(ctx)
    }

    /** 按当前配置把服务调整到该有的状态。任何异常都不外抛 —— 推送不该让 App 打不开。 */
    fun apply(ctx: Context) {
        val app = ctx.applicationContext
        val i = Intent(app, AnnPushService::class.java)
        if (!enabled(ctx)) {
            stop(ctx)
            return
        }
        try {
            if (Build.VERSION.SDK_INT >= 26) app.startForegroundService(i) else app.startService(i)
        } catch (e: Exception) {
            // Android 12 起，后台启动前台服务会被拒（ForegroundServiceStartNotAllowedException）。
            // 这时不重试 —— 用户下次把 App 拿到前台时 Apply 会再走一遍。
        }
    }

    fun stop(ctx: Context) {
        try {
            ctx.applicationContext.stopService(Intent(ctx.applicationContext, AnnPushService::class.java))
        } catch (e: Exception) {
            // 服务本来就没在跑。无所谓。
        }
    }

    fun clear(ctx: Context) {
        prefs(ctx).edit().clear().apply()
        stop(ctx)
    }
}
