// 仰山课表 · 网页内核
//
// 这个文件被 web/build.mjs 内联进单文件 HTML，运行在三种环境里：
//   1. file:// 双击打开（没有 Service Worker、没有 fetch 跨域）
//   2. 静态托管的 PWA（有 SW，可离线安装到桌面）
//   3. 各平台壳的 WebView 里
// 所以这里**不许引用任何外部资源**，也不许假设自己一定跑在 http(s) 上。

// ================================================================ 常量

const VERSION = '__VERSION__';
const LS_KEY = 'yangshan-schedule/v1';
const DEFAULT_SETTINGS = {
  alarm: 15,
  todoAlarm: 30,   // 作业/网课/考试截止前多少分钟提醒
  inApp: false,
  theme: 'auto',
  font: 100,
  hideWeekend: false,
  annUrl: '',
  // ntfy 频道名，来自「公告分享码」。空则只定时轮询、不订阅推送。
  annTopic: '',
  // 收到新公告时弹不弹系统通知（默认关：未经用户同意就弹窗是很讨嫌的行为）
  annNotify: false,
};

// ================================================================ 工具

const $ = (id) => document.getElementById(id);

/** 极简 DOM 构造器 —— 全程不走 innerHTML，避免把教务系统返回的课程名当 HTML 执行。 */
function h(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v; // 只用于我们自己生成的 Markdown
    else if (k === 'style') Object.assign(node.style, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function toast(msg, ms = 2400) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

/** 同一门课永远同一个颜色 —— 靠课程名的散列，而不是渲染顺序。 */
function colorOf(name) {
  return 'c' + (parseInt(fnv1a64(String(name ?? '')).slice(-2), 16) % 8);
}

function download(filename, content, mime = 'text/plain;charset=utf-8') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // file:// 或非安全上下文下 clipboard 可能被拒 → 退回 execCommand
    try {
      const ta = h('textarea', { style: { position: 'fixed', top: '-1000px' } });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

const cnDate = (iso) => {
  if (!iso) return '';
  const [, m, d] = String(iso).split('-');
  return `${Number(m)}月${Number(d)}日`;
};

// ================================================================ 状态

let state = {
  schedule: null,
  todos: [],
  readAnnouncements: [],
  announcements: [],
  // 只在本机生效的私公告（导入的文件 / 手填的表单）。永远不上传，也永远不参与分享。
  localAnnouncements: [],
  announcementsFetchedAt: '',
  settings: { ...DEFAULT_SETTINGS },
};

let ui = {
  view: 'week',
  week: null,      // 当前显示的教学周
  day: todayISO(), // 逐日视图的日期
};

function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return false;
    const o = JSON.parse(raw);
    state = {
      schedule: o.schedule ?? null,
      todos: Array.isArray(o.todos) ? o.todos : [],
      readAnnouncements: Array.isArray(o.readAnnouncements) ? o.readAnnouncements : [],
      announcements: Array.isArray(o.announcements) ? o.announcements : [],
      localAnnouncements: Array.isArray(o.localAnnouncements) ? o.localAnnouncements : [],
      announcementsFetchedAt: o.announcementsFetchedAt ?? '',
      settings: { ...DEFAULT_SETTINGS, ...(o.settings ?? {}) },
    };
    if (state.schedule) {
      // 重新展开一遍：万一课表是从旧版本存下来的，保证和当前核心逻辑一致
      state.schedule = normalizeSchedulePack(state.schedule);
    }
    return true;
  } catch (e) {
    console.warn('读取本地数据失败', e);
    return false;
  }
}

function saveState() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
    localStorage.setItem(LS_KEY + '/updatedAt', String(Date.now()));
  } catch (e) {
    // iOS 上 Safari 可能因为存储配额清理 localStorage，也会在无痕模式下直接抛错
    toast('保存失败：浏览器存储不可用。建议立刻导出备份。', 5000);
    console.warn('保存本地数据失败', e);
  }
}

// ================================================================ 视图切换

function switchView(name) {
  ui.view = name;
  for (const v of document.querySelectorAll('.view')) {
    v.hidden = v.id !== `view-${name}`;
  }
  for (const b of document.querySelectorAll('.tab')) {
    b.classList.toggle('active', b.dataset.view === name);
  }
  if (name === 'week') renderWeek();
  if (name === 'day') renderDay();
  if (name === 'todo') renderTodos();
  if (name === 'ann') renderAnnouncements();
}

// ================================================================ 周课表

function renderHeader() {
  const s = state.schedule;
  $('termLabel').textContent = s
    ? `${parseTermCode(s.termCode).label}${s.studentCode ? ' · ' + s.studentCode : ''}`
    : '尚未导入课表';
}

function renderNowCard() {
  const box = $('nowCard');
  box.replaceChildren();
  if (!state.schedule?.events?.length) return;

  const r = nextClass(state.schedule.events);
  if (r.status === 'none') {
    box.className = 'nowcard done';
    box.append(h('div', { class: 'nc-tag' }, '本学期的课都上完了'), h('div', { class: 'nc-name' }, '假期愉快'));
    return;
  }

  const e = r.event;
  box.className = 'nowcard';
  const isToday = e.date === todayISO();

  const head =
    r.status === 'ongoing'
      ? '正在上课'
      : isToday
        ? r.minutesUntil != null && r.minutesUntil <= 120
          ? `${r.minutesUntil} 分钟后上课`
          : '今天下一节'
        : `${cnDate(e.date)} 周${WEEKDAY_NAMES[e.dayOfWeek - 1]} 下一节`;

  const meta = [
    `${e.start}–${e.end}`,
    e.location || '地点未定',
    e.teacher || '',
  ].filter(Boolean).join(' · ');

  box.append(
    h('div', { class: 'nc-tag' }, head),
    h('div', { class: 'nc-name' }, e.course),
    h('div', { class: 'nc-meta' }, meta),
  );
}

function currentWeekNumber() {
  const weeks = state.schedule?.termWeeks ?? [];
  if (!weeks.length) return 1;
  return weekOfDate(weeks, todayISO()) ?? weeks[0].serialNumber;
}

function renderWeek() {
  renderHeader();
  renderNowCard();
  if (!state.schedule) return;

  const weeks = state.schedule.termWeeks ?? [];
  if (!weeks.length) return;

  if (ui.week == null) ui.week = currentWeekNumber();
  const idx = Math.max(0, weeks.findIndex((w) => w.serialNumber === ui.week));
  const w = weeks[idx];
  ui.week = w.serialNumber;

  const nums = weeks.map((x) => x.serialNumber);
  const first = nums[0];
  const last = nums[nums.length - 1];
  const thisWeek = currentWeekNumber();
  $('weekLabelMain').textContent =
    `第 ${w.serialNumber} 周` + (w.serialNumber === thisWeek ? '（本周）' : '');
  $('weekLabelDate').textContent =
    `${cnDate(w.startDate)}–${cnDate(w.endDate ?? addDays(w.startDate, 6))}`;
  $('weekLabel').title = `第 ${w.serialNumber} 周 · 点这里跳到指定周`;
  $('weekPrev').disabled = w.serialNumber <= first;
  $('weekNext').disabled = w.serialNumber >= last;

  const hideWeekend = state.settings.hideWeekend;
  const dayCount = hideWeekend ? 5 : 7;
  const today = todayISO();
  const dates = Array.from({ length: dayCount }, (_, i) => addDays(w.startDate, i));

  // ---- 表头
  const head = $('gridHead');
  head.style.setProperty('--days', dayCount);
  head.replaceChildren(h('div', { class: 'gh-cell' }, ''));
  dates.forEach((d, i) => {
    const isToday = d === today;
    head.append(
      h('div', { class: 'gh-cell' + (isToday ? ' today' : '') },
        h('b', {}, '周' + WEEKDAY_NAMES[i]),
        cnDate(d)),
    );
  });

  // ---- 找出这一周实际用到的节次范围，只渲染这一段，避免大片空白
  const list = state.schedule.events.filter((e) => e.week === w.serialNumber && (!hideWeekend || e.dayOfWeek <= 5));
  let rowStart = 1;
  let rowEnd = 13;
  if (list.length) {
    rowStart = Math.min(...list.map((e) => e.beginSection));
    rowEnd = Math.max(...list.map((e) => e.endSection));
  }
  const rowCount = rowEnd - rowStart + 1;

  const body = $('gridBody');
  body.style.setProperty('--days', dayCount);
  body.style.gridTemplateRows = `repeat(${rowCount}, 46px)`;
  body.replaceChildren();

  // 背景格子（提供网格线与"今天"底色）
  for (let s = rowStart; s <= rowEnd; s++) {
    const gridRow = s - rowStart + 1;
    body.append(h('div', {
      class: 'gd-time',
      style: { gridColumn: '1', gridRow: String(gridRow) },
    },
      h('span', {}, String(s)),
      h('span', {}, (SECTION_TIMES[s - 1]?.start ?? '').slice(0, 5)),
    ));
    for (let i = 0; i < dayCount; i++) {
      body.append(h('div', {
        class: 'gd-cell' + (dates[i] === today ? ' today' : ''),
        style: { gridColumn: String(i + 2), gridRow: String(gridRow) },
      }));
    }
  }

  // 课程块：与背景格子放在同一个 grid 里，靠 grid-row/grid-column 定位
  for (const e of list) {
    const col = e.dayOfWeek + 1;
    body.append(
      h('div', {
        class: 'course ' + colorOf(e.course),
        style: {
          gridColumn: String(col),
          gridRow: `${e.beginSection - rowStart + 1} / ${e.endSection - rowStart + 2}`,
          zIndex: '1',
        },
        title: `${e.course}\n${e.location || ''}\n${e.teacher || ''}`,
        onclick: () => showCourseDetail(e),
      },
        h('b', {}, e.course),
        e.location ? h('i', {}, e.location) : null,
        h('span', { class: 'ct' }, `${e.beginSection}-${e.endSection}节`),
      ),
    );
  }

  if (!list.length) {
    body.style.gridTemplateRows = '';
    body.replaceChildren(
      h('div', { class: 'empty', style: { gridColumn: `1 / -1`, padding: '32px 12px' } },
        h('b', {}, '这周没有课'),
        '点上面的 ‹ › 换一周看看，或者确认一下导入的是不是当前学期。'),
    );
  }

  renderLegend(list);
  renderUnscheduled();
}

/**
 * 未安排时间的课。
 *
 * 教务响应里 `datas.notArrangeList` 与 `datas.arrangedList` 平级，装的是**已选上但还没排进课表**
 * 的课（本人样本 5 门、共 7 学分：军训、大学生安全知识教育、大学生职业规划、艺术导论、智能制造…）。
 * 它们没有星期/节次/教室，做不出任何事件和提醒，所以只能单独列出来。
 * 不列的话学生会拿这份课表去算学分，然后发现少了一大截。
 */
function renderUnscheduled() {
  const box = $('unscheduled');
  const list = state.schedule?.unscheduled ?? [];
  box.replaceChildren();
  if (!list.length) return;

  const credits = list.reduce((s, c) => s + (parseFloat(c.credit) || 0), 0);
  const creditText = credits ? ` · 共 ${credits % 1 === 0 ? credits : credits.toFixed(1)} 学分` : '';

  box.append(
    h('button', { class: 'notice', onclick: () => modalUnscheduled(list) },
      h('b', {}, `还有 ${list.length} 门课没排上课表${creditText}`),
      h('span', {}, '军训、网课这类通常晚些才出时间，点开看是哪几门 ›'),
    ),
  );
}

/**
 * teachingTarget 是「面向哪些专业」的全量清单，真实数据里一条能列 13 个专业、
 * 上百字。原样铺开会把弹窗撑成一面墙，把真正有用的学分/周次挤没。
 * 只留前两个，其余折成「等 N 个专业」。
 */
