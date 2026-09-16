/**
 * 单测 assets/bytes.js —— gzip / tar 的格式判定 + 体积文案换算。
 *
 * 格式判定是「工具链镜像被传输层解压过」这条兜底逻辑的基础，
 * 判错会导致两个方向的坏结果：
 *   漏判 -> 推未压缩 tar 进虚拟机，报 gzip: invalid magic
 *   误判 -> 把正常镜像再压一遍（浪费，但无害）
 * 所以用真实产物 + 构造样本 + 随机噪声三面夹一遍。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { isGzip, looksLikeTar, gzipBytes, fmtBytes } = await import(
  pathToFileURL(path.join(ROOT, 'assets', 'bytes.js')).href
);

let failed = 0;
function ok(name, pass, detail = '') {
  if (!pass) failed++;
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
}

console.log('===== bytes.js 格式判定 =====');

// 造一个最小合法 tar：一个 header block，第 257 字节起是 ustar
function makeTar(name = 'a.txt', content = 'hello') {
  const h = new Uint8Array(1024); // 1 个 header + 1 个数据块
  const put = (s, off) => {
    for (let i = 0; i < s.length; i++) h[off + i] = s.charCodeAt(i);
  };
  put(name, 0);
  put('0000644', 100);          // mode
  put('0000000', 108);          // uid
  put('0000000', 116);          // gid
  put(content.length.toString(8).padStart(11, '0'), 124); // size（8 进制）
  put('00000000000', 136);      // mtime
  put('        ', 148);         // checksum 占位（不校验时可为空格）
  put('0', 156);                // typeflag
  put('ustar', 257);            // magic
  put('00', 263);               // version
  h.set([...content].map((c) => c.charCodeAt(0)), 512);
  return h;
}

const tar = makeTar();
const gz = await gzipBytes(tar);

ok('构造的样本被认成 tar', looksLikeTar(tar) && !isGzip(tar));
ok('gzip 后被认成 gzip', isGzip(gz) && !looksLikeTar(gz));
ok('gzip 结果能解回原样', Buffer.compare(Buffer.from(zlib.gunzipSync(gz)), Buffer.from(tar)) === 0);

// 真实产物（如果已经生成过）
const realPath = path.join(ROOT, 'assets', 'image', 'rootfs.tar.gz');
if (fs.existsSync(realPath)) {
  const real = new Uint8Array(fs.readFileSync(realPath));
  ok('真实 rootfs.tar.gz 判为 gzip', isGzip(real));
  const inner = new Uint8Array(zlib.gunzipSync(real));
  ok('真实镜像解开后判为 tar', looksLikeTar(inner), `${fmtBytes(real.length)} → ${fmtBytes(inner.length)}`);
  ok('关键尺寸：压缩后应明显小于解开后', real.length < inner.length / 2,
    `${fmtBytes(real.length)} vs ${fmtBytes(inner.length)}`);
  // 重新压回去还能用
  const re = await gzipBytes(inner);
  ok('重新压缩后仍能被判为 gzip 且可解', isGzip(re) && new Uint8Array(zlib.gunzipSync(re)).length === inner.length);
} else {
  console.log('  · 跳过真实镜像检查（assets/image/rootfs.tar.gz 还没生成）');
}

// 噪声与空数据不应被误判
const noise = new Uint8Array(2048);
for (let i = 0; i < noise.length; i++) noise[i] = (i * 37 + 11) & 0xff;
ok('随机噪声不被误判', !isGzip(noise) && !looksLikeTar(noise));
ok('空数据不被误判', !isGzip(new Uint8Array(0)) && !looksLikeTar(new Uint8Array(0)));
ok('gzip 魔数前缀被识别', isGzip(new Uint8Array([0x1f, 0x8b, 0x08, 0x00])));
ok('单字节不越界', !isGzip(new Uint8Array([0x1f])));

// ---- 体积文案（网页/命令行都用它显示文件大小）----
// 这里卡住的是换算的边界：写错会显示成 0.0 MB 这种没法看的数字。
console.log('\n===== fmtBytes 体积换算 =====');
const sizeCases = [
  [0, '0 B'],
  [1023, '1,023 B'],          // 不到 1 KB 不换算
  [1024, '1.0 KB'],           // 刚好 1 KB 要进位
  [2490, '2.4 KB'],
  [33572, '32.8 KB'],         // bin.elf 的典型大小
  [1048575, '1.0 MB'],        // 差 1 字节不到 1 MB：留 1 位小数会顶成 1024.0 KB，必须进位
  [1048576, '1.0 MB'],
  [38484, '37.6 KB'],         // .mrp 的典型大小
  [32134639, '30.6 MB'],      // rootfs.tar.gz
  [20971520, '20.0 MB'],      // 分段上限
  [1024 * 1024 * 1024, '1.0 GB'],
];
for (const [n, want] of sizeCases) {
  const got = fmtBytes(n);
  ok(`${String(n).padStart(11)} → ${want}`, got === want, got === want ? '' : `实际 ${got}`);
}
ok('null 不炸、返回空串', fmtBytes(null) === '');
// 中间量级以前会显示成 "0.0 MB"，这里专门钉一下
ok('10KB~1MB 之间不会显示成 0.0 MB', !fmtBytes(500000).includes('0.0'));

console.log(`\n${failed ? `${failed} 项失败` : '全部通过'}`);
process.exit(failed ? 1 : 0);
