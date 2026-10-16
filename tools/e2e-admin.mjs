// 端到端验证：管理员页（/admin/）。
//
// 跑法：node tools/e2e-admin.mjs
// 前置：先 node web/build.mjs。需要能连 ntfy.sh。
//
// 为什么必须用 HTTP 起服务、不能用 file:// 打开这个页面：
// 管理员页要算的是「公告文件在站点上的地址」，file:// 下算不出来 ——
// 这是刻意的设计（防止有人拿本地路径生成一个发给全班都用不了的分享码）。
// 所以这条测试必须把 dist/site 当真站点发出去。
//
// 这里覆盖三件单测做不到的事：
//   1. 分享码是在**真页面**里生成的，内容要和站点地址、频道一致（不是拿函数单独测）；
//   2. 「发一条测试推送」这个按钮真的能敲响 ntfy（只有设了频道、没有令牌也能用）；
//   3. 表单 → 列表 → 待发布 JSON 这条 UI 链路真的通。
import { openSession } from './cdp.mjs';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeAnnConfig, randomTopic, ntfySseUrl } from '../core/model.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'dist', 'site');
if (!existsSync(join(SITE, 'admin', 'index.html'))) throw new Error('找不到 dist/site/admin/index.html，先跑 node web/build.mjs');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const file = join(SITE, p);
  if (!file.startsWith(SITE) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
console.log(`站点 ${base}/admin/`);

// 先把门铃的接收端挂上，再去点按钮 —— 反了就会漏掉那一声。
const topic = randomTopic('ys-e2e-admin');
const heard = [];
const ac = new AbortController();
const sse = (async () => {
  const r = await fetch(ntfySseUrl(topic), { signal: ac.signal, headers: { accept: 'text/event-stream' } });
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      // ★ ntfy 的真消息是**裸 data: 行**（没有 event: 字段）；连接建立才是 event: open。
      // 只认裸 data:，正好也验证了「应用不会把连接事件误当成新公告」。
      if (line.startsWith('data: ')) {
        try { if (JSON.parse(line.slice(6)).event === 'message') heard.push(line.slice(6)); } catch { /* 非 JSON 忽略 */ }
      }
    }
  }
})().catch((e) => { if (e.name !== 'AbortError') console.log('SSE 失败：' + e.message); });

// ---------------------------------------------------------------- 页内探针

const probe = async (tp) => {
  const $ = (id) => document.getElementById(id);
  const out = { steps: [], shareCode: '' };
  const step = (name, value, pass) => out.steps.push([name, value, pass]);

  const boot = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };
  await boot(() => !!$('cfgTopic'), 10000);
  step('管理页已载入', document.title, /公告管理/.test(document.title));

  // 1) 分享码：只在 HTTP 下算得出来
  $('cfgRepo').value = 'Chen-ser/YangShan-schedule';
  $('cfgBranch').value = 'main';
  $('cfgPath').value = 'data/announcements.json';
  $('cfgTopic').value = tp;
  $('cfgTopic').dispatchEvent(new Event('change', { bubbles: true }));
  const code = await boot(() => $('shareCode').value.length > 0, 5000) ? $('shareCode').value : '';
  out.shareCode = code;
  step('分享码已生成', code.slice(0, 24) + '…', code.startsWith('YSA1-'));
  step('提示里给出了公告地址', $('shareHint').textContent, /data\/announcements\.json/.test($('shareHint').textContent));

  // 2) 表单 → 列表 → 待发布 JSON
  $('fTitle').value = 'E2E 管理页测试公告';
  $('fDate').value = '2026-10-16';
  $('fBody').value = '这条由 e2e-admin.mjs 加进去，不会真的提交。';
  $('fLevel').value = 'warn';
  $('fPinned').checked = true;
  $('btnAdd').click();
  await new Promise((r) => setTimeout(r, 200));
  const items = [...document.querySelectorAll('#list .ad-item')];
  step('列表里出现了这条', items.length, items.length === 1);
  step('列表里标题正确', items[0]?.textContent ?? '', /E2E 管理页测试公告/.test(items[0]?.textContent ?? ''));
  step('列表计数已更新', $('listCount')?.textContent ?? '', /1/.test($('listCount')?.textContent ?? ''));

  // 3) 没有令牌时，发布必须**干净地失败**，不能偷偷发出去
  $('cfgToken').value = '';
  $('btnPublish').click();
  await new Promise((r) => setTimeout(r, 300));
  step('没令牌时拒绝发布', $('pubHint')?.textContent ?? '', /令牌/.test($('pubHint')?.textContent ?? ''));

  // 4) 门铃按钮
  $('btnTestPush').click();
  return out;
};

// ---------------------------------------------------------------- 跑

const s = await openSession(`${base}/admin/`);
let result;
try {
  result = await s.evaluate(`(${probe.toString()})(${JSON.stringify(topic)})`);
  for (let i = 0; i < 24 && heard.length === 0; i++) await new Promise((r) => setTimeout(r, 500));
  try { await s.screenshot(join(ROOT, 'dist', '_shot-admin.png'), { width: 900, height: 1400 }); } catch (e) { console.log('截图失败（不影响结论）：' + e.message); }
} finally {
  await s.close();
  ac.abort();
  await sse.catch(() => {});
  server.close();
}

const steps = [...result.steps];

// 分享码必须能被**应用侧的解析器**吃下，且解出来的东西正好指向本次站点与频道。
// 生成端和解析端是两个文件，这条断言是它们之间的合同。
let decoded = null;
try { decoded = decodeAnnConfig(result.shareCode); } catch (e) { decoded = { err: e.message }; }
steps.push([`分享码解出的地址 = ${base}/data/announcements.json（跨模块合同）`, decoded?.url ?? decoded?.err, decoded?.url === `${base}/data/announcements.json`]);
steps.push([`分享码解出的频道 = ${topic}`, decoded?.topic ?? '', decoded?.topic === topic]);

steps.push([`点了「发一条测试推送」后 ntfy 上收到了门铃`, heard.length, heard.length >= 1]);
steps.push(['门铃不含公告内容（只有固定的 ASCII 串）', heard[0]?.slice(0, 90) ?? '(无)', heard.length > 0 && /"message":"new"/.test(heard[0])]);

let bad = 0;
for (const [k, v, pass] of steps) {
  const okFlag = pass === true; // 显式判据，没写 pass 算失败
  if (!okFlag) bad++;
  console.log(`  ${okFlag ? '✔' : '✗'} ${k}: ${Array.isArray(v) ? v.join(' | ') : v}`);
}
console.log(bad ? `\nE2E_FAIL ${bad} 项异常` : '\nE2E_OK 全部符合预期');
process.exit(bad ? 1 : 0);