function shortTarget(s) {
  const all = String(s || '').split(/[,，]/).map((x) => x.trim()).filter(Boolean);
  if (all.length <= 2) return all.join('、');
  return `${all[0]}、${all[1]} 等 ${all.length} 个专业`;
}

function modalUnscheduled(list) {
  const rows = list.map((c) =>
    h('div', { class: 'unsched-item' },
      h('div', { class: 'ui-head' },
        h('b', {}, c.courseName || '未命名课程'),
        c.credit ? h('span', { class: 'pill' }, `${c.credit} 学分`) : null,
      ),
      h('p', { class: 'muted small' },
        [
          c.weeks.length ? `第 ${c.weeks[0]}–${c.weeks[c.weeks.length - 1]} 周` : '',
          c.teachers.length ? c.teachers.join('、') : '',
          c.courseCode || '',
        ].filter(Boolean).join(' · '),
      ),
      c.teachingTarget ? h('p', { class: 'muted small' }, '面向：' + shortTarget(c.teachingTarget)) : null,
    ),
  );

  openModal(`未排课的 ${list.length} 门`, [
    h('p', { class: 'muted small' },
      '这些课已经选上了，但教务系统还没给出上课时间，所以进不了课表和提醒。' +
      '等出时间后回「我的 → 同步课表」重新导入，它们就会自动出现在课表里。'),
    ...rows,
  ], [{ label: '知道了' }]);
}

function renderLegend(list) {
  const box = $('legend');
  const names = [...new Set((list ?? []).map((e) => e.course))];
  box.replaceChildren();
  if (names.length < 2) return;
  for (const n of names) {
    box.append(h('span', {}, h('i', { class: colorOf(n), style: { background: `var(--${colorOf(n)})` } }), n));
  }
}

function showCourseDetail(e) {
  openModal(e.course, [
    h('div', { class: 'row' }, h('span', {}, '时间'), h('b', {}, `${e.date} ${e.start}–${e.end}`)),
    h('div', { class: 'row' }, h('span', {}, '周次'), h('b', {}, `第 ${e.week} 周 周${WEEKDAY_NAMES[e.dayOfWeek - 1]}`)),
    h('div', { class: 'row' }, h('span', {}, '节次'), h('b', {}, `${e.beginSection}-${e.endSection} 节`)),
    h('div', { class: 'row' }, h('span', {}, '地点'), h('b', {}, e.location || '未定')),
    h('div', { class: 'row' }, h('span', {}, '教师'), h('b', {}, e.teacher || '未定')),
    e.teachingTarget ? h('div', { class: 'row' }, h('span', {}, '教学班'), h('b', {}, e.teachingTarget)) : null,
  ], []);
}

// ================================================================ 逐日

function renderDay() {
  const box = $('dayList');
  $('dayPicker').value = ui.day;
  box.replaceChildren();

  if (!state.schedule) {
    box.append(h('div', { class: 'empty' }, h('b', {}, '还没有课表'), '先在「我的 → 导入课表」里导入。'));
    return;
  }

  const list = state.schedule.events.filter((e) => e.date === ui.day);
  const wk = weekOfDate(state.schedule.termWeeks, ui.day);
  const head = h('div', { class: 'sec-head' },
    h('h2', {}, `${cnDate(ui.day)} 周${WEEKDAY_NAMES[weekdayOf(ui.day) - 1]}`),
    h('span', { class: 'muted small' }, wk ? `第 ${wk} 周` : '不在学期内'),
  );
  box.append(head);

  if (!list.length) {
    box.append(h('div', { class: 'empty' }, h('b', {}, '这天没课')));
    return;
  }

  for (const e of list) {
    box.append(
      h('div', { class: 'dayitem ' + colorOf(e.course), onclick: () => showCourseDetail(e) },
        h('div', { class: 'dt' }, h('b', {}, e.start), e.end.slice(0, 5)),
        h('div', { class: 'di' },
          h('b', {}, e.course),
          h('p', {}, [e.location, e.teacher, `${e.beginSection}-${e.endSection}节`].filter(Boolean).join(' · ')),
        ),
      ),
    );
  }
}

// ================================================================ 待办

function renderTodos() {
  const box = $('todoList');
  box.replaceChildren();
  const list = state.todos;

  if (!list.length) {
    box.append(h('div', { class: 'empty' }, h('b', {}, '没有待办'),
      '作业、网课截止时间可以手动加，也可以把通知文本粘进来自动识别。'));
  }

  for (const td of list) {
    const cd = todoCountdown(td.due);
    let cdText = '';
    let cdClass = 'ok';
    if (cd) {
      if (cd.overdue) { cdText = `已过期 ${cd.days ? cd.days + ' 天' : cd.hours ? cd.hours + ' 小时' : cd.minutes + ' 分钟'}`; cdClass = 'over'; }
      else if (cd.days > 0) { cdText = `还剩 ${cd.days} 天`; cdClass = cd.days <= 3 ? 'soon' : 'ok'; }
      else if (cd.hours > 0) { cdText = `还剩 ${cd.hours} 小时`; cdClass = 'soon'; }
      else { cdText = `还剩 ${cd.minutes} 分钟`; cdClass = 'soon'; }
    }

    box.append(
      h('div', { class: `todo-item k-${td.kind}${td.done ? ' done' : ''}` },
        h('div', { class: 'tk' }),
        h('div', { class: 'ti', onclick: () => { state.todos = toggleTodo(state.todos, td.id); saveState(); renderTodos(); updateBadges(); } },
          h('b', {}, td.title),
          h('p', {}, [TODO_KINDS[td.kind]?.label, td.due ? td.due.replace('T', ' ') : '无截止时间', td.note && td.note !== td.title ? '' : ''].filter(Boolean).join(' · ')),
        ),
        h('div', { class: 'cd ' + cdClass }, cdText),
        h('button', {
          class: 'icon-btn', title: '删除',
          onclick: (ev) => { ev.stopPropagation(); state.todos = removeTodo(state.todos, td.id); saveState(); renderTodos(); updateBadges(); },
        }, '✕'),
      ),
    );
  }
}

function modalAddTodo() {
  openModal('添加待办', [
    h('label', { class: 'row' }, h('span', {}, '内容'), h('input', { id: 'ntTitle', class: 'text-input', type: 'text', placeholder: '例：高数作业第三章' })),
    h('label', { class: 'row' }, h('span', {}, '类型'),
      h('select', { id: 'ntKind' },
        ...Object.entries(TODO_KINDS).map(([k, v]) => h('option', { value: k }, v.label)))),
    h('label', { class: 'row' }, h('span', {}, '截止'), h('input', { id: 'ntDue', class: 'text-input', type: 'datetime-local' })),
  ], [
    { label: '取消', class: 'ghost-btn' },
    {
      label: '保存', class: 'primary-btn',
      onClick: () => {
        const title = $('ntTitle').value.trim();
        if (!title) { toast('内容不能为空'); return false; }
        state.todos = upsertTodo(state.todos, { title, kind: $('ntKind').value, due: $('ntDue').value });
        saveState(); renderTodos(); updateBadges();
        toast('已添加');
        return true;
      },
    },
  ]);
}

function modalParseNotice() {
  openModal('粘贴通知文本', [
    h('p', { class: 'muted small' },
      '把微信 / QQ / 学习通里那条通知复制过来。会识别出日期时间和截止/作业/考试等关键字。'),
    h('textarea', { id: 'ntText', placeholder: '例：\n【学习通】高等数学 作业提交截止时间：2025-09-10 23:59\n2025-09-12 12:00 英语视听说网课截止' }),
    h('div', { id: 'ntPreview' }),
  ], [
    { label: '取消', class: 'ghost-btn' },
    {
      label: '识别', class: 'ghost-btn',
      onClick: () => {
        const found = parseNoticeText($('ntText').value);
        const box = $('ntPreview');
        box.replaceChildren();
        if (!found.length) { box.append(h('p', { class: 'muted small' }, '没识别出任何截止时间。可以用「添加」手动录入。')); return false; }
        box.append(h('p', { class: 'small' }, `识别出 ${found.length} 条：`));
        for (const f of found) {
          box.append(h('div', { class: 'row' }, h('span', {}, f.title), h('b', {}, f.due.replace('T', ' '))));
        }
        return false;
      },
    },
    {
      label: '全部加入待办', class: 'primary-btn',
      onClick: () => {
        const found = parseNoticeText($('ntText').value);
        if (!found.length) { toast('没识别出内容'); return false; }
        for (const f of found) state.todos = upsertTodo(state.todos, f);
        saveState(); renderTodos(); updateBadges();
        toast(`已加入 ${found.length} 条`);
        return true;
      },
    },
  ]);
}

// ================================================================ 公告

/** 共享公告 + 本机私公告，合并后就是界面上真正看到的全部。 */
function annAll() {
  return mergeAnnouncements(state.announcements, state.localAnnouncements);
}

function renderAnnouncements() {
  const box = $('annList');
  box.replaceChildren();
  const list = annAll();

  if (!list.length) {
    box.append(h('div', { class: 'empty' }, h('b', {}, '暂时没有公告'),
      !state.settings.annUrl
        ? '还没设置公告源。到「我的 → 公告源」粘贴班级里发的那串分享码。'
        : '公告源没有返回内容，或者网络不通。'));
    return;
  }

  const read = new Set(state.readAnnouncements);
  for (const a of list) {
    box.append(
      h('div', {
        class: `ann-item lv-${a.level}${read.has(a.id) ? '' : ' unread'}`,
        onclick: () => modalAnnouncement(a),
      },
        h('div', { class: 'ah' },
          a.pinned ? h('span', { class: 'pin-tag' }, '置顶') : null,
          // 来源必须标出来：共享公告和私公告混在一列里，不标就分不清哪条是自己加的
          a.source === 'local' ? h('span', { class: 'src-tag' }, '本机') : null,
          h('b', {}, a.title),
          h('time', {}, a.date)),
        h('div', { class: 'ab' }, h('div', { html: miniMarkdown(a.body) })),
      ),
    );
  }
}

function modalAnnouncement(a) {
  if (!state.readAnnouncements.includes(a.id)) {
    state.readAnnouncements.push(a.id);
    saveState();
    updateBadges();
    // 顺手重画列表 —— 否则刚点开的那条还挂着 .unread，视觉上「读过了但还标着未读」，
    // 要等下次切视图才消失。
    renderAnnouncements();
  }
  const body = [h('div', {}, h('div', { html: miniMarkdown(a.body) }))];
  if (a.link) body.push(h('p', {}, h('a', { href: a.link, target: '_blank', rel: 'noopener' }, '相关链接')));
  body.push(h('p', { class: 'muted small' },
    a.source === 'local' ? `${a.date} · 只在本机，不会同步给任何人` : a.date));

  const actions = [];
  if (a.source === 'local') {
    actions.push({
      label: '删除这条', class: 'danger-btn',
      onClick: () => {
        state.localAnnouncements = state.localAnnouncements.filter((x) => x.id !== a.id);
        saveState();
        renderAll();
        toast('已删除本机公告');
        return true;
      },
    });
  }
  openModal(a.title, body, actions);
}

async function refreshAnnouncements(quiet = false) {
  const url = state.settings.annUrl?.trim();
  if (!url) {
    if (!quiet) toast('还没设置公告源');
    return;
  }
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const before = new Set(state.announcements.map((a) => String(a.id)));
    state.announcements = normalizeAnnouncements(data);
    state.announcementsFetchedAt = new Date().toISOString();
    saveState();
    // 设置页那行状态要跟着走：不重画的话，保存后它永远停在「还没成功拉到过」，
    // 用户看不出到底通没通（实测踩过）。
    renderAnnSrcStatus();
    if (ui.view === 'ann') renderAnnouncements();
    updateBadges();
    if (!quiet) toast(`公告已更新（${annAll().length} 条）`);
    // 首次拉取（before 为空）不弹通知 —— 否则刚装上应用就被历史公告刷屏。
    // 之后每次发现新 id 才弹。
    if (before.size) {
      const fresh = state.announcements.filter((a) => !before.has(String(a.id)));
      if (fresh.length) notifyNewAnnouncements(fresh);
    }
  } catch (e) {
    if (!quiet) toast('公告拉取失败：' + e.message);
    console.warn('公告拉取失败', e);
  }
}

