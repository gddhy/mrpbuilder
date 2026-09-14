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

/** 人读的大小 */
export function fmtBytes(n) {
  if (n == null) return '';
  return n < 10240 ? `${n.toLocaleString()} B` : `${(n / 1048576).toFixed(1)} MiB`;
}
