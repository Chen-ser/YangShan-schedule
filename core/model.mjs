// 本地数据模型 —— 课表数据包校验、分享码、待办（作业/网课）、公告、备份。
//
// 与 core/schedule.mjs 一样：零依赖、零 DOM、**不许出现 Node 专有 API**。
// 只用 TextEncoder / TextDecoder / btoa / atob 这些 Web 标准（Node 16+ 也有）。

import { buildSchedule, expandCourses, normalizeTermWeeks, todayISO } from './schedule.mjs';

export const SCHEMA = 1;
export const SHARE_PREFIX = 'YS1-';
/** 原始抓取结果的前缀（书签小工具 / 壳注入脚本产出）。 */
export const RAW_PREFIX = 'YSRAW1-';

// ---------------------------------------------------------------- base64url

const _enc = new TextEncoder();
const _dec = new TextDecoder();

/** UTF-8 字符串 → base64url（无 padding）。浏览器与 Node 18+ 都有 btoa/atob。 */
export function toBase64Url(str) {
  const bytes = _enc.encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url → UTF-8 字符串。 */
export function fromBase64Url(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return _dec.decode(bytes);
}

// ---------------------------------------------------------------- 课表数据包

function pickArrangedList(o) {
  if (Array.isArray(o?.arrangedList)) return o.arrangedList;
  if (Array.isArray(o?.datas?.arrangedList)) return o.datas.arrangedList;
  if (Array.isArray(o?.datas?.list)) return o.datas.list;
  if (Array.isArray(o?.data?.rows)) return o.data.rows;
  if (Array.isArray(o)) return o;
  return null;
}

function pickTermWeeks(o) {
  if (Array.isArray(o?.termWeeks)) return normalizeTermWeeks(o.termWeeks);
  if (o?.termWeeks) return normalizeTermWeeks(o.termWeeks);
  return [];
}

/**
 * 判断这是不是「原始抓取结果」—— 书签小工具和壳抓到的就是这种形状：
 * 原封不动把教务系统三个接口的响应装在一起。
 *
 * 为什么让书签小工具交原始响应、而不是已经算好的课表？
 * 因为这样书签小工具里几乎没有任何业务逻辑，它只有几十行；
 * 所有解析、展开、去重的规则都留在本应用里，改规则不需要用户重新存书签。
 */
export function isRawCapture(o) {
  if (!o || typeof o !== 'object') return false;
  if (o.kind === 'yangshan-raw') return true;
  return o.currentUser != null || o.scheduleDetail != null || o.schedule != null;
}

/**
 * 把外部来的东西（分享码解出来的、粘贴的、壳里注入脚本给的）规整成标准数据包。
 *
 * 只接受「有课表内容」的输入，其余一律抛出可读错误 —— 宁可让用户看到
 * 「这份数据里没有课表，可能复制错了」，也不要往本地写半截数据把已有课表弄坏。
 */
export function normalizeSchedulePack(input, opts = {}) {
  if (input == null) throw new Error('数据为空');
  if (typeof input === 'string') throw new Error('这是一段文本，不是课表数据。如果你是从书签小工具复制的，请粘贴完整的分享码或 JSON。');
  if (typeof input !== 'object') throw new Error('数据格式不对，期望一个对象');

  // 原始抓取结果 → 先组装成课表
  if (isRawCapture(input) && !Array.isArray(input.events)) {
    let pack;
    try {
      pack = buildSchedule(
        input.currentUser ?? input.user ?? null,
        input.termWeeks ?? input.weeks ?? null,
        input.scheduleDetail ?? input.schedule ?? input.detail ?? null,
      );
    } catch (e) {
      throw new Error('抓取到的数据不完整：' + e.message);
    }
    if (!pack.termWeeks.length) {
      throw new Error('这份抓取结果里没有学期周历，没法算出每节课的日期。可能是抓取时没有登录，或者教务系统换了接口。');
    }
    if (!pack.events.length) {
      throw new Error('这份抓取结果里没有课表内容。确认一下抓取时是不是当前学期，以及教务系统里确实有课。');
    }
    return pack;
  }

  const arrangedList = pickArrangedList(input);
  const events = Array.isArray(input.events) ? input.events : null;

  if ((!arrangedList || arrangedList.length === 0) && (!events || events.length === 0)) {
    throw new Error('这份数据里没有课表内容，可能是复制错了或者教务系统返回了空课表。');
  }

  const termWeeks = pickTermWeeks(input);
  const termCode = input.termCode || input.xnxqdm || '';

  if (!termWeeks.length) {
    throw new Error('这份数据里缺少学期周历（每一周的起止日期），没有它无法算出每节课的具体日期。');
  }

  return {
    schema: SCHEMA,
    kind: 'schedule',
    termCode,
    studentCode: input.studentCode ?? '',
    fetchedAt: input.fetchedAt ?? new Date().toISOString(),
    termWeeks,
    arrangedList: arrangedList ?? [],
    events: events ?? expandCourses(arrangedList, termWeeks, { termCode }),
  };
}

/** 从任意抓取结果组装（给壳和书签小工具用）。 */
export function packFromRaw(currentUser, termWeeks, scheduleDetail) {
  return buildSchedule(currentUser, termWeeks, scheduleDetail);
}

// ---------------------------------------------------------------- 分享码
// 设计取舍：分享码**不做压缩**，是同步的纯 base64url。
// 代价是长度偏大（一学期约 5-8KB 文本），收益是不引入 CompressionStream 的
// 异步与兼容性分支，且 iOS Safari 16.4 以下也能用。
// ⚠️ 因此分享码**不适合做成二维码**（二维码容量只有几 KB）——别在这上面浪费时间。

/** 只保留重建课表必需的最小字段；学号不进分享码。 */
function minimalPayload(pack) {
  return {
    s: SCHEMA,
    t: pack.termCode ?? '',
    w: normalizeTermWeeks(pack.termWeeks),
    l: (pack.arrangedList ?? []).map((c) => ({
      courseName: c.courseName,
      dayOfWeek: c.dayOfWeek,
      beginSection: c.beginSection,
      endSection: c.endSection,
      week: c.week,
      weeksAndTeachers: c.weeksAndTeachers,
      placeName: c.placeName,
      beginTime: c.beginTime,
      endTime: c.endTime,
      teachingTarget: c.teachingTarget,
    })),
  };
}

/** 课表数据包 → 分享码字符串。 */
export function encodeShareCode(pack) {
  const p = pack?.kind === 'schedule' ? pack : normalizeSchedulePack(pack);
  return SHARE_PREFIX + toBase64Url(JSON.stringify(minimalPayload(p)));
}

/** 分享码字符串 → 课表数据包。空白与换行会被忽略，方便从聊天软件里粘过来。 */
export function decodeShareCode(code) {
  const cleaned = String(code ?? '').replace(/\s+/g, '');
  if (!cleaned) throw new Error('分享码是空的');
  const body = cleaned.startsWith(SHARE_PREFIX) ? cleaned.slice(SHARE_PREFIX.length) : cleaned;

  let json;
  try {
    json = fromBase64Url(body);
  } catch {
    throw new Error('这不是有效的分享码，或者复制的时候漏掉了一段。');
  }

  let obj;
  try {
    obj = JSON.parse(json);
  } catch {
    throw new Error('分享码内容已损坏，请重新复制一次。');
  }

  if (!obj || typeof obj !== 'object') throw new Error('分享码内容已损坏，请重新复制一次。');

  const pack = {
    termCode: obj.t ?? '',
    termWeeks: Array.isArray(obj.w) ? obj.w : [],
    arrangedList: Array.isArray(obj.l) ? obj.l : [],
  };
  return normalizeSchedulePack(pack);
}

/** 自动识别输入是分享码、原始抓取结果还是 JSON，统一返回数据包。 */
export function parseAnyScheduleInput(text) {
  const s = String(text ?? '').trim();
  if (!s) throw new Error('没有内容');
  if (s.startsWith(RAW_PREFIX)) {
    let obj;
    try {
      obj = JSON.parse(fromBase64Url(s.slice(RAW_PREFIX.length).replace(/\s+/g, '')));
    } catch {
      throw new Error('抓取结果已损坏，或者复制的时候漏掉了一段。回到教务系统页面重新点一次书签。');
    }
    return normalizeSchedulePack(obj);
  }
  if (s.startsWith('{') || s.startsWith('[')) {
    let obj;
    try {
      obj = JSON.parse(s);
    } catch (e) {
      throw new Error('JSON 解析失败：' + e.message);
    }
    return normalizeSchedulePack(obj);
  }
  return decodeShareCode(s);
}

// ---------------------------------------------------------------- 待办

export const TODO_KINDS = Object.freeze({
  homework: { label: '作业', color: '#e8734a' },
  online: { label: '网课', color: '#4a8fe8' },
  exam: { label: '考试', color: '#d94a6a' },
  other: { label: '其他', color: '#8a8a8a' },
});

function normDue(due) {
  if (!due) return '';
  const s = String(due).trim().replace(/\//g, '-').replace(' ', 'T');
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:T(\d{1,2}):(\d{2}))?/);
  if (!m) return s;
  const p = (n) => String(n).padStart(2, '0');
  return `${m[1]}-${p(m[2])}-${p(m[3])}T${p(m[4] ?? '23')}:${m[5] ?? '59'}`;
}