/** 新公告 → 系统通知。没给权限就静默跳过，角标照常更新。 */
function notifyNewAnnouncements(fresh) {
  if (!state.settings.annNotify) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  for (const a of fresh.slice(0, 3)) {
    try {
      const n = new Notification(a.title, {
        body: String(a.body || '').replace(/[*#>`_\-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120),
        tag: 'ys-ann-' + a.id,
      });
      n.onclick = () => {
        window.focus();
        if (ui.view !== 'ann') switchView('ann');
        modalAnnouncement(a);
      };
    } catch (e) {
      console.warn('系统通知失败', e);
    }
  }
}

// ---------------------------------------------------------------- 推送订阅

let annSse = null;    // 当前的 EventSource
let annSseTries = 0;  // 连续失败次数，用来退避

/**
 * 订阅 ntfy 频道，只为「响一声」。
 *
 * ★ 这里是整套推送的安全支点：ntfy 消息**绝不携带公告内容**，收到什么都只是
 * 去重新拉一遍 announcements.json。所以就算频道名泄露、有人往频道里灌假消息，
 * 也只能让用户多刷一次公告，注入不了任何文字 —— 公告内容的唯一来源永远是那个 JSON。
 */
function subscribeAnnouncePush() {
  const topic = String(state.settings.annTopic ?? '').trim();
  if (annSse) { try { annSse.close(); } catch { /* 已经关了 */ } annSse = null; }
  if (!topic || !TOPIC_RE.test(topic)) return;
  if (typeof EventSource === 'undefined') return; // file:// 或老浏览器：只靠轮询

  let es;
  try {
    es = new EventSource(ntfySseUrl(topic));
  } catch (e) {
    console.warn('订阅推送失败', e);
    return;
  }
  annSse = es;

  es.addEventListener('open', () => { annSseTries = 0; });
  es.addEventListener('message', () => refreshAnnouncements(true));
  es.addEventListener('error', () => {
    // EventSource 自带重连，但断网时会疯狂重试 —— 自己接管，做指数退避
    try { es.close(); } catch { /* 忽略 */ }
    if (annSse === es) annSse = null;
    annSseTries = Math.min(annSseTries + 1, 6);
    const delay = Math.min(30000, 2000 * 2 ** (annSseTries - 1));
    setTimeout(() => {
      if (!annSse && state.settings.annTopic) subscribeAnnouncePush();
    }, delay);
  });
}

// ---------------------------------------------------------------- 本机私公告

/** 手填一条只在本机生效的公告。 */
function modalAddLocalAnn() {
  const today = todayISO();
  const fTitle = h('input', { type: 'text', placeholder: '例如：把这周的实验报告交了' });
  const fDate = h('input', { type: 'date', value: today });
  const fBody = h('textarea', { rows: 4, placeholder: '支持 **加粗**、- 列表、换行' });
  openModal('加一条本机公告', [
    h('p', { class: 'muted small' }, '只存在这台设备上，不会上传、也不会分享给别人。'),
    h('label', { class: 'row' }, h('span', {}, '标题'), fTitle),
    h('label', { class: 'row' }, h('span', {}, '日期'), fDate),
    h('label', { class: 'row' }, h('span', {}, '正文'), fBody),
  ], [
    { label: '取消', class: 'ghost-btn' },
    {
      label: '保存', class: 'btn',
      onClick: () => {
        const title = fTitle.value.trim();
        const body = fBody.value.trim();
        if (!title && !body) { toast('标题和正文至少要有一个'); return false; }
        const local = normalizeAnnouncements(
          [{ id: `local-${Date.now()}`, title, date: fDate.value || today, body, level: 'info' }],
          { source: 'local' },
        );
        state.localAnnouncements = mergeAnnouncements(state.localAnnouncements, local);
        saveState();
        renderAll();
        toast('已加入本机公告');
        return true;
      },
    },
  ]);
}

/** 从 JSON 文件导入公告到本机（只在本机生效）。 */
async function importLocalAnnouncements(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const list = normalizeAnnouncements(data, { source: 'local' });
    if (!list.length) { toast('这个文件里没有可用的公告'); return; }
    // 导入的东西 id 可能和管理员发的撞车 —— 统一加前缀。
    // 不加的话，本地优先规则会让它悄悄顶掉一条共享公告，用户完全看不出为什么。
    const stamped = list.map((a) => ({ ...a, id: `local-${a.id}` }));
    state.localAnnouncements = mergeAnnouncements(state.localAnnouncements, stamped);
    saveState();
    renderAll();
    toast(`已导入 ${stamped.length} 条本机公告`);
  } catch (e) {
    toast('导入失败：' + e.message);
  }
}

/** 把公告源当前状态写到设置页上 —— 「到底设上没有、上次什么时候拉到的」要能一眼看到。 */
function renderAnnSrcStatus() {
  const el = $('annSrcStatus');
  if (!el) return;
  const { annUrl, annTopic } = state.settings;
  if (!annUrl && !annTopic) {
    el.textContent = '还没设置。';
    return;
  }
  const parts = [];
  if (annUrl) parts.push('公告地址已设置');
  else parts.push('⚠️ 只有推送频道，没有公告地址');
  if (annTopic) parts.push(`推送频道 ${annTopic}`);
  else parts.push('没有推送频道（只有轮询）');
  const at = state.announcementsFetchedAt;
  parts.push(at ? `上次拉到 ${new Date(at).toLocaleString()}` : '还没成功拉到过');
  el.textContent = parts.join(' · ');
}

function renderLocalCount() {
  const el = $('localAnnCount');
  if (!el) return;
  const n = state.localAnnouncements.length;
  el.textContent = n ? `当前有 ${n} 条本机公告。` : '当前没有本机公告。';
}

function updateBadges() {
  const unread = unreadCount(state.announcements, state.readAnnouncements);
  const b1 = $('badgeAnn');
  b1.hidden = unread === 0;
  b1.textContent = unread > 99 ? '99+' : String(unread);

  const pending = state.todos.filter((t) => !t.done).length;
  const b2 = $('badgeTodo');
  b2.hidden = pending === 0;
  b2.textContent = pending > 99 ? '99+' : String(pending);
}

// ================================================================ 导入
//
// 导入做成「三选一 + 一个兜底」。之所以要分这么多条路，是因为四端的能力不一样：
//
//   ① 登录教务系统   只有壳做得到。浏览器有同源策略：jwxt.bistu.edu.cn 的接口
//                    不返回 Access-Control-Allow-Origin，跨源 fetch 连响应体都读不到；
//                    而且登录会话 cookie 缺省 SameSite=Lax，跨站请求根本不会带上。
//                    纯网页端点这一项会**解释原因并给替代路径**，不静默失败。
//   ② 上传课表文件   教务系统「导出」出来的 .xlsx / .docx。四端全通、数据最准。
//                    唯一的缺口：这两种文件里**只有周次、没有学期起始日**，
//                    所以要用户补一次「今天在第几周」。
//   ③ 课表截图       网页端做不到离线的中文 OCR（引 tesseract.js 会把单文件产物
//                    从 160KB 涨到 20MB+，识别质量还一般）。所以这一项是：
//                    用系统自带识字提出文字，或者对着截图**照抄进格子**——
//                    两条路最后都汇到同一个网格解析器，和上传文件走的是同一套代码。
//   ④ 粘贴抓取结果   iOS / 鸿蒙 上用书签小工具抓完粘回来的那条路。

/** 把一份课表数据包落进 state 并刷新界面。返回给调用方一个可展示的摘要。 */
function applyPack(pack) {
  state.schedule = pack;
  ui.week = currentWeekNumber();
  saveState();
  renderHeader();
  renderWeek();
  switchView('week');
  return { events: pack.events?.length ?? 0, weeks: pack.termWeeks.length };
}

function importFromText(text) {
  const r = applyPack(parseAnyScheduleInput(text));
  toast(`导入成功：${r.events} 节课，${r.weeks} 教学周`);
}

/** 网格课表 → 落库。上传文件、粘贴表格、手动照抄、编辑课表四条路共用这一个出口。 */
function importFromGrid(grid, anchorWeek, opts = {}) {
  const pack = normalizeSchedulePack(
    packFromGrid(grid, { anchorWeek, today: todayISO(), ...opts }),
  );
  const r = applyPack(pack);
  const extra = pack.unscheduled?.length ? `，另有 ${pack.unscheduled.length} 门没排上课表` : '';
  toast(`导入成功：${r.events} 节课${extra}`);
  return r;
}

/** 一句人话概括这次解析出的内容，用于导入前的预览。 */
function gridSummary(grid, anchorWeek) {
  const pack = packFromGrid(grid, { anchorWeek, today: todayISO() });
  const evs = pack.events;
  const parts = [];
  if (grid.termName) parts.push(grid.termName);
  if (grid.studentCode) parts.push(grid.studentCode);
  parts.push(`${grid.courses.length} 个课程时段 · ${evs.length} 节课`);
  if (evs.length) parts.push(`${evs[0].date} ~ ${evs[evs.length - 1].date}`);
  if (pack.unscheduled.length) parts.push(`${pack.unscheduled.length} 门没排上课表`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------- ① 登录教务系统

function modalImportAccount() {
  const shell = globalThis.YangShanShell;
  if (!shell || typeof shell.login !== 'function') {
    openModal('登录教务系统', [
      h('p', {}, '这一步在浏览器里做不到 —— 不是没做，是浏览器的安全规则不允许。'),
      h('p', { class: 'muted small' },
        '课表网页在第三方域名下，去请求教务系统的接口属于跨源请求。教务系统的接口不返回 ' +
        'Access-Control-Allow-Origin，浏览器就不会把响应交给网页；登录会话的 cookie 又缺省是 ' +
        'SameSite=Lax，跨站请求根本不会带上。所以哪怕把账号密码填进去，也拿不到课表。'),
      h('p', {}, '能走通的几条路：'),
      h('ol', { class: 'onboard-steps' },
        h('li', {}, h('b', {}, '上传课表文件'), '：在教务系统里点「导出」，存下 .xlsx / .docx 再导进来。最省事，数据也最全。'),
        h('li', {}, h('b', {}, '抓取书签'), '：在手机浏览器里登录教务系统，点一下书签把数据抓回来。'),
        h('li', {}, h('b', {}, '手动填课表'), '：对着截图或教务系统照抄，一次性的活。'),
        h('li', {}, h('b', {}, '装客户端'), '：电脑 / 安卓客户端不受这个限制，装好后这里会直接出现登录框。')),
    ], [
      { label: '上传课表文件', class: 'primary-btn', onClick: () => { modalImportFile(); return true; } },
      { label: '手动填课表', class: 'ghost-btn', onClick: () => { modalImportManual(); return true; } },
    ]);
    return;
  }

  const user = h('input', { class: 'text-input', type: 'text', autocomplete: 'username', placeholder: '学号' });
  const pass = h('input', { class: 'text-input', type: 'password', autocomplete: 'current-password', placeholder: '密码' });
  const hint = h('p', { class: 'muted small' }, '账号密码只交给本机客户端用于直连学校统一身份认证，不会写进任何文件，也不会发到别的服务器。');

  const submit = async () => {
    if (!user.value.trim() || !pass.value) { toast('学号和密码都要填'); return false; }
    hint.textContent = '正在登录教务系统…';
    try {
      const raw = await shell.login(user.value.trim(), pass.value);
      pass.value = '';
      applyPack(normalizeSchedulePack(raw));
      toast('已从教务系统获取课表');
      return true;
    } catch (e) {
      hint.textContent = '登录失败：' + (e?.message || e);
      return false;
    }
  };

  pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

  openModal('登录教务系统', [
    h('p', { class: 'muted small' }, '课表按人不同，所以用你自己的账号登录。客户端直连学校，不经过任何中间服务器。'),
    h('label', { class: 'row' }, h('span', {}, '学号'), user),
    h('label', { class: 'row' }, h('span', {}, '密码'), pass),
    hint,
  ], [
    { label: '取消', class: 'ghost-btn' },
    { label: '登录并获取课表', class: 'primary-btn', onClick: submit },
  ]);
}

// ---------------------------------------------------------------- ② 上传课表文件

/**
 * 「今天在第几周」的双向输入。
 * 教务导出的文件里只有周次、没有学期起始日，这一步是这条路径唯一的用户负担，
 * 所以给它一个能自己校验的界面：改周数会算出第 1 周的星期一，改日期会反推周数。
 */
function weekAnchorRow(initialWeek) {
  const week = h('input', {
    class: 'text-input', type: 'number', min: '1', max: '30',
    value: String(initialWeek), style: { width: '5em', marginTop: '0' },
  });
  const date = h('input', { class: 'text-input', type: 'date', style: { width: '11em', marginTop: '0' } });

  const fromWeek = () => {
    date.value = termStartFromWeek(Number(week.value) || 1, todayISO());
  };
  const fromDate = () => {
    if (!date.value) return;
    const n = Math.floor(daysBetween(date.value, todayISO()) / 7) + 1;
    week.value = String(Math.max(1, Math.min(30, n)));
  };
  week.addEventListener('input', fromWeek);
  date.addEventListener('change', fromDate);
  fromWeek();

  const node = h('div', {},
    h('label', { class: 'row' }, h('span', {}, '今天是第几周'), week),
    h('label', { class: 'row' }, h('span', {}, '第 1 周的星期一'), date),
    h('p', { class: 'muted small' },
      '导出的课表文件里只有「第几周」，没有学期从哪天开始，所以这里要你补一次。' +
      '教务系统首页或课表页上通常写着「第 N 周」。'),
  );
  return { node, week, date };
}

async function readGridFromFile(f) {
  const bytes = new Uint8Array(await f.arrayBuffer());
  const { rows } = await readOfficeRows(bytes, browserInflateRaw);
  return parseScheduleGrid(rows);
}

function modalImportFile() {
  const file = h('input', { type: 'file', accept: '.xlsx,.docx', style: { display: 'none' } });
  const status = h('p', { class: 'muted small' },
    '支持教务系统「导出」出来的 Excel（.xlsx）和 Word（.docx）。文件只在你这台设备上解析，不会上传。');
  const anchorWeek = currentWeekNumber() ?? 1;
  const anchor = weekAnchorRow(anchorWeek);
  anchor.node.hidden = true;

  let grid = null;
  const preview = h('div', {});

  const refresh = () => {
    if (!grid) return;
    anchor.node.hidden = false;
    preview.replaceChildren(h('div', { class: 'notice' }, h('b', {}, gridSummary(grid, Number(anchor.week.value) || 1))));
  };

  const load = async (f) => {
    if (!f) return;
    status.textContent = '正在解析 ' + f.name + ' …';
    try {
      grid = await readGridFromFile(f);
      if (!grid.courses.length) throw new Error('这份文件里没解析出课表，确认是教务系统导出的「学生课表」。');
      status.textContent = '已读取 ' + f.name;
      refresh();
    } catch (e) {
      grid = null;
      anchor.node.hidden = true;
      preview.replaceChildren();
      status.textContent = '读不了这个文件：' + (e?.message || e);
    }
  };

  file.addEventListener('change', () => load(file.files?.[0]));
  anchor.week.addEventListener('input', refresh);
  anchor.date.addEventListener('change', refresh);

  const drop = h('div', {
    class: 'notice',
    style: { textAlign: 'center', cursor: 'pointer' },
    onclick: () => file.click(),
  }, h('b', {}, '点这里选文件'), h('span', {}, '也可以把文件拖到这一块上'));

  for (const ev of ['dragover', 'dragenter']) {
    drop.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.add('drop-on'); });
  }
  for (const ev of ['dragleave', 'dragend']) {
    drop.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.remove('drop-on'); });
  }
  drop.addEventListener('drop', (e) => {
    // 必须 preventDefault，否则浏览器会直接导航到那个文件、把页面顶掉
    e.preventDefault();
    e.stopPropagation();
    drop.classList.remove('drop-on');
    load(e.dataTransfer?.files?.[0]);
  });

  openModal('上传课表文件', [file, drop, status, anchor.node, preview], [
    { label: '取消', class: 'ghost-btn' },
    {
      label: '导入',
      class: 'primary-btn',
      onClick: () => {
        if (!grid) { toast('先选一个课表文件'); return false; }
        importFromGrid(grid, Number(anchor.week.value) || 1);
        return true;
      },
    },
  ]);
}

