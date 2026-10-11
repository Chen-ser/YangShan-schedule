#!/usr/bin/env node
// 安卓壳的资源准备：把构建产物和两份共享脚本拷进 app/src/main/assets/。
//
//   dist/仰山课表.html  →  assets/index.html    （在 <head> 后注入 shim.js）
//   shells/capture.js   →  assets/capture.js    （学校窗口里运行时注入）
//
// 为什么不把 shim.js 也留成单独一个资源、等运行时再注入？
// 因为安卓没有 WebView2 那种「文档创建时注入」的钩子，运行时注入要么赶不上内核启动，
// 要么得改内核。烘进 HTML 就完全没有竞态 —— 内核一醒来 YangShanShell 就已经在那儿了。
//
// 跑法： node tools/prepare-assets.mjs       （然后 gradle assembleDebug）
//
// 与 Windows 壳的对应关系：那边是 csproj 的 <EmbeddedResource>，同一份文件、同一个角色。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const shellRoot = resolve(here, '..'); // shells/android
const repo = resolve(shellRoot, '..', '..'); // 仓库根
const assets = join(shellRoot, 'app', 'src', 'main', 'assets');

const appHtml = join(repo, 'dist', '仰山课表.html');
if (!existsSync(appHtml)) {
  console.error(`找不到 ${appHtml}`);
  console.error('先在仓库根跑一次：node web/build.mjs');
  process.exit(1);
}

const read = (...p) => readFileSync(join(repo, ...p), 'utf8');
const shim = read('shells', 'shim.js');
const capture = read('shells', 'capture.js');

// shim.js 里如果混进了 </script>，内联就会提前闭合标签 —— 宁可在这里炸掉。
for (const [name, src] of [['shells/shim.js', shim], ['shells/capture.js', capture]]) {
  if (/<\/script/i.test(src)) {
    console.error(`${name} 里出现了 </script，没法内联到 HTML 里。`);
    process.exit(1);
  }
}

let html = readFileSync(appHtml, 'utf8');

if (html.includes("globalThis.__ysShellName='android'")) {
  console.log('index.html 已经注入过 shim.js，跳过注入。');
} else {
  const inject =
    '<script>\n' +
    "globalThis.__ysShellName='android';\n" +
    shim.trim() +
    '\n</script>\n';
  const marker = '<head>';
  const at = html.indexOf(marker);
  html = at >= 0 ? html.slice(0, at + marker.length) + '\n' + inject + html.slice(at + marker.length) : inject + html;
}

mkdirSync(assets, { recursive: true });
writeFileSync(join(assets, 'index.html'), html, 'utf8');
writeFileSync(join(assets, 'capture.js'), capture, 'utf8');

const kb = (s) => `${(Buffer.byteLength(s, 'utf8') / 1024).toFixed(1)} KB`;
console.log(`assets/index.html   ${kb(html)}   （内联了 shim.js ${kb(shim)}）`);
console.log(`assets/capture.js   ${kb(capture)}`);
console.log('好了。接着跑： gradle assembleDebug    （或用 Android Studio 打开本目录）');
