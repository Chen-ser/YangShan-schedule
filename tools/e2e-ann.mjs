// 端到端验证：公告栏 + 共享通知。
//
// 跑法：node tools/e2e-ann.mjs
// 前置：先 node web/build.mjs（构建会清空 dist/）。
//
// 这一条链路光靠单元测试测不出来 —— normalizeAnnouncements 好测，
// 「填了地址之后页面上真的出现那几条通知、未读角标真的亮、点开真的能看到正文」
// 只能在真页面里点出来。所以这里起一个本地 HTTP 服务把 examples/announcements.json
// 发出去（带 CORS 头，因为页面是 file:// 源），再走用户真正会走的路径：
// 「我的 → 公告源」填地址 → 保存并刷新 → 切到公告页。
import { openSession } from './cdp.mjs';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORE = join(ROOT, 'dist', '仰山课表.html');
const EXAMPLE = join(ROOT, 'examples', 'announcements.json');
if (!existsSync(CORE)) throw new Error('找不到 dist/仰山课表.html，先跑 node web/build.mjs');
console.log(`内核 ${(statSync(CORE).size / 1024).toFixed(1)} KB`);

// 只发一份文件的最小静态服务 —— 顺带证明 README 里说的
// 「把这份 JSON 放到任意静态托管上就行」这条路真的通。
const payload = readFileSync(EXAMPLE);
const server = createServer((req, res) => {
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    // 页面是 file:// 源，浏览器把它当成 "null" 源 —— 不给通配符就跨不过去。
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  });
  res.end(payload);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const annUrl = `http://127.0.0.1:${server.address().port}/announcements.json`;
console.log(`公告源 ${annUrl}`);

const probe = async (src) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (id) => document.getElementById(id);
  const out = { steps: [] };
  const step = (name, value) => out.steps.push([name, value]);

  for (let i = 0; i < 300 && document.documentElement.dataset.ready !== '1'; i++) await sleep(50);
  step('内核就绪', document.documentElement.dataset.ready);

  // 走用户真正会走的路径，不直接改 localStorage —— 顺便验证「保存并刷新」这个按钮真的管用。
  document.querySelector('[data-view="me"]').click();
  $('setAnnUrl').value = src;
  $('btnSaveAnnUrl').click();

  document.querySelector('[data-view="ann"]').click();
  for (let i = 0; i < 160 && !document.querySelector('#annList .ann-item'); i++) await sleep(50);

  const items = [...document.querySelectorAll('#annList .ann-item')];
  step('公告条数', items.length);
  step('第一条标题', items[0]?.querySelector('b')?.textContent ?? '');
  step('置顶排最前', /期中考试/.test(items[0]?.textContent ?? ''));
  step('三档 level 都有', ['urgent', 'warn', 'info'].every((lv) => document.querySelector(`#annList .ann-item.lv-${lv}`)));
  step('三条都是未读', document.querySelectorAll('#annList .ann-item.unread').length);
  const badgeBefore = $('badgeAnn')?.hidden === false ? Number($('badgeAnn').textContent) : 0;
  step('未读角标', badgeBefore);

  items[0].click();
  await sleep(200);
  step('详情弹窗', $('modalTitle')?.textContent ?? '');
  step('正文渲染了 Markdown', !!$('modalBody').querySelector('strong, li'));
  step('弹窗里有相关链接', !!$('modalBody').querySelector('a[href^="http"]'));
  $('modalFoot').children[$('modalFoot').children.length - 1]?.click();
  // 公告详情弹窗没有底部按钮（只读内容，不需要动作），用右上角的 ✕ 关。
  if ($('modal').classList.contains('open')) $('modalClose').click();
  await sleep(200);
  step('读之前角标是 3', badgeBefore === 3);
  step('读一条后角标减到 2', $('badgeAnn')?.hidden === false ? $('badgeAnn').textContent : '(隐藏)');
  step('读过那条不再标未读', document.querySelectorAll('#annList .ann-item.unread').length === 2);

  // 「我的 → 格式示例」：示例内容来自构建时注入的 examples/announcements.json。
  // 断言它和磁盘上那份同源（id 一致），杜绝「示例与解析器各写一份」的漂移。
  document.querySelector('[data-view="me"]').click();
  step('有格式示例按钮', !!$('btnAnnExample'));
  $('btnAnnExample').click();
  await sleep(200);
  step('示例弹窗标题', $('modalTitle')?.textContent ?? '');
  const box = $('modalBody').querySelector('.code-box')?.textContent ?? '';
  step('示例里有注入的真 id', box.includes('2026-10-09-exam'));
  step('示例是合法 JSON', (() => { try { return !!JSON.parse(box); } catch { return false; } })());
  step('示例可被解析器吃下', (() => { try { return JSON.parse(box).announcements.length; } catch { return 0; } })());
  return out;
};

const s = await openSession(pathToFileURL(CORE).href + '?demo=1');
let result;
try {
  result = await s.evaluate(`(${probe.toString()})(${JSON.stringify(annUrl)})`);
  try { await s.screenshot(join(ROOT, 'dist', '_shot-ann.png'), { width: 900, height: 1000 }); } catch (e) { console.log('截图失败（不影响结论）：' + e.message); }
} finally {
  await s.close();
  server.close();
}

let bad = 0;
for (const [k, v] of result.steps) {
  // 显式布尔判据，没写 pass 的一律算失败。
  // （早先这里按「值是 false/''/0 才算失败」判，null 不在名单里 ——
  //   页面根本没加载时 data-ready 是 null，照样打印 OK。同一坑在 e2e-live 也踩过一次。）
  const pass = v !== false && v !== '' && v !== 0 && v !== null && v !== undefined;
  if (!pass) bad++;
  console.log(`  ${pass ? '✔' : '✗'} ${k}: ${Array.isArray(v) ? v.join(' | ') : v}`);
}
console.log(bad ? `\nE2E_FAIL ${bad} 项异常` : '\nE2E_OK 全部符合预期');
process.exit(bad ? 1 : 0);
