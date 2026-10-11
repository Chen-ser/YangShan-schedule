// 端到端验证：待办 → 提醒 → .ics。
//
// 跑法：node tools/e2e-todos.mjs
// 前置：先 node web/build.mjs（构建会清空 dist/，本脚本读的是 dist/仰山课表.html）。
//
// 它验的是「导入作业后自动设置作业提醒」这条链路，而不是单元函数：
//   待办界面能加一条作业 → 设置里有截止提醒提前量 → 导出弹窗默认带上待办
//   → YangShan.toIcal() 产出的 .ics 里真的有这条作业、且带 VALARM。
import { openSession } from './cdp.mjs';
import { existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORE = join(ROOT, 'dist', '仰山课表.html');
if (!existsSync(CORE)) throw new Error('找不到 dist/仰山课表.html，先跑 node web/build.mjs');
console.log(`内核 ${(statSync(CORE).size / 1024).toFixed(1)} KB`);

const probe = async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (id) => document.getElementById(id);
  const out = { steps: [] };
  const step = (name, value) => out.steps.push([name, value]);

  for (let i = 0; i < 300 && document.documentElement.dataset.ready !== '1'; i++) {
    await sleep(50);
  }
  step('内核就绪', document.documentElement.dataset.ready);

  document.querySelector('[data-view="todo"]').click();
  step('切到待办', !$('view-todo').hidden);
  step('空态文案', $('todoList').querySelector('.empty b')?.textContent ?? '');

  $('btnAddTodo').click();
  step('弹窗标题', $('modalTitle').textContent);
  $('ntTitle').value = '高数作业第三章';
  $('ntKind').value = 'homework';
  const d = new Date(Date.now() + 90 * 60000);
  const p = (n) => String(n).padStart(2, '0');
  $('ntDue').value = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  $('modalFoot').children[1].click();
  await sleep(200);

  step('待办条数', document.querySelectorAll('#todoList .todo-item').length);
  step('待办标题', $('todoList').querySelector('.todo-item .ti b')?.textContent ?? '');
  step('待办倒计时', $('todoList').querySelector('.todo-item .cd')?.textContent ?? '');
  step('待办角标', $('badgeTodo').textContent + ($('badgeTodo').hidden ? '(隐藏)' : ''));

  document.querySelector('[data-view="me"]').click();
  step('设置里有截止提醒', !!$('setTodoAlarm'));
  step('默认截止提醒提前量', $('setTodoAlarm')?.value);
  step('默认不是「不提醒」', $('setTodoAlarm')?.value !== '0');

  $('btnExportIcs').click();
  await sleep(150);
  step('导出弹窗', $('modalTitle').textContent);
  step('导出勾选项', [...$('modalBody').querySelectorAll('.row span')].map((s) => s.textContent));
  step('默认带上待办', $('icsWithTodos')?.checked === true);
  step('待办提前量', $('icsTodoAlarm')?.value);

  const ics = globalThis.YangShan.toIcal({ calName: '测试', alarmMinutes: 15 });
  step('ics 事件数', (ics.match(/BEGIN:VEVENT/g) || []).length);
  step('含作业事件', ics.includes('SUMMARY:【作业】高数作业第三章'));
  step('含 1 天 VALARM', ics.includes('TRIGGER:-PT1440M'));
  step('含课程 15 分 VALARM', ics.includes('TRIGGER:-PT15M'));
  step('作业事件无 LOCATION', !/SUMMARY:【作业】[\s\S]{0,300}?LOCATION:/.test(ics));
  step('无裸 LF', !/[^\r]\n/.test(ics));
  step('ics 字节', ics.length);

  // 关掉待办导出后，课程应照常导出
  const onlyCourses = globalThis.YangShan.toIcal({ withTodos: false, calName: '只有课' });
  step('关掉后无作业', !onlyCourses.includes('【作业】'));
  step('关掉后仍有课', (onlyCourses.match(/BEGIN:VEVENT/g) || []).length > 0);

  step('摘要', JSON.stringify(globalThis.YangShan.summary()));
  return out;
};

const s = await openSession(pathToFileURL(CORE).href + '?demo=1');
let result;
try {
  result = await s.evaluate(`(${probe.toString()})()`);
  const png = join(ROOT, 'dist', '_shot-export.png');
  try { await s.screenshot(png, { width: 900, height: 1000 }); } catch (e) { console.log('截图失败（不影响结论）：' + e.message); }
} finally {
  await s.close();
}

let bad = 0;
for (const [k, v] of result.steps) {
  const flag = v === false || v === '' || v === 0 ? '✗' : '✔';
  if (flag === '✗') bad++;
  console.log(`  ${flag} ${k}: ${Array.isArray(v) ? v.join(' | ') : v}`);
}
console.log(bad ? `\nE2E_FAIL ${bad} 项异常` : '\nE2E_OK 全部符合预期');
process.exit(bad ? 1 : 0);
