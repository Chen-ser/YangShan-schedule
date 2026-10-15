#!/usr/bin/env node
/**
 * 等 GitHub Pages 部署完成，然后验线上站点。
 *
 *   node tools/wait-deploy.mjs            等到最新一次工作流跑完（最多 8 分钟）
 *   node tools/wait-deploy.mjs --timeout 300
 *
 * 只用匿名 GitHub API + 直连站点，不需要凭据（仓库是公开的）。
 */

const REPO = 'Chen-ser/YangShan-schedule';
const SITE = 'https://chen-ser.github.io/YangShan-schedule/';
const API = `https://api.github.com/repos/${REPO}`;
const UA = 'YangShan-schedule-deploy-check';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const TIMEOUT_S = Number(arg('timeout', 480));
const POLL_MS = Number(arg('poll', 15000));

const say = (s = '') => process.stdout.write(`${s}\n`);

async function api(path) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

const short = (sha) => (sha || '???????').slice(0, 7);
const secs = (a, b) => Math.round((new Date(b) - new Date(a)) / 1000);

async function latestRun() {
  const j = await api('/actions/runs?per_page=1');
  return j.workflow_runs?.[0] ?? null;
}

async function waitForRun(sha) {
  const start = Date.now();
  let last = '';
  while ((Date.now() - start) / 1000 < TIMEOUT_S) {
    const run = await latestRun();
    if (!run) {
      say('  API 暂时拿不到运行记录，重试…');
    } else {
      const line =
        `  run #${run.run_number}  ${run.status}/${run.conclusion ?? '-'}  ` +
        `head=${short(run.head_sha)}  ${secs(run.created_at, run.updated_at)}s`;
      if (line !== last) {
        say(`${new Date().toTimeString().slice(0, 8)}${line}`);
        last = line;
      }
      if (run.status === 'completed') {
        if (sha && short(run.head_sha) !== short(sha)) {
          say(`  ⚠ 最新一次运行的 head 是 ${short(run.head_sha)}，不是本次推送的 ${short(sha)}`);
        }
        return run;
      }
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return null;
}

async function checkSite() {
  // 加个随机参数绕开 CDN 与 Service Worker 的旧缓存
  const url = `${SITE}?t=${Date.now()}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Cache-Control': 'no-cache' } });
  const html = await res.text();
  const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
  const has = (s) => html.includes(s);
  say(`  HTTP ${res.status}  ${kb} KB`);
  say(`  是仰山课表的页面：${has('仰山课表') ? '✔' : '✗'}`);
  say(`  品牌 logo 已内联：${has('data:image/jpeg;base64,') ? '✔' : '✗'}`);
  say(`  manifest 已链接：${has('manifest.webmanifest') ? '✔' : '✗'}`);
  say(`  Service Worker 注册在：${has('serviceWorker') ? '✔' : '✗'}`);
  for (const asset of ['manifest.webmanifest', 'sw.js', 'ocr/worker.min.js']) {
    const r = await fetch(new URL(asset, SITE), { headers: { 'User-Agent': UA } });
    say(`  ${asset}：HTTP ${r.status}`);
  }
  return { kb: Number(kb), branded: has('data:image/jpeg;base64,') };
}

async function main() {
  const sha = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
  say(`仓库 ${REPO}`);
  say(`站点 ${SITE}`);
  say(sha ? `等这次推送（${short(sha)}）部署完…` : '等最新一次工作流跑完…');
  say('');

  const run = await waitForRun(sha);
  if (!run) {
    say(`✗ ${TIMEOUT_S}s 内没跑完，稍后自己看：${SITE}`);
    process.exitCode = 1;
    return;
  }
  say('');
  if (run.conclusion !== 'success') {
    say(`✗ CI 结论是 ${run.conclusion}`);
    say(`  详情：${run.html_url}`);
    process.exitCode = 1;
    return;
  }
  say('✔ CI 成功，验线上站点：');
  const { kb, branded } = await checkSite();
  say('');
  say(
    branded
      ? `✔ 站点已更新（${kb} KB，含品牌图）—— 之前是 190.4 KB 的无品牌版`
      : `⚠ 站点还是旧版（${kb} KB，没有内联品牌图）—— CDN 可能还在缓存，等 1-2 分钟再跑一次`
  );
}

main().catch((e) => {
  say(`✗ 出错：${e.message}`);
  process.exitCode = 1;
});
