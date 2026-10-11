// 仰山课表 · 课表截图 → 网格
//
// 输入是 tesseract 的 TSV（词框 + 文字），输出是 `parseScheduleGrid` 认得的那种 rows。
// 于是「截图导入」「上传课表文件」「手动填格子」走的是同一条解析路、落地是同一批 UID ——
// 同一门课换个方式再导一次，不会在系统日历里变成两条。
//
// ★ 定位靠**文字**，不靠像素。
//   课表页面长得五花八门（<table> + rowspan / 绝对定位的 div / 手机端竖排列表），
//   但「星期几写在哪一列」「第几节写在哪一行」这两样字到哪都在。
//   纯像素方案要先猜配色、再猜行高，换个学校就废。
//
// ★ 一个格子的文字会被 tesseract 切成很多碎词。中文没有空格，它基本按字切，
//   所以「中国近现代史纲要」会变成 中国近 / 现代史 / 纲要 三行。
//   只能按几何把碎词拼回格子、再按位置把碎片归成 名称 / 地点 / 节次 / 周次 四类。
//
// ★ 为什么不做像素级精修：OCR 本身只有 ~85% 准确率（实测），
//   再怎么算几何也救不回认错的字。所以这里的产出是**草稿**，
//   一律预填进可编辑的网格让用户过一眼 —— 这正是「全自动 + 导入后手动改」的分工。

import { syntheticCode } from './officefile.mjs';

const DAY_CHARS = '一二三四五六日天';
const OCR_DAY_NAMES = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];

// 中文与 ASCII 混排时要按「换了文字系统」补空格，否则
//   ZXB-306 + 1-16周 会粘成 ZXB-3061-16周
//   中国近 + 现代史 + 纲要 会变成 中国近 现代史 纲要
const isCJK = (ch) => /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(ch);
const scriptOf = (ch) => (isCJK(ch) ? 'cjk' : (/[A-Za-z0-9]/.test(ch) ? 'ascii' : 'other'));

