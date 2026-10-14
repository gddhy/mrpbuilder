/**
 * 单测 assets/encoding.js —— 源码文件的 GBK/UTF-8 识别与编解码。
 *
 * 判错的后果都很具体：
 *   · 读：GBK 文件按 UTF-8 解 → 中文变 �（用户报的"无法正常阅读"）；
 *   · 写：GBK 文件改完存回 UTF-8 → 中文字符串字面量的字节变了，编译进真机乱码；
 *   · 识别：ASCII 文件两种都成立，必须稳定取 UTF-8，别来回跳。
 * 用 Python 的 GBK 编解码器算出的已知字节做基准（Python 内置 GBK，权威）。
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { detectEncoding, decodeSource, encodeSource, ENC_UTF8, ENC_GBK } = await import(
  pathToFileURL(path.join(ROOT, 'assets', 'encoding.js')).href
);

let failed = 0;
function ok(name, pass, detail = '') {
  if (!pass) failed++;
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
}
const u8 = (s) => new TextEncoder().encode(s);
const hex = (s) => {
  const b = encodeSource(s, ENC_GBK);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ').toUpperCase();
};

// ---------------------------------------------------------------------------
console.log('===== 1. 识别（UTF-8 vs GBK）=====');

ok('纯 ASCII → utf-8', detectEncoding(u8('int main(void){}')) === ENC_UTF8);
ok('UTF-8 中文 → utf-8', detectEncoding(u8('中文注释')) === ENC_UTF8);
ok('GBK 中文 → gbk', detectEncoding(Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4])) === ENC_GBK);
ok('UTF-8 带 BOM → 仍是 utf-8', detectEncoding(Uint8Array.from([0xef, 0xbb, 0xbf, ...u8('abc')])) === ENC_UTF8);
ok('GBK 里夹 ASCII（混合）→ gbk（关键字节决定）',
  detectEncoding(Uint8Array.from([0x69, 0x6e, 0x74, 0xd6, 0xd0])) === ENC_GBK);
ok('GBK 文件里常见的全角标点字节 → gbk',
  detectEncoding(Uint8Array.from([0xa1, 0xa3])) === ENC_GBK); // 「。」

// ---------------------------------------------------------------------------
console.log('\n===== 2. 解码 =====');

ok('UTF-8 解码回原样', decodeSource(u8('int x; // 中文注释\n')) === 'int x; // 中文注释\n');
ok('GBK 解码：中文 → 中文', decodeSource(Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4])) === '中文');
ok('UTF-8 BOM 被剥掉', decodeSource(Uint8Array.from([0xef, 0xbb, 0xbf, ...u8('hello')])) === 'hello');

// ---------------------------------------------------------------------------
console.log('\n===== 3. 编码（写回原编码）=====');

// 已知字节基准：来自 Python 的 str.encode('gbk')
ok('GBK 编码「中文」= D6 D0 CE C4', hex('中文') === 'D6 D0 CE C4', hex('中文'));
ok('GBK 编码混合串与 Python 一致',
  hex('中文注释 // 你好') === 'D6 D0 CE C4 D7 A2 CA CD 20 2F 2F 20 C4 E3 BA C3', hex('中文注释 // 你好'));
ok('GBK 编码源码片段与 Python 一致',
  hex('int main(void) { /* 入口 */ return 0; }') ===
    '69 6E 74 20 6D 61 69 6E 28 76 6F 69 64 29 20 7B 20 2F 2A 20 C8 EB BF DA 20 2A 2F 20 72 65 74 75 72 6E 20 30 3B 20 7D');
ok('GBK 里编不出的字退化成 ?（不是抛错也不是乱塞字节）',
  hex('a🙂b') === '61 3F 62', hex('a🙂b'));
ok('UTF-8 编码仍是 UTF-8', [...encodeSource('中文', ENC_UTF8)].join(',') === [...u8('中文')].join(','));

// 往返无损：encode(gbk) → decode → 原文本
const roundtrip = [
  'int main(void) { /* 入口 */ return 0; }',
  '中文注释 // 你好',
  'A.改 B.删 C.备注',
];
for (const s of roundtrip) {
  ok(`GBK 往返无损：${JSON.stringify(s.slice(0, 18))}`,
    decodeSource(encodeSource(s, ENC_GBK)) === s,
    JSON.stringify(decodeSource(encodeSource(s, ENC_GBK)).slice(0, 18)));
}
ok('UTF-8 往返无损', decodeSource(encodeSource('中文注释', ENC_UTF8)) === '中文注释');

// ---------------------------------------------------------------------------
console.log(`\n${failed ? `${failed} 项失败` : '全部通过'}`);
process.exitCode = failed ? 1 : 0;
