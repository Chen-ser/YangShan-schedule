// 仰山课表 · 真实数据预览页生成器
//
// 用途：把一份**原始抓取结果**（书签小工具存下来的那种 JSON）塞进构建产物里，
// 生成 dist/_real.html。打开它看到的就是"用户导入自己课表之后"的样子。
//
//   node web/preview.mjs [fixture 路径] [输出路径]
//
// 为什么要有它：
//   1. 单文件产物里的导入入口是 textarea，自动化验证（无头截图）没法往里打字；
//      __YS_PACK__ 是壳的正式交付通道，这里复用它，顺带把通道本身也测了。
//   2. 改完布局想立刻看真数据的效果，不用每次手动粘贴 28KB 的 JSON。
//
// 生成的 _real.html 是临时产物，不进仓库（.gitignore 已排除 dist/ 下的 _ 开头文件）。

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const fixturePath = process.argv[2] || join(ROOT, 'test/fixtures/raw-2026-2027-1.json');
const outPath = process.argv[3] || join(ROOT, 'dist/_real.html');
const bundlePath = join(ROOT, 'dist/仰山课表.html');

for (const [label, p] of [['fixture', fixturePath], ['构建产物', bundlePath]]) {
  if (!existsSync(p)) {
    console.error(
      label === '构建产物'
        ? `找不到 ${p}，先跑 node web/build.mjs`
        : `找不到 ${p}`
    );
    process.exit(1);
  }
}

const pack = JSON.parse(readFileSync(fixturePath, 'utf8'));
let html = readFileSync(bundlePath, 'utf8');

// 注入点：<head> 之后。必须早于页面末尾的 main() 执行，否则 __YS_PACK__ 来不及被取用。
const MARK = '<head>';
const idx = html.indexOf(MARK);
if (idx < 0) {
  console.error('构建产物里找不到 <head>，注入点失效');
  process.exit(1);
}

