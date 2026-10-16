/**
 * 单测 assets/selectall.js —— `Ctrl/Cmd + A` 该全选谁（纯逻辑）+ app.js 的接线检查。
 *
 * 这段逻辑错了的后果都是「操作手感莫名其妙」那种：
 *   · 焦点在编译输出区时按 Ctrl+A → 默认会全选**整个网页**（把顶栏、文件列表全带上）；
 *   · 打包弹窗开着、光标落在输入框外按 Ctrl+A → 又去全选背后的页面；
 *   · 焦点明明在输入框里（打包弹窗那个）却把整页选中。
 * 所以决策抽成纯函数逐条钉住，DOM 那半（读 activeElement / 落地选区）留在 app.js，
 * 用「接线断言」保证它真的调了这里、且分支没写反。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { planSelectAll, isEditableTarget } = await import(
  pathToFileURL(path.join(ROOT, 'assets', 'selectall.js')).href
);
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

let failed = 0;
function ok(name, pass, detail = '') {
  if (!pass) failed++;
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
}

// ---------------------------------------------------------------------------
console.log('\n1. isEditableTarget —— 哪些焦点元素算「可编辑文本」（Ctrl+A 交给浏览器原生）');
for (const [target, expected, label] of [
  [{ tagName: 'TEXTAREA' }, true, '源码编辑窗 textarea'],
  [{ tagName: 'INPUT', type: 'text' }, true, '文本框'],
  [{ tagName: 'INPUT' }, true, 'input 不写 type（浏览器按 text）'],
  [{ tagName: 'INPUT', type: 'number' }, true, '数字框（打包弹窗 appid 等）'],
  [{ tagName: 'INPUT', type: 'password' }, true, '密码框'],
  [{ tagName: 'INPUT', type: 'search' }, true, '搜索框'],
  [{ tagName: 'INPUT', type: 'checkbox' }, false, '复选框'],
  [{ tagName: 'INPUT', type: 'radio' }, false, '单选框'],
  [{ tagName: 'INPUT', type: 'file' }, false, '文件选择框'],
  [{ tagName: 'INPUT', type: 'range' }, false, '滑块'],
  [{ tagName: 'INPUT', type: 'submit' }, false, '提交按钮'],
  [{ isContentEditable: true, tagName: 'DIV' }, true, 'contenteditable'],
  [{ tagName: 'PRE' }, false, '编译输出区 <pre>（不是表单元素）'],
  [{ tagName: 'BUTTON' }, false, '按钮'],
  [{ tagName: 'DIV' }, false, '普通 div'],
  [{ tagName: 'BODY' }, false, 'body'],
  [null, false, '无焦点（null）'],
  [undefined, false, 'undefined'],
]) {
  ok(`  ${label} → ${expected}`, isEditableTarget(target) === expected);
}
ok('  type 大小写不敏感（INPUT type=TEXT）', isEditableTarget({ tagName: 'INPUT', type: 'TEXT' }) === true);

// ---------------------------------------------------------------------------
console.log('\n2. planSelectAll —— 三个分支（native 放行 / block 无行为 / console 全选日志）');
for (const [target, overlayOpen, expected, label] of [
  [{ tagName: 'TEXTAREA' }, false, 'native', '编辑窗、无弹窗 → 原生（全选编辑窗文本）'],
  [{ tagName: 'TEXTAREA' }, true, 'native', '编辑窗 + 有弹窗（焦点明确在编辑窗）→ 仍原生'],
  [{ tagName: 'INPUT', type: 'text' }, true, 'native', '打包弹窗输入框 → 原生（全选输入框文本）'],
  [{ tagName: 'INPUT', type: 'number' }, true, 'native', '打包弹窗数字框 → 原生'],
  [{ tagName: 'BUTTON' }, true, 'block', '弹窗打开、焦点在按钮 → 无行为'],
  [{ tagName: 'PRE' }, true, 'block', '弹窗打开、焦点在日志区 → 无行为'],
  [{ tagName: 'DIV' }, true, 'block', '弹窗打开、焦点在普通元素 → 无行为'],
  [null, true, 'block', '弹窗打开、无焦点 → 无行为'],
  [{ tagName: 'PRE' }, false, 'console', '焦点在日志区、无弹窗 → 全选日志'],
  [{ tagName: 'DIV' }, false, 'console', '焦点在别处、无弹窗 → 全选日志'],
  [{ tagName: 'BODY' }, false, 'console', '焦点在 body、无弹窗 → 全选日志'],
  [null, false, 'console', '无焦点、无弹窗 → 全选日志'],
  [undefined, false, 'console', 'undefined、无弹窗 → 全选日志'],
]) {
  const got = planSelectAll(target, overlayOpen);
  ok(`  ${label}`, got === expected, got === expected ? '' : `得到 ${got}`);
}

// ---------------------------------------------------------------------------
console.log('\n3. app.js 接线');
const app = read('assets/app.js');
const appCode = stripComments(app);
const html = read('index.html');

ok(
  '引入 selectall.js 的 planSelectAll（而不是自己就地判断）',
  /import\s*\{\s*planSelectAll\s*\}\s*from\s*'\.\/selectall\.js'/.test(appCode)
);
ok(
  '挂了 window 级 keydown 监听、且调用了 planSelectAll',
  /addEventListener\(\s*'keydown'[\s\S]{0,600}?planSelectAll\(/.test(appCode)
);
ok(
  '只在 Ctrl/Cmd + A 时触发（排除 alt / shift，别踩 Ctrl+Shift+A 之类）',
  /ctrlKey\s*\|\|\s*e\.metaKey[\s\S]{0,60}?altKey[\s\S]{0,60}?shiftKey/.test(appCode) &&
    /String\(e\.key\)\.toLowerCase\(\)\s*!==\s*'a'/.test(appCode)
);
ok('用 `.overlay.show` 判断弹窗是否打开', /querySelector\(\s*'\.overlay\.show'\s*\)/.test(appCode));
ok(
  'native 分支直接放行（不 preventDefault）',
  /plan\s*===\s*'native'[\s\S]{0,20}?return/.test(appCode)
);
ok(
  "'console' 分支才去全选编译输出区",
  /plan\s*===\s*'console'[\s\S]{0,40}?selectNodeText\(\s*el\.console\s*\)/.test(appCode)
);
ok(
  'selectNodeText 用 Range 选中元素内容（<pre> 没有 .select()）',
  /function selectNodeText[\s\S]{0,400}?createRange\(\)[\s\S]{0,160}?selectNodeContents\(/.test(appCode)
);
ok(
  '不靠 execCommand(selectAll) 去全选整页（要的是只选日志区）',
  !/execCommand\(\s*'selectAll'/.test(appCode)
);
ok(
  '#console 带 tabindex，点它之后焦点落在日志区（Ctrl+A 也走 console 分支）',
  /id="console"[\s\S]{0,200}?tabindex="0"/.test(html)
);

// ---------------------------------------------------------------------------
console.log(`\n${failed ? `${failed} 项失败` : '全部通过'}`);
process.exitCode = failed ? 1 : 0;
