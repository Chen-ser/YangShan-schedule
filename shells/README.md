# 客户端壳 · shells/

课表内核（`web/` 那套网页）本身**不依赖这些壳**：双击 `dist/仰山课表.html` 就能用。
壳只为了补上浏览器给不了的三件事：

| 浏览器做不到 | 壳怎么做 |
| --- | --- |
| 跨源抓教务系统（CORS + SameSite=Lax 两堵墙） | 壳内置一个真浏览器，让学校页面**在自己源里**跑抓取脚本 |
| 每小时后台自动更新 | 壳有自己的定时器，窗口收进托盘/后台也照样跑 |
| 稳定记住账号与课表 | 走系统凭据管理器（Windows Credential Manager / Android EncryptedSharedPreferences），不是网页 localStorage |

## 四端策略

| 平台 | 做法 | 状态 |
| --- | --- | --- |
| Windows | `shells/windows`：WebView2 + WinForms | ✅ 已编译、已安装（开始菜单 / 桌面 / 卸载项）、`--uitest` 自检六项全过 |
| 安卓 | `shells/android`：WebView + Gradle | ✅ `gradle assembleDebug` 通过，APK 9.24 MB（SHA256 `F47D2FB8…`）；**真机安装运行未验**（构建机无 adb 设备） |
| iOS / iPadOS | 不加壳：Safari「添加到主屏幕」+ 书签小工具 + `.ics` 订阅 | 见 `docs/install-mobile.md` |
| 鸿蒙 HarmonyOS | 同上（浏览器「添加到桌面」） | 见 `docs/install-mobile.md` |

> iOS 不给第三方挂后台定时器，也不给跨源请求，所以 iOS 上唯一能走通的路线是
> 「网页 PWA + 书签抓取 + webcal 订阅日历」。这条路线不装任何东西，代价是要手动点一下书签。

## `capture.js`：抓取逻辑只有这一份

`shells/capture.js` 是**唯一**的抓取实现，挂 `globalThis.__ysCapture`：

```js
const raw = await __ysCapture({ source: 'windows' });   // → { kind:'yangshan-raw', schema:1, … }
__ysCapture.rawText(raw);                                // → 'YSRAW1-' + base64url(JSON)
```

三个调用方都用它，**改抓取规则只改这一个文件**：

- **书签小工具** —— `web/build.mjs` 把 `shells/capture.js` 与 `bookmarklet/grab.js`（只有界面）拼起来，产出 `dist/bookmarklet.txt`。
- **Windows 壳** —— `.csproj` 里 `<EmbeddedResource Include="..\capture.js">`，运行时读出来注入学校页面。
- **安卓壳** —— Gradle 把 `../capture.js` 拷进 `app/src/main/assets/`。

## 壳与内核之间的两个约定

**壳 → 内核**（在内核页面文档创建时注入）：

```js
globalThis.YangShanShell = {
  name: 'windows' | 'android',
  version: 1,
  login(username, password),   // → Promise<raw>，raw 直接喂给内核的 normalizeSchedulePack
  refresh(),                   // 可选：静默刷新
  status(),                    // 可选：壳的状态
  forget(),                    // 可选：忘掉记住的账号
  notify(title, body),         // 可选：系统通知
  openExternal(url),           // 可选：外部浏览器打开
};
```

内核 `web/app.js:676` 读它：**读到就把「输入教务账号密码」做成真能用的入口，读不到就走降级说明页**（讲清楚为什么浏览器做不到，并给出文件/书签/手动三条退路）。所以壳只要注入这一个对象，内核侧零改动。

**内核 → 壳**（`web/app.js:1826` 挂 `globalThis.YangShan`）：

```js
YangShan.version;              // '0.1.0'
YangShan.hasSchedule();        // → boolean
YangShan.summary();            // → { termName, studentCode, courses, events, … }
YangShan.importRaw(obj);       // 导入一份原始抓取结果（与文件导入、书签完全同一条解析路径）
YangShan.importText(text);     // 导入分享码 / YSRAW1- 串 / 粘贴文本
YangShan.toIcal(opts);         // → .ics 文本
YangShan.dump();               // → 当前课表快照
```

往内核里送数据有两条约定，任选一条：

- **约定 A（先注入再导航）**：导航前挂 `window.__YS_PACK__ = raw`（`web/app.js:1840`）。
- **约定 B（先导航再注入）**：等 `document.documentElement.dataset.ready === '1'`（`web/app.js:1869`），
  再执行 `YangShan.importRaw(raw)`。**Windows 壳走的是这条**（`MainForm.PushToPageAsync`）。

---

## Windows 壳 · `shells/windows/`

WebView2 + WinForms，`.NET 10`，单 exe + 一个内核 DLL 就能发出去。

### 目录

