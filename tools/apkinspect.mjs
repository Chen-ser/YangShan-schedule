// 查一个 APK(zip) 的内部布局：中央目录、每个本地记录的起止、以及本地数据区
// 与中央目录之间那段「不属于任何条目」的字节（正常情况下就是 APK Signing Block）。
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const buf = readFileSync(file);
console.log('file size       ', buf.length);

// ---- 找 EOCD ----
const eocds = [];
for (let i = 0; i + 22 <= buf.length; i++) {
  if (buf.readUInt32LE(i) !== 0x06054b50) continue;
  const n = buf.readUInt16LE(i + 10), sz = buf.readUInt32LE(i + 12);
  const off = buf.readUInt32LE(i + 16), c = buf.readUInt16LE(i + 20);
  if (off + sz === i && n > 0 && n < 10000) eocds.push({ i, n, sz, off, c });
}
console.log('EOCD candidates ', eocds.length);
if (!eocds.length) process.exit(1);
const { i: eocd, n: count, off: cdOff, sz: cdSize, c: comment } = eocds[eocds.length - 1];

// ---- 走中央目录 ----
let p = cdOff;
const entries = [];
for (let k = 0; k < count; k++) {
  if (buf.readUInt32LE(p) !== 0x02014b50) { console.log('bad central header at', p); break; }
  const nameLen = buf.readUInt16LE(p + 28);
  const extraLen = buf.readUInt16LE(p + 30);
  const cmtLen = buf.readUInt16LE(p + 32);
  const compSize = buf.readUInt32LE(p + 20);
  const rawSize = buf.readUInt32LE(p + 24);
  const lho = buf.readUInt32LE(p + 42);
  const method = buf.readUInt16LE(p + 10);
  const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
  entries.push({ name, compSize, rawSize, lho, method, nameLen, extraLen });
  p += 46 + nameLen + extraLen + cmtLen;
}
console.log('central entries ', entries.length, ' walked to', p, '(expect', cdOff + cdSize + ')');

// ---- 看本地记录区的真实结束位置 ----
let maxEnd = 0;
let storedBytes = 0;
let deflatedBytes = 0;
const withExtra = [];
for (const e of entries) {
  const ln = buf.readUInt16LE(e.lho + 26);
  const le = buf.readUInt16LE(e.lho + 28);
  const end = e.lho + 30 + ln + le + e.compSize;
  if (end > maxEnd) maxEnd = end;
  if (e.method === 0) storedBytes += e.compSize; else deflatedBytes += e.compSize;
  if (le > 64) withExtra.push(`${e.name} extra=${le}`);
}
console.log('local region end', maxEnd);
console.log('gap to cdOff    ', cdOff - maxEnd, '(APK Signing Block lives here)');
console.log('sum stored(m0)  ', storedBytes);
console.log('sum deflated    ', deflatedBytes);
console.log('sum comp        ', storedBytes + deflatedBytes);
console.log('entries with big local extra fields:', withExtra.length);
for (const s of withExtra.slice(0, 5)) console.log('   ', s);

// ---- 本地记录之间有没有空洞 ----
entries.sort((a, b) => a.lho - b.lho);
let prevEnd = 0;
let holes = 0;
for (const e of entries) {
  if (e.lho > prevEnd) { holes += e.lho - prevEnd; if (holes < 400000) console.log('   hole', e.lho - prevEnd, 'before', e.name); }
  const ln = buf.readUInt16LE(e.lho + 26), le = buf.readUInt16LE(e.lho + 28);
  prevEnd = e.lho + 30 + ln + le + e.compSize;
}
console.log('total bytes in holes between local records:', holes);
console.log('appended after EOCD:', buf.length - (eocd + 22 + comment));
