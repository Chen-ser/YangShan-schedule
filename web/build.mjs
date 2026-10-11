// 构建：把 core + styles + app + bookmarklet 内联成一个双击就能用的单文件 HTML。
//
// 用法：
//   node web/build.mjs
//
// 产出（都在 dist/ 下）：
//   仰山课表.html          单文件，双击打开即用；不含任何外部请求
//   site/                  托管用的一份（多了 manifest + service worker，可安装为 PWA）
//   bookmarklet.txt        抓取书签的 javascript: 链接
//   icons/                 图标（单文件那份是内联 data URI，这里给托管用）
//
// 之所以要"构建"这一步，是因为同一份内核要同时喂给三个消费方：
// 浏览器（要内联）、Node（要 ESM）、壳的 WebView（要内联）。手写两份必然会漂移。

import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DIST = join(ROOT, 'dist');

const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');

// ---------------------------------------------------------------- 版本

function version() {
  const arg = process.argv.find((a) => a.startsWith('--version='));
  if (arg) return arg.slice('--version='.length);
  try {
    return JSON.parse(read('package.json')).version;
  } catch {
    return '0.0.0';
  }
}

const VERSION = version();

// ---------------------------------------------------------------- 模块语法剥离

/**
 * 把 ESM 源码变成"能直接拼进 <script type="module">"的形式。
 *
 * 不能只做字符串删除就完事 —— 删掉 import 之后，模块作用域变成一个大作用域，
 * 所以调用方必须保证 core 内部没有重名。下面的 assertNoDuplicates 会兜住这一点。
 */
function stripModuleSyntax(src) {
  return src
    .replace(/^[ \t]*import\s+[^;\n]*?from\s*['"][^'"]+['"];?[ \t]*$/gm, '')
    .replace(/^[ \t]*import\s*['"][^'"]+['"];?[ \t]*$/gm, '')
    .replace(/^[ \t]*export\s*\{[^}]*\};?[ \t]*$/gm, '')
    .replace(/^export\s+/gm, '');
}

/** 拼接后检查有没有顶层重名 —— 有的话说明这段代码不能用"拼"的方式合并。 */
function assertNoDuplicates(code, label) {
  const names = [];
  const re = /^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = re.exec(code))) names.push(m[1]);
  const seen = new Set();
  const dup = [];
  for (const n of names) {
    if (seen.has(n)) dup.push(n);
    seen.add(n);
  }
  if (dup.length) {
    throw new Error(`[${label}] 拼接后出现顶层重名：${[...new Set(dup)].join(', ')}`);
  }
  return names.length;
}

/**
 * 书签源码里一个注释都不能留。
 *
 * 理由：`javascript:` 链接在存成书签、再被系统复制粘贴的过程中，换行有可能被吃掉。
 * 一旦整个脚本被折成一行，任何 `// 说明` 都会把它后面的代码**全部**变成注释，
 * 现象是"点了书签完全没反应"而且极难排查（浏览器不会报错，因为根本没执行）。
 * 所以抓取内核（shells/capture.js）的注释必须在这里剥掉。
 *
 * 只剥"整行都是注释"的情况 —— 不去猜字符串和正则字面量里的斜杠，
 * 那种启发式写法才是真正的 bug 来源。代价是抓取源码里禁止出现反引号模板字符串
 * （多行模板里可能有整行看起来像注释），这条用一个断言钉住。
 */
function stripBookmarkletComments(src, label) {
  if (src.includes('`')) {
    throw new Error(`[${label}] 抓取源码里不能出现反引号模板字符串：行注释剥离会误伤多行模板`);
  }
  const out = src
    .replace(/^\s*\/\*[\s\S]*?\*\/\s*$/gm, '')
    .replace(/^\s*\/\/.*$/gm, '');
  out.split('\n').forEach((line, i) => {
    if (/^\s*\/\//.test(line)) {
      throw new Error(`[${label}] 第 ${i + 1} 行还残留行注释：${line.trim().slice(0, 60)}`);
    }
  });
  return out;
}

