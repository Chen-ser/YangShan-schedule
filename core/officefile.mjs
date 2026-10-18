// 课表导入：零依赖读 Office 文件（.xlsx / .docx）与乱文本。
//
// 为什么要有这个文件 —— 教务处网页上「导出」按钮能下两种格式（Excel / Word），
// 里面是**同一份课表**，只是排版不同。对用户来说这是最省事的导入方式：
// 不用登录、不用装书签、不用截图，拿到的还是精确数据（截图识字错一格就是一学期）。
//
// 硬约束和 core/schedule.mjs 一样：零依赖、零网络、零 DOM、**不许出现 Node 专有 API**。
// 因此：
//   · 解压算法由调用方注入（浏览器用 DecompressionStream，Node 测试用 zlib）；
//   · XML 用手写扫描器解析，不用 DOMParser（DOMParser 在 Node 里不存在，
//     用了它这个文件的测试就跑不起来，而它恰恰是最需要真样本回归的地方）；
//   · 全程 Uint8Array / DataView / TextDecoder，不碰 Buffer。
//
// 两种格式解析后归一到**同一种中间形态 rows: (string|null)[][]**，
// 后面的 parseScheduleGrid 就完全不用关心来源是 Excel 还是 Word 了。
// ★ 这条归一化是有回报的：仓库里两份真样本（同一学期同一学生的 xlsx 与 docx）
//   必须解析出**完全相同的课表**，测试里就是这么交叉验证的。

import { addDays, expandCourses, normalizeTermWeeks, normalizeUnscheduled, parseWeekBitmap, splitWeeksTeachers, todayISO, weekdayOf } from './schedule.mjs';

// ---------------------------------------------------------------- ZIP

/**
 * 列出 ZIP 中央目录里的条目。
 * 只做「读」——不处理 Zip64（课表导出文件只有几 KB）与加密。
 */
export function listZipEntries(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  // EOCD（0x06054b50）在末尾，后面最多跟 65535 字节注释，从后往前找
  let eocd = -1;
  const lowest = Math.max(0, u8.length - 22 - 65535);
  for (let i = u8.length - 22; i >= lowest; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('这不是一个 Office 文件（找不到 ZIP 结构）。');

  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = [];
  const dec = new TextDecoder('utf-8');

  for (let i = 0; i < count; i++) {
    if (p + 46 > u8.length || dv.getUint32(p, true) !== 0x02014b50) {
      throw new Error('Office 文件的目录结构损坏了。');
    }
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const cmtLen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
    out.push({ name, method, csize, usize, lho });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

/** 取某个条目的原始（可能已压缩）字节。 */
function rawEntryBytes(u8, entry) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const p = entry.lho;
  if (dv.getUint32(p, true) !== 0x04034b50) throw new Error('Office 文件的条目损坏了。');
  const nameLen = dv.getUint16(p + 26, true);
  const extraLen = dv.getUint16(p + 28, true);
  const start = p + 30 + nameLen + extraLen;
  return u8.subarray(start, start + entry.csize);
}

/**
 * 解出指定条目（解压函数由调用方注入）。
 * @param {Uint8Array} bytes
 * @param {string[]} wanted 需要的条目名（精确匹配）
 * @param {(raw: Uint8Array) => Promise<Uint8Array>} inflateRaw
 * @returns {Promise<Map<string, string>>} 条目名 → UTF-8 文本
 */
export async function readZipTextEntries(bytes, wanted, inflateRaw) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const want = new Set(wanted);
  const map = new Map();
  const dec = new TextDecoder('utf-8');
  for (const e of listZipEntries(u8)) {
    if (!want.has(e.name)) continue;
    const raw = rawEntryBytes(u8, e);
    let data;
    if (e.method === 0) data = raw;
    else if (e.method === 8) data = await inflateRaw(raw);
    else throw new Error(`Office 文件用了不支持的压缩方式（${e.method}）。`);
    map.set(e.name, dec.decode(data));
  }
  return map;
}

/**
 * 浏览器里的 raw-deflate 解压。
 * `DecompressionStream('deflate-raw')` 要 Chrome 103+ / Safari 16.4+ / Firefox 113+。
 * 低于这个版本只能给一句人话，而不是抛一个看不懂的错。
 */
export async function browserInflateRaw(raw) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error(
      '这个浏览器版本太旧，没法解压 Office 文件。请更新浏览器；或者改用「抓取工具」导入。',
    );
  }
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---------------------------------------------------------------- XML 小工具

const NAMED = { lt: '<', gt: '>', quot: '"', apos: "'" };

/**
 * XML 实体解码。
 * ★ `&amp;` 必须**最后**解 —— 先解它的话 `&amp;lt;` 会一路变成 `<`，
 *   把本来应该是字面量的文本吃成标签。
 */
