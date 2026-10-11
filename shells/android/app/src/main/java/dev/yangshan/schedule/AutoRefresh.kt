package dev.yangshan.schedule

import android.content.Context
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

/**
 * 每小时一次的后台刷新。
 *
 * 用 WorkManager 而不是自己拿 AlarmManager 拼：省电策略、Doze、重启后恢复都由它管，
 * 不需要一个常驻前台服务，也就不会有那条甩不掉的通知。
 *
 * 15 分钟是 WorkManager 对周期任务的下限，1 小时远在其上，不违反任何限制；
 * 系统在深度 Doze 里可能把它推迟几分钟到几小时 —— 这是省电的代价，不是 bug。
 */
object AutoRefresh {

    private const val NAME = "yangshan-hourly-refresh"

    fun schedule(ctx: Context) {
        try {
            val request = PeriodicWorkRequestBuilder<RefreshWorker>(1, TimeUnit.HOURS).build()
            WorkManager.getInstance(ctx.applicationContext)
                .enqueueUniquePeriodicWork(NAME, ExistingPeriodicWorkPolicy.KEEP, request)
        } catch (e: Exception) {
            // 定时刷新只是锦上添花，排不上也不能让 App 打不开。
        }
    }

    fun cancel(ctx: Context) {
        try {
            WorkManager.getInstance(ctx.applicationContext).cancelUniqueWork(NAME)
        } catch (e: Exception) {
            // 同上。
        }
    }
}
