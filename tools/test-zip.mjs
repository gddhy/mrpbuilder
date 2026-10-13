/**
 * 单测 assets/zip.js —— 读（EOCD + central directory）与写（store / deflate）。
 *
 * 写：`zipDeflate()` 是「下载demo」走的那条路（从虚拟机现取模板 → 压成 zip），
 * `zipStore()` 用于「必须逐字节原样」的场合。两个都做「写 -> 读」往返，
 * 并且用 Node 的 zlib 独立把压缩段解一遍交叉验证（不走我们的 DecompressionStream，
 * 换个实现去认同一份字节，才说明写对了）。
 *
 * 读：除了读回自己写的包，还构造两个「外来 zip」形态 —— 反斜杠分隔符（Windows
 * 工具打出来的就是这样）和 EOCD 后面挂注释 —— 这两条都是真实踩过的路径。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { unzip, zipStore, zipDeflate } = await import(
  pathToFileURL(path.join(ROOT, 'assets', 'zip.js')).href
);

let failed = 0;
function ok(name, pass, detail = '') {
  if (!pass) failed++;
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
}

const enc = new TextEncoder();
const eq = (a, b) => a && b && a.length === b.length && a.every((v, i) => v === b[i]);

console.log('===== zip.js 写：zipDeflate（下载demo 走这条）=====');

const sample = [
  { name: 'a.txt', data: enc.encode('hello hello hello hello hello') },
  { name: 'dir/big.bin', data: new Uint8Array(120000).fill(9) },
  { name: '中文/说明.txt', data: enc.encode('中文路径与内容') },
  { name: 'lib/empty', data: new Uint8Array(0) },
];
const rawTotal = sample.reduce((n, f) => n + f.data.length, 0);
const zd = await zipDeflate(sample);
const backD = await unzip(zd);

ok('条目数一致', Object.keys(backD).length === sample.length, `${Object.keys(backD).length} 项`);
ok('小文本往返', eq(backD['a.txt'], sample[0].data));
ok('大块二进制往返', eq(backD['dir/big.bin'], sample[1].data), `${sample[1].data.length} 字节`);
ok('中文路径往返', eq(backD['中文/说明.txt'], sample[2].data));
ok('空文件往返', backD['lib/empty'] && backD['lib/empty'].length === 0);
ok(
  '确实压缩了（可压的大块明显变小）',
  zd.length < rawTotal * 0.5,
  `${rawTotal} → ${zd.length} 字节（${((zd.length / rawTotal) * 100).toFixed(0)}%）`
);

// 交叉验证：手抠第一个条目的 local header，用 Node 的 zlib 解压缩段
// （绕开我们的 DecompressionStream，换个实现认同一份字节）
{
  const dv = new DataView(zd.buffer, zd.byteOffset, zd.byteLength);
  const nameLen = dv.getUint16(26, true);
  const extraLen = dv.getUint16(28, true);
  const compSize = dv.getUint32(18, true);
  const method = dv.getUint16(8, true);
  const dataStart = 30 + nameLen + extraLen;
  const packed = zd.subarray(dataStart, dataStart + compSize);
  let inflateOk = false;
  try {
    inflateOk = eq(new Uint8Array(zlib.inflateRawSync(Buffer.from(packed))), sample[0].data);
  } catch {}
  ok('local header 记录 method=8 / 长度可用', method === 8 && compSize === packed.length,
    `method=${method} 压缩段 ${compSize} 字节`);
  ok('Node zlib 独立解出的内容与原文一致', inflateOk);
}

// 交叉验证 CRC：手抠第一条的 CRC 字段，与 Node 的 zlib.crc32 对
{
  const dv = new DataView(zd.buffer, zd.byteOffset, zd.byteLength);
  const crcInZip = dv.getUint32(14, true);
  ok('CRC32 与 Node zlib.crc32 一致', crcInZip === (zlib.crc32(sample[0].data) >>> 0),
    `zip ${crcInZip.toString(16)} / zlib ${(zlib.crc32(sample[0].data) >>> 0).toString(16)}`);
}

console.log('\n===== zip.js 写：zipStore（不压缩）=====');
const files = [
  { name: 'a.txt', data: new Uint8Array([1, 2, 3, 4]) },
  { name: 'dir/b.bin', data: new Uint8Array(60000).fill(7) },
  { name: '中文/说明.txt', data: enc.encode('中文路径与内容') },
];
const z = zipStore(files);
const back = await unzip(z);
ok('自写 zip 往返（项数）', Object.keys(back).length === files.length, `${Object.keys(back).length}`);
ok('小文件往返', back['a.txt'].length === 4 && back['a.txt'][3] === 4);
ok('大块数据往返', back['dir/b.bin'].length === 60000 && back['dir/b.bin'][59999] === 7);
ok('中文路径往返', new TextDecoder().decode(back['中文/说明.txt']) === '中文路径与内容');
ok('store 段原样存放（未压缩）', z.length > 60000, `${z.length} 字节`);

console.log('\n===== zip.js 读：外来 zip 形态 =====');
{
  // 反斜杠分隔符：Windows 工具打出来的 zip 就是这种，读的时候必须归一化成斜杠
  const bs = zd.slice();
  const ascSlash = 0x2f;
  const ascBack = 0x5c;
  for (let i = 0; i < bs.length; i++) if (bs[i] === ascSlash) bs[i] = ascBack;
  const backBs = await unzip(bs);
  ok('反斜杠路径会归一化成正斜杠',
    !Object.keys(backBs).some((n) => n.includes('\\')) && 'dir/big.bin' in backBs,
    Object.keys(backBs).slice(0, 3).join('、'));
}
{
  // EOCD 后面挂注释（真实 zip 允许）：仍要能定位到 EOCD
  const withComment = new Uint8Array(zd.length + 12);
  withComment.set(zd, 0);
  withComment.set(enc.encode('comment here'), zd.length);
  const backC = await unzip(withComment);
  ok('EOCD 后面有注释也能读', Object.keys(backC).length === sample.length);
}

console.log('\n===== zip.js 读：非法输入 =====');
let threw = false;
try {
  await unzip(new Uint8Array([1, 2, 3, 4, 5]));
} catch {
  threw = true;
}
ok('非 zip 输入会报错', threw);

// 落一份到 .build 供人工检查（可选产物）
try {
  fs.mkdirSync(path.join(ROOT, '.build'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, '.build', 'chk-zip-deflate.zip'), zd);
} catch {
  /* 写不了就算了 */
}

console.log(`\n${failed ? `${failed} 项失败` : '全部通过'}`);
process.exit(failed ? 1 : 0);