```
shells/windows/
  YangShanShell.csproj      net10.0-windows / UseWindowsForms / Microsoft.Web.WebView2 1.0.3351.48
  Program.cs                入口（--selfcheck / --uitest）+ 崩溃日志
  Shell.cs                  ShellRuntime（数据目录、内核来源、WebView2 环境、EvalAsync）+ CredStore（凭据）
  MainForm.cs               主窗口 + 壳接口注入 + 托盘 + 每小时自动刷新
  SchoolForm.cs             教务窗口：驱动学校登录页、自动填表、调 __ysCapture 抓取
  UiTest.cs                 --uitest：真开窗口、真加载内核、逐项核对桥的两端
  NuGet.config              指向本地 feed/（见下）
  tools/fetch-nupkg.mjs     用 Node 下 .nupkg 到 feed/
  build.ps1                 一条龙：内核 → nupkg → dotnet build → out/
  feed/ bin/ obj/ out/ .dotnet/ .nuget/ _runtime/     ← 全是产物，已 gitignore
```

### 构建

```powershell
cd shells\windows
.\build.ps1            # 产物在 out\，含 YangShanShell.exe + Microsoft.Web.WebView2.*.dll + runtimes\
```

`build.ps1` 刻意**只用 ASCII**：PowerShell 5.1 读没有 BOM 的 `.ps1` 会按 ANSI(GBK) 解码，
中文字面量会变成乱码。所以脚本里不写「仰山课表.html」，改用 `Get-ChildItem dist -Filter *.html` 拿文件名。

### 自检（两个，都不用看界面）

```powershell
# 1) 静态自检：内核有没有打进 exe、WebView2 在不在、数据目录能不能写
.\bin\Release\net10.0-windows\YangShanShell.exe --selfcheck --data <可写目录>

# 2) 界面自检：真开窗口、真加载内核，核对 localStorage / 双向桥 / postMessage 往返，跑完自己退出
.\bin\Release\net10.0-windows\YangShanShell.exe --uitest --data <可写目录> --wait 30000
```

**实测结果（2026-10-09）**：

```
内核来源            exe 内嵌（10,583,465 字节）
抓取内核            4,063 字符
主页地址            https://yangshan.local/index.html
WebView2        154.0.4258.62（内核 1.0.3351.48）
虚拟主机            yangshan.local → <数据目录>\app
内核就绪            是
页面探针            {"ready":"1","bridge":"object","bridgeVersion":"<版本号>","shell":"object",
                     "shellName":"windows","tabs":5,"storage":"ok", …}
内核桥             ✔ globalThis.YangShan 已就位
壳接口             ✔ globalThis.YangShanShell 已注入
本地存储            ✔ localStorage 可读可写（课表存得住）
壳往返通信           ✔ {"name":"windows","version":"<版本号>","hasSchedule":false,"autoRefresh":true,…}
导入入口            ✔ YangShan.importRaw 可用
结果：界面自检通过。
```

> 上面是**示例输出**：`<版本号>` 处实际会打印 `package.json` 里的当前版本（构建时注入
> `__VERSION__`），字段列表也可能随实现增减。

界面自检的退出码就是判据：`0` 通过，`1` 不通过，报告写 `uitest.txt`。

### 几个非做不可的设计

1. **内核托在虚拟 https 源上**（`SetVirtualHostNameToFolderMapping("yangshan.local", …)`），
   **不能直接 `file://` 打开** —— Chromium 在 `file://` 下不给 `localStorage`，而内核靠它存课表。
   （界面自检里的「本地存储 ✔」就是这条的回归测试。）
