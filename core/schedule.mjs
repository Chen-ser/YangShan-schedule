// 课表核心纯逻辑 —— 强智 EMAP 原始数据 → 归一化事件 → iCal。
//
// 这个文件是四个客户端（Win 壳 / 安卓壳 / 网页 / 书签小工具）共用的唯一真相。
// 因此它必须满足两条硬约束，改这里之前先想清楚：
//   1. 零依赖、零网络、零 DOM；
//   2. **不许出现任何 Node 专有 API**（node:crypto、Buffer、process…），
//      否则打包进网页后在浏览器里直接崩。历史上这里用过 createHash 和
//      Buffer.byteLength，是改造成浏览器可用时踩掉的第一个坑。
//
// 打包方式见 web/build.mjs：它把本文件去掉 import/export 后内联进单文件 HTML。

// ---------------------------------------------------------------- 节次

/**
 * 北信科节次时间表（官方公布 12 节）。
 *
 * ★ 这张表最初是**从真实接口反推**出来的，不是抄来的：
 *   把 22 门课的 (beginSection, beginTime) 与 (endSection, endTime) 对齐，
 *   得到 1→08:30、2→09:20-10:05、3→10:20-11:05、4→11:55、5→13:30、
 *   6→15:05、7→15:55、8→16:10、9→17:45、10→19:00、11→20:35、12→21:25，
 *   全部符合「每节 45 分钟 + 课间 5 分钟」的规律，缺口据此补齐。
 *   网上流传的同校油猴脚本用的是 08:00 开头、第 5 节在 11:30 的另一张表，
 *   与本校现行作息整整差了一节课，照抄会给出错误的提醒时间。
 *
 * ★ 事后拿到学校公布的作息表核对，**第 1–12 节逐条完全一致**，官方表到第 12 节为止。
 *   第 13 节是按同一规律续推的推测值（教务导出的 Excel 模板把行预留到了第 14 节，
 *   但真实数据里从未出现），保留它只为「万一有课落在第 13 节也不至于显示成 08:00」。
 *
 * 课程自带 beginTime/endTime 时**优先用课程自带的**（真实接口两列都有值），
 * 本表只在字段缺失时兜底，同时用于渲染左侧的节次时间轴。
 */
export const SECTION_TIMES = Object.freeze([
  { start: '08:30', end: '09:15' }, // 1
  { start: '09:20', end: '10:05' }, // 2
  { start: '10:20', end: '11:05' }, // 3
  { start: '11:10', end: '11:55' }, // 4
  { start: '13:30', end: '14:15' }, // 5
  { start: '14:20', end: '15:05' }, // 6
  { start: '15:10', end: '15:55' }, // 7
  { start: '16:10', end: '16:55' }, // 8
  { start: '17:00', end: '17:45' }, // 9
  { start: '19:00', end: '19:45' }, // 10
  { start: '19:50', end: '20:35' }, // 11
  { start: '20:40', end: '21:25' }, // 12
  { start: '21:30', end: '22:15' }, // 13（推测值，真实数据未覆盖）
]);

export const WEEKDAY_NAMES = Object.freeze(['一', '二', '三', '四', '五', '六', '日']);

const pad = (n) => String(n).padStart(2, '0');

// ---------------------------------------------------------------- UTF-8
// 自己算字节数，不用 Buffer 也不用 TextEncoder：
// Buffer 在浏览器里不存在；TextEncoder 每次都要分配对象，折行时逐字符调用太浪费。

/** 单个码点的 UTF-8 字节数。 */
export function charBytes(codePoint) {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/** 字符串的 UTF-8 字节长度，与 Buffer.byteLength(s,'utf8') 等价。 */
export function utf8Length(str) {
  let n = 0;
  for (const ch of String(str ?? '')) n += charBytes(ch.codePointAt(0));
  return n;
}

// ---------------------------------------------------------------- 哈希
// UID 需要一个稳定、跨端一致、且不依赖 Node 的散列。
// 用 BigInt 实现的 FNV-1a 64 位：定长、无碰撞风险、在任何 JS 引擎上结果一致。

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

/** FNV-1a 64 位 → 16 位十六进制串。输入按 UTF-8 字节参与运算，保证跨端一致。 */
export function fnv1a64(str) {
  let h = FNV_OFFSET;
  for (const ch of String(str ?? '')) {
    const cp = ch.codePointAt(0);
    // 把码点拆成 UTF-8 字节序列再喂进去
    let bytes;
    if (cp < 0x80) bytes = [cp];
    else if (cp < 0x800) bytes = [0xc0 | (cp >> 6), 0x80 | (cp & 0x3f)];
    else if (cp < 0x10000) bytes = [0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)];
    else bytes = [0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)];
    for (const b of bytes) {
      h = (h ^ BigInt(b)) & MASK64;
      h = (h * FNV_PRIME) & MASK64;
    }
  }
  return h.toString(16).padStart(16, '0');
}

