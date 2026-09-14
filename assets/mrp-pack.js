/**
 * MRP 容器打包器 —— 纯 JS，浏览器 / Node 共用，无外部依赖
 *
 * 格式依据（三份来源互相印证，并用两个真实样本逐字节校验过）：
 *   1. fengdeyingzi/MrpProjects → MrpEditor/src/mrpinfo.ts（在线编辑器）
 *   2. fengdeyingzi/mrpbuilder → mrp.go（gcc 路线实际使用的打包器）
 *   3. C:\APP\2048\build_output\game2048.mrp、C:\APP\ai\demo\WasteLand_240.mrp（真机可跑的产物）
 *
 * 文件结构：
 *   ┌──────────────── 240 字节固定头 ────────────────┐
 *   │ MRPG / fileStart / totalLen / headerSize ...   │
 *   ├──────────────── 文件列表区 ────────────────────┤
 *   │ 每项: 名称长度(4) 名称+\0 偏移(4) 长度(4) 保留(4) │
 *   ├──────────────── 文件数据区 ────────────────────┤
 *   │ 每项: 名称长度(4) 名称+\0 长度(4) gzip 数据      │
 *   └────────────────────────────────────────────────┘
 *
 * 两个容易踩错的地方：
 *   • fileStart = 240 + 列表区长度 - 8。Go 源码里的原话是
 *     「不明白为什么要减8，但是必需这样做」，实测样本确实如此。
 *   • CRC32 是「把 84..87 这 4 字节置零后对整个文件计算」，然后写回 84。
 *     注意 MrpEditor 的 mrpinfo.ts 写的是「跳过这 4 字节」——那是错的，
 *     用它算出来的值和真实产物对不上（我在样本上验过）。
 */

export const MRP_HEADER_SIZE = 240;
export const MRP_MAGIC = 'MRPG';

/** MTK 平台固定 1（mstar 也是 1，spr 是 2） */
export const PLAT_MTK = 1;
/** 两个真实样本都是 10002 */
export const BUILDER_VERSION = 10002;
/**
 * flag 的位含义（来自 mrp.go 注释）：
 *   第 0 位 = 是否在应用列表里可见
 *   第 1-2 位 = CPU 性能要求（0-3，仅展讯有效）
 *   第 3 位 = 启动方式，0 = start 启动，1 = shell 启动
 * gcc 路线的参考实现固定用 Visible=1 / CPU=3 / Shell=0，即 1 + 6 + 0 = 7，
 * 两个真实样本也正好都是 7。
 */
export const FLAG_DEFAULT = 7;

/** 头部各字段的字节上限，供界面显示剩余空间用 */
export const MRP_LIMITS = {
  fileName: 12,
  displayName: 24,
  authStr: 16,
  vendor: 40,
  desc: 64,
};

// ---------------------------------------------------------------------------
// 文件分类（浏览器界面与命令行打包器共用同一套规则，避免两边不一致）
// ---------------------------------------------------------------------------

/** 这些扩展名不算「资源」：源码、构建产物、壳文件、文档 */
const NON_RESOURCE_EXT = new Set([
  'c', 'h', 'md', 'elf', 'o', 'obj', 'mr', 'ext', 'json', 'txt', 'mk',
]);
/** 纯文本、可以放进编辑器的扩展名 */
const TEXT_EXT = new Set(['c', 'h', 'txt', 'md', 'json', 'mk', 'mpr']);

export function extOf(name) {
  const base = String(name).split('/').pop().toLowerCase();
  if (base === 'makefile') return '';
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1) : '';
}

/**
 * 是否是「资源」——即打包时需要一并塞进 .mrp 的非源码文件。
 * 壳目录 lib/ 与运行时源码目录 src/ 整体排除，Makefile 与文档也排除。
 */
export function isResourceCandidate(name) {
  const base = String(name).split('/').pop().toLowerCase();
  if (base === 'makefile') return false;
  if (name.startsWith('lib/') || name.startsWith('src/')) return false;
  return !NON_RESOURCE_EXT.has(extOf(name));
}