/** 护栏：内联产物里不许出现任何 Node 专有 API（它要在浏览器里跑）。 */
function assertBrowserSafe(code, label) {
  const stripped = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const rules = [
    [/from\s+['"]node:/, 'import from "node:..."'],
    [/\brequire\s*\(/, 'require()'],
    [/\bBuffer\b/, 'Buffer'],
    [/\bprocess\s*\./, 'process.'],
    [/\b__dirname\b/, '__dirname'],
    [/\bwriteFileSync\b/, 'writeFileSync'],
  ];
  for (const [re, why] of rules) {
    const line = stripped.split('\n').findIndex((l) => re.test(l));
    if (line >= 0) throw new Error(`[${label}] 第 ${line + 1} 行出现了浏览器里不存在的东西：${why}`);
  }
}

// ---------------------------------------------------------------- 图标（手写 PNG 编码器）

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** RGBA 像素数组 → PNG 文件内容。 */
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy
      ? rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
      : Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 应用图标：蓝底圆角方块 + 白色课表卡片 + 蓝色网格。
 * 用 3 倍超采样再降采样拿到平滑边缘 —— 不引任何绘图库。
 */
function drawIcon(size) {
  const SS = 3;
  const W = size * SS;
  const px = new Uint8Array(W * W * 4);

  const put = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= W || y >= W) return;
    const i = (y * W + x) * 4;
    const na = a / 255;
    px[i] = Math.round(px[i] * (1 - na) + r * na);
    px[i + 1] = Math.round(px[i + 1] * (1 - na) + g * na);
    px[i + 2] = Math.round(px[i + 2] * (1 - na) + b * na);
    px[i + 3] = Math.min(255, Math.round(px[i + 3] * (1 - na) + 255 * na));
  };

  const inRound = (x, y, rx0, ry0, rx1, ry1, rad) => {
    if (x < rx0 || y < ry0 || x >= rx1 || y >= ry1) return false;
    const cx = Math.min(Math.max(x, rx0 + rad), rx1 - rad);
    const cy = Math.min(Math.max(y, ry0 + rad), ry1 - rad);
    return (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad + rad;
  };

  const S = (v) => Math.round((v / 180) * W);

  // 蓝色圆角底
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      if (inRound(x, y, 0, 0, W, W, S(38))) put(x, y, 31, 111, 235, 255);
    }
  }

  // 白色卡片
  const cx0 = S(36), cy0 = S(46), cx1 = S(144), cy1 = S(140);
  for (let y = cy0; y < cy1; y++) {
    for (let x = cx0; x < cx1; x++) {
      if (inRound(x, y, cx0, cy0, cx1, cy1, S(12))) put(x, y, 255, 255, 255, 255);
    }
  }

  // 表头蓝条（压在卡片上）
  for (let y = cy0; y < S(70); y++) {
    for (let x = cx0; x < cx1; x++) {
      if (inRound(x, y, cx0, cy0, cx1, cy1, S(12))) put(x, y, 31, 111, 235, 255);
    }
  }

  // 卡片内的课表网格
  const half = 255;
  const bar = (x0, y0, x1, y1) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) put(x, y, 31, 111, 235, half);
  };
  bar(S(46), S(80), S(134), S(86));
  bar(S(46), S(98), S(134), S(104));
  bar(S(46), S(116), S(134), S(122));
  bar(S(84), S(80), S(90), S(134));

  // 降采样
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const i = ((y * SS + dy) * W + (x * SS + dx)) * 4;
          r += px[i]; g += px[i + 1]; b += px[i + 2]; a += px[i + 3];
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return encodePng(size, size, out);
}

// ---------------------------------------------------------------- 组装