export function decodeXmlEntities(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(Number(d)))
    .replace(/&(lt|gt|quot|apos);/g, (_, n) => NAMED[n])
    .replace(/&amp;/g, '&');
}

function safeCodePoint(n) {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

/** 取标签属性值（要求属性名前有空白，避免把 `r="A1"` 匹配到别的属性里）。 */
function attr(attrs, name) {
  const m = String(attrs ?? '').match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`));
  return m ? m[1] : '';
}

/**
 * 扫出同名标签的内容。不处理同名嵌套（OOXML 里 w:tr / w:tc / w:p 都不自嵌套），
 * 自闭合标签（`<w:p/>`）会被正确识别为空。
 */
function elements(xml, tag) {
  const out = [];
  const open = new RegExp(`<${tag}(\\s[^>]*?)?(/?)>`, 'g');
  let m;
  while ((m = open.exec(xml)) !== null) {
    const attrs = m[1] || '';
    if (m[2] === '/') {
      out.push({ attrs, inner: '' });
      continue;
    }
    const close = `</${tag}>`;
    const end = xml.indexOf(close, open.lastIndex);
    if (end < 0) break;
    out.push({ attrs, inner: xml.slice(open.lastIndex, end) });
    open.lastIndex = end + close.length;
  }
  return out;
}

/** 某段 XML 里所有 `<tag>` 的文本拼接（`<w:t>` 在一段里可能出现多次）。 */
function textOf(xml, tag) {
  let s = '';
  for (const e of elements(xml, tag)) s += concatRuns(e.inner, tag);
  return s;
}

function concatRuns(inner, tag) {
  // inner 已经是标签内容；再往里可能还有同名标签（xlsx 的 <is><t>…），
  // 这里用一次浅扫描即可 —— 真实文件里不会有更深一层。
  return decodeXmlEntities(inner);
}

// ---------------------------------------------------------------- 列号

/** `A`→0、`Z`→25、`AA`→26 */
export function colIndex(ref) {
  const m = String(ref ?? '').match(/^([A-Z]+)/);
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function putRow(rows, rowIdx, col, value) {
  while (rows.length <= rowIdx) rows.push([]);
  const row = rows[rowIdx];
  while (row.length <= col) row.push(null);
  if (value !== '' && value != null) row[col] = value;
}

// ---------------------------------------------------------------- .xlsx

function parseXlsxSheet(xml, shared) {
  const rows = [];
  const sd = elements(xml, 'sheetData')[0];
  if (!sd) return rows;
  for (const rowEl of elements(sd.inner, 'row')) {
    const rowIdx = Number(attr(rowEl.attrs, 'r')) - 1;
    if (!(rowIdx >= 0)) continue;
    for (const cellEl of elements(rowEl.inner, 'c')) {
      const col = colIndex(attr(cellEl.attrs, 'r'));
      if (col < 0) continue;
      const t = attr(cellEl.attrs, 't');
      let value = '';
      if (t === 'inlineStr') {
        // `<is>` 里可能有多段 `<t>`（富文本）
        value = textOf(cellEl.inner, 't');
      } else {
        const v = textOf(cellEl.inner, 'v');
        if (t === 's') value = shared[Number(v)] ?? '';
        else value = v;
      }
      putRow(rows, rowIdx, col, value);
    }
  }
  return rows;
}

async function readXlsx(bytes, inflateRaw) {
  const names = listZipEntries(bytes).map((e) => e.name);
  const sheetName = names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[0];
  if (!sheetName) throw new Error('这个 Excel 文件里没有工作表。');

  const wanted = [sheetName];
  const hasShared = names.includes('xl/sharedStrings.xml');
  if (hasShared) wanted.push('xl/sharedStrings.xml');
  const files = await readZipTextEntries(bytes, wanted, inflateRaw);

  const shared = [];
  if (hasShared) {
    const sx = files.get('xl/sharedStrings.xml') ?? '';
    for (const si of elements(sx, 'si')) shared.push(textOf(si.inner, 't'));
  }

  return { kind: 'xlsx', rows: parseXlsxSheet(files.get(sheetName) ?? '', shared) };
}

// ---------------------------------------------------------------- .docx

/** 把一个 `<w:p>` 的内容拼成字符串（`<w:t>` / `<w:tab/>` / `<w:br/>` 按出现顺序）。 */
function paragraphText(inner) {
  let s = '';
  const re = /<w:(t|tab|br)(\s[^>]*?)?(\/?)>/g;
  let m;
  while ((m = re.exec(inner)) !== null) {
    if (m[1] === 'tab') {
      s += '\t';
      continue;
    }
    if (m[1] === 'br') {
      s += '\n';
      continue;
    }
    if (m[3] === '/') continue;
    const end = inner.indexOf('</w:t>', re.lastIndex);
    if (end < 0) break;
    s += decodeXmlEntities(inner.slice(re.lastIndex, end));
    re.lastIndex = end + 6;
  }
  return s;
}

/** 把一张 `<w:tbl>` 里的行渲染成字符串矩阵。 */
function docxTableRows(tblInner) {
  const rows = [];
  for (const tr of elements(tblInner, 'w:tr')) {
    const row = [];
    for (const tc of elements(tr.inner, 'w:tc')) {
      // ★ 一格里的多门课靠**段落**分隔，段落之间必须以 \n 连接。
      //   真实文件里同一格里就躺着 2~3 门课，丢了段落边界后面全都粘成一行。
      const paras = [];
      for (const p of elements(tc.inner, 'w:p')) paras.push(paragraphText(p.inner));
      row.push(paras.join('\n').replace(/\n+$/, ''));
    }
    rows.push(row);
  }
  return rows;
}

/**
 * 扫 `w:body`，按**文档顺序**收集表格之外的抬头段落与所有表格。
 * ★ 不能只取 `elements(xml,'w:tbl')[0]`：教务导出的 .docx 有**两张表** ——
 *   第一张是课表网格，第二张是未排具体节次的课程清单。只读第一张会让
 *   未排课 5 门全丢，而且抬头（学期名 / 校区年级院系 / 学号）本来就在表格之外的
 *   段落里，一起丢了之后连「这是哪个学期」都不知道。
 */
function parseDocxBody(xml) {
  const bodyEl = elements(xml, 'w:body')[0];
  const body = bodyEl ? bodyEl.inner : xml;
  const rows = [];
  const head = [];
  const re = /<w:(p|tbl)(\s[^>]*?)?(\/?)>/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    if (m[3] === '/') continue;
    if (m[1] === 'p') {
      // 注意：<w:pPr>/<w:tblPr> 之类不会被这条正则命中 —— w:p 后面要么是空白要么是 '>'
      const end = body.indexOf('</w:p>', re.lastIndex);
      if (end < 0) break;
      head.push(paragraphText(body.slice(re.lastIndex, end)));
      re.lastIndex = end + 6;
    } else {
      const end = body.indexOf('</w:tbl>', re.lastIndex);
      if (end < 0) break;
      for (const r of docxTableRows(body.slice(re.lastIndex, end))) rows.push(r);
      re.lastIndex = end + 8;
    }
  }
  const headText = head.map(clean).filter(Boolean).join('    ');
  if (headText) rows.unshift([headText]);
  return rows;
}

async function readDocx(bytes, inflateRaw) {
  const files = await readZipTextEntries(bytes, ['word/document.xml'], inflateRaw);
  const xml = files.get('word/document.xml');
  if (!xml) throw new Error('这个 Word 文件里没有正文。');
  return { kind: 'docx', rows: parseDocxBody(xml) };
}

/**
 * 读一份课表文件（自动判 xlsx / docx），返回归一化后的网格。
 * @param {Uint8Array} bytes
 * @param {(raw: Uint8Array) => Promise<Uint8Array>} inflateRaw
 */
export async function readOfficeRows(bytes, inflateRaw) {
  const names = listZipEntries(bytes).map((e) => e.name);
  if (names.some((n) => n.startsWith('xl/'))) return readXlsx(bytes, inflateRaw);
  if (names.some((n) => n.startsWith('word/'))) return readDocx(bytes, inflateRaw);
  throw new Error('认不出这个文件。请上传教务系统导出的 Excel（.xlsx）或 Word（.docx）。');
}

// ---------------------------------------------------------------- 课表网格

const DAY_NAMES = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };

const clean = (s) => String(s ?? '').replace(/[\u00a0\u3000]/g, ' ').trim();

/** 同一门课：`名称[代码]` 开头，后面跟 **一条或多条** 时间段描述。 */
function splitCellBlocks(text) {
  const lines = String(text ?? '')
    .split('\n')
    .map(clean)
    .filter(Boolean);
  const blocks = [];
  let cur = null;
  for (const line of lines) {
    // ★ 方括号里必须是「含字母或数字的课程代码」。不能用 `/^(.+?)\[(.+?)\]$/`：
    //   '1-7周[讲授]/陈曦[主讲]' 这种也会命中，于是周次串被当成课程名。
    //   判据是「方括号里含 ASCII 字母或数字」—— '讲授'/'主讲'/'实验' 全是汉字，被挡在外面；
    //   手输的 'MATH131'、OCR 出来的 'B001'、编出来的 'ZZ1A2B' 都能认。
    const m = line.match(/^(.+?)\s*\[([^\[\]]+)\]\s*(.*)$/);
    if (m && /[A-Za-z0-9]/.test(m[2]) && !/周$/.test(m[1].trim())) {
      cur = { courseName: m[1].trim(), courseCode: m[2].trim(), details: [] };
      blocks.push(cur);
      if (m[3].trim()) cur.details.push(m[3].trim());
    } else if (cur) {
      // ★ 一个课程名底下可能挂着**多条**时间段，而且教务的导出并不总是重复写课程名：
      //   '基础英语A[ENGL101a]' 后面直接跟了 '4-17周…ZXC205' 和 '3周…ZXB-502' 两行。
      //   早先只留一条 detail，第二条会被并进地点里，界面显示成
      //   「基础英语A  ZXC205 3周 方元 第1节-第2节 ZXB-502」这种鬼东西。
      cur.details.push(line);
    }
  }
  if (blocks.length === 0 && lines.length > 0) {
    blocks.push({ courseName: lines[0], courseCode: '', details: lines.slice(1) });
  }
  return blocks;
}

/**
 * 拆一格里的「周次 教师 第X节-第Y节 地点」。
 * ★ 位置是**有语义的**，不用猜「哪个词像人名、哪个词像教室」：
 *   地点总在 `第X节-第Y节` **后面**，教师总在它**前面**。
 *   早先想着靠词形猜，遇到「汇贤堂」（纯中文地名）和「李珍」（纯中文人名）根本分不开。
 */
function parseCellDetail(detail, rowSection) {
  let beginSection = rowSection;
  let endSection = rowSection;
  let head = clean(detail);
  let placeName = '';

  const sec = head.match(/第\s*(\d+)\s*节\s*[-–—~～至]\s*第?\s*(\d+)\s*节/);
  if (sec) {
    beginSection = Number(sec[1]);
    endSection = Number(sec[2]);
    placeName = head.slice(sec.index + sec[0].length).trim();
    head = head.slice(0, sec.index).trim();
  }

  const tm = head.match(/^(\S+)[\s]+(.*)$/);
  const weeksText = tm ? tm[1] : head;
  const teacher = tm ? tm[2].trim() : '';
  return { weeksText, teacher, beginSection, endSection, placeName };
}

/** 周次数组 → 强智那种位图串（第 i 位是第 i+1 周）。 */
export function weeksToBitmap(weeks) {
  if (!Array.isArray(weeks) || weeks.length === 0) return '';
  const max = Math.max(...weeks.filter((w) => Number.isFinite(w) && w > 0));
  if (!Number.isFinite(max) || max <= 0) return '';
  let s = '';
  const set = new Set(weeks);
  for (let i = 1; i <= max; i++) s += set.has(i) ? '1' : '0';
  return s;
}

/**
 * 周次数组 → `1-3,5,8-10周` 这种紧凑写法。
 *
 * 存在的理由：`gridFromCourses` 要把课表写回网格，而 `parseCellDetail` 是按空格切
 * 「周次 教师 第X节-第Y节 地点」的 —— 周次里**不能有空格**。
 * 抓取来的 `weeksAndTeachers` 恰恰带空格和方括号（`1-7周[讲授]; 1-7周[讲授]`），
 * 直接写回去会把教师名切错。所以一律从 `weeks` 数组重新生成。
 */
export function weeksToRanges(weeks) {
  const set = [...new Set((weeks || [])
    .map(Number)
    .filter((w) => Number.isFinite(w) && w > 0))]
    .sort((a, b) => a - b);
  if (!set.length) return '';
  const parts = [];
  let start = set[0];
  let prev = set[0];
  for (let i = 1; i < set.length; i += 1) {
    if (set[i] === prev + 1) { prev = set[i]; continue; }
    parts.push(start === prev ? String(start) : `${start}-${prev}`);
    start = set[i];
    prev = set[i];
  }
  parts.push(start === prev ? String(start) : `${start}-${prev}`);
  return `${parts.join(',')}周`;
}

/** 没有课程代码时编一个稳定的（UID 不含代码，所以编也不会造成重复事件）。 */
export function syntheticCode(name) {
  let x = 2166136261;
  const s = String(name ?? '');
  for (let i = 0; i < s.length; i += 1) {
    x ^= s.charCodeAt(i);
    x = Math.imul(x, 16777619);
  }
  return `ZZ${(x >>> 0).toString(36).toUpperCase().slice(0, 4)}`;
}

/**
 * 课表课程 → 手动填课表那种网格。**这是 `parseScheduleGrid` 的逆运算。**
 *
 * 为什么必须能逆：用户导入完还要改（"导入完成后改为支持用户手动修改"）。
 * 编辑走的是同一条路 —— 课表 → 网格 → 用户改 → 解析回课表。
 * 只要这个往返是恒等的，「编辑一次」就不会把没碰过的课改掉（UID 不变，日历里原地更新）。
 *
 * 输出 rows 与教务导出的 .xlsx 同形：表头行 + `第N节` 数据行，一格里的多条时间段用换行分隔。
 * 每格严格写成 `课程名[课程代码]` + 若干条 `周次 教师 第X节-第Y节 地点`。
 */
export function gridFromCourses(courses, opts = {}) {
  const list = (courses || []).filter((c) => c && c.courseName);
  const minRows = Number(opts.minSections) || 14;
  const maxSection = Math.max(minRows, ...list.map((c) => Number(c.endSection) || 0));

  // 块 = 同一天、同一开始节次、**同一门课**。同一门课的多段周次并成一个块（多行 detail）；
  // 不同课占同一格（上半学期 A 课、下半学期 B 课）必须分成**两个块**，
  // 否则会被写成「A课 / B课的时间段」—— 课名张冠李戴。
  // 一格可以有多个块，所以格子里会出现多个 `名称[代码]` 行。
  const blocks = new Map();
  const cellOrder = new Map(); // `${day}:${begin}` -> [key, …]
  for (const c of list) {
    const day = Number(c.dayOfWeek) || 0;
    const begin = Number(c.beginSection) || 0;
    if (day < 1 || day > 7 || begin < 1) continue;
    const end = Number(c.endSection) || begin;
    // ★ 周次可能挂在三个不同的字段上：解析网格得来的用 `weeks`（数组），
    //   `gridToArrangedList` 出来的是 `week`（位图串），接口抓来的是 `weekBitmap`。
    //   只认其中一个，另一种来源的课就会算出「没有周次」→ 整门课在往返里消失。
    const bitmap = c.weekBitmap || c.week || '';
    const weeks = (Array.isArray(c.weeks) && c.weeks.length)
      ? c.weeks
      : (bitmap ? parseWeekBitmap(bitmap) : []);
    const wk = weeksToRanges(weeks)
      || String(c.weeksText ?? '').replace(/\s+/g, '');
    // 教师也可能只有 `weeksAndTeachers` 里有（抓取来的 arrangedList 就是这样，
    // 它不单列 teacher）。不补这一步，编辑一次就会把所有老师名字抹掉。
    const teacher = c.teacher
      || (c.weeksAndTeachers ? splitWeeksTeachers(String(c.weeksAndTeachers)).teacher : '')
      || '';
    const detail = [wk, teacher, `第${begin}节-第${end}节`, c.placeName || '']
      .filter((x) => x !== '')
      .join(' ');
    const code = c.courseCode || syntheticCode(c.courseName);
    const key = `${day}:${begin}:${code}`;
    if (!blocks.has(key)) {
      blocks.set(key, { day, begin, courseName: c.courseName, courseCode: code, details: [] });
      const slot = `${day}:${begin}`;
      if (!cellOrder.has(slot)) cellOrder.set(slot, []);
      cellOrder.get(slot).push(key);
    }
    const b = blocks.get(key);
    if (!b.details.includes(detail)) b.details.push(detail);
  }

  const days = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];
  const rows = [['节次/星期', ...days]];
  let blocksSeen = 0;
  for (let s = 1; s <= maxSection; s += 1) {
    const line = [];
    for (let d = 1; d <= 7; d += 1) {
      const keys = cellOrder.get(`${d}:${s}`);
      if (!keys || !keys.length) { line.push(''); continue; }
      blocksSeen += keys.length;
      line.push(keys
        .map((k) => {
          const b = blocks.get(k);
          return `${b.courseName}[${b.courseCode}]\n${b.details.join('\n')}`;
        })
        .join('\n'));
    }
    rows.push([`第${s}节`, ...line]);
  }
  return { rows, sections: maxSection, blocks: blocksSeen, skipped: list.length - blocksSeen };
}

/** 把下载文件里的周次串整理成 core/schedule.mjs 认得的形态。 */
function normalizeWeeksAndTeachers(weeksText, teacher) {
  // 先压掉换行（Word 的未排课表里，同一门课的多个教师分行写）
  let wk = clean(weeksText).replace(/\s*\n\s*/g, ' ');
  // 多教师：文件里两段之间用「,」分隔（'1-7周[讲授]/陈曦[主讲] ,1-7周[讲授]/古一[主讲]'），
  // 而 splitWeeksTeachers 认的是「;」分段，先归一。
  // 只在逗号后面紧跟「周次」时才当分隔符，否则会把「陈蕾,郭芳芳,蔡蓉,倪海」也切碎。
  wk = wk.replace(/([,，])\s*(?=\d+(?:-\d+)?周)/g, '; ');
  const t = clean(teacher);
  if (!t) return wk.includes('/') ? wk : `${wk}[讲授]`;
  return `${wk}[讲授]/${t}`;
}

/**
 * 归一化后的网格 → 课表。
 *
 * 网格长这样（Excel 与 Word 解析出来完全一致）：
 *   第1行  '2026-2027学年 第一学期 张三[2026000000] 课表'
 *   第2行  '校区: … 年级: … 专业: … 班级: … 学生: 张三[2026000000]'
 *   表头行 '节次/星期 | 星期一 | … | 星期日'
 *   数据行 '第1节 | 课A[XX101]\n3-14周 某老师 第1节-第3节 A-101 | … '
 *   末尾   '教学班名称 | 上课校区 | 上课周次 | 上课对象 | 备注' + 若干未排课
 */
export function parseScheduleGrid(rows) {
  const out = {
    source: 'grid',
    termName: '',
    studentName: '',
    studentCode: '',
    campus: '',
    major: '',
    className: '',
    printedAt: '',
    courses: [],
    unscheduled: [],
  };
  if (!Array.isArray(rows) || rows.length === 0) return out;

  // ---- 抬头信息
  for (const row of rows) {
    const line = clean((row || []).join(' '));
    if (!line) continue;
    const term = line.match(/(\d{4}-\d{4}学年\s*第[一二三四]学期)/);
    if (term && !out.termName) out.termName = term[1].replace(/\s+/g, ' ');
    const stu = line.match(/学生[:：]\s*([^\s\[]+)\[(\d{4,})\]/);
    if (stu) {
      out.studentName = out.studentName || stu[1];
      out.studentCode = out.studentCode || stu[2];
    }
    const any = line.match(/([^\s\[]+)\[(\d{6,})\]/);
    if (any && !out.studentCode) {
      out.studentName = any[1];
      out.studentCode = any[2];
    }
    const cm = line.match(/校区[:：]\s*([^\s]+)/);
    if (cm && !out.campus) out.campus = cm[1];
    const mm = line.match(/专业[:：]\s*([^\s]+)/);
    if (mm && !out.major) out.major = mm[1];
    const cl = line.match(/班级[:：]\s*([^\s]+)/);
    if (cl && !out.className) out.className = cl[1];
    const pt = line.match(/打印时间[:：]\s*([\d-]+)/);
    if (pt && !out.printedAt) out.printedAt = pt[1];
  }

  // ---- 找表头行
  let headerRow = -1;
  let dayCols = null;
  for (let i = 0; i < rows.length; i++) {
    const cols = {};
    let hits = 0;
    for (let c = 0; c < (rows[i] || []).length; c++) {
      const m = clean(rows[i][c]).match(/^星期([一二三四五六日天])$/);
      if (m) {
        cols[c] = DAY_NAMES[m[1]];
        hits++;
      }
    }
    if (hits >= 5) {
      headerRow = i;
      dayCols = cols;
      break;
    }
  }
  if (headerRow < 0 || !dayCols) return out;

  // ---- 逐行
  let mode = 'courses';
  let unschedCols = null;
  for (let i = headerRow + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const first = clean(row[0]);

    if (/教学班名称/.test(first)) {
      mode = 'unscheduled';
      unschedCols = {};
      for (let c = 0; c < row.length; c++) {
        const h = clean(row[c]);
        if (!h) continue;
        if (/教学班名称|课程名称/.test(h)) unschedCols.name = c;
        else if (/上课周次|周次/.test(h)) unschedCols.weeks = c;
        else if (/上课校区/.test(h)) unschedCols.campus = c;
        else if (/上课对象/.test(h)) unschedCols.target = c;
      }
      continue;
    }

    if (mode === 'unscheduled') {
      if (!first) continue;
      const nameCell = clean(row[unschedCols?.name ?? 0]);
      if (!nameCell) continue;
      const nm = nameCell.match(/^(.*?)\s*\[([A-Za-z][A-Za-z0-9._-]*)\]\s*(?:-(\d+))?$/);
      // ★ 名称格必须长成「名称[课程代码]」才算数。Excel 版课表在未排课清单后面
      //   还跟着一行页脚『打印人：… 打印时间：2026-10-09 20:00』，只判非空的话
      //   这行页脚会被当成一门课混进未排课列表里。
      if (!nm) continue;
      const weeksRaw = clean(row[unschedCols?.weeks ?? 2]);
      const courseName = nm[1].trim();
      const courseCode = nm[2];
      const weeks = parseWeeksLoose(weeksRaw);
      out.unscheduled.push({
        courseName,
        courseCode,
        classNo: nm?.[3] ?? '',
        campus: clean(row[unschedCols?.campus ?? 1]),
        teachingTarget: clean(row[unschedCols?.target ?? 3]),
        weeksAndTeachers: normalizeWeeksAndTeachers(weeksRaw, ''),
        weeks,
        weekBitmap: weeksToBitmap(weeks),
      });
      continue;
    }

    const sec = first.match(/^第\s*(\d+)\s*节$/);
    if (!sec) continue;
    const rowSection = Number(sec[1]);
    for (const [colStr, day] of Object.entries(dayCols)) {
      const text = row[Number(colStr)];
      if (!text) continue;
      for (const b of splitCellBlocks(text)) {
        // ★ 一个课程名可以挂多条时间段，逐条各出一个课程项（同一门课的不同周次段）。
        for (const detail of b.details.length ? b.details : ['']) {
          const d = parseCellDetail(detail, rowSection);
          const weeks = parseWeeksLoose(d.weeksText);
          if (weeks.length === 0) continue;
          out.courses.push({
            courseName: b.courseName,
            courseCode: b.courseCode,
            dayOfWeek: day,
            beginSection: d.beginSection,
            endSection: d.endSection,
            weeks,
            weekBitmap: weeksToBitmap(weeks),
            weeksText: d.weeksText,
            teacher: d.teacher,
            placeName: d.placeName,
            weeksAndTeachers: normalizeWeeksAndTeachers(d.weeksText, d.teacher),
          });
        }
      }
    }
  }
  return out;
}

/** 周次串 → 周次数组。 */
export function parseWeeksLoose(text) {
  const raw = String(text ?? '');
  // ★ 单双周要**绑在它自己那一段上**，不能整串一刀切。
  //   '3周,6-8周(双)' 的含义是「第 3 周 + 第 6~8 周里的双周」= {3,6,8}；
  //   早先的实现先剥掉 (双) 再整串过 even 过滤，会把明确列出的第 3 周也误删。
  const marked = raw.replace(/[（(]\s*(单|双)\s*[）)]/g, '@$1');
  const s = marked
    .split('/')[0]
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[第周\s]/g, '')
    .replace(/[、，;；]/g, ',');

  const set = new Set();
  for (const segRaw of s.split(',')) {
    let seg = segRaw.trim();
    if (!seg) continue;
    let parity = null;
    if (seg.endsWith('@单')) {
      parity = 'odd';
      seg = seg.slice(0, -2);
    } else if (seg.endsWith('@双')) {
      parity = 'even';
      seg = seg.slice(0, -2);
    }
    let weeks = [];
    const r = seg.match(/^(\d+)\s*[-–—~～]\s*(\d+)$/);
    if (r) {
      const a = Number(r[1]);
      const b = Number(r[2]);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) weeks.push(i);
    } else {
      const o = seg.match(/^(\d+)$/);
      if (o) weeks.push(Number(o[1]));
    }
    if (parity === 'odd') weeks = weeks.filter((w) => w % 2 === 1);
    if (parity === 'even') weeks = weeks.filter((w) => w % 2 === 0);
    for (const w of weeks) set.add(w);
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * 网格课表 → 与强智接口 `datas.arrangedList` **同形**的数组。
 *
 * ★ 刻意做成同形，是为了白拿 core/schedule.mjs 里已有的整条下游：
 *   expandCourses 的周次展开、地点兜底、以及最要紧的 **UID 稳定性**
 *   （UID 不含教师和教室，重新导入时日历里是原地更新而不是加一份新的）。
 *   否则文件导入出来的日历和抓取导入出来的日历会各存一份，重复一学期。
 */
export function gridToArrangedList(courses) {
  return (courses || []).map((c) => ({
    courseName: c.courseName,
    courseCode: c.courseCode,
    dayOfWeek: c.dayOfWeek,
    beginSection: c.beginSection,
    endSection: c.endSection,
    week: c.weekBitmap,
    weeksAndTeachers: c.weeksAndTeachers,
    placeName: c.placeName,
    beginTime: '',
    endTime: '',
    teachingTarget: '',
  }));
}

/** 网格未排课课 → 与强智 `notArrangeList` 同形（字段名对齐 normalizeUnscheduled）。 */
export function gridToUnscheduledList(unscheduled) {
  return (unscheduled || []).map((c) => ({
    courseName: c.courseName,
    courseCode: c.courseCode,
    credit: '',
    week: c.weekBitmap,
    weeksAndTeachers: c.weeksAndTeachers,
    teachingTarget: c.teachingTarget,
    placeName: '',
    beginTime: '',
    endTime: '',
  }));
}

// ---------------------------------------------------------------- 学期周历补全
//
// ★ 这是文件导入与抓取导入的**根本差别**，也是整条文件路径唯一的用户负担：
//   教务系统导出的 Excel / Word（以及一张截图）里**只有周次，没有学期起始日**。
//   这不是解析漏了 —— 文件本身就没印。没有起始日就算不出每节课的公历日期，
//   也就做不了提醒、导不出 .ics。
//   所以必须让用户补一次「今天在第几周」，其余全部由这里反推。

/**
 * 「今天是第 anchorWeek 周」→ 第 1 周的星期一（ISO 'YYYY-MM-DD'）。
 * 以用户设备本地时间的「今天」为准，所以不需要网络也不需要时区表。
 */
export function termStartFromWeek(anchorWeek, today = todayISO()) {
  const n = Math.max(1, Math.min(30, Number(anchorWeek) || 1));
  const thisMonday = addDays(today, -(weekdayOf(today) - 1));
  return addDays(thisMonday, -(n - 1) * 7);
}

/** 从第 1 周的星期一开始生成 count 周周历（与接口 getTermWeeks 同形）。 */
export function makeTermWeeks(startISO, count) {
  const n = Math.max(1, Math.min(30, Number(count) || 20));
  const out = [];
  for (let i = 0; i < n; i++) {
    const s = addDays(startISO, i * 7);
    out.push({ serialNumber: i + 1, name: `第${i + 1}周`, startDate: s, endDate: addDays(s, 6) });
  }
  return normalizeTermWeeks(out);
}

/** '2026-2027学年 第一学期' → '2026-2027-1'（parseTermCode 只认连字符写法）。 */
export function termCodeFromName(termName) {
  const m = String(termName ?? '').match(/(\d{4})\s*-\s*(\d{4})\s*学年\s*第([一二三四五六])学期/);
  if (!m) return '';
  return `${m[1]}-${m[2]}-${'一二三四五六'.indexOf(m[3]) + 1}`;
}

/** 课表里实际用到的最大周次（排了课的 + 没排课的），用来决定周历该生成多少周。 */
export function maxWeekUsed(courses, unscheduled) {
  let max = 0;
  const scan = (arr) => {
    for (const c of arr || []) {
      for (const w of c.weeks || []) if (w > max) max = w;
    }
  };
  scan(courses);
  scan(unscheduled);
  return max;
}

/**
 * 网格课表（Office 文件或粘贴文本解析出来的）→ 可持久化的课表数据包。
 *
 * 产物与 `buildSchedule()` 出来的**同形**，所以渲染、ics、提醒、备份全部白拿。
 * `expandCourses` 的 UID 只由「学期+课程名+星期+节次+日期」决定，
 * 因此同一门课从文件导入和从教务系统抓取，在日历里是**同一条事件**（原地更新），
 * 不会出现「导入两次、一学期两份」。
 *
 * opts: { anchorWeek, today, termStartDate, termWeeks, termCode }
 */
export function packFromGrid(grid, opts = {}) {
  const courses = grid?.courses ?? [];
  const unsched = grid?.unscheduled ?? [];
  const arrangedList = gridToArrangedList(courses);

  let termWeeks = Array.isArray(opts.termWeeks) ? normalizeTermWeeks(opts.termWeeks) : [];
  if (!termWeeks.length) {
    const anchorWeek = Number(opts.anchorWeek) || 1;
    const explicitStartRaw = typeof opts.termStartDate === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(opts.termStartDate)
      ? opts.termStartDate
      : '';
    const explicitStart = explicitStartRaw
      ? addDays(explicitStartRaw, -(weekdayOf(explicitStartRaw) - 1))
      : '';
    const start = explicitStart || termStartFromWeek(anchorWeek, opts.today ?? todayISO());
    // 至少 20 周（多数专业的教学周数），课表里有更靠后的周次就照它加长
    termWeeks = makeTermWeeks(start, Math.max(20, maxWeekUsed(courses, unsched)));
  }

  const termCode = opts.termCode || termCodeFromName(grid?.termName) || '';
  const events = expandCourses(arrangedList, termWeeks, { termCode });

  return {
    schema: 1,
    kind: 'schedule',
    source: 'office',
    termCode,
    studentCode: grid?.studentCode ?? '',
    studentName: grid?.studentName ?? '',
    fetchedAt: new Date().toISOString(),
    termWeeks,
    arrangedList,
    events,
    unscheduled: normalizeUnscheduled(gridToUnscheduledList(unsched)),
  };
}

// ---------------------------------------------------------------- 粘贴文本 → 网格

/**
 * 粘贴进来的制表符文本 → rows。
 *
 * 存在的理由：用户在电脑上把教务系统导出的 Word/Excel 打开、全选复制，
 * 粘出来的就是制表符分隔的网格（Excel 每个单元格一个 \t，Word 每个单元格也是）。
 * 这条路径让「手上有文件但不想上传」的用户也能一步导入，
 * 顺带给「截图 → 系统识字」留了同一个入口（识字结果若保留单元格分隔也能吃）。
 */
export function textToGridRows(text) {
  const rows = [];
  for (const line of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    if (!line.trim()) continue;
    rows.push(line.split('\t').map((s) => s.replace(/^\uFEFF/, '').trim()));
  }
  return rows;
}

/** 判断一段文本像不像「制表符分隔的课表网格」（够得着表头就算）。 */
export function looksLikeGridText(text) {
  const s = String(text ?? '');
  if (!s.includes('\t')) return false;
  return (s.match(/星期[一二三四五六日天]/g) || []).length >= 4;
}

/** 粘贴文本 → 网格课表。不像网格就抛可读错误，交给别的导入方式。 */
export function parseGridText(text) {
  if (!looksLikeGridText(text)) {
    throw new Error('这段文字里没有找到课表表格（需要从 Excel/Word 里整块复制，列之间是制表符）。');
  }
  const grid = parseScheduleGrid(textToGridRows(text));
  if (!grid.courses.length) {
    throw new Error('认出了表头，但一格课都没解析出来。确认复制的是「学生课表」那整张表。');
  }
  return grid;
}
