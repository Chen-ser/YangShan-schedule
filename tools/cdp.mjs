// 极简 CDP 驱动：起一个 Edge 无头实例，在真实页面里求值一段 JS 并拿回结果。
//
// 为什么不用 `msedge --dump-dom` 或 `--screenshot`：
//   1. --virtual-time-budget 会跟页面里的定时器抢跑，异步结果不一定拿到；
//   2. 拿不到返回值，只能对 DOM 字符串做正则，测不出"函数返回了什么"；
//   3. 点按钮要走真实事件循环，dump-dom 做不到。
//
// ★ 沙箱注意：spawn 必须用 stdio:'ignore'。本项目的开发沙箱禁止命名管道，
// 一旦用默认的 stdio:'pipe' 去捕获子进程输出，就会 `Error: spawn EPERM`。
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPort(profile) {
  const f = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 300; i++) {
    if (existsSync(f)) {
      const p = Number(readFileSync(f, 'utf8').split('\n')[0]);
      if (p) return p;
    }
    await sleep(100);
  }
  throw new Error('DevToolsActivePort 一直没出现（Edge 没起来？）');
}

async function findPageWs(port, tries = 200) {
  for (let i = 0; i < tries; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* 还没起来 */ }
    await sleep(100);
  }
  throw new Error('没找到 page target');
}

export async function openSession(url, extraArgs = []) {
  const profile = mkdtempSync(path.join(tmpdir(), 'edge-cdp-'));
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-crash-reporter',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--window-size=1000,900', '--allow-file-access-from-files',
    ...extraArgs, url,
  ], { stdio: 'ignore' });

  const port = await findPort(profile);
  const wsUrl = await findPageWs(port);

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws 打不开')); });

  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send('Runtime.enable');

  const evaluate = async (expression, { awaitPromise = true, timeoutMs = 600000 } = {}) => {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, allowUnsafeEvalBlockedByCSP: true }),
      sleep(timeoutMs).then(() => ({ __timeout: true })),
    ]);
    if (r.__timeout) throw new Error('CDP evaluate 超时 ' + timeoutMs + 'ms');
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('页面里抛错：' + ((d.exception && (d.exception.description || d.exception.value)) || d.text));
    }
    return r.result && r.result.value;
  };

  /** 截当前视口到 png 文件。返回字节数。 */
  const screenshot = async (file, { width = 1000, height = 900 } = {}) => {
    await send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 2, mobile: false,
    });
    await sleep(300);
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(r.data, 'base64');
    writeFileSync(file, buf);
    return buf.length;
  };

  const close = async () => {
    try { ws.close(); } catch { /* ignore */ }
    try { child.kill(); } catch { /* ignore */ }
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  };

  return { evaluate, screenshot, close, port, send };
}

export async function runInPage(url, expression, opts = {}) {
  const s = await openSession(url, opts.extraArgs || []);
  try {
    return await s.evaluate(expression, opts);
  } finally {
    await s.close();
  }
}
