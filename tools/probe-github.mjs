// 探测本沙箱能否连到 GitHub（PowerShell/schannel 连不上时，Node 自带 OpenSSL 往往可以）。
const targets = [
  'https://github.com',
  'https://api.github.com',
  'https://codeload.github.com',
  'https://objects.githubusercontent.com',
  'https://github.githubassets.com',
];

for (const url of targets) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'manual' });
    console.log(`${url} -> ${res.status} (${Date.now() - t0}ms)`);
  } catch (e) {
    const cause = e.cause ? ` | cause: ${e.cause.code ?? e.cause.message}` : '';
    console.log(`${url} -> ERR: ${e.message}${cause}`);
  }
}
