/**
 * ZIP 读写 —— 浏览器 / Node 共用，无依赖。
 *
 * 读：解析 EOCD + central directory，store 与 deflate 两种压缩都支持
 *     （deflate 用平台自带的 DecompressionStream('deflate-raw')）。
 * 写：两种都给 —— `zipStore()` 不压缩（内容已压过、或必须逐字节原样时用），
 *     `zipDeflate()` 走 deflate（「下载 demo 工程包」用它：1.3 MB → ~360 KB）。
 *     框架部分（local header / central directory / EOCD）两份共用 assembleZip()，
 *     免得两个实现慢慢走偏。
 *
 * 读的部分最早写在 experiments/wasi-runtime/vfs.js 里，那里已经验证过
 * 能正确解开工具链 zip；搬到正式模块是为了给「上传 zip 源码包」用。
 */

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

function findEOCD(view) {
  // EOCD 最长 22 字节 + 65535 字节注释
  const min = Math.max(0, view.byteLength - 65557);
  for (let i = view.byteLength - 22; i >= min; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) return i;
  }
  return -1;
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前环境不支持 DecompressionStream，无法解压 zip');
  }
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * 解开 zip。
 * @param {Uint8Array|ArrayBuffer} buffer
 * @returns {Promise<Object<string, Uint8Array>>} path -> 内容（目录项不返回）
 */
export async function unzip(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEOCD(view);
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件');
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  if (offset >= bytes.length) throw new Error('ZIP 中央目录偏移异常');

  const out = {};
  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== CEN_SIG) break;
    const method = view.getUint16(offset + 10, true);
    const compSize = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLen));

    if (!name.endsWith('/')) {
      // 数据长度/偏移以 local header 为准（zip64 或流式打包时两者可能不一致）
      const lNameLen = view.getUint16(localOffset + 26, true);
      const lExtraLen = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const raw = bytes.subarray(dataStart, dataStart + compSize);
      // Windows 工具打出来的 zip 会用反斜杠当分隔符（实测 mrp_demo.zip 就是这样），
      // 直接拿去做路径会生成 "lib\start.mr" 这种坏路径，统一归一化成斜杠。
      const norm = name.replace(/\\+/g, '/');
      out[norm] = method === 0 ? raw.slice() : await inflateRaw(raw);
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  if (!Object.keys(out).length) throw new Error('ZIP 里没有可用文件');
  return out;
}

// ---------------------------------------------------------------------------
// 写（store，不压缩）
// ---------------------------------------------------------------------------

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 打包成 zip（store，不压缩）。
 * 用于「内容已经压过、或必须逐字节原样」的场合。工程源码包请用 zipDeflate()。
 * @param {Array<{name: string, data: Uint8Array}>} files
 * @returns {Uint8Array}
 */
export function zipStore(files) {
  const enc = new TextEncoder();
  const entries = files.map((f) => {
    const data = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
    return { nameBytes: enc.encode(f.name), crc: crc32(data), packed: data, raw: data.length };
  });
  return assembleZip(entries, 0);
}

/** raw-deflate 一段字节（浏览器与 Node 18+ 都内置 CompressionStream） */
async function deflateRaw(bytes) {
  if (typeof CompressionStream !== 'function') {
    throw new Error('当前环境没有 CompressionStream，无法压缩 zip');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * 打包成 zip（deflate 压缩）。
 * 给「下载 demo 工程包」用：模板约 1.3 MB，store 会原样塞进去，
 * deflate 之后约 360 KB —— 下载体积差 3 倍多，值得。
 * @param {Array<{name: string, data: Uint8Array}>} files
 * @returns {Promise<Uint8Array>}
 */
export async function zipDeflate(files) {
  const enc = new TextEncoder();
  const entries = [];
  for (const f of files) {
    const data = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
    entries.push({
      nameBytes: enc.encode(f.name),
      crc: crc32(data),
      packed: await deflateRaw(data),
      raw: data.length,
    });
  }
  return assembleZip(entries, 8);
}

/**
 * 按 zip 结构把条目拼成字节流 —— store / deflate 只差一个 method 和压没压过，
 * 框架部分共用一份，避免两份实现走偏。
 * @param {Array<{nameBytes:Uint8Array, crc:number, packed:Uint8Array, raw:number}>} entries
 * @param {number} method 0=store，8=deflate
 */
function assembleZip(entries, method) {
  const chunks = [];
  const central = [];
  let offset = 0;

  const push = (b) => {
    chunks.push(b);
    offset += b.length;
  };
  const u16 = (v) => new Uint8Array([v & 0xff, (v >>> 8) & 0xff]);
  const u32 = (v) =>
    new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);

  for (const e of entries) {
    const crcBytes = u32(e.crc);
    const packedSize = u32(e.packed.length);
    const rawSize = u32(e.raw);

    // ⚠ 必须在写 local header 之前记下起始偏移；
    //    写完再记会变成"条目结束位置"，读回来全错（实际踩过）。
    const start = offset;

    // local file header
    push(u32(0x04034b50));
    push(u16(20)); // version needed
    push(u16(0x0800)); // flags：UTF-8 文件名
    push(u16(method));
    push(u16(0)); // mtime
    push(u16(0x21)); // mdate（1980-01-01，合法最小值）
    push(crcBytes);
    push(packedSize);
    push(rawSize);
    push(u16(e.nameBytes.length));
    push(u16(0)); // extra len
    push(e.nameBytes);
    push(e.packed);

    central.push({ ...e, crcBytes, packedSize, rawSize, offset: start });
  }

  const centralStart = offset;
  for (const c of central) {
    push(u32(CEN_SIG));
    push(u16(20)); // version made by
    push(u16(20)); // version needed
    push(u16(0x0800));
    push(u16(method));
    push(u16(0));
    push(u16(0x21));
    push(c.crcBytes);
    push(c.packedSize);
    push(c.rawSize);
    push(u16(c.nameBytes.length));
    push(u16(0)); // extra
    push(u16(0)); // comment
    push(u16(0)); // disk
    push(u16(0)); // internal attrs
    push(u32(0)); // external attrs
    push(u32(c.offset));
    push(c.nameBytes);
  }
  const centralSize = offset - centralStart;

  // EOCD
  push(u32(EOCD_SIG));
  push(u16(0));
  push(u16(0));
  push(u16(entries.length));
  push(u16(entries.length));
  push(u32(centralSize));
  push(u32(centralStart));
  push(u16(0));

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}
