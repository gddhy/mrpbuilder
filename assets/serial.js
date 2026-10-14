/**
 * 串口的收 / 发编解码，以及「把路径安全拼进 shell 命令」。
 *
 * 为什么值得单独一个模块：v86 的 `serial0_send` 是**按 `charCodeAt` 逐字符发的**
 * （码点 > 255 的字符会被截断成低 8 位）—— 所以「发中文路径」不能直接把字符串丢进去：
 * 实测 `功能机开发规范.md` 会打出 0x03(^C) / 0x00(NUL)，^C 直接打断命令行、留下未闭合引号，
 * shell 卡在续行符上等到超时。
 * 正确做法是**先按 UTF-8 编成字节、再把每个字节映射成一个字符**发出去；
 * 反方向同理：guest 回来的字节被 `String.fromCharCode` 拼成 Latin-1 串，要按 UTF-8 解回来。
 *
 * 这几个都是纯函数（不碰 DOM、不碰 v86），所以放在这里单测（`tools/test-serial.mjs`）。
 */

/** JS 字符串 → 「每字符一个字节」的串，可直接交给 `serial0_send` */
export function serialBytes(text) {
  const bytes = new TextEncoder().encode(text);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

/** 串口回来的 Latin-1 串 → JS 字符串（按 UTF-8 解；坏字节替换成 U+FFFD，不抛异常） */
export function decodeSerial(text) {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/**
 * 把任意字符串安全地放进 shell 命令：整体单引号包起来，内部的单引号写成 `'\''`。
 * 单引号里除了 `'` 本身什么都不用管（`$`、反引号、空格、换行都是字面量），
 * 所以这是唯一要处理的情况 —— 也是唯一会破坏命令拼接的字符。
 */
export function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** 工程内相对路径 → guest 里可直接当参数用的 shell 片段 */
export function shProjectPath(projectDir, relPath) {
  return shQuote(`${projectDir}/${relPath}`);
}

/**
 * 允许作为工程内相对路径吗？（重命名 / 删除前先挡一道）
 *
 * 危险的是「拼进命令」和「跳出工程目录」两类：
 *   · 控制字符（含换行）会把命令行断成两截 —— 单引号也保不住；
 *   · `..` 段能跳到工程外（比如删掉工具链自身的文件）；
 *   · 绝对路径 / 空段同理。
 * 单引号本身不用挡（shQuote 会转义），但空名字要挡。
 */
export function isSafeRelPath(name) {
  if (typeof name !== 'string' || !name) return false;
  if (/[\u0000-\u001f\u007f]/.test(name)) return false; // 控制字符（含 \n \r \t）
  if (name.startsWith('/')) return false;
  if (name.endsWith('/')) return false;
  return name.split('/').every((seg) => seg && seg !== '.' && seg !== '..');
}
