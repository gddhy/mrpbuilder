/**
 * 工程文件那一块（列表带大小 / 重命名 / 删除 / 下载按钮）的接线检查。
 *
 * 这几件事的特点是：**错了不会当场报错，而是悄悄给错东西** ——
 *   · 大小取错单位或取到 0 → 界面看着正常，数字是假的；
 *   · 重命名只改前端不改虚拟机 → 编译的还是旧名字，或干脆少了文件；
 *   · 删掉文件但没清 overrides → 下一次「下载当前项目/编译」又把它带回来；
 *   · 「下载demo」在改过之后还写 mrp_demo.zip → 用户以为拿到的是原始模板。
 * 所以这里把关键接线钉住（真机行为由 `node tools/test-v86.mjs` 端到端验）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failed = 0;
function ok(name, pass, detail = '') {
  if (!pass) failed++;
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
}

const vm = read('assets/vm.js');
const app = read('assets/app.js');
const css = read('assets/style.css');
const html = read('index.html');
const noCommentCss = css.replace(/\/\*[\s\S]*?\*\//g, '');
// 「不许出现 X」这类断言必须看**剥掉注释**的代码 —— 注释里往往会写
// 「早期版本用了 stat / base64 -d，为什么不用」这种说明，不剥就会误判
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const vmCode = stripComments(vm);
const appCode = stripComments(app);

// ---------------------------------------------------------------------------
console.log('===== 1. 列目录：取名字 + 大小（真机上验证过的命令）=====');

ok('用 `du -b` + `-exec … +`（一次 fork 拿全部）', /-exec du -b \{\} \+/.test(vmCode));
ok('不用 stat（guest 里 `stat: applet not found`）', !/stat -c/.test(vmCode));
ok('不用 find -printf（这版 busybox 没编）', !/-printf/.test(vmCode));
ok('注释里写清为什么（免得后人又改回 stat / -printf）',
  /applet not found/.test(vm) && /printf/.test(vm));
ok('解析「<字节数>\\t<路径>」：按第一个制表符切',
  /row\.indexOf\('\\t'\)/.test(vm) && /Number\(row\.slice\(0, tab\)\)/.test(vm));
ok('剥掉路径前面的 ./', /startsWith\('\.\/'\)/.test(vm));
ok('按名字排序放在前端做（不依赖 guest 的 sort）', /files\.sort\(\(x, y\)/.test(vm));
ok('名字按 UTF-8 解回来（中文文件名不变成乱码）', /decodeSerial\(row\.slice/.test(vm));

// ---------------------------------------------------------------------------
console.log('\n===== 2. 串口：命令走字节级发送 =====');

ok('有统一的 _send（按 UTF-8 编字节再发）', /_send\(text\)\s*\{[\s\S]{0,120}serialBytes\(text\)/.test(vm));
ok('没有绕过 _send 直接用 serial0_send 的地方',
  (vmCode.match(/serial0_send\(/g) || []).length === 1, `serial0_send 出现 ${(vmCode.match(/serial0_send\(/g) || []).length} 次`);
ok('build() 里的 base64 绕法已删掉（直接拼带引号的路径）',
  !/base64 -d|btoa\(/.test(vmCode) && /shProjectPath\(PROJ, name\)/.test(vmCode));

// ---------------------------------------------------------------------------
console.log('\n===== 3. 重命名 / 删除 =====');

ok('vm 有 renameProjectFile（mv）', /async renameProjectFile\(from, to\)[\s\S]{0,300}mv -f/.test(vm));
ok('vm 有 deleteProjectFile（rm + test ! -e 复核）',
  /async deleteProjectFile[\s\S]{0,300}rm -f[\s\S]{0,120}test ! -e/.test(vm));
ok('两条都走 shProjectPath（引号 + 中文都安全）',
  /renameProjectFile[\s\S]{0,300}shProjectPath/.test(vm) &&
    /deleteProjectFile[\s\S]{0,300}shProjectPath/.test(vm));

ok('app 端改名只允许改名字部分（目录不动）', /const renameTarget = \(from, base\)[\s\S]{0,200}lastIndexOf\('\/'\)/.test(appCode));
ok('改名先过白名单校验', /renameNameError[\s\S]{0,400}isSafeRelPath/.test(app));
ok('  重名 / 空名 / 带斜杠都会被拦下',
  /已经存在/.test(app) && /不能是空的/.test(app) && /不能带 \//.test(app));
ok('删除要二次确认（不是一点就删）', /function armDelete[\s\S]{0,900}再点一次删除/.test(app));
ok('  确认窗口会自动收回（用常量，别写死魔法数）',
  /DELETE_CONFIRM_MS = \d+/.test(app) && /DELETE_CONFIRM_MS\)/.test(app));

// 状态同步：一份数据在虚拟机里，前端这几份记录必须跟着搬
for (const [what, re] of [
  ['overrides（内容）', /state\.overrides\.delete\(from\)[\s\S]{0,120}state\.overrides\.set\(to, bytes\)/],
  ['fromGuest（只是读过）', /state\.fromGuest\.delete\(from\)[\s\S]{0,60}add\(to\)/],
  ['uploaded（用户传的）', /state\.uploaded\.delete\(from\)[\s\S]{0,60}add\(to\)/],
  ['packRes（打包勾选）', /state\.packRes\.delete\(from\)[\s\S]{0,60}add\(to\)/],
  ['sizes（大小）', /state\.sizes\.delete\(from\)[\s\S]{0,140}state\.sizes\.set\(to, size\)/],
]) {
  ok(`改名时同步搬运 ${what}`, re.test(app));
}
ok('删掉的是当前打开的文件 → 编辑器一起清空', /state\.selected === name[\s\S]{0,200}clearEditor\(\)/.test(app));
ok('删掉/改名的是入口源文件 → 跟着改（否则编译直接找不到入口）',
  /el\.optApp\.value\.trim\(\) === from/.test(app) && /el\.optApp\.value\.trim\(\) === name/.test(app));
ok('  删掉入口后先刷新清单再挑替补（别挑到刚删那个）',
  /await refreshProjectIndex\(\); \/\/ 先刷新清单，再挑替代的入口[\s\S]{0,200}fallbackEntry\(\)/.test(app));
ok('操作完重新问虚拟机要清单（前端不猜）',
  (app.match(/await refreshProjectIndex\(\)/g) || []).length >= 3,
  `${(app.match(/await refreshProjectIndex\(\)/g) || []).length} 处`);

// ---------------------------------------------------------------------------
console.log('\n===== 4. 文件大小显示 =====');

ok('清单接口同时喂 sizes 与 template',
  /refreshProjectIndex[\s\S]{0,400}state\.sizes = new Map\(list\.map/.test(app));
ok('大小优先用 overrides 里那份字节（那才是编译时写进去的）',
  /function fileSizeOf[\s\S]{0,300}state\.overrides\.get\(name\)[\s\S]{0,80}bytes\.length/.test(app));
ok('用共用的 fmtBytes（KB/MB 这种可读单位，不自己再写一套）',
  /fmtBytes\(bytes\)/.test(appCode) && !/toFixed\(1\)\s*\+\s*['"] ?(KB|MB)/.test(appCode));
ok('拿不到大小显示「—」而不是 0 KB', /bytes == null \? '—'/.test(app));

// ---------------------------------------------------------------------------
console.log('\n===== 5. 下载按钮：文案 / 可用状态 / 包名 =====');

ok('按钮文案二选一：未改动 = 下载demo，改过 = 下载当前项目',
  /textContent = pristine \? '下载demo' : '下载当前项目'/.test(app));
ok('只有编译环境就绪后才可点（未启动 = 不可点击）', /disabled = state\.busy \|\| !ready/.test(app));
ok('“改过”的判定包含文件集（重命名 / 删除在前端不留内容痕迹）',
  /isTemplatePristine[\s\S]{0,600}state\.pristineNames/.test(app));
ok('启动时记下模板快照', /state\.pristineNames = \[\.\.\.state\.template\]/.test(app));
ok('恢复模板之后快照重新对齐', /resetProject\(\)[\s\S]{0,900}state\.pristineNames = \[\.\.\.state\.template\]/.test(app));
ok('两种包名分开（下载 demo 时就是 mrp_demo.zip）',
  /zipName = pristine \? 'mrp_demo\.zip' : 'mrp_project\.zip'/.test(app));
ok('打包内容 = 当前工程文件集（allFiles）', /const names = allFiles\(\)/.test(app));
ok('刚导入、虚拟机里还没有的文件用内存里那份字节（否则读取会失败）',
  /const cached = state\.overrides\.get\(n\);\s*\n\s*files\.push\(\{ name: n, data: cached \?\?/.test(app));

// ---------------------------------------------------------------------------
console.log('\n===== 6. 界面结构（index.html / style.css）=====');

const rules = new Map(
  [...noCommentCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [
    m[1].trim().replace(/\s+/g, ' '),
    m[2],
  ])
);
const rule = (sel) => rules.get(sel) || '';

ok('index.html 的按钮初值是 disabled + 「下载demo」',
  /id="btnDemo"[^>]*disabled/.test(html) && /button id="btnDemo"[\s\S]{0,80}下载demo/.test(html));
for (const [sel, why] of [
  ['.filelist .fname', '文件名占满 + 省略号'],
  ['.filelist .fsize', '大小'],
  ['.filelist .fbtn', '图标按钮'],
  ['.filelist .frename', '就地改名的输入框'],
]) {
  ok(`style.css 有 ${sel}（${why}）`, !!rule(sel));
}
ok('文件名能缩（min-width: 0）+ 省略号，否则长路径会把按钮挤出去',
  /min-width:\s*0/.test(rule('.filelist .fname')) && /text-overflow:\s*ellipsis/.test(rule('.filelist .fname')));
ok('图标按钮不撑高行（固定 18px）', /width:\s*18px/.test(rule('.filelist .fbtn')));
ok('删除确认态有样式（红）', /var\(--err\)/.test(rule('.filelist .fbtn.danger')));
ok('大小用等宽数字（一列看着齐）', /tabular-nums/.test(rule('.filelist .fsize')));
ok('就地改名的输入框聚焦态和其它输入框一路（墨色边 + 加粗）',
  /border-color:\s*var\(--text\)/.test(rule('.filelist .frename:focus')) &&
    /border-width:\s*1\.5px/.test(rule('.filelist .frename:focus')));

// ---------------------------------------------------------------------------
console.log('\n===== 7. 日志里的「文件状态」提示 =====');

ok('有统一的 [文件] 日志入口 logFile()',
  /function logFile\(name, kind, text\)[\s\S]{0,400}\[文件\]/.test(appCode));
ok('  去重键带上类别（否则每敲一下都会刷一行）',
  /const key = `\$\{name\}\\n\$\{kind\}`/.test(appCode));
ok('  「已修改」那条不带字节数（带了去重就失效、每敲一次刷一行）',
  /logFile\(name, 'edit', `已修改 \$\{name\} —— 编译时会写进虚拟机`\)/.test(appCode));
ok('打开文件时写「读取 xxx（大小，来自虚拟机）」',
  /logFile\(\s*name,\s*'open',[\s\S]{0,120}`读取 \$\{name\}（/.test(appCode) && /来自虚拟机里的工程/.test(appCode));
ok('  内存里那份也写清楚（已改过 / 与虚拟机一致）',
  /logFile\(\s*name,\s*'open',[\s\S]{0,240}与虚拟机里那份一致，未修改/.test(appCode));
ok('读取失败也写一行（不是只改编辑器底下那行小字）',
  /logFile\(name, 'open', `读取 \$\{name\} 失败/.test(appCode));
ok('编译时说明同步了哪些改动（源文件改没改一眼可见）',
  /\[文件\] 同步到虚拟机：\$\{changed\.length\} 个改动/.test(appCode) &&
    /\[文件\] 源码没有改动，直接编译/.test(appCode));
ok('恢复模板 / 重启时把这份日志记忆清掉', /fileLog\.clear\(\)/.test(appCode));

// ---------------------------------------------------------------------------
console.log('\n===== 8. 源码编码（UTF-8 / GBK）接线 =====');

ok('app 引入编码模块', /from '\.\/encoding\.js'/.test(appCode));
ok('打开文件时识别并记住编码', /detectEncoding\(bytes\)/.test(appCode) && /state\.fileEncoding\.set\(name, enc\)/.test(appCode));
ok('读取走 decodeSource（不再硬按 UTF-8 解，GBK 才不至于出 �）',
  /decodeSource\(bytes\)/.test(appCode) && !/new TextDecoder\(\)\.decode\(bytes\)/.test(appCode));
ok('保存按原编码编回（GBK 文件写回仍是 GBK，字符串字面量字节不变）',
  /encodeSource\(el\.editor\.value, enc\)/.test(appCode) && /fileEncoding\.get\(name\) \?\? ENC_UTF8/.test(appCode));
ok('重命名时把编码记录一起搬、删除时清掉', /state\.fileEncoding\.delete\(from\)/.test(appCode));
ok('恢复模板 / 重启时清空编码记录', /state\.fileEncoding\.clear\(\)/.test(appCode));

// ---------------------------------------------------------------------------
console.log(`\n${failed ? `${failed} 项失败` : '全部通过'}`);
process.exitCode = failed ? 1 : 0;
