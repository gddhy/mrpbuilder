/**
 * 源码文件的编码识别 + 编解码（浏览器 / Node 共用，纯函数）。
 *
 * MRP 工程里部分文件用 GB2312/GBK 编码（中文注释、中文字符串字面量），
 * 硬按 UTF-8 解会把中文显示成 �，根本没法读。规则：
 *
 *   · 读：先**严格按 UTF-8** 试（含可选 BOM），能完整解出来就当 UTF-8；
 *     解不动（有非法字节序列）就按 GBK 解。纯 ASCII 两种都成立，取 UTF-8。
 *     这是编辑器 / `file` 通用做法 —— 真实的 GBK 中文几乎不可能恰好是合法 UTF-8。
 *   · 写：**按原编码编回去** —— 中文字符串字面量的字节不能变，否则编译进真机后乱码。
 *
 * GBK 编码复用 `assets/mrp-pack.js` 的实现（那是唯一的码表来源，别各写一套）：
 * 它用 `TextDecoder('gbk')` 把全部 23940 个码位一次性解成字符串、下标即码位序号，
 * 反过来建「字符 → 双字节」表，浏览器 / Node 都没自带 GBK **编码器**。
 */
import { encodeGBK } from './mrp-pack.js';

export const ENC_UTF8 = 'utf-8';
export const ENC_GBK = 'gbk';

/** 识别字节序列的编码：`'utf-8'` 或 `'gbk'` */
export function detectEncoding(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(b);
    return ENC_UTF8;
  } catch {
    return ENC_GBK;
  }
}

/** 按识别出的编码解码成文本（UTF-8 的 BOM 由 TextDecoder 自动剥掉） */
export function decodeSource(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const enc = detectEncoding(b);
  return new TextDecoder(enc).decode(b);
}

/** 把文本按指定编码编回字节；GBK 编不出的字符会退化成 `?` */
export function encodeSource(text, encoding) {
  return encoding === ENC_GBK ? encodeGBK(text) : new TextEncoder().encode(text);
}
