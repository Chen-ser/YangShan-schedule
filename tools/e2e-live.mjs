// 线上站点端到端验证：用真浏览器打开 GitHub Pages 上的 PWA，确认它真的能跑起来。
//
// 跑法：node tools/e2e-live.mjs
// ★ 需要能起本机 Edge（workspace-write 沙箱下起不来：mojo platform_channel 拒绝访问）。
//
// 它验的不是「文件能下载」，而是「部署出去的那份东西在浏览器里真的成了一个应用」：
// 页面真的加载了、内核启动（data-ready）、五个视图渲染、Service Worker 注册并建立缓存、
// manifest 可安装、OCR 资产按相对路径解析得到。
//
// ★★ 判据纪律（2026-10-15 修）★★
//   每条检查必须带**显式布尔断言**，不能靠「值是不是假值」反推。
//   旧版写成 `v === false || v === '' || v === 0 || v === undefined ? '✗' : '✔'`，
//   于是 `null`、以及错误页的标题/location 这些**非空字符串**全被判成 ✔ ——
//   网络断掉时浏览器停在 `chrome-error://chromewebdata/`，工具照样打印 LIVE_OK。
//   现改为：断言写在 step 的第三个参数里；没写断言的一律算失败（fail-closed）。
import { openSession } from './cdp.mjs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://chen-ser.github.io/YangShan-schedule/';
const TITLE_NEEDLE = '仰山课表';

const probe = async (site, needle) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { steps: [] };

  // 每条检查：[名字, 显示值, 断言结果]。断言必须是显式布尔值。
  const step = (name, value, pass) => {
    out.steps.push([name, value, pass === true]);
  };
  const isErrorPage = () =>
    location.protocol === 'chrome-error:' ||
    document.title === new URL(site).host ||
    document.body?.querySelector('#main-frame-error, .error-code') != null;

  // ---- 门槛 1：页面真的加载了（不是 Edge 的错误页） ----
  step('页面已加载（非错误页）', location.href, !isErrorPage());
  step('文档标题', document.title, document.title.includes(needle));
  step('实际地址在本站下', location.href, location.href.startsWith(site));
  if (isErrorPage()) return out; // 后面全都没意义，直接收工（不写断言 = 失败）

  // ---- 门槛 2：内核启动（main() 跑完最后一行才设 data-ready） ----
  for (let i = 0; i < 400 && document.documentElement.dataset.ready !== '1'; i++) await sleep(50);
  step('内核已启动（data-ready）', document.documentElement.dataset.ready, document.documentElement.dataset.ready === '1');
  if (document.documentElement.dataset.ready !== '1') return out;

  // ---- 五个视图的标签栏 ----
  const tabs = [...document.querySelectorAll('.tabbar .tab')].map((b) => b.textContent.replace(/\d+$/, '').trim());
  step('视图标签', tabs.join(' / '), tabs.length === 5);
  step('标签是课表/逐日/待办/公告/我的',
    tabs.join(','), ['课表', '逐日', '待办', '公告', '我的'].every((t, i) => tabs[i] === t));

  // ---- 没有课表时应弹出引导 ----
  step('首次进入显示引导', String(document.getElementById('onboard')?.classList.contains('open')),
    document.getElementById('onboard')?.classList.contains('open') === true);
  step('引导里有导入入口', String(!!document.querySelector('#onboard .primary-btn, #onboard button')),
    !!document.querySelector('#onboard .primary-btn, #onboard button'));

  // ---- 版本号真的渲染出来了（说明 app.js 执行到了底） ----
  const about = document.getElementById('aboutBox')?.textContent ?? '';
  const ver = (about.match(/v[\d.]+/) ?? ['-'])[0];
  step('关于里的版本号', ver, /^v\d/.test(ver));

  // ---- 品牌图真的在页面上（2026-10-15 并入品牌资源后新增） ----
  const logos = [...document.querySelectorAll('img[src^="data:image/"]')];
  step('内联品牌图数量', String(logos.length), logos.length >= 1);
  step('内联图都已解码成功',
    logos.map((i) => i.naturalWidth).join(','),
    logos.length > 0 && logos.every((i) => i.naturalWidth > 0));

  // ---- Service Worker：注册 + 缓存 ----
  let sw = null;
  try { sw = await navigator.serviceWorker.getRegistration(); } catch (e) { step('SW 注册抛错', e.message, false); }
  step('Service Worker 已注册', String(!!sw), !!sw);
  if (sw) step('SW 作用域', sw.scope, sw.scope.startsWith(site));
  // 缓存是 SW 在 install 事件里**异步**填的，注册刚 resolve 时它常常还是空的。
  // 直接读会撞竞态（明明正常却报「暂无」），所以轮询等一会儿。
  let cacheNames = [];
  for (let i = 0; i < 100; i++) {
    try { cacheNames = await caches.keys(); } catch { /* 忽略 */ }
    if (cacheNames.length) break;
    await sleep(100);
  }
  step('已建立的缓存（等待 SW 填充）', cacheNames.join(', ') || '(等 10s 仍为空)', cacheNames.length > 0);

  // ---- manifest 能不能装 ----
  try {
    const href = document.querySelector('link[rel="manifest"]')?.href ?? '';
    step('manifest 链接', href, href.startsWith(site));
    const m = await (await fetch(href)).json();
    step('manifest start_url', m.start_url, !!m.start_url);
    step('manifest 图标数', String((m.icons ?? []).length), (m.icons ?? []).length > 0);
    step('manifest display=standalone', String(m.display), m.display === 'standalone');
  } catch (e) {
    step('manifest 读取失败', e.message, false);
  }

  // ---- OCR 资产按**相对路径**解析 —— 这正是子路径部署最容易挂的地方 ----
  for (const asset of ['ocr/worker.min.js', 'sw.js', 'manifest.webmanifest']) {
    try {
      const r = await fetch(asset, { method: 'HEAD' });
      step(`${asset} 相对路径可达`, `HTTP ${r.status}`, r.status === 200);
    } catch (e) {
      step(`${asset} 相对路径可达`, e.message, false);
    }
  }

  // ---- 本地存储可写（离线数据落在这里） ----
  try {
    localStorage.setItem('__probe', '1');
    localStorage.removeItem('__probe');
    step('localStorage 可写', 'true', true);
  } catch (e) {
    step('localStorage 可写', e.message, false);
  }
  return out;
};

