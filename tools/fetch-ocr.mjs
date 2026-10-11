// 下载 OCR 运行时资产到 vendor/ocr/。
// 这些文件体积较大（约 10 MB），但都是可再分发的开源资产；
// 仓库里直接带着它们，别人 clone 下来就能构建，不需要联网。
//   node tools/fetch-ocr.mjs            缺什么补什么
//   node tools/fetch-ocr.mjs --force    全部重下
import { mkdirSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'vendor', 'ocr');

const SRC = {
  tesseract: 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist',
  core: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.1.2',
  lang: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data',
};

const FILES = [
  ['tesseract.min.js', `${SRC.tesseract}/tesseract.min.js`],
  ['worker.min.js', `${SRC.tesseract}/worker.min.js`],
  // 自包含的 wasm 核心：wasm 以 base64 内嵌在 js 里，单文件场景不需要再 fetch .wasm。
  // 用 -lstm 版（3.95 MB），因为默认 oem 就是 LSTM_ONLY。
  ['tesseract-core-simd-lstm.wasm.js', `${SRC.core}/tesseract-core-simd-lstm.wasm.js`],
  // 语言包用 best_int（LSTM-only + 整数量化）：中文 1.64 MB，比 4.0.0_best 的 11.43 MB 小得多，精度接近。
  ['chi_sim.traineddata.gz', `${SRC.lang}/chi_sim/4.0.0_best_int/chi_sim.traineddata.gz`],
  ['eng.traineddata.gz', `${SRC.lang}/eng/4.0.0_best_int/eng.traineddata.gz`],
];

const force = process.argv.includes('--force');

mkdirSync(OUT, { recursive: true });

let fetched = 0;
let skipped = 0;

for (const [name, url] of FILES) {
  const dest = path.join(OUT, name);
  if (!force && existsSync(dest) && statSync(dest).size > 1024) {
    console.log(`跳过 ${name}（已存在 ${(statSync(dest).size / 1048576).toFixed(2)} MB）`);
    skipped += 1;
    continue;
  }
  process.stdout.write(`下载 ${name} … `);
  const res = await fetch(url);
  if (!res.ok) {
    console.log(`失败 HTTP ${res.status}`);
    process.exitCode = 1;
    continue;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024) {
    console.log(`失败（只有 ${buf.length} 字节）`);
    process.exitCode = 1;
    continue;
  }
  writeFileSync(dest, buf);
  const sha = createHash('sha256').update(buf).digest('hex').slice(0, 16);
  console.log(`${(buf.length / 1048576).toFixed(2)} MB  sha256:${sha}`);
  fetched += 1;
}

console.log(`\n完成：新下载 ${fetched} 个，跳过 ${skipped} 个，目录 ${OUT}`);