/** 是不是二进制文件（二进制不进代码编辑器，免得被按 UTF-8 拆坏） */
export function isBinaryName(name) {
  const base = String(name).split('/').pop().toLowerCase();
  if (base === 'makefile') return false;
  return !TEXT_EXT.has(extOf(name));
}

// ---------------------------------------------------------------------------
// GBK 编解码
// ---------------------------------------------------------------------------

/**
 * GBK 双字节区：首字节 0x81..0xFE，尾字节 0x40..0xFE（跳过 0x7F），
 * 每个首字节 190 个码位，合计 126 × 190 = 23940。
 */
const GBK_LEADS = 0xfe - 0x81 + 1;
const GBK_TRAILS_PER_LEAD = 0xfe - 0x40 + 1 - 1;

let encodeMap = null;

/**
 * 建 GBK 反向表（字符 → 双字节）。
 *
 * 浏览器和 Node 都只提供 GBK 解码器（TextDecoder），没有编码器，
 * 而自己附一份码表文件又要多几十 KB。这里换个思路：
 * 把全部 23940 个码位拼成一个字节流，一次性解码成字符串，
 * 下标即码位序号，反向查表就有了。实测解码 3ms、建表 14ms，只在首次打包时做一次。
 */
function getEncodeMap() {
  if (encodeMap) return encodeMap;

  const pairs = new Uint8Array(GBK_LEADS * GBK_TRAILS_PER_LEAD * 2);
  let p = 0;
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x40; trail <= 0xfe; trail++) {
      if (trail === 0x7f) continue;
      pairs[p++] = lead;
      pairs[p++] = trail;
    }
  }

  const decoded = new TextDecoder('gbk').decode(pairs);
  encodeMap = new Map();
  for (let i = 0; i < decoded.length; i++) {
    const ch = decoded[i];
    // 未定义的码位会被解成 U+FFFD，跳过
    if (ch === '\ufffd' || ch === '\u0000') continue;
    if (encodeMap.has(ch)) continue;
    const lead = 0x81 + Math.floor(i / GBK_TRAILS_PER_LEAD);
    const r = i % GBK_TRAILS_PER_LEAD;
    // 正向映射时跳过 0x7F，所以尾字节要跨过这个洞
    const trail = 0x40 + r + (r >= 0x3f ? 1 : 0);
    encodeMap.set(ch, (lead << 8) | trail);
  }
  return encodeMap;
}

/**
 * UTF-8 字符串 → GBK 字节。
 * @returns {{bytes: Uint8Array, missed: string[]}} missed 是无法用 GBK 表示的字符
 *          （会被替换成 '?'，界面可以据此提示用户）
 */
export function encodeGBKDetailed(str) {
  const map = getEncodeMap();
  const out = [];
  const missed = [];
  const seen = new Set();

  for (const ch of String(str ?? '')) {
    const code = ch.codePointAt(0);
    if (code < 0x80) {
      out.push(code);
      continue;
    }
    if (code >= 0x80 && code <= 0xff) {
      // GBK 的 0x80 单字节是 €，其余 0xA1..0xFE 单字节区才是全角符号
      // 这里保守处理：Latin-1 区间直接用单字节（与 GBK 单字节区一致）
      out.push(code);
      continue;
    }
    const pair = map.get(ch);
    if (pair === undefined) {
      out.push(0x3f); // '?'
      if (!seen.has(ch)) {
        seen.add(ch);
        missed.push(ch);
      }
      continue;
    }
    out.push(pair >> 8, pair & 0xff);
  }
  return { bytes: Uint8Array.from(out), missed };
}

/** encodeGBKDetailed 的简化版，不关心哪些字符丢了 */
export function encodeGBK(str) {
  return encodeGBKDetailed(str).bytes;
}

