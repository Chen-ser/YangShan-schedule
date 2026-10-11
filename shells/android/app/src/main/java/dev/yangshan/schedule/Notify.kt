package dev.yangshan.schedule

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent

/** 一条「课表已更新」的系统通知。没有通知权限时静默跳过，不当成错误。 */
object Notify {

    private const val CHANNEL = "yangshan"
    private const val ID = 4711

    private fun manager(ctx: Context) =
        ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    private fun ensureChannel(ctx: Context) {
        val nm = manager(ctx)
        if (nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, "课表更新", NotificationManager.IMPORTANCE_DEFAULT),
            )
        }
    }

    fun show(ctx: Context, title: String, body: String) {
        ensureChannel(ctx)

        val open = PendingIntent.getActivity(
            ctx,
            0,
            Intent(ctx, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        @Suppress("DEPRECATION")
        val n = android.app.Notification.Builder(ctx, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(android.app.Notification.BigTextStyle().bigText(body))
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()

        try {
            manager(ctx).notify(ID, n)
        } catch (e: SecurityException) {
            // 用户把通知关了 —— 那就别打扰人家。
        }
    }
}