// ---------------------------------------------------------------- ③ 课表截图（本地 OCR）/ 手动照抄

const SHOT_HOWTO = [
  ['iPhone / iPad', '相册打开截图 → 长按文字 → 全选 → 拷贝（iOS 15+ 的「实况文本」）'],
  ['安卓', '相册打开截图 → 更多 → 「提取文字」/「识别文字」'],
  ['鸿蒙', '相册打开截图 → 长按选中文字 → 复制'],
  ['微信 / QQ', '把截图发给自己 → 长按图片 → 「提取文字」'],
  ['Windows', 'PowerToys 的「文本提取器」：Win+Shift+T 框选'],
];

// 识别是本地跑的（tesseract.js 的 wasm 就装在页面里），所以图不上传、断网也能用。
// 但中文表格 OCR 到不了「直接可用」的准确度：课名常有错字，教室号偶尔串行。
// 所以这里的定位是**出草稿**——认完直接铺进可编辑的格子，让人扫一眼改改再保存。
function modalImportShot() {
  const file = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
  const status = h('p', { class: 'muted small', id: 'shotStatus' },
    '选一张课表截图，在你这台设备上识别，图不会上传。第一次用要先把识别引擎读进内存，会慢几秒。');
  const bar = h('div', { class: 'ocr-bar', id: 'shotBar' }, h('i', {}));
  bar.hidden = true;
  const preview = h('div', {});
  const anchor = weekAnchorRow(currentWeekNumber() ?? 1);
  anchor.node.hidden = true;

  let busy = false;

  const showHowto = () => {
    preview.replaceChildren(
      h('h3', { style: { marginTop: '14px' } }, '识别结果不对怎么办'),
      h('p', { class: 'muted small' },
        '中文课表识别的准确率到不了 100%，课名最容易认错。三条退路：'),
      h('ul', { class: 'onboard-steps' },
        h('li', {}, h('b', {}, '直接改：'), '认完会把结果铺进格子，点「检查并修正」改掉错字就行。'),
        h('li', {}, h('b', {}, '换系统识字：'), '系统自带的识字比网页里的准。'),
        ...SHOT_HOWTO.map(([k, v]) => h('li', {}, h('b', {}, k + '：'), v)),
        h('li', {}, h('b', {}, '有课表文件就别截图：'), '教务系统「导出」的 .xlsx / .docx 是 100% 准确的，优先用它。')),
    );
  };

  const run = async (f) => {
    if (!f || busy) return;
    busy = true;
    bar.hidden = false;
    bar.firstChild.style.width = '2%';
    status.textContent = '正在准备识别引擎…';
    try {
      const img = await imageBlobOf(f);
      const small = await shrinkForOcr(img);
      const ocr = scheduleOcr({
        onProgress: (m) => {
          const pct = Math.max(2, Math.round((m.progress || 0) * 100));
          bar.firstChild.style.width = pct + '%';
          status.textContent = m.status === 'recognizing text'
            ? `正在认字… ${pct}%`
            : (m.status === 'error' ? '识别出错：' + (m.message || '') : `正在准备识别引擎… ${pct}%`);
        },
      });
      const data = await ocr.recognize(small);
      status.textContent = '正在把认出来的字归到格子里…';
      const { rows, stats } = ocrToRows(data.tsv);
      if (!stats.courses) throw new Error('认出了字，但没拼出一门课。换一张更清楚的截图试试。');
      bar.hidden = true;
      status.textContent = `认出 ${stats.courses} 门课（${stats.columns} 天 × ${stats.sections} 节）。`;
      anchor.node.hidden = false;
      preview.replaceChildren(
        h('div', { class: 'notice' },
          h('b', {}, `认出 ${stats.courses} 门课`),
          h('span', {}, '课名可能有错字、教室号偶尔会串行。点下面的按钮进格子核对一遍再保存。')),
      );
      anchor.week.addEventListener('input', () => {});
      const go = async () => {
        openGridEditor({
          title: '核对截图识别结果',
          intro: [h('p', { class: 'muted small' },
            '这是从截图里认出来的，已经铺进格子了。把错字改掉、认错的课清空，然后保存。')],
          rows,
          anchorWeek: Number(anchor.week.value) || 1,
          submitLabel: '保存',
        });
      };
      preview.firstChild.appendChild(h('div', { class: 'row', style: { marginTop: '10px' } },
        h('button', { class: 'primary-btn', onclick: go }, '检查并修正'),
        h('button', { class: 'ghost-btn', onclick: () => file.click() }, '换一张'),
      ));
    } catch (e) {
      bar.hidden = true;
      status.textContent = '没认出来：' + (e?.message || e);
      anchor.node.hidden = true;
      preview.replaceChildren();
      showHowto();
    } finally {
      busy = false;
    }
  };

  file.addEventListener('change', () => run(file.files?.[0]));

  const drop = h('div', {
    class: 'notice',
    style: { textAlign: 'center', cursor: 'pointer' },
    onclick: () => file.click(),
  }, h('b', {}, '点这里选截图'), h('span', {}, '也可以把图片拖到这一块上；手机上会直接让你拍照'));

  for (const ev of ['dragover', 'dragenter']) {
    drop.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.add('drop-on'); });
  }
  for (const ev of ['dragleave', 'drop']) {
    drop.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.remove('drop-on'); });
  }
  drop.addEventListener('drop', (e) => run(e.dataTransfer?.files?.[0]));

  showHowto();

  openModal('课表截图', [drop, file, bar, status, anchor.node, preview], [
    { label: '粘贴文字导入', class: 'ghost-btn', onClick: () => { modalImportPaste(); return true; } },
    { label: '手动填课表', class: 'ghost-btn', onClick: () => { modalImportManual(); return true; } },
    { label: '关闭', class: 'ghost-btn' },
  ]);
}

// ---------------------------------------------------------------- ④ 粘贴抓取结果 / 表格

