package dev.yangshan.schedule

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * 公告推送的前台服务。
 *
 * ## 为什么是前台服务
 *
 * 安卓上「App 关掉还能收到消息」只有三条路：
 *   1. 厂商推送通道（国内各家各自一套，装不齐）；
 *   2. FCM —— **在校园网里连不通**（实测 `fcm.googleapis.com` 直连超时），这条路是死的；
 *   3. 一个自己维持长连接的前台服务（就是这里）。
 *
 * 所以只能选 3，代价是通知栏里常驻一条 —— 那条通知走的是 IMPORTANCE_MIN 的独立渠道，
 * 用户可以在系统设置里只把它静音掉。
 *
 * ## 它到底连的是什么
 *
 * `GET https://ntfy.sh/<topic>/sse`，一条标准的 Server-Sent Events 长连接。
 * ntfy 每收到一条 publish 就往这条连接推一行 `data: {...,"event":"message",...}`。
 *
 * ★ **推送的内容永远不被信任**：ntfy 的消息只是一声门铃，正文固定是 `new`。
 *   真正的公告内容由本服务自己去 annUrl 拉那个 JSON —— 与网页端完全同一条规则。
 *   这样频道名即使泄露，也只能让我们多拉一次公告，注入不了任何文字。
 *
 * ## 已知限制
 *
 * Android 15 起，`dataSync` 类型的前台服务每天累计最多约 6 小时，
 * 超时后系统会调 [onTimeout]。到那时推送会停，直到用户再次打开 App。
 * 这是系统的省电策略，不是本服务的缺陷 —— 已经在 README 里写明。
 */
class AnnPushService : Service() {

    companion object {
        /** 断线后的退避起点与上限。 */
        private const val BACKOFF_MIN = 2_000L
        private const val BACKOFF_MAX = 60_000L
        private const val CONNECT_TIMEOUT = 15_000

        /** 拉公告超时。比连接超时短：这只是一次普通的 HTTP GET。 */
        private const val FETCH_TIMEOUT = 15_000

        /** 服务此刻是不是真的在跑（main 会把它的值回给网页端看）。 */
        @Volatile
        var active: Boolean = false
            private set
    }

    @Volatile
    private var running = false

