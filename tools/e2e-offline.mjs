// 验线上站点的**离线能力**。
//
// 跑法：node tools/e2e-offline.mjs   （需要 danger-full-access 起无头 Edge）
//
// 「Service Worker 注册成功」不等于「离线可用」—— 注册只是拿到一个对象，
// 真正决定离线能不能打开的是 install 里的 `caches.addAll` 有没有跑完、
// 以及再次访问时 SW 有没有接管（controller 非空）。
// 所以这里分两趟：第一趟等 SW 装完并数缓存条目，第二趟**断网重载**看还能不能启动。
import { openSession } from './cdp.mjs';

const SITE = 'https://chen-ser.github.io/YangShan-schedule/';

const phase1 = async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  const sw = await navigator.serviceWorker.getRegistration();
  out.registered = !!sw;
  for (let i = 0; i < 120; i++) {
    if (sw?.active?.state === 'activated') break;
    if (sw?.installing?.state === 'activated') break;
    await sleep(500);
  }
  out.activeState = sw?.active?.state ?? '(none)';
  out.caches = await caches.keys();
  for (const c of out.caches) {
    const keys = await (await caches.open(c)).keys();
    out['cache:' + c] = keys.length + ' 项';
  }
  out.controlled = !!navigator.serviceWorker.controller;
  return out;
};

const phase2 = async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  for (let i = 0; i < 400 && document.documentElement.dataset.ready !== '1'; i++) await sleep(50);
  out.ready = document.documentElement.dataset.ready;
  out.title = document.title;
  out.tabs = document.querySelectorAll('.tabbar .tab').length;
  out.controlled = !!navigator.serviceWorker.controller;
  return out;
};

const s = await openSession(SITE);
let ok = false;
try {
  console.log('=== 第一趟：等 Service Worker 装完 ===');
  const r1 = await s.evaluate(`(${phase1.toString()})()`, { timeoutMs: 180000 });
  for (const [k, v] of Object.entries(r1)) {
    console.log(`  ${k}: ${Array.isArray(v) ? (v.join(', ') || '(空)') : v}`);
  }
  const cacheCount = Number(String(r1['cache:' + (r1.caches?.[0] ?? '')] ?? '0').split(' ')[0]);
  if (!r1.registered) console.log('  ⚠ 没注册 SW —— 离线不会生效');

  console.log('\n=== 第二趟：断网重载 ===');
  await s.send('Network.enable');
  await s.send('Network.emulateNetworkConditions', {
    offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
  });
  await s.send('Page.enable');
  await s.send('Page.reload', { ignoreCache: false });
  await new Promise((r) => setTimeout(r, 1500));
  const r2 = await s.evaluate(`(${phase2.toString()})()`, { timeoutMs: 120000 });
  for (const [k, v] of Object.entries(r2)) console.log(`  ${k}: ${v}`);
  ok = r2.ready === '1' && r2.tabs === 6;
  console.log(ok
    ? `\nOFFLINE_OK 断网后仍能完整启动（缓存 ${cacheCount} 项）`
    : '\nOFFLINE_FAIL 断网后起不来');
} finally {
  await s.close();
}
process.exit(ok ? 0 : 1);