function modalImportPaste(initial = '') {
  const ta = h('textarea', {
    id: 'impText',
    placeholder: '抓取结果（YSRAW1- 开头）、分享码（YS1- 开头）、JSON，' +
      '或者从 Excel / Word 里整块复制出来的课表表格',
  });
  ta.value = initial;
  const file = h('input', { type: 'file', accept: '.json,.txt', style: { display: 'none' } });

  const readFile = async (f) => {
    if (!f) return;
    try {
      ta.value = await f.text();
      toast('已读入文件，点「导入」确认');
    } catch {
      toast('读不了这个文件');
    }
  };

  file.addEventListener('change', () => readFile(file.files?.[0]));

  // 拖进来。默认行为必须 preventDefault，否则浏览器会直接导航到那个文件、把页面顶掉。
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  ta.addEventListener('dragover', (e) => { stop(e); ta.classList.add('drop-on'); });
  ta.addEventListener('dragleave', (e) => { stop(e); ta.classList.remove('drop-on'); });
  ta.addEventListener('drop', (e) => {
    stop(e);
    ta.classList.remove('drop-on');
    readFile(e.dataTransfer?.files?.[0]);
  });

  openModal('粘贴导入', [
    h('p', { class: 'muted small' }, '课表数据来自「抓取工具」（电脑上是内置浏览器一键抓取，手机上是书签小工具），也可以是教务系统导出的表格。数据只写进本机存储，不会上传。'),
    file,
    h('div', { class: 'btn-row' },
      h('button', { class: 'ghost-btn', onclick: () => file.click() }, '选择文件'),
      h('button', {
        class: 'ghost-btn',
        onclick: async () => {
          try {
            const t = await navigator.clipboard.readText();
            if (t) { ta.value = t; toast('已从剪贴板读入'); }
            else toast('剪贴板是空的');
          } catch {
            toast('浏览器不允许读剪贴板，请手动粘贴（Ctrl/⌘+V）');
          }
        },
      }, '读剪贴板'),
    ),
    ta,
  ], [
    { label: '取消', class: 'ghost-btn' },
    {
      label: '导入',
      class: 'primary-btn',
      onClick: () => {
        const text = ta.value;
        // 粘贴进来的也可能是制表符表格（从 Word/Excel 复制），先试它
        if (looksLikeGridText(text)) {
          try {
            importFromGrid(parseGridText(text), currentWeekNumber() ?? 1);
            return true;
          } catch (e) {
            toast(e?.message || '导入失败');
            return false;
          }
        }
        importFromText(text);
        return true;
      },
    },
  ]);
}

// ---------------------------------------------------------------- 手动填课表 / 编辑课表

/**
 * 手填课表网格编辑器。**手动填课表和「编辑已导入的课表」用的是这一个函数。**
 *
 * ★ 这里**没有第二套解析逻辑**：格子里的文字按教务导出文件里一模一样的简写写
 *   （`课程名[课程代码] | 周次 教师 第X节-第Y节 地点`），拼成 rows 之后直接喂给
 *   core/officefile.mjs 的 parseScheduleGrid —— 和上传 .xlsx / .docx 走的是同一条路。
 *   于是"手动填的课表"和"文件导入的课表"在日历里是同一条事件（UID 相同），不会重复。
 *
 * ★ 「编辑」就是把课表用 `gridFromCourses` 反写成同样的网格、预填进来。
 *   这样编辑一次不会改变任何一门课的 UID（日历里原地更新），
 *   也不会因为编辑而丢掉抓取时才有、网格里没有的字段（走 opts.carry 带回来）。
 *
 * opts:
 *   title        弹窗标题
 *   intro        说明节点数组（缺省是"照着一格一格填"那套）
 *   rows         预填网格（gridFromCourses 的产物）
 *   anchorWeek   "今天在第几周"的初值
 *   packOpts     透给 packFromGrid 的（termWeeks / termCode —— 编辑时必须沿用原周历，否则日期会漂）
 *   carry        网格里装不下、需要原样带回来的：{ studentCode, studentName, termName, unscheduled }
 *   submitLabel  确认按钮文字
 */
function openGridEditor(opts = {}) {
  const days = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];

  // 预填：把 rows 按 `第N节` 还原到格子里。一个格子里的多行用 ｜ 连回去。
  const seeded = new Map();
  for (const r of opts.rows || []) {
    const m = /^第\s*(\d+)\s*节/.exec(String(r[0] ?? ''));
    if (!m) continue;
    seeded.set(Number(m[1]), r.slice(1, 8).map((v) => String(v ?? '').replace(/\n+/g, '｜').trim()));
  }
  const SECTIONS = Math.max(14, ...seeded.keys());

  const cells = [];
  const table = h('div', { class: 'mgrid' });
  table.append(h('div', { class: 'mgrid-corner' }, '节次'));
  for (const d of days) table.append(h('div', { class: 'mgrid-day' }, d.slice(1)));
  for (let s = 1; s <= SECTIONS; s++) {
    table.append(h('div', { class: 'mgrid-sec' }, String(s)));
    const row = [];
    for (let c = 0; c < 7; c++) {
      const input = h('input', {
        class: 'mgrid-cell', type: 'text',
        value: seeded.get(s)?.[c] ?? '',
        placeholder: c === 0 && s === 1 ? '高数[MATH131]｜3-16周 某老师 第1节-第2节 ZXD-205' : '',
        title: '课程名[课程代码]｜周次 教师 第X节-第Y节 地点',
      });
      row.push(input);
      table.append(input);
    }
    cells.push(row);
  }

  const toRows = () => {
    const rows = [['节次/星期', ...days]];
    for (let s = 0; s < SECTIONS; s++) {
      // `｜` 和 `|` 都当「一条时间段」的分隔符；换成 \n 是因为 splitCellBlocks 按行切
      const line = cells[s].map((inp) => inp.value.replace(/[｜|]/g, '\n').trim());
      if (!line.some(Boolean)) continue;
      rows.push([`第${s + 1}节`, ...line]);
    }
    return rows;
  };

  const parse = () => {
    const rows = toRows();
    if (rows.length <= 1) throw new Error('还一格都没填。');
    const grid = parseScheduleGrid(rows);
    if (!grid.courses.length) {
      throw new Error('没解析出课。每格要写成「课程名[课程代码]｜周次 教师 第X节-第Y节 地点」。');
    }
    // 网格装不下的东西（学号、未排课的课……）原样带回，否则编辑一次就丢了
    const carry = opts.carry || {};
    if (!grid.studentCode && carry.studentCode) grid.studentCode = carry.studentCode;
    if (!grid.studentName && carry.studentName) grid.studentName = carry.studentName;
    if (!grid.termName && carry.termName) grid.termName = carry.termName;
    if (!grid.unscheduled?.length && carry.unscheduled?.length) grid.unscheduled = carry.unscheduled;
    return grid;
  };

  const anchor = weekAnchorRow(opts.anchorWeek ?? currentWeekNumber() ?? 1);

  const intro = opts.intro || [
    h('p', { class: 'muted small' },
      '照着一格一格填。格式：', h('code', {}, '课程名[课程代码]｜周次 教师 第X节-第Y节 地点'),
      '，例如 ', h('code', {}, '高等数学(1)[MATH131]｜3-16周 雷纪刚 第1节-第2节 ZXD-205'),
      '。一格里有多个时间段就用 ｜ 隔开。'),
    h('p', { class: 'muted small' }, '方括号里放课程代码（带字母或数字的都行）—— 解析器靠它认出「这一格是课程名」。不知道代码可以随便编一个，比如 TMP1。'),
  ];

  openModal(opts.title || '填课表', [
    ...intro,
    h('div', { class: 'mgrid-wrap' }, table),
    anchor.node,
  ], [
    { label: '取消', class: 'ghost-btn' },
    {
      label: opts.submitLabel || '导入',
      class: 'primary-btn',
      onClick: () => {
        try {
          importFromGrid(parse(), Number(anchor.week.value) || 1, opts.packOpts || {});
          return true;
        } catch (e) {
          toast(e?.message || '解析失败');
          return false;
        }
      },
    },
  ], { wide: true });
}

/** 对着截图照抄（导入流程里的第三条路）。 */
function modalImportManual() {
  openGridEditor({ title: '手动填课表' });
}

/**
 * 编辑已经导入的课表。
 *
 * 两条硬约束：
 *   1. **沿用原来的 termWeeks**（不按「今天第几周」重推）—— 否则用户改一个错别字，
 *      整学期的日期就平移了。
 *   2. 反向写成网格再解析回来必须是恒等的，所以未排课的课、学号、教师名都要原样带回来。
 */
function modalEditSchedule() {
  const pack = state.schedule;
  if (!pack || !pack.arrangedList?.length) {
    toast('还没有课表，先在「导入课表」里导一份');
    return;
  }
  const built = gridFromCourses(pack.arrangedList);
  const n = pack.arrangedList.length;
  openGridEditor({
    title: '编辑课表',
    rows: built.rows,
    anchorWeek: currentWeekNumber() ?? 1,
    submitLabel: '保存',
    packOpts: { termWeeks: pack.termWeeks, termCode: pack.termCode },
    carry: {
      studentCode: pack.studentCode,
      studentName: pack.studentName,
      unscheduled: pack.unscheduled,
    },
    intro: [
      h('p', { class: 'muted small' },
        `这是当前课表的 ${n} 个课程时段，已经填进格子里了。改完点「保存」即可 —— `,
        '保存走的是和导入完全一样的解析，所以没动过的课在系统日历里是原地更新，不会多出一份。'),
      h('p', { class: 'muted small' },
        '每格格式：', h('code', {}, '课程名[课程代码]｜周次 教师 第X节-第Y节 地点'),
        '。清空一格就是删掉那门课；一门课多个时间段就用 ｜ 隔开。'),
    ],
  });
}

// ---------------------------------------------------------------- 三选一入口

function modalImport() {
  const opt = (emoji, title, desc, onClick) =>
    h('button', { class: 'notice imp-opt', onclick: onClick },
      h('b', {}, emoji + '  ' + title),
      h('span', {}, desc));

  openModal('导入课表', [
    h('p', { class: 'muted small' }, '选一种。数据只写进这台设备，不上传任何服务器。'),
    opt('🔑', '登录教务系统', '一键抓取。需要装电脑 / 安卓客户端；浏览器里做不到，点进去会说明原因。', modalImportAccount),
    opt('📄', '上传课表文件', '教务系统「导出」的 .xlsx / .docx。四端都能用，数据最准，只需补一次「今天第几周」。', modalImportFile),
    opt('📷', '课表截图', '全自动识别，不用你先手动提取文字。认完直接铺进格子让你核对改错字，图不出这台设备。', modalImportShot),
    opt('📌', '粘贴抓取结果 / 分享码', '手机书签小工具抓完粘回来；也可以粘同学发来的分享码。', () => modalImportPaste()),
  ], [
    { label: '关闭', class: 'ghost-btn' },
  ]);
}

// ================================================================ 抓取工具

function modalBookmarklet() {
  const src = document.getElementById('bookmarklet-src')?.textContent?.trim() ?? '';
  const a = h('a', {
    href: src ? 'javascript:' + encodeURIComponent(src).replace(/%20/g, ' ') : '#',
    class: 'primary-btn',
    style: { display: 'inline-block', textDecoration: 'none' },
    onclick: (e) => e.preventDefault(),
  }, '📌 抓取课表');

  openModal('抓取课表数据', [
    h('p', {}, '手机（iOS / 鸿蒙）上没法用内置浏览器，用这个书签小工具抓：'),
    h('ol', { class: 'onboard-steps' },
      h('li', {}, '在电脑浏览器里把下面这个按钮拖到书签栏；手机上则复制它的链接，手动新建一个书签、地址粘进去。'),
      h('li', {}, '用手机浏览器登录教务系统，进到课表页面。'),
      h('li', {}, '点一下那个书签。页面会弹出课表数据，自动复制到剪贴板。'),
      h('li', {}, '回到本页面，在「导入课表」里粘贴。'),
    ),
    h('div', { class: 'btn-row center' }, a),
    h('p', { class: 'muted small' },
      '⚠️ 不要往地址栏手打 javascript: —— iOS Safari 会拦掉。必须存成书签再点。'),
    h('details', {},
      h('summary', { class: 'muted small' }, '书签链接（手动复制用）'),
      h('div', { class: 'code-box', id: 'bmSrc' }, src || '（构建时未注入书签小工具源码）'),
    ),
  ], [
    { label: '复制书签链接', class: 'ghost-btn', onClick: async () => { const ok = await copyText(src); toast(ok ? '已复制' : '复制失败，请手动选中'); return false; } },
    { label: '关闭', class: 'primary-btn' },
  ]);
}

// ================================================================ 导出