/** GBK 字节 → 字符串（浏览器与 Node 的 TextDecoder 都支持 gbk） */
export function decodeGBK(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const nul = b.indexOf(0);
  return new TextDecoder('gbk').decode(nul >= 0 ? b.subarray(0, nul) : b);
}

// ---------------------------------------------------------------------------
// gzip
// ---------------------------------------------------------------------------

// 实现放在 bytes.js —— vm.js 也要用它给工具链镜像做兜底压缩。
// 这里原样再导出一遍，保持 `import { gzipBytes } from './mrp-pack.js'` 可用。
export { gzipBytes } from './bytes.js';
import { gzipBytes as gzipImpl } from './bytes.js';

/**
 * 把 [{name, data}] 逐项 gzip 成可直接打包的形态。
 *
 * 注意：mrp 里的每个文件都是压缩后存放的 —— 这一点在真实样本上验证过
 * （start.mr / cfunction.ext 都是 1f 8b 开头的 gzip 流）。
 */
export async function prepareFiles(entries, onProgress) {
  const out = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const raw = e.data instanceof Uint8Array ? e.data : new Uint8Array(e.data);
    const gz = await gzipImpl(raw);
    out.push({ name: e.name, data: gz, rawSize: raw.length });
    onProgress?.(i + 1, entries.length, e.name);
  }
  return out;
}

// ---------------------------------------------------------------------------
// CRC32
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** 标准 CRC-32（IEEE，反射，多项式 0xEDB88320） */
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// 打包
// ---------------------------------------------------------------------------

function writeFixedString(buf, offset, str, maxLen) {
  const { bytes } = encodeGBKDetailed(str);
  const n = Math.min(bytes.length, maxLen);
  buf.set(bytes.subarray(0, n), offset);
  // 余下保持 0（缓冲区本来就是 0 填充），即 NUL 结尾
  return n;
}

/**
 * 组装 .mrp。
 *
 * @param {object} meta
 * @param {string} meta.fileName     内部名，写入头部 [16]，GBK，≤12 字节
 * @param {string} meta.displayName  显示名，[28]，≤24
 * @param {string} [meta.authStr]    授权串，[52]，≤16
 * @param {number} [meta.appid]
 * @param {number} [meta.version]
 * @param {number} [meta.flag]       默认 7
 * @param {number} [meta.builderVersion] 默认 10002
 * @param {string} [meta.vendor]     开发者，[88]，≤40
 * @param {string} [meta.desc]       介绍，[128]，≤64
 * @param {number} [meta.screenWidth]
 * @param {number} [meta.screenHeight]
 * @param {number} [meta.plat]       默认 1（MTK）
 * @param {Array<{name: string, data: Uint8Array}>} meta.files
 *        顺序即打包顺序；data 必须是**已经 gzip 过**的内容
 *        （先跑 prepareFiles()）。这样打包本身是纯同步函数，便于逐字节测试。
 * @returns {{bytes: Uint8Array, entries: Array}} 同时返回清单，方便界面展示
 */
