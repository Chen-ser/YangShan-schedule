#!/usr/bin/env node
// 把 Microsoft.Web.WebView2 的 .nupkg 下到 feed/，让 dotnet build 可以完全离线。
//
// 为什么不用 dotnet restore：本机 / 沙箱里 dotnet 走 HTTPS 会直接失败
// （error NU1301: 无法加载源 https://api.nuget.org/v3/index.json ... SSL connection
//  could not be established）。Node 用自带的 OpenSSL，没有这个问题。
//
// 用法：node tools/fetch-nupkg.mjs [版本号]

import { mkdirSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const feed = join(here, '..', 'feed');

const id = 'microsoft.web.webview2';
const version = process.argv[2] ?? '1.0.3351.48';
const file = `${id}.${version}.nupkg`;
const target = join(feed, file);

if (existsSync(target) && statSync(target).size > 1024 * 512) {
  console.log(`已经有了：${target}（${statSync(target).size} 字节）`);
  process.exit(0);
}

const url = `https://api.nuget.org/v3-flatcontainer/${id}/${version}/${file}`;
console.log(`下载 ${url}`);
const res = await fetch(url);
if (!res.ok) {
  console.error(`下载失败：HTTP ${res.status} ${res.statusText}`);
  console.error('版本号可能不对。可以用下面的地址看有哪些版本：');
  console.error(`https://api.nuget.org/v3-flatcontainer/${id}/index.json`);
  process.exit(1);
}
const bytes = Buffer.from(await res.arrayBuffer());
mkdirSync(feed, { recursive: true });
writeFileSync(target, bytes);
console.log(`已写入 ${target}（${bytes.length} 字节）`);
