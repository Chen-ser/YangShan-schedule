package dev.yangshan.schedule

import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 保存最近一次教务抓取的脱敏诊断轨迹。
 *
 * 不记录账号、密码、Cookie、Authorization、课表响应正文或完整 URL 查询参数；
 * 只记录阶段、状态码、主机/路径和数据形状，足够定位登录与接口分流问题。
 */
object DiagLog {
    private const val PREFS = "yangshan-diagnostics"
    private const val KEY_LINES = "lines"
    private const val MAX_LINES = 240
    private const val MAX_CHARS = 48_000

    /** 攒到这么多字符就先落一次盘，免得事件太密时内存里堆住。 */
    private const val FLUSH_CHARS = 8_000

    /** 平时的落盘间隔：一次抓取的几十条事件会合并成一两次写盘。 */
    private const val FLUSH_DELAY_MS = 300L

    private val lock = Any()
    private var app: Context? = null
    private val pending = StringBuilder()
    private var pendingClear = false
    private var flushScheduled = false
    private val handler = Handler(Looper.getMainLooper())
    private val flushTask = Runnable {
        synchronized(lock) { flushLocked() }
    }

    fun begin(context: Context, interactive: Boolean) {
        synchronized(lock) {
            app = context.applicationContext
            // 只有用户主动发起的那次才清空日志。
            // 后台刷新（RefreshWorker，每小时一次）如果也清空，用户刚看到的失败原因
            // 会在一个小时内被它覆盖掉，「导出诊断日志」拿到的就不是他看到的那次了。
            appendLocked(
                "BEGIN mode=${if (interactive) "interactive" else "background"} " +
                    "version=${BuildConfig.VERSION_NAME} sdk=${Build.VERSION.SDK_INT}",
                clear = interactive,
            )
            // 开局这一条要立刻可见 —— 用户可能马上就点「导出诊断日志」。
            flushLocked()
        }
    }

    fun event(message: String) {
        synchronized(lock) {
            if (app == null) return
            appendLocked(sanitize(message), clear = false)
        }
    }

    fun url(url: String): String {
        return try {
            val parsed = Uri.parse(url)
            val host = parsed.host ?: "<no-host>"
            val path = parsed.path.orEmpty().ifBlank { "/" }
            "$host$path"
        } catch (_: Exception) {
            "<invalid-url>"
        }
    }

    fun export(context: Context): String {
        synchronized(lock) {
            app = context.applicationContext
            // 还没到落盘时间的那几条也要出现在导出的日志里。
            flushLocked()
            val lines = app!!.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString(KEY_LINES, "")
                .orEmpty()
            return if (lines.isBlank()) {
                "仰山课表诊断日志\n暂无记录。请先重新尝试导入课表。"
            } else {
                "仰山课表诊断日志\n$lines"
            }
        }
    }

    private fun appendLocked(message: String, clear: Boolean) {
        if (app == null) return
        if (clear) {
            pending.setLength(0)
            pendingClear = true
        }
        val stamp = SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US).format(Date())
        pending.append(stamp).append(' ').append(message).append('\n')
        if (pending.length >= FLUSH_CHARS) {
            // 一条抓取里事件很密。每条都读一遍 48 KB、拼一遍、再写一遍磁盘，
            // 在低端机上会明显拖慢。攒到一定量或隔一小会儿再落盘。
            flushLocked()
        } else {
            scheduleFlushLocked()
        }
    }

    private fun scheduleFlushLocked() {
        if (flushScheduled) return
        flushScheduled = true
        handler.postDelayed(flushTask, FLUSH_DELAY_MS)
    }

    private fun flushLocked() {
        flushScheduled = false
        handler.removeCallbacks(flushTask)
        val context = app ?: return
        if (pending.isEmpty() && !pendingClear) return
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val current = if (pendingClear) "" else prefs.getString(KEY_LINES, "").orEmpty()
        pendingClear = false
        val next = (current + pending.toString())
            .lineSequence()
            .filter { it.isNotBlank() }
            .toList()
            .takeLast(MAX_LINES)
            .joinToString("\n")
            .takeLast(MAX_CHARS)
            .let { if (it.isBlank()) "" else "$it\n" }
        pending.setLength(0)
        prefs.edit().putString(KEY_LINES, next).apply()
    }

    private fun sanitize(input: String): String {
        var text = input
            .replace(Regex("(?i)(password|passwd|pwd|token|cookie|authorization)\\s*[=:]\\s*[^\\s&]+"), "$1=<redacted>")
            .replace(Regex("(?i)(username|userId|studentCode|xh)\\s*[=:]\\s*[^\\s&]+"), "$1=<redacted>")
            .replace(Regex("(?i)(当前学期|termCode)\\s*[=:：]?\\s*[^，,\\s]+"), "$1=<redacted>")
        text = Regex("https?://[^\\s)'\"<>]+").replace(text) { match -> url(match.value) }
        if (text.length > 600) text = text.take(600) + "…"
        return text
    }
}
