package dev.yangshan.schedule

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * 开机后把推送服务重新拉起来。
 *
 * 没有它的话，用户重启一次手机推送就永久停了 —— 而他完全看不出为什么，
 * 只会觉得「这个 App 有时候收得到有时候收不到」。
 *
 * WorkManager 管的是每小时抓课表（它自带重启恢复），
 * 但前台服务不在它的管辖范围内，必须自己接这一下。
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context?, intent: Intent?) {
        val ctx = context?.applicationContext ?: return
        val action = intent?.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED &&
            action != Intent.ACTION_MY_PACKAGE_REPLACED
        ) {
            return
        }
        // 没配过频道就是没开过推送，别自作主张起一个前台服务。
        if (!AnnPush.enabled(ctx)) return
        AnnPush.apply(ctx)
    }
}
