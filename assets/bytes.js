/**
 * 字节流小工具 —— 浏览器 / Node 共用，无依赖。
 *
 * 单独拆出来是因为 `vm.js`（工具链镜像）和 `mrp-pack.js`（mrp 里的文件）
 * 都要做 gzip，放一处避免两份实现走偏。
 */

/** gzip 魔数 */
export function isGzip(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;
}

/**
 * 是不是一个未压缩的 tar。
 * POSIX tar 的第 257 字节起是 "ustar"；老式 v7 tar 没有这个标记，
 * 所以额外用「大小字段是 8 进制 ASCII」来兜一下。
 */
export function looksLikeTar(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 512) return false;
  if (b[257] === 0x75 && b[258] === 0x73 && b[259] === 0x74 && b[260] === 0x61 && b[261] === 0x72) {
    return true; // "ustar"
  }
  // 兜底：检查第一个 header 的 size 字段（偏移 124，12 字节，8 进制）
  let octal = true;
  for (let i = 124; i < 135; i++) {
    const c = b[i];
    if (c === 0 || c === 0x20) continue;
    if (c < 0x30 || c > 0x37) {
      octal = false;
      break;
    }
  }
  return octal && b[0] !== 0;
}

/** gzip 压缩（浏览器与 Node 18+ 都内置 CompressionStream） */
export async function gzipBytes(bytes) {
  if (typeof CompressionStream !== 'function') {
    throw new Error('当前环境没有 CompressionStream，无法压缩');
  }
  const blob = new Blob([bytes]);
  const stream = blob.stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * 人读的体积：自动换算到最合适的单位（B / KB / MB / GB）。
 * 只用于显示，别拿它做校验 —— 要精确字节数就用原始数字。
 * 进制是 1024（与镜像/分段的实际口径一致），所以 1 MB = 1024 KB。
 *   1023     → 1,023 B     （不到 1 KB 不换算）
 *   2490     → 2.4 KB
 *   33572    → 32.8 KB
 *   32134639 → 30.6 MB
 */
const SIZE_UNITS = ['B', 'KB', 'MB', 'GB'];
export function fmtBytes(n) {
  if (n == null) return '';
  let v = n;
  let i = 0;
  while (v >= 1024 && i < SIZE_UNITS.length - 1) {
    v /= 1024;
    i += 1;
  }
  // 留 1 位小数后可能刚好顶到 1024.0（1048575 字节就是 1024.0 KB），
  // 那样显示出来像"1024 KB"，其实该进位到下一个单位 → 再降一级
  if (i < SIZE_UNITS.length - 1 && v.toFixed(1) === '1024.0') {
    v /= 1024;
    i += 1;
  }
  return i === 0 ? `${v.toLocaleString()} B` : `${v.toFixed(1)} ${SIZE_UNITS[i]}`;
}