function modalExportIcs() {
  const events = state.schedule?.events ?? [];
  const openTodos = state.todos.filter((t) => !t.done && t.due);
  if (!events.length && !openTodos.length) { toast('还没有课表，也没有带截止时间的待办'); return; }

  const alarmOptions = (id, def) => h('select', { id },
    h('option', { value: '' }, '不写提醒（订阅时由系统决定）'),
    ...[[5, '5 分钟'], [10, '10 分钟'], [15, '15 分钟'], [30, '30 分钟'], [60, '1 小时'], [1440, '1 天']]
      .map(([v, t]) => h('option', { value: String(v), selected: v === def ? true : null }, t)));

  openModal('导出日历', [
    h('p', { class: 'muted small' },
      '导出的 .ics 可以直接用系统日历打开。想让它自动更新，就把文件放到一个固定网址上，' +
      '用 webcal:// 订阅 —— 手机日历会自己定时刷新，不需要本应用在后台跑。'),
    h('label', { class: 'row' }, h('span', {}, '日历名称'),
      h('input', { id: 'icsName', class: 'text-input', type: 'text', value: '课表 ' + parseTermCode(state.schedule?.termCode ?? '').label })),
    h('label', { class: 'row' }, h('span', {}, '上课提前提醒'), alarmOptions('icsAlarm', 15)),
    h('label', { class: 'row' }, h('span', {}, '作业/网课截止提前提醒'), alarmOptions('icsTodoAlarm', 1440)),
    h('label', { class: 'row' }, h('span', {}, `同时导出作业与截止（${openTodos.length} 条）`),
      h('input', { id: 'icsWithTodos', type: 'checkbox', checked: openTodos.length ? true : null })),
    h('p', { class: 'muted small' },
      `课程数：${events.length} 节。重复导入不会产生重复事件（UID 由课程身份决定，与教室、教师无关）。` +
      (openTodos.length ? '待办事件的 UID 前缀是 ys-todo-，与课程互不干扰；已勾掉的待办不会被导出。' : '')),
  ], [
    { label: '取消', class: 'ghost-btn' },
    {
      label: '下载 .ics', class: 'primary-btn',
      onClick: () => {
        const alarmRaw = $('icsAlarm').value;
        const todoLead = $('icsTodoAlarm').value === '' ? null : Number($('icsTodoAlarm').value);
        const withTodos = $('icsWithTodos').checked;
        const todoEvents = withTodos
          ? todoToEvents(openTodos).map((e) => ({ ...e, alarmMinutes: todoLead }))
          : [];
        const all = [...events, ...todoEvents];
        if (!all.length) { toast('没有可导出的内容'); return false; }
        const ics = buildIcal(all, {
          calName: $('icsName').value.trim() || '课表',
          sequence: Math.floor(Date.now() / 1000) % 100000,
          alarmMinutes: alarmRaw === '' ? null : Number(alarmRaw),
        });
        download(`课表-${state.schedule?.termCode || 'export'}.ics`, ics, 'text/calendar;charset=utf-8');
        toast(`已下载（${events.length} 节课${todoEvents.length ? ' + ' + todoEvents.length + ' 条截止' : ''}）`);
        return true;
      },
    },
  ]);
}

function modalShareCode() {
  if (!state.schedule) { toast('还没有课表'); return; }
  const code = encodeShareCode(state.schedule);
  openModal('分享码', [
    h('p', { class: 'muted small' },
      `长度 ${code.length} 字符。适合发给自己或同班同学（同一教学班的课表通常一样）。` +
      '注意：分享码里**不含**学号和任何账号信息。'),
    h('div', { class: 'code-box' }, code),
  ], [
    {
      label: '复制', class: 'primary-btn',
      onClick: async () => { const ok = await copyText(code); toast(ok ? '已复制到剪贴板' : '复制失败，请手动选中上面的文本'); return false; },
    },
    { label: '关闭', class: 'ghost-btn' },
  ]);
}

/**
 * 公告源格式示例 —— 「共享通知」的落地载体：把这份 JSON 放到任意静态托管上，
 * 把地址发给全班，大家在「我的 → 公告源」填同一个地址，看到的就是同一批通知。
 *
 * 内容不在这里写死：构建时把仓库根目录的 `examples/announcements.json` 注入到
 * `<script type="application/json" id="ann-example">`（见 web/build.mjs）。
 * 用户是照抄这份示例的，示例与解析器各写一份必然漂移。
 */
function annExampleJson() {
  const raw = document.getElementById('ann-example')?.textContent?.trim();
  if (raw) {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      // 注入的内容坏了就退回下面的兜底，至少还能弹出一个能用的结构
    }
  }
  return JSON.stringify({
    announcements: [
      { id: 'example-1', title: '在这里写通知标题', date: '2026-11-08', level: 'urgent', pinned: true, body: '正文，支持 **加粗** 和换行。' },
    ],
  }, null, 2);
}

function modalAnnExample() {
  const text = annExampleJson();
  openModal('公告源格式', [
    h('p', { class: 'muted small' },
      '把下面这份 JSON 存成 announcements.json，放到任意静态托管上（GitHub Pages、对象存储都行），' +
      '把地址发给同学，大家在「公告源」里填同一个地址 —— 这就是这套方案里的「共享通知」。'),
    h('p', { class: 'muted small' },
      '字段：id（唯一串，改内容也沿用同一个 id 就不会重复提醒）、title、date、body（支持加粗语法和换行）、' +
      'level（info / warn / urgent 三档配色）、pinned（置顶）、link（可选，附一条相关链接）。' +
      '顶层还可以写一个 "_说明" 数组放给人看的备注，解析时会忽略。'),
    h('p', { class: 'muted small' },
      '注意：本应用没有服务器，所以它不是推送 —— 打开时、每 15 分钟、以及每次切回这个页面时会各拉一次。'),
    h('div', { class: 'code-box' }, text),
  ], [
    {
      label: '复制模板', class: 'primary-btn',
      onClick: async () => { const ok = await copyText(text); toast(ok ? '已复制到剪贴板' : '复制失败，请手动选中上面的文本'); return false; },
    },
    { label: '关闭', class: 'ghost-btn' },
  ], { wide: true });
}

/**
 * 把某一周的课表画成图片 —— 这是学生最需要的分享形态（发群里、发朋友圈）。
 * 全部用 canvas 手绘，不依赖 html2canvas 之类的库。
 */
function exportWeekImage() {
  const s = state.schedule;
  if (!s) { toast('还没有课表'); return; }

  const w = (s.termWeeks ?? []).find((x) => x.serialNumber === ui.week) ?? s.termWeeks?.[0];
  if (!w) { toast('没有学期周历'); return; }

  const list = s.events.filter((e) => e.week === w.serialNumber);
  const dayCount = 7;
  const rowStart = list.length ? Math.min(...list.map((e) => e.beginSection)) : 1;
  const rowEnd = list.length ? Math.max(...list.map((e) => e.endSection)) : 10;
  const rows = rowEnd - rowStart + 1;

  const SCALE = 2;
  const W = 1000;
  const HEAD = 108;
  const COLHEAD = 46;
  const ROWH = 62;
  const TIME_W = 56;
  const CELL = (W - TIME_W - 24) / dayCount;
  const H = HEAD + COLHEAD + rows * ROWH + 40;

  const cv = document.createElement('canvas');
  cv.width = W * SCALE;
  cv.height = H * SCALE;
  const g = cv.getContext('2d');
  g.scale(SCALE, SCALE);

  const dark = document.documentElement.dataset.theme === 'dark' ||
    (state.settings.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  const C = dark
    ? { bg: '#191d21', fg: '#e6e8ea', muted: '#9aa2ab', line: '#2b3036', head: '#22272c' }
    : { bg: '#ffffff', fg: '#1a1d21', muted: '#6b7280', line: '#e3e6ea', head: '#f5f6f8' };
  const palette = dark
    ? ['#5c9bff', '#f0a05a', '#3fbf74', '#b07cc9', '#e874a4', '#2bbdbd', '#8b9aa8', '#c99a45']
    : ['#4c8dff', '#f2994a', '#27ae60', '#9b59b6', '#e0558a', '#16a3a3', '#7a8b99', '#b5822c'];

  const FONT = '"PingFang SC","Microsoft YaHei",sans-serif';
  const colorMap = new Map();
  const colorOfName = (n) => {
    if (!colorMap.has(n)) colorMap.set(n, palette[parseInt(fnv1a64(n).slice(-2), 16) % 8]);
    return colorMap.get(n);
  };

  g.fillStyle = C.bg;
  g.fillRect(0, 0, W, H);

  // 标题
  g.fillStyle = C.fg;
  g.font = `600 26px ${FONT}`;
  g.fillText('仰山课表', 12, 40);
  g.font = `400 15px ${FONT}`;
  g.fillStyle = C.muted;
  g.fillText(`${parseTermCode(s.termCode).label}　第 ${w.serialNumber} 周　${w.startDate} 起`, 12, 66);
  g.font = `400 12px ${FONT}`;
  g.fillText('由「仰山课表」生成', 12, 88);

  // 星期表头
  const today = todayISO();
  for (let i = 0; i < dayCount; i++) {
    const x = TIME_W + i * CELL;
    const d = addDays(w.startDate, i);
    if (d === today) {
      g.fillStyle = C.head;
      g.fillRect(x, HEAD, CELL, COLHEAD);
    }
    g.fillStyle = d === today ? '#4c8dff' : C.fg;
    g.font = `600 14px ${FONT}`;
    g.textAlign = 'center';
    g.fillText('周' + WEEKDAY_NAMES[i], x + CELL / 2, HEAD + 20);
    g.fillStyle = C.muted;
    g.font = `400 11px ${FONT}`;
    g.fillText(cnDate(d), x + CELL / 2, HEAD + 37);
    g.textAlign = 'left';
  }

  // 表格线
  g.strokeStyle = C.line;
  g.lineWidth = 1;
  for (let r = 0; r <= rows; r++) {
    const y = HEAD + COLHEAD + r * ROWH;
    g.beginPath(); g.moveTo(0, y + .5); g.lineTo(W, y + .5); g.stroke();
  }
  for (let i = 0; i <= dayCount; i++) {
    const x = TIME_W + i * CELL;
    g.beginPath(); g.moveTo(x + .5, HEAD); g.lineTo(x + .5, HEAD + COLHEAD + rows * ROWH); g.stroke();
  }

  // 节次时间
  for (let s2 = rowStart; s2 <= rowEnd; s2++) {
    const y = HEAD + COLHEAD + (s2 - rowStart) * ROWH;
    g.fillStyle = C.muted;
    g.font = `600 11px ${FONT}`;
    g.textAlign = 'center';
    g.fillText(String(s2), TIME_W / 2, y + ROWH / 2 - 2);
    g.font = `400 10px ${FONT}`;
    g.fillText((SECTION_TIMES[s2 - 1]?.start ?? '').slice(0, 5), TIME_W / 2, y + ROWH / 2 + 12);
    g.textAlign = 'left';
  }

  // 课程块
  for (const e of list) {
    const x = TIME_W + (e.dayOfWeek - 1) * CELL + 2;
    const y = HEAD + COLHEAD + (e.beginSection - rowStart) * ROWH + 2;
    const cw = CELL - 4;
    const ch = (e.endSection - e.beginSection + 1) * ROWH - 4;

    g.fillStyle = colorOfName(e.course);
    roundRect(g, x, y, cw, ch, 6);
    g.fill();

    g.fillStyle = '#fff';
    g.font = `600 13px ${FONT}`;
    const lines = wrapText(g, e.course, cw - 10, 3);
    lines.forEach((ln, i) => g.fillText(ln, x + 5, y + 18 + i * 16));

    const sub = [e.location, `${e.beginSection}-${e.endSection}节`].filter(Boolean).join(' · ');
    if (ch > 46) {
      g.font = `400 11px ${FONT}`;
      g.globalAlpha = .9;
      g.fillText(clip(g, sub, cw - 10), x + 5, y + ch - 8);
      g.globalAlpha = 1;
    }
  }

  cv.toBlob((blob) => {
    if (!blob) { toast('生成图片失败'); return; }
    download(`课表-第${w.serialNumber}周.png`, blob);
    toast('图片已保存');
  }, 'image/png');
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function wrapText(g, text, maxW, maxLines) {
  const out = [];
  let line = '';
  for (const ch of String(text)) {
    if (g.measureText(line + ch).width > maxW && line) {
      out.push(line);
      line = ch;
      if (out.length >= maxLines) return out;
    } else {
      line += ch;
    }
  }
  if (line) out.push(line);
  return out.slice(0, maxLines);
}

function clip(g, text, maxW) {
  let s = String(text);
  while (s.length > 1 && g.measureText(s).width > maxW) s = s.slice(0, -1);
  return s;
}

function exportBackup() {
  download(backupFileName(), serializeBackup(state), 'application/json;charset=utf-8');
  toast('备份已下载');
}

function modalRestoreBackup() {
  const file = h('input', { type: 'file', accept: '.json,application/json' });
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    try {
      const b = parseBackup(await f.text());
      if (b.schedule) state.schedule = normalizeSchedulePack(b.schedule);
      state.todos = b.todos;
      state.readAnnouncements = b.readAnnouncements;
      state.settings = { ...DEFAULT_SETTINGS, ...b.settings };
      saveState();
      applySettings();
      renderAll();
      toast('备份已恢复');
      closeModal();
    } catch (e) {
      toast('恢复失败：' + e.message);
    }
  });
  openModal('恢复备份', [
    h('p', { class: 'muted small' }, '选择之前导出的备份文件。会覆盖当前的课表、待办和设置。'),
    file,
  ], [{ label: '取消', class: 'ghost-btn' }]);
}

