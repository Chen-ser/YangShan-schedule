package dev.yangshan.schedule

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/** 课程/待办提醒的锁屏落地页；公告和普通更新通知不会进入这里。 */
class ReminderActivity : Activity() {

    companion object {
        const val EXTRA_TITLE = "reminder_title"
        const val EXTRA_BODY = "reminder_body"
        const val EXTRA_KEY = "reminder_key"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                    WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON,
            )
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        val title = intent.getStringExtra(EXTRA_TITLE).orEmpty().ifBlank { "仰山课表提醒" }
        val body = intent.getStringExtra(EXTRA_BODY).orEmpty()
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(40, 36, 40, 36)
            setBackgroundColor(0xFFF8FAFC.toInt())
        }
        root.addView(TextView(this).apply {
            text = title
            textSize = 24f
            setTextColor(0xFF0F172A.toInt())
        })
        root.addView(TextView(this).apply {
            text = body
            textSize = 17f
            setTextColor(0xFF334155.toInt())
            setPadding(0, 18, 0, 28)
        })
        val actions = LinearLayout(this).apply { gravity = Gravity.END }
        actions.addView(Button(this).apply {
            text = "知道了"
            setOnClickListener { finish() }
        })
        actions.addView(Button(this).apply {
            text = "打开课表"
            setOnClickListener {
                startActivity(
                    Intent(this@ReminderActivity, MainActivity::class.java)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
                )
                finish()
            }
        })
        root.addView(actions)
        setContentView(root)
    }
}
