package dev.yangshan.schedule

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.Button
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
        val actions = LinearLayout(this).apply {
            gravity = Gravity.END
            addView(Button(this@SchoolActivity).apply {
                text = "导出诊断日志"
                setOnClickListener { shareDiagnostics() }
            })
            addView(Button(this@SchoolActivity).apply {
                text = "关闭"
                setOnClickListener { closeWithFailure() }
            })
        }

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
                actions,
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
        DiagLog.event("ui-step $message")
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
        // 失败原因就是这次抓取的最终结果，必须立刻用 done 钉住。
        // 以前这里不置 done：用户看完提示按返回键 → closeWithFailure() 发现 done 还是
        // false → 又 setResult 一次「已取消」，把真正的诊断信息盖掉（SchoolWeb.fail()
        // 已经把 finished 置 true 了，school.cancel() 会早返回，挡不住这次覆盖）。
        done = true
        DiagLog.event("ui-failed reason=$reason")
        setResult(RESULT_CANCELED, Intent().putExtra(EXTRA_ERROR, reason))
        status.text = "$reason\n\n请点击“导出诊断日志”，把日志分享出来。"
    }

    private fun shareDiagnostics() {
        val text = DiagLog.export(this)
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_SUBJECT, "仰山课表诊断日志")
            putExtra(Intent.EXTRA_TEXT, text)
            clipData = ClipData.newPlainText("仰山课表诊断日志", text)
        }
        startActivity(Intent.createChooser(send, "分享诊断日志"))
    }

    private fun closeWithFailure() {
        if (!done) {
            // 用户主动按返回：先让 SchoolWeb 停下，它会回调 onFailed("已取消")，
            // 由那里把 done 置 true 并写结果。这里只兜底，绝不覆盖已有结果。
            school.cancel()
        }
        if (!done) {
            done = true
            setResult(RESULT_CANCELED, Intent().putExtra(EXTRA_ERROR, "已取消"))
        }
        finish()
    }

    @Deprecated("Activity 自带的返回键回调")
    override fun onBackPressed() {
        if (done) {
            // 已经出结果了（抓到了，或者失败了并写了具体原因）——直接走默认返回，
            // 让那个结果原样交回 MainActivity。
            super.onBackPressed()
            return
        }
        closeWithFailure()
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }
}
