package dev.yangshan.schedule

import android.app.Activity
import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.IntentFilter
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.provider.OpenableColumns
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.widget.Toast
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream

/**
 * 课表内核的主窗口。
 *
 * 它做的事和 Windows 壳的 MainForm 一模一样，只是换了平台：
 *   1. 把内核托在 https://appassets.androidplatform.net/ 这个虚拟源上显示出来；
 *   2. 注入 shells/shim.js（安卓这边在打包时就烘进 index.html 了，见 tools/prepare-assets.mjs）；
 *   3. 收到内核要登录/刷新时，开 SchoolActivity 去学校页面上抓。
 */
class MainActivity : Activity(), ShellBridge.Host {

    companion object {
        private const val ORIGIN = "https://appassets.androidplatform.net"
        private const val ENTRY_URL = "$ORIGIN/assets/index.html"
        const val ACTION_REFRESH_AVAILABLE = "dev.yangshan.schedule.REFRESH_AVAILABLE"
        private const val REQ_LOGIN = 4001
        private const val REQ_NOTIFY = 4002
        private const val REQ_FILE = 4003
        private const val RUNTIME_PREFS = "yangshan_runtime"
        private const val K_INITIAL_PROMPTED = "initialSensitivePermissionsPrompted"
        private const val MAX_SHARED_BYTES = 30L * 1024L * 1024L
        // 冷启动要先把 2.4 MB 的页面铺起来，3 秒常常不够（旧值 12 次 × 250 ms）。
        // 现在前 12 次仍然快（页面通常已经好了），之后放慢到 1 秒一次，总共约一分钟。
        private const val SHARE_FAST_TRIES = 12
        private const val SHARE_MAX_TRIES = 72
    }

    private lateinit var web: WebView
    private lateinit var shareDir: File
    private var pendingShare: SharePayload? = null
    private var shareDeliveryTries = 0
    private var shareRequestSerial = 0L
    private var refreshReceiver: BroadcastReceiver? = null
    private var pendingRefreshRaw: String? = null

    /** 正在处理的请求 id（来自 shim 那一侧的 id），抓完用它把结果送回去。 */
    private var pendingId: String? = null
    private var pendingNotifyId: String? = null
    private var initialPermissionFlow = false
    private var initialFullScreenSettingsOpened = false
    private val persistLock = Any()
    private var persistEpoch = 0L
    private var latestPersistAt = 0L
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null