    private var worker: Thread? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        active = true
        startInForeground("正在接收公告")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!AnnPush.enabled(this)) {
            stopSelf()
            return START_NOT_STICKY
        }
        startInForeground("正在接收公告")
        startLoop()
        // START_STICKY：系统因为内存紧张把我们杀了之后，会自己把服务拉回来 ——
        // 这正是「关掉 App 也能收到」赖以成立的那一条。
        return START_STICKY
    }

    private fun startInForeground(text: String) {
        val n = Notify.ongoing(this, text)
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(
                    Notify.ID_ONGOING,
                    n,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
                )
            } else {
                startForeground(Notify.ID_ONGOING, n)
            }
        } catch (e: Exception) {
            // 前台服务被系统拒绝（少见，但真机上出现过）。
            // 不抛 —— 推送失败不该让 App 崩掉。
        }
    }

    @Synchronized
    private fun startLoop() {
        if (running) return
        running = true
        worker = thread(name = "ys-ann-push", isDaemon = true) { loop() }
    }

    private fun loop() {
        var backoff = BACKOFF_MIN
        while (running) {
            val topic = AnnPush.topic(this)
            if (topic.isBlank()) break
            try {
                listen(topic)
                // 正常返回说明连接被对端关了（ntfy 会定期断开）。不算失败，立刻重连。
                backoff = BACKOFF_MIN
            } catch (e: Exception) {
                if (!running) break
                sleep(backoff)
                backoff = (backoff * 2).coerceAtMost(BACKOFF_MAX)
            }
        }
        if (running) stopSelf()
    }

    /** 一条 SSE 长连接。阻塞直到断开或收到停止信号。 */
    private fun listen(topic: String) {
        val base = AnnPush.base(this).trimEnd('/')
        val url = URL("$base/$topic/sse")
        val conn = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = CONNECT_TIMEOUT
            // 0 = 不设读超时。SSE 本来就是长连接，设了反而会被自己的超时打断。
            readTimeout = 0
            setRequestProperty("Accept", "text/event-stream")
            setRequestProperty("Cache-Control", "no-cache")
        }

        try {
            val code = conn.responseCode
            if (code != 200) throw IllegalStateException("ntfy 返回 $code")
            BufferedReader(InputStreamReader(conn.inputStream, Charsets.UTF_8)).use { r ->
                while (running) {
                    val line = r.readLine() ?: break
                    // SSE 的注释行（`:keepalive`）与空行都不是消息。
                    if (line.isEmpty() || line.startsWith(":")) continue
                    if (!line.startsWith("data:")) continue
                    val payload = line.removePrefix("data:").trim()
                    if (payload.isEmpty()) continue
                    if (isMessage(payload)) onDoorbell()
                }
            }
        } finally {
            try {
                conn.disconnect()
            } catch (e: Exception) {
                // 已经断了。
            }
        }
    }

    /**
     * ntfy 在建立连接时会先发一条 `event: open`。
     * **只有 `event == "message"` 才是真的有人发公告** —— 否则每次重连都会误报一次。
     */
    private fun isMessage(payload: String): Boolean = try {
        JSONObject(payload).optString("event") == "message"
    } catch (e: Exception) {
        false
    }

    /** 门铃响了：去把真正的公告拉回来，然后弹一条通知。 */
    private fun onDoorbell() {
        // App 就在前台时，网页端自己会弹（还带点进去看详情的行为），这里让位。
        if (AnnPush.appVisible) return
        val msg = latestAnnouncement()
        if (msg == null) {
            Notify.showAnnouncement(this, "ys-ann-latest", "有新公告", "打开仰山课表查看。")
            return
        }
        Notify.showAnnouncement(this, msg.first, msg.second, msg.third)
    }

    /**
     * 拉公告 JSON，挑出**日期最新**的那条。
     *
     * 为什么不取第一条：`mergeAnnouncements` 的排序是「置顶优先」，置顶的往往是
     * 很久以前那条（比如「本课程群规」）。用第一条的话，管理员再发新公告时
     * 排在最前的还是它 —— 我们就永远弹不出新东西。
     */
    private fun latestAnnouncement(): Triple<String, String, String>? {
        val url = AnnPush.annUrl(this)
        if (url.isBlank()) return null

        val body = try {
            httpGet(url)
        } catch (e: Exception) {
            return null
        }

        val arr: JSONArray = try {
            val root = JSONObject(body)
            when {
                root.has("announcements") -> root.getJSONArray("announcements")
                else -> JSONArray()
            }
        } catch (e: Exception) {
            return null
        }

        var best: JSONObject? = null
        var bestDate = ""
        for (i in 0 until arr.length()) {
            val a = arr.optJSONObject(i) ?: continue
            if (a.optString("title").isBlank() && a.optString("body").isBlank()) continue
            val d = a.optString("date")
            if (best == null || d > bestDate) {
                best = a
                bestDate = d
            }
        }

        val a = best ?: return null
        val id = a.optString("id").ifBlank { a.optString("title").ifBlank { "ys-ann" } }
        // 同一条公告只弹一次。重连、重启、切频道都不会重复打扰。
        if (id == AnnPush.lastId(this)) return null
        AnnPush.setLastId(this, id)

        val title = a.optString("title").ifBlank { "有新公告" }
        val text = a.optString("body")
            .replace(Regex("[*#>`_\\-]"), " ")
            .replace(Regex("\\s+"), " ")
            .trim()
            .ifBlank { "打开仰山课表查看。" }
        return Triple(title, id, text.take(150))
    }

    private fun httpGet(url: String): String {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = CONNECT_TIMEOUT
            readTimeout = FETCH_TIMEOUT
            // 公告源可能被中介缓存 10 分钟（GitHub Pages 就是 max-age=600）。
            // 每次都要最新的，所以强制重验证。
            setRequestProperty("Cache-Control", "no-cache")
        }
        try {
            if (conn.responseCode != 200) throw IllegalStateException("公告源返回 ${conn.responseCode}")
            return conn.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
        } finally {
            try {
                conn.disconnect()
            } catch (e: Exception) {
                // 已经断了。
            }
        }
    }

    private fun sleep(ms: Long) {
        try {
            Thread.sleep(ms)
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
        }
    }

    /**
     * Android 15 起 `dataSync` 前台服务每天有累计时长上限，到点系统会调这里。
     * 必须**主动**停下来并告诉用户 —— 不处理的话系统会直接 ANR 掉进程。
     */
    override fun onTimeout(startId: Int) {
        try {
            Notify.show(this, "公告推送已暂停", "系统限制了后台运行时长，打开 App 即可恢复。")
        } catch (e: Exception) {
            // 通知发不出去也要停。
        }
        stopSelf()
    }

    override fun onDestroy() {
        running = false
        active = false
        worker?.interrupt()
        worker = null
        super.onDestroy()
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // 用户从最近任务里划掉了 App。**不要停** —— 停了就收不到公告了，
        // 而这正是这个服务存在的全部意义。
        super.onTaskRemoved(rootIntent)
    }
}
