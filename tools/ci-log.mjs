// 从 GitHub 网页（不是 API）里挖出工作流最近一次运行为什么失败。
//
// 为什么要有这个脚本：匿名 GitHub API 每小时只有 60 次、按出口 IP 共享，
// 这台机器上很容易撞限流。而 HTML 页面不受该配额限制，且运行页里
// 嵌了一段 react-app.embeddedData 的 JSON，够定位到具体哪一步红了。
//
// 跑法：node tools/ci-log.mjs
// ★ 仓库规范名是 YangShan-schedule（大写 Y、大写 S）；github.com 网址大小写不敏感，
//   但 GitHub Pages 的路径敏感，所以别在这里改成全小写再拿去拼站点地址。
const [OWNER, REPO] = ['Chen-ser', 'YangShan-schedule'];
const UA = { 'user-agent': 'yangshan-schedule-ci-probe' };

const get = async (url) => {
  const res = await fetch(url, { headers: UA, redirect: 'follow' });
  return { status: res.status, text: await res.text() };
};

// 运行页把数据塞在 <script type="application/json" data-target="react-app.embeddedData"> 里
const embedded = (html) => {
  const m = html.match(/<script type="application\/json" data-target="react-app\.embeddedData">([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
};

console.log(`拉取 ${OWNER}/${REPO} 的运行列表…`);
const list = await get(`https://github.com/${OWNER}/${REPO}/actions`);
console.log(`  HTTP ${list.status}  ${list.text.length} 字节`);

// 从列表页抓运行 id（最稳的是直接找 /actions/runs/<数字>）
const ids = [...new Set([...list.text.matchAll(/\/actions\/runs\/(\d+)/g)].map((m) => m[1]))];
if (!ids.length) {
  console.log('  没从列表页里找到任何运行 id。可能仓库还没有运行记录，或页面结构变了。');
  process.exit(1);
}
console.log(`  找到 ${ids.length} 个运行：${ids.slice(0, 5).join(', ')}`);

for (const id of ids.slice(0, 3)) {
  const url = `https://github.com/${OWNER}/${REPO}/actions/runs/${id}`;
  const run = await get(url);
  const data = embedded(run.text);
  console.log(`\n=== 运行 ${id}  HTTP ${run.status} ===`);
  console.log(`  ${url}`);

  if (data) {
    // 结构随 GitHub 版本变，所以这里递归找所有带 conclusion 的对象，不写死路径。
    const seen = new Set();
    const walk = (node, depth = 0) => {
      if (!node || typeof node !== 'object' || depth > 8) return;
      if (seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) { for (const x of node) walk(x, depth + 1); return; }
      const name = node.name ?? node.title;
      const concl = node.conclusion ?? node.status;
      if (name && concl && typeof name === 'string' && name.length < 80) {
        const mark = /success|completed/i.test(String(concl)) ? '✔' : /fail/i.test(String(concl)) ? '✗' : '·';
        if (mark === '✗' || /fail/i.test(String(concl))) console.log(`  ${mark} ${name}  [${concl}]`);
      }
      for (const v of Object.values(node)) walk(v, depth + 1);
    };
    walk(data);
  } else {
    console.log('  （页面里没有 embeddedData，退回正则找状态文本）');
  }

  // 兜底：直接找页面上的失败标记
  for (const pat of [
    /<span[^>]*class="[^"]*text-red[^"]*"[^>]*>([^<]{2,60})<\/span>/g,
    /([A-Za-z0-9_\u4e00-\u9fa5 ]{2,50})\s*·\s*(failure|failed|cancelled)/gi,
  ]) {
    const hits = [...run.text.matchAll(pat)].map((m) => m[1].trim()).filter(Boolean);
    if (hits.length) console.log(`  失败标记：${[...new Set(hits)].slice(0, 10).join(' | ')}`);
  }
}
