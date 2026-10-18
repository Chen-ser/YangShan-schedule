package dev.yangshan.schedule

import android.content.Context
import android.content.Intent
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject

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

    data class Source(
        val id: String,
        val topic: String,
        val url: String,
    )

    private const val FILE = "yangshan_ann"
    private const val K_TOPIC = "topic"
    private const val K_URL = "url"
    private const val K_BASE = "base"
    private const val K_LAST = "lastId"
    private const val K_SOURCES = "sources"

    const val DEFAULT_BASE = "https://ntfy.sh"

    /** App 是否在前台。前台时网页端自己会弹通知，服务就别重复弹了。 */
    @Volatile
    var appVisible: Boolean = false

    private fun prefs(ctx: Context) =
        ctx.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    fun sources(ctx: Context): List<Source> = dedupeByTopic(rawSources(ctx))

    /** 同一频道只保留一条 SSE，但门铃到达后要检查该频道的全部公告源。 */
    fun sourcesForTopic(ctx: Context, topic: String): List<Source> =
        rawSources(ctx).filter { it.topic == topic }

    /**
     * 全体推送之后所有公告源共用同一条 ntfy 频道。
     * 同一个频道开两条 SSE 连接只会让同一条公告弹两次通知，
     * 所以按频道去重：每个频道只留第一条（第一条的 url 足够用来回源拉正文）。
     */
    private fun dedupeByTopic(list: List<Source>): List<Source> {
        val seen = HashSet<String>()
        val out = ArrayList<Source>(list.size)
        for (s in list) {
            if (!seen.add(s.topic)) continue
            out.add(s)
        }
        return out
    }

    private fun rawSources(ctx: Context): List<Source> {
        val p = prefs(ctx)
        val raw = p.getString(K_SOURCES, "").orEmpty()
        if (raw.isNotBlank()) {
            try {
                val arr = JSONArray(raw)
                return (0 until arr.length()).mapNotNull { i ->
                    val o = arr.optJSONObject(i) ?: return@mapNotNull null
                    val id = o.optString("id").trim()
                    val topic = o.optString("topic").trim()
                    val url = o.optString("url").trim()
                    if (id.isBlank() || topic.isBlank() || url.isBlank()) null else Source(id, topic, url)
                }
            } catch (_: Exception) {
                // 坏配置按旧格式尝试恢复，随后 save 会覆盖它。
            }
        }
        val topic = p.getString(K_TOPIC, "").orEmpty().trim()
        val url = p.getString(K_URL, "").orEmpty().trim()
        return if (topic.isNotBlank() && url.isNotBlank()) listOf(Source("legacy", topic, url)) else emptyList()
    }

    /** 旧单源 API 留着给升级兼容和现有静态检查使用。 */
    fun topic(ctx: Context): String = sources(ctx).firstOrNull()?.topic.orEmpty()

    fun annUrl(ctx: Context): String = sources(ctx).firstOrNull()?.url.orEmpty()

    fun base(ctx: Context): String =
        prefs(ctx).getString(K_BASE, DEFAULT_BASE).orEmpty().ifBlank { DEFAULT_BASE }

    /** 上一次已经弹过通知的公告 id —— 用来去重，避免重连后重复打扰。 */
    fun lastId(ctx: Context, sourceId: String = "legacy"): String {
        val raw = prefs(ctx).getString(K_LAST, "").orEmpty()
        if (raw.isBlank()) return ""
        return try { JSONObject(raw).optString(sourceId) } catch (_: Exception) { raw }
    }

    fun setLastId(ctx: Context, sourceId: String, id: String) {
        val p = prefs(ctx)
        val raw = p.getString(K_LAST, "").orEmpty()
        val o = try { if (raw.isBlank()) JSONObject() else JSONObject(raw) } catch (_: Exception) { JSONObject() }
        o.put(sourceId, id)
        p.edit().putString(K_LAST, o.toString()).apply()
    }

    fun enabled(ctx: Context): Boolean = sources(ctx).isNotEmpty()

    /** 写入频道与公告地址，并相应地起停服务。 */
    fun save(ctx: Context, sourcesJson: String, base: String) {
        val next = try {
            val arr = JSONArray(sourcesJson)
            JSONArray().also { out ->
                for (i in 0 until arr.length()) {
                    val item = arr.optJSONObject(i) ?: continue
                    val id = item.optString("id").trim()
                    val topic = item.optString("topic").trim()
                    val url = item.optString("url").trim()
                    if (id.isNotBlank() && topic.isNotBlank() && url.isNotBlank()) {
                        out.put(JSONObject().put("id", id).put("topic", topic).put("url", url))
                    }
                }
            }
        } catch (_: Exception) {
            JSONArray()
        }
        val oldJson = prefs(ctx).getString(K_SOURCES, "").orEmpty()
        prefs(ctx).edit()
            .putString(K_SOURCES, next.toString())
            // 旧键清掉，避免下次升级又被误判为旧配置。
            .remove(K_TOPIC)
            .remove(K_URL)
            .putString(K_BASE, base.trim().ifBlank { DEFAULT_BASE })
            .apply()
        if (next.toString() != oldJson) prefs(ctx).edit().remove(K_LAST).apply()
        // 配置变化时重启监听线程，确保新增/删除的源立即生效。
        stop(ctx)
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
