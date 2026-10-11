package dev.yangshan.schedule

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.LinearLayout
import android.widget.TextView

/**
 * 教务窗口。
 *
 * 它**不是**给用户平时看的东西 —— 正常导入流程里它会很快自己关掉。
 * 它的存在只为一件事：如果自动填表过不去（要验证码、口令改了、学校换页面了），
 * 得有个地方让人用自己的眼睛和手指把这一步走完。
 *
 * 与 Windows 壳的 SchoolForm 是同一个角色，区别是那边"藏到屏幕外还留着 cookie"，
 * 这边每次用完就关掉 —— 登录态在 CookieManager 里，跨进程重启也在。
 */
class SchoolActivity : Activity(), SchoolWeb.Listener {

    companion object {
        const val EXTRA_USER = "user"
        const val EXTRA_PASS = "pass"
        const val EXTRA_REMEMBER = "remember"
        const val EXTRA_RAW = "raw"
        const val EXTRA_ERROR = "error"
    }

    private lateinit var web: WebView
    private lateinit var status: TextView
    private lateinit var school: SchoolWeb
    private var done = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        status = TextView(this).apply {
            setPadding(28, 26, 28, 26)
            textSize = 13f
            setTextColor(0xFF334155.toInt())
        }

        web = WebView(this)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(
                status,
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ),
            )
            addView(
                web,
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f),
            )
        }
        setContentView(root)

        school = SchoolWeb(
            context = this,
            web = web,
            user = intent.getStringExtra(EXTRA_USER),
            pass = intent.getStringExtra(EXTRA_PASS),
            interactive = true,
            listener = this,
        )
        school.attach()
        school.start()
    }

    override fun onStep(message: String) {
        status.text = message
    }

    override fun onCaptured(raw: String) {
        if (done) return
        done = true
        Store.saveRaw(this, raw)
        if (intent.getBooleanExtra(EXTRA_REMEMBER, false)) {
            val u = intent.getStringExtra(EXTRA_USER)
            val p = intent.getStringExtra(EXTRA_PASS)
            if (!u.isNullOrBlank() && !p.isNullOrBlank()) Creds.save(this, u, p)
        }
        setResult(RESULT_OK, Intent().putExtra(EXTRA_RAW, raw))
        finish()
    }

    override fun onFailed(reason: String) {
        if (done) return
        done = true
        setResult(RESULT_CANCELED, Intent().putExtra(EXTRA_ERROR, reason))
        finish()
    }

    @Deprecated("Activity 自带的返回键回调")
    override fun onBackPressed() {
        if (done) {
            super.onBackPressed()
            return
        }
        // 人退出了，得让发起方别再等下去 —— cancel() 会走 onFailed → finish()。
        school.cancel()
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }
}
