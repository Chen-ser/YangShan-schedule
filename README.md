# 仰山课表

北京信息科技大学课表工具。它把教务系统课表整理成可查看、可编辑、可提醒、可导出日历的本地应用，并提供 Windows 壳、Android 壳和纯网页版本。

项目默认不需要服务器账号。课表、待办、修改记录和历史对话保存在本机；只有用户主动配置智能助手并发送材料时，相关内容才会发送到用户填写的 AI API。

## 功能

- 周课表、总课表和逐日查看
- 课程点击编辑：课程名、教师、地点、上下课时间、节次等
- 长按拖动课程，拖动时锁定页面滚动
- 课程修改记录：记录本地修改与教务系统课表差异
- 教务刷新时确认是否保留本地修改
- 上课、作业、网课截止时间和公告提醒
- 待办添加、编辑、删除和提醒
- 公告栏、共享公告源、本机公告和 Android 后台公告通知
- 课表文件导入：XLSX、DOCX、截图 OCR、抓取结果和手动录入
- 智能助手：通知截图、PDF、DOCX、PPTX、文本分析，自动提取重点、截止时间和待办
- Android 可从微信等应用分享文字或文件，自动打开助手并载入附件
- PDF 在本机逐页转换为图片后发送给视觉模型，最多处理前 6 页
- 助手历史对话、附件上下文恢复和本地归档
- 导出 ICS 日历、备份 JSON、分享码和课表图片

## 三种使用方式

| 版本 | 适用场景 | 入口 |
| --- | --- | --- |
| 纯网页 | iOS、鸿蒙、桌面浏览器 | `dist/site/` 或 `dist/仰山课表.html` |
| Windows 壳 | 教务登录、自动刷新、桌面通知 | `shells/windows/` |
| Android 壳 | 教务登录、后台刷新、系统通知 | `shells/android/` |

纯网页版本不提供教务系统一键提取和自动定时刷新。网页端请使用课表文件、截图、书签抓取工具或分享码导入。

## 使用入口

应用底部导航为：

`课表` · `逐日` · `待办` · `助手` · `公告` · `设置`

常用功能位于「设置」：

- 导入课表
- 抓取工具
- 编辑课表
- 导出与备份
- 课表修改记录
- 公告源
- 智能助手 API 配置

### 智能助手

在「设置 → 智能助手 · DeepSeek」中填写：

- API 地址，默认 `https://api.deepseek.com`
- API Key
- 模型，默认 `deepseek-flash`
- 是否启用联网增强
- 思考强度

注入提示词由程序内部生成，用户界面不会展示或复制它。助手识别出的带截止时间事项会先让用户确认，再写入待办。

## 开发环境

- Node.js 22 或更高版本
- Android 构建需要 Android SDK、JDK 21 和 Gradle 8.11.1
- Windows 壳需要 .NET SDK 10 和 WebView2 SDK 包

项目不依赖 `node_modules`。OCR 和 PDF.js 运行资产已经放在 `vendor/` 中。

## 网页构建

```powershell
npm test
npm run build
```

构建结果：

- `dist/仰山课表.html`：单文件版本，可直接双击打开
- `dist/site/`：托管版 PWA
- `dist/bookmarklet.txt`：抓取书签工具

预览：

```powershell
npm run preview
```

## Android 构建

先生成 WebView 资源：

```powershell
node shells/android/tools/prepare-assets.mjs
```

再在 `shells/android/` 目录执行：

```powershell
gradle --no-watch-fs --no-daemon assembleDebug
```

APK 输出在：

```text
shells/android/app/build/outputs/apk/debug/app-debug.apk
```

Android 壳包含教务系统 SSL 受限处理、诊断日志、后台公告服务和系统通知。真机登录、后台通知、文件选择器和厂商电池策略需要在实际设备上验证。

Android 也注册为系统分享目标。微信中选择文件或文字后，通过系统分享面板选择“仰山课表”，应用会打开助手页并自动载入内容；只接受 PDF、图片、文本、JSON、Word、PowerPoint，单个文件上限 30 MB，一次只导入第一个（选多了会提示）。

## Windows 构建

在 `shells/windows/` 目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\build.ps1
```

可运行文件输出在：

```text
shells/windows/out/
```

安装入口：

```text
shells/windows/installer.cmd
```

Windows 壳把网页核心嵌入 EXE，并支持自动刷新设置、教务登录和系统通知。

## 测试与检查

```powershell
npm test
node tools/check-secrets.mjs
git diff --check
```

当前测试覆盖：

- 课表解析、周次、节次、时间和 UID
- XLSX/DOCX 导入
- OCR 网格解析
- 课表修改记录和刷新保留逻辑
- 助手附件、PDF 入口、历史对话和待办确认
- Android SSL 证书范围和公告重复通知
- Windows/Android 壳接口契约

真实 Android 设备、学校教务登录、后台通知、文件选择器和浏览器完整 UI 需要在目标设备上单独测试。

## 目录

```text
core/                 课表模型、解析器和日历逻辑
web/                  网页界面、助手、OCR 和构建模板
bookmarklet/          书签抓取工具
shells/capture.js     教务系统抓取核心
shells/android/       Android 壳
shells/windows/       Windows 壳
vendor/ocr/           离线 OCR 运行资产
vendor/pdfjs/         本机 PDF 转图片运行资产
test/                 自动化测试和脱敏样本
tools/                构建、检查和端到端工具
docs/                 使用说明和复盘文档
examples/             公告源格式示例
data/                 公告管理页使用的数据文件
```

## 隐私

- 网页课表、待办、修改记录和历史对话只保存在本机浏览器存储。
- Windows 账号凭据保存到系统凭据管理器。
- Android 账号凭据保存到加密的 Shared Preferences，密钥由 Android Keystore 管理。
- 诊断日志不记录账号、密码、Cookie、Authorization、课表正文或完整 URL 查询参数。
- 智能助手：唯一的联网功能。只有用户主动发送材料时，内容才会发往设置中的 AI API。
- 助手的「联网补充资料」只抓公网 http/https 地址，本机、内网段（10/8、172.16/12、192.168/16、127/8、169.254/16）、`.local`、`.internal` 一律跳过；抓回的正文会明确标注为外部资料，不当作指令执行。
- 导出备份会通过 `settingsForBackup` 自动剔除 API Key，不会把密钥写入备份文件。
- 助手对话**默认不写进备份**（备份天生是要发给别人或传到网盘的）。导出时勾选「备份里带上助手对话」才会包含，且依然不带 Key；恢复一份不含对话的备份不会清空本机对话。
- 仓库中的课表样本经过脱敏；发布前必须运行 `node tools/check-secrets.mjs`。

## 许可证

项目源码使用 MIT 许可证。`vendor/pdfjs/` 随附其 Apache-2.0 许可证文件；OCR 运行资产按各自上游许可证使用。