/** 新增或按 id 更新一条待办，返回按截止时间升序的新数组（不改原数组）。 */
export function upsertTodo(list, todo) {
  const arr = Array.isArray(list) ? list.slice() : [];
  const item = {
    id: todo.id || `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    title: String(todo.title ?? '').trim() || '未命名',
    due: normDue(todo.due),
    kind: TODO_KINDS[todo.kind] ? todo.kind : 'other',
    note: todo.note ?? '',
    done: Boolean(todo.done),
    createdAt: todo.createdAt ?? new Date().toISOString(),
  };
  const i = arr.findIndex((x) => x.id === item.id);
  if (i >= 0) arr[i] = { ...arr[i], ...item };
  else arr.push(item);
  return arr.sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
}

export function removeTodo(list, id) {
  return (Array.isArray(list) ? list : []).filter((x) => x.id !== id);
}

export function toggleTodo(list, id) {
  return (Array.isArray(list) ? list : []).map((x) => (x.id === id ? { ...x, done: !x.done } : x));
}

/** 距离截止还有多久；已过期为负数。返回 {days,hours,overdue}。 */
export function todoCountdown(due, now = new Date()) {
  if (!due) return null;
  const [d, t] = String(due).split('T');
  const [y, mo, da] = d.split('-').map(Number);
  const [h, mi] = (t || '23:59').split(':').map(Number);
  const target = new Date(y, mo - 1, da, h, mi);
  const ms = target.getTime() - now.getTime();
  const overdue = ms < 0;
  const abs = Math.abs(ms);
  return {
    overdue,
    days: Math.floor(abs / 86400000),
    hours: Math.floor((abs % 86400000) / 3600000),
    minutes: Math.floor((abs % 3600000) / 60000),
  };
}

// ---------------------------------------------------------------- 提醒时间

/**
 * 'YYYY-MM-DDTHH:MM' 提前 minutes 分钟 → 同一格式。纯字符串运算，不涉及时区。
 * 用于把「提醒提前量」翻译成系统日历/通知能用的绝对时刻。
 */
export function remindAt(dueLocal, minutes = 15) {
  const m = String(dueLocal ?? '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return '';
  const [, y, mo, da, h, mi] = m;
  const t = Date.UTC(Number(y), Number(mo) - 1, Number(da), Number(h), Number(mi)) - Number(minutes) * 60000;
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// ---------------------------------------------------------------- 待办 → 事件

const p2 = (n) => String(n).padStart(2, '0');

/** 'HH:MM' 归一化，非法输入退回 '23:59'（与 normDue 的默认一致）。 */
function normHM(t) {
  const m = String(t ?? '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return '23:59';
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return '23:59';
  return `${p2(h)}:${p2(mi)}`;
}

/** 'HH:MM' 加 n 分钟，跨天就截到 23:59（日历块不跨日，省得各端表现不一）。 */
function addMinutesHM(hm, n) {
  const [h, mi] = hm.split(':').map(Number);
  const total = h * 60 + mi + Number(n);
  if (total >= 24 * 60) return '23:59';
  return `${p2(Math.floor(total / 60))}:${p2(total % 60)}`;
}

/**
 * 待办 → 可进 .ics / 应用内提醒的事件。
 *
 * 只产出「未完成 + 有截止时间」的条目：已经勾掉的待办不该再响，
 * 没填截止时间的待办也没有"什么时候提醒"可言。
 *
 * UID 前缀 `ys-todo-` 与课程事件（`bistu-`）刻意分开，这样
 * 「同一门课改教室」不会影响待办，「同一条待办改标题」也不会影响课程。
 */
export function todoToEvents(todos, opts = {}) {
  const block = Number.isFinite(opts.blockMinutes) ? opts.blockMinutes : 30;
  return (Array.isArray(todos) ? todos : [])
    .filter((t) => t && !t.done && t.due)
    .map((t) => {
      const [date, time = '23:59'] = String(t.due).split('T');
      const start = normHM(time);
      return {
        kind: 'todo',
        id: t.id,
        uid: `ys-todo-${String(t.id ?? '').replace(/[^A-Za-z0-9-]/g, '')}@bistu.schedule`,
        date,
        start,
        end: addMinutesHM(start, block),
        title: t.title,
        todoKind: t.kind,
        todoKindLabel: TODO_KINDS[t.kind]?.label ?? '待办',
        note: t.note || '',
        due: t.due,
      };
    });
}

/** 距截止还有多久该提醒 —— 待办专用，返回绝对值（分钟）；无截止时间返回 null。 */
export function todoRemindIn(todo, now = new Date()) {
  const at = remindAt(todo?.due, 0);
  if (!at) return null;
  const [d, t] = at.split('T');
  const [y, mo, da] = d.split('-').map(Number);
  const [h, mi] = t.split(':').map(Number);
  return (new Date(y, mo - 1, da, h, mi).getTime() - now.getTime()) / 60000;
}

// ---------------------------------------------------------------- 公告

/**
 * 归一化公告列表（来自 announcements.json），按日期倒序。
 * 公告是纯静态文件、学生端只读 —— 正因为没有服务器，公告的"实时"只能靠
 * 打开网页时重新拉取，做不到主动推送。这一点在 README 里必须说清楚。
 */
export function normalizeAnnouncements(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.announcements) ? raw.announcements : [];
  return list
    .filter((a) => a && (a.title || a.body))
    .map((a, i) => ({
      id: String(a.id ?? `ann-${i}`),
      title: String(a.title ?? '').trim() || '无标题',
      date: String(a.date ?? '').trim(),
      body: String(a.body ?? ''),
      pinned: Boolean(a.pinned),
      level: ['info', 'warn', 'urgent'].includes(a.level) ? a.level : 'info',
      link: a.link ? String(a.link) : '',
    }))
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return (b.date || '').localeCompare(a.date || '');
    });
}

/** 未读公告数。 */
export function unreadCount(announcements, readIds) {
  const list = Array.isArray(announcements) ? announcements : [];
  const read = new Set(Array.isArray(readIds) ? readIds : []);
  return list.filter((a) => !read.has(a.id)).length;
}

/** 极简 Markdown → HTML（只支持公告里真正会用到的几种）。 */
export function miniMarkdown(src) {
  const esc = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const lines = String(src ?? '').split(/\r?\n/);
  const out = [];
  let inList = false;
  const inline = (s) =>
    esc(s)
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');

  for (const line of lines) {
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (li) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      out.push(`<h${h[1].length + 2}>${inline(h[2])}</h${h[1].length + 2}>`);
      continue;
    }
    if (!line.trim()) continue;
    out.push(`<p>${inline(line)}</p>`);
  }
  if (inList) out.push('</ul>');
  return out.join('');
}

// ---------------------------------------------------------------- 通知文本解析

const KIND_RULES = [
  [/网课|在线|视频|慕课|mooc|学习通|雨课堂/i, 'online'],
  [/作业|习题|报告|论文|实验/i, 'homework'],
  [/考试|测验|测评|补考|重修/i, 'exam'],
];

/**
 * 解析从微信/QQ/学习通里复制来的通知文本 → 待办数组。
 *
 * ⚠️ 边界说清楚：微信**不会**把聊天记录给第三方读，所以这里只能处理
 * 用户自己复制过来的文字。不存在"导入微信自动生成提醒"这回事。
 */
export function parseNoticeText(text) {
  const raw = String(text ?? '');
  if (!raw.trim()) return [];

  const out = [];
  const year = new Date().getFullYear();

  for (const line of raw.split(/\r?\n/)) {
    // 2025-09-10 23:59 / 2025/9/10 23:59 / 2025年9月10日 23:59 / 9月10日 23:59 / 09-10 23:59
    const m = line.match(
      /(?:(\d{4})\s*[-/年]\s*)?(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?\s*(?:[T\s]*(\d{1,2}):(\d{2}))?/,
    );
    if (!m) continue;

    const y = m[1] ? Number(m[1]) : year;
    const mo = Number(m[2]);
    const da = Number(m[3]);
    if (!(mo >= 1 && mo <= 12 && da >= 1 && da <= 31)) continue;

    const hasTime = m[4] != null;
    const hh = hasTime ? Number(m[4]) : 23;
    const mi = hasTime ? Number(m[5]) : 59;
    if (hh > 23 || mi > 59) continue;

    const before = line.slice(0, m.index).trim();
    const after = line.slice(m.index + m[0].length).trim();
    let title = before || after;
    title = title
      .replace(/[【】\[\]（）()]/g, '')
      .replace(/^(截止时间|提交时间|截止|时间)[:：]?/, '')
      .replace(/(截止时间|提交时间|截止)[:：]?$/, '')
      .replace(/[,，。;；:：\s]+$/, '')
      .replace(/^[,，。;；:：\s]+/, '')
      .trim();

    if (!title) title = '待办';
    if (title.length > 60) title = title.slice(0, 60) + '…';

    let kind = 'other';
    for (const [re, k] of KIND_RULES) {
      if (re.test(line)) {
        kind = k;
        break;
      }
    }

    const p = (n) => String(n).padStart(2, '0');
    const due = `${y}-${p(mo)}-${p(da)}T${p(hh)}:${p(mi)}`;
    out.push({ title, due, kind, note: line.trim() });
  }
  return out;
}

// ---------------------------------------------------------------- 备份

export function serializeBackup(state) {
  return JSON.stringify(
    {
      schema: SCHEMA,
      kind: 'backup',
      exportedAt: new Date().toISOString(),
      schedule: state?.schedule ?? null,
      todos: state?.todos ?? [],
      readAnnouncements: state?.readAnnouncements ?? [],
      settings: state?.settings ?? {},
    },
    null,
    2,
  );
}

export function parseBackup(text) {
  let obj;
  try {
    obj = JSON.parse(String(text ?? ''));
  } catch (e) {
    throw new Error('备份文件解析失败：' + e.message);
  }
  if (!obj || typeof obj !== 'object') throw new Error('备份文件内容不对');
  if (obj.kind && obj.kind !== 'backup') throw new Error('这不是本应用的备份文件');
  return {
    schema: obj.schema ?? SCHEMA,
    kind: 'backup',
    exportedAt: obj.exportedAt ?? '',
    schedule: obj.schedule ?? null,
    todos: Array.isArray(obj.todos) ? obj.todos : [],
    readAnnouncements: Array.isArray(obj.readAnnouncements) ? obj.readAnnouncements : [],
    settings: obj.settings && typeof obj.settings === 'object' ? obj.settings : {},
  };
}

/** 备份文件名，形如 课表备份-2026-10-09.json */
export function backupFileName(now = new Date()) {
  return `课表备份-${todayISO(now)}.json`;
}
