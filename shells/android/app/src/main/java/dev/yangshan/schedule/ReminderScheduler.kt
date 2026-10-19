package dev.yangshan.schedule

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDateTime
import java.time.ZoneId

/**
 * 把网页端保存的课表/待办转换成 Android 一次性闹钟。
 *
 * 页面仍会在前台每分钟检查一次，用于立即反馈；这里是后台兜底，
 * 让应用被划掉或 WebView 休眠后，课前和截止提醒仍能进入系统通知栏。
 */
object ReminderScheduler {

    private const val PREFS = "yangshan_reminders"
    private const val KEY_IDS = "ids"
    private const val EXTRA_KEY = "key"
    private const val EXTRA_TITLE = "title"
    private const val EXTRA_BODY = "body"

    private data class Reminder(
        val key: String,
        val at: Long,
        val title: String,
        val body: String,
    )

    fun schedule(ctx: Context, json: String?) {
        val app = ctx.applicationContext
        val alarm = app.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val old = prefs.getStringSet(KEY_IDS, emptySet()).orEmpty()
        old.forEach { cancelOne(app, alarm, it) }

        val reminders = parse(json).filter { it.at > System.currentTimeMillis() + 1000L }
        val ids = HashSet<String>()
        for (item in reminders) {
            val requestCode = requestCode(item.key)
            val pending = pendingIntent(app, item, requestCode)
            try {
                if (Build.VERSION.SDK_INT >= 31 && alarm.canScheduleExactAlarms()) {
                    alarm.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, item.at, pending)
                } else {
                    // 没有“精确闹钟”特殊权限时仍然安排提醒，系统会在省电策略允许时唤醒。
                    alarm.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, item.at, pending)
                }
                ids += item.key
            } catch (_: SecurityException) {
                // 厂商系统拒绝闹钟时不影响网页和公告功能。
            }
        }
        prefs.edit().putStringSet(KEY_IDS, ids).apply()
    }

    fun rescheduleFromStore(ctx: Context) {
        schedule(ctx, Store.state(ctx))
    }

    private fun parse(json: String?): List<Reminder> {
        if (json.isNullOrBlank()) return emptyList()
        return runCatching {
            val root = JSONObject(json)
            val settings = root.optJSONObject("settings") ?: JSONObject()
            if (!settings.optBoolean("inApp", false)) return emptyList()
            val out = ArrayList<Reminder>()
            val alarmMinutes = settings.optInt("alarm", 0).coerceAtLeast(0)
            val todoMinutes = settings.optInt("todoAlarm", 0).coerceAtLeast(0)

            val schedule = root.optJSONObject("schedule")
            val events = schedule?.optJSONArray("events") ?: JSONArray()
            for (i in 0 until events.length()) {
                val e = events.optJSONObject(i) ?: continue
                val date = e.optString("date")
                val start = e.optString("start").take(5)
                val uid = e.optString("uid").ifBlank { "$date|$start|$i" }
                if (alarmMinutes <= 0 || date.isBlank() || start.length != 5) continue
                val at = parseTime(date, start)
                    ?.minusMinutes(alarmMinutes.toLong())
                    ?.toEpochMillis() ?: continue
                out += Reminder(
                    key = "class:$uid:$alarmMinutes",
                    at = at,
                    title = "$alarmMinutes 分钟后上课",
                    body = listOf(
                        e.optString("course"),
                        "$start ${e.optString("location")}".trim(),
                    ).filter { it.isNotBlank() }.joinToString("\n"),
                )
            }

            val todos = root.optJSONArray("todos") ?: JSONArray()
            for (i in 0 until todos.length()) {
                val td = todos.optJSONObject(i) ?: continue
                if (td.optBoolean("done", false) || todoMinutes <= 0) continue
                val due = td.optString("due")
                val at = parseTime(due.substringBefore('T'), due.substringAfter('T').take(5))
                    ?.minusMinutes(todoMinutes.toLong())
                    ?.toEpochMillis() ?: continue
                val kind = when (td.optString("kind")) {
                    "homework" -> "作业"
                    "online" -> "网课"
                    "exam" -> "考试"
                    else -> "待办"
                }
                val id = td.optString("id").ifBlank { "$due|$i" }
                val whenText = if (todoMinutes >= 60) {
                    "${todoMinutes / 60} 小时后"
                } else {
                    "$todoMinutes 分钟后"
                }
                out += Reminder(
                    key = "todo:$id:$due:$todoMinutes",
                    at = at,
                    title = "$kind${whenText}截止",
                    body = "${td.optString("title").ifBlank { kind }}\n$due".trim(),
                )
            }
            out
        }.getOrDefault(emptyList())
    }

    private fun parseTime(date: String, time: String): LocalDateTime? =
        runCatching { LocalDateTime.parse("${date}T${time}") }.getOrNull()

    private fun LocalDateTime.toEpochMillis(): Long =
        atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()

    private fun requestCode(key: String): Int = key.hashCode() and 0x7fffffff

    private fun pendingIntent(ctx: Context, item: Reminder, requestCode: Int): PendingIntent {
        val intent = Intent(ctx, ReminderReceiver::class.java)
            .setData(Uri.parse("yangshan://reminder/${Uri.encode(item.key)}"))
            .putExtra(EXTRA_KEY, item.key)
            .putExtra(EXTRA_TITLE, item.title)
            .putExtra(EXTRA_BODY, item.body)
        return PendingIntent.getBroadcast(
            ctx,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun cancelOne(ctx: Context, alarm: AlarmManager, key: String) {
        val item = Reminder(key, 0L, "", "")
        alarm.cancel(pendingIntent(ctx, item, requestCode(key)))
    }

    internal fun title(intent: Intent): String = intent.getStringExtra(EXTRA_TITLE).orEmpty()
    internal fun body(intent: Intent): String = intent.getStringExtra(EXTRA_BODY).orEmpty()
    internal fun key(intent: Intent): String? = intent.getStringExtra(EXTRA_KEY)
}

class ReminderReceiver : android.content.BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
        val ctx = context?.applicationContext ?: return
        val title = ReminderScheduler.title(intent ?: return)
        val body = ReminderScheduler.body(intent ?: return)
        if (title.isNotBlank() && Notify.notificationsEnabled(ctx)) {
            Notify.show(ctx, title, body, ReminderScheduler.key(intent))
        }
        // 重新读取最新状态，覆盖用户刚删除/完成/改期的提醒。
        ReminderScheduler.rescheduleFromStore(ctx)
    }
}
