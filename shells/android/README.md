# 仰山课表 · 安卓壳

把课表内核（`dist/仰山课表.html`）装进一个真正的安卓应用，并补上浏览器做不到的两件事：
**直连学校教务抓数据**、**每小时后台刷新**。

> ✅ **本工程已编译验证过。** 2026-10-10 在一台装了 JDK 21.0.8（Microsoft build）、
> Android SDK（`build-tools;36.0.0` + `platforms;android-35` + `platform-tools`）、Gradle 8.11.1 的
> Windows 机器上跑通了 `gradle assembleDebug`：
>
> ```
> BUILD SUCCESSFUL in 15s
> 产物 app/build/outputs/apk/debug/app-debug.apk
>   9,684,062 字节（9.24 MB）
>   SHA256 F47D2FB85B9825F0D02DD3DD6B2834B4B9E0375ED27223DBAE6ACB325721B061
> ```
>
> 只剩三条 deprecation 警告（`WebSettings.databaseEnabled` 两处、`onBackPressed()` 一处），不影响构建。
> 第一次编译报了 4 个真错，都已经修进代码里了，见下面「构建时踩过的坑」。
> **还没做的**：真机 / 模拟器安装运行（构建机器上没有 adb 设备），所以 `RefreshWorker` 那个
> 无窗口 WebView 仍然只有代码、没有真机证据 —— 见「风险最高的地方」一节。

---

## 构建

```bash
# 1. 先生成课表内核（在仓库根）
node web/build.mjs

# 2. 把内核与共享脚本拷进 assets/，并把 shim.js 内联进 index.html
cd shells/android
node tools/prepare-assets.mjs

# 3. 构建 APK —— 二选一
#    a) 用 Android Studio 打开 shells/android/（会自动生成 gradle wrapper），然后 Build APK
#    b) 命令行（需要本机有 Gradle 8.9+；AGP 8.7.3 的最低要求）
gradle wrapper --gradle-version 8.11.1
./gradlew assembleDebug
# 产物：app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

需要的工具链：**JDK 17+**（实测用 21）、**Android SDK Platform 35** + **Build-Tools 36.0.0**、Gradle 8.11.1。
第一次 `assembleDebug` 会下载 AGP 8.7.3 与 Kotlin 2.0.21，实测依赖缓存约 **768 MB**。

`local.properties` 里要指到本机的 SDK（这个文件不入库）：

```properties
sdk.dir=C\:\\Program Files (x86)\\Android\\android-sdk
```

### 换一台机器构建时最容易卡住的两件事

1. **`Gradle` 从哪来。** `services.gradle.org` 的下载链接会 307 跳到 GitHub Releases，
   国内直连 GitHub 常常超时。用镜像即可：
   `https://repo.huaweicloud.com/gradle/gradle-8.11.1-bin.zip`（也支持断点续传）。
2. **`GRADLE_USER_HOME` / `ANDROID_USER_HOME` 写不了。** 默认落在 `%USERPROFILE%\.gradle` 与
   `%USERPROFILE%\.android`，若这些位置不可写（受限账户、沙箱），Gradle 会直接失败或每次
   警告 `Unable to initialize metrics, ensure …\.android is writable`。把它们指到可写目录即可。

### 构建时踩过的坑（都已经修好了，记在这里免得下次再踩）

| 报错 | 真因 | 修法 |
| --- | --- | --- |
| `Your project path contains non-ASCII characters. … See http://b.android.com/95744` | 仓库放在 `D:\ds工作区\` 下，路径含中文。AGP 默认拒绝 | `gradle.properties` 里 `android.overridePathCheck=true`（build-tools 36 + AGP 8.7 实测能吃中文路径） |
| `Couldn't open current thread, error = 5`（`File watcher server`） | 原生文件监视器在受限环境里起不来。非致命 | 加 `--no-watch-fs` |
| `Unresolved reference 'MasterKey'` | `androidx.security:security-crypto:1.0.0` **没有** `MasterKey` 这个类（1.1.0-alpha 才有），且这个版本的 `create` 签名是 `create(fileName, masterKeyAlias, context, …)` | 改用同版本的 `MasterKeys.getOrCreate(MasterKeys.AES256_GCM_SPEC)` + `create(FILE, alias, ctx, …)`；主密钥同样在 Android Keystore，只是 API 被标了 `@Deprecated` |
| `Argument type mismatch: actual type is 'androidx.work.ListenableWorker.Result', but 'kotlin.Result<…>' was expected` | `CoroutineWorker` 继承自 `ListenableWorker`，它的嵌套类 `Result` **遮蔽**了 `kotlin.Result` | 写全限定名 `kotlin.Result.failure(…)` |

---

## 目录