/**
 * 事件 UID。
 *
 * ★ 这里不含地点和教师 —— 这是刻意的，也是整个导入体验里最容易埋雷的一处：
 * UID 只由「学期 + 课程 + 星期 + 节次 + 具体日期」决定，所以教务处把教室换了、
 * 或者换了个老师，用户重新导入时日历里是**原地更新**；一旦把地点混进来，
 * 重新导入就会变成"旧事件没人删、新事件又加一遍"，用户日历直接脏掉。
 */
export function uidFor(parts) {
  return `bistu-${fnv1a64(parts.join('|'))}@bistu.schedule`;
}

// ---------------------------------------------------------------- 周次

/**
 * 解析强智的周次位图。第 i 位为 '1' 表示第 i+1 周上课。
 * 例：'1111111111111111000000' → [1..16]
 */
export function parseWeekBitmap(week) {
  if (typeof week !== 'string' || week.length === 0) return [];
  const out = [];
  for (let i = 0; i < week.length; i++) {
    if (week[i] === '1') out.push(i + 1);
  }
  return out;
}

/**
 * 位图缺失时的兜底：从人读串里抠周次。
 * 支持 '1-16周[讲授]'、'1-16周(单)'、'1-4,9-12周'、'1、5、9周'、'第3周'，
 * 也接受 '1-16周[讲授]/张三' 这种带教师后缀的完整串（直接切掉 '/' 之后的部分），
 * 以及一门课多段写法 '1-7周[讲授]; 1-7周[讲授]'。
 */
export function parseWeeksFromText(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const parity = /单/.test(text) ? 'odd' : /双/.test(text) ? 'even' : null;

  const s = text
    .split('/')[0] // ★ 切掉 '/教师' 后缀：不切的话 '1-16周/张三' 会因为尾部杂质整段解析失败
    .replace(/\[[^\]]*\]/g, '') // 去 [讲授] 等
    .replace(/[（(][^）)]*[）)]/g, '') // 去 (单)/(双)
    .replace(/单|双/g, '')
    .replace(/[第周\s]/g, '')
    .replace(/[、，;；]/g, ','); // ★ 半角/全角分号也要算分隔符（多段写法用 ';'）

  const set = new Set();
  for (const seg of s.split(',').map((x) => x.trim())) {
    if (!seg) continue;
    const range = seg.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) set.add(i);
      continue;
    }
    const one = seg.match(/^(\d+)$/);
    if (one) set.add(Number(one[1]));
  }

  let arr = [...set].sort((x, y) => x - y);
  if (parity === 'odd') arr = arr.filter((w) => w % 2 === 1);
  if (parity === 'even') arr = arr.filter((w) => w % 2 === 0);
  return arr;
}

/**
 * 把 '1-16周[讲授]/张三' 拆成 { weeksText, teacher, teachers }。
 *
 * ★ 一门课**可能挂多个教师、写成多段**（真实数据里就有）：
 *   '1-7周[讲授]/陈曦[主讲]; 1-7周[讲授]/古一[主讲]'
 * 早先的实现只按第一个 '/' 切，第二段的周次串会混进教师名里，
 * 界面上就会出现"教师：陈曦; 1-7周/古一"这种东西。
 * 正确做法是按 '/' 全部切开：偶数段是周次、奇数段是教师。
 */