    private data class SharePayload(
        val text: String?,
        val name: String?,
        val mime: String?,
        val url: String?,
        val error: String? = null,
        /** 不是错误、但用户该知道的事，比如「多选分享只取了第一个」。 */
        val notice: String? = null,
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        shareDir = File(cacheDir, "share-inbox")
        shareDir.mkdirs()
        handleShareIntent(intent)

        // Android 13 起通知要用户点头。不给也能用，只是后台刷新完没法提示。
        web = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true // 内核靠 localStorage 存课表
            settings.databaseEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = true
            settings.mediaPlaybackRequiresUserGesture = true
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?,
            ): Boolean {
                fileChooserCallback?.onReceiveValue(null)
                fileChooserCallback = filePathCallback
                return try {
                    val intent = fileChooserParams?.createIntent()
                        ?: Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                            addCategory(Intent.CATEGORY_OPENABLE)
                            type = "*/*"
                        }
                    startActivityForResult(intent, REQ_FILE)
                    true
                } catch (_: Exception) {
                    fileChooserCallback = null
                    false
                }
            }
        }
        web.addJavascriptInterface(ShellBridge(this), "YangShanNative")

        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: android.content.Context?, intent: Intent?) {
                if (intent?.action != ACTION_REFRESH_AVAILABLE) return
                Thread {
                    val raw = Store.raw(this@MainActivity)
                    if (raw.isNullOrBlank()) return@Thread
                    runOnUiThread {
                        pendingRefreshRaw = raw
                        importRefreshedRaw(raw)
                    }
                }.start()
            }
        }
        refreshReceiver = receiver
        val refreshFilter = IntentFilter(ACTION_REFRESH_AVAILABLE)
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(receiver, refreshFilter, RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            registerReceiver(receiver, refreshFilter)
        }

        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .addPathHandler("/shared/", WebViewAssetLoader.InternalStoragePathHandler(this, shareDir))
            .build()

        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                loader.shouldInterceptRequest(request.url)

            override fun onPageFinished(view: WebView, url: String) {
                if (url.startsWith(ORIGIN)) {
                    restoreIfNeeded()
                    // 页面刚铺好，把分享的窗口重新给满：onCreate 那一轮往往在页面
                    // 还没起来时就用完了计数，等 onPageFinished 时已经放弃。
                    if (pendingShare != null) {
                        shareDeliveryTries = 0
                        deliverPendingShare()
                    }
                    pendingRefreshRaw?.let { raw ->
                        pendingRefreshRaw = null
                        importRefreshedRaw(raw)
                    }
                }
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                if (url.startsWith(ORIGIN)) return false
                open(url)
                return true
            }
        }

        setContentView(web)
        web.loadUrl(ENTRY_URL)

        AutoRefresh.schedule(this)

        // 服务可能被系统杀过（省电、内存），这里按已存的配置把它恢复回来。
        // 没配过频道时 AnnPush.apply 什么也不做。
        AnnPush.apply(this)
        Store.state(this)?.let { ReminderScheduler.schedule(this, it) }
        web.postDelayed({ requestInitialSensitivePermissions() }, 700L)
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleShareIntent(intent)
    }

    /**
     * URI 元数据和文件复制都放到后台线程，避免微信分享大文件时阻塞主线程。
     * 用序号丢弃过期请求，防止用户连续分享时旧文件覆盖新文件。
     */
    private fun handleShareIntent(incoming: Intent?) {
        val serial = ++shareRequestSerial
        pendingShare = null
        shareDeliveryTries = 0
        Thread {
            val payload = readShareIntent(incoming)
            runOnUiThread {
                if (serial != shareRequestSerial) return@runOnUiThread
                pendingShare = payload
                shareDeliveryTries = 0
                if (payload != null && ::web.isInitialized) deliverPendingShare()
            }
        }.start()
    }

    private fun readShareIntent(incoming: Intent?): SharePayload? {
        val action = incoming?.action ?: return null
        if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return null

        val text = incoming.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()?.trim().orEmpty()
        val streams: List<Uri> = when {
            action == Intent.ACTION_SEND -> listOfNotNull(incoming.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))
            else -> incoming.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM).orEmpty()
        }
        val uri = streams.firstOrNull()
        if (uri == null) {
            return if (text.isNotBlank()) SharePayload(text, null, "text/plain", null) else null
        }
        // 多选分享只支持第一份。以前是静默丢掉其余文件，用户会以为全都导进去了。
        val extraNotice = if (streams.size > 1) "（一次只能导入一个文件，已取第一个）" else ""

        return try {
            val name = sharedDisplayName(uri)
            val mime = contentResolver.getType(uri) ?: incoming.type ?: "application/octet-stream"
            val fileName = safeShareName(name, mime)
            val target = File(shareDir, fileName)
            shareDir.mkdirs()
            pruneShareDir()
            // 体积先问一句：能拿到声明长度就别先拷 30 MB 再报错。
            val declared = try {
                contentResolver.openAssetFileDescriptor(uri, "r")?.use { it.length } ?: -1L
            } catch (_: Exception) {
                -1L
            }
            if (declared > MAX_SHARED_BYTES) {
                return SharePayload(null, null, null, null, "文件过大，暂不支持超过 30 MB 的分享文件。")
            }
            contentResolver.openInputStream(uri)?.use { input ->
                FileOutputStream(target).use { output ->
                    val buffer = ByteArray(64 * 1024)
                    var total = 0L
                    while (true) {
                        val count = input.read(buffer)
                        if (count <= 0) break
                        total += count
                        if (total > MAX_SHARED_BYTES) {
                            target.delete()
                            return SharePayload(null, null, null, null, "文件过大，暂不支持超过 30 MB 的分享文件。")
                        }
                        output.write(buffer, 0, count)
                    }
                }
            } ?: return SharePayload(null, null, null, null, "无法读取微信分享的文件。")
            SharePayload(text.ifBlank { null }, fileName, mime, "$ORIGIN/shared/${Uri.encode(fileName)}", null, extraNotice)
        } catch (e: Exception) {
            SharePayload(null, null, null, null, "读取分享文件失败：${e.message ?: "未知错误"}")
        }
    }

    /**
     * 清掉过期的落盘文件。
     *
     * 不能「一律清空」：receiveShare 是异步 fetch 的，刚交付就删会把文件删掉。
     * 也不能不清：分享一次留一份，应用开久了就在 cache 里堆着。
     * 10 分钟足够页面取完，也足够把上一次的残留收走。
     */
    private fun pruneShareDir() {
        val cutoff = System.currentTimeMillis() - 10 * 60 * 1000L
        shareDir.listFiles()?.forEach { file -> if (file.lastModified() < cutoff) file.delete() }
    }

    private fun sharedDisplayName(uri: Uri): String? {
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (index >= 0) return cursor.getString(index)
            }
        }
        return uri.lastPathSegment
    }

    private fun safeShareName(name: String?, mime: String): String {
        val cleaned = name.orEmpty().replace(Regex("[^A-Za-z0-9._-]"), "_").trim('_')
        // 只由点组成的名字（".."、"..."）不能放行：File(shareDir, "..") 指向上一级目录。
        // 目前是靠 FileOutputStream 对目录抛异常挡下来的 —— 那是碰运气，不是设计。
        val looksReal = cleaned.isNotBlank() && cleaned.contains('.') && cleaned.any { it != '.' }
        if (looksReal) return cleaned.take(120)
        val extension = when {
            mime.startsWith("image/") -> ".jpg"
            mime == "application/pdf" -> ".pdf"
            mime.contains("word") -> ".docx"
            mime.contains("presentation") -> ".pptx"
            mime.startsWith("text/") -> ".txt"
            else -> ".bin"
        }
        return "shared-file$extension"
    }

    private fun deliverPendingShare() {
        val payload = pendingShare ?: return
        if (shareDeliveryTries >= SHARE_MAX_TRIES) {
            // 到点了还没送进去：不能静默丢掉。用户从微信点了「分享到仰山课表」，
            // 应用也确实打开了，如果这里什么都不说，他会以为文件已经导入了。
            pendingShare = null
            shareDeliveryTries = 0
            Toast.makeText(this, "分享的文件还没载入页面就超时了，请在应用里手动导入。", Toast.LENGTH_LONG).show()
            return
        }
        val json = JSONObject()
            .put("text", payload.text ?: JSONObject.NULL)
            .put("name", payload.name ?: JSONObject.NULL)
            .put("mime", payload.mime ?: JSONObject.NULL)
            .put("url", payload.url ?: JSONObject.NULL)
            .put("error", payload.error ?: JSONObject.NULL)
            .put("notice", payload.notice ?: JSONObject.NULL)
        web.evaluateJavascript(
            "(globalThis.YangShan && typeof globalThis.YangShan.receiveShare === 'function')" +
                " ? (globalThis.YangShan.receiveShare(${json}) , 'ready') : 'waiting'"
        ) { result ->
            if (result?.contains("ready") == true) {
                pendingShare = null
                shareDeliveryTries = 0
            } else {
                shareDeliveryTries += 1
                val delay = if (shareDeliveryTries < SHARE_FAST_TRIES) 250L else 1000L
                web.postDelayed({ deliverPendingShare() }, delay)
            }
        }
    }

    override fun onResume() {
        super.onResume()
        // 前台时网页端自己会弹通知（点了还能直接跳到那条公告），
        // 告诉服务别重复弹。
        AnnPush.appVisible = true
        // Android 14 的全屏通知授权在独立系统页面里完成；返回后继续
        // 首次安装引导，不把电池优化设置漏掉。
        if (initialPermissionFlow && initialFullScreenSettingsOpened) {
            initialFullScreenSettingsOpened = false
            openInitialBackgroundAccess()
        }
    }

    override fun onPause() {
        AnnPush.appVisible = false
        super.onPause()
    }

    // ── 内核 → 壳的请求（ShellBridge.Host）────────────────────────────────────

    override fun onLogin(id: String, username: String?, password: String?) {
        if (username.isNullOrBlank() || password.isNullOrBlank()) {
            replyError(id, "账号和密码都要填。")
            return
        }
        pendingId = id
        val i = Intent(this, SchoolActivity::class.java)
            .putExtra(SchoolActivity.EXTRA_USER, username)
            .putExtra(SchoolActivity.EXTRA_PASS, password)
            .putExtra(SchoolActivity.EXTRA_REMEMBER, Creds.remember(this))
        startActivityForResult(i, REQ_LOGIN)
    }

    override fun onRefresh(id: String) {
        val stored = Creds.load(this)
        if (stored == null) {
            replyError(id, "还没有记住账号，先在学校账号那一栏登录一次。")
            return
        }
        pendingId = id
        val i = Intent(this, SchoolActivity::class.java)
            .putExtra(SchoolActivity.EXTRA_USER, stored.first)
            .putExtra(SchoolActivity.EXTRA_PASS, stored.second)
            .putExtra(SchoolActivity.EXTRA_REMEMBER, false)
        startActivityForResult(i, REQ_LOGIN)
    }

    @Deprecated("Activity 自带的回调")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == REQ_FILE) {
            val callback = fileChooserCallback
            fileChooserCallback = null
            val result = if (resultCode == RESULT_OK) {
                val clip = data?.clipData
                when {
                    clip != null -> Array(clip.itemCount) { i -> clip.getItemAt(i).uri }
                    data?.data != null -> arrayOf(data.data!!)
                    else -> null
                }
            } else null
            callback?.onReceiveValue(result)
            return
        }
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_LOGIN) return
        val id = pendingId
        pendingId = null
        if (id == null) return

        val raw = data?.getStringExtra(SchoolActivity.EXTRA_RAW)
        if (resultCode == RESULT_OK && !raw.isNullOrBlank()) {
            Store.saveRaw(this, raw)
            replyOk(id, raw)
        } else {
            replyError(id, data?.getStringExtra(SchoolActivity.EXTRA_ERROR) ?: "没有抓到课表。")
        }
    }

    override fun onStatus(id: String) {
        // YangShan.hasSchedule() 是个同步函数，但只有页面里才有它。
        web.evaluateJavascript(
            "(globalThis.YangShan && typeof YangShan.hasSchedule === 'function')" +
                " ? String(YangShan.hasSchedule()) : 'false'"
        ) { value ->
            val creds = Creds.load(this)
            val status = JSONObject()
                .put("name", "android")
                .put("version", BuildConfig.VERSION_NAME)
                .put("hasSchedule", value?.trim('"') == "true")
                .put("remembered", creds != null)
                .put("autoRefresh", true)
                .put("autoRefreshMinutes", 60)
                .put("notificationsGranted", Notify.notificationsEnabled(this))
                // 关掉 App 也能收到公告 —— 由前台服务维持一条到 ntfy 的长连接。
                .put("annPush", AnnPush.enabled(this) && AnnPushService.active)
            if (creds != null) status.put("username", creds.first) else status.put("username", JSONObject.NULL)
            val payload = JSONObject()
                .put("id", id)
                .put("ok", true)
                .put("pack", status)
            reply(payload)
        }
    }

    override fun onForget(id: String) {
        Creds.clear(this)
        synchronized(persistLock) {
            // 丢弃已经排队但尚未写入的旧页面状态，避免“忘记账号”后后台线程又把它写回来。
            persistEpoch += 1
            latestPersistAt = 0L
            Store.clear(this)
            // 清掉 AlarmManager 中已经排好的课前/截止提醒。
            ReminderScheduler.schedule(this, null)
        }
        replyOk(id, "{}")
    }

    override fun onNotify(title: String?, body: String?) {
        runOnUiThread { Notify.show(this, title ?: "仰山课表", body.orEmpty()) }
    }

    override fun onNotifyReminder(title: String?, body: String?, tag: String?) {
        runOnUiThread { Notify.showReminder(this, title ?: "仰山课表提醒", body.orEmpty(), tag) }
    }

    override fun onRequestNotifications(id: String) {
        runOnUiThread {
            if (Notify.notificationsEnabled(this)) {
                ReminderScheduler.rescheduleFromStore(this)
                reply(JSONObject().put("id", id).put("ok", true).put("pack", JSONObject().put("granted", true)))
                return@runOnUiThread
            }
            if (Build.VERSION.SDK_INT < 33) {
                // 低版本没有运行时权限，但用户仍可能在系统设置里关闭整个应用通知。
                // 不能把“无运行时权限”误报成“通知已开启”。
                openNotificationSettings()
                reply(JSONObject().put("id", id).put("ok", false).put("error", "请在系统设置中允许仰山课表通知。"))
                return@runOnUiThread
            }
            if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) !=
                android.content.pm.PackageManager.PERMISSION_GRANTED
            ) {
                pendingNotifyId = id
                requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFY)
                return@runOnUiThread
            }
            // 运行时权限已授予但应用通知总开关/渠道被用户关闭时，重复 requestPermissions
            // 不会触发回调，必须直接带用户去系统设置并回失败包。
            openNotificationSettings()
            reply(JSONObject().put("id", id).put("ok", false).put("error", "请在系统设置中允许仰山课表通知。"))
        }
    }

    private fun openNotificationSettings() {
        try {
            startActivity(
                Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, packageName),
            )
        } catch (_: Exception) {
            try {
                startActivity(
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                        .setData(Uri.parse("package:$packageName")),
                )
            } catch (_: Exception) {
                // 某些定制系统没有通知详情页，保留网页端失败提示即可。
            }
        }
    }

    override fun onRequestBackgroundAccess(id: String) {
        runOnUiThread {
            val opened = try {
                val pm = getSystemService(POWER_SERVICE) as PowerManager
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M &&
                    !pm.isIgnoringBatteryOptimizations(packageName)
                ) {
                    startActivity(
                        Intent(
                            Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                            Uri.parse("package:$packageName"),
                        ),
                    )
                    true
                } else {
                    false
                }
            } catch (_: Exception) {
                false
            }
            if (!opened) {
                try {
                    startActivity(
                        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                            .setData(Uri.parse("package:$packageName")),
                    )
                } catch (_: Exception) {
                    // 某些定制系统没有应用详情页，仍给网页一个可处理的成功回包。
                }
            }
            reply(
                JSONObject()
                    .put("id", id)
                    .put("ok", true)
                    .put(
                        "pack",
                        JSONObject().put(
                            "message",
                            if (opened) "请在系统页面允许忽略电池优化；若仍不刷新，再到应用详情开启通知和后台运行。"
                            else "请在系统页面开启通知和允许后台运行。",
                        ),
                    ),
            )
        }
    }

    override fun onOpenAppSettings(id: String) {
        runOnUiThread {
            try {
                startActivity(
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                        .setData(Uri.parse("package:$packageName")),
                )
                reply(JSONObject().put("id", id).put("ok", true).put("pack", JSONObject()))
            } catch (e: Exception) {
                replyError(id, "无法打开应用权限设置：${e.message ?: "未知错误"}")
            }
        }
    }

    override fun onPersistState(json: String?, updatedAt: Long) {
        if (json.isNullOrBlank()) return
        val epoch: Long
        synchronized(persistLock) {
            if (updatedAt < latestPersistAt) return
            latestPersistAt = updatedAt
            epoch = persistEpoch
        }
        Thread {
            synchronized(persistLock) {
                // 用户可能已经点了“忘记账号/清除数据”，此时这份页面副本已经过期。
                if (epoch != persistEpoch || updatedAt < Store.stateAt(this)) return@synchronized
                runCatching {
                    Store.saveState(this, json, updatedAt)
                    ReminderScheduler.schedule(this, json)
                }
            }
        }.start()
    }

    /**
     * 首次安装主动把最关键的系统授权交给用户确认，避免厂商系统在后台首次使用
     * 时静默拒绝。通知权限之后再打开电池优化设置；没有精确闹钟特殊权限时，
     * ReminderScheduler 会自动降级为省电闹钟，不阻塞首次使用。
     */
    private fun requestInitialSensitivePermissions() {
        val prefs = getSharedPreferences(RUNTIME_PREFS, MODE_PRIVATE)
        if (prefs.getBoolean(K_INITIAL_PROMPTED, false)) return
        prefs.edit().putBoolean(K_INITIAL_PROMPTED, true).apply()
        initialPermissionFlow = true
        // 先创建高重要性频道。这样即使用户还没有课表/待办，
        // 系统安装后的提醒频道也已经具备弹窗和锁屏显示能力。
        Notify.prepareReminderChannel(this)
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) !=
            android.content.pm.PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFY)
        } else {
            openInitialFullScreenAccess()
        }
    }

    private fun openInitialFullScreenAccess() {
        if (!initialPermissionFlow) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            if (!manager.canUseFullScreenIntent()) {
                try {
                    initialFullScreenSettingsOpened = true
                    startActivity(
                        Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT)
                            .setData(Uri.parse("package:$packageName")),
                    )
                    return
                } catch (_: Exception) {
                    // 部分厂商没有这个系统页面，继续走后台权限引导。
                    initialFullScreenSettingsOpened = false
                }
            }
        }
        openInitialBackgroundAccess()
    }

    private fun openInitialBackgroundAccess() {
        if (!initialPermissionFlow) return
        initialPermissionFlow = false
        try {
            val pm = getSystemService(POWER_SERVICE) as PowerManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M &&
                !pm.isIgnoringBatteryOptimizations(packageName)
            ) {
                startActivity(
                    Intent(
                        Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                        Uri.parse("package:$packageName"),
                    ),
                )
            }
        } catch (_: Exception) {
            // 定制系统不提供该页面时，用户仍可在设置页手动允许。
        }
    }

    override fun onOpen(url: String?) {
        if (!url.isNullOrBlank()) open(url)
    }

    @Deprecated("Activity自带的权限回调")
    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_NOTIFY) return
        val granted = Notify.notificationsEnabled(this)
        pendingNotifyId?.let { id ->
            pendingNotifyId = null
            if (granted) {
                AnnPush.apply(this)
                ReminderScheduler.rescheduleFromStore(this)
                reply(JSONObject().put("id", id).put("ok", true).put("pack", JSONObject().put("granted", true)))
            } else {
                reply(JSONObject().put("id", id).put("ok", false).put("error", "请在系统设置中允许仰山课表通知。"))
            }
        }
        if (initialPermissionFlow) openInitialFullScreenAccess()
    }

    /**
     * 网页端保存「公告源」时把频道名与公告地址送过来。
     *
     * 单向：不回包。成功与否由下一次 `status` 的 `annPush` 字段说话 ——
     * 前台服务是异步起来的，此刻回「成功」是不诚实。
     */
    override fun onAnnPush(sourcesJson: String?, base: String?) {
        if (sourcesJson.isNullOrBlank()) {
            AnnPush.clear(this)
            return
        }
        AnnPush.save(this, sourcesJson, base.orEmpty())
    }

    // ── 抓取回来的路上 ──────────────────────────────────────────────────────

    /**
     * 内核自己会把课表存进 localStorage，正常情况下用不上这里。
     * 但换手机、清数据、重装之后 localStorage 会空 —— 那时用 Store 里的备份把它填回去。
     */
    private fun restoreIfNeeded() {
        val stateAt = Store.stateAt(this)
        val rawAt = Store.rawAt(this)
        if (stateAt <= 0L && rawAt <= 0L) return
        // 先只问一个问题：本地那份是什么时候写的。绝大多数启动本地都是最新的，
        // 那就完全不该去读几 MB 的状态文件，更不该把它拼进一段 JS 注入进来 ——
        // 之前每次 onPageFinished 都无条件做这件事。
        web.evaluateJavascript(
            "(function(){return String(Number(localStorage.getItem('yangshan-schedule/v1/updatedAt')||0));})()",
        ) { probe ->
            val localAt = probe?.trim()?.trim('"')?.toLongOrNull() ?: 0L
            when {
                stateAt > localAt -> restoreFullState(stateAt)
                rawAt > localAt -> restoreRawCapture()
            }
        }
    }

    /** 读文件 + 拼脚本都放后台线程：状态可能有几 MB，JSON 转义在主线程上能明显卡顿。 */
    private fun restoreFullState(stateAt: Long) {
        Thread {
            val full = Store.state(this)
            if (full.isNullOrBlank()) return@Thread
            val js = """
                (function () {
                  try {
                    localStorage.setItem('yangshan-schedule/v1', ${JSONObject.quote(full)});
                    localStorage.setItem('yangshan-schedule/v1/updatedAt', "$stateAt");
                    location.reload();
                    return 'full-restored';
                  } catch (e) { return 'full-restore-error: ' + e.message; }
                })()
            """.trimIndent()
            runOnUiThread { web.evaluateJavascript(js, null) }
        }.start()
    }

    /** 只有「没有完整副本、但有上次抓取的原始课表」这条老路才会走到这里。 */
    private fun restoreRawCapture() {
        Thread {
            val raw = Store.raw(this)
            if (raw.isNullOrBlank()) return@Thread
            runOnUiThread { importRefreshedRaw(raw) }
        }.start()
    }

    /** 把后台刷新或本地备份的原始课表送回当前页面，并保留用户修改记录。 */
    private fun importRefreshedRaw(raw: String) {
        val js = """
            (function () {
              if (!globalThis.YangShan) return 'no-bridge';
              try {
                YangShan.importText(${JSONObject.quote(raw)}, { preserveChanges: true });
                return 'restored';
              } catch (e) { return 'error: ' + e.message; }
            })()
        """.trimIndent()
        web.evaluateJavascript(js) { result ->
            if (result?.contains("no-bridge") == true) {
                pendingRefreshRaw = raw
            } else if (pendingRefreshRaw == raw) {
                pendingRefreshRaw = null
            }
        }
    }

    // ── 回包 ────────────────────────────────────────────────────────────────

    private fun replyOk(id: String, packJson: String) {
        val payload = JSONObject().put("id", id).put("ok", true)
        try {
            payload.put("pack", JSONObject(packJson))
        } catch (e: Exception) {
            replyError(id, "抓到的数据不完整。")
            return
        }
        reply(payload)
    }

    private fun replyError(id: String, message: String) {
        reply(JSONObject().put("id", id).put("ok", false).put("error", message))
    }

    /**
     * ★ 安卓没有 WebView2 那种 postMessage，回包得靠 evaluateJavascript 调 shim 里的
     *   `__ysShellReply`。这个不对称由 shells/shim.js 内部吸收掉了。
     */
    private fun reply(payload: JSONObject) {
        val js = "__ysShellReply(" + JSONObject.quote(payload.toString()) + ")"
        web.post { web.evaluateJavascript(js, null) }
    }

    private fun open(url: String) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        } catch (e: Exception) {
            // 手机上没有能打开它的应用 —— 不是错误，算了。
        }
    }

    override fun onDestroy() {
        refreshReceiver?.let {
            try {
                unregisterReceiver(it)
            } catch (_: Exception) {
                // 已经注销或 Activity 初始化中断。
            }
        }
        refreshReceiver = null
        web.destroy()
        super.onDestroy()
    }
}
