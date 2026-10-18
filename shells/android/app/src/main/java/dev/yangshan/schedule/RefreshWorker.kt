package dev.yangshan.schedule

import android.content.Context
import android.webkit.WebView
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlin.coroutines.resume

/**
 * 后台的那次抓取。**这是整个安卓壳里最难验证的一块**，原因有二：
 *
 *   1. WebView 必须在有 Looper 的线程上创建 —— 所以整段跑在 Dispatchers.Main 上；
 *      它没有窗口，但能正常加载页面、带 cookie、跑 JS。这是已知可行但不算常见的用法。
 *   2. 学校页面偶尔会弹验证码，这时后台线程里没人能帮忙 —— 那种情况下这一步只能放弃，
 *      等用户下次打开 App 时再走前台那条路（那里有窗口，人能接手）。
 *
 * 因此本类失败一律 Result.retry()，绝不抛出去影响 App 本身的可用性。
 */
class RefreshWorker(appContext: Context, params: WorkerParameters) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result = withContext(Dispatchers.Main) {
        val creds = Creds.load(applicationContext)
        if (creds == null) {
            // 没记住账号就没得刷。返回 success 而不是 retry —— 重试一万次也还是没有账号。
            return@withContext Result.success()
        }

        val web = WebView(applicationContext)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true

        try {
            val raw = capture(web, creds.first, creds.second)
            Store.saveRaw(applicationContext, raw)
            // 页面正在打开时立即回推；页面尚未打开时，MainActivity 会在加载后
            // 通过 Store.rawAt/restoreIfNeeded 补上这次结果。
            applicationContext.sendBroadcast(
                android.content.Intent(MainActivity.ACTION_REFRESH_AVAILABLE)
                    .setPackage(applicationContext.packageName),
            )
            Notify.show(applicationContext, "课表已更新", "已从教务系统同步最新课表。")
            Result.success()
        } catch (e: Exception) {
            Result.retry()
        } finally {
            web.destroy()
        }
    }

    private suspend fun capture(web: WebView, user: String, pass: String): String =
        suspendCancellableCoroutine { cont ->
            val school = SchoolWeb(
                context = applicationContext,
                web = web,
                user = user,
                pass = pass,
                interactive = false,
                listener = object : SchoolWeb.Listener {
                    override fun onStep(message: String) = Unit

                    override fun onCaptured(raw: String) {
                        if (cont.isActive) cont.resume(raw)
                    }

                    override fun onFailed(reason: String) {
                        if (cont.isActive) {
                            // 必须写全限定名：CoroutineWorker 继承自 ListenableWorker，
                            // 它的嵌套类 Result 会遮蔽 kotlin.Result，这里要的是后者。
                            cont.resumeWith(kotlin.Result.failure(IllegalStateException(reason)))
                        }
                    }
                },
            )
            cont.invokeOnCancellation { school.cancel() }
            school.attach()
            school.start()
        }
}
