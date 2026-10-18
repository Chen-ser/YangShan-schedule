// 零依赖测试跑法：node test/run.mjs
//
// ★ 为什么不用 `node --test`：本项目的开发沙箱禁止命名管道，
// `node --test test/` 会直接以 `Error: spawn EPERM ... syscall: 'spawn'` 失败。
// 在进程内自跑一个极简断言器反而更省事、更可控，也不依赖 Node 版本。
import { readFileSync, existsSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ★ Windows 坑：动态 import() 只吃 file:// URL，喂 'D:\...' 会报
// ERR_UNSUPPORTED_ESM_URL_SCHEME: Received protocol 'd:'。必须过 pathToFileURL。
const load = (rel) => import(pathToFileURL(join(ROOT, rel)).href);

const S = await load('core/schedule.mjs');
const M = await load('core/model.mjs');

let pass = 0;
const failures = [];

function t(name, fn) {
  try {
    fn();
    pass++;
  } catch (e) {
    failures.push({ name, error: e });
  }
}

function fail(msg) {
  throw new Error(msg);
}

function ok(v, msg = 'expected truthy') {
  if (!v) fail(`${msg} —— 实际拿到 ${JSON.stringify(v)}`);
}

function eq(actual, expected, msg = '') {
  if (!Object.is(actual, expected)) {
    fail(`${msg}\n      期望: ${JSON.stringify(expected)}\n      实际: ${JSON.stringify(actual)}`);
  }
}

function deepEq(actual, expected, msg = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail(`${msg}\n      期望: ${b}\n      实际: ${a}`);
}

function throws(fn, msg = 'expected throw') {
  let threw = false;
  try { fn(); } catch { threw = true; }
  if (!threw) fail(msg);
}

// ================================================================
// 0b. 移动端课表布局护栏
// 七天课表在窄屏上不能把每列压到不可读的窄条；网格应保留最小列宽，
// 由外层容器提供横向滚动。这个检查直接针对最终会被内联进页面的 CSS。

t('移动端课表网格保留最小列宽并允许横向滚动', () => {
  const css = readFileSync(join(ROOT, 'web/styles.css'), 'utf8');
  ok(/\.grid-wrap[\s\S]*?overflow-x:\s*auto/.test(css), '课表容器必须支持横向滚动');
  ok(/\.grid-head[\s\S]*?min-width:\s*calc\(38px \+ var\(--days, 7\) \* 50px\)/.test(css), '表头必须有最小宽度');
  ok(/\.grid-body[\s\S]*?min-width:\s*calc\(38px \+ var\(--days, 7\) \* 50px\)/.test(css), '表体必须有最小宽度');
});

t('周课表背景格显式绑定行列，时间轴不会被课程卡片挤走', () => {
  const src = readFileSync(join(ROOT, 'web/app.js'), 'utf8');
  ok(src.includes("gridColumn: '1'"), '节次时间格必须固定在第 1 列');
  ok(src.includes("gridColumn: String(i + 2)"), '日期背景格必须固定到对应日期列');
  ok(src.includes("gridRow: String(gridRow)"), '背景格必须固定到对应节次行');
});

t('课程触摸交互区分点击、滚动与长按拖拽', () => {
  const app = readFileSync(join(ROOT, 'web/app.js'), 'utf8');
  const css = readFileSync(join(ROOT, 'web/styles.css'), 'utf8');
  ok(app.includes('distance > 8'), '移动距离超过阈值时必须取消点击');
  ok(app.includes('node.setPointerCapture?.(ev.pointerId)'), '只有进入拖拽后才捕获指针');
  ok(app.includes('ev.preventDefault()'), '拖拽过程中必须阻止页面滚动');
  ok(app.includes("node.style.pointerEvents = 'none'"), '拖拽命中测试必须穿透课程块');
  ok(app.includes('lostpointercapture'), '指针捕获丢失时必须清理拖拽状态');
  ok(css.includes('touch-action: none'), '课程块触摸必须交给拖拽状态机');
  ok(app.includes('scheduleDragLock'), '拖拽状态必须有页面滚动锁');
  ok(app.includes("document.addEventListener('touchmove'"), '长按拖拽时必须拦截页面触摸滚动');
  ok(css.includes('overscroll-behavior: none'), '拖拽锁定时必须禁止过度滚动');
});

t('多节课程拖拽保持原跨度并限制末节起点', () => {
  const app = readFileSync(join(ROOT, 'web/app.js'), 'utf8');
  ok(app.includes('const maxStart = Math.max(1, 13 - span.duration + 1)'), '必须限制多节课程的最大起始节次');
  ok(app.includes('const endSection = section + span.duration - 1'), '结束节次必须按原跨度重新计算');
  ok(app.includes('node.style.gridRow = `${beginSection - rowStart + 1} / ${endSection - rowStart + 2}`'), '拖拽预览必须覆盖完整课程跨度');
  ok(app.includes('beginTime: SECTION_TIMES[section - 1]?.start'), '总课表拖拽后必须同步开始时间');
  ok(app.includes('endTime: SECTION_TIMES[endSection - 1]?.end'), '总课表拖拽后必须同步结束时间');
  ok(app.includes('start: SECTION_TIMES[section - 1]?.start'), '周课表拖拽后必须同步开始时间');
  ok(app.includes('end: SECTION_TIMES[endSection - 1]?.end'), '周课表拖拽后必须同步结束时间');
  ok(app.includes('ensureEditableEntryIds'), '课程修改必须使用不随位置变化的本地条目标识');
});

t('设置页切换后会重新渲染课表修改记录', () => {
  const app = readFileSync(join(ROOT, 'web/app.js'), 'utf8');
  const template = readFileSync(join(ROOT, 'web/template.html'), 'utf8');
  ok(app.includes("if (name === 'me') renderScheduleChanges();"), '进入我的页面时必须刷新修改记录');
  ok(template.includes('id="scheduleChanges"'), '设置页必须包含修改记录容器');
  ok(template.includes('id="btnClearScheduleChanges"'), '设置页必须包含删除记录按钮');
});

t('课程编辑会同步节次与具体时间，并记录两类字段', () => {
  const app = readFileSync(join(ROOT, 'web/app.js'), 'utf8');
  ok(app.includes('syncTimesFromSections'), '修改节次后必须同步上下课时间输入框');
  ok(app.includes('sectionForClock'), '修改具体时间后必须同步对应节次');
  ok(app.includes("const typedBeginTime = normTime($('editStart').value)"), '保存时必须直接读取上课时间输入');
  ok(app.includes('sectionForClock(typedBeginTime'), '保存时必须由上课时间重新推导开始节次');
  ok(app.includes('sectionForClock(typedEndTime'), '保存时必须由下课时间重新推导结束节次');
  ok(app.includes('beginTime,') && app.includes('endTime,'), '保存修改必须写入上下课时间');
  ok(app.includes('fields.start ||') && app.includes('fields.end ||'), '修改记录必须展示周课表时间字段');
});

t('课程块按实际时间在节次格内偏移显示', () => {
  const app = readFileSync(join(ROOT, 'web/app.js'), 'utf8');
  ok(app.includes('function courseVisualInsets'), '必须有按分钟计算课程块偏移的函数');
  ok(app.includes('marginTop: `${(1 + top).toFixed(2)}px`'), '开始时间应转换为上边距');
  ok(app.includes('marginBottom: `${(1 + bottom).toFixed(2)}px`'), '结束时间应转换为下边距');
  ok(app.includes('...courseVisualInsets(e)'), '周课表必须使用实际时间定位');
  ok(app.includes('...courseVisualInsets(c)'), '总课表必须使用实际时间定位');
});

t('安卓教务接口使用绝对地址，兼容 *default 路由的 WebView', () => {
  const src = readFileSync(join(ROOT, 'shells/capture.js'), 'utf8');
  ok(src.includes("var API_ORIGIN = 'https://jwxt.bistu.edu.cn';"), '抓取接口必须声明教务域名');
  ok(src.includes("API_ORIGIN + '/jwapp/sys/homeapp/api/home/currentUser.do'"), '当前用户接口必须使用绝对地址');
  ok(src.includes("API_ORIGIN + '/jwapp/sys/kbbpapp/api/schoolCalendar/getTermWeeks.do'"), '周历接口必须使用绝对地址');
  ok(src.includes("API_ORIGIN + '/jwapp/sys/homeapp/api/home/student/getMyScheduleDetail.do'"), '课表接口必须使用绝对地址');
});

t('自动刷新课表必须延续本地修改记录', () => {
  const app = readFileSync(join(ROOT, 'web/app.js'), 'utf8');
  const android = readFileSync(
    join(ROOT, 'shells/android/app/src/main/java/dev/yangshan/schedule/MainActivity.kt'),
    'utf8',
  );
  const windows = readFileSync(join(ROOT, 'shells/windows/MainForm.cs'), 'utf8');
  ok(app.includes('if (opts.preserveChanges)'), '课表导入必须支持静默保留修改记录');
  ok(app.includes('applyPack(normalizeSchedulePack(raw), { preserveChanges: true })'), '页面刷新回包必须保留修改记录');
  ok(android.includes('YangShan.importText') && android.includes('preserveChanges: true'), '安卓后台刷新恢复必须保留修改记录');
  ok(windows.includes('YangShan.importRaw') && windows.includes('preserveChanges: true'), 'Windows 自动刷新注入必须保留修改记录');
});

t('智能助手支持 DeepSeek 配置、通知文件提取与提问', () => {
  const app = readFileSync(join(ROOT, 'web/app.js'), 'utf8');
  const template = readFileSync(join(ROOT, 'web/template.html'), 'utf8');
  const css = readFileSync(join(ROOT, 'web/styles.css'), 'utf8');
  const pdfjs = readFileSync(join(ROOT, 'vendor/pdfjs/pdf.min.mjs'), 'utf8');
  const pdfWorker = readFileSync(join(ROOT, 'vendor/pdfjs/pdf.worker.min.mjs'), 'utf8');
  ok(app.includes("aiModel: 'deepseek-flash'"), '默认模型必须是 deepseek-flash');
  ok(app.includes('function assistantInjectionPrompt'), '必须生成智能助手注入提示词');
  ok(app.includes('function extractAssistantFile'), '必须提供通知文件提取');
  ok(app.includes('readZipTextEntries') && app.includes('slide\\d+'), '必须支持 DOCX/PPTX 文本提取');
  ok(app.includes('function ensurePdfWorker') && app.includes('GlobalWorkerOptions'), 'PDF 必须初始化本地 worker');
  ok(app.includes('ensurePdfWorker(pdfjs)') && app.includes('disableWorker: true'), 'PDF 必须在本机转换为图片');
  ok(app.includes('normalizePdfPageLimit') && app.includes('configuredLimit === 0 ? totalPages'), 'PDF 页数必须支持设置档位和无上限');
  ok(app.includes('image_url') && app.includes('reasoning_effort'), '图片输入与思考强度必须传给接口');
  ok(app.includes('fetchAssistantUrlContext'), '联网增强必须有独立的联网上下文处理');
  ok(template.includes('id="view-assistant"') && template.includes('id="assistantFile"'), '必须有智能助手分区和文件入口');
  ok(template.includes('id="setAiApiKey"') && !template.includes('id="setAiPrompt"'), 'API 设置保留但不得向用户展示注入提示词');
  ok(template.includes('.pdf,application/pdf') && template.includes('<!--{{PDFJSCOMPAT}}-->') && template.includes('<!--{{PDFJS}}-->') && template.includes('<!--{{PDFJSWORKER}}-->'), '助手必须提供 PDF 上传入口和本地渲染引擎');
  ok(template.includes('id="setPdfPageLimit"') && template.includes('value="6"') && template.includes('value="12"') && template.includes('value="24"') && template.includes('value="48"') && template.includes('value="0"'), '设置页必须提供 PDF 页数档位');
  ok(pdfjs.includes('globalThis.pdfjsLib') && pdfjs.length > 300_000, 'PDF.js 本地资产必须完整存在');
  ok(pdfWorker.includes('globalThis.pdfjsWorker') && pdfWorker.length > 500_000, 'PDF.js worker 本地资产必须完整存在');
  const build = readFileSync(join(ROOT, 'web/build.mjs'), 'utf8');
  ok(
    build.includes('Uint8Array.prototype.toHex') &&
      build.includes('getOrInsertComputed') &&
      build.includes('pdfCompatInline') &&
      build.includes('Android WebView compatibility'),
    'PDF 主模块和 worker 必须兼容 Android WebView 缺失的现代内置方法',
  );
  ok(css.includes('.assistant-drop') && css.includes('.assistant-answer'), '智能助手需要有独立布局样式');
});

t('底部导航将“我的”改名为“设置”并保留智能助手入口', () => {
  const template = readFileSync(join(ROOT, 'web/template.html'), 'utf8');
  const css = readFileSync(join(ROOT, 'web/styles.css'), 'utf8');
  ok(template.includes('<button data-view="assistant" class="tab">助手</button>'), '底部导航必须有助手');
  ok(template.includes('<button data-view="me" class="tab">设置</button>'), '原我的入口只改名为设置');
  ok(css.includes('grid-template-columns: repeat(6, 1fr)'), '六个底部导航入口必须均分');
});

t('纯网页版不展示教务系统一键提取和课表刷新入口', () => {
  const app = readFileSync(join(ROOT, 'web/app.js'), 'utf8');
  const template = readFileSync(join(ROOT, 'web/template.html'), 'utf8');
  ok(app.includes('function hasNativeShell'), '必须能区分原生壳与纯网页版');
  ok(app.includes('sync.hidden = !native'), '纯网页版必须隐藏课表刷新入口');
  ok(app.includes('if (hasNativeShell())'), '登录教务系统入口只能由原生壳提供');
  ok(template.includes('选择课表文件、截图，或使用书签小工具导入'), '网页引导不得宣传教务系统一键提取');
});

t('智能助手发送后清空问题并提供附件取消、历史对话和待办确认', () => {
  const app = readFileSync(join(ROOT, 'web/app.js'), 'utf8');
  const template = readFileSync(join(ROOT, 'web/template.html'), 'utf8');
  ok(!app.includes('当前日期：${todayISO()}'), '注入提示词不得注入当前日期');
  ok(app.includes('[YS_TODOS]') && app.includes('parseAssistantTodos'), '助手必须输出并解析待办机器区块');
  ok(app.includes('showAssistantTodoConfirm'), '助手回答后必须让用户确认是否加入待办');
  ok(app.includes("$('assistantQuestion').value = ''"), '发送后必须清空问题输入框');
  ok(app.includes('assistantHistory') && app.includes('archiveAssistantConversation'), '必须保存并归档历史对话');
  ok(app.includes('persistAssistantAttachment') && app.includes('assistantApiMessage'), '历史对话必须保留并恢复附件上下文');
  ok(app.includes('btnAssistantCancelFile') && app.includes('clearAssistantAttachment'), '附件必须可取消');
  ok(!template.includes('id="setAiPrompt"') && !template.includes('id="btnCopyAiPrompt"'), '不得展示或复制注入提示词');
  ok(!template.includes('PDF请先复制文字'), 'PDF 已支持本机转换，不得继续提示用户手动复制文字');
});

t('课程触摸只在长按拖动后锁定页面', () => {
  const css = readFileSync(join(ROOT, 'web/styles.css'), 'utf8');
  ok(css.includes('touch-action: pan-y'), '普通触摸必须允许页面纵向滚动');
  ok(css.includes('.course.dragging') && css.includes('touch-action: none'), '拖动状态必须锁定触摸滚动');
});

t('安卓教务 SSL 处理必须是域名和证书范围受限的', () => {
  const src = readFileSync(join(ROOT, 'shells/android/app/src/main/java/dev/yangshan/schedule/SchoolWeb.kt'), 'utf8');
  ok(src.includes('isExpectedSchoolCertificate'), '必须有受限的学校证书判断');
  ok(src.includes('handler.proceed()') && src.includes('handler.cancel()'), '只允许匹配学校证书时继续，否则取消');
  ok(src.includes('GlobalSign RSA OV SSL CA 2018'), '必须校验预期证书颁发者');
});

t('安卓公告重复门铃不得重复弹通知', () => {
  const src = readFileSync(join(ROOT, 'shells/android/app/src/main/java/dev/yangshan/schedule/AnnPushService.kt'), 'utf8');
  ok(src.includes('AnnouncementStatus.NO_NEW'), '必须区分没有新公告和拉取失败');
  ok(src.includes('AnnouncementStatus.FRESH'), '必须只对新公告发送通知');
});

t('安卓主 WebView 支持文件选择器', () => {
  const src = readFileSync(join(ROOT, 'shells/android/app/src/main/java/dev/yangshan/schedule/MainActivity.kt'), 'utf8');
  ok(src.includes('onShowFileChooser'), '安卓必须处理网页文件选择');
  ok(src.includes('REQ_FILE') && src.includes('onReceiveValue(result)'), '安卓必须把选择结果回传 WebView');
  ok(src.includes('allowContentAccess = true'), '安卓必须允许内容 URI 读取');
});

t('安卓可接收系统分享并自动打开助手', () => {
  const manifest = readFileSync(join(ROOT, 'shells/android/app/src/main/AndroidManifest.xml'), 'utf8');
  const src = readFileSync(join(ROOT, 'shells/android/app/src/main/java/dev/yangshan/schedule/MainActivity.kt'), 'utf8');
  const app = readFileSync(join(ROOT, 'web/app.js'), 'utf8');
  ok(manifest.includes('android.intent.action.SEND'), '必须注册单文件分享入口');
  ok(!manifest.includes('android.intent.action.SEND_MULTIPLE'),
    '内核一次只能导入一个文件，别声明多选（声明了却只取第一份，用户会以为剩下的也进去了）');
  ok(manifest.includes('android:mimeType="application/pdf"'), '分享入口要声明真正能导入的类型，不能用 */*');
  ok(src.includes('readShareIntent') && src.includes('onNewIntent'), '必须处理冷启动和已运行状态的分享');
  ok(src.includes('InternalStoragePathHandler') && src.includes('MAX_SHARED_BYTES'), '分享文件必须走本地临时目录并限制大小');
  ok(src.includes('receiveShare'), '安卓必须把分享内容交给网页助手');
  ok(app.includes('receiveAssistantShare') && app.includes('switchView(\'assistant\')'), '网页必须打开助手并载入分享内容');
  ok(app.includes("$('onboard')?.classList.remove('open')"), '首次打开时分享必须关闭引导遮罩');
});

t('待办长按编辑时锁定页面移动', () => {
  const app = readFileSync(join(ROOT, 'web/app.js'), 'utf8');
  ok(app.includes('function bindTodoLongPress'), '待办必须有长按状态机');
  ok(app.includes('todoEditLock'), '待办长按必须有滚动锁');
  ok(app.includes('modalEditTodo'), '待办长按必须打开编辑界面');
});

t('品牌资源会注入页面模板', () => {
  const template = readFileSync(join(ROOT, 'web/template.html'), 'utf8');
  const build = readFileSync(join(ROOT, 'web/build.mjs'), 'utf8');
  ok(template.includes('仰山课表'), '页面品牌名');
  ok(template.includes('/*{{BRAND_LOGO}}*/'), '主页品牌图占位符');
  ok(template.includes('/*{{ABOUT_IMAGE}}*/'), '关于页图片占位符');
  ok(build.includes("brand-logo.jpg"), '构建脚本读取主页品牌图');
  ok(build.includes("about-contact.jpg"), '构建脚本读取关于页图片');
});

// Service Worker 坏了最难发现：页面上什么都对，只有「已经装过的人」永远看不到新版。
// 缓存名曾经只带版本号（0.1.0），于是 sw.js 一字不变，浏览器比对到字节相同就不装新 SW，
// addAll 不重跑、旧缓存不删 —— 公告功能做得再好也发不到老用户手上。
t('Service Worker 的缓存名带内容指纹，新内容能顶掉旧缓存', () => {
  const build = readFileSync(join(ROOT, 'web/build.mjs'), 'utf8');
  ok(build.includes('const swSrc = (fp) =>'), 'sw.js 的内容必须由指纹参与生成');
  ok(build.includes("createHash('sha256')"), '指纹必须来自内容哈希');
  ok(build.includes("CACHE = 'yangshan-${VERSION}-${fp}'"), '缓存名必须同时带版本与内容指纹');
  ok(!build.includes("CACHE = 'yangshan-${VERSION}'"), '缓存名不能只有版本号，否则内容变了老用户也拿不到');
  ok(
    build.includes('keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))'),
    '换缓存名后必须把旧缓存删掉',
  );
});

// 公告源按设计就是要随时变的。缓存优先一旦命中，管理员改了 JSON 全班还在看旧的，
// 而且「我明明发了」和「同学说没看到」会在两边同时成立，极难排查。
t('Service Worker 不会把公告源缓存成死数据', () => {
  const build = readFileSync(join(ROOT, 'web/build.mjs'), 'utf8');
  const dataBranch = build.indexOf("url.pathname.includes('/data/')");
  const cacheFirst = build.indexOf('caches.match(req).then((hit) => hit ||');
  ok(dataBranch > 0, '公告源必须单独走「先回源」的分支');
  ok(cacheFirst > 0, '其余资源仍然走缓存优先');
  ok(dataBranch < cacheFirst, '/data/ 的分支必须在缓存优先那条 return 之前返回');
});

t('Windows 壳状态与刷新回包不能丢失真实状态', () => {
  const src = readFileSync(join(ROOT, 'shells/windows/MainForm.cs'), 'utf8');
  ok(src.includes('hasSchedule,') || src.includes('hasSchedule ='), 'Windows 状态应探测页面中的真实课表状态');
  ok(src.includes('自动刷新失败，请查看托盘提示后重试。'), '刷新失败必须返回失败回包');
  ok(!/hasSchedule\s*=\s*false\s*,/.test(src), '不得把 hasSchedule 写死为 false');
});

t('安卓壳所有异步回包都带请求 id，并恢复最新课表', () => {
  const src = readFileSync(
    join(ROOT, 'shells/android/app/src/main/java/dev/yangshan/schedule/MainActivity.kt'),
    'utf8',
  );
  ok(src.includes('.put("id", id)'), '安卓状态回包必须带请求 id');
  ok(src.includes('.put("ok", true)'), '安卓状态回包必须带成功标志');
  ok(src.includes('.put("pack", status)'), '安卓状态回包必须把状态放进 pack 字段');
  ok(src.includes('localStorage.getItem'), '安卓恢复应比较网页本地更新时间');
  ok(src.includes('local-newer'), '用户较新的本地导入不能被旧抓取结果覆盖');
  ok(!/if\s*\(YangShan\.hasSchedule\(\)\)\s*return 'has'/.test(src), '安卓启动时不能跳过 Store 中的最新课表');
});

t('网页同步按钮在原生壳中调用真实刷新接口', () => {
  const src = readFileSync(join(ROOT, 'web/app.js'), 'utf8');
  ok(src.includes("typeof shell.refresh === 'function'"), '同步按钮应探测壳的刷新接口');
  ok(src.includes('shell.refresh()'), '同步按钮应调用壳刷新');
  ok(src.includes('刷新失败：'), '同步失败应给出可见提示');
});

// ---------------------------------------------------------------- 后台推送（安卓）
// 这一组盯的是「App 关掉之后还能收到公告」那条链路。它跨了三个文件：
// shells/shim.js（网页→壳的命令名）、ShellBridge.kt（壳收哪条命令）、
// MainActivity.kt + AnnPushService.kt（真正去起前台服务）。
// 任何一处改了名字，推送就**静默失效** —— 属于「平时完全看不出来、
// 真发公告时才发现全班收不到」的那类故障，所以值得钉住。

t('后台推送的命令名在网页端与安卓壳之间必须一致', () => {
  const shim = readFileSync(join(ROOT, 'shells/shim.js'), 'utf8');
  const bridge = readFileSync(
    join(ROOT, 'shells/android/app/src/main/java/dev/yangshan/schedule/ShellBridge.kt'),
    'utf8',
  );
  ok(shim.includes("cmd: 'annpush'"), "shim 必须下发 cmd: 'annpush'");
  ok(shim.includes('setAnnPush'), 'shim 必须把 setAnnPush 暴露给内核');
  ok(bridge.includes('"annpush" ->'), 'ShellBridge 必须处理 annpush');
  ok(bridge.includes('onAnnPush'), 'ShellBridge 必须把它交给宿主');
});

t('公告源支持内置默认源与多个可删除自定义源', () => {
  const app = readFileSync(join(ROOT, 'web/app.js'), 'utf8');
  const template = readFileSync(join(ROOT, 'web/template.html'), 'utf8');
  const shim = readFileSync(join(ROOT, 'shells/shim.js'), 'utf8');
  ok(app.includes('DEFAULT_ANNOUNCEMENT_SOURCE'), '网页端必须内置默认公告源');
  ok(app.includes('annSources'), '设置必须保存多个自定义公告源');
  ok(app.includes('allAnnouncementSources'), '刷新与推送必须合并内置源和自定义源');
  ok(app.includes('Promise.allSettled'), '多个公告源应互不阻塞地并行拉取');
  ok(app.includes('renderAnnSources'), '设置页必须渲染自定义公告源列表');
  ok(template.includes('id="annSources"'), '设置页必须有自定义公告源容器');
  ok(shim.includes('Array.isArray(sources)'), '壳桥接必须传递公告源数组');
});

t('安卓壳必须声明公告推送的前台服务与开机恢复', () => {
  const mf = readFileSync(
    join(ROOT, 'shells/android/app/src/main/AndroidManifest.xml'),
    'utf8',
  );
  ok(mf.includes('android.permission.FOREGROUND_SERVICE'), '必须申请前台服务权限');
  ok(mf.includes('FOREGROUND_SERVICE_DATA_SYNC'), 'Android 14 起前台服务要按类型再申请一次');
  ok(
    mf.includes('android:foregroundServiceType="dataSync"'),
    '服务本体必须声明 dataSync 类型（不声明在 Android 14 上会直接崩）',
  );
  ok(mf.includes('.AnnPushService'), '必须注册推送服务');
  ok(mf.includes('.BootReceiver'), '必须注册开机恢复接收器');
  ok(mf.includes('android.intent.action.BOOT_COMPLETED'), '重启后要能把服务拉回来');
  ok(mf.includes('android.permission.RECEIVE_BOOT_COMPLETED'), '接收 BOOT_COMPLETED 需要权限');
});

t('后台推送由网页端配置驱动，且状态如实回读', () => {
  const app = readFileSync(join(ROOT, 'web/app.js'), 'utf8');
  ok(app.includes('shell.setAnnPush('), '网页端必须把频道下发给壳');
  ok(app.includes('pushAnnToShell()'), '保存公告源与启动时都要下发');
  ok(app.includes('refreshShellAnnPush'), '必须回读服务是否真的起来了');
  ok(app.includes('后台推送已开启'), '界面要如实显示后台推送状态');
});

t('安卓 WebView 通知优先走原生壳，不能误报浏览器不支持', () => {
  const app = readFileSync(join(ROOT, 'web/app.js'), 'utf8');
  const shim = readFileSync(join(ROOT, 'shells/shim.js'), 'utf8');
  const bridge = readFileSync(
    join(ROOT, 'shells/android/app/src/main/java/dev/yangshan/schedule/ShellBridge.kt'),
    'utf8',
  );
  ok(app.includes('function sendSystemNotification'), '网页端应统一走通知发送助手');
  ok(app.includes('shell.notify(title, body)'), '安卓壳应接管系统通知');
  ok(app.includes('shell.requestNotifications'), '设置和测试按钮应请求原生通知权限');
  ok(shim.includes('requestNotifications'), 'shim 必须暴露原生权限请求');
  ok(bridge.includes('"requestNotifications" ->'), '安卓桥必须处理权限请求');
});

t('Windows 托盘通知权限请求必须回包，不能让共享设置开关挂起', () => {
  const main = readFileSync(join(ROOT, 'shells/windows/MainForm.cs'), 'utf8');
  ok(main.includes('case "requestNotifications"'), 'Windows 壳必须处理共享通知权限命令');
  ok(main.includes('Reply(id, true, "{\\"granted\\":true}", null)'), 'Windows 托盘通知无需权限，应明确回成功');
});

t('安卓后台推送只在通知权限真实可用时报告 active', () => {
  const main = readFileSync(
    join(ROOT, 'shells/android/app/src/main/java/dev/yangshan/schedule/MainActivity.kt'),
    'utf8',
  );
  const notify = readFileSync(
    join(ROOT, 'shells/android/app/src/main/java/dev/yangshan/schedule/Notify.kt'),
    'utf8',
  );
  const service = readFileSync(
    join(ROOT, 'shells/android/app/src/main/java/dev/yangshan/schedule/AnnPushService.kt'),
    'utf8',
  );
  ok(main.includes('notificationsGranted'), '状态应报告通知权限');
  ok(main.includes('onRequestPermissionsResult'), '拒绝权限后必须回包');
  ok(notify.includes('areNotificationsEnabled'), '必须检查系统通知总开关');
  ok(service.includes('active = startInForeground'), '前台服务必须以真实启动结果设置 active');
  // 原来这里是「权限关闭就直接 return false」，等于一次都不调 startForeground。
  // 服务是被 startForegroundService 拉起来的，那样做在 Android 12+ 会抛
  // ForegroundServiceDidNotStartInTimeException。现在改成：先调、再撤、再返回 false。
  const start = service.slice(service.indexOf('private fun startInForeground'), service.indexOf('@Synchronized'));
  ok(start.includes('startForeground('), '通知被关掉时也要真的调一次 startForeground');
  ok(start.includes('stopForeground(STOP_FOREGROUND_REMOVE)'), '调完立刻撤掉前台身份');
  ok(/if \(allowed\) \{\s*true\s*\} else \{/.test(start), '通知不可用时仍然要返回 false，不能假报服务已运行');
});

t('课前和待办截止提醒必须支持安卓原生通知', () => {
  const app = readFileSync(join(ROOT, 'web/app.js'), 'utf8');
  const main = readFileSync(
    join(ROOT, 'shells/android/app/src/main/java/dev/yangshan/schedule/MainActivity.kt'),
    'utf8',
  );
  ok(app.includes('nativeNotifications'), '提醒逻辑必须探测原生通知能力');
  ok(app.includes('shell.notify(title, body)'), '提醒必须能走原生壳通知');
  ok(app.includes('const alarm = Number(state.settings.alarm)'), '必须检查上课提前提醒设置');
  ok(app.includes('const lead = Number(state.settings.todoAlarm'), '必须检查待办截止提醒设置');
  ok(main.includes('override fun onNotify'), '安卓壳必须接收网页提醒');
  ok(main.includes('Notify.show(this'), '安卓壳必须把网页提醒发到系统通知栏');
});

t('推送载荷一律不可信：通知正文只能来自公告 JSON', () => {
  const svc = readFileSync(
    join(ROOT, 'shells/android/app/src/main/java/dev/yangshan/schedule/AnnPushService.kt'),
    'utf8',
  );
  ok(svc.includes('START_STICKY'), '被系统杀掉后必须能自动拉回来');
  ok(svc.includes('"message"'), '只认 ntfy 的 message 事件');
  ok(
    svc.includes('optString("event") == "message"'),
    '必须判 JSON 里的 event 字段 —— 建立连接时那声 open 不能被当成公告',
  );
  ok(
    svc.includes('AnnPush.annUrl('),
    '通知正文必须来自公告 JSON，绝不能直接用推送载荷里的文字',
  );
  ok(svc.includes('lastId'), '同一条公告只弹一次，重连不能重复打扰');
  ok(svc.includes('appVisible'), 'App 在前台时让位给网页端，避免弹两条');
});

// ---------------------------------------------------------------- 教务登录与抓取（安卓）
// 真机上这条路失败时是**静默**的：状态栏停在一句看不出所以然的话，用户只能报「导入失败」。
// 下面三条都是已经在真机/探针上踩实了的坑，钉住它们免得下次改别的东西时又踩回去。

t('安卓教务窗口必须报桌面版 UA：手机 UA 那一支根本没有课表页', () => {
  const src = readFileSync(
    join(ROOT, 'shells/android/app/src/main/java/dev/yangshan/schedule/SchoolWeb.kt'),
    'utf8',
  );
  ok(
    /DESKTOP_UA\s*=\s*"Mozilla\/5\.0 \(Windows NT/.test(src),
    '必须自带一份桌面版 UA 字面量',
  );
  ok(
    /userAgentString\s*=\s*DESKTOP_UA/.test(src),
    '必须整体替换 UA —— 在安卓 UA 后面拼后缀仍然落进手机分支',
  );
  ok(
    !/userAgentString\s*\+\s*"/.test(src),
    '不得再用 web.settings.userAgentString 拼接（那正是要躲开的写法）',
  );
  ok(src.includes('useWideViewPort'), '桌面版页面是定宽的，必须允许缩放');
  ok(src.includes('loadWithOverviewMode'), '必须整体缩到屏幕宽，否则手机上只看得到左上角一块');
});

t('登录表单在 iframe 里晚几百毫秒才建好，填表必须轮询而不是只试一次', () => {
  const src = readFileSync(
    join(ROOT, 'shells/android/app/src/main/java/dev/yangshan/schedule/SchoolWeb.kt'),
    'utf8',
  );
  ok(src.includes('FILL_POLL_MS') && src.includes('FILL_MAX_TRIES'), '必须给轮询定义间隔与次数上限');
  ok(/fillTries\s*<\s*FILL_MAX_TRIES/.test(src), '没找到表单时要继续轮询');
  ok(src.includes("'noform'"), '要认得出「表单还没建好」这一种返回');
  ok(src.includes('fillDone'), '真的填过并提交之后就不能再抢用户的输入框');
  ok(src.includes('sso.bistu.edu.cn'), '迟到的重试必须先确认人还在登录页');
});

t('安卓教务登录必须允许跨子域 Cookie，并在页签切换后再找动态表单', () => {
  const src = readFileSync(
    join(ROOT, 'shells/android/app/src/main/java/dev/yangshan/schedule/SchoolWeb.kt'),
    'utf8',
  );
  ok(src.includes('setAcceptThirdPartyCookies'), 'WebView 必须允许教务登录跨子域 Cookie');
  ok(src.includes('CookieManager.getInstance().flush'), '抓取前必须刷新登录 Cookie');
  const tab = src.indexOf('var tabs = findAll');
  const fields = src.indexOf('var U = find(', tab);
  ok(tab >= 0 && fields > tab, '必须先切到账号密码页签，再查动态生成的输入框');
  ok(src.includes('input#username') && src.includes('autocomplete="current-password"'), '输入框选择器要兼容新版登录页');
});

t('登录页的页签是可记忆的（可能是扫码/短信页），填表前必须先切到账号密码', () => {
  const src = readFileSync(
    join(ROOT, 'shells/android/app/src/main/java/dev/yangshan/schedule/SchoolWeb.kt'),
    'utf8',
  );
  ok(src.includes('content-tabs-title'), '按页签容器的文字找，不能写死「第几个」');
  ok(src.includes('账号密码'), '要认得中文页签名');
  ok(
    src.includes('刷新') || src.includes('Refresh'),
    '按钮不能按 DOM 顺序取第一个 —— 同一个 .btn-submit 也会命中「刷新二维码」',
  );
  ok(src.includes('offsetParent'), '挑按钮时要先看是否可见');
});

t('验证码按「在不在」判，不能按「看不看得见」判', () => {
  // 这两条各踩过一次坑：
  //   1. 验证码标记是 v-if="showCaptcha" 控制的，不需要时根本不在 DOM 里；
  //   2. 真正需要时它所在的「账号密码」面板可能正被 v-show 藏着
  //      （页签选中的是哪一个存在 localStorage 里，可能是扫码/短信页），
  //      用 offsetParent 判会永远判不到 → 盲提交 → 用户只看到一句「登录失败」。
  const capLines = (file) =>
    readFileSync(join(ROOT, file), 'utf8')
      .split('\n')
      .filter((l) => l.includes('captcha-box'));
  for (const [shell, file] of [
    ['安卓', 'shells/android/app/src/main/java/dev/yangshan/schedule/SchoolWeb.kt'],
    ['Windows', 'shells/windows/SchoolForm.cs'],
  ]) {
    const lines = capLines(file);
    ok(lines.length > 0, `${shell}壳里要能找到验证码探测`);
    for (const l of lines) {
      ok(
        !l.includes('offsetParent') && !l.includes('visible('),
        `${shell}壳的验证码不能判可见性（页签默认藏着会让它永远判不到）：${l.trim()}`,
      );
    }
  }
});

t('两个壳的自动填表必须一视同仁（这场 bug 就是两边跑偏造成的）', () => {
  const shells = {
    安卓: readFileSync(
      join(ROOT, 'shells/android/app/src/main/java/dev/yangshan/schedule/SchoolWeb.kt'),
      'utf8',
    ),
    Windows: readFileSync(join(ROOT, 'shells/windows/SchoolForm.cs'), 'utf8'),
  };
  for (const [shell, src] of Object.entries(shells)) {
    ok(src.includes('content-tabs-title'), `${shell}壳：登录页默认停在扫码页，要切到账号密码`);
    ok(/刷新|Refresh/.test(src), `${shell}壳：挑提交按钮时要排掉「刷新二维码」`);
    ok(src.includes('KeyboardEvent'), `${shell}壳：挑不到合适的按钮时要能用回车兜底`);
    ok(
      /return ['"]nofields['"]|return 'noform'|'noform'/.test(src),
      `${shell}壳：要认得出「表单还没建好」这一种返回`,
    );
  }
});

t('抓取失败要能就地重试，而且失败原因必须带上当时停在哪个页面', () => {
  const src = readFileSync(
    join(ROOT, 'shells/android/app/src/main/java/dev/yangshan/schedule/SchoolWeb.kt'),
    'utf8',
  );
  ok(src.includes('CAPTURE_RETRY_MS'), '抓取重试要有间隔');
  ok(src.includes('CAPTURE_MAX_TRIES'), '抓取重试必须封顶，不能无限重来');
  ok(src.includes('__YS_NO_CAPTURE__'), '脚本没落地要认得出来（它是重试得掉的那种）');
  ok(/retryable\(err\)/.test(src), '失败要先判能不能重试再决定报错');
  ok(src.includes('private fun where()'), '失败原因必须带上当时的页面地址');
  ok(src.includes('lastUrl'), '要记住最近一次 onPageFinished 的地址');
});

// ================================================================ 0. 浏览器安全
// 这是把核心从"只能在 Node 跑"改造成"四端共用"之后必须守住的一条线：
// 核心文件里一旦出现 node:crypto / Buffer / process，打包进网页后浏览器直接崩。
//
// ⚠️ 必须先把注释剥掉再扫 —— 文件头注释里就写着"历史上用过 Buffer.byteLength"，
// 不剥注释的话这条护栏会被自己的说明文字误伤（第一版就是这么红的）。

function stripComments(src) {
  return src
    // 先统一行尾。Windows 上签出的是 CRLF，而 `.` 不匹配 \r，
    // `/\/\/.*$/` 碰到 "…\r" 就整条匹配不上 —— 注释里的 Buffer 会被当成真代码。
    // 这不是理论问题：同一份仓库在 Linux（CI）上全绿、在 CRLF 签出上必挂。
    .replace(/\r\n?/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

const BANNED = [
  [/from\s+['"]node:/, 'import ... from "node:..."'],
  [/\brequire\s*\(/, 'require()'],
  [/\bBuffer\b/, 'Buffer'],
  [/\bprocess\s*\./, 'process.*'],
  [/\b__dirname\b/, '__dirname'],
];

function assertBrowserSafe(rel) {
  const src = stripComments(readFileSync(join(ROOT, rel), 'utf8'));
  for (const [re, label] of BANNED) {
    const m = src.match(re);
    if (m) fail(`${rel} 里出现了 ${label}（第 ${src.slice(0, m.index).split('\n').length} 行）—— 浏览器里会崩`);
  }
}

t('core/schedule.mjs 不得引入任何 Node 专有 API', () => assertBrowserSafe('core/schedule.mjs'));t('core/model.mjs 不得引入任何 Node 专有 API', () => assertBrowserSafe('core/model.mjs'));
t('core/officefile.mjs 不得引入任何 Node 专有 API', () => assertBrowserSafe('core/officefile.mjs'));

t('剥注释前要统一行尾，否则 CRLF 签出上会误报', () => {
  // 实测过一次：同一份仓库在 Linux（CI）全绿，在 Windows 的 CRLF 签出上必挂 ——
  // 因为 `.` 不匹配 \r，`/\/\/.*$/` 碰到 "…\r" 整条不匹配，注释里的 Buffer 被当真代码。
  const stripped = stripComments('// 注释里提到 Buffer 和 process.cwd\r\nconst a = 1;\r\n');
  ok(!stripped.includes('Buffer'), 'CRLF 的注释行必须照样剥掉');
  ok(stripped.includes('const a = 1;'), '真代码要留住');
});

// ================================================================ 1. UTF-8 / 哈希

t('charBytes 各区间字节数正确', () => {
  eq(S.charBytes('a'.codePointAt(0)), 1);
  eq(S.charBytes('中'.codePointAt(0)), 3);
  eq(S.charBytes('é'.codePointAt(0)), 2);
  eq(S.charBytes('😀'.codePointAt(0)), 4);
});

t('utf8Length 与 Buffer.byteLength 等价', () => {
  for (const s of ['', 'abc', '中文', 'a中b', '😀', '课程A：高数（上）']) {
    eq(S.utf8Length(s), Buffer.byteLength(s, 'utf8'), `字符串 ${JSON.stringify(s)}`);
  }
});

t('fnv1a64 定长、稳定、对中文敏感', () => {
  eq(S.fnv1a64('').length, 16);
  eq(S.fnv1a64('高等数学'), S.fnv1a64('高等数学'));
  ok(S.fnv1a64('高等数学') !== S.fnv1a64('高等数学A'), '不同字符串必须不同哈希');
  ok(/^[0-9a-f]{16}$/.test(S.fnv1a64('随便什么')), '必须是 16 位小写十六进制');
});

t('uidFor 格式固定且与哈希一致', () => {
  const u = S.uidFor(['a', 'b']);
  ok(u.startsWith('bistu-'), 'UID 前缀');
  ok(u.endsWith('@bistu.schedule'), 'UID 后缀');
  eq(u, `bistu-${S.fnv1a64('a|b')}@bistu.schedule`);
});

// ================================================================ 2. 周次位图

t('parseWeekBitmap 连续周', () => {
  deepEq(S.parseWeekBitmap('1111111111111111000000'), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
});

t('parseWeekBitmap 单周', () => {
  deepEq(S.parseWeekBitmap('1010101000000000000000'), [1, 3, 5, 7]);
});

t('parseWeekBitmap 双周', () => {
  deepEq(S.parseWeekBitmap('0101010000000000000000'), [2, 4, 6]);
});

t('parseWeekBitmap 间断', () => {
  deepEq(S.parseWeekBitmap('1100011000000000000000'), [1, 2, 6, 7]);
});

t('parseWeekBitmap 空/非串输入返回空数组', () => {
  deepEq(S.parseWeekBitmap(''), []);
  deepEq(S.parseWeekBitmap(null), []);
  deepEq(S.parseWeekBitmap(undefined), []);
  deepEq(S.parseWeekBitmap(123), []);
});

t('parseWeekBitmap 全零', () => {
  deepEq(S.parseWeekBitmap('0000000000000000000000'), []);
});

// ================================================================ 3. 人读串兜底

t('parseWeeksFromText 连续区间', () => {
  deepEq(S.parseWeeksFromText('1-16周[讲授]/张三'), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
});

t('parseWeeksFromText 单周标记', () => {
  deepEq(S.parseWeeksFromText('1-8周(单)'), [1, 3, 5, 7]);
});

t('parseWeeksFromText 双周标记', () => {
  deepEq(S.parseWeeksFromText('1-8周(双)'), [2, 4, 6, 8]);
});

t('parseWeeksFromText 多段区间', () => {
  deepEq(S.parseWeeksFromText('1-4,9-12周'), [1, 2, 3, 4, 9, 10, 11, 12]);
});

t('parseWeeksFromText 顿号分隔', () => {
  deepEq(S.parseWeeksFromText('1、5、9周'), [1, 5, 9]);
});

t('parseWeeksFromText 中文括号单周', () => {
  deepEq(S.parseWeeksFromText('1-6周（单）'), [1, 3, 5]);
});

t('parseWeeksFromText 第N周', () => {
  deepEq(S.parseWeeksFromText('第3周'), [3]);
});

t('parseWeeksFromText 无周次信息返回空', () => {
  deepEq(S.parseWeeksFromText(''), []);
  deepEq(S.parseWeeksFromText('未安排'), []);
  deepEq(S.parseWeeksFromText(null), []);
});

t('parseWeeksFromText 区间倒序也能吃', () => {
  deepEq(S.parseWeeksFromText('8-6周'), [6, 7, 8]);
});

t('splitWeeksTeachers 拆分周次与教师', () => {
  deepEq(S.splitWeeksTeachers('1-16周[讲授]/张三'), { weeksText: '1-16周[讲授]', teacher: '张三', teachers: ['张三'] });
  deepEq(S.splitWeeksTeachers('1-16周'), { weeksText: '1-16周', teacher: '', teachers: [] });
  deepEq(S.splitWeeksTeachers(''), { weeksText: '', teacher: '', teachers: [] });
});

t('★ splitWeeksTeachers 处理多教师写法（真实数据里的形状）', () => {
  // 早先只按第一个 '/' 切，第二段的周次串会混进教师名
  const r = S.splitWeeksTeachers('1-7周[讲授]/陈曦[主讲]; 1-7周[讲授]/古一[主讲]');
  eq(r.teacher, '陈曦 · 古一');
  deepEq(r.teachers, ['陈曦', '古一']);
  eq(r.weeksText, '1-7周[讲授]; 1-7周[讲授]');
  ok(!/\d/.test(r.teacher), `教师名里不该混进周次：${r.teacher}`);
  // 重名只留一份
  deepEq(S.splitWeeksTeachers('1-2周[讲授]/张三; 3-4周[讲授]/张三').teachers, ['张三']);
});

// ================================================================ 4. 学期周历

const TERM_WEEKS_RAW = {
  code: 200,
  datas: {
    getTermWeeks: [
      { serialNumber: 3, startDate: '2025-09-15', endDate: '2025-09-21' },
      { serialNumber: 1, startDate: '2025-09-01', endDate: '2025-09-07' },
      { serialNumber: 2, startDate: '2025-09-08', endDate: '2025-09-14' },
    ],
  },
};

t('normalizeTermWeeks 取出并按周序排序', () => {
  deepEq(S.normalizeTermWeeks(TERM_WEEKS_RAW), [
    { serialNumber: 1, startDate: '2025-09-01', endDate: '2025-09-07' },
    { serialNumber: 2, startDate: '2025-09-08', endDate: '2025-09-14' },
    { serialNumber: 3, startDate: '2025-09-15', endDate: '2025-09-21' },
  ]);
});

t('normalizeTermWeeks 裸数组也吃', () => {
  deepEq(S.normalizeTermWeeks([{ serialNumber: 1, startDate: '2025-09-01' }]), [
    { serialNumber: 1, startDate: '2025-09-01', endDate: undefined },
  ]);
});

t('normalizeTermWeeks 坏输入返回空数组', () => {
  deepEq(S.normalizeTermWeeks(null), []);
  deepEq(S.normalizeTermWeeks({}), []);
  deepEq(S.normalizeTermWeeks({ datas: {} }), []);
  deepEq(S.normalizeTermWeeks('x'), []);
});

t('normalizeTermWeeks 丢掉缺 startDate 的条目', () => {
  deepEq(S.normalizeTermWeeks([{ serialNumber: 1 }, { serialNumber: 2, startDate: '2025-09-08' }]), [
    { serialNumber: 2, startDate: '2025-09-08', endDate: undefined },
  ]);
});

t('parseTermCode 三种学期', () => {
  eq(S.parseTermCode('2025-2026-1').label, '2025-2026学年 上学期');
  eq(S.parseTermCode('2025-2026-2').label, '2025-2026学年 下学期');
  eq(S.parseTermCode('2025-2026-3').label, '2025-2026学年 小学期');
  eq(S.parseTermCode('2025-2026-1').term, 1);
  eq(S.parseTermCode('2025-2026-1').year, '2025-2026');
});

t('parseTermCode 坏输入不崩', () => {
  eq(S.parseTermCode('').label, '');
  eq(S.parseTermCode(null).term, 0);
  eq(S.parseTermCode('乱码').label, '乱码');
});

// ================================================================ 5. 日期

t('SECTION_TIMES 首尾正确', () => {
  eq(S.SECTION_TIMES.length, 13);
  eq(S.SECTION_TIMES[0].start, '08:30');
  eq(S.SECTION_TIMES[12].end, '22:15');
});

t('addDays 能吃带时分秒的日期串（真实接口就是这个形状）', () => {
  eq(S.addDays('2026-09-07 00:00:00', 0), '2026-09-07');
  eq(S.addDays('2026-09-07 00:00:00', 14), '2026-09-21');
  eq(S.weekdayOf('2026-09-07 00:00:00'), 1);
  eq(S.daysBetween('2026-09-07 00:00:00', '2026-09-21 23:59:59'), 14);
});

t('addDays 跨月跨年', () => {
  eq(S.addDays('2025-09-01', 0), '2025-09-01');
  eq(S.addDays('2025-09-01', 6), '2025-09-07');
  eq(S.addDays('2025-09-30', 1), '2025-10-01');
  eq(S.addDays('2025-12-31', 1), '2026-01-01');
  eq(S.addDays('2025-03-01', -1), '2025-02-28');
});

t('normTime 各种写法归一', () => {
  eq(S.normTime('0800'), '08:00');
  eq(S.normTime('8:00'), '08:00');
  eq(S.normTime('08:00'), '08:00');
  eq(S.normTime(' 13:30 '), '13:30');
  eq(S.normTime(''), null);
  eq(S.normTime(null), null);
  eq(S.normTime('不是时间'), null);
});

t('weekdayOf 算对星期（周一=1..周日=7）', () => {
  eq(S.weekdayOf('2025-09-01'), 1); // 周一
  eq(S.weekdayOf('2025-09-06'), 6); // 周六
  eq(S.weekdayOf('2025-09-07'), 7); // 周日
});

t('daysBetween 正负与跨月', () => {
  eq(S.daysBetween('2025-09-01', '2025-09-01'), 0);
  eq(S.daysBetween('2025-09-01', '2025-09-08'), 7);
  eq(S.daysBetween('2025-09-08', '2025-09-01'), -7);
  eq(S.daysBetween('2025-09-30', '2025-10-02'), 2);
});

t('todayISO / nowHM 格式正确', () => {
  ok(/^\d{4}-\d{2}-\d{2}$/.test(S.todayISO()), '日期格式');
  ok(/^\d{2}:\d{2}$/.test(S.nowHM()), '时间格式');
  eq(S.todayISO(new Date(2026, 0, 5, 9, 8)), '2026-01-05');
  eq(S.nowHM(new Date(2026, 0, 5, 9, 8)), '09:08');
});

// ================================================================ 6. 展开

const WEEKS = [
  { serialNumber: 1, startDate: '2025-09-01', endDate: '2025-09-07' },
  { serialNumber: 2, startDate: '2025-09-08', endDate: '2025-09-14' },
  { serialNumber: 3, startDate: '2025-09-15', endDate: '2025-09-21' },
];

const COURSE = {
  courseName: '高等数学',
  dayOfWeek: 3,
  beginSection: 1,
  endSection: 2,
  week: '1110000000000000000000',
  weeksAndTeachers: '1-3周[讲授]/李四',
  placeName: '教一楼101',
  teachingTarget: '高数A班',
};

t('expandCourses 展开到具体日期', () => {
  const ev = S.expandCourses([COURSE], WEEKS, { termCode: '2025-2026-1' });
  eq(ev.length, 3);
  deepEq(ev.map((e) => e.date), ['2025-09-03', '2025-09-10', '2025-09-17']);
  eq(ev[0].week, 1);
  eq(ev[2].week, 3);
});

t('expandCourses 起止时间按节次表回落', () => {
  const ev = S.expandCourses([COURSE], WEEKS);
  eq(ev[0].start, '08:30');
  eq(ev[0].end, '10:05'); // 第 2 节结束，而不是第 1 节的 09:15
});

t('expandCourses 课程自带时间优先于节次表', () => {
  const ev = S.expandCourses([{ ...COURSE, beginTime: '0800', endTime: '09:30' }], WEEKS);
  eq(ev[0].start, '08:00');
  eq(ev[0].end, '09:30');
});

t('expandCourses 位图缺失时回落人读串', () => {
  const ev = S.expandCourses([{ ...COURSE, week: '' }], WEEKS);
  eq(ev.length, 3);
});

t('expandCourses 周历里没有该周则跳过而不是猜', () => {
  const ev = S.expandCourses([{ ...COURSE, week: '1111000000000000000000' }], WEEKS);
  eq(ev.length, 3, '第 4 周不在周历里，必须被丢弃');
});

t('expandCourses 无周次信息则不产出事件', () => {
  deepEq(S.expandCourses([{ ...COURSE, week: '', weeksAndTeachers: '' }], WEEKS), []);
});

t('expandCourses 空输入返回空', () => {
  deepEq(S.expandCourses([], WEEKS), []);
  deepEq(S.expandCourses([COURSE], []), []);
  deepEq(S.expandCourses(null, WEEKS), []);
  deepEq(S.expandCourses([COURSE], null), []);
});

t('expandCourses 地点缺失时只认 data-kblx=01 锚点', () => {
  const html = '<i>3-16周</i> <a data-kblx="02" data-code="123">某老师</a> <a data-kblx="01" data-code="456">ZXB-306</a>';
  const ev = S.expandCourses([{ ...COURSE, placeName: '', titleDetail: [html] }], WEEKS);
  eq(ev[0].location, 'ZXB-306');
});

t('★ expandCourses 没有地点锚点时宁可留空，也不能把老师名字当教室', () => {
  const html = '<i>1-16周</i> <a data-kblx="02" data-code="123">某老师</a>';
  const ev = S.expandCourses([{ ...COURSE, placeName: '', titleDetail: [html] }], WEEKS);
  eq(ev[0].location, '');
});

t('expandCourses 按日期时间升序', () => {
  const ev = S.expandCourses([COURSE], WEEKS);
  for (let i = 1; i < ev.length; i++) {
    ok((ev[i - 1].date + ev[i - 1].start) <= (ev[i].date + ev[i].start), '顺序必须递增');
  }
});

t('★ UID 稳定性：两次展开完全一致', () => {
  const a = S.expandCourses([COURSE], WEEKS, { termCode: '2025-2026-1' });
  const b = S.expandCourses([COURSE], WEEKS, { termCode: '2025-2026-1' });
  deepEq(a.map((e) => e.uid), b.map((e) => e.uid));
});

t('★ UID 稳定性：改地点不改变 UID', () => {
  const a = S.expandCourses([COURSE], WEEKS, { termCode: '2025-2026-1' });
  const b = S.expandCourses([{ ...COURSE, placeName: '教三楼999' }], WEEKS, { termCode: '2025-2026-1' });
  deepEq(a.map((e) => e.uid), b.map((e) => e.uid), '换教室后重新导入必须原地更新而非新增');
});

t('★ UID 稳定性：换教师不改变 UID', () => {
  const a = S.expandCourses([COURSE], WEEKS, { termCode: '2025-2026-1' });
  const b = S.expandCourses([{ ...COURSE, weeksAndTeachers: '1-3周[讲授]/王五' }], WEEKS, { termCode: '2025-2026-1' });
  deepEq(a.map((e) => e.uid), b.map((e) => e.uid));
});

t('★ UID 稳定性：不同学期必须不同 UID', () => {
  const a = S.expandCourses([COURSE], WEEKS, { termCode: '2025-2026-1' });
  const b = S.expandCourses([COURSE], WEEKS, { termCode: '2026-2027-1' });
  ok(a[0].uid !== b[0].uid, '跨学期不能撞 UID，否则新学期课会覆盖旧学期');
});

t('expandCourses 同一条重复出现只产出一个事件', () => {
  const ev = S.expandCourses([COURSE, { ...COURSE }], WEEKS);
  eq(ev.length, 3);
});

t('expandCourses 缺字段的脏数据不崩', () => {
  const ev = S.expandCourses([{ courseName: '无字段课' }], WEEKS);
  ok(Array.isArray(ev));
});

// ================================================================ 7. iCal 转义与折行

t('escapeIcalText 转义四种特殊字符', () => {
  eq(S.escapeIcalText('a,b'), 'a\\,b');
  eq(S.escapeIcalText('a;b'), 'a\\;b');
  eq(S.escapeIcalText('a\\b'), 'a\\\\b');
  eq(S.escapeIcalText('a\nb'), 'a\\nb');
  eq(S.escapeIcalText('a\r\nb'), 'a\\nb');
  eq(S.escapeIcalText(null), '');
  eq(S.escapeIcalText('正常文本'), '正常文本');
});

t('foldLine 短行不动', () => {
  eq(S.foldLine('SUMMARY:abc'), 'SUMMARY:abc');
});

t('foldLine 长行每段 UTF-8 字节数 ≤75', () => {
  const line = 'DESCRIPTION:' + '这是一段很长的中文描述用来测试折行是否会按字节切开'.repeat(4);
  const folded = S.foldLine(line);
  for (const part of folded.split('\r\n')) {
    ok(Buffer.byteLength(part, 'utf8') <= 75, `折行后某段超过 75 字节: ${Buffer.byteLength(part, 'utf8')}`);
  }
  // 折回来必须与原文一致
  eq(folded.split('\r\n ').join('\r\n').split('\r\n').join(''), line);
});

t('foldLine 续行以单个空格开头', () => {
  const folded = S.foldLine('X:' + 'a'.repeat(200));
  const parts = folded.split('\r\n');
  ok(parts.length > 1, '应该被折成多行');
  for (let i = 1; i < parts.length; i++) ok(parts[i].startsWith(' '), '续行必须以空格开头');
});

t('foldLine 不在多字节字符中间切断', () => {
  const folded = S.foldLine('SUMMARY:' + '中文'.repeat(50));
  for (const part of folded.split('\r\n')) {
    ok(!/[\uFFFD]/.test(part), '不得出现替换字符');
  }
});

// ================================================================ 8. iCal 生成

const EVENTS = S.expandCourses([COURSE], WEEKS, { termCode: '2025-2026-1' });

t('buildIcal 结构完整', () => {
  const ics = S.buildIcal(EVENTS, { calName: '我的课表' });
  ok(ics.startsWith('BEGIN:VCALENDAR\r\n'), '开头');
  ok(ics.endsWith('END:VCALENDAR\r\n'), '结尾');
  ok(ics.includes('VERSION:2.0'));
  ok(ics.includes('CALSCALE:GREGORIAN'));
  ok(ics.includes('METHOD:PUBLISH'));
  ok(ics.includes('X-WR-CALNAME:我的课表'));
  ok(ics.includes('X-WR-TIMEZONE:Asia/Shanghai'));
  eq((ics.match(/BEGIN:VEVENT/g) || []).length, 3);
  eq((ics.match(/END:VEVENT/g) || []).length, 3);
});

t('buildIcal 只有 CRLF，没有裸 LF', () => {
  const ics = S.buildIcal(EVENTS, { calName: 'x' });
  ok(!/[^\r]\n/.test(ics), '存在裸 LF，部分日历会解析失败');
});

t('buildIcal DTSTART/DTEND 无时区后缀（浮动时间）', () => {
  const ics = S.buildIcal(EVENTS);
  ok(ics.includes('DTSTART:20250903T083000'), 'DTSTART');
  ok(ics.includes('DTEND:20250903T100500'), 'DTEND');
  ok(!/DTSTART:[0-9T]+Z/.test(ics), '不得带 Z，否则中国时区会整体偏移');
});

t('buildIcal 事件必备字段齐全', () => {
  const ics = S.buildIcal(EVENTS);
  for (const k of ['UID:', 'DTSTAMP:', 'SUMMARY:', 'DESCRIPTION:', 'LOCATION:', 'SEQUENCE:']) {
    ok(ics.includes(k), `缺少 ${k}`);
  }
  ok(ics.includes('LOCATION:教一楼101'));
  ok(ics.includes('SUMMARY:高等数学'));
});

t('buildIcal 默认不写 VALARM，要求时写入', () => {
  ok(!S.buildIcal(EVENTS).includes('BEGIN:VALARM'), '默认不应有闹钟');
  const withAlarm = S.buildIcal(EVENTS, { alarmMinutes: 15 });
  ok(withAlarm.includes('BEGIN:VALARM'), '要求时必须有闹钟');
  ok(withAlarm.includes('TRIGGER:-PT15M'), '提前量必须是 15 分钟');
});

t('buildIcal SEQUENCE 可控', () => {
  ok(S.buildIcal(EVENTS, { sequence: 3 }).includes('SEQUENCE:3'));
});

t('buildIcal 同课同周折叠为同一 UID', () => {
  const ics = S.buildIcal(EVENTS);
  const uids = [...ics.matchAll(/UID:(\S+)/g)].map((m) => m[1]);
  eq(new Set(uids).size, uids.length, 'UID 不得重复');
});

t('buildIcal 空事件列表也产出合法日历', () => {
  const ics = S.buildIcal([]);
  ok(ics.includes('BEGIN:VCALENDAR'));
  ok(ics.includes('END:VCALENDAR'));
  eq((ics.match(/BEGIN:VEVENT/g) || []).length, 0);
});

t('buildIcal 课程名里的逗号被转义，不会撕裂 DESCRIPTION', () => {
  const ev = S.expandCourses([{ ...COURSE, courseName: '数学,分析' }], WEEKS);
  const ics = S.buildIcal(ev);
  ok(ics.includes('SUMMARY:数学\\,分析'), '逗号必须转义');
});

// ================================================================ 9. 派生视图

t('weekInfo 取到/取不到', () => {
  eq(S.weekInfo(WEEKS, 2).startDate, '2025-09-08');
  eq(S.weekInfo(WEEKS, 99), null);
});

t('weekOfDate 判定日期属于第几周', () => {
  eq(S.weekOfDate(WEEKS, '2025-09-03'), 1);
  eq(S.weekOfDate(WEEKS, '2025-09-10'), 2);
  eq(S.weekOfDate(WEEKS, '2025-09-21'), 3);
  eq(S.weekOfDate(WEEKS, '2025-12-01'), null);
});

t('groupByDate 按日期分组且组内有序', () => {
  const g = S.groupByDate(EVENTS);
  eq(Object.keys(g).length, 3);
  eq(g['2025-09-03'].length, 1);
});

t('groupByWeekDay 按周次+星期分组', () => {
  const g = S.groupByWeekDay(EVENTS);
  eq(g.get(1).get(3).length, 1);
  eq(g.get(3).get(3)[0].course, '高等数学');
});

t('nextClass 识别正在上的课', () => {
  const r = S.nextClass(EVENTS, new Date(2025, 8, 3, 9, 0));
  eq(r.status, 'ongoing');
  eq(r.event.course, '高等数学');
});

t('nextClass 识别下一节课并给出分钟数', () => {
  const r = S.nextClass(EVENTS, new Date(2025, 8, 3, 7, 30));
  eq(r.status, 'upcoming');
  eq(r.minutesUntil, 60);
});

t('nextClass 今天没课时指向后面最近一节', () => {
  const r = S.nextClass(EVENTS, new Date(2025, 8, 4, 10, 0));
  eq(r.status, 'upcoming');
  eq(r.event.date, '2025-09-10');
  eq(r.minutesUntil, null);
});

t('nextClass 全部上完返回 none', () => {
  eq(S.nextClass(EVENTS, new Date(2026, 0, 1, 10, 0)).status, 'none');
});

t('nextClass 空课表不崩', () => {
  eq(S.nextClass([], new Date()).status, 'none');
  eq(S.nextClass(null, new Date()).status, 'none');
});

// ================================================================ 10. buildSchedule 契约

t('buildSchedule 从原始响应组装数据包', () => {
  const pack = S.buildSchedule(
    { datas: { welcomeInfo: { xnxqdm: '2025-2026-1' }, userId: '2025000000' } },
    TERM_WEEKS_RAW,
    { datas: { arrangedList: [COURSE] } },
    { fetchedAt: '2026-01-01T00:00:00.000Z' },
  );
  eq(pack.schema, 1);
  eq(pack.kind, 'schedule');
  eq(pack.termCode, '2025-2026-1');
  eq(pack.studentCode, '2025000000');
  eq(pack.events.length, 3);
  eq(pack.termWeeks.length, 3);
  eq(pack.fetchedAt, '2026-01-01T00:00:00.000Z');
});

t('buildSchedule 兼容 list / rows 两种包装', () => {
  eq(S.buildSchedule({}, TERM_WEEKS_RAW, { datas: { list: [COURSE] } }).events.length, 3);
  eq(S.buildSchedule({}, TERM_WEEKS_RAW, { data: { rows: [COURSE] } }).events.length, 3);
  eq(S.buildSchedule({}, TERM_WEEKS_RAW, [COURSE]).events.length, 3);
});

t('buildSchedule 坏输入不崩', () => {
  const p = S.buildSchedule(null, null, null);
  eq(p.events.length, 0);
  eq(p.termCode, '');
});

// ================================================================ 11. 数据模型 / 分享码

t('model: normalizeSchedulePack 校验并补默认值', () => {
  const p = M.normalizeSchedulePack({ termCode: '2025-2026-1', arrangedList: [COURSE], termWeeks: WEEKS });
  eq(p.schema, 1);
  eq(p.kind, 'schedule');
  eq(p.events.length, 3);
});

t('model: normalizeSchedulePack 拒绝明显不合法的输入', () => {
  throws(() => M.normalizeSchedulePack(null), 'null 必须抛错');
  throws(() => M.normalizeSchedulePack({ kind: 'schedule' }), '缺少课表内容必须抛错');
  throws(() => M.normalizeSchedulePack('随便一段文字'), '字符串必须抛错');
});

t('model: 分享码编解码往返', () => {
  const pack = S.buildSchedule({ datas: { welcomeInfo: { xnxqdm: '2025-2026-1' }, userId: '2025000000' } }, TERM_WEEKS_RAW, { datas: { arrangedList: [COURSE] } });
  const code = M.encodeShareCode(pack);
  eq(typeof code, 'string');
  const back = M.decodeShareCode(code);
  eq(back.termCode, pack.termCode);
  eq(back.events.length, pack.events.length);
  deepEq(back.events.map((e) => e.uid), pack.events.map((e) => e.uid));
});

t('model: 分享码不含口令等敏感字段', () => {
  const pack = S.buildSchedule({ datas: { welcomeInfo: { xnxqdm: '2025-2026-1' }, userId: '2025000000' } }, TERM_WEEKS_RAW, { datas: { arrangedList: [COURSE] } });
  const code = M.decodeShareCode(M.encodeShareCode(pack));
  const dump = JSON.stringify(code);
  ok(!/password|passwd|pwd|cookie|token|tgc/i.test(dump), '分享码不得携带任何凭据字段');
});

t('model: 分享码能容忍空白与换行', () => {
  const pack = S.buildSchedule({ datas: { welcomeInfo: { xnxqdm: '2025-2026-1' } } }, TERM_WEEKS_RAW, { datas: { arrangedList: [COURSE] } });
  const code = M.encodeShareCode(pack);
  const messy = `  ${code.slice(0, 10)}\n${code.slice(10)}  `;
  eq(M.decodeShareCode(messy).events.length, pack.events.length);
});

t('model: 坏分享码抛出可读错误', () => {
  throws(() => M.decodeShareCode('这不是分享码'));
  throws(() => M.decodeShareCode(''));
});

t('model: 待办（作业/网课）增删与排序', () => {
  const list = M.upsertTodo([], { id: 'a', title: '高数作业', due: '2025-09-10T23:59', kind: 'homework' });
  eq(list.length, 1);
  const list2 = M.upsertTodo(list, { id: 'b', title: '网课截止', due: '2025-09-05T23:59', kind: 'online' });
  eq(list2.length, 2);
  eq(list2[0].id, 'b', '必须按截止时间升序');
  const list3 = M.upsertTodo(list2, { id: 'a', title: '高数作业（改）', due: '2025-09-10T23:59', kind: 'homework' });
  eq(list3.length, 2, '同一 id 应更新而非追加');
  eq(M.removeTodo(list3, 'a').length, 1);
});

t('model: 未读公告计数', () => {
  const anns = [{ id: '1' }, { id: '2' }, { id: '3' }];
  eq(M.unreadCount(anns, []), 3);
  eq(M.unreadCount(anns, ['1', '3']), 1);
  eq(M.unreadCount(anns, ['1', '2', '3']), 0);
  eq(M.unreadCount(null, null), 0);
});

t('model: 导入的公告按时间倒序', () => {
  const list = M.normalizeAnnouncements([
    { id: 'a', title: '旧', date: '2025-09-01' },
    { id: 'b', title: '新', date: '2025-10-01' },
  ]);
  eq(list[0].id, 'b');
});

// ---- 公告分享码 / ntfy 频道 / 共享与私公告合并（管理员页 → 用户端的接线） ----

t('ann: 分享码往返一致，且前缀与课表分享码分开', () => {
  const code = M.encodeAnnConfig({
    url: 'https://chen-ser.github.io/YangShan-schedule/data/announcements.json',
    topic: 'ys-bistu-a1b2c3d4e5f6a7b8c9d0e1f2',
    name: '仰山课表公告',
  });
  ok(code.startsWith('YSA1-'), '必须以 YSA1- 开头');
  ok(!code.startsWith(M.SHARE_PREFIX) && !code.startsWith(M.RAW_PREFIX), '不能和课表分享码混在一起');
  const back = M.decodeAnnConfig(code);
  eq(back.url, 'https://chen-ser.github.io/YangShan-schedule/data/announcements.json');
  eq(back.topic, 'ys-bistu-a1b2c3d4e5f6a7b8c9d0e1f2');
  eq(back.name, '仰山课表公告');
});

t('ann: 只有频道、或只有地址的分享码都能解', () => {
  const onlyTopic = M.decodeAnnConfig(M.encodeAnnConfig({ topic: 'ys-abc' }));
  eq(onlyTopic.url, '');
  eq(onlyTopic.topic, 'ys-abc');
  const onlyUrl = M.decodeAnnConfig(M.encodeAnnConfig({ url: 'https://a.example/x.json' }));
  eq(onlyUrl.url, 'https://a.example/x.json');
  eq(onlyUrl.topic, '');
});

t('ann: 坏分享码一律抛错，不静默用一半', () => {
  throws(() => M.decodeAnnConfig('YS1-abc'), '不是公告分享码');
  throws(() => M.decodeAnnConfig('YSA1-!!!!'), '内容损坏');
  throws(() => M.decodeAnnConfig(M.encodeAnnConfig({})), '空载荷');
  throws(() => M.decodeAnnConfig(M.encodeAnnConfig({ topic: '有中文' })), '频道名非法');
  throws(() => M.decodeAnnConfig(M.encodeAnnConfig({ topic: 'a/b' })), '频道名不许有斜杠');
  throws(() => M.decodeAnnConfig(M.encodeAnnConfig({ url: 'ftp://x/y.json' })), '地址必须是 http(s)');
});

t('ann: 公告源输入框同时接受裸网址和分享码', () => {
  eq(M.parseAnnConfig('https://a.example/ann.json').url, 'https://a.example/ann.json');
  eq(M.parseAnnConfig('https://a.example/ann.json').topic, '');
  eq(M.parseAnnConfig('').url, '', '留空是合法的（等于不订阅）');
  eq(M.parseAnnConfig('   ').topic, '');
  const c = M.parseAnnConfig(M.encodeAnnConfig({ url: 'https://a.example/ann.json', topic: 'ys-1' }));
  eq(c.topic, 'ys-1');
  throws(() => M.parseAnnConfig('随便写的一串'), '既不是分享码也不是地址');
});

t('ann: 本机私公告与共享公告合并，同 id 时本机优先', () => {
  const shared = [
    { id: 's1', title: '共享一', date: '2025-10-01' },
    { id: 'dup', title: '共享的重复 id', date: '2025-10-02' },
  ];
  const local = [
    { id: 'dup', title: '我自己改过的', date: '2025-10-03', source: 'local' },
    { id: 'l1', title: '私公告', date: '2025-09-30', source: 'local' },
  ];
  const merged = M.mergeAnnouncements(shared, local);
  eq(merged.length, 3, '重复 id 只留一条');
  const dup = merged.find((a) => a.id === 'dup');
  eq(dup.title, '我自己改过的', '同 id 时本机优先');
  eq(dup.source, 'local');
  eq(merged[0].id, 'dup', '合并后仍按日期倒序');
});

t('ann: 来源标记要落到 normalized 结果上', () => {
  eq(M.normalizeAnnouncements([{ id: 'a', title: 'x' }])[0].source, 'shared', '默认共享');
  eq(M.normalizeAnnouncements([{ id: 'a', title: 'x' }], { source: 'local' })[0].source, 'local');
});

t('ann: 类别能带着走，但不设白名单（手写的值不能被吃掉）', () => {
  const one = (raw) => M.normalizeAnnouncements([{ id: 'a', title: 'x', ...raw }])[0];
  eq(one({ category: '调课' }).category, '调课', '管理页选的类别要原样留下');
  eq(one({}).category, '', '没填就是空字符串，卡片上不显示标签');
  eq(one({ category: '选课' }).category, '选课', '不在固定列表里的值也要保留 —— 别人手写的不该消失');
  eq(one({ category: '  考试  ' }).category, '考试', '两侧空白要清掉');
  eq(one({ category: '很长的类别名字超过十二个字了' }).category.length, 12, '过长要截到 12 个字，免得挤坏布局');
  eq(one({ category: '考\u0000试\n' }).category, '考试', '控制字符（含换行）必须清掉');
});

t('ann: 管理页「写公告」区必须有类别选择，并且真的写进 JSON', () => {
  const tpl = readFileSync(join(ROOT, 'web/admin/template.html'), 'utf8');
  const js = readFileSync(join(ROOT, 'web/admin/admin.js'), 'utf8');
  const app = readFileSync(join(ROOT, 'web/app.js'), 'utf8');
  const schema = readFileSync(join(ROOT, 'data/announcements.json'), 'utf8');
  const cssAdmin = readFileSync(join(ROOT, 'web/admin/admin.css'), 'utf8');

  const select = tpl.match(/<select id="fCategory">([\s\S]*?)<\/select>/);
  ok(select, '表单里必须有 id="fCategory" 的下拉框');
  const options = [...select[1].matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
  deepEq(options, ['通知', '调课', '考试', '活动', '其它'], '类别选项就是这五项');

  // 两边的列表必须一模一样：只在 HTML 里加一项、JS 里没加，会出现「选了却被重置成通知」
  const consts = js.match(/const CATEGORIES = \[([^\]]+)\]/);
  ok(consts, 'admin.js 里要有 CATEGORIES 常量');
  deepEq([...consts[1].matchAll(/'([^']*)'/g)].map((m) => m[1]), options, 'CATEGORIES 要和下拉框逐项一致');

  ok(/category: \$id\('fCategory'\)\.value/.test(js), 'commitForm 必须把选中的类别写进列表项');
  ok(/\$id\('fCategory'\)\.value = CATEGORIES\[0\]/.test(js), '清空表单要回到第一项，不能留空');
  ok(/CATEGORIES\.includes\(a\.category\)/.test(js), '编辑已有公告要回填类别（越界的回落第一项）');
  ok(/catTag\.textContent = a\.category/.test(js), '列表里要看得见类别');
  ok(cssAdmin.includes('.ad-item .tag.cat'), '类别标签要有自己的样式');

  ok(/a\.category \? h\('span', \{ class: 'ann-cat' \}, a\.category\)/.test(app), '应用端的公告卡片要显示类别');
  ok(schema.includes('category'), 'announcements.json 的字段说明要写清 category');
});

t('ann: 置顶的私公告在合并后仍排最前', () => {
  const merged = M.mergeAnnouncements(
    [{ id: 's1', title: '新的共享公告', date: '2025-10-09' }],
    [{ id: 'l1', title: '置顶的私公告', date: '2025-09-01', pinned: true, source: 'local' }],
  );
  eq(merged[0].id, 'l1');
});

t('ann: ntfy 地址与随机频道名', () => {
  eq(M.ntfySseUrl('ys-abc'), 'https://ntfy.sh/ys-abc/sse');
  eq(M.ntfyPublishUrl('ys-abc'), 'https://ntfy.sh/ys-abc');
  eq(M.ntfySseUrl('ys-abc', 'https://ntfy.sh/'), 'https://ntfy.sh/ys-abc/sse', '结尾斜杠要归一');
  const topic = M.randomTopic('ys-bistu');
  ok(/^ys-bistu-[0-9a-f]{24}$/.test(topic), `随机频道名格式不对：${topic}`);
  ok(M.TOPIC_RE.test(topic));
  ok(!M.TOPIC_RE.test('有中文'));
  ok(!M.TOPIC_RE.test('a/b'));
  ok(!M.TOPIC_RE.test(''), '空频道名非法');
  ok(!M.TOPIC_RE.test('x'.repeat(65)), '超过 64 字符非法');
  ok(M.randomTopic('ys') !== M.randomTopic('ys'), '两次生成不应相同');
});

t('data: 仓库里的公告权威源合法、可解析、初始为空', () => {
  const raw = JSON.parse(readFileSync(join(ROOT, 'data/announcements.json'), 'utf8'));
  ok(Array.isArray(raw.announcements), '必须有 announcements 数组');
  deepEq(M.normalizeAnnouncements(raw), [], '初始状态不该有公告');
  ok(Array.isArray(raw._说明) && raw._说明.length > 0, '_说明 要在，它是给管理员看的');
});

t('model: 提醒时间计算（提前 N 分钟）', () => {
  eq(M.remindAt('2025-09-10T08:00', 15), '2025-09-10T07:45');
  eq(M.remindAt('2025-09-10T08:00', 0), '2025-09-10T08:00');
  eq(M.remindAt('2025-09-10T00:10', 15), '2025-09-09T23:55');
});

// 随仓库发布的公告源示例是给用户照抄的（共享通知的落地载体），它必须真的能被解析。
// 单纯「文件存在」不算数 —— 这里断言字段真的落到位，杜绝示例与解析器各自漂移。
t('examples: 公告源示例能被真实解析', () => {
  const raw = JSON.parse(readFileSync(join(ROOT, 'examples/announcements.json'), 'utf8'));
  const list = M.normalizeAnnouncements(raw);
  eq(list.length, 3, '三条示例都应解析出来');
  ok(list.every((a) => a.id && a.title && a.date), '每条都要有 id / title / date');
  const urgent = list.find((a) => a.id === '2026-10-09-exam');
  ok(urgent, '示例里的 urgent 那条应被解析出来');
  eq(urgent.level, 'urgent', 'level 应原样保留');
  eq(urgent.pinned, true, 'pinned 应为真');
  ok(/^https?:/.test(urgent.link), 'link 应保留成可点的地址');
  eq(list[0].id, '2026-10-09-exam', '置顶那条排最前');
  ok(list.some((a) => a.level === 'warn') && list.some((a) => a.level === 'info'), '三档 level 都要覆盖到');
});

t('model: 微信/QQ 通知文本解析出待办', () => {
  const r = M.parseNoticeText('【学习通】高等数学 作业提交截止时间：2025-09-10 23:59，请及时提交。');
  ok(r.length >= 1, '至少解析出一条');
  eq(r[0].due, '2025-09-10T23:59');
  ok(/高等数学|作业/.test(r[0].title), '标题应含课程或关键词');
});

t('model: 解析多行通知文本', () => {
  const r = M.parseNoticeText('2025-09-10 23:59 高数作业截止\n2025-09-12 12:00 英语网课截止');
  eq(r.length, 2);
});

t('model: 认不出的文本返回空数组而不是瞎猜', () => {
  deepEq(M.parseNoticeText('今天天气不错'), []);
  deepEq(M.parseNoticeText(''), []);
  deepEq(M.parseNoticeText(null), []);
});

// ---- 待办 → 日历事件 / 提醒（「导入作业后自动设置作业提醒」的接线） ----

t('model: 待办转事件只吃「未完成 + 有截止时间」', () => {
  const ev = M.todoToEvents([
    { id: 'a', title: '高数作业', due: '2025-09-10T23:59', kind: 'homework' },
    { id: 'b', title: '做完了的', due: '2025-09-11T12:00', kind: 'homework', done: true },
    { id: 'c', title: '没填截止', due: '', kind: 'online' },
  ]);
  eq(ev.length, 1, '只应剩 1 条');
  eq(ev[0].uid, 'ys-todo-a@bistu.schedule');
  eq(ev[0].kind, 'todo');
  eq(ev[0].todoKindLabel, '作业');
  eq(ev[0].date, '2025-09-10');
  eq(ev[0].start, '23:59');
  eq(ev[0].end, '23:59', '23:59 起 30 分钟不跨日，截到 23:59');
});

t('model: 待办事件块长 30 分钟、UID 前缀与课程分开', () => {
  const ev = M.todoToEvents([{ id: 'x1', title: '网课', due: '2025-09-12T12:00', kind: 'online' }]);
  eq(ev[0].start, '12:00');
  eq(ev[0].end, '12:30');
  eq(ev[0].todoKindLabel, '网课');
  ok(ev[0].uid.startsWith('ys-todo-'), 'UID 必须是 ys-todo- 前缀');
  ok(!ev[0].uid.startsWith('bistu-'), '不能和课程事件撞前缀');
});

t('model: 待办 UID 不含标题，改错别字不会多出一个事件', () => {
  const a = M.todoToEvents([{ id: 'same', title: '高数作业第三章', due: '2025-09-10T23:59' }]);
  const b = M.todoToEvents([{ id: 'same', title: '高数作业第三章（改过）', due: '2025-09-10T23:59' }]);
  eq(a[0].uid, b[0].uid);
});

t('model: 距离截止还有多久（跨天要算对）', () => {
  const now = new Date(2025, 8, 10, 22, 0); // 2025-09-10 22:00
  eq(M.todoRemindIn({ due: '2025-09-10T23:59' }, now), 119);
  eq(M.todoRemindIn({ due: '2025-09-11T00:30' }, now), 150);
  eq(M.todoRemindIn({ due: '2025-09-10T21:00' }, now), -60);
  eq(M.todoRemindIn({ due: '' }, now), null);
});

t('model: 待办转事件容忍坏输入', () => {
  deepEq(M.todoToEvents(null), []);
  deepEq(M.todoToEvents([]), []);
  const ev = M.todoToEvents([{ id: 'z', title: '怪时间', due: '2025-09-10T99:99' }]);
  eq(ev[0].start, '23:59', '非法时间退回 23:59');
});

// ---- 待办进 .ics ----

t('ical: 待办事件带【类型】前缀、不写 LOCATION、用逐条提前量', () => {
  const todos = M.todoToEvents([{ id: 'h1', title: '高数作业', due: '2025-09-10T23:59', kind: 'homework', note: '【学习通】高数作业截止' }]);
  const ics = S.buildIcal([...todos.map((e) => ({ ...e, alarmMinutes: 1440 }))], {
    calName: '截止', alarmMinutes: null,
  });
  ok(ics.includes('SUMMARY:【作业】高数作业'), 'SUMMARY 应带类型前缀');
  ok(ics.includes('DTSTART:20250910T235900'), 'DTSTART 应为 23:59');
  ok(ics.includes('TRIGGER:-PT1440M'), '应使用逐条提前量 1 天');
  ok(!ics.includes('LOCATION:'), '待办不该写 LOCATION');
  ok(!ics.includes('教师: 未知'), '不该套课程模板');
  ok(ics.includes('类型: 作业'), '描述里应有类型');
  ok(!ics.includes('\n') || ics.split('\r\n').length > 1, '必须用 CRLF');
  ok(!/[^\r]\n/.test(ics), '不允许裸 LF');
});

t('ical: 课程事件不受待办改动影响（仍有 LOCATION、无【】前缀）', () => {
  const events = S.expandCourses(
    [{ courseName: '高等数学', dayOfWeek: 3, beginSection: 1, endSection: 2, week: '1', placeName: 'ZXB-306' }],
    [{ serialNumber: 1, startDate: '2025-09-01', endDate: '2025-09-07' }],
    { termCode: '2025-2026-1' },
  );
  const ics = S.buildIcal(events, { alarmMinutes: 15 });
  ok(ics.includes('LOCATION:ZXB-306'), '课程仍要有地点');
  ok(ics.includes('SUMMARY:高等数学'), '课程 SUMMARY 不该带【】');
  ok(!ics.includes('【'), '课程里不该出现待办专用的【】');
  ok(ics.includes('TRIGGER:-PT15M'), '课程用全局提前量');
});

t('ical: 待办与课程混编时事件数正确、UID 不重复', () => {
  const events = S.expandCourses(
    [{ courseName: '高等数学', dayOfWeek: 3, beginSection: 1, endSection: 2, week: '1', placeName: 'ZXB-306' }],
    [{ serialNumber: 1, startDate: '2025-09-01', endDate: '2025-09-07' }],
    { termCode: '2025-2026-1' },
  );
  const todos = M.todoToEvents([
    { id: 't1', title: '作业一', due: '2025-09-10T23:59', kind: 'homework' },
    { id: 't2', title: '网课二', due: '2025-09-12T12:00', kind: 'online' },
  ]);
  const ics = S.buildIcal([...events, ...todos]);
  eq(ics.split('BEGIN:VEVENT').length - 1, events.length + 2);
  const uids = [...ics.matchAll(/^UID:(.+)$/gm)].map((m) => m[1]);
  eq(uids.length, new Set(uids).size, 'UID 不得重复');
});

t('model: 备份包往返', () => {
  const pack = { schema: 1, kind: 'backup', schedule: { events: [] }, todos: [], readAnnouncements: [] };
  const back = M.parseBackup(M.serializeBackup(pack));
  eq(back.kind, 'backup');
});

// ================================================================ 6. 真实数据回归（脱敏 fixture）
//
// 样本来自对 jwxt.bistu.edu.cn 的一次真实抓取，学号/姓名/教师姓名/内部编码已置换，
// 课程、教室、节次、周次位图、学期周历保持原样。
//
// 这一节是拿真实响应喂出来的，已经抓到两个只有真数据才暴露的缺陷：
//   ① 接口的 startDate 带时分秒（'2026-09-07 00:00:00'）→ Number('07 00:00:00') = NaN，
//      所有日期变成 'NaN-NaN-NaN'，又因为 UID 含日期，全部互相去重，22 门课只剩 22 条；
//   ② placeName 为空时"剥标签取最后一个词"，把教师名当成了教室。
// 改核心解析逻辑后若这一节红了，先怀疑自己，别改断言。

const RAW = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/raw-2026-2027-1.json'), 'utf8'));
const REAL = M.normalizeSchedulePack(RAW);
const REAL_COURSES = RAW.scheduleDetail.datas.arrangedList;

t('fixture: 真实样本里不含任何个人信息', () => {
  const dump = JSON.stringify(RAW);

  // ── 结构不变量：任何环境都要跑 ──────────────────────────────────────────
  ok(!/data-code=/.test(dump), '不得含内部编码');
  ok(!/avatarToken|userImg|bgImage|userName/.test(dump), '不得含身份字段');

  // 学号必须是占位串：整份样本里不该出现第二个 10 位数字。
  // 这条是通用护栏，不需要知道真实学号是什么 —— 真实值换一茬它照样生效。
  const tenDigit = new Set(dump.match(/(?<!\d)20[12]\d[0-9]{6}(?!\d)/g) ?? []);
  const extra = [...tenDigit].filter((x) => x !== REAL.studentCode);
  eq(extra.length, 0, `除占位学号 ${REAL.studentCode} 外不应有别的 10 位数字`);

  // ── 黑名单比对：名单放在不进仓库的 pii-denylist.local.json ──────────────
  //
  // ★ 为什么不把真实学号和姓名直接写在这段测试里：这段源码是要发到公开仓库的，
  //   把黑名单抄进去等于换个地方泄露 —— 本来就是为了拦住它们才写的断言。
  //   文件不在时跳过（CI 上就是这种情况：CI 本来也无从知道真实值）。
  const denyPath = join(ROOT, 'test/fixtures/pii-denylist.local.json');
  if (!existsSync(denyPath)) {
    console.log('      · 跳过真实标识黑名单比对（test/fixtures/pii-denylist.local.json 不存在）');
    return;
  }
  const deny = JSON.parse(readFileSync(denyPath, 'utf8'));
  for (const id of deny.studentIds ?? []) {
    // 报错信息只回显前 4 位，免得断言失败时把真实值又打进 CI 日志。
    ok(!dump.includes(id), `不得含真实学号（${String(id).slice(0, 4)}…）`);
  }
  // 名单必须覆盖**整棵对象树**上的所有教师，包括 notArrangeList（未排课的 5 门）。
  // 漏掉那一支的教训：有几个教师名曾经原样留在 fixture 里。
  for (const n of deny.names ?? []) {
    ok(!dump.includes(n), `不得含姓名（${String(n).slice(0, 1)}…）`);
  }
});

t('fixture: 脱敏不能把结构洗掉（防假绿）', () => {
  // 这两条如果红了，说明脱敏脚本把该留的东西吃掉了 ——
  // 下面的地点兜底、周次位图、锚点解析等用例会因此变成"假绿"。
  // 注意 JSON 文本里引号是 \"，正则要容忍反斜杠。
  const dump = JSON.stringify(RAW);
  ok(/data-kblx=\\?"01\\?"/.test(dump), '地点锚点必须保留，否则覆盖不到地点兜底');
  ok(/data-kblx=\\?"02\\?"/.test(dump), '教师锚点必须保留');
  ok(dump.includes('[讲授]'), '课程性质标签不能被姓名替换吃掉');
  eq(RAW.scheduleDetail.datas.notArrangeList.length, 5, '未排课列表也要一起进样本');
});

t('真实数据: 学期与学号识别正确', () => {
  eq(REAL.termCode, '2026-2027-1');
  eq(REAL.studentCode, '2026000000');
  eq(S.parseTermCode(REAL.termCode).label, '2026-2027学年 上学期');
});

t('真实数据: 22 门课展开成 133 节课（回归基准）', () => {
  eq(REAL_COURSES.length, 22);
  eq(REAL.events.length, 133);
  const dates = REAL.events.map((e) => e.date).sort();
  eq(dates[0], '2026-09-08');
  eq(dates[dates.length - 1], '2027-01-01');
  ok(REAL.events.every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date)), '每个事件都必须有合法日期');
});

t('真实数据: 位图长度参差不齐（2~17 位）也能正确取周', () => {
  const lens = new Set(REAL_COURSES.map((c) => String(c.week).length));
  ok(lens.size >= 5, '样本里本来就长短不一');
  for (const c of REAL_COURSES) {
    const ws = S.parseWeekBitmap(c.week);
    if (ws.length) eq(Math.max(...ws), String(c.week).length, `${c.courseName} 最后一周应等于位图长度`);
  }
});

t('★ 真实数据: 节次时间表与接口给的 beginTime/endTime 完全自洽', () => {
  let checked = 0;
  for (const c of REAL_COURSES) {
    if (!c.beginTime) continue;
    const row = S.SECTION_TIMES[c.beginSection - 1];
    ok(row, `第 ${c.beginSection} 节必须在节次表里`);
    eq(row.start, c.beginTime, `${c.courseName} 第 ${c.beginSection} 节开始时间`);
    if (c.endTime) {
      eq(S.SECTION_TIMES[c.endSection - 1].end, c.endTime, `${c.courseName} 第 ${c.endSection} 节结束时间`);
    }
    checked++;
  }
  eq(checked, REAL_COURSES.length, '每条都该有 beginTime');
});

t('真实数据: 一节具体的课（日期/时间/地点/教师）', () => {
  const evs = REAL.events.filter((e) => e.course === '程序设计基础(C语言)B');
  eq(evs.length, 11, '位图 3-12 周 10 次 + 第 13 周 1 次');
  eq(evs[0].date, '2026-09-21', '第 3 周周一');
  eq(evs[0].start, '13:30');
  eq(evs[0].end, '15:55');
  eq(evs[0].location, '汇贤堂');
  eq(evs[0].teacher, '某老师');
  eq(evs[evs.length - 1].date, '2026-11-30', '第 13 周周一');
});

t('★ 真实数据: 单周课只落在它自己那一周', () => {
  const c = REAL_COURSES.find((x) => x.week === '0000001');
  ok(c, '样本里应有一条只上第 7 周的课');
  const evs = REAL.events.filter((e) => e.course === c.courseName && e.week === 7);
  ok(evs.length >= 1);
  ok(evs.every((e) => e.week === 7));
});

t('★ 真实数据: 地点为空时不得把教师名当教室', () => {
  for (const e of REAL.events) {
    ok(!/老师|同学/.test(e.location), `${e.course} 的教室不应该是人名：${e.location}`);
  }
});

t('真实数据: 同一份原始数据展开两次，UID 完全一致', () => {
  const again = M.normalizeSchedulePack(RAW);
  deepEq(again.events.map((e) => e.uid), REAL.events.map((e) => e.uid));
  eq(new Set(REAL.events.map((e) => e.uid)).size, REAL.events.length, 'UID 不得重复');
});

t('真实数据: 走书签串 YSRAW1- 往返后完全一致', () => {
  const code = M.RAW_PREFIX + M.toBase64Url(JSON.stringify(RAW));
  const back = M.parseAnyScheduleInput(code);
  eq(back.events.length, REAL.events.length);
  deepEq(back.events.map((e) => e.uid), REAL.events.map((e) => e.uid));
});

t('真实数据: 生成的 ics 能被日历按天切开且不含裸 LF', () => {
  const ics = S.buildIcal(REAL.events, { calendarName: '仰山课表' });
  eq((ics.match(/BEGIN:VEVENT/g) || []).length, REAL.events.length);
  ok(!/[^\r]\n/.test(ics), '存在裸 LF');
  ok(ics.includes('DTSTART:20260921T133000'), '第 3 周周一 13:30');
});

// ================================================================ 7. 课表文件导入（.xlsx / .docx）
//
// 这里的样本是**教务系统导出的真文件**：把两份真课表（同一学生同一学期的
// Excel 版与 Word 版）里的 XML 部件脱敏后存成文本 fixture，测试时用 test/zip.mjs
// 现打包成 Office 文件。留 XML 不留 zip 的原因：文本能看 diff，二进制不能。
//
// ★ 这一节最值钱的一条是「两种格式必须解析出完全相同的课表」——Excel 与 Word 的
//   排版机制完全不同（inlineStr vs w:t、&#xa; vs w:p、纵向合并单元格），能对上就说明
//   两条解析路径都没跑偏。改 core/officefile.mjs 后这一节红了，先怀疑自己。

const OF = await load('core/officefile.mjs');
const { makeZip } = await load('test/zip.mjs');

// 真实学期周历（19 周，2026-09-07 起）。文件里只有周次，没有学期起始日，
// 所以「文件导入」必须借一份周历才能算出每节课的日期 —— 这也是产品上必须让
// 用户补一次「第 1 周从哪天开始」的原因。
const REAL_WEEKS = S.normalizeTermWeeks(RAW.termWeeks);

// Node 侧注入解压器。浏览器侧注的是 OF.browserInflateRaw（DecompressionStream）。
const inflateRaw = async (u8) => new Uint8Array(inflateRawSync(u8));

async function ta(name, fn) {
  try {
    await fn();
    pass++;
  } catch (e) {
    failures.push({ name, error: e });
  }
}

const SHEET_XML = readFileSync(join(ROOT, 'test/fixtures/office-sheet1.xml'), 'utf8');
const DOC_XML = readFileSync(join(ROOT, 'test/fixtures/office-document.xml'), 'utf8');

// 故意把大部件标成 deflate、小部件用 stored —— 两条分支都被真实走到
const XLSX = makeZip([
  { name: '[Content_Types].xml', text: '<Types/>' },
  { name: 'xl/workbook.xml', text: '<workbook/>' },
  { name: 'xl/styles.xml', text: '<styleSheet/>' },
  { name: 'xl/sharedStrings.xml', text: '<sst count="0" uniqueCount="0"/>' },
  { name: 'xl/worksheets/sheet1.xml', text: SHEET_XML, deflate: true },
]);
const DOCX = makeZip([
  { name: '[Content_Types].xml', text: '<Types/>' },
  { name: 'word/styles.xml', text: '<w:styles/>' },
  { name: 'word/document.xml', text: DOC_XML, deflate: true },
]);

const GRID_XLSX = OF.parseScheduleGrid((await OF.readOfficeRows(XLSX, inflateRaw)).rows);
const GRID_DOCX = OF.parseScheduleGrid((await OF.readOfficeRows(DOCX, inflateRaw)).rows);

// ★ 浏览器侧那条解压路径（DecompressionStream）也要真跑一遍。
//   Node 18+ 有全局的 DecompressionStream / Blob，所以同一份代码能在这里验证，
//   不用靠"人肉打开浏览器点一下试试"。改 browserInflateRaw 后这条红了就是真坏了。
await ta('browserInflateRaw：DecompressionStream 解开 deflate-raw', async () => {
  const { deflateRawSync } = await import('node:zlib');
  const text = '仰山课表 deflate-raw roundtrip · 中文也一样';
  const out = await OF.browserInflateRaw(new Uint8Array(deflateRawSync(new TextEncoder().encode(text))));
  eq(new TextDecoder().decode(out), text);
});

await ta('整份 .xlsx 走浏览器解压器读一遍，结果与 Node 解压器一致', async () => {
  const g = OF.parseScheduleGrid((await OF.readOfficeRows(XLSX, OF.browserInflateRaw)).rows);
  eq(g.courses.length, GRID_XLSX.courses.length);
  eq(JSON.stringify(g.courses), JSON.stringify(GRID_XLSX.courses));
});

t('officefile: ZIP 中央目录能列出全部条目（含 stored 与 deflate 两种）', () => {
  const names = OF.listZipEntries(XLSX).map((e) => e.name);
  eq(names.length, 5);
  ok(names.includes('xl/worksheets/sheet1.xml'));
  const methods = new Set(OF.listZipEntries(XLSX).map((e) => e.method));
  deepEq([...methods].sort(), [0, 8], '两种压缩方式都要出现');
});

t('officefile: 认不出格式时给的是人话', () => {
  const junk = makeZip([{ name: 'readme.txt', text: 'hi' }]);
  let msg = '';
  try {
    OF.listZipEntries(new Uint8Array([1, 2, 3]));
  } catch (e) {
    msg = e.message;
  }
  ok(/不是一个 Office 文件/.test(msg), `实际: ${msg}`);
  void junk;
});

t('officefile: XML 实体解码', () => {
  eq(OF.decodeXmlEntities('a&amp;b&lt;c&gt;d&quot;e&apos;f'), 'a&b<c>d"e\'f');
  eq(OF.decodeXmlEntities('&#65;&#x4e2d;'), 'A中');
  eq(OF.decodeXmlEntities('没有实体'), '没有实体');
});

t('officefile: 单元格引用 → 列号', () => {
  eq(OF.colIndex('A1'), 0);
  eq(OF.colIndex('H12'), 7);
  eq(OF.colIndex('AA1'), 26);
  eq(OF.colIndex('AB100'), 27);
});

t('officefile: xlsx 抬头信息（学期 / 学号 / 校区 / 专业 / 班级）', () => {
  eq(GRID_XLSX.termName, '2026-2027学年 第一学期');
  eq(GRID_XLSX.studentCode, '2026000000');
  eq(GRID_XLSX.studentName, '某同学');
  eq(GRID_XLSX.campus, '天枢书院（张家口）');
  eq(GRID_XLSX.major, '智能制造工程');
  eq(GRID_XLSX.className, '000000');
  eq(GRID_XLSX.printedAt, '2026-10-09');
});

t('★ officefile: docx 的抬头在表格之外，也必须读到', () => {
  // Word 版把学期/学号/校区放在 `<w:body>` 里表格之外的段落中。
  // 早先只读第一张 `w:tbl`，于是学期与学号全空 —— 这一条就是钉住这个回归。
  eq(GRID_DOCX.termName, '2026-2027学年 第一学期');
  eq(GRID_DOCX.studentCode, '2026000000');
  eq(GRID_DOCX.campus, '天枢书院（张家口）');
  eq(GRID_DOCX.className, '000000');
});

t('★ officefile: docx 有第二张表（未排具体节次课程），不能只读第一张', () => {
  eq(GRID_DOCX.unscheduled.length, 5, 'Word 版的未排课清单在第二张表里');
  eq(GRID_XLSX.unscheduled.length, 5);
});

t('★ officefile: 一份课程名可以挂多条时间段', () => {
  // 真文件里 '基础英语A[ENGL101a]' 只写一次，底下直接跟两行（4-17周 / 3周）。
  // 早先只留一条 detail，第二条会被并进地点里，界面显示成
  // 「基础英语A  ZXC205 3周 方元 第1节-第2节 ZXB-502」。
  for (const g of [GRID_XLSX, GRID_DOCX]) {
    const eng = g.courses.filter((c) => c.courseName === '基础英语A');
    eq(eng.length, 4, '两个时段 × 两个节次段');
    for (const c of eng) ok(!/周.*周|第\d节/.test(c.placeName), `地点被污染: ${c.placeName}`);
    deepEq(
      eng.map((c) => `${c.dayOfWeek}/${c.beginSection}-${c.endSection}/${c.weeksText}/${c.placeName}`).sort(),
      [
        '4/1-2/3周/ZXB-502',
        '4/1-2/4-17周/ZXC205',
        '3/3-4/3周/ZXB-502',
        '3/3-4/4-17周/ZXC205',
      ].sort(),
    );
  }
});

t('★ officefile: 单双周只作用在它自己那一段上', () => {
  // '3周,6-8周(双)' = 第 3 周 + 第 6~8 周里的双周 = {3,6,8}。
  // 已用接口侧的 week 位图 '00100101' 交叉验证过（见下一节）。
  deepEq(OF.parseWeeksLoose('3周,6-8周(双)'), [3, 6, 8]);
  deepEq(OF.parseWeeksLoose('3-6周,8周'), [3, 4, 5, 6, 8]);
  deepEq(OF.parseWeeksLoose('1-8周(单)'), [1, 3, 5, 7]);
  deepEq(OF.parseWeeksLoose('15-17周'), [15, 16, 17]);
  deepEq(OF.parseWeeksLoose('1-2周'), [1, 2]);
  deepEq(OF.parseWeeksLoose(''), []);
  // 两条真数据必须对上
  const mar = GRID_XLSX.courses.find((c) => c.courseCode === 'MARX111' && c.beginSection === 5);
  deepEq(mar.weeks, [3, 6, 8], '形势与政策(1)');
});

t('★ officefile: 两种格式解析出的课表必须完全一致', () => {
  const key = (c) =>
    [c.courseName, c.courseCode, c.dayOfWeek, c.beginSection, c.endSection, c.weeksText, c.teacher, c.placeName].join('|');
  const a = GRID_XLSX.courses.map(key).sort();
  const b = GRID_DOCX.courses.map(key).sort();
  eq(a.length, 25, 'Excel 版 25 个课程块');
  deepEq(b, a, 'Word 版与 Excel 版必须一模一样');

  const uk = (c) => [c.courseName, c.courseCode, c.classNo, c.weeksAndTeachers].join('|');
  deepEq(GRID_DOCX.unscheduled.map(uk).sort(), GRID_XLSX.unscheduled.map(uk).sort());
});

t('officefile: 页脚「打印人…打印时间…」不得被当成一门课', () => {
  // Excel 版在未排课清单后面还跟一行页脚。只判"名称格非空"的话它会混进未排课列表。
  for (const g of [GRID_XLSX, GRID_DOCX]) {
    for (const c of g.unscheduled) {
      ok(!/打印/.test(c.courseName), `页脚混进来了: ${c.courseName}`);
      ok(c.courseCode, `未排课必须有课程代码: ${c.courseName}`);
      ok(c.weeks.length > 0, `未排课必须有周次: ${c.courseName}`);
    }
  }
});

t('officefile: 未排课清单内容正确', () => {
  const names = GRID_XLSX.unscheduled.map((c) => c.courseName);
  deepEq(names, ['艺术导论(通识课)', '智能制造产业认知与素养', '大学生安全知识教育', '大学生职业规划', '军训']);
  eq(GRID_XLSX.unscheduled.find((c) => c.courseName === '军训').classNo, '02');
  ok(GRID_XLSX.unscheduled.find((c) => c.courseName === '军训').weeksAndTeachers.length > 0);
});

t('officefile: 教师字段全部脱敏干净（拿解析器当探针）', () => {
  // XML 文本里查残留只能查到"已知姓名"。这里换个角度：让解析器把教师抠出来，
  // 任何一个没被替换掉的真名都会以非「某老师」的形式冒出来。
  for (const g of [GRID_XLSX, GRID_DOCX]) {
    for (const c of [...g.courses, ...g.unscheduled]) {
      const t = c.teacher ?? c.weeksAndTeachers ?? '';
      ok(!/[陈孟古马孙王郭赵李雷方倪蔡]/.test(t.replace(/某老师/g, '')), `教师里疑似残留真名: ${t}`);
    }
  }
});

t('★ officefile: 文件 → 事件 端到端，且与抓取路径共用同一套展开逻辑', () => {
  const list = OF.gridToArrangedList(GRID_XLSX.courses);
  eq(list.length, 25);
  const evs = S.expandCourses(list, REAL_WEEKS, { termCode: '2026-2027-1' });
  eq(evs.length, 137);
  const dates = evs.map((e) => e.date).sort();
  eq(dates[0], '2026-09-08');
  eq(dates[dates.length - 1], '2027-01-01');
  for (const e of evs) {
    ok(/^\d{4}-\d{2}-\d{2}$/.test(e.date), `非法日期 ${e.date}`);
    ok(/^\d{2}:\d{2}$/.test(e.start) && /^\d{2}:\d{2}$/.test(e.end), `非法时间 ${e.start}~${e.end}`);
    ok(e.uid.startsWith('bistu-'), 'UID 格式');
  }
  eq(new Set(evs.map((e) => e.uid)).size, evs.length, 'UID 不得重复');
});

t('★ officefile: 同一门课无论从文件导入还是从接口抓取，UID 必须一致', () => {
  // 这是整个导入设计的地基：UID 只由「学期+课名+星期+节次+日期」决定，不含教师/教室。
  // 于是先上传文件、后来改成书签抓取（或反过来）时，日历里是**原地更新**而不是
  // 两套事件并存 —— 否则一个学期下来日历里每个格子都躺着两份。
  const fromApi = REAL.events.filter((e) => e.course === '军事理论').map((e) => `${e.date}|${e.uid}`);
  const fromFile = S.expandCourses(
    OF.gridToArrangedList(GRID_XLSX.courses.filter((c) => c.courseName === '军事理论')),
    REAL_WEEKS,
    { termCode: '2026-2027-1' },
  ).map((e) => `${e.date}|${e.uid}`);
  deepEq(fromFile.sort(), fromApi.sort());
});

t('officefile: 两种格式生成的 ics 都能被日历读', () => {
  for (const g of [GRID_XLSX, GRID_DOCX]) {
    const evs = S.expandCourses(OF.gridToArrangedList(g.courses), REAL_WEEKS, { termCode: '2026-2027-1' });
    const ics = S.buildIcal(evs, { calendarName: '仰山课表' });
    eq((ics.match(/BEGIN:VEVENT/g) || []).length, evs.length);
    ok(!/[^\r]\n/.test(ics), '存在裸 LF');
  }
});

// ================================================================ 8. 文件导入的「补周历」与粘贴文本
//
// 教务导出的 Excel / Word（以及一张截图）里**只有周次，没有学期起始日**。
// 这一节钉住的就是"用户补一次『今天在第几周』之后，能不能把日期算对"。

t('officefile: 「今天在第几周」反推第 1 周的星期一', () => {
  // 真数据：2026-10-09（周五）是第 5 周，第 1 周的星期一就是 2026-09-07。
  eq(OF.termStartFromWeek(5, '2026-10-09'), '2026-09-07');
  eq(OF.termStartFromWeek(1, '2026-10-09'), '2026-10-05');
  // 星期几与第几周必须解耦：同一周里任何一天都推出同一个星期一
  for (const d of ['2026-10-05', '2026-10-08', '2026-10-11']) {
    eq(OF.termStartFromWeek(5, d), '2026-09-07', `从 ${d} 反推`);
  }
});

t('★ officefile: 生成的周历与教务系统接口给的 19 周逐条一致', () => {
  const weeks = OF.makeTermWeeks('2026-09-07', 19);
  eq(weeks.length, 19);
  deepEq(weeks.map((w) => `${w.serialNumber}|${w.startDate}|${w.endDate}`),
    REAL_WEEKS.map((w) => `${w.serialNumber}|${w.startDate}|${w.endDate}`));
});

t('officefile: 学期名 → 学期代码', () => {
  eq(OF.termCodeFromName('2026-2027学年 第一学期'), '2026-2027-1');
  eq(OF.termCodeFromName('2026-2027 学年 第二学期'), '2026-2027-2');
  eq(OF.termCodeFromName('随便什么'), '');
});

t('officefile: 周历至少 20 周，课表里有更靠后的周次就跟着加长', () => {
  eq(OF.maxWeekUsed(GRID_XLSX.courses, GRID_XLSX.unscheduled), 17);
  eq(OF.makeTermWeeks('2026-09-07', Math.max(20, OF.maxWeekUsed(GRID_XLSX.courses, GRID_XLSX.unscheduled))).length, 20);
  eq(OF.makeTermWeeks('2026-09-07', 25).length, 25);
});

t('★★ officefile: 只补一个「第几周」，文件导入就能复现接口抓取的全部 137 节课', () => {
  // 这是整条"上传文件"路径的验收线：用户不需要做任何别的事。
  const pack = OF.packFromGrid(GRID_XLSX, { anchorWeek: 5, today: '2026-10-09' });
  eq(pack.kind, 'schedule');
  eq(pack.source, 'office');
  eq(pack.termCode, '2026-2027-1');
  eq(pack.studentCode, '2026000000');
  eq(pack.arrangedList.length, 25);
  eq(pack.unscheduled.length, 5);
  eq(pack.termWeeks.length, 20);
  eq(pack.termWeeks[0].startDate, '2026-09-07');
  eq(pack.events.length, 137);
  const dates = pack.events.map((e) => e.date).sort();
  eq(dates[0], '2026-09-08');
  eq(dates[dates.length - 1], '2027-01-01');

  // 与接口抓取那一份**逐条 UID 相同** —— 两条导入路径在日历里是同一条事件
  const key = (e) => `${e.date}|${e.start}|${e.end}|${e.course}|${e.uid}`;
  const apiKeys = new Set(REAL.events.map(key));
  const fileKeys = pack.events.map(key);

  // ★ 真数据发现：教务**导出的文件比接口还多 4 节课**。
  //   接口对「程序设计基础(C语言)B」只给了两段（'3-12周 第5-7节 汇贤堂' 与
  //   '13周 第5-6节 汇贤堂'），而导出的 Excel/Word 里还有第三段
  //   '14-17周 第5节-第7节 MLC-104'（换教室了）。两份数据是同一天取的，
  //   所以这不是时间差，而是接口的 arrangedList 本身少了一段。
  //   ⇒ 文件导入不是"降级替代方案"，它拿到的课表可能比接口更全。
  const missing = [...apiKeys].filter((k) => !fileKeys.includes(k));
  deepEq(missing, [], '文件里不该缺接口有的课');
  const extra = fileKeys.filter((k) => !apiKeys.has(k));
  eq(extra.length, 4, '文件应比接口多出 14-17 周那 4 节');
  for (const k of extra) ok(k.includes('程序设计基础'), `多出来的应该是程序设计基础: ${k}`);
  ok(extra.every((k) => /^2026-12-(07|14|21|28)/.test(k)), `多出来的应当是 12 月那 4 个周一: ${extra}`);
  eq(REAL.events.length, 133);
  eq(new Set(pack.events.map((e) => e.uid)).size, 137, 'UID 不得重复');
});

t('★ officefile: Word 版补同样的周历，产出与 Excel 版逐条相同', () => {
  const a = OF.packFromGrid(GRID_XLSX, { anchorWeek: 5, today: '2026-10-09' });
  const b = OF.packFromGrid(GRID_DOCX, { anchorWeek: 5, today: '2026-10-09' });
  const key = (e) => `${e.date}|${e.uid}`;
  deepEq(b.events.map(key).sort(), a.events.map(key).sort());
  deepEq(b.unscheduled.map((c) => c.courseName), a.unscheduled.map((c) => c.courseName));
});

t('officefile: 明确给了周历就不再用「第几周」推', () => {
  const pack = OF.packFromGrid(GRID_XLSX, { anchorWeek: 99, termWeeks: REAL_WEEKS, termCode: '2026-2027-1' });
  eq(pack.termWeeks.length, 19);
  eq(pack.termWeeks[0].startDate, '2026-09-07');
  eq(pack.events.length, 137);
});

t('officefile: 制表符粘贴文本 → 网格', () => {
  const text = [
    '2026-2027学年 第一学期 某同学[2026000000] 课表',
    '节次/星期\t星期一\t星期二\t星期三\t星期四\t星期五\t星期六\t星期日',
    '第1节\t数据结构[CS101]1-16周 某老师 第1节-第2节 A-101\t\t\t\t\t\t',
    '第3节\t\t操作系统[CS201]1-8周(双) 某老师 第3节-第4节 B-202\t\t\t\t\t',
    '教学班名称\t上课校区\t上课周次\t上课对象\t备注',
    '军训[UNIV161]-02\t天枢书院\t1-2周[实验]/某老师[主讲]\t\t',
  ].join('\n');
  ok(OF.looksLikeGridText(text));
  const g = OF.parseGridText(text);
  eq(g.termName, '2026-2027学年 第一学期');
  eq(g.studentCode, '2026000000');
  eq(g.courses.length, 2);
  const a = g.courses.find((c) => c.courseCode === 'CS101');
  eq(a.courseName, '数据结构');
  eq(a.dayOfWeek, 1);
  eq(a.placeName, 'A-101');
  deepEq(a.weeks, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  const b = g.courses.find((c) => c.courseCode === 'CS201');
  eq(b.dayOfWeek, 2);
  eq(b.beginSection, 3);
  deepEq(b.weeks, [2, 4, 6, 8]);
  eq(g.unscheduled.length, 1);
  eq(g.unscheduled[0].courseName, '军训');
});

t('officefile: 不像表格的文本给的是人话，而不是静默失败', () => {
  ok(!OF.looksLikeGridText('今天高数不上了'));
  throws(() => OF.parseGridText('今天高数不上了'), '应当抛错');
  let msg = '';
  try { OF.parseGridText('今天高数不上了'); } catch (e) { msg = e.message; }
  ok(/制表符/.test(msg), `提示要说清怎么复制: ${msg}`);
});

// ================================================================ 9. 编辑往返

// 用户要的「导入完成后还能手动改」不能靠「另写一套编辑逻辑」——
// 那必然和导入的解析规则走偏（UID 变了就等于日历里多出一份）。
// 做法是走**同一条路**：课表 → 网格 → 用户改 → 解析回课表。
// 所以这一节钉的是「这个往返是恒等的」。

t('officefile: weeksToRanges 把周次压成紧凑写法', () => {
  eq(OF.weeksToRanges([1, 2, 3, 5, 8, 9, 10]), '1-3,5,8-10周');
  eq(OF.weeksToRanges([4]), '4周');
  eq(OF.weeksToRanges([3, 1, 2, 2]), '1-3周', '要去重并排序');
  eq(OF.weeksToRanges([]), '');
  eq(OF.weeksToRanges([1, 3, 5]), '1,3,5周');
});

t('★ officefile: 课表 → 网格 → 解析回来，课程逐条不变', () => {
  const built = OF.gridFromCourses(GRID_XLSX.courses);
  const back = OF.parseScheduleGrid(built.rows);
  const key = (c) => [
    c.courseName, c.courseCode, c.dayOfWeek, c.beginSection, c.endSection,
    (c.weeks || []).slice().sort((a, b) => a - b).join(','), c.teacher, c.placeName,
  ].join('|');
  eq(back.courses.length, GRID_XLSX.courses.length, '往返后课程条数不能变');
  deepEq(back.courses.map(key).sort(), GRID_XLSX.courses.map(key).sort());
});

t('★ officefile: 编辑往返后事件 UID 完全一致（日历里原地更新，不新增）', () => {
  const before = OF.packFromGrid(GRID_XLSX, { termWeeks: REAL_WEEKS, termCode: '2026-2027-1' });
  const back = OF.parseScheduleGrid(OF.gridFromCourses(before.arrangedList).rows);
  const after = OF.packFromGrid(back, { termWeeks: REAL_WEEKS, termCode: '2026-2027-1' });
  eq(after.events.length, before.events.length);
  deepEq(after.events.map((e) => e.uid).sort(), before.events.map((e) => e.uid).sort());
});

t('★ officefile: 从抓取结果编辑往返，教师名不会丢', () => {
  // 抓取来的 arrangedList **不单列 teacher**，教师藏在 `weeksAndTeachers`
  // （'3-14周[讲授]/某老师'）里。编辑一次就抹掉所有老师名字是很难看出来的回归。
  const before = OF.packFromGrid(GRID_XLSX, { termWeeks: REAL_WEEKS, termCode: '2026-2027-1' });
  ok(before.arrangedList.every((c) => c.teacher === undefined), '前提：arrangedList 里没有独立 teacher 字段');
  const back = OF.parseScheduleGrid(OF.gridFromCourses(before.arrangedList).rows);
  eq(back.courses.length, before.arrangedList.length);
  eq(back.courses.find((c) => c.courseCode === 'MARX102').teacher, '某老师');
  ok(back.courses.every((c) => c.teacher), '每门课都该带上教师名');
});

t('★ officefile: 改教室/改老师后往返，UID 仍然不变（只更新，不重复）', () => {
  const before = OF.packFromGrid(GRID_XLSX, { termWeeks: REAL_WEEKS, termCode: '2026-2027-1' });
  const edited = before.arrangedList.map((c) => (
    c.placeName ? { ...c, placeName: '新教室-999', teacher: '新老师' } : c
  ));
  const after = OF.packFromGrid(
    OF.parseScheduleGrid(OF.gridFromCourses(edited).rows),
    { termWeeks: REAL_WEEKS, termCode: '2026-2027-1' },
  );
  deepEq(after.events.map((e) => e.uid).sort(), before.events.map((e) => e.uid).sort());
  ok(after.events.some((e) => /新教室-999/.test(e.location || '')), '改的地点要真的生效');
});

t('officefile: 没有课程代码时编一个稳定的（编也不会造成重复事件）', () => {
  const one = [{
    courseName: '某门没代码的课', courseCode: '', dayOfWeek: 3,
    beginSection: 1, endSection: 2, weeks: [1, 2, 3], teacher: '某老师', placeName: 'A-101',
  }];
  const a = OF.gridFromCourses(one);
  const b = OF.gridFromCourses(one);
  eq(JSON.stringify(a.rows), JSON.stringify(b.rows), '同一输入必须给出同一代码');
  const back = OF.parseScheduleGrid(a.rows);
  eq(back.courses.length, 1);
  eq(back.courses[0].courseName, '某门没代码的课');
  ok(/^ZZ/.test(back.courses[0].courseCode), `实际: ${back.courses[0].courseCode}`);
  eq(back.courses[0].teacher, '某老师');
  eq(back.courses[0].placeName, 'A-101');
  deepEq(back.courses[0].weeks, [1, 2, 3]);
});

t('officefile: 同一格里的两门不同课不会被张冠李戴', () => {
  const two = [
    { courseName: '上半学期的课', courseCode: 'AAA101', dayOfWeek: 1, beginSection: 1, endSection: 2, weeks: [1, 2, 3, 4], teacher: '甲', placeName: 'A-1' },
    { courseName: '下半学期的课', courseCode: 'BBB202', dayOfWeek: 1, beginSection: 1, endSection: 2, weeks: [5, 6, 7, 8], teacher: '乙', placeName: 'B-2' },
  ];
  const back = OF.parseScheduleGrid(OF.gridFromCourses(two).rows);
  eq(back.courses.length, 2);
  const a = back.courses.find((c) => c.courseCode === 'AAA101');
  const b = back.courses.find((c) => c.courseCode === 'BBB202');
  eq(a.courseName, '上半学期的课');
  deepEq(a.weeks, [1, 2, 3, 4]);
  eq(b.courseName, '下半学期的课');
  deepEq(b.weeks, [5, 6, 7, 8]);
});

t('officefile: 同一门课的两段周次并进一格，不会被拆成两门', () => {
  const two = [
    { courseName: '分两段的课', courseCode: 'CCC303', dayOfWeek: 2, beginSection: 3, endSection: 4, weeks: [1, 2, 3], teacher: '丙', placeName: 'C-3' },
    { courseName: '分两段的课', courseCode: 'CCC303', dayOfWeek: 2, beginSection: 3, endSection: 4, weeks: [9, 10], teacher: '丙', placeName: 'D-4' },
  ];
  const built = OF.gridFromCourses(two);
  eq(built.blocks, 1, '同一天同一节同一门课应当并成一个块');
  const back = OF.parseScheduleGrid(built.rows);
  eq(back.courses.length, 2, '两段时间各自是一条记录');
  eq(back.courses[0].courseName, '分两段的课');
  deepEq(back.courses.map((c) => c.weeks.join(',')).sort(), ['1,2,3', '9,10']);
  eq(back.courses.find((c) => c.weeks[0] === 9).placeName, 'D-4');
});

t('officefile: 网格给满 14 行，节次号与行号对得上', () => {
  const built = OF.gridFromCourses([], { minSections: 14 });
  eq(built.sections, 14);
  eq(built.rows.length, 15, '表头 1 行 + 14 个节次行');
  eq(built.rows[1][0], '第1节');
  eq(built.rows[14][0], '第14节');
  eq(built.rows[0].length, 8, '表头 = 节次列 + 7 天');
});

// ================================================================ 10. 课表截图（OCR）
const OCR = await load('core/ocrgrid.mjs');

// TSV 有 12 列：level, page, block, par, line, word, left, top, width, height, conf, text
function tsvWord(block, line, word, left, top, w, h, text, conf = 90) {
  return [5, 1, block, 1, line, word, left, top, w, h, conf, text].join('\t');
}
function tsvOf(...lines) {
  return [[1, 1, 0, 0, 0, 0, 0, 0, 500, 700, -1, ''],
    ...lines.flat()].map((f) => (Array.isArray(f) ? f.join('\t') : f)).join('\n');
}

// 一张手写的迷你课表：4 天 × 3 节，列心 100/200/300/400，节次带心 70/190/310。
// 坐标全是编的，但**形状**和真 tesseract 输出一样：中文按字切碎、教室编号单独一个词。
function miniTsv() {
  const head = [
    tsvWord(1, 1, 1, 80, 20, 40, 20, '星期'),
    tsvWord(1, 1, 2, 110, 22, 12, 18, '一'),
    tsvWord(1, 2, 1, 180, 20, 40, 20, '星期'),
    tsvWord(1, 2, 2, 210, 22, 12, 18, '二'),
    tsvWord(1, 3, 1, 280, 20, 40, 20, '星期'),
    tsvWord(1, 3, 2, 310, 22, 12, 18, '三'),
    tsvWord(1, 4, 1, 380, 20, 40, 20, '星期'),
    tsvWord(1, 4, 2, 410, 22, 12, 18, '四'),
  ];
  const secs = [
    [1, 90], [2, 310], [3, 530],
  ].flatMap(([n, top], i) => [
    // 块号故意离课程块（3、4）远一点：同一个 (block,par,line) 会被拼成一行，
    // 节次标签和课程文字共用一个块号的话，会拼出「第 1 节 语 文」这种行。
    tsvWord(20 + i, 1, 1, 10, top, 16, 20, '第'),
    tsvWord(20 + i, 1, 2, 28, top - 4, 10, 26, String(n)),
    tsvWord(20 + i, 1, 3, 40, top, 16, 20, '节'),
  ]);
  // 星期二 · 第1节：两个字的课名 + 教室 + 1-2节 + 1-16周
  // 课程块的 top 必须落在 bandTop（= 表头下沿 40）之下，否则会被当表头丢掉。
  const c1 = [
    tsvWord(3, 1, 1, 160, 55, 18, 20, '语'),
    tsvWord(3, 1, 2, 180, 55, 18, 20, '文'),
    tsvWord(3, 2, 1, 160, 80, 50, 16, 'A-101'),
    tsvWord(3, 3, 1, 160, 105, 34, 16, '1-2'),
    tsvWord(3, 3, 2, 196, 105, 16, 18, '节'),
    tsvWord(3, 4, 1, 160, 130, 42, 16, '1-16'),
    tsvWord(3, 4, 2, 204, 130, 16, 18, '周'),
  ];
  // 星期三 · 第2节：课名带括号字母（大学体育(1) 这种），教室是纯中文场地
  const c2 = [
    tsvWord(4, 1, 1, 260, 225, 18, 20, '高'),
    tsvWord(4, 1, 2, 280, 225, 18, 20, '数'),
    tsvWord(4, 1, 3, 300, 225, 34, 20, '(1)'),
    tsvWord(4, 2, 1, 260, 250, 52, 18, '体育馆'),
    tsvWord(4, 3, 1, 260, 275, 34, 16, '3-4'),
    tsvWord(4, 3, 2, 296, 275, 16, 18, '节'),
    tsvWord(4, 4, 1, 260, 300, 42, 16, '1-16'),
    tsvWord(4, 4, 2, 304, 300, 16, 18, '周'),
  ];
  return tsvOf(head, secs, c1, c2);
}

t('ocr: parseOcrTsv 只认 level 5，页框从 level 1 取', () => {
  const r = OCR.parseOcrTsv(miniTsv());
  deepEq(r.page, { width: 500, height: 700 });
  ok(r.words.length >= 25, `词数 ${r.words.length}`);
  ok(r.words.every((w) => w.text && Number.isFinite(w.left)), '每个词都要有文字和坐标');
  // level 4 的 text 是空的（实测），所以绝不能让空词混进来
  ok(!r.words.some((w) => w.text === ''), '空词必须被丢掉');
});

t('ocr: 低置信度的词会被 minConf 挡掉', () => {
  const tsv = tsvOf([tsvWord(3, 1, 1, 160, 30, 18, 20, '语', 10), tsvWord(3, 1, 2, 180, 30, 18, 20, '文', 95)]);
  eq(OCR.parseOcrTsv(tsv).words.length, 1);
  eq(OCR.parseOcrTsv(tsv, { minConf: 0 }).words.length, 2);
});

t('ocr: 从「星期X」推出 7 列，步距正确', () => {
  const { lines } = OCR.parseOcrTsv(miniTsv());
  const cols = OCR.findDayColumns(lines);
  ok(cols, '应当认出列');
  eq(cols.length, 7);
  eq(cols[0].name, '星期一');
  eq(cols[1].center, 200, '星期二列心');
  eq(cols[3].center, 400, '星期四列心');
  eq(cols[6].center, 700, '星期日由步距外推');
  eq(cols[0].left, 50, '列边界取相邻列心中点');
  eq(cols[0].right, 150);
});

t('ocr: 只认出两三列时宁可不认，交给手动填课表', () => {
  const tsv = tsvOf([tsvWord(1, 1, 1, 80, 20, 40, 20, '星期'), tsvWord(1, 1, 2, 110, 22, 12, 18, '一')]);
  eq(OCR.findDayColumns(OCR.parseOcrTsv(tsv).lines), null);
});

t('ocr: 从「第N节」推出节次带，「08:30」这种时间不算节次', () => {
  const { lines } = OCR.parseOcrTsv(miniTsv());
  const cols = OCR.findDayColumns(lines);
  const bands = OCR.findSectionBands(lines, cols);
  ok(bands);
  eq(bands.length, 3);
  eq(bands.map((b) => b.section).join(','), '1,2,3');
  eq(bands[0].center, 99, '第1节中心');
  eq(bands[0].top, -11, '第一带的上界靠步距外推');
  eq(bands[1].top, 209, '带边界取相邻标签中心的中点');
  eq(bands[1].center, 319, '第2节中心');
});

t('ocr: 端到端 —— 碎词拼回格子，再变成课表', () => {
  const { rows, stats } = OCR.ocrToRows(miniTsv());
  eq(stats.columns, 7);
  eq(stats.sections, 3);
  eq(stats.courses, 2);
  deepEq(rows[0], ['节次/星期', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日']);
  eq(rows[1][0], '第1节');
  ok(rows[1][2].includes('语文'), `实际: ${rows[1][2]}`);
  ok(rows[1][2].includes('A-101'));
  ok(rows[1][2].includes('1-16周 第1节-第2节 A-101'), `实际: ${rows[1][2]}`);

  const g = OF.parseScheduleGrid(rows);
  eq(g.courses.length, 2);
  const a = g.courses.find((c) => c.courseName === '语文');
  eq(a.dayOfWeek, 2);
  eq(a.beginSection, 1);
  eq(a.endSection, 2);
  eq(a.placeName, 'A-101');
  deepEq(a.weeks, Array.from({ length: 16 }, (_, i) => i + 1));
  const b = g.courses.find((c) => c.courseName === '高数(1)');
  eq(b.dayOfWeek, 3);
  eq(b.beginSection, 3);
  eq(b.endSection, 4);
  eq(b.placeName, '体育馆', '纯中文场地名也要认出来，不能并进课名');
  deepEq(b.weeks, Array.from({ length: 16 }, (_, i) => i + 1));
});

// 四天表头 + 一个「第N节」标签，给下面几个小用例复用
function head4() {
  return [1, 2, 3, 4].flatMap((d) => [
    tsvWord(1, d, 1, 80 + (d - 1) * 100, 20, 40, 20, '星期'),
    tsvWord(1, d, 2, 110 + (d - 1) * 100, 22, 12, 18, '一二三四'[d - 1]),
  ]);
}
function secLabel(block, n, top) {
  return [
    tsvWord(block, 1, 1, 10, top, 16, 20, '第'),
    tsvWord(block, 1, 2, 28, top - 4, 10, 26, String(n)),
    tsvWord(block, 1, 3, 40, top, 16, 20, '节'),
  ];
}

t('ocr: ★ 教室编号的尾数字不许污染节次和周次', () => {
  // 踩过的坑：把整格文字先去掉空格再匹配，`ZXB-306` + `1-3节` 会粘成 `ZXB-3061-3节`，
  // 节次被读成第 3061 节、周次被读成 417 周。
  const tsv = tsvOf(head4(), secLabel(9, 1, 90), secLabel(10, 2, 310), secLabel(11, 3, 530),
    [tsvWord(3, 1, 1, 60, 55, 18, 20, '课'), tsvWord(3, 1, 2, 80, 55, 18, 20, '名'),
      tsvWord(3, 2, 1, 60, 80, 66, 16, 'ZXB-306'),
      tsvWord(3, 3, 1, 60, 105, 34, 16, '1-3'), tsvWord(3, 3, 2, 96, 105, 16, 18, '节'),
      tsvWord(3, 4, 1, 60, 130, 26, 16, '1-'), tsvWord(3, 5, 1, 60, 155, 26, 16, '16'),
      tsvWord(3, 5, 2, 90, 155, 16, 18, '周')]);
  const { rows } = OCR.ocrToRows(tsv);
  ok(/1-16周 第1节-第3节 ZXB-306/.test(rows[1][1]), `实际: ${rows[1][1]}`);
  const c = OF.parseScheduleGrid(rows).courses[0];
  eq(c.beginSection, 1);
  eq(c.endSection, 3);
  eq(c.placeName, 'ZXB-306');
  eq(c.weeks.length, 16);
});

t('ocr: 周次碎片拼接 —— 「4」+「17周」是 4-17，不是 417', () => {
  const tsv = tsvOf(head4(), secLabel(9, 1, 90), secLabel(10, 2, 310), secLabel(11, 3, 530),
    [tsvWord(3, 1, 1, 60, 55, 18, 20, '课'), tsvWord(3, 1, 2, 80, 55, 18, 20, '名'),
      tsvWord(3, 2, 1, 60, 80, 34, 16, '1-2'), tsvWord(3, 2, 2, 96, 80, 16, 18, '节'),
      tsvWord(3, 2, 3, 116, 80, 12, 16, '4'),
      tsvWord(3, 3, 1, 60, 105, 26, 16, '17'), tsvWord(3, 3, 2, 90, 105, 16, 18, '周')]);
  const { rows } = OCR.ocrToRows(tsv);
  ok(/4-17周/.test(rows[1][1]), `实际: ${rows[1][1]}`);
  deepEq(OF.parseScheduleGrid(rows).courses[0].weeks, [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
});

t('ocr: 同一格上下半学期两门课不会被并成一门', () => {
  const tsv = tsvOf(head4(), secLabel(9, 1, 90), secLabel(10, 2, 310), secLabel(11, 3, 530),
    [tsvWord(3, 1, 1, 60, 55, 18, 20, '甲'), tsvWord(3, 1, 2, 80, 55, 18, 20, '课'),
      tsvWord(3, 2, 1, 60, 80, 34, 16, '1-4'), tsvWord(3, 2, 2, 96, 80, 16, 18, '周')],
    [tsvWord(4, 1, 1, 60, 140, 18, 20, '乙'), tsvWord(4, 1, 2, 80, 140, 18, 20, '课'),
      tsvWord(4, 2, 1, 60, 165, 34, 16, '9-12'), tsvWord(4, 2, 2, 96, 165, 16, 18, '周')]);
  const { rows } = OCR.ocrToRows(tsv);
  eq((rows[1][1].match(/\[/g) || []).length, 2, '第1节那一格应当有两个课程块');
  const names = OF.parseScheduleGrid(rows).courses.map((c) => c.courseName).sort();
  deepEq(names, ['乙课', '甲课']);
});

t('ocr: 认不出表头时说人话，让人去走手动填课表', () => {
  let e = null;
  try {
    OCR.ocrToRows(tsvOf([tsvWord(1, 1, 1, 10, 10, 40, 20, '随便'), tsvWord(1, 1, 2, 60, 10, 40, 20, '什么')]),
      { minWords: 0 });
  } catch (err) { e = err; }
  ok(e, '应当抛错');
  ok(/认不出字|星期/.test(e.message), `实际: ${e.message}`);
});

t('ocr: 真·tesseract 输出（模拟课表截图）回归', () => {
  const tsv = readFileSync(join(ROOT, 'test/fixtures/ocr-mock.tsv'), 'utf8');
  const { rows, stats } = OCR.ocrToRows(tsv);
  deepEq(stats.page, { width: 780, height: 1800 });
  eq(stats.columns, 7);
  eq(stats.sections, 11);
  eq(stats.courses, 10);
  const g = OF.parseScheduleGrid(rows);
  eq(g.courses.length, 10);
  // OCR 会认错字，所以只钉**结构**：星期、节次、周次、地点这几样必须对
  const byName = (re) => g.courses.find((c) => re.test(c.courseName));
  const history = byName(/中国近现代史/);
  eq(history.dayOfWeek, 1);
  eq(history.beginSection, 1);
  eq(history.endSection, 3);
  eq(history.placeName, 'ZXB-306');
  eq(history.weeks.length, 16);
  const cprog = byName(/程序设计基础/);
  eq(cprog.dayOfWeek, 1);
  eq(cprog.beginSection, 5);
  eq(cprog.endSection, 7);
  eq(cprog.placeName, '汇贤堂');
  deepEq(cprog.weeks, Array.from({ length: 15 }, (_, i) => i + 3));
  const eng = byName(/英语外刊/);
  eq(eng.dayOfWeek, 2);
  eq(eng.beginSection, 10);
  eq(eng.endSection, 12);
  eq(eng.placeName, 'ZXC-205');
  const sport = byName(/大学体育/);
  eq(sport.dayOfWeek, 4);
  eq(sport.beginSection, 1);
  eq(sport.endSection, 2);
  eq(sport.placeName, '体育馆');
  // 每一门都必须落在第 1~11 节、星期一~星期日之内
  ok(g.courses.every((c) => c.dayOfWeek >= 1 && c.dayOfWeek <= 7), '星期越界');
  ok(g.courses.every((c) => c.beginSection >= 1 && c.beginSection <= 11), '节次越界');
  ok(g.courses.every((c) => c.weeks && c.weeks.length), '每门课都要有周次');
});

t('ocr: OCR 出来的课表也能一路走到事件列表', () => {
  const tsv = readFileSync(join(ROOT, 'test/fixtures/ocr-mock.tsv'), 'utf8');
  const { rows } = OCR.ocrToRows(tsv);
  const packed = OF.packFromGrid(OF.parseScheduleGrid(rows), {
    anchorWeek: 5, today: '2026-10-09', termCode: '2026-2027-1',
  });
  ok(packed.events.length > 0, '必须有事件');
  eq(packed.termWeeks[0].startDate, '2026-09-07');
  ok(packed.events.every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date)), '日期必须是干净的 YYYY-MM-DD');
  const uids = new Set(packed.events.map((e) => e.uid));
  eq(uids.size, packed.events.length, 'UID 不能重复');
});



// ================================================================
// 0c. 安全 / 本地存储 / CI 的回归护栏
// 这一组全是「已经踩过一次，不想再踩」的东西：备份会把密钥带出去、
// 存储配额撑爆会静默丢数据、CI 能被一个旧 tag 把线上站点回滚。

t('备份文件里绝不能出现 API Key', () => {
  const text = M.serializeBackup({
    settings: { aiApiKey: 'sk-SECRET-123', theme: 'dark', aiModel: 'deepseek-flash' },
    todos: [],
  });
  ok(!text.includes('sk-SECRET-123'), '备份里不能带 aiApiKey —— 备份天生是要发给别人的');
  ok(!/"aiApiKey"\s*:/.test(text), '连字段名都不该出现，免得有人以为里面真有 key');
  ok(text.includes('deepseek-flash') && text.includes('dark'), '其它设置必须照常保留');
});

t('恢复备份时保留本机的 API Key', () => {
  const app = readFileSync(join(ROOT, 'web/app.js'), 'utf8');
  ok(
    /aiApiKey:\s*state\.settings\.aiApiKey\s*\|\|\s*''/.test(app),
    '恢复备份要把本机已有的 key 抄回来，否则用户恢复一次备份就得重填 key',
  );
});

t('助手附件的持久化上限必须小于 localStorage 总预算', () => {
  const app = readFileSync(join(ROOT, 'web/app.js'), 'utf8');
  const num = (name) => {
    const m = app.match(new RegExp(`const ${name} = ([0-9_]+);`));
    ok(m, `找不到常量 ${name}`);
    return Number(m[1].replace(/_/g, ''));
  };
  const budget = num('MAX_STATE_CHARS');
  const perAttachment = num('MAX_PERSISTED_ASSISTANT_IMAGE_BYTES');
  ok(perAttachment < budget, `单个附件(${perAttachment})不能吃掉整个预算(${budget})`);
  ok(budget <= 2_400_000, 'Chrome 的 5MB 配额按 UTF-16 字节算，字符预算不能超过 240 万');
  ok(/function trimStateForStorage\(/.test(app), '必须有按体积淘汰的实现');
  const save = app.slice(app.indexOf('function saveState()'));
  ok(/trimStateForStorage\(/.test(save.slice(0, 900)), 'saveState 必须先淘汰再写');
  ok(save.indexOf('trimStateForStorage(') < save.indexOf('setItem('), '淘汰必须发生在写入之前');
  ok(/if \(json\.length > MAX_STATE_CHARS\)/.test(save), '只在超出预算时才重算 JSON，平时一次 stringify');
  ok(/QuotaExceededError/.test(save.slice(0, 1500)), '写失败要能分辨「配额满」，并明确告诉用户这次没存上');
});

t('附件图片被配额裁掉时必须留下说明', () => {
  const app = readFileSync(join(ROOT, 'web/app.js'), 'utf8');
  ok(/note:\s*missing > 0/.test(app), 'persistAssistantAttachment 要记录少了几页图片');
  ok(/attachment\.note/.test(app), 'assistantApiMessage 要把这句说明带给模型，否则它会以为看全了');
});

t('模型不收图片时必须退回纯文字再试，而不是让整个提问直接失败', () => {
  const app = readFileSync(join(ROOT, 'web/app.js'), 'utf8');
  ok(app.includes('const sendOnce ='), '请求要抽成可重发的 sendOnce');
  ok(/result\.status === 400 \|\| result\.status === 422/.test(app), '只在 400/422（参数不合法）时重试；401/429 重发没意义');
  ok(/const retry = await sendOnce\(textOnly\)/.test(app), '重试必须发纯文字版');
  ok(app.includes('不接受图片输入'), '退回纯文字时要告诉用户，不能悄悄降级');
});

t('.gitignore 必须挡住自检产物与发版 zip', () => {
  const lines = readFileSync(join(ROOT, '.gitignore'), 'utf8').split('\n').map((x) => x.trim());
  for (const line of [
    'shells/windows/.selfcheck-data/',
    'shells/windows/selfcheck-build-report.txt',
    'shells/windows/YangShanShell-*.zip',
  ]) {
    ok(lines.includes(line), `.gitignore 缺少 ${line}`);
  }
});

t('CI 只能在分支上部署 Pages，且默认只读', () => {
  const yml = readFileSync(join(ROOT, '.github/workflows/pages.yml'), 'utf8');
  const head = yml.slice(0, yml.indexOf('\njobs:'));
  ok(/contents:\s*read/.test(head), 'workflow 级默认权限应是只读');
  ok(!/contents:\s*write/.test(head), '写权限必须下放到具体 job，不能写在 workflow 级');
  const deploy = yml.slice(yml.indexOf('\n  deploy:'), yml.indexOf('\n  release:'));
  ok(
    /if:\s*github\.ref_type == 'branch'/.test(deploy),
    'deploy 必须限定在分支上 —— 打一个指向旧提交的 tag 会把线上站点回滚',
  );
  ok(/pages:\s*write/.test(deploy) && /id-token:\s*write/.test(deploy), 'deploy 需要 pages / id-token 写权限');
  const build = yml.slice(yml.indexOf('\n  build:'), yml.indexOf('\n  deploy:'));
  ok(!/permissions:/.test(build), 'build job 不该单独要权限');
});

t('安卓抓取失败的结果不能被「已取消」覆盖', () => {
  const src = readFileSync(
    join(ROOT, 'shells/android/app/src/main/java/dev/yangshan/schedule/SchoolActivity.kt'),
    'utf8',
  );
  const onFailed = src.slice(src.indexOf('override fun onFailed'), src.indexOf('private fun shareDiagnostics'));
  // 注释里也会出现这些词，先把 // 注释行去掉再比顺序。
  const code = onFailed.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  ok(/done\s*=\s*true/.test(code), 'onFailed 必须把 done 置真，否则返回键会用「已取消」覆盖真实原因');
  ok(code.indexOf('done = true') < code.indexOf('setResult'), 'done 要在 setResult 之前置真');
  const close = src.slice(src.indexOf('private fun closeWithFailure'), src.indexOf('@Deprecated'));
  ok(/if \(!done\)[\s\S]*school\.cancel\(\)/.test(close), '只有用户主动返回时才去 cancel');
});

t('后台刷新不得清空诊断日志', () => {
  const src = readFileSync(
    join(ROOT, 'shells/android/app/src/main/java/dev/yangshan/schedule/DiagLog.kt'),
    'utf8',
  );
  const begin = src.slice(src.indexOf('fun begin('), src.indexOf('fun event('));
  ok(/clear\s*=\s*interactive/.test(begin), '只有用户主动发起的那次才能清空 —— 后台每小时一次会把失败原因覆盖掉');
});

t('UA 里的版本号必须来自 BuildConfig，不能手写', () => {
  const src = readFileSync(
    join(ROOT, 'shells/android/app/src/main/java/dev/yangshan/schedule/SchoolWeb.kt'),
    'utf8',
  );
  ok(src.includes('YangShanShell/${BuildConfig.VERSION_NAME}'), 'UA 版本号要从 BuildConfig 取');
  ok(!/YangShanShell\/\d+\.\d+\.\d+/.test(src), '不能手写版本号 —— 写死过 0.2.0，而全局那时是 0.1.9');
});

t('README 必须把所有联网出口都写出来（公告源 + 智能助手），不能只说一半', () => {
  const md = readFileSync(join(ROOT, 'README.md'), 'utf8');
  // 联网出口只有两处：默认开启的公告源、用户主动使用的智能助手。两者写在同一条里，
  // 否则「没有服务器」「唯一的联网功能」都会变成误导 —— 内置公告源是默认就会发请求的。
  ok(/联网只有两处/.test(md), 'README 必须把联网出口数清楚，不能只说其中一个');
  ok(/公告源/.test(md) && /data\/announcements\.json/.test(md), '要写清默认拉哪个公告 JSON');
  ok(/纯 GET/.test(md), '要说明拉公告是只读的、不带本机数据');
  ok(/api\.deepseek\.com/.test(md), '要写清助手默认发给谁');
  ok(/settingsForBackup/.test(md), '要写清备份里会剔掉 Key');
  ok(!/智能助手：唯一的联网功能/.test(md), '内置公告源默认就会联网，再说「唯一」就是假话');
  ok(!/课表和账号密码永远不离开你自己的设备/.test(md), '「永远不离开」是错的 —— 助手会把材料发出去');
});

t('API 地址只接受 https（本机除外），免得 Key 明文上网', () => {
  const app = readFileSync(join(ROOT, 'web/app.js'), 'utf8');
  ok(/只能用 https:\/\/ 地址/.test(app), 'http:// 会把 Bearer Key 明文发出去，必须拦掉');
  ok(app.includes('localhost|127\\.0\\.0\\.1'), '本机 localhost 要留例外，方便本地调试');
});

// ================================================================
// 0d. 2026-10-18 审查出来的 18 项缺陷的回归护栏

t('PDF worker 必须随仓库一起发出去，缺了要当场说清楚', () => {
  const worker = join(ROOT, 'vendor/pdfjs/pdf.worker.min.mjs');
  ok(existsSync(worker), 'vendor/pdfjs/pdf.worker.min.mjs 必须存在且入库 —— 它不在，CI 的构建会直接 ENOENT');
  const build = readFileSync(join(ROOT, 'web/build.mjs'), 'utf8');
  ok(/pdf\.worker\.min\.mjs/.test(build), 'build.mjs 要读它');
  ok(/必须入库/.test(build), '缺失时的报错要说明「它必须入库」，否则下一个人只会看到一句 ENOENT');
});

t('托管版不再把 1.24 MB 的 worker 塞进首页', () => {
  const build = readFileSync(join(ROOT, 'web/build.mjs'), 'utf8');
  ok(build.includes('pdfjs-worker-url'), '托管版要用外链占位符，让 worker 按需取');
  ok(/writeFileSync\(join\(DIST, 'site', PDF_WORKER_FILE\)/.test(build), 'worker 要单独写成 dist/site 下的文件');
  const app = readFileSync(join(ROOT, 'web/app.js'), 'utf8');
  ok(app.includes("$('pdfjs-worker-url')"), '前端要优先用外链，单文件版才回落到内联 blob');
});

t('手动改过的课表条目，重新导入后不能悄悄失效', () => {
  const app = readFileSync(join(ROOT, 'web/app.js'), 'utf8');
  ok(app.includes('function entryContentKey('), '要有「不含 courseId」的内容指纹，用来认老记录');
  ok(app.includes('function findChangeTargetIndex('), '查找修改目标时要能按内容回退，不然老记录 findIndex 全落空');
  ok(app.includes('function scheduleChangeStats('), '要能统计「N 条修改里几条真的生效了」');
  ok(/条修改里有/.test(app), '落空时必须告诉用户，不能只说「已保留 N 条修改」');
  const sched = readFileSync(join(ROOT, 'core/schedule.mjs'), 'utf8');
  const seed = sched.slice(sched.indexOf('course.courseId || fnv1a64(['));
  const fields = seed.slice(0, seed.indexOf('])'));
  for (const key of ['termCode', 'courseCode', 'courseName', 'classNo', 'teachingTarget', 'dayOfWeek', 'beginSection', 'endSection', 'week']) {
    ok(fields.includes(key), `courseId 的字段集必须与老 __ysEntryId 一致（缺 ${key}，两边就永远对不上）`);
  }
});

t('备份默认不带助手对话，明确勾选才带', () => {
  const state = {
    settings: { aiApiKey: 'sk-SECRET-123', theme: 'dark' },
    todos: [],
    assistantHistory: [{ id: 'h1', title: '我的成绩单', messages: [{ role: 'user', text: '机密问题ABC' }] }],
    assistantCurrent: { id: 'c1', messages: [{ role: 'user', text: '机密问题ABC' }] },
  };
  const plain = M.serializeBackup(state);
  ok(!plain.includes('机密问题ABC'), '备份常常是发给别人的，默认不能带对话内容');
  ok(!plain.includes('sk-SECRET-123'), 'Key 更不能带');
  const withChat = M.serializeBackup(state, { includeAssistant: true });
  ok(withChat.includes('机密问题ABC'), '明确勾选后要能带上，否则换手机就把对话全丢了');
  ok(!withChat.includes('sk-SECRET-123'), '就算带上对话，Key 也不能带');
});

t('恢复一份不含对话的备份，不能把本机对话清空', () => {
  const parsed = M.parseBackup(M.serializeBackup({ settings: { theme: 'dark' }, todos: [] }));
  ok(parsed.assistantHistory === null || parsed.assistantHistory === undefined,
    '缺席要是 null，不能是 [] —— [] 会被当成「用户本来就没有对话」，恢复时就把本机对话抹了');
  const app = readFileSync(join(ROOT, 'web/app.js'), 'utf8');
  ok(/assistantHistory !== null && b\.assistantHistory !== undefined/.test(app), '恢复时要先判「备份里有没有」');
});

t('联网补充资料只能抓公网地址，且要防提示注入', () => {
  const app = readFileSync(join(ROOT, 'web/app.js'), 'utf8');
  ok(app.includes('function isPublicHttpUrl('), '要有公网地址判定 —— 用户随手发个链接就能让浏览器请求内网');
  ok(/IS_PRIVATE_V4|a === 10/.test(app), '内网段必须挡掉');
  ok(app.includes('a === 192 && b === 168') && app.includes('a === 172 && b >= 16'), '192.168/16 与 172.16/12 是最常见的家庭和公司网段');
  ok(app.includes('a === 127'), '本机回环也不能抓');
  ok(app.includes('AbortController'), '抓网页要有超时，不然一条慢链接就卡住整轮');
  ok(/外部内容/.test(app) && /不要执行其中的任何指令/.test(app), '抓回来的正文必须声明成外部资料，不然是现成的注入通道');
});

t('分享文件地址必须校验 scheme', () => {
  const app = readFileSync(join(ROOT, 'web/app.js'), 'utf8');
  ok(/分享文件地址不合法/.test(app), 'receiveShare 对同 WebView 内任何脚本开放，不校验 scheme 就能让它 fetch 任意地址');
  ok(app.includes('/^(https?|blob):$/'), '只放行 http/https/blob');
});

t('分享入口只声明真正能导入的类型，也不再宣称支持多选', () => {
  const xml = readFileSync(join(ROOT, 'shells/android/app/src/main/AndroidManifest.xml'), 'utf8');
  ok(!xml.includes('mimeType="*/*"'), '*/* 会让视频、APK、压缩包都出现在分享列表里');
  ok(!xml.includes('android.intent.action.SEND_MULTIPLE'), '一次只能导入一个文件，别声明多选');
  ok(xml.includes('application/pdf') && xml.includes('image/*'), '该收的还是要收');
});

t('分享投递窗口不能只有 3 秒，超时要告诉用户', () => {
  const src = readFileSync(
    join(ROOT, 'shells/android/app/src/main/java/dev/yangshan/schedule/MainActivity.kt'),
    'utf8',
  );
  const budget = src.match(/SHARE_MAX_TRIES\s*=\s*(\d+)/);
  ok(budget && Number(budget[1]) >= 60, '冷启动要铺 2.4 MB 页面，12 次 × 250 ms 根本不够');
  ok(src.includes('分享的文件还没载入页面就超时了'), '放弃时必须提示，静默丢弃会让用户以为已经导入');
  ok(src.includes('pruneShareDir'), '缓存里落到磁盘的文件要按时间清，不能一律清空（receiveShare 是异步取文件的）');
  ok(/cleaned\.any \{ it != '\.' \}/.test(src), '「..」这类纯点名不能放行');
});

t('前台服务被拉起后必须真的调过 startForeground', () => {
  const src = readFileSync(
    join(ROOT, 'shells/android/app/src/main/java/dev/yangshan/schedule/AnnPushService.kt'),
    'utf8',
  );
  const onCreate = src.slice(src.indexOf('override fun onCreate()'), src.indexOf('override fun onStartCommand'));
  ok(!onCreate.includes('startForeground('), 'onCreate 里不能 startForeground：失败路径会一次都没调过就 stopSelf');
  const start = src.slice(src.indexOf('private fun startInForeground'), src.indexOf('@Synchronized'));
  ok(!/if \(!Notify\.notificationsEnabled\(this\)\) return false/.test(start),
    '通知被关掉时也要先调一次 startForeground 再撤掉，否则 Android 12+ 会抛 ForegroundServiceDidNotStartInTimeException');
  ok(start.includes('stopForeground(STOP_FOREGROUND_REMOVE)'), '调完要立刻撤掉前台身份');
});

t('诊断日志不能一条一条写盘', () => {
  const src = readFileSync(
    join(ROOT, 'shells/android/app/src/main/java/dev/yangshan/schedule/DiagLog.kt'),
    'utf8',
  );
  ok(src.includes('FLUSH_DELAY_MS'), '事件很密，每次读 48 KB 再拼再写会拖慢抓取');
  ok(src.includes('flushLocked'), '要攒批落盘');
  const exportFn = src.slice(src.indexOf('fun export('), src.indexOf('private fun appendLocked'));
  ok(exportFn.includes('flushLocked()'), '导出前必须先 flush，否则最后几条看不到');
});

t('控制台错误要留给 logcat', () => {
  const src = readFileSync(
    join(ROOT, 'shells/android/app/src/main/java/dev/yangshan/schedule/SchoolWeb.kt'),
    'utf8',
  );
  ok(!/onConsoleMessage[\s\S]{0,600}?return true\s*\n\s*\}/.test(src),
    '恒 return true 会把错误全吞掉，真机排查时会出现「控制台没报错」的假象');
});

t('密钥扫描器对第三方 vendor 代码不套用个人信息规则', () => {
  const src = readFileSync(join(ROOT, 'tools/check-secrets.mjs'), 'utf8');
  ok(src.includes('PERSONAL_RULES'), 'PDF.js 的 SHA-256 轮常量长得像十位学号，实测误报过');
  ok(src.includes("if (VENDOR_RE.test(rel) && PERSONAL_RULES.has(rule.name)) continue"),
    '凭据类规则照旧全扫，只有个人信息类对 vendor 免检');
  ok(src.includes('SKIP_PATHS'), '安卓 assets/index.html 是构建产物，会把 vendor 的误报再报一次');
});

t('两个壳的图标都来自同一张徽章图，且启动器蒙版不会裁到画面', () => {
  const res = 'shells/android/app/src/main/res';
  const manifest = readFileSync(join(ROOT, 'shells/android/app/src/main/AndroidManifest.xml'), 'utf8');
  ok(manifest.includes('android:icon="@mipmap/ic_launcher"'),
    '自适应图标只能是位图，走 mipmap；还指着 drawable 就说明用的是旧的矢量占位图');
  ok(manifest.includes('android:roundIcon="@mipmap/ic_launcher_round"'),
    '圆形蒙版启动器要单独给一份，否则会被裁成方块');

  const adaptive = readFileSync(join(ROOT, res, 'mipmap-anydpi-v26/ic_launcher.xml'), 'utf8');
  ok(adaptive.includes('@color/ic_launcher_background') && adaptive.includes('@mipmap/ic_launcher_foreground'),
    'API 26+ 走自适应图标：背景 + 前景两层'); 

  // 五个密度各三张，缺一张就会在某些机器上退化成系统默认图标
  for (const d of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
    for (const f of ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png']) {
      ok(existsSync(join(ROOT, res, `mipmap-${d}`, f)), `缺 ${d}/${f}`);
    }
  }

  // 前景图必须是正方形且四周留透明：画心只占 108dp 画布正中的 72dp 安全区，
  // 否则圆形/水滴蒙版会把徽章外圈切掉。
  const fg = readFileSync(join(ROOT, res, 'mipmap-xxxhdpi/ic_launcher_foreground.png'));
  ok(fg.subarray(1, 4).toString('latin1') === 'PNG', '前景图必须是 PNG');
  const fgW = fg.readUInt32BE(16);
  const fgH = fg.readUInt32BE(20);
  ok(fgW === 432 && fgH === 432, `xxxhdpi 前景图应是 108dp×4 = 432px，实测 ${fgW}x${fgH}`);

  const csproj = readFileSync(join(ROOT, 'shells/windows/YangShanShell.csproj'), 'utf8');
  ok(csproj.includes('<ApplicationIcon>app.ico</ApplicationIcon>'),
    '没有 ApplicationIcon，exe 就是 .NET 的默认图标');
  const icoPath = join(ROOT, 'shells/windows/app.ico');
  ok(existsSync(icoPath), 'app.ico 必须入库，否则换台机器构建出来的 exe 又没图标了');
  const ico = readFileSync(icoPath);
  ok(ico.readUInt16LE(0) === 0 && ico.readUInt16LE(2) === 1, 'app.ico 不是合法的 ICO 头');
  const icoCount = ico.readUInt16LE(4);
  ok(icoCount >= 8, `ico 里要多带几种尺寸（现在 ${icoCount} 种），只放一张 256 的话 16x16 会糊成一团`);

  const mainForm = readFileSync(join(ROOT, 'shells/windows/MainForm.cs'), 'utf8');
  ok(mainForm.includes('Icon.ExtractAssociatedIcon'),
    '窗口与托盘图标要从 exe 里取回来，不能写死系统默认图标');
  ok(!mainForm.includes('Icon = SystemIcons.Application'),
    '托盘图标写死 SystemIcons.Application 时，exe 换了图标托盘还是旧的');
});

t('管理页：没点「加入列表」也不会再提交一条空公告', () => {
  const admin = readFileSync(join(ROOT, 'web/admin/admin.js'), 'utf8');
  const pub = admin.slice(admin.indexOf('async function doPublish'), admin.indexOf('function pushNotify'));
  ok(pub.includes('if (!commitForm()) return;'),
    '发布时必须先把表单里还没入列表的内容补进列表，否则写好的公告不会被提交');
  ok(pub.indexOf('commitForm()') < pub.indexOf('writeRemote'),
    '补列表这一步必须发生在提交之前');
  ok(pub.includes('if (!list.length)'),
    '列表为空要拦住 —— 否则会提交「更新 0 条」的空提交，且因为列表为空连门铃都不发');
  ok(pub.indexOf('!list.length') < pub.indexOf('writeRemote'),
    '空列表检查必须发生在提交之前');
  ok(pub.includes('pushNotify()'), '发布成功后要顺手敲一声门铃');
  ok(pub.includes('但没有设推送频道'),
    '没设频道时必须明说「同学收不到提醒」，不然又是一次「发了但没人知道」');
  // 2026-10-18 真的踩过：连提交两条「更新 0 条」，公告没发出去、手机也没收到推送
  const live = JSON.parse(readFileSync(join(ROOT, 'data/announcements.json'), 'utf8'));
  ok(Array.isArray(live.announcements), '仓库里的公告文件必须是 { announcements: [...] } 结构');
});

t('管理页：草稿不会因为刷新页面或点「测试连接并读取」而丢', () => {
  const admin = readFileSync(join(ROOT, 'web/admin/admin.js'), 'utf8');
  ok(admin.includes("const LS_DRAFT = 'yangshan-admin/draft/v1'"), '草稿要落在本机，不然刷新就没了');
  const list = admin.slice(admin.indexOf('function renderList'), admin.indexOf('function resetForm'));
  ok(list.includes('saveDraft()'), '每次重画列表都要顺手存一份草稿（增删改都会重画）');
  ok(admin.includes('restoreDraft();'), '启动时要恢复上次没发布的草稿');
  const test = admin.slice(admin.indexOf('async function doTest'), admin.indexOf('// ---------------------------------------------------------------- 分享码'));
  ok(!/list = parsed\.list/.test(test),
    '「测试连接并读取」不能直接把本地列表覆盖成远端内容 —— 会把刚写好的公告冲掉');
  ok(test.includes('localOnly'), '读取远端后要把本机还没提交的公告并回去');
});

t('安卓签名必须能钉死在 local.properties 里的那把钥匙上（否则升级装不上）', () => {
  const gradle = readFileSync(join(ROOT, 'shells/android/app/build.gradle.kts'), 'utf8');
  ok(gradle.includes('signingConfigs'), '要在 signingConfigs 里覆盖 debug 签名，不能只靠默认的随机钥匙');
  ok(gradle.includes('yangshan.keystore'), '钥匙路径要从 local.properties 读，别写死在构建脚本里');
  ok(gradle.includes('storeFile = sharedKeystore'), '读到路径时要真的应用到 debug 签名配置上');
  ok(/reader\(Charsets\.UTF_8\)/.test(gradle),
    '要用 UTF-8 Reader 读 local.properties —— 默认的 load(InputStream) 会按 ISO-8859-1 读，中文路径变乱码');
  ok(gradle.includes('takeIf { it.exists() }'), '钥匙不存在时要能回落，别让换台机器直接构建失败');
  const ignores = readFileSync(join(ROOT, '.gitignore'), 'utf8');
  ok(ignores.includes('shells/android/local.properties'), 'local.properties 必须挡在仓库外（里面有钥匙路径）');
  ok(/^\*\.keystore$/m.test(ignores), '签名钥匙（*.keystore）永远不进货架：谁拿到它谁就能签官方包');
});

t('Windows 对外发的是「解压即用」的便携包，不是安装器', () => {
  const doc = readFileSync(join(ROOT, 'shells/README.md'), 'utf8');
  const sec = doc.slice(doc.indexOf('### 便携版打包'), doc.indexOf('### 自检'));
  ok(sec.length > 200, 'shells/README.md 要有「便携版打包」一节，写清对外发什么');
  ok(sec.includes('--self-contained true'), '便携包必须自带 .NET 运行时，否则目标机双击打不开');
  ok(sec.includes('-p:RestoreSources'), '要写清 RestoreSources 覆盖 NuGet.config 的 <clear />，否则报 NU1101');
  ok(!/PublishTrimmed=true/.test(sec), 'WinForms 不能裁剪');
  ok(sec.includes('%LOCALAPPDATA%\\YangShanSchedule'), '要说清数据不在程序目录（解压到 U 盘也能跑）');
  ok(sec.includes('WebView2'), '自包含只解决 .NET，WebView2 仍是系统组件，必须写明');
});

const total = pass + failures.length;
console.log('');
if (failures.length) {
  console.log(`✗ ${failures.length}/${total} 个用例失败\n`);
  for (const f of failures) console.log(`  ✗ ${f.name}\n    ${f.error.message}\n`);
} else {
  console.log(`✓ 全部通过`);
}
console.log(`  tests ${total}  pass ${pass}  fail ${failures.length}`);
process.exit(failures.length ? 1 : 0);
