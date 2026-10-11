// 查 GitHub 发布进度：仓库在不在、工作流跑了没、Pages 站点起没起来。
//
// 跑法：node tools/check-publish.mjs
// ★ 必须用 Node 而不是 PowerShell：这台机器上 PowerShell 的 schannel 连不上 GitHub，
//   Node 自带 OpenSSL 不受影响（见 README「网络环境注意」）。
//
// 只读：全是 GET，不带任何凭据，用的是 GitHub 的匿名接口（每小时 60 次，够用）。
const [OWNER, REPO] = ['Chen-ser', 'yangshan-schedule'];
const SITE = `https://${OWNER.toLowerCase()}.github.io/${REPO}/`;

const H = { 'user-agent': 'yangshan-schedule-publish-check', accept: 'application/vnd.github+json' };

const api = async (path) => {
  const res = await fetch(`https://api.github.com${path}`, { headers: H });
  let body = null;
  try { body = await res.json(); } catch { /* 可能没 body */ }
  return { status: res.status, body, headers: res.headers };
};

const line = (ok, label, detail) => console.log(`  ${ok ? '✔' : '✗'} ${label}${detail ? '：' + detail : ''}`);

// 匿名接口限流（每小时 60 次，按出口 IP 共享）在这台机器上很容易撞到。
// 撞到时不要把它当成"发布失败" —— API 查不了不代表站点没起来，继续往下直接拉站点。
const RATE_LIMITED = (r) => r.status === 403 && /rate limit/i.test(r.body?.message ?? '');
let apiUsable = true;

console.log(`仓库 ${OWNER}/${REPO}`);
console.log(`站点 ${SITE}\n`);

// 1) 仓库存在吗
const repo = await api(`/repos/${OWNER}/${REPO}`);
if (RATE_LIMITED(repo)) {
  apiUsable = false;
  line(false, '匿名 API 被限流，跳过仓库/工作流查询', '改用下面的站点直连结果判断');
} else if (repo.status === 404) {
  line(false, '仓库还不存在', '先把本地提交推上去（push-to-github.cmd）');
} else if (repo.status !== 200) {
  line(false, `查询仓库失败 HTTP ${repo.status}`, repo.body?.message ?? '');
} else {
  line(true, '仓库存在', `default_branch=${repo.body.default_branch}  private=${repo.body.private}  size=${repo.body.size}KB  pushed_at=${repo.body.pushed_at}`);
}

// 2) 分支上有没有我们的提交
if (apiUsable) {
  const commits = await api(`/repos/${OWNER}/${REPO}/commits?per_page=3`);
  if (commits.status === 200 && Array.isArray(commits.body)) {
    line(commits.body.length > 0, '分支上有提交', commits.body.map((c) => c.sha.slice(0, 7)).join(' '));
    for (const c of commits.body) console.log(`      ${c.sha.slice(0, 7)}  ${c.commit.message.split('\n')[0]}`);
  } else {
    line(false, '读不到提交列表（仓库可能是空的）', `HTTP ${commits.status}`);
  }

  // 3) 工作流跑了吗 —— 这是"页面为什么还没出来"最常见的答案
  const runs = await api(`/repos/${OWNER}/${REPO}/actions/runs?per_page=5`);
  if (runs.status === 200 && runs.body.workflow_runs) {
    const list = runs.body.workflow_runs;
    if (!list.length) {
      line(false, '还没有任何工作流运行过', '推上去后 GitHub Actions 才会启动；也可能是 Pages 源没选 GitHub Actions');
    } else {
      line(true, `工作流运行 ${list.length} 次`);
      for (const r of list) {
        const dur = r.updated_at && r.run_started_at
          ? `${Math.round((new Date(r.updated_at) - new Date(r.run_started_at)) / 1000)}s` : '-';
        console.log(`      #${r.run_number}  ${r.name}  [${r.status}/${r.conclusion ?? '-'}]  ${r.head_sha?.slice(0, 7)}  ${dur}`);
        console.log(`        ${r.html_url}`);
      }
    }
  } else {
    line(false, '读不到工作流（Actions 被关了？）', `HTTP ${runs.status}`);
  }

  // 4) Pages 配置
  const pages = await api(`/repos/${OWNER}/${REPO}/pages`);
  if (pages.status === 200) {
    line(true, 'Pages 已启用', `status=${pages.body.status}  build_type=${pages.body.build_type}  url=${pages.body.html_url}`);
    if (pages.body.build_type && pages.body.build_type !== 'workflow') {
      line(false, '  ⚠ build_type 不是 workflow', '到 Settings → Pages 把 Source 改成 GitHub Actions');
    }
  } else {
    line(false, 'Pages 还没启用或读不到', `HTTP ${pages.status}（未启用时是 404，去 Settings → Pages 选 GitHub Actions）`);
  }
}

// 4.5) 工作流徽章 —— 绕开 API 限流拿状态
//
// GitHub 的 badge.svg 是纯静态资源，不占 API 配额，里面 <title> 就写着结论
// （"build: passing" / "failing" / "no status"）。匿名 API 一被限流就靠它。
const BADGE = `https://github.com/${OWNER}/${REPO}/actions/workflows/pages.yml/badge.svg?branch=main`;
try {
  const res = await fetch(BADGE, { headers: { 'user-agent': H['user-agent'] } });
  const svg = await res.text();
  const title = (svg.match(/<title>([^<]*)<\/title>/) ?? [])[1] ?? '(读不出标题)';
  const ok = /passing|success/i.test(title);
  const running = /running|queued|pending|in progress/i.test(title);
  line(ok || running, '工作流徽章', title);
  if (!ok && !running) {
    console.log(`      去这里看失败在哪一步：https://github.com/${OWNER}/${REPO}/actions`);
  }
} catch (e) {
  line(false, '读不到工作流徽章', e.message);
}

// 5) 站点真的能打开吗
console.log('\n实际拉一下站点：');
try {
  const res = await fetch(SITE, { redirect: 'follow', headers: { 'user-agent': H['user-agent'] } });
  const html = await res.text();
  line(res.status === 200, `GET ${SITE}`, `HTTP ${res.status}  ${html.length} 字节`);
  if (res.status === 200) {
    const checks = [
      ['是仰山课表的页面', /仰山课表/.test(html)],
      ['manifest 已链接', /manifest\.webmanifest/.test(html)],
      ['Service Worker 注册在', /serviceWorker\.register/.test(html)],
    ];
    for (const [label, ok] of checks) line(ok, label);
    if (res.status === 200 && !/仰山课表/.test(html)) {
      console.log('      （200 但不是我们的页面 —— 多半是 Pages 还在跑，或者被 404 兜底页顶上来了）');
    }
  }
} catch (e) {
  line(false, '站点拉不到', e.message);
}

// 6) OCR 资产是否跟着发布了 —— 托管版是让它们按需取的，缺了就识别不了截图
try {
  const res = await fetch(SITE + 'ocr/worker.min.js', { method: 'HEAD', headers: { 'user-agent': H['user-agent'] } });
  line(res.status === 200, 'OCR 资产 /ocr/worker.min.js 已发布', `HTTP ${res.status}`);
} catch (e) {
  line(false, 'OCR 资产拉不到', e.message);
}