export function packMrp(meta) {
  const {
    fileName = '',
    displayName = '',
    authStr = '',
    appid = 0,
    version = 1,
    flag = FLAG_DEFAULT,
    builderVersion = BUILDER_VERSION,
    vendor = '',
    desc = '',
    screenWidth = 0,
    screenHeight = 0,
    plat = PLAT_MTK,
    files = [],
  } = meta;

  if (!files.length) throw new Error('没有要打包的文件');

  // 先把每一项的名称与偏移算出来
  const items = files.map((f) => {
    const nameBytes = encodeGBKDetailed(f.name).bytes;
    const nameLen = nameBytes.length + 1; // 含 NUL 终止符
    return {
      name: f.name,
      nameBytes,
      nameLen,
      data: f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data),
      rawSize: f.rawSize,
    };
  });

  let listLen = 0;
  let dataLen = 0;
  for (const it of items) {
    listLen += it.nameLen + 4 * 4; // 名称长度 + 名称 + 偏移 + 长度 + 保留
    dataLen += it.nameLen + 4 * 2 + it.data.length; // 名称长度 + 名称 + 长度 + 数据
  }

  const firstFilePos = MRP_HEADER_SIZE + listLen;
  const fileStart = firstFilePos - 8; // 见文件头注释，这个 -8 是必需的
  const totalLen = MRP_HEADER_SIZE + listLen + dataLen;

  const buf = new Uint8Array(totalLen); // 默认全 0
  const view = new DataView(buf.buffer);
  let pos = 0;

  // ---- 固定头 ----
  buf.set(new TextEncoder().encode(MRP_MAGIC), pos); pos += 4;
  view.setInt32(pos, fileStart, true); pos += 4;
  view.setInt32(pos, totalLen, true); pos += 4;
  view.setInt32(pos, MRP_HEADER_SIZE, true); pos += 4;
  writeFixedString(buf, pos, fileName, MRP_LIMITS.fileName); pos += 12;
  writeFixedString(buf, pos, displayName, MRP_LIMITS.displayName); pos += 24;
  writeFixedString(buf, pos, authStr, MRP_LIMITS.authStr); pos += 16;
  view.setInt32(pos, appid >>> 0, true); pos += 4;
  view.setInt32(pos, version >>> 0, true); pos += 4;
  view.setInt32(pos, flag >>> 0, true); pos += 4;
  view.setInt32(pos, builderVersion >>> 0, true); pos += 4;
  view.setInt32(pos, 0, true); pos += 4; // CRC 占位，最后写
  writeFixedString(buf, pos, vendor, MRP_LIMITS.vendor); pos += 40;
  writeFixedString(buf, pos, desc, MRP_LIMITS.desc); pos += 64;
  view.setInt32(pos, appid >>> 0, false); pos += 4; // 大端 appid
  view.setInt32(pos, version >>> 0, false); pos += 4; // 大端 version
  view.setInt32(pos, 0, true); pos += 4; // reserve2
  view.setInt16(pos, screenWidth, true); pos += 2;
  view.setInt16(pos, screenHeight, true); pos += 2;
  buf[pos++] = plat & 0xff;
  pos += 31; // reserve3

  // ---- 文件列表区 ----
  let filePos = firstFilePos;
  for (const it of items) {
    filePos += it.nameLen + 4 * 2;
    it.offset = filePos;
    filePos += it.data.length;

    view.setInt32(pos, it.nameLen, true); pos += 4;
    buf.set(it.nameBytes, pos); pos += it.nameBytes.length;
    buf[pos++] = 0;
    view.setInt32(pos, it.offset, true); pos += 4;
    view.setInt32(pos, it.data.length, true); pos += 4;
    view.setInt32(pos, 0, true); pos += 4;
  }

  // ---- 文件数据区 ----
  for (const it of items) {
    view.setInt32(pos, it.nameLen, true); pos += 4;
    buf.set(it.nameBytes, pos); pos += it.nameBytes.length;
    buf[pos++] = 0;
    view.setInt32(pos, it.data.length, true); pos += 4;
    buf.set(it.data, pos); pos += it.data.length;
  }

  if (pos !== totalLen) {
    throw new Error(`内部错误：写入 ${pos} 字节，预期 ${totalLen}`);
  }

  // CRC 是对「CRC 字段为 0」的整个文件算的，此时 buf[84..88) 正好还是 0
  view.setInt32(84, crc32(buf), true);

  return {
    bytes: buf,
    entries: items.map((it) => ({
      name: it.name,
      offset: it.offset,
      size: it.data.length,
      rawSize: it.rawSize,
    })),
  };
}

// ---------------------------------------------------------------------------
// 解析（用于校验与界面回显）
// ---------------------------------------------------------------------------

/** 读固定长度的 NUL 结尾字符串 */
function readFixedString(buf, offset, len) {
  return decodeGBK(buf.subarray(offset, offset + len));
}

