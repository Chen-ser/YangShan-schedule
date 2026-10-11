// 课表截图识别 —— 把手机截的那张课表图变成 rows，交给 core/ocrgrid.mjs 归并成格子。
//
// 为什么是 tesseract.js 而不是调云端的 OCR 接口：
//   这套东西的全部卖点就是「课表只存在你自己的设备上」。截图里带着学号、姓名、
//   一整个学期的行踪，把它上传到任何一个服务器，这个承诺就没了。
//
// 为什么 assets 有两种来路：
//   单文件版（双击打开的那种）在 file:// 下跑，**相对路径的 fetch 必定失败**
//   （实测 `Failed to fetch`），所以 lib / core / worker / 语言包只能以
//   `<script type="text/plain">` 的形式内联在页面里；
//   托管版则相反 —— 把 4MB 的 core 塞进首页会让首屏一直转圈，所以它从
//   `ocr/` 目录按需取，取过一次就被 Service Worker 缓存住。
//   两条路只差「从哪儿拿到字节」，后面的初始化完全一样。

const IDS = {
  lib: 'ocr-src-lib',
  core: 'ocr-src-core',
  worker: 'ocr-src-worker',
  lang: (l) => 'ocr-data-' + l,
};

// 语言包按文件名喂给 worker 里的 fetch 拦截器，所以这里必须是 tesseract 认的名字。
const LANG_FILES = { chi_sim: 'chi_sim.traineddata.gz', eng: 'eng.traineddata.gz' };

function inlineText(id) {
  const el = typeof document !== 'undefined' ? document.getElementById(id) : null;
  return el ? el.textContent : null;
}

async function fetchOk(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`取 ${url} 失败（HTTP ${res.status}）`);
  return res;
}

async function loadText(id, url) {
  const t = inlineText(id);
  if (t != null) return t;
  return await (await fetchOk(url)).text();
}

/** 语言包统一取 base64 —— worker 里没有别的好办法把二进制跨线程带过去。 */
async function loadB64(id, url) {
  const t = inlineText(id);
  if (t != null) return t.replace(/\s+/g, '');
  const buf = new Uint8Array(await (await fetchOk(url)).arrayBuffer());
  let s = '';
  const CHUNK = 0x8000; // 一次 apply 太多参数会把调用栈撑爆
  for (let i = 0; i < buf.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

/**
 * worker 里会去 fetch `xxx.traineddata.gz`。file:// 下那个请求必定失败，
 * 所以我们抢在 worker 脚本之前把 fetch 换掉：认得出语言包名字就返回内联的那份。
 * 这段代码是 worker 的顶层，`self.TesseractCore` 由前面拼进来的 core 源码定义好，
 * tesseract 的 getCore.js 看到它已经存在就会跳过 importScripts —— 这正是我们要的。
 */
function workerShim(langsB64) {
  return [
    '(function(){',
    '  var DATA = ' + JSON.stringify(langsB64) + ';',
    '  var realFetch = self.fetch ? self.fetch.bind(self) : null;',
    '  self.fetch = function(input, init){',
    '    var url = (typeof input === "string") ? input : ((input && input.url) || "");',
    '    var m = /([A-Za-z_]+)\\.traineddata/.exec(url);',
    '    if (m && DATA[m[1]]) {',
    '      var bin = atob(DATA[m[1]]);',
    '      var u8 = new Uint8Array(bin.length);',
    '      for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);',
    '      return Promise.resolve(new Response(u8, { status: 200 }));',
    '    }',
    '    if (realFetch) return realFetch(input, init);',
    '    return Promise.reject(new Error("取不到 " + url));',
    '  };',
    '})();',
  ].join('\n');
}

let workerPromise = null;
let workerBlobUrl = null;

/**
 * @param {{lang?: string, psm?: string, onProgress?: (p:{status:string, progress:number}) => void}} opts
 */
export function scheduleOcr(opts = {}) {
  const lang = opts.lang || 'chi_sim+eng';
  const psm = String(opts.psm || '11'); // SPARSE_TEXT —— 课表是一格一格的稀疏文字，实测这个最好
  const onProgress = opts.onProgress || null;

  const start = async () => {
    const [lib, core, workerSrc] = await Promise.all([
      loadText(IDS.lib, 'ocr/tesseract.min.js'),
      loadText(IDS.core, 'ocr/tesseract-core-simd-lstm.wasm.js'),
      loadText(IDS.worker, 'ocr/worker.min.js'),
    ]);

    const langs = lang.split('+').map((s) => s.trim()).filter(Boolean);
    const b64 = {};
    for (const l of langs) {
      const file = LANG_FILES[l];
      if (!file) throw new Error(`不认识的语言包：${l}`);
      b64[l] = await loadB64(IDS.lang(l), 'ocr/' + file);
    }

    if (typeof self.Tesseract === 'undefined') new Function(lib)(); // UMD，会把 Tesseract 挂到 self 上
    if (typeof self.Tesseract === 'undefined') throw new Error('OCR 引擎没装载起来');

    const code = core + '\n' + workerShim(b64) + '\n' + workerSrc;
    workerBlobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));

    const w = await self.Tesseract.createWorker(lang, 1, {
      workerPath: workerBlobUrl,
      workerBlobURL: false,
      langPath: 'ocr', // 只是给 tesseract 拼 URL 用，真正的字节由上面的 shim 给
      logger: onProgress ? (m) => onProgress(m) : () => {},
      errorHandler: (e) => { if (onProgress) onProgress({ status: 'error', progress: 0, message: String(e) }); },
    });
    await w.setParameters({ tessedit_pageseg_mode: psm });
    return w;
  };

  return {
    /** 认出 TSV（词框坐标 + 文字），调用方拿它去 core/ocrgrid.mjs 归并成格子。 */
    async recognize(blob) {
      if (!workerPromise) workerPromise = start();
      const w = await workerPromise;
      const { data } = await w.recognize(blob, {}, { text: true, tsv: true });
      return data;
    },
    async terminate() {
      if (!workerPromise) return;
      const w = await workerPromise.catch(() => null);
      workerPromise = null;
      if (w) await w.terminate().catch(() => {});
      if (workerBlobUrl) { URL.revokeObjectURL(workerBlobUrl); workerBlobUrl = null; }
    },
  };
}

/** 把一个 File/Blob 读成图片；非图片（PDF、heic 之类）早点报清楚，别让 OCR 去猜。 */
export async function imageBlobOf(file) {
  if (!file) throw new Error('没有选到文件');
  const type = file.type || '';
  if (!/^image\//.test(type) && !/\.(png|jpe?g|webp|bmp)$/i.test(file.name || '')) {
    throw new Error('这不是一张图片。截图请存成 PNG 或 JPG 再传。');
  }
  return file;
}

/** 太大的图先缩一下再识别：4000px 宽的手机截图会让 wasm 里那一层白白多吃几十秒。 */
export async function shrinkForOcr(blob, maxSide = 2200) {
  if (typeof createImageBitmap !== 'function') return blob;
  let bmp;
  try {
    bmp = await createImageBitmap(blob);
  } catch {
    return blob; // 浏览器认不出的格式，交给 tesseract 自己报错
  }
  const side = Math.max(bmp.width, bmp.height);
  if (side <= maxSide) { bmp.close && bmp.close(); return blob; }
  const k = maxSide / side;
  const cv = document.createElement('canvas');
  cv.width = Math.round(bmp.width * k);
  cv.height = Math.round(bmp.height * k);
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, cv.width, cv.height);
  bmp.close && bmp.close();
  return await new Promise((r) => cv.toBlob((b) => r(b || blob), 'image/png'));
}
