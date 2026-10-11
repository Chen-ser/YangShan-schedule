// 线上站点端到端验证：用真浏览器打开 GitHub Pages 上的 PWA，确认它真的能跑起来。
//
// 跑法：node tools/e2e-live.mjs
// ★ 需要 danger-full-access：无头 Edge 在 workspace-write 下起不来
//   （mojo platform_channel 拒绝访问）。
//
// 它验的不是「文件能下载」，而是「部署出去的那份东西在浏览器里真的成了一个应用」：
// 内核启动（data-ready）、五个视图渲染、Service Worker 注册并建立缓存、
// manifest 可安装、OCR 资产按相对路径解析得到。
import { openSession } from './cdp.mjs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://chen-ser.github.io/YangShan-schedule/';

const probe = async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { steps: [] };
  const step = (name, value) => out.steps.push([name, value]);

  step('文档标题', document.title);
  step('初始 location', location.href);

  // 内核启动标志：main() 跑完最后一行才设 data-ready
  for (let i = 0; i < 400 && document.documentElement.dataset.ready !== '1'; i++) await sleep(50);
  step('内核已启动（data-ready）', document.documentElement.dataset.ready);
  if (document.documentElement.dataset.ready !== '1') return out;

  // 五个视图的标签栏
  const tabs = [...document.querySelectorAll('.tabbar .tab')].map((b) => b.textContent.replace(/\d+$/, '').trim());
  step('视图标签', tabs.join(' / '));
  step('标签数量是 5', tabs.length === 5);

  // 没有课表时应弹出引导
  step('首次进入显示引导', document.getElementById('onboard')?.classList.contains('open') === true);
  step('引导里有导入入口', !!document.querySelector('#onboard .primary-btn, #onboard button'));

  // 版本号真的渲染出来了（说明 app.js 执行到了底）
  const about = document.getElementById('aboutBox')?.textContent ?? '';
  step('关于里的版本号', (about.match(/v[\d.]+/) ?? ['-'])[0]);

  // Service Worker：注册 + 缓存
  let sw = null;
  try { sw = await navigator.serviceWorker.getRegistration(); } catch (e) { step('SW 注册抛错', e.message); }
  step('Service Worker 已注册', !!sw);
  if (sw) step('SW 作用域', sw.scope);
  let cacheNames = [];
  try { cacheNames = await caches.keys(); } catch { /* 忽略 */ }
  step('已建立的缓存', cacheNames.join(', ') || '(暂无)');

  // manifest 能不能装
  try {
    const href = document.querySelector('link[rel="manifest"]')?.href ?? '';
    step('manifest 链接', href);
    const m = await (await fetch(href)).json();
    step('manifest start_url', m.start_url);
    step('manifest 图标数', (m.icons ?? []).length);
    step('manifest display=standalone', m.display === 'standalone');
  } catch (e) {
    step('manifest 读取失败', e.message);
  }

  // OCR 资产按**相对路径**解析 —— 这正是子路径部署最容易挂的地方
  try {
    const r = await fetch('ocr/worker.min.js', { method: 'HEAD' });
    step('OCR worker 相对路径可达', r.status === 200);
  } catch (e) {
    step('OCR 资产失败', e.message);
  }
  try {
    const r = await fetch('sw.js', { method: 'HEAD' });
    step('sw.js 相对路径可达', r.status === 200);
  } catch (e) {
    step('sw.js 失败', e.message);
  }

  // 本地存储可写（离线数据落在这里）
  try {
    localStorage.setItem('__probe', '1');
    localStorage.removeItem('__probe');
    step('localStorage 可写', true);
  } catch {
    step('localStorage 可写', false);
  }
  return out;
};

console.log(`打开 ${SITE}`);
const s = await openSession(SITE);
let result;
try {
  result = await s.evaluate(`(${probe.toString()})()`, { timeoutMs: 180000 });
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
for (const [k, v] of result.steps) {
  const flag = v === false || v === '' || v === 0 || v === undefined ? '✗' : '✔';
  if (flag === '✗') bad++;
  console.log(`  ${flag} ${k}: ${v}`);
}
console.log(bad ? `\nLIVE_FAIL ${bad} 项异常` : '\nLIVE_OK 线上站点在真浏览器里完整可用');
process.exit(bad ? 1 : 0);
