/**
 * C 源码着色 —— 纯函数，无 DOM 依赖，浏览器 / Node 共用。
 *
 * 为什么自己写而不是引一个库：
 *   1. 本项目所有页面资源都是随仓库走的（离线可用、无构建步骤），不引外部依赖；
 *   2. 只需要「C 的常见词法」这一件事，加个 highlight.js / Prism 会把体积翻好几倍；
 *   3. 着色结果要塞进**和 textarea 逐像素对齐**的覆盖层里，标记必须足够可控
 *      —— 见下面「只能改颜色」那条硬约束。
 *
 * ⚠ 硬约束：**只允许改颜色（color），不许加粗 / 斜体 / 改字体**。
 *   着色层是叠在 textarea 底下、靠同样的字体与排版对齐的；一旦某个 token 用了
 *   `font-weight: bold`，非等宽字体或合成加粗会让字形宽度变一点点，
 *   整行就会和底下的输入框错位（越往右越明显）。所以 token 样式里只有 `color`，
 *   `tools/test-codeview.mjs` 会检查这一点。
 *
 * 输出是一个 HTML 片段（已转义），可直接塞进 `innerHTML`：
 *   · 需要着色的 token 包一层 `<span class="c-xxx">`；
 *   · 普通标识符与空白**不包 span**（绝大多数字符都属于这种，少建节点 = 少一份开销）。
 */

/** token 类型 → CSS 类名。改这里要同步 style.css 的 `.c-*` 与两套调色板的 `--code-*` */
export const TOKEN_CLASS = {
  com: 'c-com', // /* … */ 与 //
  pre: 'c-pre', // #include 这类预处理指令（整行）
  str: 'c-str', // "…"
  num: 'c-num', // 数字，以及 NULL / true / false 这类常量
  kw: 'c-kw',   // 控制流与存储类关键字
  typ: 'c-typ', // 内置类型与整型别名
  fn: 'c-fn',   // 后面紧跟 "(" 的标识符（函数调用 / 定义）
};

/**
 * 超过这个长度就不着色了（行号照常显示）。
 *
 * 着色本身是线性的、很快，真正贵的是 `innerHTML` —— 662 KB 的 tables.h 会生成几万个
 * span，每次输入都要重建一遍，输入就会明显发涩。真实用户代码远小于这个量级；
 * 模板里只有 tables.h（662 KB，自动生成的查找表）会被跳过。
 */
export const MAX_HIGHLIGHT_CHARS = 200_000;

const KEYWORDS = new Set([
  'auto', 'break', 'case', 'const', 'continue', 'default', 'do', 'else', 'enum',
  'extern', 'for', 'goto', 'if', 'inline', 'register', 'restrict', 'return',
  'sizeof', 'static', 'struct', 'switch', 'typedef', 'union', 'volatile', 'while',
]);

const TYPES = new Set([
  'char', 'double', 'float', 'int', 'long', 'short', 'signed', 'unsigned', 'void',
  'bool', 'size_t', 'ssize_t',
  'int8_t', 'int16_t', 'int32_t', 'int64_t',
  'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t',
]);

/** 常量归到数字那一类（共用一种颜色，也省一个 CSS 变量） */
const CONSTANTS = new Set(['NULL', 'true', 'false']);

/** `<` `>` `&` `"` 必须转义，否则整段会被浏览器当成标签 */
export function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

/**
 * 一次扫描的词法正则。**刻意不加 `m` 标志** —— 这样 `$` 表示「输入结束」，
 * 块注释未闭合时才能一直吃到文件末尾（带 `m` 的话 `$` 会匹配行尾，注释会在第一行就断掉）。
 * 每个分支的顺序就是优先级：注释 / 字符串在前，才不会把注释里的 `"` 当成字符串开头。
 */
