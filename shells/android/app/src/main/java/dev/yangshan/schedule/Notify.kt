package dev.yangshan.schedule

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent

/**
 * 系统通知。全部集中在这里，因为渠道（NotificationChannel）必须与通知一起考虑：
 * 安卓 8 起，一条通知属于哪个渠道就决定了它响不响、能不能被单独静音。
 *
 * 三条渠道，**刻意分开**：
 *   - `yangshan`      课表已更新（后台抓完提示一声）
 *   - `yangshan-ann`  新公告（管理员发的，用户想第一时间看到）
 *   - `yangshan-push` 推送服务的常驻通知（必须存在但**不该打扰人** → IMPORTANCE_MIN）
 *
 * 把常驻通知单独放一条最低重要性的渠道，是为了让用户能「只静音那条挂着的通知」
 * 而保留公告提醒 —— 如果混在一条渠道里，他只能二选一。
 */
object Notify {

    private const val CH_SCHEDULE = "yangshan"
    private const val CH_ANN = "yangshan-ann"
    private const val CH_PUSH = "yangshan-push"

    private const val ID_SCHEDULE = 4711

    /** 公告通知的 id 基数：不同的公告用不同 id，才不会互相覆盖。 */
    private const val ID_ANN_BASE = 5100

    /** 常驻通知的固定 id —— 它永远只有一条。 */
    const val ID_ONGOING = 4900

    private fun manager(ctx: Context) =
        ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    private fun channel(ctx: Context, id: String, name: String, importance: Int) {
        val nm = manager(ctx)
        if (nm.getNotificationChannel(id) == null) {
            nm.createNotificationChannel(NotificationChannel(id, name, importance))
        }
    }

    private fun openApp(ctx: Context): PendingIntent = PendingIntent.getActivity(
        ctx,
        0,
        Intent(ctx, MainActivity::class.java),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    private fun post(ctx: Context, id: Int, n: Notification) {
        try {
            manager(ctx).notify(id, n)
        } catch (e: SecurityException) {
            // 用户把通知关了 —— 那就别打扰人家。
        }
    }

    /** 课表后台刷新完成。 */
    fun show(ctx: Context, title: String, body: String) {
        channel(ctx, CH_SCHEDULE, "课表更新", NotificationManager.IMPORTANCE_DEFAULT)

        @Suppress("DEPRECATION")
        val n = Notification.Builder(ctx, CH_SCHEDULE)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setContentIntent(openApp(ctx))
            .setAutoCancel(true)
            .build()

        post(ctx, ID_SCHEDULE, n)
    }

    /**
     * 新公告。
     *
     * ★ `key` 用来让同一条公告互相覆盖（重连后重复收到不会堆一屏），
     *   不同的公告则各占一条。用公告 id 的稳定哈希，不用它的原始值 ——
     *   管理员改标题不改 id，这里就不该弹第二条。
     */
    fun showAnnouncement(ctx: Context, key: String, title: String, body: String) {
        channel(ctx, CH_ANN, "新公告", NotificationManager.IMPORTANCE_DEFAULT)

        @Suppress("DEPRECATION")
        val n = Notification.Builder(ctx, CH_ANN)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setContentIntent(openApp(ctx))
            .setAutoCancel(true)
            .build()

        // 拿 id 的哈希取模当通知 id：同一条 -> 同一个 id（覆盖），不同条 -> 不同 id。
        val slot = ID_ANN_BASE + (key.hashCode() and 0x7fffffff) % 500
        post(ctx, slot, n)
    }

    /** 推送服务的常驻通知。低调、不可划掉、点了回到 App。 */
    fun ongoing(ctx: Context, text: String): Notification {
        channel(ctx, CH_PUSH, "公告推送服务", NotificationManager.IMPORTANCE_MIN)

        @Suppress("DEPRECATION")
        return Notification.Builder(ctx, CH_PUSH)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("仰山课表")
            .setContentText(text)
            .setContentIntent(openApp(ctx))
            .setOngoing(true)
            .setShowWhen(false)
            .build()
    }
}