export function splitWeeksTeachers(v) {
  if (typeof v !== 'string' || v.length === 0) return { weeksText: '', teacher: '', teachers: [] };
  if (!v.includes('/')) return { weeksText: v, teacher: '', teachers: [] };

  const weeksParts = [];
  const teachers = [];
  // 一门课的多段之间用 ';' 分隔：'1-7周[讲授]/陈曦[主讲]; 1-7周[讲授]/古一[主讲]'
  // ★ 必须先按 ';' 切段、再在段内按最后一个 '/' 切 —— 直接全局 split('/') 会让
  //   第二段的周次串落进"教师"位（偶数/奇数段并不交替，真实数据里就是这样）。
  for (const group of v.split(/[;；]/)) {
    const g = group.trim();
    if (!g) continue;
    const i = g.lastIndexOf('/');
    if (i < 0) {
      weeksParts.push(g);
      continue;
    }
    const wk = g.slice(0, i).trim();
    if (wk) weeksParts.push(wk);
    const t = g.slice(i + 1).replace(/\[[^\]]*\]/g, '').trim();
    if (t && !teachers.includes(t)) teachers.push(t);
  }
  return {
    weeksText: weeksParts.join('; '),
    teacher: teachers.join(' · '),
    teachers,
  };
}

// ---------------------------------------------------------------- 学期周历

/**
 * 归一化 getTermWeeks.do 的返回（原始响应对象或裸数组都吃），按周序升序。
 *
 * ★ 这一条推翻了动手前的判断：原本以为"教务一般不给学期起始日，得自建校历 JSON"，
 * 实测本校 getTermWeeks 直接给出每一周的 startDate/endDate，所以校历不需要人工维护，
 * 也不存在"每年开学要改配置文件"的维护负担。
 */
export function normalizeTermWeeks(raw) {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.datas?.getTermWeeks)
      ? raw.datas.getTermWeeks
      : [];
  return list
    .filter((w) => w && typeof w.serialNumber !== 'undefined' && typeof w.startDate === 'string')
    .map((w) => ({
      serialNumber: Number(w.serialNumber),
      startDate: dateOnly(w.startDate),
      endDate: dateOnly(w.endDate),
    }))
    .sort((a, b) => a.serialNumber - b.serialNumber);
}

/** '2025-2026-1' → { year, term, label } */
export function parseTermCode(code) {
  const parts = String(code ?? '').split('-');
  if (parts.length !== 3) return { year: '', term: 0, label: String(code ?? '') };
  const year = `${parts[0]}-${parts[1]}`;
  const term = Number(parts[2]);
  const name = term === 1 ? '上学期' : term === 2 ? '下学期' : term === 3 ? '小学期' : `第${term}学期`;
  return { year, term, label: `${year}学年 ${name}` };
}

// ---------------------------------------------------------------- 日期

/**
 * 只取日期部分。
 *
 * ★ 真实接口给的日期是 '2026-09-07 00:00:00'，带着时分秒。
 *   第一版 normalizeTermWeeks 原样收下，结果 addDays 里 Number('07 00:00:00') = NaN，
 *   所有事件日期变成 'NaN-NaN-NaN'；又因为 UID 里含日期，NaN 全相同 → 全部互相去重，
 *   22 门课只剩 22 个事件。这个坑是拿真实响应做回归才暴露出来的。
 */
function dateOnly(v) {
  return typeof v === 'string' ? v.slice(0, 10) : v;
}