// 默认让 Edge 走系统代理（跟用户真实打开时一样）；加 --direct 强制直连，
// 用来区分「站点坏了」和「本机代理到不了 GitHub」。
const DIRECT = process.argv.includes('--direct');
console.log(`打开 ${SITE}${DIRECT ? '（--direct：绕过系统代理，直接连）' : '（走系统代理，同用户真实环境）'}`);
const s = await openSession(SITE, DIRECT ? ['--no-proxy-server'] : []);
let result;
try {
  result = await s.evaluate(`(${probe.toString()})(${JSON.stringify(SITE)}, ${JSON.stringify(TITLE_NEEDLE)})`, { timeoutMs: 180000 });
  const png = join(ROOT, 'dist', '_shot-live.png');
  try {
    const n = await s.screenshot(png, { width: 420, height: 900 });
    console.log(`截图已存 ${png}（${(n / 1024).toFixed(0)} KB，手机尺寸 420×900）`);
  } catch (e) {
    console.log('截图失败（不影响结论）：' + e.message);
  }
} finally {
  await s.close();
}

let bad = 0;
for (const [k, v, pass] of result.steps) {
  // fail-closed：断言必须显式为 true 才算过
  const flag = pass === true ? '✔' : '✗';
  if (flag === '✗') bad++;
  console.log(`  ${flag} ${k}: ${v}`);
}
if (bad) {
  console.log(`\nLIVE_FAIL ${bad} 项异常`);
  console.log(' 提示：若是「页面已加载」这条挂了，先看浏览器是不是卡在代理上（系统代理不可达时 Edge 停在 chrome-error 页）。');
} else {
  console.log('\nLIVE_OK 线上站点在真浏览器里完整可用');
}
process.exit(bad ? 1 : 0);