// ================================================================ 提醒

const firedKeys = new Set();

/**
 * 应用内提醒。⚠️ 只有在页面开着的时候才可能触发 ——
 * 手机浏览器不会让网页在后台定时唤醒，Service Worker 也会在空闲几分钟内被杀。
 * 想要"到点必响"，只能用系统日历订阅（.ics）。这不是实现偷懒，是浏览器的边界。
 */
function checkReminders() {
  if (!state.settings.inApp) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;

  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const today = todayISO(now);

  const fire = (key, title, body) => {
    if (firedKeys.has(key)) return;
    firedKeys.add(key);
    try {
      new Notification(title, { body, tag: key });
    } catch (err) {
      console.warn('通知失败', err);
    }
  };

  // 上课提醒
  const alarm = Number(state.settings.alarm) || 0;
  if (alarm > 0) {
    for (const e of state.schedule?.events ?? []) {
      if (e.date !== today) continue;
      const [h2, m2] = e.start.split(':').map(Number);
      const diff = h2 * 60 + m2 - nowMin;
      if (diff < 0 || diff > alarm) continue;
      fire(`${e.uid}@${today}`, `${alarm} 分钟后上课`, `${e.course}\n${e.start} ${e.location || ''}`);
    }
  }

  // 作业 / 网课 / 考试截止提醒。
  // 用绝对时刻算差值，所以「今晚 23:59 截止」这种当天最后一分钟也判得对。
  const lead = Number(state.settings.todoAlarm ?? 30);
  if (lead > 0) {
    for (const td of state.todos) {
      if (td.done || !td.due) continue;
      const mins = todoRemindIn(td, now);
      if (mins === null || mins < 0 || mins > lead) continue;
      const label = TODO_KINDS[td.kind]?.label ?? '待办';
      const when = mins >= 60 ? `${Math.round(mins / 60)} 小时后` : `${Math.max(1, Math.round(mins))} 分钟后`;
      fire(`todo-${td.id}@${td.due}`, `${label}${when}截止`, `${td.title}\n${td.due.replace('T', ' ')}`);
    }
  }
}

// ================================================================ 设置

function applySettings() {
  const st = state.settings;
  document.documentElement.dataset.theme = st.theme === 'auto' ? '' : st.theme;
  document.documentElement.style.setProperty('--course-font', (12 * st.font / 100).toFixed(1) + 'px');
}

function bindSettings() {
  const st = () => state.settings;

  $('setAlarm').addEventListener('change', (e) => { st().alarm = Number(e.target.value); saveState(); checkReminders(); });
  $('setTodoAlarm').addEventListener('change', (e) => { st().todoAlarm = Number(e.target.value); saveState(); checkReminders(); });
  $('setInApp').addEventListener('change', async (e) => {
    if (e.target.checked && typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
      const p = await Notification.requestPermission();
      if (p !== 'granted') { e.target.checked = false; toast('浏览器拒绝了通知权限'); return; }
    }
    st().inApp = e.target.checked;
    saveState();
  });
  $('setTheme').addEventListener('change', (e) => { st().theme = e.target.value; saveState(); applySettings(); });
  $('setFont').addEventListener('input', (e) => { st().font = Number(e.target.value); saveState(); applySettings(); });
  $('setHideWeekend').addEventListener('change', (e) => { st().hideWeekend = e.target.checked; saveState(); renderWeek(); });
  $('btnSaveAnnUrl').addEventListener('click', () => {
    const raw = $('setAnnUrl').value.trim();
    let parsed;
    try {
      parsed = parseAnnConfig(raw);
    } catch (e) {
      toast('解析失败：' + e.message);
      return;
    }
    st().annUrl = parsed.url;
    st().annTopic = parsed.topic || '';
    saveState();
    renderAnnSrcStatus();
    subscribeAnnouncePush();
    refreshAnnouncements().then(() => renderAnnouncements());
  });
  $('btnAnnExample').addEventListener('click', modalAnnExample);

  $('setAnnNotify').addEventListener('change', async (e) => {
    if (e.target.checked && typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
      const p = await Notification.requestPermission();
      if (p !== 'granted') { e.target.checked = false; toast('浏览器拒绝了通知权限'); return; }
    }
    st().annNotify = e.target.checked;
    saveState();
  });
  $('btnTestAnnPush').addEventListener('click', () => {
    if (typeof Notification === 'undefined') { toast('这个浏览器不支持系统通知'); return; }
    if (Notification.permission !== 'granted') { toast('先打开上面的「弹系统通知」并允许权限'); return; }
    try {
      new Notification('仰山课表 · 测试通知', { body: '看到这条说明通知是通的。' });
      toast('已发出');
    } catch (e) {
      toast('发送失败：' + e.message);
    }
  });

  $('btnAddLocalAnn').addEventListener('click', modalAddLocalAnn);
  $('btnImportLocalAnn').addEventListener('click', () => $('fileLocalAnn').click());
  $('fileLocalAnn').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    e.target.value = ''; // 同一个文件连选两次也要能触发
    if (f) await importLocalAnnouncements(f);
    renderLocalCount();
  });
  $('btnClearLocalAnn').addEventListener('click', () => {
    if (!state.localAnnouncements.length) { toast('本来就没有'); return; }
    if (!confirm(`删除全部 ${state.localAnnouncements.length} 条本机公告？`)) return;
    state.localAnnouncements = [];
    saveState();
    renderAll();
    toast('已清除');
  });

  $('btnWipe').addEventListener('click', () => {
    openModal('确认清除', [
      h('p', {}, '会删掉本机保存的课表、待办、公告已读记录和全部设置。'),
      h('p', { class: 'muted small' }, '这个操作不可撤销。建议先「导出备份」。'),
    ], [
      { label: '取消', class: 'ghost-btn' },
      {
        label: '确认清除', class: 'danger-btn',
        onClick: () => {
          state = { schedule: null, todos: [], readAnnouncements: [], announcements: [], localAnnouncements: [], announcementsFetchedAt: '', settings: { ...DEFAULT_SETTINGS } };
          saveState();
          renderAll();
          applySettings();
          subscribeAnnouncePush(); // 频道设置也没了，把订阅一起断掉
          toast('已清除');
          return true;
        },
      },
    ]);
  });

  // 把设置回填到控件
  $('setAlarm').value = String(st().alarm);
  $('setTodoAlarm').value = String(st().todoAlarm ?? 30);
  $('setInApp').checked = st().inApp;
  $('setTheme').value = st().theme;
  $('setFont').value = String(st().font);
  $('setHideWeekend').checked = st().hideWeekend;
  $('setAnnUrl').value = st().annUrl ?? '';
  $('setAnnNotify').checked = Boolean(st().annNotify);
  renderAnnSrcStatus();
  renderLocalCount();
}

// ================================================================ 周次选择

/**
 * 直接跳到第 N 周。
 * 存在的理由：一学期 19 周，想查第 15 周有没有课要连点十几下「下一周」；
 * 手机上是十几次误触的机会，桌面壳里更烦人。
 */
function modalPickWeek() {
  const weeks = state.schedule?.termWeeks ?? [];
  if (!weeks.length) { toast('还没有课表数据'); return; }

  const thisWeek = currentWeekNumber();
  const grid = h('div', { class: 'weekpick' });
  for (const w of weeks) {
    grid.append(h('button', {
      class: 'wp-cell' +
        (w.serialNumber === ui.week ? ' cur' : '') +
        (w.serialNumber === thisWeek ? ' now' : ''),
      title: `${cnDate(w.startDate)}–${cnDate(w.endDate ?? addDays(w.startDate, 6))}`,
      onclick: () => { ui.week = w.serialNumber; renderWeek(); closeModal(); },
    }, String(w.serialNumber)));
  }

  openModal('跳到第几周', [
    h('p', { class: 'muted small' }, '蓝色方块是你正在看的周；带小圆点的是本周。'),
    grid,
  ], [
    { label: '回到本周', onClick: () => { ui.week = thisWeek; renderWeek(); } },
    { label: '关闭' },
  ]);
}

// ================================================================ 模态

let modalOnClose = null;
// 每次 openModal 记一个令牌。按钮里如果又开了一个弹窗（「三选一 → 上传文件」这种），
// 令牌就变了，此时**不能**再 closeModal —— 否则新开的面板会被立刻关掉，
// 表现是「点了没反应」。这是导航按钮最初真的踩到的坑。
let modalToken = 0;
function openModal(title, bodyNodes, buttons, opts = {}) {
  const token = ++modalToken;
  $('modalTitle').textContent = title;
  // 填课表的网格最窄要 720px，默认 560px 的弹窗里只能横向滚 —— 桌面上白白浪费宽度
  $('modal').querySelector('.modal-box')?.classList.toggle('wide', !!opts.wide);
  const body = $('modalBody');
  body.replaceChildren(...bodyNodes.filter(Boolean));

  const foot = $('modalFoot');
  foot.replaceChildren();
  for (const b of buttons ?? []) {
    foot.append(h('button', {
      class: b.class ?? 'ghost-btn',
      onclick: () => {
        const r = b.onClick ? b.onClick() : undefined;
        if (r === false) return;          // 明确要留着
        if (token !== modalToken) return; // 处理函数自己又开了新弹窗，别关
        closeModal();
      },
    }, b.label));
  }
  $('modal').classList.add('open');
}

function closeModal() {
  $('modal').classList.remove('open');
  if (modalOnClose) { modalOnClose(); modalOnClose = null; }
}

// ================================================================ 渲染总入口

function renderAll() {
  renderHeader();
  renderNowCard();
  if (ui.view === 'week') renderWeek();
  if (ui.view === 'day') renderDay();
  if (ui.view === 'todo') renderTodos();
  if (ui.view === 'ann') renderAnnouncements();
  updateBadges();
  $('aboutBox').textContent =
    `仰山课表 v${VERSION} · 北京信息科技大学 · 零服务器 · 课表仅存本机。` +
    `课表数据 ${state.schedule?.events?.length ?? 0} 节。`;
}

