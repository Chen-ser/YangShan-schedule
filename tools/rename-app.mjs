// 一次性改名工具：阳山课表 → 仰山课表
//
// 为什么单独写个脚本而不是手改：整个仓库有近 30 个源文件、上百处出现，
// 手改一定会漏。但是**不能**无脑全库替换 —— dist/、bin/、obj/、
// shells/android/app/build/ 这些是构建产物（重新构建即可），
// vendor/ocr/ 里是 wasm 与语言包二进制（替换会直接损坏文件）。
//
// 用法： node tools/rename-app.mjs [--dry]
//
// 只改「用户看得见的名字」。以下**故意不改**（都是线格式或标识符，
// 改了会让已经存了书签的用户、已经装了旧版的用户数据失联）：
//   - 抓取 schema 的 kind: 'yangshan-raw'、分享码前缀 YSRAW1-
//   - 壳的虚拟主机名 yangshan.local、程序集名 YangShanShell、
//     程序目录 %LOCALAPPDATA%\Programs\YangShanSchedule、
//     数据目录 %LOCALAPPDATA%\YangShanSchedule、
//     凭据名 YangShanSchedule/bistu
//   - 安卓包名 dev.yangshan.schedule（改了就是另一个 App 了）

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const DRY = process.argv.includes('--dry');

// 构建产物 / 二进制 / 第三方缓存 —— 一律跳过
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'bin', 'obj', 'build', 'out',
  '_runtime', 'vendor', '.gradle', '.idea', 'local.properties',
]);
const TEXT_EXT = new Set([
  '.mjs', '.js', '.cjs', '.json', '.md', '.html', '.css', '.ps1', '.cmd', '.bat',
  '.kts', '.kt', '.xml', '.cs', '.csproj', '.sln', '.yml', '.yaml', '.txt', '.properties', '.pro',
]);

const OLD_NAME = '阳山';
const NEW_NAME = '仰山';
// install.ps1 / uninstall.ps1 刻意只写 ASCII：中文用码点拼出来。
// 阳 = U+9633，仰 = U+4EF0。
const OLD_CODE = '0x9633';
const NEW_CODE = '0x4EF0';

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(e)) continue;
      walk(full, out);
    } else if (TEXT_EXT.has(extname(e))) {
      // 别改自己：脚本里的 OLD_NAME 一旦被替换掉，工具就废了。
      if (full === join(ROOT, 'tools', 'rename-app.mjs')) continue;
      out.push(full);
    }
  }
  return out;
}

const files = walk(ROOT);
let changed = 0;
let total = 0;

for (const f of files) {
  const src = readFileSync(f, 'utf8');
  let next = src;
  let n = 0;

  const nameHits = next.split(OLD_NAME).length - 1;
  if (nameHits) { next = next.split(OLD_NAME).join(NEW_NAME); n += nameHits; }

  if (extname(f) === '.ps1') {
    const codeHits = next.split(OLD_CODE).length - 1;
    if (codeHits) { next = next.split(OLD_CODE).join(NEW_CODE); n += codeHits; }
  }

  if (n === 0) continue;
  changed++;
  total += n;
  console.log(`${String(n).padStart(3)}  ${relative(ROOT, f)}`);
  if (!DRY) writeFileSync(f, next, 'utf8');
}

console.log('');
console.log(`${DRY ? '[dry] would change' : 'changed'} ${changed} file(s), ${total} occurrence(s)`);

// 收尾自检：源文件里不该再剩旧名（构建产物已跳过，它们会被重新生成）
const leftovers = [];
for (const f of files) {
  if (readFileSync(f, 'utf8').includes(OLD_NAME)) leftovers.push(relative(ROOT, f));
}
const codeLeftovers = files.filter((f) => extname(f) === '.ps1' && readFileSync(f, 'utf8').includes(OLD_CODE))
  .map((f) => relative(ROOT, f));
if (leftovers.length || codeLeftovers.length) {
  console.error('LEFTOVERS:', [...leftovers, ...codeLeftovers].join(', '));
  process.exit(1);
}
console.log('self-check: no "' + OLD_NAME + '" or ' + OLD_CODE + ' left in tracked sources');
