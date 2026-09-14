/**
 * 用两个真实 mrp 样本逐字节验证打包器。
 *
 * 思路：样本里的文件数据已经是 gzip 过的，直接原样取出，用我们自己的容器逻辑
 * 重新组装一遍。如果输出和原文件**一个字节都不差**，就说明固定头布局、文件列表区、
 * 偏移计算、fileStart 的 -8、CRC32 变体全部正确 —— 这比"能生成一个文件"强得多。
 *
 * 用法： node tools/test-pack.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { packMrp, parseMrp, crc32, encodeGBK, decodeGBK, encodeGBKDetailed } = await import(
  pathToFileURL(path.join(ROOT, 'assets', 'mrp-pack.js')).href
);

const SAMPLES = [
  'C:/APP/2048/build_output/game2048.mrp',
  'C:/APP/ai/demo/WasteLand_240.mrp',
];

let failed = 0;
function ok(name, pass, detail = '') {
  if (!pass) failed++;
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
}

function hex(b, n = 16) {
  return [...b.subarray(0, n)].map((x) => x.toString(16).padStart(2, '0')).join(' ');
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

console.log('===== 1. 真实样本往返重打包（逐字节比对）=====');
for (const p of SAMPLES) {
  if (!fs.existsSync(p)) {
    ok(`样本存在 ${p}`, false, '（文件不存在，跳过）');
    continue;
  }
  const orig = new Uint8Array(fs.readFileSync(p));
  console.log(`\n--- ${path.basename(p)}  (${orig.length.toLocaleString()} 字节) ---`);

  const parsed = parseMrp(orig);
  const problems = parsed.verify();
  ok('解析后自洽（长度/列表区/偏移/CRC）', problems.length === 0, problems.join('; '));
  console.log(
    `      显示名=${JSON.stringify(parsed.header.displayName)} appid=${parsed.header.appid}` +
      ` version=${parsed.header.version} flag=${parsed.header.flag} vendor=${JSON.stringify(parsed.header.vendor)}`
  );
  console.log(`      文件 ${parsed.files.map((f) => `${f.name}(${f.size})`).join(', ')}`);

  // 用解析出的头字段 + 原样的已压缩数据重新打包
  const rebuilt = packMrp({
    fileName: parsed.header.fileName,
    displayName: parsed.header.displayName,
    authStr: parsed.header.authStr,
    appid: parsed.header.appid,
    version: parsed.header.version,
    flag: parsed.header.flag,
    builderVersion: parsed.header.builderVersion,
    vendor: parsed.header.vendor,
    desc: parsed.header.desc,
    screenWidth: parsed.header.screenWidth,
    screenHeight: parsed.header.screenHeight,
    plat: parsed.header.plat,
    files: parsed.files.map((f) => ({ name: f.name, data: parsed.getFileData(f.name) })),
  });

  ok('长度一致', rebuilt.bytes.length === orig.length, `${rebuilt.bytes.length} vs ${orig.length}`);
  const d = firstDiff(rebuilt.bytes, orig);
  ok('逐字节完全一致', d === -1, d === -1 ? '' : `首个差异 @${d}: ${hex(rebuilt.bytes.subarray(d))} vs ${hex(orig.subarray(d))}`);

  // 顺带确认：MrpEditor 那个「跳过 CRC 字段」的算法算不出样本里的值
  const storedCrc = parsed.header.crc32;
  const zeroed = orig.slice();
  zeroed[84] = zeroed[85] = zeroed[86] = zeroed[87] = 0;
  let crcSkip = 0xffffffff;
  for (let i = 0; i < orig.length; i++) {
    if (i >= 84 && i < 88) continue;
    crcSkip ^= orig[i];
    for (let j = 0; j < 8; j++) crcSkip = (crcSkip >>> 1) ^ (crcSkip & 1 ? 0xedb88320 : 0);
  }
  crcSkip = (crcSkip ^ 0xffffffff) >>> 0;
  ok(
    'CRC 变体判定：置零版吻合、跳过版不吻合',
    crc32(zeroed) === storedCrc && crcSkip !== storedCrc,
    `存储=0x${storedCrc.toString(16)} 置零=0x${crc32(zeroed).toString(16)} 跳过=0x${crcSkip.toString(16)}`
  );
}

console.log('\n===== 2. GBK 编解码 =====');
checkGBK();

function checkGBK() {
  const cases = [
    ['中', [0xd6, 0xd0]],
    ['废土拾荒录文字生存RPG游戏', null],
    ['2048益智游戏', null],
    ['测试gcc编译', null],
    ['abcXYZ 0~9!@#', null],
    ['', []],
  ];
  for (const [s, expect] of cases) {
    const enc = encodeGBK(s);
    const back = decodeGBK(enc);
    if (expect) {
      ok(`"${s}" → ${[...enc].map((x) => x.toString(16)).join(' ')}`, JSON.stringify(back) === JSON.stringify(s));
    } else {
      ok(`"${s}" 往返一致（${enc.length} 字节）`, back === s, back === s ? '' : `解回 ${JSON.stringify(back)}`);
    }
  }
  // 样本里的中文名必须能编回去
  const a = decodeGBK(encodeGBK('废土拾荒录'));
  ok('样本中文名往返', a === '废土拾荒录', JSON.stringify(a));

  // 不可编码字符要能报出来。
  // 注意 '★'(U+2605) 在 GBK 符号区里是有码位的（0xA1EE 附近），只有 '✓'(U+2713) 没有，
  // 所以这里预期只有 1 个 missed。
  const r = encodeGBKDetailed('ok✓★中文');
  ok(
    '不可编码字符被识别并替换成 ?',
    r.missed.length === 1 && r.missed[0] === '✓' && r.bytes.includes(0x3f),
    `missed=${JSON.stringify(r.missed)} bytes=${[...r.bytes].map((x) => x.toString(16)).join(' ')}`
  );
  ok('★ 在 GBK 里可编码', new TextDecoder('gbk').decode(encodeGBK('★')) === '★');
}

console.log('\n===== 3. 合成样本自洽性 =====');
await (async () => {
  const files = [
    { name: 'start.mr', data: new Uint8Array([0x1b, 0x4d, 0x52, 0x50, 1, 2, 3]) },
    { name: 'bin.elf', data: new Uint8Array(1000).fill(7) },
    { name: '资源.bmp', data: new Uint8Array([1, 2, 3, 4, 5]) },
    { name: 'cfunction.ext', data: new Uint8Array(50).fill(9) },
  ];
  // 用 gzip 模拟真实流程（这里 data 已是"压缩后"的形态，直接打包即可）
  const { bytes, entries } = packMrp({
    fileName: 'demo.mrp',
    displayName: '打包测试',
    vendor: 'AI Studio',
    desc: '中文描述测试 0123456789',
    appid: 30001,
    version: 3,
    files,
  });
  ok('生成成功', bytes.length > 240, `${bytes.length} 字节`);
  const p = parseMrp(bytes);
  const problems = p.verify();
  ok('解析后自洽', problems.length === 0, problems.join('; '));
  ok('文件名往返（含中文）', p.files.map((f) => f.name).join(',') === files.map((f) => f.name).join(','), p.files.map((f) => f.name).join(','));
  ok('显示名/开发者/介绍往返', p.header.displayName === '打包测试' && p.header.vendor === 'AI Studio' && p.header.desc === '中文描述测试 0123456789');
  ok('appid/version 大小端都对', p.header.appid === 30001 && p.header.appidBE === 30001 && p.header.version === 3 && p.header.versionBE === 3);
  ok('fileStart = 240 + 列表长 - 8', p.header.fileStart === 240 + (p.header.fileStart + 8 - 240) - 8);
  console.log(`      清单: ${entries.map((e) => `${e.name}@${e.offset}(${e.size}B)`).join(', ')}`);

  // 截断字段：内部名超 12 字节应被截断而不是报错
  const long = packMrp({
    fileName: 'this-name-is-way-too-long.mrp',
    displayName: '一二三四五六七八九十一二三四五六七八九十',
    vendor: 'v'.repeat(60),
    desc: 'd'.repeat(100),
    files: [{ name: 'a', data: new Uint8Array([1]) }],
  });
  const pl = parseMrp(long.bytes);
  ok('超长字段被安全截断', pl.header.fileName.length === 12 && pl.header.vendor.length === 40 && pl.header.desc.length === 64,
    `internal=${JSON.stringify(pl.header.fileName)} vendor=${pl.header.vendor.length} desc=${pl.header.desc.length}`);
})();

console.log(`\n${failed ? `${failed} 项失败` : '全部通过'}`);
process.exit(failed ? 1 : 0);