// ================================================================ 示例课表

/** 没数据时给一份虚构课表，让人先看到界面长什么样。全部是编的，不含任何真实信息。 */
function demoPack() {
  // ★ 学期起点按"今天"反推，让示例永远落在学期中间。
  // 写死日期的示例过两个月就会变成一整屏空白，第一次打开的人会以为程序坏了。
  const today = todayISO();
  const thisMonday = addDays(today, -(weekdayOf(today) - 1));
  const termStart = addDays(thisMonday, -5 * 7); // 今天正好是第 6 周

  const now = new Date();
  const y = now.getFullYear();
  const mo = now.getMonth() + 1;
  const [sy, t] = mo >= 9 ? [y, 1] : mo === 1 ? [y - 1, 1] : [y - 1, 2];
  const termCode = `${sy}-${sy + 1}-${t}`;

  const termWeeks = Array.from({ length: 20 }, (_, i) => {
    const start = addDays(termStart, i * 7);
    return { serialNumber: i + 1, startDate: start, endDate: addDays(start, 6) };
  });

  const bm = (weeks) => Array.from({ length: 20 }, (_, i) => (weeks.includes(i + 1) ? '1' : '0')).join('');
  const ALL = Array.from({ length: 16 }, (_, i) => i + 1);
  const mk = (courseName, dayOfWeek, beginSection, endSection, week, placeName, weeksAndTeachers) => ({
    courseName, dayOfWeek, beginSection, endSection, week, placeName, weeksAndTeachers, teachingTarget: '示例教学班',
  });

  const arrangedList = [
    mk('高等数学 A', 1, 1, 2, bm(ALL), '教一楼 101', '1-16周[讲授]/示例老师'),
    mk('大学英语', 1, 3, 4, bm(ALL.filter((w) => w % 2 === 1)), '教二楼 205', '1-15周(单)[讲授]/示例老师'),
    mk('数据结构', 2, 6, 7, bm(ALL), '实验楼 302', '1-16周[讲授]/示例老师'),
    mk('线性代数', 3, 1, 2, bm(ALL), '教一楼 203', '1-16周[讲授]/示例老师'),
    mk('大学物理', 3, 8, 9, bm(ALL.filter((w) => w % 2 === 0)), '教三楼 401', '2-16周(双)[讲授]/示例老师'),
    mk('程序设计实验', 4, 6, 9, bm([3, 6, 9, 12, 15]), '机房 A', '3-15周[实验]/示例老师'),
    mk('体育（篮球）', 5, 3, 4, bm(ALL), '体育馆', '1-16周[讲授]/示例老师'),
    mk('马克思主义基本原理', 5, 8, 9, bm(ALL), '教二楼 108', '1-16周[讲授]/示例老师'),
  ];

  return buildSchedule(
    { datas: { welcomeInfo: { xnxqdm: termCode }, userId: '' } },
    termWeeks,
    { datas: { arrangedList } },
  );
}

// ================================================================ 启动

function bindEvents() {
  for (const b of document.querySelectorAll('.tab')) {
    b.addEventListener('click', () => switchView(b.dataset.view));
  }

  $('weekPrev').addEventListener('click', () => { ui.week = (ui.week ?? 1) - 1; renderWeek(); });
  $('weekNext').addEventListener('click', () => { ui.week = (ui.week ?? 1) + 1; renderWeek(); });
  $('weekToday').addEventListener('click', () => { ui.week = currentWeekNumber(); renderWeek(); });
  $('weekLabel').addEventListener('click', modalPickWeek);

  $('dayPrev').addEventListener('click', () => { ui.day = addDays(ui.day, -1); renderDay(); });
  $('dayNext').addEventListener('click', () => { ui.day = addDays(ui.day, 1); renderDay(); });
  $('dayPicker').addEventListener('change', (e) => { ui.day = e.target.value || todayISO(); renderDay(); });

  $('btnImport').addEventListener('click', modalImport);
  $('onboardImport').addEventListener('click', () => { $('onboard').classList.remove('open'); modalImport(); });
  $('onboardDemo').addEventListener('click', () => {
    state.schedule = normalizeSchedulePack(demoPack());
    ui.week = currentWeekNumber();
    saveState();
    $('onboard').classList.remove('open');
    renderAll();
    toast('已载入示例课表（内容全是编的）');
  });

  $('btnBookmarklet').addEventListener('click', modalBookmarklet);
  $('btnEditSchedule').addEventListener('click', modalEditSchedule);
  $('btnExportIcs').addEventListener('click', modalExportIcs);
  $('btnShareCode').addEventListener('click', modalShareCode);
  $('btnExportImage').addEventListener('click', exportWeekImage);
  $('btnExportBackup').addEventListener('click', exportBackup);
  $('btnImportBackup').addEventListener('click', modalRestoreBackup);
  $('btnAddTodo').addEventListener('click', modalAddTodo);
  $('btnParseNotice').addEventListener('click', modalParseNotice);
  $('btnRefreshAnn').addEventListener('click', () => refreshAnnouncements());
  $('btnSettings').addEventListener('click', () => switchView('me'));
  $('btnSync').addEventListener('click', () => {
    const shell = globalThis.YangShanShell;
    refreshAnnouncements(true);
    if (shell && typeof shell.refresh === 'function') {
      toast('正在从教务系统刷新课表…');
      shell.refresh()
        .then((raw) => {
          applyPack(normalizeSchedulePack(raw));
          toast('课表已更新');
        })
        .catch((e) => toast('刷新失败：' + (e?.message || e)));
      return;
    }
    // 纯网页端受同源策略限制，改走书签抓取或手动导入。
    if (document.getElementById('bookmarklet-src')?.textContent?.trim()) modalBookmarklet();
    else modalImport();
  });

  $('modalClose').addEventListener('click', closeModal);
  $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      renderNowCard();
      checkReminders();
    }
  });
}

// ================================================================ 对外接口（给壳用）
//
// Windows / Android 的内置浏览器壳抓到数据后，要把数据交到这个内核手里。两种约定：
//
//   A. 先注入再导航：壳把数据挂在 window.__YS_PACK__ 上，然后 load 本页。
//      （适合"抓完直接跳过来"的顺序；main() 里会取用，等同于走了一次导入）
//   B. 先导航再注入：等 document.documentElement.dataset.ready === '1' 之后，
//      壳 evaluateJavascript 调用 YangShan.importRaw(obj)。
//      （适合"课表页已在眼前、抓完原地刷新"的顺序）
//
// 两条路径共用 applyPack，所以落盘、刷新、切视图的行为完全一致。
// 方法都返回可 JSON 序列化的普通值，方便壳那边从 evaluateJavascript 里取回结果；
// 失败时抛异常，message 是已经写好可以直接展示给用户的中文。

const bridge = {
  version: VERSION,

  /** 是否已有课表（壳用它决定是直接进主界面还是去抓数据）。 */
  hasSchedule: () => !!state.schedule,

  /** 课表概览；没有课表返回 null。 */
  summary: () =>
    state.schedule
      ? {
          termCode: state.schedule.termCode,
          studentCode: state.schedule.studentCode,
          events: state.schedule.events.length,
          weeks: state.schedule.termWeeks.length,
          firstDate: state.schedule.events[0]?.date ?? '',
          lastDate: state.schedule.events[state.schedule.events.length - 1]?.date ?? '',
        }
      : null,

  /** 原始抓取结果（YSRAW1 里的那个对象）或课表数据包 → 落库并切到周视图。 */
  importRaw: (obj) => applyPack(normalizeSchedulePack(obj)),

  /** 分享码 / JSON 文本 → 落库。等价于用户手动粘贴。 */
  importText: (text) => applyPack(parseAnyScheduleInput(text)),

  /**
   * 生成 ics 文本。壳可以写进文件、或交给系统日历应用订阅。
   * 默认把「未完成 + 有截止时间」的待办一起导出 —— 壳定时重抓课表时，
   * 这个函数产出的 .ics 会顺带把作业截止也刷新成最新的，这正是
   * 「导入作业后自动设置作业提醒」在无服务器前提下的可靠实现。
   * 传 { withTodos: false } 可只要课程。
   */
  toIcal: (opts = {}) => {
    const { withTodos = true, todoAlarmMinutes = 1440, ...rest } = opts;
    const todos = withTodos
      ? todoToEvents(state.todos).map((e) => ({ ...e, alarmMinutes: todoAlarmMinutes }))
      : [];
    return buildIcal([...(state.schedule?.events ?? []), ...todos], rest);
  },

  /** 当前状态快照（深拷贝），调试与自动化验证用。 */
  dump: () => JSON.parse(JSON.stringify(state)),
};

globalThis.YangShan = bridge;

async function main() {
  const q = new URLSearchParams(location.search);
  loadState();

  // ?demo=1 直接载入虚构示例 —— 既是"先看看长什么样"的分享链接，也是构建后的冒烟测试入口
  if (q.get('demo') === '1') {
    state.schedule = normalizeSchedulePack(demoPack());
  }

  // 约定 A（见上方 bridge 注释）：壳在导航前把数据挂上来了。
  // 放在 loadState 之后，但**优先于**本地已有数据 —— 壳刚抓的是最新的。
  let injected = false;
  if (globalThis.__YS_PACK__) {
    try {
      state.schedule = normalizeSchedulePack(globalThis.__YS_PACK__);
      injected = true;
    } catch (e) {
      // 不打断启动：让用户看到本地已有的课表，比白屏好
      console.warn('壳注入的课表数据无法使用', e);
    }
  }

  $('app').hidden = false;
  applySettings();
  bindEvents();
  bindSettings();
  if (state.schedule) ui.week = currentWeekNumber();
  renderAll();
  switchView(q.get('view') || 'week');
  $('onboard').classList.toggle('open', !state.schedule);
  // ?demo=1 是假数据，刻意不落盘；壳注入的是真数据，要落盘以便离线使用
  if (injected) saveState();

  // 公告刷新：打开时拉一次 + 每 15 分钟一次（仅页面可见时）+ 每次切回这个标签页时一次。
  // 页面在后台时不轮询 —— 手机浏览器本来就会冻结后台定时器，与其指望它，
  // 不如把"切回来的那一刻"当成可靠的刷新时机。
  if (state.settings.annUrl) refreshAnnouncements(true);
  subscribeAnnouncePush();
  setInterval(() => {
    if (document.visibilityState === 'visible') refreshAnnouncements(true);
  }, 15 * 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    renderNowCard();
    checkReminders();
    refreshAnnouncements(true);
    // 手机浏览器在后台会掐掉 SSE，切回来的这一刻顺手确认还连着
    if (state.settings.annTopic && !annSse) subscribeAnnouncePush();
  });

  setInterval(() => { renderNowCard(); checkReminders(); }, 60 * 1000);
  checkReminders();

  console.log(`仰山课表 v${VERSION} 已启动：${state.schedule?.events?.length ?? 0} 节课`);
  document.documentElement.dataset.ready = '1';

  // ?debug=1 —— 把布局尺寸写进标题。
  // 存在的理由：用户报"手机上显示不全"时，让他在地址后加 ?debug=1 截个图，
  // 一眼就能区分是"窗口真的太窄"还是"某个元素把页面撑宽了"。
  if (q.get('debug') === '1') {
    setTimeout(() => {
      const de = document.documentElement;
      let worst = null;
      let w = 0;
      for (const el of document.querySelectorAll('body *')) {
        if (el.scrollWidth > w) { w = el.scrollWidth; worst = el; }
      }
      document.title = `vw=${de.clientWidth} scrollW=${de.scrollWidth} ` +
        `grid=${document.getElementById('gridBody')?.scrollWidth ?? '-'} ` +
        `widest=${worst ? worst.tagName + '.' + (worst.className || '-') + '=' + w : '-'}`;
    }, 200);
  }
}

main();