2. **抓取全在 WebView2 里做**，**不用 .NET `HttpClient`** ——
   学校 `jwxt.bistu.edu.cn` 的 TLS 链路不完整（只发叶子证书、不发 GlobalSign 中间证书），
   .NET / Node / curl 一律 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`；浏览器靠 AIA 自动补链所以没事。
3. **`ExecuteScriptAsync` 不会 await Promise**（返回 `{}`）。要拿异步结果必须走
   `CoreWebView2.CallDevToolsProtocolMethodAsync("Runtime.evaluate", {"awaitPromise":true,"returnByValue":true})`
   —— 见 `ShellRuntime.EvalAsync`。
4. **登录页是 Vue 的 `v-model`**：直接 `el.value = x` 不会更新 Vue 状态，必须用原型上的原生 setter
   （`Object.getOwnPropertyDescriptor(el.constructor.prototype,'value').set.call(el, v)`）再派发冒泡的 `input`。
   而且表单在 **iframe** 里，`CoreWebView2.FrameNavigationCompleted` 的 args **拿不到 frame**，
   只能挂 `CoreWebView2.FrameCreated` 逐个 frame 订阅。
5. **凭据走 Windows 凭据管理器**（`CredStore`，`advapi32` 的 `CredWriteW/CredReadW/CredDeleteW`），
   **密码绝不写进 settings.json、日志、崩溃报告**。
6. **关窗口 = 收进托盘**，真要退出走托盘菜单 —— 否则「每小时自动更新」这个卖点就没了。

### 数据放在哪

按 `--data` → `%LOCALAPPDATA%\YangShanSchedule` → `%TEMP%\YangShanSchedule` → exe 同级 `data\`
的顺序找**第一个写得进去的**目录（每一步都真写一个 `.probe` 文件探活）。
`%LOCALAPPDATA%` 在受限环境里会被拒（`System.UnauthorizedAccessException`），
早先版本就是在这里崩在启动画面上的 —— 所以现在宁可退到临时目录也不崩。

### 故障排查

| 现象 | 先看 |
| --- | --- |
| 双击没反应 / 一闪而过 | exe 同级的 `crash.log`（含时间、版本、系统、.NET、完整堆栈） |
| 提示「装一下 WebView2 Runtime」 | `--selfcheck` 看 WebView2 那一行；Win10/11 一般自带 |
| 课表存不住、刷新就没了 | `--uitest` 看「本地存储」是不是 ✘ |
| 自动更新不跑 | 托盘菜单里「每小时自动更新」有没有勾上 |

### 沙箱 / CI 里的坑（给未来的自己）

- **`dotnet` 默认写 `C:\Users\<你>\.dotnet`，受限环境一律拒绝**：
  `System.UnauthorizedAccessException: Access to the path 'C:\Users\…\.dotnet' is denied.`
  → 把 `DOTNET_CLI_HOME` 和 `NUGET_PACKAGES` 都指到工程内（`build.ps1` 就是这么做的）。
- **`dotnet restore` 的 HTTPS 通道在受限环境里会被卡死**：
  `NU1301: 无法加载源 https://api.nuget.org/v3/index.json … The SSL connection could not be established`。
  → 用 Node（自带 OpenSSL，不受 schannel 影响）下 `.nupkg` 到 `feed/`，再用 `NuGet.config` 的
  `<packageSources><clear />` 只留这一个本地文件夹源。`tools/fetch-nupkg.mjs` 干这件事。
- **WebView2 需要真桌面会话**：在没有交互桌面的沙箱里 `EnsureCoreWebView2Async` 会拿不到 `CoreWebView2`，
  `--uitest` 会报「WebView2 没初始化出来」。这不是壳的 bug。
- **别用 PowerShell 反射查 WebView2 的 API**：
  `[Reflection.Assembly]::LoadFrom('Microsoft.Web.WebView2.Core.dll')` 在 PS 5.1 下必定失败
  （`HRESULT:0x80131515`，那是 .NET Framework 程序集）。去读 nupkg 里的 `Microsoft.Web.WebView2.Core.xml`。

---

## 安卓壳 · `shells/android/`

**已编译验证**：`gradle assembleDebug` 跑通（Gradle 8.11.1 + JDK 21 + AGP 8.7.3 + Kotlin 2.0.21），
产物 `app-debug.apk` **9,684,062 字节**，SHA256 `F47D2FB85B9825F0D02DD3DD6B2834B4B9E0375ED27223DBAE6ACB325721B061`，
`classes.dex` 与 `assets/index.html`、`assets/capture.js` 都在包里。
只剩三条 deprecation 警告。**真机安装运行尚未验证**（构建机上没有 adb 设备），所以 `RefreshWorker`
那个无窗口 WebView 仍然只有代码、没有真机证据 —— 详细取舍与踩坑见 `shells/android/README.md`。

与 Windows 壳逐条对应：

| 关注点 | Windows | 安卓 |
| --- | --- | --- |
| 内核来源 | 内嵌 `app.html` 资源 | `assets/index.html`（构建时从 `dist/` 拷） |
| 内核源地址 | `SetVirtualHostNameToFolderMapping` → `https://yangshan.local/` | `WebViewAssetLoader` → `https://appassets.androidplatform.net/assets/index.html` |
| 壳接口 | `AddScriptToExecuteOnDocumentCreatedAsync(Shim)` + `postMessage` | `addJavascriptInterface` + `postMessage`（同样一份 shim） |
| 凭据 | Windows 凭据管理器 | `EncryptedSharedPreferences` |
| 定时刷新 | `System.Windows.Forms.Timer` | `WorkManager` 周期任务 + 前台服务 |
| 抓取 | 隐藏的第二个 WebView2 | 隐藏的第二个 `WebView` |

## iOS / 鸿蒙

不加壳，见 `docs/install-mobile.md`。那是本项目的**默认路径**，壳只是电脑上的加速器。