function build() {
  const coreFiles = ['core/schedule.mjs', 'core/model.mjs', 'core/officefile.mjs', 'core/ocrgrid.mjs'];
  const coreSrc = coreFiles.map((f) => `// ======== ${f} ========\n${stripModuleSyntax(read(f))}`).join('\n');

  const appSrc = stripModuleSyntax(read('web', 'app.js')) + '\n' + stripModuleSyntax(read('web', 'ocr.mjs'));
  const styles = read('web', 'styles.css');
  // 书签 = 抓取内核 + 界面。内核（shells/capture.js）与客户端壳共用同一份，
  // 所以教务接口真变了的时候只需要改一个文件。
  const bookmarklet = (
    stripBookmarkletComments(read('shells', 'capture.js'), 'shells/capture.js') +
    '\n' +
    stripBookmarkletComments(read('bookmarklet', 'grab.js'), 'bookmarklet/grab.js')
  ).trim();

  // OCR 资产：单文件版内联（file:// 下相对路径 fetch 必失败），托管版外置（首页不该背 4MB）。
  const ocrVendor = {
    lib: ['tesseract.min.js', 'ocr-src-lib'],
    core: ['tesseract-core-simd-lstm.wasm.js', 'ocr-src-core'],
    worker: ['worker.min.js', 'ocr-src-worker'],
  };
  const ocrLangs = { chi_sim: 'chi_sim.traineddata.gz', eng: 'eng.traineddata.gz' };
  // <script type="text/plain"> 里不能出现字面量 </script
  const guardScript = (s) => s.replace(/<\/(script)/gi, '<\\/$1');
  const ocrLibsInline = [
    ...Object.values(ocrVendor).map(([file, id]) =>
      `<script type="text/plain" id="${id}">${guardScript(readFileSync(join(ROOT, 'vendor', 'ocr', file), 'utf8'))}</script>`),
    ...Object.entries(ocrLangs).map(([lang, file]) =>
      `<script type="text/plain" id="ocr-data-${lang}">${readFileSync(join(ROOT, 'vendor', 'ocr', file)).toString('base64')}</script>`),
  ].join('\n');

  assertBrowserSafe(coreSrc, 'core');
  assertBrowserSafe(appSrc, 'app');
  assertNoDuplicates(coreSrc + '\n' + appSrc, 'bundle');

  if (bookmarklet.includes('</script')) throw new Error('书签源码里不能出现 </script');

  const combined = `${coreSrc}\n${appSrc}`;
  if (/\bimport\s+[^;\n]*from\b/.test(combined)) throw new Error('内联产物里还残留 import 语句');
  if (/^export\s/m.test(combined)) throw new Error('内联产物里还残留 export 语句');
  if (combined.includes('__VERSION__') === false) throw new Error('app.js 里应当有 __VERSION__ 占位符');

  const icons = {
    32: drawIcon(32),
    180: drawIcon(180),
    192: drawIcon(192),
    512: drawIcon(512),
  };
  const dataUri = (buf) => 'data:image/png;base64,' + buf.toString('base64');

  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(join(DIST, 'site', 'icons'), { recursive: true });

  const template = read('web', 'template.html');

  const manifest = {
    name: '仰山课表',
    short_name: '课表',
    description: '北京信息科技大学课表 · 课表只存在你自己的设备上',
    start_url: '.',
    scope: '.',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#f5f6f8',
    theme_color: '#1f6feb',
    lang: 'zh-CN',
    icons: [
      { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };

  const swSrc = `// 仰山课表 Service Worker —— 只做一件事：让断网时也能打开。
const CACHE = 'yangshan-${VERSION}';
const ASSETS = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // 公告源等其他域一律走网络，不缓存
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match('./index.html'))),
  );
});
`;

  const inlineManifest =
    'data:application/manifest+json;charset=utf-8,' +
    encodeURIComponent(JSON.stringify({
      name: '仰山课表', short_name: '课表', display: 'standalone', background_color: '#f5f6f8',
      theme_color: '#1f6feb', lang: 'zh-CN',
      icons: [
        { src: dataUri(icons[192]), sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: dataUri(icons[512]), sizes: '512x512', type: 'image/png', purpose: 'any' },
      ],
    }));

  // 公告源格式示例：**从 examples/announcements.json 读，不在这里再抄一份**。
  // 用户会照抄这份示例去建自己的公告源，示例和解析器各写一份必然漂移。
  // 包进 <script type="application/json"> 时要挡掉 `</script`（JSON 里正常不会出现，但别赌）。
  const annExample = readFileSync(join(ROOT, 'examples', 'announcements.json'), 'utf8')
    .trim()
    .replace(/<\/(script)/gi, '<\\/$1');

  const fill = (html, { manifestTag, sw, icon16, icon180, ocrLibs }) =>
    html
      .replace('/*{{STYLES}}*/', () => styles)
      .replace('/*{{CORE}}*/', () => coreSrc)
      .replace('/*{{APP}}*/', () => appSrc)
      .replace('/*{{BOOKMARKLET}}*/', () => bookmarklet)
      .replace('/*{{ANN_EXAMPLE}}*/', () => annExample)
      .replace('<!--{{OCRLIBS}}-->', () => ocrLibs || '')
      .replace('/*{{ICON16}}*/', () => icon16)
      .replace('/*{{ICON180}}*/', () => icon180)
      .replace('<!--{{MANIFEST}}-->', () => manifestTag)
      .replace('<!--{{SW}}-->', () => sw)
      .replace(/__VERSION__/g, VERSION);

  // --- 单文件版
  const single = fill(template, {
    manifestTag: `<link rel="manifest" href="${inlineManifest}">`,
    sw: '',
    icon16: dataUri(icons[32]),
    icon180: dataUri(icons[180]),
    ocrLibs: ocrLibsInline,
  });
  // 自检：OCR 资产必须**原样**落到单文件里。
  // 踩过一次：`</script` 的转义没生效时，浏览器会在那儿把 script 元素提前截断，
  // 页面照样能开、只是 OCR 那块悄悄少了内容 —— 不检就得靠人去浏览器里量长度。
  for (const [file, id] of Object.values(ocrVendor)) {
    const want = readFileSync(join(ROOT, 'vendor', 'ocr', file), 'utf8').replace(/<\/(script)/gi, '<\\/$1');
    const need = `<script type="text/plain" id="${id}">${want}</script>`;
    if (!single.includes(need)) throw new Error(`单文件产物里的 ${id} 被截断或改写了`);
  }
  for (const [lang, file] of Object.entries(ocrLangs)) {
    const b64 = readFileSync(join(ROOT, 'vendor', 'ocr', file)).toString('base64');
    if (!single.includes(`<script type="text/plain" id="ocr-data-${lang}">${b64}</script>`)) {
      throw new Error(`单文件产物里的 ocr-data-${lang} 被截断或改写了`);
    }
  }
  writeFileSync(join(DIST, '仰山课表.html'), single, 'utf8');
  writeFileSync(join(DIST, 'yangshan-schedule.html'), single, 'utf8'); // 方便在英文路径/脚本里引用

  // --- 托管版
  const siteSw = `
<script>
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
</script>`;
  const site = fill(template, {
    manifestTag: '<link rel="manifest" href="manifest.webmanifest">',
    sw: siteSw,
    icon16: 'icons/icon-32.png',
    icon180: 'icons/icon-180.png',
  });
  writeFileSync(join(DIST, 'site', 'index.html'), site, 'utf8');
  writeFileSync(join(DIST, 'site', 'manifest.webmanifest'), JSON.stringify(manifest, null, 2), 'utf8');
  writeFileSync(join(DIST, 'site', 'sw.js'), swSrc, 'utf8');
  for (const [s, buf] of Object.entries(icons)) {
    writeFileSync(join(DIST, 'site', 'icons', `icon-${s}.png`), buf);
  }
  writeFileSync(join(DIST, 'site', '.nojekyll'), '', 'utf8');

  // --- 托管版的 OCR 资产：外置，按需取，取过就被 Service Worker 缓存住
  mkdirSync(join(DIST, 'site', 'ocr'), { recursive: true });
  for (const [file] of Object.values(ocrVendor)) {
    copyFileSync(join(ROOT, 'vendor', 'ocr', file), join(DIST, 'site', 'ocr', file));
  }
  for (const file of Object.values(ocrLangs)) {
    copyFileSync(join(ROOT, 'vendor', 'ocr', file), join(DIST, 'site', 'ocr', file));
  }

  // --- 书签
  const bmUrl = 'javascript:' + encodeURIComponent(bookmarklet);
  writeFileSync(join(DIST, 'bookmarklet.txt'), bmUrl, 'utf8');
  writeFileSync(join(DIST, 'bookmarklet.source.js'), bookmarklet + '\n', 'utf8');

  return { single, site, bmUrl };
}

const out = build();
const kb = (s) => (Buffer.byteLength(s, 'utf8') / 1024).toFixed(1) + ' KB';

console.log(`✓ 构建完成 v${VERSION}`);
console.log(`  dist/仰山课表.html         ${kb(out.single)}   单文件，双击即用`);
console.log(`  dist/site/index.html       ${kb(out.site)}   托管版（含 manifest + service worker）`);
console.log(`  dist/bookmarklet.txt       ${kb(out.bmUrl)}   抓取书签链接`);
console.log('');
console.log('  提示：dist/仰山课表.html 直接用浏览器打开就能用（file:// 下也正常）。');
console.log('       放进 dist/site/ 部署到静态托管则自动升级成可安装、可离线的 PWA。');