```
shells/android/
├── settings.gradle.kts            仓库源、include(":app")
├── build.gradle.kts               AGP 8.7.3 / Kotlin 2.0.21
├── gradle.properties
├── tools/prepare-assets.mjs       内核 + capture.js → assets/，shim.js 内联进 index.html
└── app/
    ├── build.gradle.kts           compileSdk 35 / minSdk 26 / targetSdk 35
    ├── proguard-rules.pro         保住 @JavascriptInterface 的方法名
    └── src/main/
        ├── AndroidManifest.xml
        ├── assets/                 ← prepare-assets.mjs 生成，不入库
        ├── res/                    字符串、主题、自适应图标（位图，来源见 ../README.md 的「图标」节）
        └── java/dev/yangshan/schedule/
            ├── MainActivity.kt     内核主窗口 + 壳接口的安卓侧实现
            ├── SchoolActivity.kt   教务窗口（平时自己关掉，只在要人过验证码时露出来）
            ├── SchoolWeb.kt        「开教务 → 填账号 → 等课表页 → 调 __ysCapture」整套流程
            ├── RefreshWorker.kt    每小时后台抓一次（WorkManager）
            ├── AutoRefresh.kt      排周期任务
            ├── ShellBridge.kt      页面 → 壳的入口（YangShanNative.post）
            ├── Creds.kt            加密存账号密码 + 普通存课表备份
            └── Notify.kt           「课表已更新」通知
```

---

## 与 Windows 壳的对应关系

做的是同一件事，只是平台换了一套 API。改一边时记得看另一边。

| 干什么 | Windows（`shells/windows/`） | 安卓（本目录） |
| --- | --- | --- |
| 内核从哪来 | `dist/仰山课表.html` 作为 `EmbeddedResource` 打进 exe | `prepare-assets.mjs` 拷成 `assets/index.html` |
| 内核托在哪个源 | `SetVirtualHostNameToFolderMapping` → `https://yangshan.local/` | `WebViewAssetLoader` → `https://appassets.androidplatform.net/` |
| 壳接口怎么进去 | `AddScriptToExecuteOnDocumentCreatedAsync` 注入 `shim.js` | 打包时内联进 `index.html` |
| 页面 → 壳 | `chrome.webview.postMessage` | `YangShanNative.post`（`@JavascriptInterface`） |
| 壳 → 页面 | `PostWebMessageAsJson` → `chrome.webview` 的 `message` 事件 | `evaluateJavascript("__ysShellReply(...)")` |
| 异步结果怎么等 | CDP `Runtime.evaluate` + `awaitPromise:true` | 页面抓到后主动 post 回来 |
| 凭据存哪 | Windows 凭据管理器（`CredWriteW`） | `EncryptedSharedPreferences`（密钥在 Android Keystore） |
| 定时刷新 | `System.Windows.Forms.Timer`，60 分钟 | WorkManager 周期任务，1 小时 |
| 抓取实现 | `shells/capture.js`（EmbeddedResource） | `shells/capture.js`（`assets/`，运行时注入） |

两个壳共用 `shells/capture.js` 与 `shells/shim.js` —— **同一份文件，不是两份拷贝**，
这样改一次抓取逻辑两边同时生效（书签小工具也是同一份 `capture.js`）。

---

## 几个刻意的取舍

- **minSdk 26（Android 8.0）**。为了直接用 `NotificationChannel` 与 `EncryptedSharedPreferences`，
  不用为老系统写一堆分支。2026 年这个下限挡不到任何在读的同学。
- **不引 AppCompat / Material Components**。整个壳只有两个 Activity 和一个 WebView，
  多引一个 UI 库就是白多几 MB。
- **账号密码进 EncryptedSharedPreferences**，密钥由 Android Keystore 管。
  与 Windows 壳的凭据管理器同一个角色：**不写明文文件、不进日志、不上传**。
