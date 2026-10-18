// 发布前扫一遍会被提交的文件，确认没有把凭据或真实个人信息带进公开仓库。
//
// 跑法：node tools/check-secrets.mjs
// 退出码非 0 表示命中。CI（.github/workflows/pages.yml）里也会跑。
//
// 为什么需要它：本项目侦察阶段用过真实教务账号，`docs/复盘.md` 里也记过
// 「脱敏脚本把属性洗掉导致回归假绿」的事故。公开仓库一旦推上去历史就抹不掉了，
// 所以拦在 commit 之前，而不是等出事再 force-push。
//
// ★ 为什么自己走目录、不调 `git ls-files`：本项目的开发沙箱禁止命名管道，
// Node 一旦用 spawnSync/execFileSync 去捕获子进程输出就会 `Error: spawnSync git EPERM`。
// 所以这里不 spawn 任何东西，自己按 .gitignore 的语义排除，并把「扫了什么、跳过什么」打出来，
// 免得"扫得少"被误读成"很干净"。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 与 .gitignore 保持一致：这些不进仓库，也就不需要扫。
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist',
  join('shells', 'windows', 'feed'), join('shells', 'windows', 'bin'),
  join('shells', 'windows', 'obj'), join('shells', 'windows', 'out'),
  join('shells', 'windows', '.dotnet'), join('shells', 'windows', '.nuget'),
  join('shells', 'windows', '_runtime'),
  join('shells', 'android', '.gradle'), join('shells', 'android', 'build'),
  join('shells', 'android', '.gradle-build-home'), join('shells', 'android', '.kotlin'),
  join('shells', 'android', 'app', 'build'),
]);
const SKIP_FILE_RE = /(\.local\.json|\.log|\.apk|\.aab)$/i;
const BINARY_RE = /\.(wasm|png|jpg|jpeg|gif|ico|gz|zip|nupkg|exe|dll|pdb|woff2?)$/i;

// 构建产物：不入库，但它就在盘上，会被 walk 扫到。它是把 vendor 代码内联进来的结果，
// 扫它等于把 vendor 的误报再报一次。
const SKIP_PATHS = new Set([join('shells', 'android', 'app', 'src', 'main', 'assets', 'index.html')]);

// 第三方 vendor 代码（PDF.js、OCR 运行时）里不可能出现我们学生的学号/手机号，
// 但确实有「长得像十位学号」的常量 —— 实测 pdf.worker.min.mjs 里的 SHA-256 轮常量
// 就被当成学号报过一次。凭据类规则照旧全扫，个人信息类对它免检。
const VENDOR_RE = /^vendor\//;
const PERSONAL_RULES = new Set(['中国手机号', '18 位身份证号', '10 位学号（疑似）']);

const RULES = [
  // ── 真·凭据 ────────────────────────────────────────────────────────────
  { name: 'GitHub 令牌', re: /\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|gho_[A-Za-z0-9]{20,})\b/ },
  { name: 'AWS 密钥', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: '私钥文件内容', re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'Slack 令牌', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },

  // ── 硬编码口令（用户明令：账号密码不得写进任何项目文件）────────────────
  {
    name: '硬编码口令',
    re: /(password|passwd|pwd|口令|密码)\s*[:=]\s*["'`](?!\s*["'`]|\$\{|<|\.\.\.|xxx|your|YOUR|\*{3,})[^"'`\s]{4,}["'`]/i,
  },
  { name: '硬编码侦察凭据', re: /BISTU_(USER|PASS)\s*[:=]\s*["'`][^"'`]{3,}["'`]/ },

  // ── 真实个人信息 ──────────────────────────────────────────────────────
  { name: '中国手机号', re: /(?<!\d)1[3-9]\d{9}(?!\d)/ },
  { name: '18 位身份证号', re: /(?<!\d)[1-9]\d{5}(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/ },
  { name: '10 位学号（疑似）', re: /(?<!\d)(20[12]\d[0-9]{6})(?!\d)/ },
];

// 白名单：这些行里出现"像学号/像手机号"的数字是刻意的，不是泄露。
const ALLOW = [/tesseract/i, /tests?\s+\d+/i, /node_modules/];

// 占位串：脱敏后的样本统一用「年份 + 全 0」当假学号（形如 2026000000）。
// 它长得像学号，但结构上不可能是真的 —— 真学号不会后六位全零。
const PLACEHOLDER_ID = /^20[12]\d0{6}$/;

function walk(dir, out = [], skipped = new Set()) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, ent.name);
    const rel = relative(ROOT, abs);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(rel)) { skipped.add(rel); continue; }
      walk(abs, out, skipped);
    } else if (ent.isFile()) {
      if (SKIP_FILE_RE.test(ent.name)) continue;
      if (BINARY_RE.test(ent.name)) continue;
      if (SKIP_PATHS.has(rel)) continue;
      out.push(rel.split(sep).join('/'));
    }
  }
  return { files: out, skipped };
}

const { files, skipped } = walk(ROOT);
let hits = 0;

for (const rel of files) {
  let text;
  try {
    text = readFileSync(join(ROOT, rel), 'utf8');
  } catch {
    continue;
  }
  if (text.includes('\u0000')) continue; // 二进制伪装成文本
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (ALLOW.some((a) => a.test(lines[i]))) continue;
    for (const rule of RULES) {
      if (VENDOR_RE.test(rel) && PERSONAL_RULES.has(rule.name)) continue;
      const m = lines[i].match(rule.re);
      if (!m) continue;
      if (rule.name.startsWith('10 位学号') && PLACEHOLDER_ID.test(m[0])) continue; // 占位串
      // 命中内容打码，免得把敏感串再抄进终端/日志一次。
      const shown = m[0].length > 12 ? m[0].slice(0, 6) + '…' + m[0].slice(-2) : m[0];
      console.log(`✗ ${rel}:${i + 1}  [${rule.name}]  ${shown}`);
      hits++;
    }
  }
}

console.log(`\n扫描 ${files.length} 个文本文件；跳过 ${skipped.size} 个目录（构建产物/依赖缓存）`);
console.log(hits ? `SECRETS_FAIL 命中 ${hits} 处 —— 修掉再提交` : 'SECRETS_OK 无命中');
process.exit(hits ? 1 : 0);
