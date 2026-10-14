/**
 * 单测 assets/serial.js —— 串口的收 / 发编解码 + 路径怎么拼进 shell 命令。
 *
 * 这几条都是「错了就现场炸」的那种：
 *   · 发：`serial0_send` 按 charCodeAt 逐字符发，中文码点 > 255 会被截断成控制字符
 *     （实测 0x03(^C) 直接把命令行打断、shell 卡在续行符到超时）；
 *   · 收：guest 回来的字节被拼成 Latin-1 串，不按 UTF-8 解回来就是乱码；
 *   · 拼：单引号是唯一能破坏命令拼接的字符，转义写错就是命令注入。
 * 前两条靠往返断言，第三条用一个「按 sh 的规则重新解析」的小解析器验回来。
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { serialBytes, decodeSerial, shQuote, shProjectPath, isSafeRelPath } = await import(
  pathToFileURL(path.join(ROOT, 'assets', 'serial.js')).href
);

let failed = 0;
function ok(name, pass, detail = '') {
  if (!pass) failed++;
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
}

// ---------------------------------------------------------------------------
console.log('===== 1. 发送：字符串 → 「每字符一字节」 =====');

ok('纯 ASCII 原样（不会多出字节）', serialBytes('cd /opt/tc && ls') === 'cd /opt/tc && ls');
ok('每个字符的码点都 ≤ 255（否则 serial0_send 会截断）',
  [...serialBytes('中文 / emoji 🙂 / ünïcode')].every((c) => c.charCodeAt(0) <= 255));
ok('字节数等于 UTF-8 长度',
  serialBytes('中文').length === 6 && serialBytes('é').length === 2, `${serialBytes('中文').length}`);
ok('控制字符不受影响（命令里的 \\n 要原样发）', serialBytes('a\nb')[1] === '\n');

// ---------------------------------------------------------------------------
console.log('\n===== 2. 接收：Latin-1 字节串 → UTF-8 =====');

const cases = [
  'plain ascii line',
  '             8436\t./Makefile',
  '      6120\t./源文件/中文 名字.c',
  'src/带空格 与\'引号\'.h',
  'emoji 🙂🙃 与全角（）',
  '',
];
for (const s of cases) {
  ok(`往返一致：${JSON.stringify(s.slice(0, 34))}`, decodeSerial(serialBytes(s)) === s,
    JSON.stringify(decodeSerial(serialBytes(s)).slice(0, 34)));
}
ok('坏字节不抛异常（替换成 U+FFFD）', (() => {
  try {
    return decodeSerial('\xff\xfe').includes('\ufffd');
  } catch {
    return false;
  }
})());

// ---------------------------------------------------------------------------
console.log('\n===== 3. 拼命令：单引号转义 =====');

ok("普通路径加引号", shQuote('src/a.c') === "'src/a.c'", shQuote('src/a.c'));
ok('空格不需要特殊处理（引号里就是字面量）', shQuote('a b.txt') === "'a b.txt'");
ok("单引号写成 '\\''", shQuote("it's.txt") === "'it'\\''s.txt'", shQuote("it's.txt"));
ok('$ 与反引号在单引号里是字面量', shQuote('$HOME`x`') === "'$HOME`x`'");
ok('工程路径 = 目录 + 相对路径', shProjectPath('/opt/tc/mrp_demo', 'src/a.c') === "'/opt/tc/mrp_demo/src/a.c'");

/**
 * 按 sh 的规则把一段 shell 词重新解析出来（只处理单引号 + 反斜杠转义）。
 * 用来验证 shQuote 的输出在真 shell 里会还原成原字符串 —— 也就是「拼进去安全」。
 */
function shUnquote(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    if (src[i] === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) throw new Error('未闭合的单引号: ' + src);
      out += src.slice(i + 1, end);
      i = end + 1;
    } else if (src[i] === '\\') {
      out += src[i + 1];
      i += 2;
    } else {
      throw new Error(`出现了未被引号包住的字符 ${JSON.stringify(src[i])}（可能被 shell 当成元字符）`);
    }
  }
  return out;
}
const nasty = [
  "it's.txt", 'a b  c.txt', '半角 与 全角（）', '\\反斜杠.txt', '$HOME.txt', '`cmd`.txt',
  '分号;与管道|与&与>重定向.txt', '换行'.replace('\n', ''), '-开头像选项.txt', '🙂.txt',
];
let quoteBad = [];
for (const n of nasty) {
  try {
    const parsed = shUnquote(shQuote(n));
    if (parsed !== n) quoteBad.push(`${JSON.stringify(n)} → ${JSON.stringify(parsed)}`);
  } catch (e) {
    quoteBad.push(`${JSON.stringify(n)} → ${e.message}`);
  }
}
ok('任意文件名经 shQuote 后都能被 shell 原样还原（含单引号 / $ / 反引号 / 分号 / 空格）',
  quoteBad.length === 0, quoteBad.join(' | '));

// ---------------------------------------------------------------------------
console.log('\n===== 4. 相对路径的白名单（重命名 / 删除前挡一道）=====');

for (const [name, want, why] of [
  ['src/mrc_base.h', true, '正常'],
  ['helloworld.c', true, '根目录'],
  ['中文 名.c', true, '中文 + 空格'],
  ["it's.c", true, '单引号（靠 shQuote 转义）'],
  ['', false, '空名字'],
  ['/etc/passwd', false, '绝对路径'],
  ['..', false, '父目录'],
  ['src/../../etc/passwd', false, '跳出工程'],
  ['src//a.c', false, '空路径段'],
  ['src/', false, '目录结尾'],
  ['a\nb.c', false, '换行（会截断命令行）'],
  ['a\u0003b.c', false, '控制字符 ^C'],
]) {
  ok(`${want ? '接受' : '拒绝'}：${JSON.stringify(name)} —— ${why}`, isSafeRelPath(name) === want);
}

// ---------------------------------------------------------------------------
console.log(`\n${failed ? `${failed} 项失败` : '全部通过'}`);
process.exitCode = failed ? 1 : 0;