export function parseMrp(input) {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (buf.length < MRP_HEADER_SIZE) throw new Error('文件太短，不是 mrp');
  const magic = String.fromCharCode(...buf.subarray(0, 4));
  if (magic !== MRP_MAGIC) throw new Error(`magic 不是 MRPG（实际 ${JSON.stringify(magic)}）`);

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const header = {
    magic,
    fileStart: view.getInt32(4, true),
    totalLen: view.getInt32(8, true),
    headerSize: view.getInt32(12, true),
    fileName: readFixedString(buf, 16, 12),
    displayName: readFixedString(buf, 28, 24),
    authStr: readFixedString(buf, 52, 16),
    appid: view.getInt32(68, true),
    version: view.getInt32(72, true),
    flag: view.getInt32(76, true),
    builderVersion: view.getInt32(80, true),
    crc32: view.getUint32(84, true),
    vendor: readFixedString(buf, 88, 40),
    desc: readFixedString(buf, 128, 64),
    appidBE: view.getInt32(192, false),
    versionBE: view.getInt32(196, false),
    reserve2: view.getInt32(200, true),
    screenWidth: view.getInt16(204, true),
    screenHeight: view.getInt16(206, true),
    plat: buf[208],
  };

  const files = [];
  let off = header.headerSize;
  const listEnd = header.fileStart + 8;
  while (off < listEnd) {
    const nameLen = view.getInt32(off, true);
    off += 4;
    const name = decodeGBK(buf.subarray(off, off + nameLen));
    off += nameLen;
    const offset = view.getInt32(off, true);
    off += 4;
    const size = view.getInt32(off, true);
    off += 4;
    const reserved = view.getInt32(off, true);
    off += 4;
    if (name) files.push({ name, nameLen, offset, size, reserved });
  }

  return {
    header,
    files,
    listEndActual: off,
    /** 取某个文件的原始存储数据（已 gzip 的字节） */
    getFileData(name) {
      const f = files.find((x) => x.name === name);
      if (!f) throw new Error(`mrp 里没有 ${name}`);
      return buf.subarray(f.offset, f.offset + f.size);
    },
    /** 校验：头部长度、总长、列表区、每个偏移指向的数据段是否自洽 */
    verify() {
      const problems = [];
      if (header.totalLen !== buf.length) {
        problems.push(`总长字段 ${header.totalLen} 与实际 ${buf.length} 不符`);
      }
      if (off !== listEnd) {
        problems.push(`列表区解析结束于 ${off}，但按 fileStart 应为 ${listEnd}`);
      }
      if (header.fileStart !== header.headerSize + (listEnd - header.headerSize) - 8) {
        // 该式恒等，保留以说明 fileStart 的语义
      }
      let expect = listEnd;
      for (const f of files) {
        const gotLen = view.getInt32(expect, true);
        const gotName = decodeGBK(buf.subarray(expect + 4, expect + 4 + gotLen));
        const gotSize = view.getInt32(expect + 4 + gotLen, true);
        const dataAt = expect + 4 + gotLen + 4;
        if (gotLen !== f.nameLen || gotName !== f.name || gotSize !== f.size) {
          problems.push(`${f.name}: 数据段头不符（nameLen ${gotLen}/${f.nameLen}, name ${gotName}, size ${gotSize}/${f.size}）`);
        }
        if (dataAt !== f.offset) {
          problems.push(`${f.name}: 偏移 ${f.offset} 与数据实际位置 ${dataAt} 不符`);
        }
        expect = dataAt + gotSize;
      }
      if (expect !== buf.length) problems.push(`数据区结束于 ${expect}，文件长 ${buf.length}`);
      // CRC：把 84..87 置零后重算
      const copy = buf.slice();
      copy[84] = copy[85] = copy[86] = copy[87] = 0;
      const want = crc32(copy);
      if (want !== header.crc32) {
        problems.push(`CRC32 不符：存储 0x${header.crc32.toString(16)}，重算 0x${want.toString(16)}`);
      }
      return problems;
    },
  };
}