/** 补空格地拼一串文字。同文字系统直接粘，跨系统补一个空格。 */
function joinSmart(parts) {
  let out = '';
  for (const p of parts) {
    const t = String(p ?? '').trim();
    if (!t) continue;
    if (!out) { out = t; continue; }
    const a = scriptOf(out[out.length - 1]);
    const b = scriptOf(t[0]);
    out += (a === b && a !== 'other') ? t : ` ${t}`;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** 洗掉 OCR 读表格竖线/引号读出来的噪声字符。括号要留着 —— 「大学体育(1)」靠它。 */
function normalizeWord(raw) {
  return String(raw ?? '')
    .replace(/[‖│┃¦§|]/g, ' ')
    .replace(/[“”"]/g, '')
    .replace(/[《〈]/g, '(')
    .replace(/[》〉]/g, ')')
    .replace(/[\u00a0\u3000]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.。,，:：;；]+|[.。,，:：;；]+$/g, '')
    .trim();
}

function boxOf(items) {
  const left = Math.min(...items.map((w) => w.left));
  const top = Math.min(...items.map((w) => w.top));
  const right = Math.max(...items.map((w) => w.left + w.width));
  const bottom = Math.max(...items.map((w) => w.top + w.height));
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

/**
 * 解析 tesseract 的 TSV。
 *
 * ★ 只认 level 5（词）。level 4（行）的 text 字段**是空的**（实测），
 *   而且 tesseract 会把同一横排上、分属两列的文字并成一行
 *   （`中国近‖高等数` 横跨星期一和星期二），所以行分组只能当"同一横带"用，
 *   分列必须回到词框上做。
 */
export function parseOcrTsv(tsv, opts = {}) {
  const minConf = Number(opts.minConf ?? 30);
  const words = [];
  let page = { width: 0, height: 0 };
  for (const raw of String(tsv ?? '').split(/\r?\n/)) {
    const f = raw.split('\t');
    if (f.length < 12) continue;
    const level = Number(f[0]);
    if (level === 1) {
      // level 1 是整页框，宽高就是图片尺寸
      page = { width: Number(f[8]) || 0, height: Number(f[9]) || 0 };
      continue;
    }
    if (level !== 5) continue;
    const conf = Number(f[10]);
    if (Number.isFinite(conf) && conf >= 0 && conf < minConf) continue;
    const text = normalizeWord(f[11]);
    if (!text) continue;
    words.push({
      text,
      block: Number(f[2]) || 0,
      par: Number(f[3]) || 0,
      line: Number(f[4]) || 0,
      word: Number(f[5]) || 0,
      left: Number(f[6]) || 0,
      top: Number(f[7]) || 0,
      width: Number(f[8]) || 0,
      height: Number(f[9]) || 0,
      conf,
    });
  }
  words.sort((a, b) => a.top - b.top || a.left - b.left);

  const grouped = new Map();
  for (const w of words) {
    const k = `${w.block}/${w.par}/${w.line}`;
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k).push(w);
  }
  const lines = [];
  for (const ws of grouped.values()) {
    ws.sort((a, b) => a.word - b.word || a.left - b.left);
    lines.push({ words: ws, text: joinSmart(ws.map((w) => w.text)), ...boxOf(ws) });
  }
  lines.sort((a, b) => a.top - b.top || a.left - b.left);
  return { page, words, lines };
}

/**
 * 从「星期X」这些表头词推出 7 列。
 *
 * 只认得到 3 列以上才敢用：手机端课表常常是竖排列表（一天一块、没有列），
 * 那时候硬凑 7 列只会把文字塞错格子，不如老实报错让用户走手动填。
 */
export function findDayColumns(lines) {
  const anchors = [];
  for (const line of lines) {
    for (let i = 0; i < line.words.length; i += 1) {
      const w = line.words[i];
      const m = /星期([一二三四五六日天])?/.exec(w.text);
      if (!m) continue;
      let day = m[1] ? DAY_CHARS.indexOf(m[1]) + 1 : 0;
      if (!day) {
        // 「星期」和「一」被切成了两个词 —— 往右找紧挨着的单个日名字
        const near = line.words.find((o) => o !== w
          && o.left >= w.left - 2 && o.left <= w.left + w.width * 1.6)
          || null;
        if (near && DAY_CHARS.includes(near.text.trim())) {
          day = DAY_CHARS.indexOf(near.text.trim()) + 1;
        }
      }
      if (!day) continue;
      anchors.push({ day, center: w.left + w.width / 2, bottom: line.bottom });
    }
  }
  if (anchors.length < 3) return null;

  // 同一天可能被认出两次，取最靠左的那个当锚（表头文字总是贴着列左边写）
  const byDay = new Map();
  for (const a of anchors) {
    const prev = byDay.get(a.day);
    if (!prev || a.center < prev.center) byDay.set(a.day, a);
  }
  const list = [...byDay.values()].sort((a, b) => a.day - b.day);
  if (list.length < 3) return null;
  const first = list[0];
  const last = list[list.length - 1];
  const pitch = (last.center - first.center) / (last.day - first.day);
  if (!(pitch > 20)) return null;

  const cols = OCR_DAY_NAMES.map((name, i) => {
    const day = i + 1;
    const center = first.center + (day - first.day) * pitch;
    return { day, name, center, left: center - pitch / 2, right: center + pitch / 2 };
  });
  // 表头那一行本身也在表里（`星期一` 这些字就落在第一列上），
  // 不把它的下沿记下来，它会被当成第一格里的一门课。跟着数组一起带出去。
  cols.headerBottom = Math.max(...anchors.map((a) => a.bottom ?? 0), 0);
  return cols;
}

/** 从「第N节」这些标签行推出节次带。标签贴在行顶，所以边界取相邻标签中心的中点。 */
export function findSectionBands(lines, columns) {
  const edge = columns[0] ? columns[0].center : Infinity;
  const hits = [];
  for (const line of lines) {
    if (line.left >= edge) continue;
    const m = /^第\s*(\d{1,2})\s*节?$/.exec(line.text);
    if (!m) continue;
    hits.push({ section: Number(m[1]), center: (line.top + line.bottom) / 2 });
  }
  if (hits.length < 3) return null;
  const byNum = new Map();
  for (const h of hits) if (!byNum.has(h.section)) byNum.set(h.section, h);
  const list = [...byNum.values()].sort((a, b) => a.section - b.section);

  return list.map((h, i) => {
    const prev = list[i - 1];
    const next = list[i + 1];
    const top = prev ? (prev.center + h.center) / 2 : h.center - ((next.center - h.center) / 2);
    const bottom = next ? (h.center + next.center) / 2 : h.center + ((h.center - prev.center) / 2);
    return { section: h.section, top, bottom, center: h.center };
  });
}

// ---------------------------------------------------------------- 一格里的文字

const isBareNumber = (t) => /^[\d\-–—]+$/.test(t);

const isPlaceLine = (t) => {
  if (/^[A-Za-z][A-Za-z0-9-]*$/.test(t)) return true;
  return t.length <= 8 && /(楼|馆|厅|室|堂|场|区|院|园|栋|座|中心|教室)$/.test(t);
};

// 节次的三种写法。**必须按顺序试**：`1-3节` 这种「一个节字管一个范围」的写法，
// 落到单节规则上只会认出末尾那个 3。
const SEC_PATTERNS = [
  /第?\s*(\d+)\s*节\s*[-–—~～至]\s*第?\s*(\d+)\s*节/,
  /第?\s*(\d+)\s*[-–—~～至]\s*第?\s*(\d+)\s*节/,
  /第?\s*(\d+)\s*节/,
];

/**
 * 把一个格子里的一堆碎行归成 名称 / 地点 / 节次 / 周次。
 *
 * 依据是**视觉顺序**：强智的手机课表一格里的顺序固定是
 *   名称（可能多行）→ 地点 → 第X-Y节 → 周次，
 * 这是从真实页面的词框实测出来的，不是猜的。所以按位置分类比按词形猜可靠得多：
 * 「汇贤堂」和「某老师」都是纯中文，只按词形根本分不开。
 *
 * ★ 每个判断都在**单行内**做。行与行之间不拼字符串 ——
 *   一旦拼起来，`ZXB-306` 和后面的 `1-3节` 会粘成 `ZXB-3061-3节`，
 *   节次被读成第 3061 节、周次被读成 417 周。这是实测踩到的坑。
 */
function classifyCell(rawLines, fallbackSection) {
  const buckets = { name: [], place: [], weeks: [] };
  let last = 'name';
  let sec = null;
  for (const line of rawLines) {
    const t = line.text;
    if (!t) continue;
    let hit = null;
    for (const re of SEC_PATTERNS) { hit = re.exec(t); if (hit) break; }
    if (hit) {
      if (!sec) sec = { begin: Number(hit[1]), end: Number(hit[2] ?? hit[1]) };
      // `1-3节 1-` / `1-2节 4` —— 节次后面还粘着周次的头，捡起来给周次桶
      const rest = t.slice(hit.index + hit[0].length).trim();
      if (rest && /^[\d\-–—~～至,，、]+$/.test(rest)) buckets.weeks.push(rest);
      last = 'weeks';
      continue;
    }
    if (/^[\d\s,，、\-–—~～至第]+周$/.test(t)) { buckets.weeks.push(t); last = 'weeks'; continue; }
    if (isPlaceLine(t)) { buckets.place.push(t); last = 'place'; continue; }
    // 「ZXD-」+「205」这种被切成两行的教室编号：纯数字行接着上一个桶
    if (isBareNumber(t)) { buckets[last].push(t); continue; }
    buckets.name.push(t);
    last = 'name';
  }

  // 「基础 英语 A」这种被拆开的课程名要粘回去，但只粘「汉字 + 单个字母/括号组」，
  // 免得把没认出来的教室编号也吞进课名里
  const name = joinSmart(buckets.name)
    .replace(/([\u4e00-\u9fff])\s+([A-Za-z]\b|\([^)]*\))/g, '$1$2')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .trim();
  return {
    name,
    place: joinSmart(buckets.place).replace(/\s+/g, ''),
    weeks: joinWeeks(buckets.weeks),
    begin: sec ? sec.begin : fallbackSection,
    end: sec ? sec.end : fallbackSection,
  };
}

/**
 * 周次碎片拼回一整串。
 * `1-` + `16 周` → `1-16周`（前一段自带连字符，直接接）
 * `4` + `17 周`   → `4-17周`（前一段没有连字符，得自己补一个，否则变成 417 周）
 */
function joinWeeks(parts) {
  let out = '';
  for (const p of parts) {
    const t = String(p ?? '').replace(/\s+/g, '');
    if (!t) continue;
    if (!out) { out = t; continue; }
    if (/\d$/.test(out) && /^\d/.test(t)) out += `-${t}`;
    else out += t;
  }
  return out;
}


// ---------------------------------------------------------------- 主入口

/** 同一列里竖直相邻的行按「纵向间隙」聚成块 —— 一块就是一格课。 */
function groupBlocks(lines) {
  const out = [];
  let cur = null;
  let medianH = 18;
  if (lines.length) {
    const hs = lines.map((l) => l.height).sort((a, b) => a - b);
    medianH = hs[Math.floor(hs.length / 2)] || 18;
  }
  const gapLimit = Math.max(medianH * 1.8, 16);
  for (const line of lines) {
    if (cur && line.top - cur.bottom <= gapLimit) {
      cur.lines.push(line);
      cur.bottom = Math.max(cur.bottom, line.bottom);
      cur.top = Math.min(cur.top, line.top);
      continue;
    }
    cur = { top: line.top, bottom: line.bottom, lines: [line] };
    out.push(cur);
  }
  return out;
}

/**
 * TSV → 课表网格。抛出的错误都是给用户看的整句话。
 * @param {string} tsv
 * @param {{minConf?: number}} [opts]
 */
export function ocrToRows(tsv, opts = {}) {
  const { words, lines, page } = parseOcrTsv(tsv, opts);
  const minWords = Number(opts.minWords ?? 20);
  if (words.length < minWords) {
    throw new Error('这张图里几乎没认出字来。是不是截得太小、太糊，或者只截了一小块？'
      + '整屏截「我的课表」那一页，字越大越准。');
  }

  const columns = findDayColumns(lines);
  if (!columns) {
    throw new Error('没在这张图里找到「星期一…星期日」的表头。'
      + '课表截图要带上最上面那一行星期，或者改用「上传课表文件」「手动填课表」。');
  }
  const bands = findSectionBands(lines, columns);
  if (!bands) {
    throw new Error('没在这张图里找到「第 1 节…第 N 节」那一列。'
      + '截图时左边那一列节次要一起截进去。');
  }

  const dayStart = columns[0].left;
  const dayEnd = columns[columns.length - 1].right;
  const bandTop = Math.max(bands[0].top, columns.headerBottom || 0);
  const bandBottom = bands[bands.length - 1].bottom;

  const bySlot = new Map();
  let dropped = 0;
  for (const w of words) {
    const cx = w.left + w.width / 2;
    const cy = w.top + w.height / 2;
    if (cx < dayStart || cx > dayEnd || cy < bandTop || cy > bandBottom) { dropped += 1; continue; }
    const col = columns.find((c) => cx >= c.left && cx < c.right);
    if (!col) { dropped += 1; continue; }
    // 节次带按「行顶」归，不按词中心：一格里的最后一行（周次）经常正好压在带边界上
    const band = bands.find((b) => w.top >= b.top && w.top < b.bottom)
      || bands.find((b) => cy >= b.top && cy < b.bottom);
    if (!band) { dropped += 1; continue; }
    const key = `${col.day}:${band.section}`;
    if (!bySlot.has(key)) bySlot.set(key, []);
    bySlot.get(key).push(w);
  }

  const cells = new Map();
  let courses = 0;
  for (const [key, ws] of bySlot) {
    const [day, section] = key.split(':').map(Number);
    ws.sort((a, b) => a.top - b.top || a.left - b.left);
    const lineObjs = [];
    const grouped = new Map();
    for (const w of ws) {
      const k = `${w.block}/${w.par}/${w.line}`;
      if (!grouped.has(k)) grouped.set(k, []);
      grouped.get(k).push(w);
    }
    for (const g of grouped.values()) {
      g.sort((a, b) => a.word - b.word || a.left - b.left);
      lineObjs.push({ words: g, text: joinSmart(g.map((x) => x.text)), ...boxOf(g) });
    }
    lineObjs.sort((a, b) => a.top - b.top || a.left - b.left);

    const parts = [];
    for (const block of groupBlocks(lineObjs)) {
      const c = classifyCell(block.lines, section);
      if (!c.name) continue;
      const detail = [c.weeks, `第${c.begin}节-第${c.end}节`, c.place]
        .filter((x) => x !== '')
        .join(' ');
      parts.push(`${c.name}[${syntheticCode(c.name)}]\n${detail}`);
      courses += 1;
    }
    if (parts.length) cells.set(key, parts.join('\n'));
  }

  const rows = [['节次/星期', ...OCR_DAY_NAMES]];
  for (const band of bands) {
    const line = [`第${band.section}节`];
    for (const col of columns) line.push(cells.get(`${col.day}:${band.section}`) || '');
    rows.push(line);
  }

  return {
    rows,
    stats: {
      page,
      columns: columns.length,
      sections: bands.length,
      courses,
      dropped,
      words: words.length,
    },
  };
}