/** '2025-09-01' + n 天 → '2025-09-03'。纯字符串进、纯字符串出，不碰时区。 */
export function addDays(iso, n) {
  const [y, m, d] = dateOnly(iso).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + n * 86400000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** '0800' / '8:00' / '08:00' → '08:00'；识别不了返回 null。 */
export function normTime(t) {
  if (!t) return null;
  const m = String(t).trim().match(/^(\d{1,2}):?(\d{2})$/);
  return m ? `${pad(Number(m[1]))}:${m[2]}` : null;
}

/** '2025-09-03' → 3（周三）。用 UTC 算，避开本地时区把日期推前一天的经典坑。 */
export function weekdayOf(iso) {
  const [y, m, d] = dateOnly(iso).split('-').map(Number);
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return w === 0 ? 7 : w;
}

/** 两个 'YYYY-MM-DD' 之间相差几天（b - a）。 */
export function daysBetween(a, b) {
  const [ay, am, ad] = dateOnly(a).split('-').map(Number);
  const [by, bm, bd] = dateOnly(b).split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

/** 今天（本地时区）的 'YYYY-MM-DD'。 */
export function todayISO(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 当前时刻的 'HH:MM'。 */
export function nowHM(now = new Date()) {
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

// ---------------------------------------------------------------- 展开

/**
 * arrangedList + 学期周历 → 每节课一个带具体日期的归一化事件。
 *
 * 展开规则：周次位图 × 学期周历（第 N 周的 startDate）× 星期几。
 * 周历里没有的周直接跳过而不是猜一个日期 —— 宁可少一节课，也不要给用户一节日期的课。
 */
export function expandCourses(arrangedList, termWeeks, opts = {}) {
  const weeks = normalizeTermWeeks(termWeeks);
  if (!Array.isArray(arrangedList) || arrangedList.length === 0 || weeks.length === 0) return [];

  const startOf = new Map(weeks.map((w) => [w.serialNumber, w.startDate]));
  const seen = new Set();
  const events = [];

  for (const course of arrangedList) {
    if (!course) continue;
    const courseName = course.courseName || '未知课程';
    const dayOfWeek = Number(course.dayOfWeek) || 1;
    const beginSection = Number(course.beginSection) || 1;
    const endSection = Number(course.endSection) || beginSection;

    const { weeksText, teacher } = splitWeeksTeachers(course.weeksAndTeachers);
    let weekNumbers = parseWeekBitmap(course.week);
    if (weekNumbers.length === 0) weekNumbers = parseWeeksFromText(weeksText);

    const sectionStart = SECTION_TIMES[beginSection - 1]?.start;
    const sectionEnd = SECTION_TIMES[endSection - 1]?.end;
    const start = normTime(course.beginTime) ?? sectionStart ?? '08:00';
    const end = normTime(course.endTime) ?? sectionEnd ?? start;

    // placeName 偶尔为空（真实数据 22 条里就有 1 条）。此时从 titleDetail 里捞地点，
    // 但**只认 data-kblx="01" 这个地点锚点** —— 早先的写法是「剥掉标签取最后一个词」，
    // 遇到"只有教师锚点、没有地点锚点"的条目会把老师名字当成教室显示出来。
    let location = course.placeName || '';
    if (!location && Array.isArray(course.titleDetail)) {
      for (const frag of course.titleDetail) {
        const m = String(frag).match(/<a[^>]*data-kblx=["']?01["']?[^>]*>([^<]*)<\/a>/);
        if (m && m[1].trim()) {
          location = m[1].trim();
          break;
        }
      }
    }

    for (const weekNum of weekNumbers) {
      const weekStart = startOf.get(weekNum);
      if (!weekStart) continue; // 学期周历里没有这一周 → 跳过，不猜

      const date = addDays(weekStart, dayOfWeek - 1);
      const uid = uidFor([opts.termCode ?? '', courseName, dayOfWeek, beginSection, endSection, date]);
      if (seen.has(uid)) continue;
      seen.add(uid);

      events.push({
        uid,
        course: courseName,
        teacher,
        location,
        teachingTarget: course.teachingTarget || '',
        date,
        start,
        end,
        week: weekNum,
        dayOfWeek,
        beginSection,
        endSection,
      });
    }
  }

  events.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  return events;
}

/**
 * 原始响应 → 可持久化的课表数据包。
 *
 * 这是「抓取」与「渲染」之间的契约：书签小工具抓完就产出这个结构，
 * 网页、Win 壳、安卓壳都只认它。任何一端要改，先改这里。
 */
export function buildSchedule(currentUser, termWeeks, scheduleDetail, opts = {}) {
  const cu = currentUser?.datas ?? currentUser ?? {};
  const termCode = opts.termCode || cu.welcomeInfo?.xnxqdm || '';
  const studentCode =
    opts.studentCode || cu.userId || cu.user?.xh || cu.user?.usrId || cu.student?.xh || cu.welcomeInfo?.xh || '';

  const list =
    scheduleDetail?.datas?.arrangedList ??
    scheduleDetail?.datas?.list ??
    scheduleDetail?.data?.rows ??
    (Array.isArray(scheduleDetail) ? scheduleDetail : []);

  const weeks = normalizeTermWeeks(termWeeks);
  const events = expandCourses(list, weeks, { termCode });

  return {
    schema: 1,
    kind: 'schedule',
    termCode,
    studentCode,
    fetchedAt: opts.fetchedAt ?? new Date().toISOString(),
    termWeeks: weeks,
    arrangedList: list,
    events,
    // 未安排时间的课（`datas.notArrangeList`）。
    // 这一支很容易被漏掉：同一次响应里它和 arrangedList 平级，但**没有 dayOfWeek / 节次 / 教室**，
    // 所以展开不出任何事件 —— 如果只读 arrangedList，学生就会以为"我这学期只有 22 门"，
    // 而实际上还有 5 门（本样本共 7 学分）没排上课表。它们通常是要等通知的网课/军训/通识课。
    unscheduled: normalizeUnscheduled(
      scheduleDetail?.datas?.notArrangeList ?? scheduleDetail?.datas?.unArrangeList ?? [],
    ),
  };
}

/**
 * 未排课列表归一化。保留「能看到全部学分和教师」所需的最小字段。
 * 这些课没有具体上课时间，做不了提醒，但必须让学生看得见。
 */
export function normalizeUnscheduled(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c) => c && typeof c === 'object' && (c.courseName || c.courseCode))
    .map((c) => ({
      courseName: String(c.courseName ?? '').trim(),
      courseCode: String(c.courseCode ?? '').trim(),
      credit: String(c.credit ?? '').trim(),
      weekBitmap: String(c.week ?? ''),
      weeks: parseWeekBitmap(c.week),
      weeksAndTeachers: String(c.weeksAndTeachers ?? '').trim(),
      // 一门课可能有多个教师：'1-7周[讲授]/陈曦[主讲]; 1-7周[讲授]/古一[主讲]'
      teachers: splitWeeksTeachers(c.weeksAndTeachers).teachers,
      teachingTarget: String(c.teachingTarget ?? '').trim(),
      // 少数条目其实带了一点时间信息，有就留着，UI 可以顺带显示
      beginTime: normTime(c.beginTime),
      endTime: normTime(c.endTime),
      placeName: String(c.placeName ?? '').trim(),
    }));
}

// ---------------------------------------------------------------- iCal

/** RFC 5545 TEXT 转义：反斜杠、分号、逗号、换行。 */
export function escapeIcalText(v) {
  return String(v ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * RFC 5545 折行：物理行按 UTF-8 字节不超过 75，续行以单个空格开头。
 * ★ 必须按字节切而不是按字符：中文一个字 3 字节，按 75 个字符折会变成 225 字节，
 * Outlook 和 iOS 日历会直接截断，表现为"课表名显示不全"。
 */
export function foldLine(line) {
  if (utf8Length(line) <= 75) return line;
  const parts = [];
  let cur = '';
  let bytes = 0;
  let budget = 75;
  for (const ch of line) {
    const b = charBytes(ch.codePointAt(0));
    if (bytes + b > budget) {
      parts.push(cur);
      cur = '';
      bytes = 0;
      budget = 74; // 续行首部那个空格占 1 字节
    }
    cur += ch;
    bytes += b;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}

export const dtLocal = (date, time) => `${String(date).replace(/-/g, '')}T${String(time).replace(':', '')}00`;
export const dtUtc = (d = new Date()) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;

/**
 * 事件数组 → .ics 文本。
 * @param {Array} events 归一化事件（expandCourses 的产物）
 * @param {{calName?:string, sequence?:number, dtstamp?:string, prodId?:string, alarmMinutes?:number}} opts
 */
export function buildIcal(events, opts = {}) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${opts.prodId ?? '-//YangShan Schedule//CN'}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcalText(opts.calName ?? '课表')}`,
    'X-WR-TIMEZONE:Asia/Shanghai',
  ];

  const stamp = opts.dtstamp ?? dtUtc();
  const sequence = Number.isInteger(opts.sequence) ? opts.sequence : 0;
  const alarm = Number.isFinite(opts.alarmMinutes) ? opts.alarmMinutes : null;

  for (const e of events ?? []) {
    // 待办（作业/网课/考试截止）走另一套文案：它们没有教师、教室、节次，
    // 硬套课程模板会往日历里塞一堆"教师: 未知 / 节次: 0-0节"。
    const isTodo = e.kind === 'todo';
    const desc = isTodo
      ? [
          `类型: ${e.todoKindLabel || '待办'}`,
          `截止: ${String(e.due ?? '').replace('T', ' ')}`,
          e.note && e.note !== e.title ? `原文: ${e.note}` : '',
        ].filter(Boolean).join('\n')
      : [
          `课程名称: ${e.course}`,
          `教师: ${e.teacher || '未知'}`,
          `地点: ${e.location || '未知'}`,
          `周次: 第${e.week}周`,
          `节次: ${e.beginSection}-${e.endSection}节`,
          `教学班: ${e.teachingTarget || '未知'}`,
        ].join('\n');

    const summary = isTodo ? `【${e.todoKindLabel || '待办'}】${e.title}` : e.course;

    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${dtLocal(e.date, e.start)}`,
      `DTEND:${dtLocal(e.date, e.end)}`,
      `SUMMARY:${escapeIcalText(summary)}`,
      `DESCRIPTION:${escapeIcalText(desc)}`,
    );

    // 待办不写 LOCATION（没有地点），课程写上。
    if (!isTodo) lines.push(`LOCATION:${escapeIcalText(e.location || '未知')}`);
    lines.push(`SEQUENCE:${sequence}`);

    // 日历级订阅（webcal）里 VALARM 各端支持度参差，所以只在用户明确要"文件导入"时才写。
    // 待办的提前量按条目决定（导出弹窗里选），课程用全局那个。
    const lead = isTodo ? (Number.isFinite(e.alarmMinutes) ? e.alarmMinutes : alarm) : alarm;
    if (lead !== null && lead !== undefined && Number.isFinite(lead)) {
      lines.push(
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        `TRIGGER:-PT${Math.max(0, Math.round(lead))}M`,
        `DESCRIPTION:${escapeIcalText(isTodo ? `${e.title} 快要截止了` : e.course + ' 即将开始')}`,
        'END:VALARM',
      );
    }

    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- 派生视图

/** 取某个学期周历里"第 N 周"的信息；超出范围返回 null。 */
export function weekInfo(termWeeks, weekNum) {
  return normalizeTermWeeks(termWeeks).find((w) => w.serialNumber === Number(weekNum)) ?? null;
}

/** 给定日期落在第几教学周；不在学期内返回 null。 */
export function weekOfDate(termWeeks, iso) {
  for (const w of normalizeTermWeeks(termWeeks)) {
    if (daysBetween(w.startDate, iso) >= 0 && daysBetween(iso, w.endDate ?? addDays(w.startDate, 6)) >= 0) {
      return w.serialNumber;
    }
  }
  return null;
}

/** 事件列表 → { 'YYYY-MM-DD': [事件...] }。 */
export function groupByDate(events) {
  const map = {};
  for (const e of events ?? []) (map[e.date] ??= []).push(e);
  for (const k of Object.keys(map)) map[k].sort((a, b) => a.start.localeCompare(b.start));
  return map;
}

/** 事件列表 → { 周次: { 星期: [事件...] } }，用于周课表网格。 */
export function groupByWeekDay(events) {
  const map = new Map();
  for (const e of events ?? []) {
    if (!map.has(e.week)) map.set(e.week, new Map());
    const w = map.get(e.week);
    if (!w.has(e.dayOfWeek)) w.set(e.dayOfWeek, []);
    w.get(e.dayOfWeek).push(e);
  }
  for (const w of map.values()) {
    for (const arr of w.values()) arr.sort((a, b) => a.beginSection - b.beginSection);
  }
  return map;
}

/**
 * 下一节课 / 正在上的课。用于首页顶部那张「现在该去哪」的卡片。
 * @returns {{status:'ongoing'|'upcoming'|'none', event?:object, minutesUntil?:number}}
 */
export function nextClass(events, now = new Date()) {
  const today = todayISO(now);
  const hm = nowHM(now);
  const todayEvents = (events ?? []).filter((e) => e.date === today).sort((a, b) => a.start.localeCompare(b.start));

  const ongoing = todayEvents.find((e) => e.start <= hm && hm < e.end);
  if (ongoing) return { status: 'ongoing', event: ongoing, minutesUntil: 0 };

  const upcoming = todayEvents.find((e) => e.start > hm);
  if (upcoming) {
    const [h, m] = upcoming.start.split(':').map(Number);
    const [nh, nm] = hm.split(':').map(Number);
    return { status: 'upcoming', event: upcoming, minutesUntil: h * 60 + m - (nh * 60 + nm) };
  }

  // 今天没课了 → 找后面最近的一节
  const later = (events ?? []).filter((e) => e.date > today).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  if (later.length) return { status: 'upcoming', event: later[0], minutesUntil: null };
  return { status: 'none' };
}
