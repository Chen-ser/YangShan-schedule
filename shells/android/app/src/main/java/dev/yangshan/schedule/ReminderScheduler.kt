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
        val alarm: Boolean,
    )

    fun schedule(ctx: Context, json: String?) {
        val app = ctx.applicationContext
        val alarm = app.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        Notify.prepareReminderChannel(app)
        val prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val old = prefs.getStringSet(KEY_IDS, emptySet()).orEmpty()
        old.forEach { cancelOne(app, alarm, it) }

        val reminders = parse(json).filter { it.at > System.currentTimeMillis() + 1000L }
        val ids = HashSet<String>()
        for (item in reminders) {
            val requestCode = requestCode(item.key)
            val pending = pendingIntent(app, item, requestCode)
            try {
                if (item.alarm && Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                    // “闹钟提醒”使用系统 AlarmClock 通道，系统会把它当作真正的闹钟
                    // 处理；普通提醒仍使用精确闹钟唤醒后发通知，不占用闹钟入口。
                    alarm.setAlarmClock(
                        AlarmManager.AlarmClockInfo(item.at, alarmShowIntent(app, requestCode)),
                        pending,
                    )
                } else if (Build.VERSION.SDK_INT >= 31 && alarm.canScheduleExactAlarms()) {
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
            val out = ArrayList<Reminder>()
            val alarmMinutes = settings.optInt("alarm", 0).coerceAtLeast(0)
            val todoMinutes = settings.optInt("todoAlarm", 0).coerceAtLeast(0)
            val courseAlarmEnabled = settings.optBoolean("courseAlarmEnabled", false)
            val todoAlarmEnabled = settings.optBoolean("todoAlarmEnabled", false)

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
                    alarm = courseAlarmEnabled,
                    body = listOf(
                        e.optString("course"),
                        "$start ${e.optString("location")}".trim(),
                    ).filter { it.isNotBlank() }.joinToString("\n"),
                )
            }

            val todos = root.optJSONArray("todos") ?: JSONArray()
            for (i in 0 until todos.length()) {
                val td = todos.optJSONObject(i) ?: continue
                if (td.optBoolean("done", false)) continue
                val itemAlarmEnabled = td.optBoolean("alarmEnabled", false)
                val leadMinutes = if (todoAlarmEnabled) {
                    todoMinutes
                } else if (itemAlarmEnabled) {
                    td.optInt("alarmMinutes", todoMinutes).coerceAtLeast(0)
                } else {
                    todoMinutes
                }
                if (leadMinutes <= 0) continue
                val due = td.optString("due").trim()
                val at = parseFlexibleTime(due)
                    ?.minusMinutes(leadMinutes.toLong())
                    ?.toEpochMillis() ?: continue
                val kind = when (td.optString("kind")) {
                    "homework" -> "作业"
                    "online" -> "网课"
                    "exam" -> "考试"
                    "meeting" -> "会议"
                    "experiment" -> "实验"
                    "competition" -> "竞赛"
                    "activity" -> "活动"
                    else -> "待办"
                }
                val id = td.optString("id").ifBlank { "$due|$i" }
                val whenText = if (leadMinutes >= 60) {
                    "${leadMinutes / 60} 小时后"
                } else {
                    "$leadMinutes 分钟后"
                }
                out += Reminder(
                    key = "todo:$id:$due:$leadMinutes",
                    at = at,
                    title = "$kind${whenText}截止",
                    alarm = todoAlarmEnabled || itemAlarmEnabled,
                    body = "${td.optString("title").ifBlank { kind }}\n$due".trim(),
                )
            }
            out
        }.getOrDefault(emptyList())
    }

    private fun parseTime(date: String, time: String): LocalDateTime? =
        runCatching {
            val normalizedDate = date.trim()
            val normalizedTime = time.trim().let {
                when {
                    it.matches(Regex("""\d{1,2}:\d{2}""")) -> it.padStart(5, '0')
                    it.length >= 5 -> it.take(5)
                    else -> return@runCatching null
                }
            }
            LocalDateTime.parse("${normalizedDate}T$normalizedTime")
        }.getOrNull()

    /** 兼容网页输入框、通知文本和 ISO 字符串的几种截止时间写法。 */
    private fun parseFlexibleTime(raw: String): LocalDateTime? {
        val value = raw.trim()
            .replace(' ', 'T')
            .replace(Regex("""([+-]\d{2}:\d{2}|Z)$"""), "")
        runCatching { LocalDateTime.parse(value) }.getOrNull()?.let { return it }
        val date = value.substringBefore('T', "")
        val time = value.substringAfter('T', "")
        return parseTime(date, time)
    }

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

    private fun alarmShowIntent(ctx: Context, requestCode: Int): PendingIntent =
        PendingIntent.getActivity(
            ctx,
            requestCode,
            Intent(ctx, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    private fun cancelOne(ctx: Context, alarm: AlarmManager, key: String) {
        val item = Reminder(key, 0L, "", "", false)
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
        // 不在这里提前判断通知权限：系统设置页可能刚刚授予权限，而
        // areNotificationsEnabled() 在部分厂商 ROM 上仍会短暂返回旧值。
        // 直接尝试发送，Notify.post 会处理真正的 SecurityException。
        if (title.isNotBlank()) {
            Notify.showReminder(ctx, title, body, ReminderScheduler.key(intent))
        }
        // 重新读取最新状态，覆盖用户刚删除/完成/改期的提醒。
        ReminderScheduler.rescheduleFromStore(ctx)
    }
}