const TOKEN_RE = new RegExp(
  [
    String.raw`\/\*[\s\S]*?(?:\*\/|$)`, // 块注释（未闭合 → 到文件末尾）
    String.raw`\/\/[^\n]*`, // 行注释（不含换行）
    String.raw`"(?:[^"\\\n]|\\.)*(?:"|(?=\n|$))`, // 字符串（未闭合 → 到行尾，仍是字符串色）
    String.raw`'(?:[^'\\\n]|\\.)*(?:'|(?=\n|$))`, // 字符常量（同上）
    String.raw`#[^\n]*`, // 预处理指令（整行）
    String.raw`\b(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)[uUlLfF]*`, // 数字
    String.raw`[A-Za-z_]\w*`, // 标识符
  ].join('|'),
  'g'
);

/** 一个 token 该用哪个类；返回空串 = 不包 span（普通标识符） */
function tokenClass(tok, nextChar) {
  const c = tok.charCodeAt(0);
  if (c === 47) return TOKEN_CLASS.com; // '/' → /* 或 //
  if (c === 34) return TOKEN_CLASS.str; // "
  if (c === 39) return TOKEN_CLASS.str; // '（字符常量与字符串同色）
  if (c === 35) return TOKEN_CLASS.pre; // #
  if (c >= 48 && c <= 57) return TOKEN_CLASS.num; // 数字
  if (KEYWORDS.has(tok)) return TOKEN_CLASS.kw;
  if (TYPES.has(tok)) return TOKEN_CLASS.typ;
  if (CONSTANTS.has(tok)) return TOKEN_CLASS.num;
  if (nextChar === '(') return TOKEN_CLASS.fn; // 标识符后面紧跟 ( → 函数名
  return '';
}

/**
 * 把 C 源码转成「可直接 innerHTML 的」着色片段。
 * 超长（> MAX_HIGHLIGHT_CHARS）时只转义、不着色 —— 宁可没颜色也别让输入卡住。
 */
export function highlightC(src) {
  if (typeof src !== 'string' || src === '') return '';
  if (src.length > MAX_HIGHLIGHT_CHARS) return escapeHtml(src);

  let out = '';
  let last = 0;
  TOKEN_RE.lastIndex = 0; // 正则挂在模块上：每次进来都重置，别让上一次的游标漏进来
  let m;
  while ((m = TOKEN_RE.exec(src)) !== null) {
    if (m.index > last) out += escapeHtml(src.slice(last, m.index));
    const tok = m[0];
    const cls = tokenClass(tok, src[m.index + tok.length]);
    out += cls ? `<span class="${cls}">${escapeHtml(tok)}</span>` : escapeHtml(tok);
    last = m.index + tok.length;
  }
  if (last < src.length) out += escapeHtml(src.slice(last));
  return out;
}

/**
 * 逻辑行数。空串算 0 行（行号槽留空，不显示一个孤零零的 "1"）。
 * 注意：行号槽与编辑器一样是 `wrap="off"`（不折行），所以逻辑行 = 视觉行，
 * 行号与代码才会一一对齐。
 */
export function countLines(src) {
  return src === '' ? 0 : src.split('\n').length;
}

/** 行号槽的文本：用 `<pre>` 直接显示，靠 `text-align: right` 对齐 */
export function lineNumbersText(lines) {
  let s = '';
  for (let i = 1; i <= lines; i++) s += i + '\n';
  return s;
}

/**
 * textarea 的滚动量 → 两个图层的位移。抽成纯函数是为了能单测：
 * 这两个 transform 字符串是「看起来对不对」的关键，写反一个符号就整层跑偏。
 *   · 着色层跟着横竖两个方向（代码可以左右滚）；
 *   · 行号槽只跟竖向（横向滚的时候行号必须钉在原地）。
 */
export function scrollMirror(scrollLeft, scrollTop) {
  return {
    hl: `translate(${-scrollLeft}px, ${-scrollTop}px)`,
    lines: `translateY(${-scrollTop}px)`,
  };
}
