/**
 * 单测 C 源码着色（assets/codeview.js）+ 它与 style.css 的契约。
 *
 * 为什么这个模块值得单独测：
 *   1. 它的输出直接塞进 `innerHTML`，**转义错一个字符就是 XSS / 版式崩坏**；
 *      `#include <stdio.h>` 里的 `<` 是最容易被漏掉的那种。
 *   2. 它不是「好看的装饰」而是要和 textarea 逐像素对齐的图层 ——
 *      只要少了一个字符、多了一个换行，行号和代码就会整体错位。
 *      所以最关键的一条断言是**往返无损**：把生成的 HTML 去掉标签再反转义，必须和输入一字不差。
 *   3. token 的 CSS 类名、`--code-*` 变量名散落在三个文件里（codeview.js / style.css 两套调色板），
 *      改一处忘一处不会报错、只会「某类代码永远不变色」。
 *
 * 不需要浏览器：着色器是纯函数；style.css 直接当文本读。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const { highlightC, countLines, lineNumbersText, escapeHtml, TOKEN_CLASS, MAX_HIGHLIGHT_CHARS } =
  await import(pathToFileURL(path.join(ROOT, 'assets', 'codeview.js')).href);

let failed = 0;
function ok(name, pass, detail = '') {
  if (!pass) failed++;
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
}

/** 把着色结果还原成纯文本：去掉我们自己加的 span，再反转义 */
function plain(html) {
  return html
    .replace(/<\/?span[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
/** 取出某段源码被包成的类名列表（按出现顺序） */
function classesOf(html) {
  return [...html.matchAll(/<span class="(c-[a-z]+)">/g)].map((m) => m[1]);
}

// ---------------------------------------------------------------------------
console.log('===== 1. 转义与往返无损（最重要的一条）=====');

ok('空串 → 空串', highlightC('') === '' && highlightC(null) === '');
ok('& < > 都被转义', escapeHtml('a & b < c > d') === 'a &amp; b &lt; c &gt; d');

const ESCAPE_CASES = [
  '#include <stdio.h>',
  'if (a < b && c > d) x = a & b;',
  'char *s = "a<b>c&d";',
  '/* <tag> & "quoted" */',
  'int a = 1; // 注释里有 < > &',
  'a <<= 2; b >>= 1; c ^= ~d;',
];
for (const src of ESCAPE_CASES) {
  const html = highlightC(src);
  ok(`往返无损：${src.slice(0, 32)}`, plain(html) === src, plain(html) === src ? '' : JSON.stringify(plain(html)));
  ok(`  没有裸 < 或 >（除标签外）`, !/<(?!\/?span)/.test(html), html.slice(0, 60));
}

// ---------------------------------------------------------------------------
console.log('\n===== 2. 各类 token =====');

const CLASS_CASES = [
  ['// 行注释', ['c-com']],
  ['/* 块注释 */', ['c-com']],
  ['"字符串"', ['c-str']],
  ["'\\n'", ['c-str']],
  ['#define MAX 10', ['c-pre']],
  ['0x1F', ['c-num']],
  ['1.5e-3', ['c-num']],
  ['42u', ['c-num']],
  ['NULL', ['c-num']],
  ['true', ['c-num']],
  ['if', ['c-kw']],
  ['sizeof', ['c-kw']],
  ['int32_t', ['c-typ']],
  ['unsigned', ['c-typ']],
  ['foo(', ['c-fn']],
];
for (const [src, want] of CLASS_CASES) {
  const got = classesOf(highlightC(src));
  ok(`${JSON.stringify(src)} → ${want.join(',')}`, got.join(',') === want.join(','), `实际 ${got.join(',') || '(无)'}`);
}

// 不能误伤：标识符里含关键字 / 数字
const NO_SPAN = ['myVar', 'iffy', 'integer', 'x1', 'a_b_c', '_tmp', 'printf2'];
for (const src of NO_SPAN) {
  ok(`${JSON.stringify(src)} 不着色（普通标识符少建节点）`, !highlightC(src).includes('<span'));
}
ok(
  'int32_t 不会被拆成 int + 32 + _t',
  highlightC('int32_t').includes('>int32_t<'),
  highlightC('int32_t')
);

// 注释 / 字符串的优先级：里面的引号不该被当成字符串
ok(
  '行注释里的 " 不算字符串',
  classesOf(highlightC('// 他说 "你好"')).join(',') === 'c-com',
  classesOf(highlightC('// 他说 "你好"')).join(',')
);
ok(
  '块注释里的 /* 不会再起一层',
  highlightC('/* a /* b */').includes('>/* a /* b */<'),
  highlightC('/* a /* b */')
);
ok('字符常量里的转义引号', classesOf(highlightC("'\\''")).join(',') === 'c-str');

// 未闭合的情况：仍然按「到行尾 / 到文件尾」着色，别把后面整块吞掉或吐出来
{
  // 未闭合字符串只吃到行尾，下一行的代码照常着色
  const html = highlightC('char *s = "abc\nint x;');
  const cls = classesOf(html);
  ok('未闭合字符串 → 到行尾仍是字符串色', cls.join(',') === 'c-typ,c-str,c-typ', cls.join(','));
  const strTok = /<span class="c-str">([\s\S]*?)<\/span>/.exec(html)[1];
  ok('  字符串 token 不含换行（没把下一行吞进来）', strTok === '"abc', JSON.stringify(strTok));
}
{
  // 未闭合块注释一直吃到文件末尾，后面的代码都在注释里
  const html = highlightC('int a;\n/* 没关\nint b;');
  const cls = classesOf(html);
  ok('未闭合块注释 → 一直吃到文件末尾', cls.join(',') === 'c-typ,c-com', cls.join(','));
  const comTok = /<span class="c-com">([\s\S]*?)<\/span>/.exec(html)[1];
  ok('  注释 token 把后面的 int b; 也包住了', comTok.includes('int b;'), JSON.stringify(comTok));
}
ok('未闭合块注释只产生一个 token', classesOf(highlightC('/* x\ny\nz')).length === 1);

// 多行 / CRLF
{
  const html = highlightC('/* a\nb\nc */ int x;');
  const cls = classesOf(html);
  ok('块注释跨行仍是同一个 token', cls.join(',') === 'c-com,c-typ', cls.join(','));
  const comTok = /<span class="c-com">([\s\S]*?)<\/span>/.exec(html)[1];
  ok('  该 token 里含换行（确实是跨行的那一整块）', comTok.includes('\n'), JSON.stringify(comTok));
}
{
  const html = highlightC('int a;\r\nint b;\r\n');
  ok('CRLF 输入不丢字符（往返无损）', plain(html) === 'int a;\r\nint b;\r\n');
  ok('CRLF 下两行都识别为类型', classesOf(html).filter((c) => c === 'c-typ').length === 2);
}

// ---------------------------------------------------------------------------
console.log('\n===== 3. 行号 =====');

ok('空串 → 0 行', countLines('') === 0);
ok('单行无换行 → 1 行', countLines('int a;') === 1);
ok('两行 → 2 行', countLines('int a;\nint b;') === 2);
ok('末尾换行 → 多一个空行（和 textarea 一致）', countLines('int a;\n') === 2);
ok('纯换行 → 2 行', countLines('\n') === 2);
ok('lineNumbersText(3)', lineNumbersText(3) === '1\n2\n3\n');
ok('lineNumbersText(0) → 空', lineNumbersText(0) === '');
ok('行号行数 = 换行数 + 1', lineNumbersText(countLines('a\nb\nc')).split('\n').filter(Boolean).length === 3);

// ---------------------------------------------------------------------------
console.log('\n===== 4. 超长文件降级 =====');

{
  const long = 'int x;\n'.repeat(Math.ceil(MAX_HIGHLIGHT_CHARS / 7) + 10);
  const html = highlightC(long);
  ok(`超过 ${MAX_HIGHLIGHT_CHARS} 字符 → 不着色`, !html.includes('<span'));
  ok('  但仍然逐字保留（只是转义了）', plain(html) === long);
  const just = 'int x;\n'.repeat(Math.floor(MAX_HIGHLIGHT_CHARS / 7) - 10);
  ok('  刚好在阈值内 → 正常着色', highlightC(just).includes('<span class="c-typ">'));
}

// ---------------------------------------------------------------------------
console.log('\n===== 5. 真实源码（模板里的 helloworld.c）=====');

{
  const file = path.join(ROOT, 'mrp_demo', 'helloworld.c');
  if (fs.existsSync(file)) {
    const src = fs.readFileSync(file, 'utf8');
    const html = highlightC(src);
    ok('往返无损（整份文件一字不差）', plain(html) === src);
    const cls = new Set(classesOf(html));
    ok('识别出注释', cls.has('c-com'));
    ok('识别出预处理指令', cls.has('c-pre'));
    ok('识别出关键字与类型', cls.has('c-kw') && cls.has('c-typ'));
    ok('识别出字符串', cls.has('c-str'));
    ok('生成的类名都是已知类型', [...cls].every((c) => Object.values(TOKEN_CLASS).includes(c)), [...cls].join(' '));
    const t0 = Date.now();
    highlightC(src);
    const ms = Date.now() - t0;
    ok('重复着色耗时合理（< 1000ms，抓的是量级退化）', ms < 1000, `${ms}ms / ${src.length} 字符`);
  } else {
    console.log('  · 跳过（没有 mrp_demo/helloworld.c）');
  }
}

// ---------------------------------------------------------------------------
console.log('\n===== 6. 与 style.css 的契约 =====');

const css = read('assets/style.css');
const noComment = css.replace(/\/\*[\s\S]*?\*\//g, '');
const allClasses = Object.values(TOKEN_CLASS);

for (const cls of allClasses) {
  const rule = new RegExp(`\\.${cls}\\s*\\{([^}]*)\\}`).exec(noComment);
  ok(`.${cls} 有样式规则`, !!rule);
  if (!rule) continue;
  const body = rule[1].replace(/\s+/g, ' ').trim();
  // 只看颜色：加粗 / 斜体 / 换字体都会破坏与 textarea 的字形对齐
  ok(`  ${cls} 只改颜色（无 font-weight / font-style / font-family）`,
    !/font-(weight|style|family)/.test(body), body);
  const m = /color:\s*var\((--code-[a-z]+)\)/.exec(body);
  ok(`  ${cls} 的颜色走变量`, !!m, body);
}
ok('每个 token 类各用各的变量（没有两个类共用同一色）',
  new Set(allClasses.map((c) => (new RegExp(`\\.${c}\\s*\\{([^}]*)\\}`).exec(noComment) || [])[1] || c)).size === allClasses.length);

// 两套调色板都要有成对的 --code-*
// 注意必须用 noComment：style.css 的**头部注释**里就写着 `:root` 和 `:root[data-theme="dark"]`，
// 用原文 indexOf 会两次都跳到同一个 `{` —— 「两套成对」就退化成「浅色和自己比」，永远通过。
const block = (sel) => {
  const i = noComment.indexOf(sel);
  if (i < 0) return '';
  const s = noComment.indexOf('{', i);
  const e = noComment.indexOf('}', s);
  if (s < 0 || e < 0) return '';
  return noComment.slice(s + 1, e);
};
const varsOf = (body) => new Set([...body.matchAll(/(--[a-z-]+)\s*:/g)].map((m) => m[1]));
const LIGHT_BODY = block(':root');
const DARK_BODY = block(':root[data-theme="dark"]');
ok('取到了浅色调色板块', /\n|color-scheme|--bg:/.test(LIGHT_BODY) && LIGHT_BODY.length > 200);
ok('取到了深色调色板块', DARK_BODY.length > 200);
ok('两块是不同内容（防上面那个「都跳到同一个 {」的坑）', LIGHT_BODY !== DARK_BODY);
const light = varsOf(LIGHT_BODY);
const dark = varsOf(DARK_BODY);
const codeVars = [...light].filter((v) => v.startsWith('--code-'));
ok('浅色里有 7 个 --code-* 变量', codeVars.length === 7, codeVars.join(' '));
ok('深色里同样成对定义', codeVars.every((v) => dark.has(v)),
  codeVars.filter((v) => !dark.has(v)).join(' ') || '全部成对');

// style.css 里用到的每个 --code-* 都必须有定义
const used = new Set([...noComment.matchAll(/var\((--code-[a-z]+)\)/g)].map((m) => m[1]));
ok('用到的 --code-* 都有定义', [...used].every((v) => light.has(v)),
  [...used].filter((v) => !light.has(v)).join(' ') || '全部有定义');

// 选区配色也得两套成对（少一份 → 那一侧要么看不见选区，要么盖住文字）
const selVars = ['--sel-bg', '--sel-bg-solid', '--sel-fg'];
ok('选区三个变量两套调色板都定义了', selVars.every((v) => light.has(v) && dark.has(v)),
  selVars.filter((v) => !light.has(v) || !dark.has(v)).join(' ') || '全部成对');

/*
 * 这条是本功能踩过的真实 bug：选区背景要盖在**着色层**上（textarea 在上面、文字透明），
 * 用不透明色 → 整段代码被盖成一片纯色块，看着像「一选中就变空白、字没了」。
 * 所以两份 --sel-bg 都必须是 rgba（alpha 严格在 0~1 之间）。
 */
for (const [theme, body] of [['浅色', block(':root')], ['深色', block(':root[data-theme="dark"]')]]) {
  const m = /--sel-bg:\s*rgba\(\s*[0-9.]+\s*,\s*[0-9.]+\s*,\s*[0-9.]+\s*,\s*([0-9.]+)\s*\)/.exec(body);
  const a = m ? Number(m[1]) : NaN;
  ok(`${theme}的 --sel-bg 是半透明（0 < alpha < 1）`, a > 0 && a < 1, m ? m[0] : '不是 rgba(…) 或找不到');
  ok(`${theme}的 --sel-bg-solid 是不透明色（供没着色层的两态用）`,
    /--sel-bg-solid:\s*#[0-9a-f]{6}/i.test(body));
}

// ---------------------------------------------------------------------------
console.log('\n===== 7. 滚动镜像（纯函数）=====');

{
  const { scrollMirror } = await import(pathToFileURL(path.join(ROOT, 'assets', 'codeview.js')).href);
  ok('原点 → 两个图层都不动', scrollMirror(0, 0).hl === 'translate(0px, 0px)' && scrollMirror(0, 0).lines === 'translateY(0px)');
  ok('向右下滚 → 反向平移', scrollMirror(30, 40).hl === 'translate(-30px, -40px)', scrollMirror(30, 40).hl);
  ok('行号槽只跟竖向', scrollMirror(30, 40).lines === 'translateY(-40px)', scrollMirror(30, 40).lines);
  ok('横向滚动不影响行号槽（行号要钉住）', scrollMirror(120, 0).lines === 'translateY(0px)');
  ok('只竖滚时着色层也不横移', scrollMirror(0, 25).hl === 'translate(0px, -25px)', scrollMirror(0, 25).hl);
}

// ---------------------------------------------------------------------------
console.log('\n===== 8. 接线（index.html / app.js / css 三方的约定）=====');

{
  const html = read('index.html');
  const app = read('assets/app.js');
  const rules = [...noComment.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1], m[2]]);
  const findRule = (needles) => rules.find(([sel]) => needles.every((n) => sel.includes(n)));

  for (const id of ['editorWrap', 'editorHl', 'editorLines', 'editor', 'editorHint']) {
    ok(`index.html 有 #${id}`, new RegExp(`id="${id}"`).test(html));
  }
  for (const cls of ['editor-main', 'editor-gutter', 'editor-code', 'editor-hl']) {
    ok(`index.html 有 .${cls}`, new RegExp(`class="[^"]*\\b${cls}\\b`).test(html));
  }
  ok('着色层与行号槽都标了 aria-hidden（正文仍在 textarea 里，读屏只念一遍）',
    (html.match(/aria-hidden="true"/g) || []).length >= 2);

  const fontRule = findRule(['#editor,', '.editor-hl', '#editorLines']);
  ok('字体 / 行高 / tab 宽写在同一条规则里（三个元素，分开写迟早错位）',
    !!fontRule, fontRule ? fontRule[1].replace(/\s+/g, ' ').trim() : '没找到共用规则');
  if (fontRule) {
    const body = fontRule[1];
    ok('  该规则同时管字体、字号、行高、tab', /font-family/.test(body) && /font-size/.test(body) && /line-height/.test(body) && /tab-size/.test(body));
  }

  ok('#editor 默认文字透明 + 光标可见',
    /#editor\s*\{[^}]*color:\s*transparent/.test(noComment) && /#editor\s*\{[^}]*caret-color:\s*var\(--text\)/.test(noComment));
  ok('placeholder 单独上色（否则跟着一起透明、看不见）', /#editor::placeholder\s*\{[^}]*color:/.test(noComment));

  // 选区（曾经的 bug：不透明底色盖住着色层 → 一选中就变空白）
  const selRule = (noComment.match(/#editor::selection\s*\{([^}]*)\}/) || [])[1] || '';
  ok('#editor::selection 用半透明底色（不透明色会把下面的彩色文字整片盖住）',
    /background:\s*var\(--sel-bg\)/.test(selRule), selRule.replace(/\s+/g, ' ').trim() || '没找到规则');
  ok('  选区里的文字仍保持 transparent（两层字形重叠会冒彩色描边）',
    /color:\s*transparent/.test(selRule));
  ok('.no-hl / .ime 下的选区反过来：不透明底 + 显式文字色（否则"选中即空白"）',
    /\.editor-wrap\.no-hl\s+#editor::selection[\s\S]{0,140}background:\s*var\(--sel-bg-solid\)[\s\S]{0,120}color:\s*var\(--sel-fg\)/.test(noComment));
  ok('着色层不吃鼠标事件', /\.editor-hl\s*\{[^}]*pointer-events:\s*none/.test(noComment));
  ok('着色层绝对定位、贴着左上角（靠 transform 跟随滚动）',
    /\.editor-hl\s*\{[^}]*position:\s*absolute/.test(noComment) && /\.editor-hl\s*\{[^}]*top:\s*0/.test(noComment));

  // 这两个逃生口是本功能最容易漏的地方：漏了就是「编辑器里一个字都看不见」
  ok('超长不着色时把 textarea 文字点亮（.no-hl）',
    /\.editor-wrap\.no-hl\s+#editor\s*\{[^}]*color:\s*var\(--text\)/.test(noComment));
  ok('  同时把着色层撤掉', /\.editor-wrap\.no-hl\s+\.editor-hl\s*\{[^}]*display:\s*none/.test(noComment));
  ok('输入法组字时把 textarea 文字点亮（.ime）',
    /\.editor-wrap\.ime\s+#editor\s*\{[^}]*color:\s*var\(--text\)/.test(noComment));
  ok('  同时藏起着色层（否则两层文字会重叠）',
    /\.editor-wrap\.ime\s+\.editor-hl\s*\{[^}]*visibility:\s*hidden/.test(noComment));

  ok('app.js 引入了着色模块', /from '\.\/codeview\.js'/.test(app));
  ok('app.js 初始化时画一次', /renderEditor\(\);\s*\/\/ 行号槽/.test(app));
  ok('输入时防抖重画', /addEventListener\('input',[\s\S]{0,240}scheduleEditorRender\(\)/.test(app));
  ok('滚动用 rAF 合并后镜像', /addEventListener\('scroll',\s*onEditorScroll,\s*\{\s*passive:\s*true\s*\}/.test(app));
  ok('组字开始 / 结束都处理了', /compositionstart/.test(app) && /compositionend/.test(app));
  ok('换文件时把视图归零（否则带着上一个文件的滚动位置）',
    /function setEditorText[\s\S]{0,400}scrollTop = 0/.test(app));
  ok('清空编辑器也走统一入口 clearEditor()', /function clearEditor[\s\S]{0,200}renderEditor\(\)/.test(app));

  /* ---------- 网页内全屏（.maxed）---------- */

  const hintBar = (noComment.match(/\.editor-hint\s*\{([^}]*)\}/) || [])[1] || '';
  ok('.editor-hint 是 flex 行（左边状态、右边按钮）', /display:\s*flex/.test(hintBar) && /justify-content:\s*space-between/.test(hintBar));
  ok('  hint 里的文本自己省略号截断（长文件名不能把按钮挤出去）',
    /\.editor-hint\s*>\s*span\s*\{[^}]*text-overflow:\s*ellipsis/.test(noComment));

  // 关键不变式：#editorHint 必须是 hint 条里的那个 <span>。
  // 若有人把它改回整个 hint 条，app.js 的 textContent 会把「全屏」按钮整块冲掉。
  const hintEl = /<div class="editor-hint">[\s\S]{0,600}?<span id="editorHint">/.test(html);
  ok('#editorHint 是 hint 条里的 <span>（不是整条，否则 textContent 会冲掉按钮）', hintEl);
  ok('  按钮与它在同一条里（sibling）',
    /<span id="editorHint">[\s\S]{0,300}?<button id="btnEditorMax"/.test(html));
  ok('按钮带 aria-pressed（切换态可读）', /id="btnEditorMax"[^>]*aria-pressed=/.test(html));

  const maxed = (noComment.match(/\.editor-wrap\.maxed\s*\{([^}]*)\}/) || [])[1] || '';
  ok('.editor-wrap.maxed 铺满视口（position:fixed + inset:0）',
    /position:\s*fixed/.test(maxed) && /inset:\s*0/.test(maxed), maxed.replace(/\s+/g, ' ').trim() || '没找到规则');
  ok('全屏时去掉边框圆角（否则四角露缝）',
    /border:\s*0/.test(maxed) && /border-radius:\s*0/.test(maxed));
  // 层级：全屏必须**低于**弹窗，否则打包弹窗会被编辑器盖住、按钮点不到
  const zOf = (sel) => {
    const m = new RegExp(`\\${sel}\\s*\\{([^}]*)\\}`).exec(noComment);
    const z = m && /z-index:\s*(\d+)/.exec(m[1]);
    return z ? Number(z[1]) : null;
  };
  const zMax = /z-index:\s*(\d+)/.exec(maxed)?.[1];
  const zOverlay = zOf('.overlay');
  ok('  z-index 低于 .overlay（弹窗要能盖在全屏编辑器上）',
    zMax != null && zOverlay != null && Number(zMax) < zOverlay, `maxed=${zMax} overlay=${zOverlay}`);
  ok('全屏时锁住背后页面滚动（body.editor-maxed）',
    /body\.editor-maxed\s*\{[^}]*overflow:\s*hidden/.test(noComment));

  ok('app.js 有 setEditorMaxed()，切的就是 .maxed 这个 class',
    /function setEditorMaxed[\s\S]{0,400}classList\.toggle\('maxed'/.test(app));
  ok('  按钮点击是「反着切」，不是只开不关',
    /btnEditorMax\.addEventListener\('click'[\s\S]{0,120}!el\.editorWrap\.classList\.contains\('maxed'\)/.test(app));
  ok('  Esc 也能退出（且排在两个弹窗之后 —— 弹窗开着时先关弹窗）',
    /Escape[\s\S]{0,400}packOverlay[\s\S]{0,260}helpOverlay[\s\S]{0,260}maxed[\s\S]{0,80}setEditorMaxed\(false\)/.test(app));
}

// ---------------------------------------------------------------------------
console.log(`\n${failed ? `${failed} 项失败` : '全部通过'}`);
process.exitCode = failed ? 1 : 0;
