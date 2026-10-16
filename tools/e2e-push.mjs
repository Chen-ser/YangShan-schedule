// 端到端验证：从「管理员发一条推送」到「用户端自己刷新出公告」的完整链路。
//
// 跑法：node tools/e2e-push.mjs
// 前置：先 node web/build.mjs。需要能连 ntfy.sh（国内可能需要代理）。
//
// 这条链路分两半，各自单独都能测，合起来才是真功能：
//   - 「公告栏能不能拉到 JSON」 —— e2e-ann.mjs 测了；
//   - 「分享码能不能解出地址和频道」 —— test/run.mjs 测了；
// 但「推送响一声 → 应用真的去重拉一次」只有把两边接起来才算数。所以这里：
//   1. 起一个本地静态服务发 announcements.json，并且**记录被请求了几次**；
//   2. 用 YSA1- 分享码把地址和 ntfy 频道一起填进「我的 → 公告源」（走用户真会走的路径）；
//   3. 先确认此刻公告是空的；
//   4. 换掉服务器上的内容，往 ntfy 频道发一声「门铃」；
//   5. 断言：服务器请求数增加了（证明是推送唤起的重拉，不是别的定时器），
//      并且页面上真的多出了那条公告。
//
// 计数放在服务器侧而不是读页面里的时间戳 —— 页面内部状态可能因为别的原因变化，
// 「服务器被多请求了一次」才是推送生效的直接证据。
import { openSession } from './cdp.mjs';
import { createServer } from 'node:http';
import { existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encodeAnnConfig, randomTopic, ntfyPublishUrl } from '../core/model.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORE = join(ROOT, 'dist', '仰山课表.html');
if (!existsSync(CORE)) throw new Error('找不到 dist/仰山课表.html，先跑 node web/build.mjs');
console.log(`内核 ${(statSync(CORE).size / 1024).toFixed(1)} KB`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let hits = 0;
let payload = JSON.stringify({ announcements: [] });

const server = createServer((req, res) => {
  if (!req.url.startsWith('/announcements.json')) { res.writeHead(404); res.end(); return; }
  hits++;
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*', // 内核是 file:// 源（null），不给通配符跨不过去
    'cache-control': 'no-store',
  });
  res.end(payload);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const annUrl = `http://127.0.0.1:${server.address().port}/announcements.json`;
const topic = randomTopic('ys-e2e-push');
const shareCode = encodeAnnConfig({ url: annUrl, topic, name: 'e2e' });
console.log(`公告源 ${annUrl}\n频道   ${topic}`);

// ---------------------------------------------------------------- 页内探针

/** 第一阶段：填分享码 → 确认此刻是空的 → 报告 EventSource 已就绪。 */
const phase1 = async (src) => {
  const $ = (id) => document.getElementById(id);
  const out = { steps: [] };
  const step = (name, value, pass) => out.steps.push([name, value, pass]);

  const boot = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };
  await boot(() => document.documentElement.dataset.ready === '1', 15000);
  step('内核就绪', document.documentElement.dataset.ready, document.documentElement.dataset.ready === '1');

  document.querySelector('[data-view="me"]').click();
  // 故意用分享码而不是裸地址 —— 地址和频道是同一个码带进来的，这正是同学会粘的东西。
  $('setAnnUrl').value = src;
  $('btnSaveAnnUrl').click();

  const pulled = await boot(() => $('annSrcStatus') && /上次拉到/.test($('annSrcStatus').textContent), 10000);
  step('保存分享码后拉到了公告源', $('annSrcStatus')?.textContent ?? '(无)', pulled);

  document.querySelector('[data-view="ann"]').click();
  await new Promise((r) => setTimeout(r, 300));
  step('此刻公告为空', document.querySelectorAll('#annList .ann-item').length, document.querySelectorAll('#annList .ann-item').length === 0);

  return out;
};

/** 第二阶段：等门铃把自己叫醒。 */
const phase2 = async () => {
  const $ = (id) => document.getElementById(id);
  const out = { steps: [] };
  const step = (name, value, pass) => out.steps.push([name, value, pass]);

  const boot = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };

  const appeared = await boot(() => document.querySelectorAll('#annList .ann-item').length > 0, 30000);
  const items = [...document.querySelectorAll('#annList .ann-item')];
  step('推送后页面上出现了公告', items.length, appeared && items.length === 1);
  step('标题正确', items[0]?.querySelector('b')?.textContent ?? '', /E2E 推送测试/.test(items[0]?.querySelector('b')?.textContent ?? ''));
  step('是新公告（未读角标亮）', document.querySelectorAll('#annList .ann-item.unread').length, document.querySelectorAll('#annList .ann-item.unread').length === 1);
  return out;
};

// ---------------------------------------------------------------- 跑

const s = await openSession(pathToFileURL(CORE).href + '?demo=1');
const steps = [];
try {
  const r1 = await s.evaluate(`(${phase1.toString()})(${JSON.stringify(shareCode)})`);
  steps.push(...r1.steps);
  const hitsAfterFill = hits;
  steps.push(['填完分享码后服务器共被请求', hitsAfterFill, hitsAfterFill >= 1]);

  // 给 EventSource 一点时间连上，否则门铃会敲在空房间里。
  await sleep(3000);

  // 换内容 + 敲门铃
  payload = JSON.stringify({
    announcements: [{ id: 'e2e-push-1', title: 'E2E 推送测试', date: '2026-10-16', body: '由 e2e-push.mjs 发出。', level: 'info' }],
  });
  // 和管理页发的一模一样：全 ASCII 头 + 固定 ASCII 体。
  // 中文进 HTTP 头会被浏览器直接拒掉（Cannot convert argument to a ByteString），
  // 而且门铃本来就不该携带内容 —— 这条断言同时守着这两件事。
  const pub = await fetch(ntfyPublishUrl(topic), {
    method: 'PUT',
    headers: { Tags: 'loudspeaker' },
    body: 'new',
  }).catch((e) => ({ status: 'ERR ' + e.message }));
  steps.push([`门铃已发出（ntfy ${pub.status}）`, pub.status, pub.status === 200]);

  const r2 = await s.evaluate(`(${phase2.toString()})()`);
  steps.push(...r2.steps);
  steps.push(['推送确实触发了重拉（服务器请求数增加）', `${hitsAfterFill} → ${hits}`, hits > hitsAfterFill]);

  try { await s.screenshot(join(ROOT, 'dist', '_shot-push.png'), { width: 900, height: 1000 }); } catch (e) { console.log('截图失败（不影响结论）：' + e.message); }
} finally {
  await s.close();
  server.close();
}

let bad = 0;
for (const [k, v, pass] of steps) {
  // 显式布尔判据：没有传入 pass 的一律算失败，宁可误报也不放过。
  // （这里吃过亏：早先按「值是 false/''/0 才算失败」判，null 不在名单里，
  //   于是页面根本没加载时也能打印 OK。）
  const okFlag = pass === true;
  if (!okFlag) bad++;
  console.log(`  ${okFlag ? '✔' : '✗'} ${k}: ${Array.isArray(v) ? v.join(' | ') : v}`);
}
console.log(bad ? `\nE2E_FAIL ${bad} 项异常` : '\nE2E_OK 全部符合预期');
process.exit(bad ? 1 : 0);