// JSON.stringify 的结果里可能含 </script>（课表字段是 HTML 片段，理论上会出现），
// 按 HTML 规范必须打断，否则会提前闭合脚本标签。
const payload = JSON.stringify(pack).replace(/<\//g, '<\\/');
const inject = `${MARK}\n<script>window.__YS_PACK__ = ${payload};</script>`;

html = html.slice(0, idx) + inject + html.slice(idx + MARK.length);
writeFileSync(outPath, html, 'utf8');

const courses = pack.scheduleDetail?.datas?.arrangedList?.length ?? 0;
console.log(`✓ 已生成 ${outPath}`);
console.log(`  数据来源 ${fixturePath}`);
console.log(`  课程条目 ${courses} 条`);

// 顺带生成窄屏探针页。
// 为什么要 iframe：Windows 上 --headless=new 会创建真窗口、有约 500px 最小宽度，
// 直接 --window-size=390,800 拿到的布局视口其实是 ~500px，窄屏问题根本暴露不出来。
// 把页面塞进指定宽度的 iframe 里，再用大窗口截整页，才是真正的窄屏渲染。
const WIDTHS = [360, 390, 430];
const caps = ['小屏安卓', 'iPhone', '大屏'];
const probe = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>窄屏探针</title>
<style>
html,body{margin:0;background:#8a8f98;font:12px/1.4 system-ui,sans-serif}
.row{display:flex;gap:16px;padding:16px;align-items:flex-start}
.col{background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,.3)}
.cap{padding:6px 10px;color:#fff;background:#3b3f46;font-weight:600}
iframe{display:block;border:0}
</style></head><body><div class="row">
${WIDTHS.map((w, i) => `  <div class="col"><div class="cap">${w} × 1180 · ${caps[i]}</div>
    <iframe src="_real.html?view=week" width="${w}" height="1180"></iframe></div>`).join('\n')}
</div></body></html>
`;
const probePath = join(dirname(outPath), '_probe-real.html');
writeFileSync(probePath, probe, 'utf8');
console.log(`✓ 已生成 ${probePath}（窄屏探针：${WIDTHS.join('/')}px）`);

// README 用的单张截图载体：一个 390px 宽的 iframe，截出来就是手机上的真实样子。
// 同样是因为 --headless=new 的最小窗口宽度问题，必须先套一层。
const docPath = join(dirname(outPath), '_probe-doc.html');
writeFileSync(
  docPath,
  `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>docs shot</title>
<style>html,body{margin:0;background:#fff}iframe{display:block;border:0}</style>
</head><body>
<iframe src="_real.html?view=${process.env.YS_SHOT_VIEW || 'week'}" width="390" height="844"></iframe>
</body></html>
`,
  'utf8',
);
console.log(`✓ 已生成 ${docPath}（README 截图载体，390×844）`);

// 导入面板探针。
// 弹窗是靠 JS 打开的，无头截图没法点按钮。两条弯路都别走：
//   1) 父页碰 iframe 的 contentWindow —— file:// 之间是不透明源，跨源访问被拦，弹窗一个都不开；
//   2) 调 window.modalImport —— 构建产物是 <script type="module">，函数是模块作用域的，不在 window 上。
// 所以：驱动脚本打进页面自己里，而且只点真实按钮（顺便把「三选一 → 二级面板」这条导航也测了）。
const DRIVER = `
<script>
// 必须等 load：构建产物是 <script type="module">，而 module 脚本是 defer 的 ——
// 这个普通 <script> 会比它先执行，那时候按钮上还没绑监听，点了等于没点。
window.addEventListener('load', function () {
  var steps = (new URLSearchParams(location.search).get('c') || '').split(',').filter(Boolean);
  var nth = function (sel, n) { var e = document.querySelectorAll(sel); if (e[n - 1]) e[n - 1].click(); };
  try {
    for (var i = 0; i < steps.length; i++) {
      var s = steps[i];
      if (s === 'onboard') document.getElementById('onboardImport').click();
      else if (s === 'me') document.getElementById('btnSettings').click();
      else if (s === 'edit') document.getElementById('btnEditSchedule').click();
      else if (s === 'fix') {
        var all = document.querySelectorAll('#modal .mgrid-cell');
        for (var j = 0; j < all.length; j++) {
          if (all[j].value) { all[j].value = all[j].value.replace(/ZXB-306/g, 'ZXB-999'); break; }
        }
      }
      else if (/^opt\\d$/.test(s)) nth('#modalBody .imp-opt', +s.slice(3));
      else if (s === 'primary') nth('#modalFoot .primary-btn', 1);
      else if (/^ghost\\d$/.test(s)) nth('#modalFoot .ghost-btn', +s.slice(5));
      else if (s === 'close') document.getElementById('modalClose').click();
      else if (s === 'fill') {
        var cells = document.querySelectorAll('#modal .mgrid-cell');
        var set = function (r, c, v) { var k = (r - 1) * 7 + (c - 1); if (cells[k]) cells[k].value = v; };
        set(1, 1, '高等数学(1)[MATH131]｜3-16周 某老师 第1节-第2节 ZXD-205');
        set(1, 3, '基础英语A[ENGL101a]｜3-16周 某老师 第1节-第2节 ZXC-205');
        set(2, 1, '程序设计基础(C语言)B[CS101]｜3-12周 某老师 第3节-第5节 汇贤堂｜14-17周 某老师 第5节-第7节 MLC-104');
        set(3, 2, '中国近现代史纲要[HIST101]｜5-7周 某老师 第6节-第7节 ZXB-306');
        set(1, 7, '大学体育(1)[PE101]｜4-15周 某老师 第3节-第4节 体育馆');
      }
    }
    document.title = 'steps:' + steps.join('+');
  } catch (e) {
    document.title = 'ERR ' + steps.join('+') + ' :: ' + e.message;
  }
});
</script>
`;

const panelPath = join(dirname(outPath), '_real-panel.html');
const closeBody = html.lastIndexOf('</body>');
writeFileSync(
  panelPath,
  html.slice(0, closeBody) + DRIVER + html.slice(closeBody),
  'utf8',
);
console.log(`✓ 已生成 ${panelPath}（带面板驱动的预览页）`);

const shell = (cases, height = 1150) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>导入面板探针</title>
<style>
html,body{margin:0;background:#8a8f98;font:12px/1.4 system-ui,sans-serif}
.row{display:flex;gap:16px;padding:16px;align-items:flex-start}
.col{background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,.3)}
.cap{padding:6px 10px;color:#fff;background:#3b3f46;font-weight:600;white-space:nowrap}
iframe{display:block;border:0}
</style></head><body><div class="row">
${cases.map(([cap, q]) => `  <div class="col"><div class="cap">${cap}</div>
    <iframe src="_real-panel.html?c=${q}" width="390" height="${height}"></iframe></div>`).join('\n')}
</div></body></html>
`;

const impPath = join(dirname(outPath), '_probe-imp.html');
writeFileSync(
  impPath,
  shell([
    ['三选一入口', 'onboard'],
    ['① 登录教务系统（浏览器里的样子）', 'onboard,opt1'],
    ['② 上传课表文件', 'onboard,opt2'],
    ['③ 课表截图说明', 'onboard,opt3'],
  ]),
  'utf8',
);
console.log(`✓ 已生成 ${impPath}（导入面板探针，4 列）`);

const manualPath = join(dirname(outPath), '_probe-manual.html');
writeFileSync(
  manualPath,
  shell(
    [
      ['手动填课表（空）', 'onboard,opt3,primary'],
      ['手动填课表（填了 5 格）', 'onboard,opt3,primary,fill'],
      ['填完点导入 → 周视图', 'onboard,opt3,primary,fill,primary'],
    ],
    1300,
  ),
  'utf8',
);
console.log(`✓ 已生成 ${manualPath}（手动填课表探针，3 列）`);

// 编辑已导入课表的探针。这一条验证的其实是"课表 → 网格 → 改一格 → 回课表"的往返：
// 第 2 列把格里的 ZXB-306 改成 ZXB-999，第 3 列是保存后的周视图 —— 改了的那门课
// 应当出现在新教室里，且**其余课一门不少**（往返丢课会立刻看出来）。
const editPath = join(dirname(outPath), '_probe-edit.html');
writeFileSync(
  editPath,
  shell(
    [
      ['「我的 → 编辑课表」（已预填 25 个时段）', 'me,edit'],
      ['改一格：ZXB-306 → ZXB-999', 'me,edit,fix'],
      ['保存后 → 周视图', 'me,edit,fix,primary'],
    ],
    1300,
  ),
  'utf8',
);
console.log(`✓ 已生成 ${editPath}（编辑课表探针，3 列）`);