- **教务抓取全部在 WebView 里做**，不用 `HttpURLConnection`/OkHttp。两个原因：
  ① 学校页面上跑就等于同源，没有 CORS 也没有 SameSite 的墙；
  ② 走 WebView 的完整 TLS 栈 —— `jwxt.bistu.edu.cn` 的证书链不完整（只发叶子证书、不发中间证书），
     自己发 HTTPS 请求会撞 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`。**这条坑在 Windows 壳那边也踩过。**
- **登录表单在 iframe 里**，自动填表不能只看 `document`。
  好消息是 `sso.bistu.edu.cn` 的 iframe 同源，主框架 JS 能直接摸到 `contentDocument`，
  所以不需要任何「按 frame 执行 JS」的 API（安卓的 WebView 本来也没有）。
  **而且它比主框架的 `onPageFinished` 晚约 380ms 才建好**（2026-10-16 用 25ms 粒度探针实测：
  `onPageFinished` 在 t≈647ms、表单在 t≈1025ms），所以填表必须**轮询**，只试一次必然拿到 `noform`。
  Windows 壳没有这个问题 —— 它挂的是 `FrameCreated`，在 iframe 自己导航完成时才填。
- **登录页是 Vue 的 `v-model`**：`el.value = x` 不会更新 Vue 状态，
  必须走原型上的原生 setter 再派发冒泡的 `input`/`change`。这条也从 Windows 壳那边照搬。
- **★ 教务窗口必须报桌面版 UA**（`SchoolWeb.kt` 的 `DESKTOP_UA`），
  **不要**改回 `web.settings.userAgentString + " YangShanShell/…"`。
  教务系统按 UA 分流：安卓 UA 会被 SSO 送到 `normal/login-mobile.html`（Vant 手机版），
  **而手机分支里没有课表页**。2026-10-16 真机上报「登录过去了但是个空白页、抓不到课表」就是这个原因；
  同一系统在 Windows 壳（桌面版 WebView2）上一直是好的 —— 两边唯一的差别就是 UA。
  配套还要 `useWideViewPort` + `loadWithOverviewMode`，否则定宽的桌面版页面在手机上只看得到左上角一块。
- **★ 桌面版登录页是「扫码 / 账号密码 / 短信」三页签，而选中的是哪一个会被记住**。
  源码里 `loginType: 'username-password'` 只是初值，紧接着就被
  `localStorage.getItem('loginType')` 覆盖 —— 所以完全可能停在扫码或短信页。
  那时账号口令表单还在 DOM 里、只是被 `v-show` 藏着，藏着的时候验证码探测永远为 null，
  盲提交过去只会换来一句「登录失败」。所以填表前要先切到「账号密码」页签
  （按页签文字匹配，不要写死索引）。**注意密码框填不填得进去跟页签无关**
  （`v-model` 不挑可见性），切页签是为了「万一要验证码，用户接手时能看见该看的那一屏」。
- **★ 验证码要判「在不在」，不能判「看不看得见」**。那几个标记
  （`#captchaId` / `.ali-captcha` / `.captcha-box` …）是 `v-if="showCaptcha"` 控制的，
  不需要时**根本不在 DOM 里**。反过来用 `offsetParent` 判有两个坑：
  它所在的面板可能正被 `v-show` 藏着，而且 `v-show` 要下一帧才生效 ——
  结果是明明要验证码却判成不用，盲提交、用户只看到一句看不懂的「登录失败」。
  宁可为「要验证码」多问一句。
- **★ `button.btn-submit` 在同一页上会同时命中扫码页的「刷新二维码」**。
  按 DOM 顺序取第一个会点错按钮 —— 必须按「可见 + 文字不是刷新」来挑，
  实在挑不出来就退回在密码框上派发 `keyup Enter`（输入框上本来就挂着 `@keyup.enter="login"`）。
  这套加固**Windows 壳的 `SchoolForm.cs:FillScript` 也要同步**：
  两边跑偏正是这次安卓 bug 的成因，`test/run.mjs` 里有专门断言两边都做到的用例。

---

## 风险最高的地方

`RefreshWorker.kt` —— 后台抓取用的那个**没有窗口的 WebView**。

- WebView 必须在有 Looper 的线程上创建，所以 `doWork()` 整段跑在 `Dispatchers.Main` 上。
  无窗口 WebView 能正常加载页面、带 cookie、跑 JS，这是已知可行的用法，但不算常见，
  **是这套代码里最需要真机验证的一块**。
- 学校页面偶尔会弹验证码，后台线程里没人能帮忙。这种情况下这一步只能放弃（返回 `Result.retry()`），
  等用户下次打开 App 时走前台那条路 —— 那里有窗口，人能接手。
- 真机验证建议：把刷新周期临时改成 15 分钟（`AutoRefresh.kt` 里的 `1, TimeUnit.HOURS`），
  用 `adb shell dumpsys jobscheduler | grep yangshan` 看任务有没有被排上，
  再在 `doWork()` 里打日志确认 WebView 真的拿到了课程数。

如果这块在真机上不work，**最省事的退路是把定时刷新删掉**：App 打开时本来就会静默刷新一次，
而提醒的自动更新其实是靠 `.ics` webcal 订阅——那是手机日历应用自己在轮询，跟壳没关系。
详见 `docs/install-mobile.md`。

---

## 首次运行会经历什么

1. 启动 → 内核显示「尚未导入课表」。
2. 点「导入课表 → 学校账号」→ 填学号口令 → 勾「记住」。
3. 弹出一个教务窗口，自动填好账号并提交（要验证码就手动过一下），然后自己关上。
4. 课表出现在「课表」页。同时写进 `Store`（备份）与内核自己的 `localStorage`。
5. 之后每小时后台刷一次；换了课会自动跟上（UID 里不含教师与地点，所以改教室是原地更新、不会重复）。
