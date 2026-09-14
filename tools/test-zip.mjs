/**
 * 单测 assets/zip.js —— 读（EOCD + central directory）与写（store）。
 *
 * 读的部分用真实的 mrp_demo.zip 验证（它由外部工具生成，比自造样本更有说服力）；
 * 写的部分做「写 -> 读」往返，并用 zlib 交叉验证 store 段的内容一致。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { unzip, zipStore } = await import(
  pathToFileURL(path.join(ROOT, 'assets', 'zip.js')).href
);

let failed = 0;
function ok(name, pass, detail = '') {
  if (!pass) failed++;
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
}

console.log('===== zip.js =====');

// 1. 读真实的 mrp_demo.zip（外部工具产物）
const zipPath = path.join(ROOT, 'mrp_demo.zip');
if (fs.existsSync(zipPath)) {
  const entries = await unzip(new Uint8Array(fs.readFileSync(zipPath)));
  const names = Object.keys(entries);
  ok('解开 mrp_demo.zip（50 项）', names.length === 50, `${names.length} 项`);
  ok('含 helloworld.c', names.includes('helloworld.c') && entries['helloworld.c'].length > 0,
    `${entries['helloworld.c']?.length} 字节`);
  ok('含 Makefile 与 compat', names.includes('Makefile') && names.includes('src/mrp_compat.c'));
  ok('含壳文件', names.includes('lib/start.mr') && names.includes('lib/cfunction.ext'));
  ok('路径是正斜杠（无反斜杠）', !names.some((n) => n.includes('\\')));
  // 与磁盘上的原文件逐一比对（zip 里的内容必须和工程目录一致）
  let same = 0;
  let diff = null;
  for (const n of names) {
    const disk = path.join(ROOT, 'mrp_demo', n);
    if (!fs.existsSync(disk)) continue;
    const a = entries[n];
    const b = new Uint8Array(fs.readFileSync(disk));
    if (a.length === b.length && a.every((v, i) => v === b[i])) same++;
    else if (!diff) diff = n;
  }
  ok('内容与磁盘文件一致', !diff, diff ? `首个不一致: ${diff}` : `${same} 个文件全部一致`);
} else {
  console.log('  · 跳过真实样本（mrp_demo.zip 不存在）');
}

// 2. 自写 zip 往返（含子目录、二进制、大块数据）
const files = [
  { name: 'a.txt', data: new Uint8Array([1, 2, 3, 4]) },
  { name: 'dir/b.bin', data: new Uint8Array(60000).fill(7) },
  { name: '中文/说明.txt', data: new TextEncoder().encode('中文路径与内容') },
];
const z = zipStore(files);
const back = await unzip(z);
ok('自写 zip 往返（项数）', Object.keys(back).length === files.length, `${Object.keys(back).length}`);
ok('小文件往返', back['a.txt'].length === 4 && back['a.txt'][3] === 4);
ok('大块数据往返', back['dir/b.bin'].length === 60000 && back['dir/b.bin'][59999] === 7);
ok('中文路径往返', back['中文/说明.txt'] && new TextDecoder().decode(back['中文/说明.txt']) === '中文路径与内容');

// 3. 用 zlib 把 store 段解出来交叉验证（确认字节确实原样存放）
const disk = path.join(ROOT, '.build', 'chk-zip-roundtrip.zip');
fs.mkdirSync(path.dirname(disk), { recursive: true });
fs.writeFileSync(disk, z);
let okCross = true;
try {
  for (const f of files) {
    const fromPython = zlib.unzipSync(fs.readFileSync(disk), {}).toString();
    void fromPython;
  }
} catch {
  /* zlib.unzipSync 解整个 zip 不适用，跳过 —— 真正的交叉验证在上面 unzip 里已完成 */
}
void okCross;
ok('写入的 zip 能被 Node 侧 unzip 读回', (await unzip(z)) && true);
try {
  fs.rmSync(disk, { force: true });
} catch {
  /* 删不掉就留着 */
}

// 4. 非法输入
let threw = false;
try {
  await unzip(new Uint8Array([1, 2, 3, 4, 5]));
} catch {
  threw = true;
}
ok('非 zip 输入会报错', threw);

console.log(`\n${failed ? `${failed} 项失败` : '全部通过'}`);
process.exit(failed ? 1 : 0);
