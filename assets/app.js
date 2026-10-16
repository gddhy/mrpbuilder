/**
 * MRP 纯前端编译环境 —— 界面逻辑
 *
 * 编译本身由 assets/vm.js 里的 MrpVm 完成（浏览器 / Node 共用同一份实现）：
 * 在浏览器里跑一台 32 位 Linux（v86），通过 9p 把工具链和源码送进去，
 * 再把 bin.elf 取回来。全程不联网、不需要后端。
 */

import { MrpVm } from './vm.js';
import { unzip, zipDeflate } from './zip.js';
import { cacheEntryMatches, readImageCache, writeImageCache } from './imagecache.js';
import { fmtBytes, fmtDuration } from './bytes.js'; // 体积/耗时文案，与命令行共用同一份
import { isSafeRelPath } from './serial.js'; // 相对路径白名单（重命名 / 删除前挡一道）
import { wheelDeltas, planWheel } from './wheel.js'; // 滚轮决策（纯函数，单测覆盖）
import { planSelectAll } from './selectall.js'; // Ctrl+A 全选谁（纯函数，单测覆盖）
import { detectEncoding, decodeSource, encodeSource, ENC_UTF8, ENC_GBK } from './encoding.js'; // 源码编码识别（UTF-8 / GBK）
import {
  highlightC,
  countLines,
  lineNumbersText,
  scrollMirror,
  MAX_HIGHLIGHT_CHARS,
} from './codeview.js'; // C 源码着色 + 行号（纯函数，单测覆盖）
import {
  isJunkEntry,
  relativeNames,
  parseGitignore,
  applyGitignore,
} from './ingest.js'; // 导入外来文件的路径规则（纯函数，有单测）
import { initTheme, toggleTheme } from './theme.js'; // 浅色/深色主题（未手动选择时跟随浏览器）
import {
  packMrp,
  parseMrp,
  encodeGBKDetailed,
  prepareFiles,
  isResourceCandidate,
  isBinaryName,
  validatePackMeta,
  FLAG_DEFAULT,
} from './mrp-pack.js';

const ASSETS = new URL('./', import.meta.url);
const URLS = {
  wasm: new URL('v86/v86.wasm', ASSETS).href,
  seabios: new URL('v86/bios/seabios.bin', ASSETS).href,
  vgabios: new URL('v86/bios/vgabios.bin', ASSETS).href,
  kernel: new URL('image/vmlinuz.bin', ASSETS).href,
  rootfs: new URL('image/rootfs.tar.gz', ASSETS).href,
};

const $ = (id) => document.getElementById(id);
const el = {
  dot: $('statusDot'),
  status: $('statusText'),
  phase: $('phase'),
  btnBoot: $('btnBoot'),
  btnBuild: $('btnBuild'),
  btnDownload: $('btnDownload'),
  btnDemo: $('btnDemo'),
  btnReset: $('btnReset'),
  btnClear: $('btnClear'),
  btnCopyLog: $('btnCopyLog'),
  btnCopyErrors: $('btnCopyErrors'),
  btnPack: $('btnPack'),
  btnHelp: $('btnHelp'),
  btnHelpClose: $('btnHelpClose'),
  btnTheme: $('btnTheme'),
  helpOverlay: $('helpOverlay'),
  packOverlay: $('packOverlay'),
  packList: $('packList'),
  packNote: $('packNote'),
  btnPackCancel: $('btnPackCancel'),
  btnPackGo: $('btnPackGo'),
  pkDisplay: $('pkDisplay'),
  pkFileName: $('pkFileName'),
  pkAppid: $('pkAppid'),
  pkVersion: $('pkVersion'),
  pkVendor: $('pkVendor'),
  pkDesc: $('pkDesc'),
  pkAuth: $('pkAuth'),
  pkFlag: $('pkFlag'),
  pkSw: $('pkSw'),
  pkSh: $('pkSh'),
  pkDisplayHint: $('pkDisplayHint'),
  pkFileNameHint: $('pkFileNameHint'),
  pkVendorHint: $('pkVendorHint'),
  pkDescHint: $('pkDescHint'),
  fileInput: $('fileInput'),
  dirInput: $('dirInput'),
  fileList: $('fileList'),
  editor: $('editor'),
  editorWrap: $('editorWrap'),
  editorHl: $('editorHl'),
  editorLines: $('editorLines'),
  editorHint: $('editorHint'),
  btnEditorMax: $('btnEditorMax'),
  drop: $('drop'),
  console: $('console'),
  optApp: $('optApp'),
  optExtra: $('optExtra'),
};

const state = {
  vm: null,
  phase: 'off',        // off | boot | ready | err
  template: [],        // 镜像内置模板里的相对路径
  /**
   * 相对路径 -> 字节数（来自虚拟机的 `du -b` 列目录）。
   * 只作显示用；**改过 / 传过的文件以 overrides 里那份字节为准**（那才是编译时写进去的），
   * 见 fileSizeOf()。
   */
  sizes: new Map(),
  /**
   * 启动虚拟机时那份「没动过的」文件清单（排序后的名字）。
   *
   * 用来回答「工程还是内置模板吗」：重命名 / 删除 / 新增都不留内容痕迹（overrides 里
   * 看不出来），所以拿现在的文件集跟这份比一比 —— 比记住一个「改过了」的布尔值可靠，
   * 改回去（比如 A→B 又改回 A）也能自己变回"没动过"。
   */
  pristineNames: [],
  // 模板自带的 Makefile 字节：启动时从虚拟机读一份（镜像里那份），另加站点上那份。
  // 用途：判断「导进来的 Makefile 是不是模板自带的」——见 isTemplateMakefile。
  templateMakefiles: [],
  overrides: new Map(),// 相对路径 -> Uint8Array（用户上传/编辑过的）
  fromGuest: new Set(),// overrides 里那些「从模板原样读进来、没改过」的（编译时不重推）
  uploaded: new Set(), // 真正由用户上传/拖入的文件（用于挑「资源」）
  /**
   * 每个文件的编码：'utf-8' | 'gbk'。打开文件时识别（assets/encoding.js 的 detectEncoding），
   * 保存时按它**原样编回** —— 中文字符串字面量的字节不能变，否则编译进真机乱码。
   */
  fileEncoding: new Map(),
  shell: new Map(),    // 壳文件字节缓存（lib/start.mr、lib/cfunction.ext）
  packRes: new Set(),  // 打包时勾选的资源
  packResTouched: false,
  selected: null,
  /**
   * 编辑器里当前这份文本的基准：{ name, text }。
   * 判断「用户到底动没动」要看文本，不能只看重新编码后的字节 ——
   * textarea 的 value 会把 CRLF/CR 归一化成 LF（HTML 规范如此，已实测），
   * 而 src/ 下 30 个 .c/.h 都是 CRLF：重新编码会把这些文件改小，
   * 于是「只是点开看一眼」就变成了「改过源码」（引擎摘要变 → 白重建一次归档）。
   */
  editorBase: null,
  artifact: null,
  busy: false,
  enginePushed: false, // 引擎预编译归档是否已推进这台虚拟机（一次会话只推一次）
  engineRebuilt: false, // 本轮编译里 guest 是否重建了引擎归档（由日志识别，用于解释耗时）
  nothingToDo: false, // 本轮 make 是否认为「没有需要重编的」（产物是上一次那份）
  logBuf: [],
};

// ---------------------------------------------------------------------------
// 控制台
// ---------------------------------------------------------------------------

function stripAnsi(s) {
  return s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][A-Za-z0-9]/g, '')
    .replace(/\x1b[=>]/g, '');
}

let flushTimer = null;
function pushOutput(text) {
  // 从 guest 的编译输出里认一下「这轮重建了引擎归档」——
  // 只有改过 src/ 才会有，是解释「为什么这轮要 3 分钟」的关键信息
  if (/\[make\] precompiling engine runtime/.test(text)) state.engineRebuilt = true;
  // make 认为没有需要重编的（几秒内「编译完成」）：产物就是上一次那份，
  // 说清楚，免得看起来像「刚编出来」的
  if (/Nothing to be done for 'all'/.test(text)) state.nothingToDo = true;
  state.logBuf.push(text);
  if (!flushTimer) flushTimer = setTimeout(flush, 80);
}

/** 本轮编译耗时文案：分段之和就是总耗时，一眼看出时间花在哪 */
function fmtTiming(t) {
  if (!t) return '';
  const parts = [
    `同步源码 ${fmtDuration(t.syncMs)}`,
    `编译 ${fmtDuration(t.compileMs)}${state.engineRebuilt ? '（含重建引擎归档）' : ''}`,
    `取回产物 ${fmtDuration(t.artifactMs)}`,
  ];
  return `${fmtDuration(t.totalMs)}（${parts.join(' · ')}）`;
}

function writeLine(text) {
  state.logBuf.push(text + '\n');
  if (!flushTimer) flushTimer = setTimeout(flush, 80);
}

/**
 * 「文件状态」日志行：统一 `[文件]` 前缀，一眼能和编译输出区分开。
 *
 * **只在状态真的变了才写一次**（键 = 文件名 + 类别）：编辑器里每敲一下都会走
 * saveEditor，每次都写就把日志刷爆了。所以「已修改」那条**不带字节数** ——
 * 带了每次敲键文本都不一样，去重就失效了。
 * 恢复模板 / 重启虚拟机时整体清空（见 clearClientProject）。
 */
const fileLog = new Map();
function logFile(name, kind, text) {
  const key = `${name}\n${kind}`;
  if (fileLog.get(key) === text) return;
  fileLog.set(key, text);
  writeLine(`[文件] ${text}`);
}

function flush() {
  flushTimer = null;
  if (!state.logBuf.length) return;
  const raw = stripAnsi(state.logBuf.join('')).replace(/\r(?!\n)/g, '\n');
  state.logBuf.length = 0;
  const atBottom =
    el.console.scrollTop + el.console.clientHeight >= el.console.scrollHeight - 24;
  el.console.textContent += raw;
  if (atBottom) el.console.scrollTop = el.console.scrollHeight;
}

function clearConsole() {
  state.logBuf.length = 0;
  el.console.textContent = '';
}

// ---------------------------------------------------------------------------
// 复制日志
// ---------------------------------------------------------------------------

/** 报错行特征：ld 的未定义符号 / 编译错误 / 链接器与 make 的失败信息 */
const ERROR_PAT = new RegExp(
  [
    'undefined reference',
    'error:',
    'Error \\d',
    '\\bld:',
    'collect2:',
    'make(\\[\\d+\\])?: \\*\\*\\*',
    'No such file',
    'cannot (find|execute|open)',
    '\\bfatal error',
    '编译失败',
  ].join('|'),
  'i'
);

/** 从完整日志里抽出报错行，并带上紧邻的「in function ...」上下文行 */
function extractErrors(text) {
  const lines = text.split('\n');
  const keep = new Set();
  lines.forEach((ln, i) => {
    if (!ERROR_PAT.test(ln)) return;
    keep.add(i);
    // ld 的报错常是两行一组，另一行说明「在哪个函数里」
    for (const k of [i - 1, i + 1]) {
      if (k >= 0 && k < lines.length && /in function /.test(lines[k])) keep.add(k);
    }
  });
  return [...keep]
    .sort((a, b) => a - b)
    .map((i) => lines[i])
    .join('\n');
}

async function copyText(text) {
  if (!text) throw new Error('没有可复制的内容');
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // 非安全上下文（file:// 或局域网 http）拿不到 clipboard API，退回 execCommand
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:-1000px;left:0;opacity:0';
  document.body.append(ta);
  ta.select();
  ta.setSelectionRange(0, ta.value.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } finally {
    ta.remove();
  }
  if (!ok) throw new Error('浏览器拒绝了复制操作，请手动选中日志再按 Ctrl/Cmd+C');
}

async function copyWithFeedback(btn, text) {
  const label = btn.dataset.label || btn.textContent;
  btn.dataset.label = label;
  clearTimeout(btn._t);
  try {
    await copyText(text);
    btn.textContent = '已复制 ✓';
    btn.classList.add('ok');
  } catch (e) {
    btn.textContent = '复制失败';
    btn.classList.remove('ok');
    writeLine(`\n✗ ${e.message}`);
    return;
  }
  btn._t = setTimeout(() => {
    btn.textContent = label;
    btn.classList.remove('ok');
  }, 1400);
}

function setPhase(p, text) {
  state.phase = p;
  el.dot.dataset.state = p;
  el.status.textContent = text;
  refreshDemoButton();
}

function setBusy(on) {
  state.busy = on;
  el.btnBuild.disabled = on || state.phase !== 'ready';
  el.btnBoot.disabled = on || state.phase === 'boot' || state.phase === 'ready';
  refreshDemoButton();
}

/**
 * 现在还是「没被动过的内置模板」吗？
 * 直接决定「下载demo」能不能点：那个按钮是从虚拟机里现取模板打包的，
 * 一旦用户改过（编辑过内容、或传了自己的文件），取出来的就不是内置模板了，
 * 下载下来只会误导人 —— 所以宁可不给点。
 *
 * 判定看两处：
 *   · `state.uploaded` 非空 → 用户传过文件（拖入/选择/解压 zip）→ 算改过；
 *   · `state.overrides` 里存在不在 `fromGuest` 里的条目 → 有真实编辑 →
 *     算改过（`fromGuest` 是「从模板读进编辑器看一眼、没动过」的那些，
 *     它们和虚拟机里那份逐字节相同，不影响打包结果）。
 */
function isTemplatePristine() {
  if (state.uploaded.size) return false;
  for (const n of state.overrides.keys()) if (!state.fromGuest.has(n)) return false;
  // 文件集也一样（重命名 / 删除 / 新增都不留内容痕迹）
  const now = allFiles();
  if (now.length !== state.pristineNames.length) return false;
  for (let i = 0; i < now.length; i++) if (now[i] !== state.pristineNames[i]) return false;
  return true;
}

/**
 * 「下载demo / 下载当前项目」按钮的文案与可用状态。
 *
 * 只有编译环境就绪后能点（打包要去虚拟机里逐个取文件）；就绪之后**一直可点** ——
 * 改过了也一样能下载，只是下的是"当前工程"，文案跟着变，不让人误以为拿到的是原始模板。
 */
function refreshDemoButton() {
  if (!el.btnDemo) return;
  const ready = state.phase === 'ready';
  const pristine = isTemplatePristine();
  el.btnDemo.disabled = state.busy || !ready;
  el.btnDemo.textContent = pristine ? '下载demo' : '下载当前项目';
  el.btnDemo.title = !ready
    ? '先点「启动编译环境」——工程包是现从虚拟机里取文件打包的'
    : pristine
      ? '把内置示例工程打包成 zip 下载（未改动过，取的就是模板那份；改完再拖回来即可）'
      : '把**当前**工程（含你的改动）打包成 zip 下载 —— 已经不是原始模板了';
}

// ---------------------------------------------------------------------------
// 文件列表
// ---------------------------------------------------------------------------

function allFiles() {
  const names = new Set(state.template);
  for (const k of state.overrides.keys()) names.add(k);
  return [...names].sort();
}

/**
 * 重新问虚拟机要一份工程清单（名字 + 字节大小）。
 *
 * 重命名 / 删除 / 恢复模板之后都要来一次 —— 虚拟机里那份才是唯一真相，
 * 前端别自己猜"现在工程里有什么"。
 */
async function refreshProjectIndex() {
  if (!state.vm) return;
  const list = await state.vm.listProjectFiles();
  state.sizes = new Map(list.map((f) => [f.name, f.size]));
  // 引擎预编译归档不当"用户文件"看：二进制、体积大、不需要进编辑器
  state.template = list.map((f) => f.name).filter((n) => !ENGINE_FILES.includes(n));
}

/**
 * 一个文件现在多大？
 * 改过 / 传过的以内存里那份字节为准 —— 那才是编译时写进虚拟机的长度；
 * 其余用虚拟机列出来的实际大小。拿不到就返回 null（界面上显示 —）。
 */
function fileSizeOf(name) {
  const bytes = state.overrides.get(name);
  if (bytes) return bytes.length;
  return state.sizes.get(name) ?? null;
}

/** 一行：文件名 + 大小 + 状态 + 两个操作按钮（重命名 / 删除） */
function fileRow(name) {
  const li = document.createElement('li');
  li.dataset.name = name;
  li.setAttribute('aria-selected', String(name === state.selected));

  const label = document.createElement('span');
  label.className = 'fname';
  label.textContent = name;
  label.title = name; // 名字被省略号截断时，悬停能看全

  const meta = document.createElement('span');
  meta.className = 'fmeta';

  const bytes = fileSizeOf(name);
  const size = document.createElement('span');
  size.className = 'fsize';
  size.textContent = bytes == null ? '—' : fmtBytes(bytes);
  size.title = bytes == null ? '大小未知（重启编译环境可以刷新）' : `${bytes} 字节`;

  const editTag = document.createElement('span');
  // 「已修改」= 真动过内容。只是从模板读进编辑器看一眼的（fromGuest）字节与模板相同，
  // 标成"已修改"会误导 —— 顺便和 isTemplatePristine 的判定保持一致。
  const changed = state.overrides.has(name) && !state.fromGuest.has(name);
  editTag.className = 'tag' + (changed ? ' new' : '');
  editTag.textContent = changed ? '已修改' : '模板';

  meta.append(
    size,
    editTag,
    iconButton('重命名', ICON.rename, () => startRename(name)),
    iconButton('删除', ICON.trash, () => armDelete(name, li, editTag), 'del')
  );
  li.append(label, meta);
  li.onclick = () => selectFile(name);
  return li;
}

function renderFiles() {
  el.fileList.innerHTML = '';
  refreshDemoButton(); // 文件列表变了基本就意味着「改过/恢复过」，按钮状态跟着走
  for (const name of allFiles()) el.fileList.append(fileRow(name));
}

/** 小图标按钮（文件行里那两颗）。图标是写死的常量，没有用户输入参与 innerHTML。 */
function iconButton(title, svg, onClick, extraClass = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = extraClass ? `fbtn ${extraClass}` : 'fbtn';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.innerHTML = svg;
  b.onclick = (e) => {
    e.stopPropagation(); // 别顺带把文件选中了
    onClick();
  };
  return b;
}

/* 文件行里用的两个图标（12px、跟着主题色走） */
const ICON = {
  rename:
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  trash:
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/></svg>',
  check:
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  cross:
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
};

/* ---------- 重命名 / 删除：改的是虚拟机里那份（前端不另存副本） ---------- */

const renameTarget = (from, base) =>
  (from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : '') + base;

/**
 * 把某一行变成输入框（就地改名），确定 / 取消 / Enter / Esc。
 * 只改**名字**部分：目录保持不变 —— 免得手滑把文件搬到别处或搬出工程之外。
 */
function startRename(name) {
  const li = [...el.fileList.children].find((x) => x.dataset.name === name);
  if (!li) return;
  const base = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'frename';
  input.value = base;
  input.spellcheck = false;
  input.setAttribute('aria-label', `重命名 ${base}`);
  input.onclick = (e) => e.stopPropagation(); // 点输入框别把文件选中了

  let settled = false;
  const cancel = () => {
    if (settled) return;
    settled = true;
    renderFiles();
  };
  const confirm = () => {
    if (settled) return;
    settled = true;
    commitRename(name, input.value.trim());
  };

  input.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      confirm();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  };

  const meta = document.createElement('span');
  meta.className = 'fmeta';
  meta.append(iconButton('确定改名', ICON.check, confirm), iconButton('取消', ICON.cross, cancel));
  li.replaceChildren(input, meta);
  // 光标停在扩展名之前（选中主文件名），改名多半是先打名字再保留后缀
  input.focus();
  const dot = base.lastIndexOf('.');
  input.setSelectionRange(0, dot > 0 ? dot : base.length);
}

/** 改名前的检查：都在前端做完，别把明显不行的名字发到虚拟机里试 */
function renameNameError(from, to) {
  if (to === from) return null;
  if (!to) return '文件名不能是空的';
  if (to.includes('/')) return '只能改名字本身，不能带 /（要挪位置请用「选择文件」重新导入）';
  if (!isSafeRelPath(to)) return '这个名字在虚拟机里不安全（控制字符 / 路径跳转之类）';
  if (allFiles().includes(to)) return `${to} 已经存在了`;
  return null;
}

async function commitRename(from, base) {
  const to = renameTarget(from, base);
  const bad = renameNameError(from, to);
  if (bad) {
    writeLine(`\n✗ 没改成：${bad}`);
    renderFiles();
    return;
  }
  if (to === from) {
    renderFiles(); // 名字没变，当取消
    return;
  }
  if (state.busy || state.phase !== 'ready') {
    writeLine('\n✗ 先启动编译环境才能改名（改的是虚拟机里的工程目录）');
    renderFiles();
    return;
  }

  setBusy(true);
  try {
    await state.vm.renameProjectFile(from, to);
    // 前端那几份"哪些文件读过/改过"的记录跟着搬（内容本身在虚拟机里，不用动）
    const bytes = state.overrides.get(from);
    if (bytes) {
      state.overrides.delete(from);
      state.overrides.set(to, bytes);
    }
    if (state.fromGuest.delete(from)) state.fromGuest.add(to);
    if (state.uploaded.delete(from)) state.uploaded.add(to);
    if (state.packRes.delete(from)) state.packRes.add(to);
    const size = state.sizes.get(from);
    state.sizes.delete(from);
    if (size != null) state.sizes.set(to, size);
    const enc = state.fileEncoding.get(from);
    state.fileEncoding.delete(from);
    if (enc) state.fileEncoding.set(to, enc);
    if (state.selected === from) {
      state.selected = to;
      if (state.editorBase?.name === from) state.editorBase = { ...state.editorBase, name: to };
      el.editorHint.textContent = state.fromGuest.has(to)
        ? `${to}（已从模板载入，未修改）`
        : `${to}（已修改，编译时写入虚拟机）`;
    }
    if (el.optApp.value.trim() === from) {
      el.optApp.value = to;
      writeLine(`  入口源文件也跟着改成 ${to}`);
    }
    // 文件集变了 → isTemplatePristine() 自己会判成「改动过」，不用额外记标志
    await refreshProjectIndex();
    renderFiles();
    writeLine(`\n✓ 已重命名：${from} → ${to}`);
  } catch (e) {
    writeLine(`\n✗ ${e.message}`);
    renderFiles();
  } finally {
    setBusy(false);
  }
}

/**
 * 删除的确认：第一次点变成「再点一次删除」（6 秒内有效，之后自动收回）。
 * 不用 window.confirm —— 嵌入式宿主里的原生对话框不可靠，而且这个更省事。
 * 窗口别太短：4 秒实测嫌紧（看一眼提示再点第二下，慢了就白点一次）。
 */
let deleteArmed = { name: null, timer: 0 };
const DELETE_CONFIRM_MS = 6000;
function armDelete(name, li, tagEl) {
  if (deleteArmed.name === name) {
    clearTimeout(deleteArmed.timer);
    deleteArmed = { name: null, timer: 0 };
    commitDelete(name);
    return;
  }
  clearTimeout(deleteArmed.timer);
  deleteArmed = {
    name,
    timer: setTimeout(() => {
      deleteArmed = { name: null, timer: 0 };
      renderFiles();
    }, DELETE_CONFIRM_MS),
  };
  li.classList.add('confirm-del');
  li.querySelector('.fbtn.del')?.classList.add('danger');
  if (tagEl) {
    tagEl.textContent = '再点一次删除';
    tagEl.className = 'tag danger';
  }
}

/** 入口源文件被删掉之后退回到哪个：优先 main.c，其次默认的 helloworld.c，再退第一个 .c */
function fallbackEntry() {
  const cs = allFiles().filter((n) => /\.c$/i.test(n));
  return (
    cs.find((n) => /(^|\/)main\.c$/i.test(n)) ||
    (cs.includes('helloworld.c') ? 'helloworld.c' : cs[0]) ||
    'helloworld.c'
  );
}

async function commitDelete(name) {
  if (state.busy || state.phase !== 'ready') {
    writeLine('\n✗ 先启动编译环境才能删除（删的是虚拟机里的工程目录）');
    return;
  }
  setBusy(true);
  try {
    await state.vm.deleteProjectFile(name);
    state.overrides.delete(name);
    state.fromGuest.delete(name);
    state.uploaded.delete(name);
    state.packRes.delete(name);
    state.sizes.delete(name);
    state.fileEncoding.delete(name);
    if (state.selected === name) {
      state.selected = null;
      clearEditor();
      el.editorHint.textContent = '未选择文件';
    }
    // 文件集变了 → isTemplatePristine() 自己会判成「改动过」
    await refreshProjectIndex(); // 先刷新清单，再挑替代的入口（否则可能挑到刚删掉那个）
    if (el.optApp.value.trim() === name) {
      el.optApp.value = fallbackEntry();
      writeLine(`  入口源文件已改回 ${el.optApp.value}（原来那个被删了）`);
    }
    renderFiles();
    writeLine(`\n✓ 已从虚拟机里删除 ${name}`);
  } catch (e) {
    writeLine(`\n✗ ${e.message}`);
    renderFiles();
  } finally {
    setBusy(false);
  }
}


/**
 * 源码编辑器：行号 + 着色。
 *
 * 结构（见 index.html）：`行号槽 | [着色层 <pre> + textarea]`
 *   · textarea 只管输入 —— 文字透明、光标可见，彩色文字由底下那层 <pre> 画；
 *   · 两层共用同一套字体 / 字号 / 行高 / padding，滚动量逐像素镜像，
 *     看上去就是一个带颜色的编辑器；
 *   · 为什么不让着色层盖在上面？那样原生选区背景（textarea 画的）会被盖住，
 *     鼠标拖选就看不见高亮了。
 */
let editorRenderTimer = 0;
let editorScrollRaf = 0;

/** 把 textarea 的滚动量镜像给行号槽（只竖向）与着色层（两个方向） */
function syncEditorScroll() {
  const t = scrollMirror(el.editor.scrollLeft, el.editor.scrollTop);
  el.editorHl.style.transform = t.hl;
  el.editorLines.style.transform = t.lines;
}

/** 滚动事件很密，用 rAF 合并，别每隔几十微秒就写一次 style */
function onEditorScroll() {
  if (editorScrollRaf) return;
  editorScrollRaf = requestAnimationFrame(() => {
    editorScrollRaf = 0;
    syncEditorScroll();
  });
}

/**
 * 重绘行号与着色。输入时走防抖（一次 20~50ms，不能每个按键都做），
 * 换文件 / 载入模板时立刻画。
 */
function renderEditor() {
  const text = el.editor.value;
  el.editorLines.textContent = lineNumbersText(countLines(text));
  // 超长文件不着色（几百 KB 会生成几万个 span，输入就没法看了）。
  // 这时必须把 textarea 的文字恢复成不透明，否则一个字都看不见 —— 见 .editor-wrap.no-hl
  const plain = text.length > MAX_HIGHLIGHT_CHARS;
  el.editorWrap.classList.toggle('no-hl', plain);
  el.editorHl.innerHTML = plain ? '' : highlightC(text);
  syncEditorScroll();
}

/** 清空编辑器（二进制资源 / 还没启动虚拟机时用） */
function clearEditor() {
  state.editorBase = null;
  el.editor.value = '';
  el.editor.scrollTop = 0;
  el.editor.scrollLeft = 0;
  renderEditor();
}

/**
 * 网页内全屏：让编辑器铺满整个视口，专供读代码 / 改代码。
 *
 * 只切一个 class（`.maxed`，见 style.css）—— 布局不用动：编辑器本来就是
 * 「flex 列 + 中间那层 flex:1」，`position:fixed; inset:0` 之后自然撑满。
 * 不用 Fullscreen API：那会把浏览器 UI 一起切走，嵌入式预览宿主里还常被禁用，
 * 而这里要的只是「在网页内铺满」。
 *
 * 退出方式：按钮再点一次，或按 Esc（与弹窗共用一处监听，弹窗优先 —— 见文件末尾）。
 */
function setEditorMaxed(on) {
  el.editorWrap.classList.toggle('maxed', on);
  document.body.classList.toggle('editor-maxed', on);
  el.btnEditorMax.textContent = on ? '退出全屏' : '全屏';
  el.btnEditorMax.setAttribute('aria-pressed', on ? 'true' : 'false');
  // 尺寸变了，光标可能落在可视区外 —— 顺手把焦点还给编辑器，切完就能接着敲
  try {
    el.editor.focus({ preventScroll: true });
  } catch {
    el.editor.focus();
  }
}
el.btnEditorMax.addEventListener('click', () => {
  setEditorMaxed(!el.editorWrap.classList.contains('maxed'));
});

/**
 * 把文本放进编辑器，并把它记成「基准」。
 * `el.editor.value` 读回来的就是 textarea 归一化后的形式（CRLF/CR → LF），
 * saveEditor 拿它跟当前 value 比，一致就说明「用户没动过」→ 一个字节都不要重写。
 */
function setEditorText(name, text) {
  el.editor.value = text;
  state.editorBase = { name, text: el.editor.value };
  // 换文件要把视图挪回左上角，再重画（否则会带着上一个文件的滚动位置）
  el.editor.scrollTop = 0;
  el.editor.scrollLeft = 0;
  renderEditor();
}

async function selectFile(name) {
  state.selected = name;
  renderFiles();

  // 二进制资源不走编辑器：按 UTF-8 拆一份再保存回去会把内容改坏
  if (isBinaryName(name)) {
    clearEditor();
    const inPack = isResourceCandidate(name);
    el.editorHint.textContent =
      `${name} —— 二进制资源，不在编辑器里打开` +
      (inPack ? '（打包 .mrp 时会按原样带上）' : '');
    logFile(name, 'open', `打开 ${name}：二进制资源，不在编辑器里显示${inPack ? '（打包 .mrp 时会按原样带上）' : ''}`);
    return;
  }

  if (state.overrides.has(name)) {
    const bytes = state.overrides.get(name);
    // 编码识别一遍并记住（改完之后要按它编回去）
    const enc = detectEncoding(bytes);
    state.fileEncoding.set(name, enc);
    setEditorText(name, decodeSource(bytes));
    const encTag = enc === ENC_GBK ? '，GBK 编码' : '';
    // 只是从模板读进来、没动过的（fromGuest）别写成"已修改" —— 与列表里的标签、
    // 与 isTemplatePristine 的判定保持一致
    el.editorHint.textContent = state.fromGuest.has(name)
      ? `${name}（已从模板载入，未修改${encTag}）`
      : `${name}（已修改，编译时写入虚拟机${encTag}）`;
    logFile(
      name,
      'open',
      state.fromGuest.has(name)
        ? `打开 ${name}（${fmtBytes(bytes.length)}${encTag}，与虚拟机里那份一致，未修改）`
        : `打开 ${name}（${fmtBytes(bytes.length)}${encTag}，内存里那份已改过，编译时写入虚拟机）`
    );
    return;
  }
  if (state.phase !== 'ready') {
    clearEditor();
    el.editorHint.textContent = `${name} —— 先启动编译环境才能读取模板内容`;
    return;
  }
  el.editorHint.textContent = `正在读取 ${name} …`;
  try {
    const bytes = await state.vm.readProjectFile(name);
    const enc = detectEncoding(bytes);
    state.fileEncoding.set(name, enc);
    state.overrides.set(name, bytes);
    // 记成「与虚拟机里那份字节相同」：编译时不必再推一遍 —— 只是点开看一眼就
    // 推回去，等于白白多一次 9p 写 + 一次 mkdir/cp 往返。
    // （引擎归档的一致性由 Makefile 的摘要校验兜着，所以这里只是省事，不是必须。）
    state.fromGuest.add(name);
    setEditorText(name, decodeSource(bytes));
    el.editorHint.textContent =
      `${name}（已从模板载入，未修改${enc === ENC_GBK ? '，GBK 编码' : ''}）`;
    logFile(
      name,
      'open',
      `读取 ${name}（${fmtBytes(bytes.length)}${enc === ENC_GBK ? '，GBK 编码' : ''}，来自虚拟机里的工程）`
    );
    renderFiles();
  } catch (e) {
    state.editorBase = null;
    el.editorHint.textContent = `读取失败：${e.message}`;
    logFile(name, 'open', `读取 ${name} 失败：${e.message}`);
  }
}

function saveEditor() {
  if (!state.selected) return;
  if (isBinaryName(state.selected)) return; // 二进制资源不经过编辑器，避免被改坏
  const name = state.selected;

  /*
   * 只是点开看一眼、没动过内容 → 一个字节都别写。
   *
   * 为什么不能直接「解码再编码」了事：textarea 会把 CRLF/CR 归一化成 LF
   * （HTML 规范如此，实测 34 字节 → 31 字节），而 src/ 下 30 个 .c/.h 都是 CRLF。
   * 一旦重写，这些文件在虚拟机里就被悄悄改小了 —— 引擎的内容摘要随之变化，
   * 下一次编译要白白重建一遍归档（≈3 分钟），编译进去的也不再是模板那份源码。
   */
  if (
    state.editorBase &&
    state.editorBase.name === name &&
    state.editorBase.text === el.editor.value
  ) {
    el.editorHint.textContent = state.fromGuest.has(name)
      ? `${name}（已从模板载入，未修改）`
      : `${name}（已修改，编译时写入虚拟机）`;
    return;
  }

  // 按文件**原来的编码**编回去（GBK 文件仍是 GBK），中文字符串字面量的字节才不会变
  const enc = state.fileEncoding.get(name) ?? ENC_UTF8;
  const next = encodeSource(el.editor.value, enc);
  const prev = state.overrides.get(name);
  // build() 开头也会调这里 —— 光选中文件、内容没动过时不能算「改过」，
  // 否则「点开看一眼再编译」就会把同一份源码多推一遍（还多一次往返）。
  const unchanged =
    prev && prev.length === next.length && prev.every((v, i) => v === next[i]);
  state.overrides.set(name, next);
  if (!unchanged) {
    state.fromGuest.delete(name);
    // 日志里明说一声（只在**第一次**真正改动时写，见 logFile 的去重）：
    // 否则用户只能从编辑器底下那行小字猜自己刚才那次操作到底改了什么
    logFile(name, 'edit', `已修改 ${name} —— 编译时会写进虚拟机`);
  }
  state.editorBase = { name, text: el.editor.value };
  renderFiles();
  el.editorHint.textContent = `${name}（已修改，编译时写入虚拟机${enc === ENC_GBK ? '，GBK 编码' : ''}）`;
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

let rootfsCache = null;      // 本次会话里已经拿到的镜像字节
let rootfsCacheEntry;        // 从 IndexedDB 读到的缓存条目（undefined = 还没读过）
let manifestCache;           // rootfs.parts.json（一次会话读一次；它决定"线上有没有变"）

/** 读分段清单。index.html 之外的静态资源没有 ?v= 防缓存，这里显式 no-store */
async function loadManifest() {
  if (manifestCache !== undefined) return manifestCache;
  try {
    const r = await fetch(new URL('image/rootfs.parts.json', ASSETS), { cache: 'no-store' });
    manifestCache = r.ok ? await r.json() : null;
  } catch {
    manifestCache = null;
  }
  return manifestCache;
}

/** 本地缓存条目（读一次就记住，避免 30MB 从 IndexedDB 反序列化两遍） */
async function getCachedRootfs() {
  if (rootfsCacheEntry === undefined) rootfsCacheEntry = await readImageCache();
  return rootfsCacheEntry;
}

/**
 * 最新版模板 Makefile：镜像（rootfs.tar.gz）里烧的是打镜像那一刻的版本，
 * 模板改动后不必重打 30MB 镜像 —— 编译时优先用站点上随仓库部署的
 * mrp_demo/Makefile（不存在或本地 file:// 打开时静默回退镜像里的旧版）。
 */
let templateMakefileCache;
async function getTemplateMakefile() {
  if (templateMakefileCache !== undefined) return templateMakefileCache;
  try {
    const r = await fetch(new URL('../mrp_demo/Makefile', import.meta.url), { cache: 'no-store' });
    templateMakefileCache = r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
  } catch {
    templateMakefileCache = null;
  }
  return templateMakefileCache;
}

/** 两个字节数组是否逐字节相同 */
function sameBytes(a, b) {
  return (
    a instanceof Uint8Array &&
    b instanceof Uint8Array &&
    a.length === b.length &&
    a.every((v, i) => v === b[i])
  );
}

/**
 * 这份 Makefile 是不是「模板自带的」？
 *
 * Makefile 决定「编译时用不用引擎预编译归档」：站点上的模板带这套逻辑，
 * 但**旧版模板没有**（镜像内置那份就是每次全量编译的老版本）。
 * 「下载demo」会把当时虚拟机里的 Makefile 一起打包（本地开发要用），
 * 用户把包拖回来时如果不加判断就当成「用户自己的 Makefile」，
 * 站点上那份新模板就再也注入不进去了 —— 症状是之后每次编译都全量重编
 * src/（≈2~3 分钟），而且日志里看不到任何归档相关的行（旧 Makefile 根本没那条输出）。
 *
 * 判据只看内容、不看来源：已知的模板样本有两份 —— 启动时虚拟机里那份
 * （镜像自带）和站点上那份。
 */
async function isTemplateMakefile(name, bytes) {
  if (name !== 'Makefile') return false;
  const site = await getTemplateMakefile();
  return [...state.templateMakefiles, site].some((t) => sameBytes(t, bytes));
}

/** Makefile 里带不带「引擎预编译归档」逻辑 —— 决定这轮是 3 秒还是 3 分钟 */
const MK_ENGINE_RE = /engine-archive/;

/**
 * 引擎预编译归档（lib/libmrp_engine.a + 内容摘要 lib/libmrp_engine.key）。
 *
 * 这是编译提速的关键：没有它，每次构建都要把 src/ 下 19 个运行时源文件
 * （1.2MB）从头编一遍 —— 在 v86 里实测 206.3 秒，占整条链路 91%。有它之后
 * 只编用户自己的代码再链接，实测 3.1 秒，产物逐字节一致。
 *
 * `.key` 是「src/ 下所有 .c/.h 内容 + 编译参数」的 sha256 摘要，Makefile 每次
 * 都会现算一份比对，对不上就自己重建归档。所以**归档与源码是否一致不由前端
 * 保证**：用户改了 src/ 里的兼容层/适配层（mrp_compat.c、mrc_android.c、各种
 * .h），或者换了镜像导致站点归档与源码对不上，都过不了这一步校验。这里把
 * .key 一起推过去，只是为了让快路径能命中（否则每次都会白重建一次 ≈190s）。
 *
 * 用 no-store：两个文件都只在 mrp_demo/src/ 改动后才需要重新生成，一旦生成
 * 就必须拿到最新的，不能吃到 HTTP 缓存里那份旧的。合计 323 KiB，远小于镜像。
 */
let engineArchiveCache;
async function getEngineArtifacts() {
  if (engineArchiveCache !== undefined) return engineArchiveCache;
  try {
    const out = [];
    for (const name of ENGINE_FILES) {
      const r = await fetch(new URL(`../mrp_demo/${name}`, import.meta.url), { cache: 'no-store' });
      if (!r.ok) {
        engineArchiveCache = null;
        return null;
      }
      out.push([name, new Uint8Array(await r.arrayBuffer())]);
    }
    engineArchiveCache = out;
  } catch {
    engineArchiveCache = null;
  }
  return engineArchiveCache;
}

/** sha256 → hex。非安全上下文（file:// 或局域网 http）没有 crypto.subtle，返回 null */
async function sha256Hex(bytes) {
  if (!globalThis.crypto?.subtle) return null;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 下载工具链镜像（带本地缓存）。
 * 优先读 rootfs.parts.json 按分段下载再拼合 —— Cloudflare Pages / EdgeOne Pages
 * 这类静态托管对单个文件有 25MB 上限，而镜像有 30.6 MiB，所以 make-image.py
 * 会把它按 20MiB 切开。拼好后校验总大小与 sha256（可用时），防止拼错或传输损坏。
 *
 * 缓存在 IndexedDB 里（见 assets/imagecache.js）：30.6 MiB 每次都重下纯属浪费。
 * 用清单里的 sha256 判断线上有没有变 —— 变了就重下并覆盖，没变就直接用本地那份。
 */
async function loadRootfs() {
  const manifest = await loadManifest();

  if (!manifest?.parts?.length) {
    // 没有清单（单文件部署 / file://）：判断不了"线上有没有变"，所以不复用缓存，
    // 老老实实下整包。这里不做缓存是刻意的 —— 宁可贵一点，也不要用到错版本工具链。
    const r = await fetch(URLS.rootfs, { cache: 'no-store' });
    if (!r.ok) throw new Error(`工具链下载失败（HTTP ${r.status}）`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    writeLine(`  收到 ${fmtBytes(bytes.length)}（无分段清单，不启用本地缓存）`);
    return bytes;
  }

  // ---- 先看本地缓存 ----
  const entry = await getCachedRootfs();
  if (entry && cacheEntryMatches(entry, manifest)) {
    // 大小对上还不够：磁盘损坏 / 上次写到一半中断都可能留下坏字节，
    // 所以再按清单的 sha256 自校验一遍（拿不到 crypto.subtle 时才跳过）。
    const hex = await sha256Hex(entry.bytes);
    if (!hex || hex === manifest.sha256) {
      const savedAt = entry.savedAt ? new Date(entry.savedAt).toLocaleString() : '未知时间';
      writeLine(`  ✓ 本地缓存命中：${fmtBytes(entry.size)}（存于 ${savedAt}）→ 不再联网下载`);
      return entry.bytes instanceof Uint8Array ? entry.bytes : new Uint8Array(entry.bytes);
    }
    writeLine('  ⚠ 本地缓存的镜像校验不过（可能已损坏）→ 重新下载');
  } else if (entry) {
    writeLine('  ⚠ 线上的镜像已变更 → 重新下载');
  }

  writeLine(`  镜像按 ${manifest.parts.length} 个分段下载（单段上限 ${fmtBytes(manifest.partBytes)}）`);
  const chunks = [];
  let total = 0;
  for (let i = 0; i < manifest.parts.length; i++) {
    const part = manifest.parts[i];
    const r = await fetch(new URL(`image/${part.name}`, ASSETS), { cache: 'no-store' });
    if (!r.ok) throw new Error(`分段 ${part.name} 下载失败（HTTP ${r.status}）`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (bytes.length !== part.size) {
      throw new Error(`分段 ${part.name} 不完整：期望 ${part.size} 字节，实际 ${bytes.length}`);
    }
    chunks.push(bytes);
    total += bytes.length;
    writeLine(`    ${i + 1}/${manifest.parts.length}  ${part.name}  ${fmtBytes(bytes.length)}`);
  }
  if (total !== manifest.size) {
    throw new Error(`镜像拼合后大小不符：期望 ${manifest.size} 字节，实际 ${total}`);
  }
  const all = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    all.set(c, p);
    p += c.length;
  }

  const hex = await sha256Hex(all);
  if (hex && manifest.sha256 && hex !== manifest.sha256) {
    // 不在这里硬失败：有些服务器会对镜像做转码（见 installToolchain 的兜底压缩），
    // 那种情况 sha 一定对不上，但内容仍可用；后面还有格式与大小两道校验兜底。
    // 这种"转码过"的字节也**不写缓存**：写进去下次会被自校验判成损坏、白下一遍。
    writeLine('  ⚠ sha256 与清单不符（若服务器对镜像做过转码可忽略，后续仍会校验）');
  } else if (hex) {
    writeLine('  sha256 校验通过');
  }

  if (!hex || hex === manifest.sha256) {
    const ok = await writeImageCache(all, { sha256: manifest.sha256, size: manifest.size });
    rootfsCacheEntry = undefined; // 缓存内容变了，下次要重新读
    writeLine(ok ? '  已存入本地缓存，下次打开直接用它' : '  ⚠ 本地缓存写入失败（隐私模式 / 配额不足），下次仍需重新下载');
  }

  return all;
}

async function boot() {
  if (state.phase === 'boot' || state.phase === 'ready') return;
  setPhase('boot', '正在启动 …');
  setBusy(true);
  clearConsole();
  writeLine('正在加载内核与工具链（首次约 1~3 分钟，取决于机器性能和网络）…');

  try {
    // 先确认镜像能拿到，避免白等。
    // 工具链优先按分段清单校验（EdgeOne/CF Pages 等 25MB 限制的静态托管上
    // 完整 rootfs.tar.gz 根本不存在，HEAD 它必然 404）：有清单就逐段 HEAD，
    // 完全不碰完整镜像；没有清单才回退检查单文件。
    //
    // 但**本地缓存命中时跳过这些探测** —— 那意味着不必联网也能开工（离线可用），
    // 也省掉 3 次 HEAD 往返。
    const manifest = await loadManifest();
    const cachedEntry = await getCachedRootfs();
    if (!cacheEntryMatches(cachedEntry, manifest)) {
      const rootfsChecks = manifest?.parts?.length
        ? manifest.parts.map((p) => [`工具链分段 ${p.name}`, new URL(`image/${p.name}`, ASSETS).href])
        : [['工具链', URLS.rootfs]];
      for (const [label, url] of [['内核', URLS.kernel], ...rootfsChecks]) {
        const r = await fetch(url, { method: 'HEAD' });
        if (!r.ok) throw new Error(`${label}缺失（HTTP ${r.status}）`);
      }
    }
  } catch (e) {
    setPhase('err', '镜像缺失');
    writeLine(`\n✗ ${e.message}`);
    writeLine('\n还没有生成虚拟机镜像，或者网络拿不到它。请在项目根目录运行：');
    writeLine('    python tools/make-image.py');
    writeLine('\n该脚本用 Debian i386 的 arm-none-eabi-gcc 组装工具链，不需要 Docker。');
    setBusy(false);
    return;
  }

  const vm = new MrpVm({
    wasmPath: URLS.wasm,
    bios: { url: URLS.seabios },
    vgaBios: { url: URLS.vgabios },
    kernel: { url: URLS.kernel },
    memorySize: 384 * 1024 * 1024,
    onOutput: pushOutput,
    onStatus: (s) => writeLine(`\n—— ${s} ——`),
  });
  state.vm = vm;

  try {
    await vm.boot();
    writeLine('\n✓ 虚拟机已启动');

    if (!rootfsCache) {
      writeLine('正在准备工具链镜像 …');
      rootfsCache = await loadRootfs();
      writeLine(`  镜像就绪：${fmtBytes(rootfsCache.length)}`);
    }

    const info = await vm.installToolchain(rootfsCache);
    if (info?.regzipped) {
      // 常见于服务端给 .tar.gz 响应加了 Content-Encoding: gzip，浏览器会自动解码，
      // 结果拿到的是未压缩的 tar。installToolchain 已就地压回去，这里只做提示。
      writeLine(
        `  ⚠ 下载到的镜像不是 gzip（被传输层透明解压过），已重新压缩为 ${fmtBytes(info.bytes)}`
      );
    }
    writeLine('\n✓ 工具链已装入虚拟机');

    // 引擎预编译归档不当"用户文件"看：二进制、体积大、不需要进编辑器
    await refreshProjectIndex();
    state.overrides.clear();
    state.pristineNames = [...state.template]; // 刚启动的虚拟机 = 干净的内置模板
    state.selected = null;
    state.editorBase = null;
    // 顺手记下模板自带的 Makefile（镜像里那份）：导入 demo 包时用来判断
    // 「这份 Makefile 是模板的还是用户自己的」—— 见 isTemplateMakefile
    state.templateMakefiles = [];
    if (state.template.includes('Makefile')) {
      try {
        state.templateMakefiles.push(await vm.readProjectFile('Makefile'));
      } catch {
        /* 读不到就算了，isTemplateMakefile 还有站点那份兜底 */
      }
    }
    renderFiles();

    setPhase('ready', '环境就绪');
    writeLine(`✓ 内置工程模板 ${state.template.length} 个文件，可以开始编译了`);
  } catch (e) {
    setPhase('err', '启动失败');
    writeLine(`\n✗ ${e.message}`);
  } finally {
    setBusy(false);
    el.phase.textContent = '—';
  }
}

// ---------------------------------------------------------------------------
// 编译
// ---------------------------------------------------------------------------

async function build() {
  if (state.phase !== 'ready' || state.busy) return;
  setBusy(true);
  state.artifact = null;
  state.engineRebuilt = false; // 本轮是否重建引擎归档，由编译日志识别
  state.nothingToDo = false; // 本轮 make 是否什么都没做（产物沿用上一次那份）
  el.btnDownload.disabled = true;
  el.btnPack.disabled = true;
  saveEditor();

  const app = el.optApp.value.trim() || 'helloworld.c';
  // 目标名固定为 bin.elf：MRP 壳（cfunction.ext 里的 ELF 加载器）就是按这个
  // 文件名去找产物的（二进制里能搜到字符串 "bin.elf"），改了真机就起不来。
  const target = 'bin.elf';
  const extra = el.optExtra.value.trim();

  writeLine(`\n===== 开始编译 ${app} =====`);

  try {
    // 只推真正变过的文件：从模板原样读进编辑器、没改过的那些，虚拟机里本来就是
    // 同一份字节，再推一遍纯属浪费（见 fromGuest 的说明）。
    const changed = [...state.overrides.keys()].filter((n) => !state.fromGuest.has(n));
    const files = Object.fromEntries(
      [...state.overrides].filter(([n]) => !state.fromGuest.has(n))
    );
    /*
     * 同步这件事要在日志里说清楚：源文件改过之后，用户最关心的就是
     * 「我改的那份到底有没有进虚拟机」。列表带名字（最多 3 个），
     * 前缀与编辑时的 [文件] 行一致，一眼能串起来。
     */
    writeLine(
      changed.length
        ? `[文件] 同步到虚拟机：${changed.length} 个改动` +
            `（${changed.slice(0, 3).join('、')}${changed.length > 3 ? ' 等' : ''}）`
        : '[文件] 源码没有改动，直接编译'
    );
    // 用户没自带 Makefile 时，注入站点上最新的模板 Makefile（镜像里可能是旧版）
    if (!files['Makefile']) {
      const mk = await getTemplateMakefile();
      if (mk) files['Makefile'] = mk;
    } else {
      writeLine('  使用工程里的 Makefile（未注入站点上的模板）');
    }

    /*
     * 这份 Makefile 带不带「引擎预编译归档」逻辑，直接决定这轮是 3 秒还是
     * 3 分钟 —— 明说出来，别让人对着一个耗时数字猜。
     * （常见来由：把一个带旧版 Makefile 的工程包/旧 demo 包拖了进来。）
     */
    const mkDecoded = files['Makefile'] ? new TextDecoder().decode(files['Makefile']) : '';
    if (mkDecoded && !MK_ENGINE_RE.test(mkDecoded)) {
      writeLine('  ⚠ 这份 Makefile 没有引擎预编译逻辑 → 本次会全量编译 src/ 下的运行时（约 2~3 分钟）');
      writeLine('    不是你特意改的话，点「恢复模板」再编译一次（会换回站点上的模板 Makefile）');
    }

    /*
     * 推进引擎预编译归档 —— 编译从 207s 降到 3s 就靠它。
     *
     * 无论用户有没有改过 src/ 都推：一致性由 Makefile 的摘要校验兜底 ——
     * 源码一样就命中快路径，源码不同就自动重建（≈190s）。
     * 所以这里推错了最多多花一次校验，不会编出错的产物；反过来「用户动过 src/
     * 就不推」会让「上传整份工程/整包 demo」这种常见操作每次都白重建一次
     * （哪怕上传的源码和镜像里的一模一样）。
     */
    if (!state.enginePushed) {
      const artifacts = await getEngineArtifacts();
      if (artifacts) {
        let total = 0;
        for (const [name, bytes] of artifacts) {
          files[name] = bytes;
          total += bytes.length;
        }
        state.enginePushed = true;
        writeLine(`  引擎预编译归档 ${fmtBytes(total)} 已就绪 → 本次只编你的源码`);
      } else {
        writeLine('  ⚠ 站点上没有引擎预编译归档（mrp_demo/lib/libmrp_engine.a + .key），本次全量编译');
      }
    }

    const res = await state.vm.build({
      files,
      app,
      target,
      extra,
    });

    if (!res.ok) {
      writeLine(`\n✗ 编译失败（make 返回 ${res.code}）`);
      if (res.timing) writeLine(`  本轮已耗时 ${fmtTiming(res.timing)}`);
      writeLine('  可点右上角「复制错误」把报错行一次性拷走');
      setPhase('ready', '编译失败');
      return;
    }

    state.artifact = res.artifact;
    el.btnDownload.disabled = false;
    el.btnPack.disabled = false;
    setPhase('ready', '编译成功');
    const b = res.artifact.bytes;
    writeLine(`\n✓ 编译完成：${res.artifact.name}（${fmtBytes(b.length)}）`);
    // 本轮编译耗时：总耗时后面跟分段明细，加起来正好是总耗时
    if (res.timing) writeLine(`  本轮编译耗时 ${fmtTiming(res.timing)}`);
    if (state.nothingToDo) {
      writeLine('  注：make 认为虚拟机里的源码没有变化，没有重新编译 —— 产物就是上一次那份');
      writeLine('      （导入过源码又点过「恢复模板」的话，恢复会把虚拟机里的工程目录一起换回来）');
    }
    const isElf = b.length >= 4 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46;
    writeLine(isElf ? '  已确认为 ELF 可执行文件，可下载、可用「打包 .mrp」' : '  ⚠ 产物不是 ELF，请检查该文件');
  } catch (e) {
    writeLine(`\n✗ ${e.message}`);
    setPhase('ready', '编译出错');
  } finally {
    setBusy(false);
    refreshPackButton();
    el.console.scrollTop = el.console.scrollHeight;
  }
}

function downloadArtifact() {
  if (!state.artifact) return;
  const blob = new Blob([state.artifact.bytes], { type: 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = state.artifact.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/**
 * 「下载demo / 下载当前项目」：把工程打包成 zip 下载。
 *
 * 内容**只有一个来源 —— 虚拟机里的工程目录**（没改动过时它就等于内置模板）：
 * 不再放静态的 mrp_demo.zip，否则改了模板忘了重新生成 zip，就会发出去一个和实际
 * 模板对不上的工程包（真发生过：zip 停在 9-16 那版，仓库的 src/ 已经是 9-17 的样子，
 * test-zip 那项「内容与磁盘文件一致」一直红着）。
 *
 * 按 `isTemplatePristine()` 分两种口味（按钮文案见 refreshDemoButton）：
 *   · 没动过 → 「下载demo」：取的就是内置模板那份（mrp_demo.zip）；
 *   · 改过（编辑 / 导入 / 重命名 / 删除）→ 「下载当前项目」：连你的改动一起打包
 *     （mrp_project.zip），文件名也换一个，别和原始 demo 混在一起。
 * 下载出来的包再拖回来，就是同一份工程 —— 导入时会认模板自带的那几份 Makefile。
 */
async function downloadProjectZip() {
  if (state.busy || state.phase !== 'ready') return;
  const pristine = isTemplatePristine();
  const kind = pristine ? '内置 demo 模板' : '当前工程（含你的改动）';
  const names = allFiles();
  if (!names.length) {
    writeLine('\n（工程里一个文件都没有 —— 先重新点一次「启动编译环境」）');
    return;
  }

  setBusy(true);
  writeLine(`\n===== 打包 ${kind}（${names.length} 个文件，取自虚拟机里的工程目录）=====`);
  try {
    const files = [];
    for (let i = 0; i < names.length; i++) {
      const n = names[i];
      /*
       * 前端手里有字节就直接用：overrides 里那份就是「编译时会写进虚拟机的内容」——
       * 改过的文件是编辑器里的文本，只是点开看过的那些是原样读回来的模板字节。
       * 这也顺带解决一个坑：**刚导入、还没编译过的文件在虚拟机里根本不存在**，
       * 去 readProjectFile 只会失败；它在 overrides 里有字节，直接打包就好。
       */
      const cached = state.overrides.get(n);
      files.push({ name: n, data: cached ?? (await state.vm.readProjectFile(n)) });
      el.phase.textContent = `读取 ${i + 1}/${names.length}`;
    }

    el.phase.textContent = '压缩中 …';
    const zip = await zipDeflate(files);

    // 自检：用项目自己的 unzip 读回来核对条目数与每项长度 —— 打包器有问题
    // 就别让用户下（和 .mrp 打包那条路一样，写完先验一遍）
    const back = await unzip(zip);
    const bad = files.filter((f) => back[f.name]?.length !== f.data.length);
    if (Object.keys(back).length !== files.length || bad.length) {
      throw new Error(
        `自检没通过：zip 里 ${Object.keys(back).length}/${files.length} 项` +
          (bad.length ? `，${bad.slice(0, 3).map((f) => f.name).join('、')} 长度不符` : '')
      );
    }

    const zipName = pristine ? 'mrp_demo.zip' : 'mrp_project.zip';
    const blob = new Blob([zip], { type: 'application/zip' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = zipName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    writeLine(`✓ 已生成 ${zipName}（${files.length} 个文件，${fmtBytes(zip.length)}），开始下载`);
    if (!pristine) writeLine('  改过工程 → 这是「当前项目」；想要原始 demo 先点「恢复模板」再下');
    writeLine('  自检：用项目自己的 zip 解析器读回，条目数与每项长度都对得上');
  } catch (e) {
    writeLine(`\n✗ 打包失败：${e.message}`);
  } finally {
    el.phase.textContent = '—';
    setBusy(false);
    el.console.scrollTop = el.console.scrollHeight;
  }
}

// ---------------------------------------------------------------------------
// 打包 .mrp
// ---------------------------------------------------------------------------

/**
 * 打包顺序固定为：start.mr → bin.elf → 资源 → cfunction.ext。
 * 这个顺序和社区 gcc 方案的 pack.json 一致，也符合两个真实样本的排布。
 * 名字必须原样保留：cfunction.ext 里的 ELF 加载器就是按 `bin.elf` 这个名字去
 * 找文件的（在二进制里能搜到字符串 "bin.elf" 和 "load bin.elf fail."）。
 */
const PACK_START = 'lib/start.mr';
const PACK_CFUNCTION = 'lib/cfunction.ext';
const PACK_ELF = 'bin.elf';
/**
 * 引擎预编译归档：src/ 下 19 个 mythroad 运行时源文件预先编好的静态库。
 * 把它推进虚拟机之后，一次构建只剩「编你自己的代码 + 链接」——
 * 实测 207s → 3.1s，产物逐字节一致。详见 mrp_demo/Makefile 里的说明。
 * 站点上不存在时（file:// 打开、或没部署）静默跳过：Makefile 会退回全量编译。
 */
const ENGINE_A = 'lib/libmrp_engine.a';
// 归档的内容摘要（src/ 的 .c+.h + 编译参数的 sha256）：Makefile 靠它判断归档
// 是否与源码一致，对不上就自己重建 —— 所以一致性不依赖前端的推送行为。
const ENGINE_KEY = 'lib/libmrp_engine.key';
const ENGINE_FILES = [ENGINE_A, ENGINE_KEY];
// 资源 / 二进制的判定规则放在 mrp-pack.js 里，与命令行打包器共用

function gbkInfo(str) {
  return encodeGBKDetailed(str ?? '');
}

function refreshPackHints() {
  const rows = [
    [el.pkDisplay, el.pkDisplayHint, 24],
    [el.pkFileName, el.pkFileNameHint, 12],
    [el.pkVendor, el.pkVendorHint, 40],
    [el.pkDesc, el.pkDescHint, 64],
  ];
  for (const [input, hint, limit] of rows) {
    const { bytes, missed } = gbkInfo(input.value);
    const n = bytes.length;
    const over = n > limit;
    const parts = [`GBK ${n} / ${limit} 字节`];
    if (over) parts.push(`超出会截断到 ${limit - 1} 字节`);
    if (missed.length) parts.push(`${missed.length} 个字符 GBK 无对应（会变成 ?）：${missed.join('')}`);
    hint.textContent = parts.join(' · ');
    hint.className = 'hint' + (over ? ' over' : '') + (missed.length ? ' bad' : '');
  }
}

/**
 * 拿去打包的 bin.elf：
 * 优先用刚编译出来的产物；没有的话，看用户有没有自己上传一个 bin.elf。
 * 这样「手上已有 elf，只想打个 mrp」的场景不需要先跑一遍编译。
 */
function currentElf() {
  if (state.artifact) return { bytes: state.artifact.bytes, from: '刚编译的 bin.elf' };
  const up = state.overrides.get(PACK_ELF);
  if (up && up.length) return { bytes: up, from: '你上传的 bin.elf' };
  return null;
}

function refreshPackButton() {
  el.btnPack.disabled = !currentElf();
}

function resourceCandidates() {
  return [...new Set(allFiles())].filter(isResourceCandidate).sort();
}

async function getProjectBytes(name) {
  if (state.overrides.has(name)) return state.overrides.get(name);
  if (state.shell.has(name)) return state.shell.get(name);
  // 同一文件的并发读取合并成一次，免得对同一个 shell 发两条重复命令
  if (!state.shellLoading) state.shellLoading = new Map();
  if (state.shellLoading.has(name)) return state.shellLoading.get(name);
  const p = (async () => {
    try {
      const bytes = await state.vm.readProjectFile(name);
      state.shell.set(name, bytes);
      return bytes;
    } finally {
      state.shellLoading.delete(name);
    }
  })();
  state.shellLoading.set(name, p);
  return p;
}

/** 预读壳文件（只为在对话框里显示体积，顺便缓存下来给打包用） */
async function loadShellFiles() {
  for (const n of [PACK_START, PACK_CFUNCTION]) {
    try {
      await getProjectBytes(n);
    } catch (e) {
      writeLine(`\n⚠ 读取 ${n} 失败：${e.message}`);
    }
  }
}

/**
 * 写打包弹窗底部的状态行。
 * @param {string} text
 * @param {'info'|'err'} [tone]  err = 高亮（红字加粗 + 淡红底），用来突出"为什么失败"
 *
 * 所有写 packNote 的地方都必须走这里：出错后再把文案改回普通状态
 * （比如「共 N 个文件」）时，tone 回到 info 就会顺手去掉 .err，不会留下残留高亮。
 */
function setPackNote(text, tone = 'info') {
  el.packNote.textContent = text;
  el.packNote.classList.toggle('err', tone === 'err');
}

function updatePackNote() {
  const elf = currentElf();
  const res = [...state.packRes].length;
  const total = 2 + res + 1;
  setPackNote(
    elf
      ? `共 ${total} 个文件（资源 ${res} 个）· ${elf.from} ${fmtBytes(elf.bytes.length)}`
      : '还没有 bin.elf'
  );
}

/**
 * 撤掉上一次校验 / 打包留下的错误痕迹：输入框红边 + 底部提示的高亮。
 * 两个调用点：
 *   ① 用户改动表单里任何一处（改了就说明上一次的判定已经过期，
 *      整体撤掉才不会有「红边还在、下面却没说明」的怪状态）
 *   ② 每次点「生成并下载」重新校验之前
 * 打包失败的原因在日志里仍然留着一条，不影响排查。
 * 唯一写 packNote 的地方就是 setPackNote，所以直接看它的 class 就够了。
 */
function clearPackErrors() {
  for (const f of PACK_FIELDS) f.classList.remove('bad');
  if (el.packNote.classList.contains('err')) updatePackNote();
}

function renderPackList() {
  const elf = currentElf();
  el.packList.innerHTML = '';
  const items = [
    { name: 'start.mr', from: PACK_START, tag: '壳 · 必需', fixed: true, size: state.shell.get(PACK_START)?.length },
    { name: 'bin.elf', from: PACK_ELF, tag: elf?.from || '编译产物', fixed: true, size: elf?.bytes.length },
    ...resourceCandidates().map((n) => ({ name: n.split('/').pop(), from: n, res: true })),
    { name: 'cfunction.ext', from: PACK_CFUNCTION, tag: '壳 · 必需', fixed: true, size: state.shell.get(PACK_CFUNCTION)?.length },
  ];

  const byName = new Map();
  for (const it of items) {
    if (!byName.has(it.name)) byName.set(it.name, []);
    byName.get(it.name).push(it.from);
  }

  let idx = 0;
  for (const it of items) {
    idx++;
    const li = document.createElement('li');
    const num = document.createElement('span');
    num.className = 'idx';
    num.textContent = String(idx);

    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = it.name;

    if (it.fixed) {
      const tag = document.createElement('span');
      tag.className = 'fixed';
      tag.textContent = it.tag;
      const sz = document.createElement('span');
      sz.className = 'sz';
      sz.textContent = it.size != null ? fmtBytes(it.size) : '';
      li.append(num, nm, tag, sz);
    } else {
      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = state.packRes.has(it.from);
      cb.onchange = () => {
        if (cb.checked) state.packRes.add(it.from);
        else state.packRes.delete(it.from);
        li.classList.toggle('res-off', !cb.checked);
        updatePackNote();
      };
      label.append(cb, nm);
      li.classList.toggle('res-off', !cb.checked);

      const tag = document.createElement('span');
      tag.className = 'res-tag';
      tag.textContent = state.uploaded.has(it.from) ? '上传' : '模板资源';
      const sz = document.createElement('span');
      sz.className = 'sz';
      const dup = byName.get(it.name).length > 1;
      sz.textContent = dup ? '⚠ 同名' : '';
      sz.className += dup ? ' dup' : '';
      li.append(num, label, tag, sz);
    }
    el.packList.append(li);
  }

  if (!items.some((it) => it.res)) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '没有可打包的资源（.c/.h 属于源码，已自动排除）';
    el.packList.append(li);
  }
  updatePackNote();
}

async function openPackDialog() {
  const elf = currentElf();
  if (!elf) {
    writeLine('\n（还没有 bin.elf —— 先点「编译」，或直接把 bin.elf 拖进来）');
    return;
  }
  if (state.phase !== 'ready') {
    writeLine('\n（编译环境未就绪，需要它来提供壳文件 lib/start.mr 与 lib/cfunction.ext）');
    return;
  }
  // 首次打开默认勾选「上传的非源码文件」和模板 assets/ 下的资源
  if (!state.packResTouched) {
    state.packRes = new Set(
      resourceCandidates().filter((n) => state.uploaded.has(n) || n.startsWith('assets/'))
    );
  }
  renderPackList();
  refreshPackHints();
  setPackNote('正在读取壳文件 …');
  openPackOverlay();
  await loadShellFiles();
  renderPackList();
}

function clampInt(v, fallback) {
  const n = Number.parseInt(String(v).trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// ---- 打包表单校验 ----------------------------------------------------------
// 规则本身在 assets/mrp-pack.js 的 validatePackMeta() 里（与命令行打包器共用同一份），
// 这里只负责把返回的「字段名」映射到界面上的输入框，并给那个框加红边。
const PACK_INPUTS = {
  displayName: el.pkDisplay,
  fileName: el.pkFileName,
  appid: el.pkAppid,
  version: el.pkVersion,
  vendor: el.pkVendor,
};
const PACK_FIELDS = Object.values(PACK_INPUTS);

/** 校验表单，返回 [输入框, 提示文案]；全部通过返回 null */
function firstPackFieldError() {
  /*
   * type=number 的框里填了非数字（"abc"、"30001." 这种），DOM 给的 value 是**空串**，
   * 直接交上去会误报"不能为空"（可框里明明有内容）。这里把 validity.badInput
   * 换成一个非数字占位串，让规则自己去判成"只能是数字"，避免把文案抄成两份。
   */
  const numValue = (input) => (input.validity?.badInput ? 'NaN' : input.value);
  const bad = validatePackMeta({
    displayName: el.pkDisplay.value,
    fileName: el.pkFileName.value,
    appid: numValue(el.pkAppid),
    version: numValue(el.pkVersion),
    vendor: el.pkVendor.value,
  });
  return bad ? [PACK_INPUTS[bad.field], bad.message] : null;
}

async function doPack() {
  clearPackErrors();
  const bad = firstPackFieldError();
  if (bad) {
    const [input, message] = bad;
    // 底部状态行高亮说"错在哪"，红边直接指出"哪个框"
    input.classList.add('bad');
    setPackNote(`⚠ ${message}`, 'err');
    // 只聚焦、不全选：全选后在某些嵌入式预览面板里点击被吞掉，
    // 高亮一直留着，鼠标就没法把光标点到想改的位置了
    try {
      input.focus();
    } catch {}
    return;
  }

  const displayName = el.pkDisplay.value.trim();
  const fileName = el.pkFileName.value.trim();
  const meta = {
    fileName,
    displayName,
    vendor: el.pkVendor.value.trim(),
    desc: el.pkDesc.value.trim(),
    authStr: el.pkAuth.value.trim(),
    appid: clampInt(el.pkAppid.value, 0),
    version: clampInt(el.pkVersion.value, 0),
    flag: clampInt(el.pkFlag.value, FLAG_DEFAULT),
    screenWidth: clampInt(el.pkSw.value, 0),
    screenHeight: clampInt(el.pkSh.value, 0),
  };

  el.btnPackGo.disabled = true;
  setPackNote('读取文件 …');
  try {
    const elf = currentElf();
    if (!elf) throw new Error('还没有 bin.elf');
    const raw = [
      { name: 'start.mr', data: await getProjectBytes(PACK_START) },
      { name: 'bin.elf', data: elf.bytes },
    ];
    for (const n of [...state.packRes].sort()) {
      raw.push({ name: n.split('/').pop(), data: await getProjectBytes(n) });
    }
    raw.push({ name: 'cfunction.ext', data: await getProjectBytes(PACK_CFUNCTION) });

    // 重名检查：mrp 内部只按文件名索引，重名会互相覆盖
    const seen = new Map();
    for (const f of raw) seen.set(f.name, (seen.get(f.name) || 0) + 1);
    const dups = [...seen].filter(([, c]) => c > 1).map(([n]) => n);
    if (dups.length) throw new Error(`打包清单里有重名文件：${dups.join('、')}（mrp 内部按文件名索引）`);

    setPackNote('压缩中 …');
    const prepared = await prepareFiles(raw, (i, total, name) => {
      setPackNote(`压缩中 ${i}/${total}：${name}`);
    });

    const { bytes, entries } = packMrp({ ...meta, files: prepared });
    const check = parseMrp(bytes).verify();

    // ---- 日志 ----
    writeLine('\n===== 打包 .mrp =====');
    writeLine(`  显示名  ${displayName}      appid  ${meta.appid}      版本  ${meta.version}`);
    writeLine(`  内部名  ${fileName}${meta.vendor ? `      开发者  ${meta.vendor}` : ''}`);
    if (meta.desc) writeLine(`  介绍    ${meta.desc}`);
    writeLine(`  授权串  ${meta.authStr || '(空)'}      flag  ${meta.flag}      内部名写入头 [16]`);
    writeLine(`  清单（原始 → gzip 后）：`);
    for (const [i, e] of entries.entries()) {
      const raw0 = raw[i]?.data?.length ?? 0;
      const pct = raw0 ? ((e.size / raw0) * 100).toFixed(0) + '%' : '';
      writeLine(
        `    ${String(i + 1).padStart(2)}  ${e.name.padEnd(18)} ${fmtBytes(raw0).padStart(10)} → ${fmtBytes(e.size).padStart(10)}${pct ? `  (${pct})` : ''}`
      );
    }
    if (check.length) {
      writeLine(`  ⚠ 自检发现问题：${check.join('；')}`);
    } else {
      writeLine('  自检：头 / 列表区 / 偏移 / CRC32 全部自洽');
    }
    const missed = [meta.displayName, meta.vendor, meta.desc, fileName]
      .flatMap((s) => gbkInfo(s).missed);
    if (missed.length) writeLine(`  ⚠ 有字符 GBK 无法表示，已替换为 ?：${[...new Set(missed)].join('')}`);

    // ---- 下载 ----
    const outName = fileName.toLowerCase().endsWith('.mrp') ? fileName : `${fileName}.mrp`;
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = outName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    writeLine(`\n✓ 已生成 ${outName}（${fmtBytes(bytes.length)}），开始下载`);
    closePackOverlay();
    // 回到普通文案（tone=info）→ 顺手清掉上一次失败留下的高亮
    updatePackNote();
  } catch (e) {
    writeLine(`\n✗ 打包失败：${e.message}`);
    setPackNote(`⚠ 打包失败：${e.message}`, 'err');
  } finally {
    el.btnPackGo.disabled = false;
    el.console.scrollTop = el.console.scrollHeight;
  }
}

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------

el.btnBoot.onclick = boot;
el.btnBuild.onclick = build;
el.btnDownload.onclick = downloadArtifact;
el.btnDemo.onclick = downloadProjectZip;
el.btnClear.onclick = clearConsole;
el.btnPack.onclick = openPackDialog;
el.btnPackCancel.onclick = closePackOverlay;
el.btnPackGo.onclick = doPack;
el.btnHelp.onclick = openHelpOverlay;
el.btnHelpClose.onclick = closeHelpOverlay;
el.btnTheme.onclick = toggleTheme;

// 主题：data-theme 已由 index.html 里的内联脚本在首屏前打好（防闪白），
// 这里补上按钮提示文案，并挂上「系统主题变化 / 其他标签页改偏好」的同步。
initTheme(el.btnTheme);

for (const input of [...PACK_FIELDS, el.pkDesc]) {
  input.addEventListener('input', () => {
    // 改了就撤掉上一次的错误痕迹（红边 + 底部提示）
    clearPackErrors();
    refreshPackHints();
  });
}

// 高级选项（authStr / flag / 屏宽高）不参与字段校验，也没 GBK 提示，
// 但改了同样应该撤掉底部那条错误提示
for (const input of [el.pkAuth, el.pkFlag, el.pkSw, el.pkSh]) {
  input.addEventListener('input', clearPackErrors);
}

// 点遮罩关闭对话框（<dialog> 默认不响应）
function openPackOverlay() {
  el.packOverlay.classList.add('show');
  // 有些嵌入式预览面板会拦截"点击 → 聚焦"这条事件链（表现为输入框点不进、
  // 光标出不来），但程序化 focus() 不经过事件链，不受影响。
  // 只把光标放进去，**不做全选** —— 全选后如果点击又被宿主吞掉，
  // 高亮会一直挂着，鼠标就再也点不到想改的位置（用户反馈过这个问题）。
  setTimeout(() => {
    try { el.pkDisplay.focus(); } catch {}
    checkOverlayInputEnv();
  }, 80);
}
function closePackOverlay() {
  el.packOverlay.classList.remove('show');
}

/**
 * 帮助弹窗。纯说明性内容、没有输入框，所以只做显隐切换：
 * 遮罩点击 / Escape / 滚轮兜底统一由下面 attachOverlay* 那组函数接管。
 */
function openHelpOverlay() {
  el.helpOverlay.classList.add('show');
}
function closeHelpOverlay() {
  el.helpOverlay.classList.remove('show');
}

/** 点遮罩（而不是点弹窗本体）关闭。两个弹窗行为一致，抽出来共用 */
function attachOverlayDismiss(overlay, close) {
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });
}
attachOverlayDismiss(el.packOverlay, closePackOverlay);
attachOverlayDismiss(el.helpOverlay, closeHelpOverlay);

/**
 * 鼠标滚轮兜底（工程文件 / 源码编辑 / 编译输出 + 弹窗）
 *
 * 正常浏览器里 overflow:auto 的元素天生响应鼠标滚轮；但部分宿主环境（嵌入式
 * 预览 iframe 等）会把 wheel 事件整体吃掉 —— 表现为「触摸能滑、电脑上滚轮
 * 完全没反应」。这里在 document 上统一接管：
 *   从事件目标往上找**第一个朝这个方向还能滚**的元素，手动把 deltaY/deltaX
 *   落到它的 scrollTop/scrollLeft 上；滚到头就继续往外层找（和原生链式滚动
 *   一致）。确实滚动了才 preventDefault —— 不拦的话宿主把事件转给原生滚动时
 *   会两边各滚一次、速度翻倍。
 *
 * 覆盖范围靠「就近可滚祖先」自动判定，所以不需要逐个登记：.filebar（文件
 * 列表）、#editor（源码编辑，wrap=off 还要吃横向 deltaX）、#console（编译
 * 输出）、窄屏下整栏滚动的 .pane，以及弹窗里的 .dlg-body 都走这一份逻辑。
 * 弹窗另有一条约束：指针在弹窗里时只允许在弹窗内部滚（滚到头就停），
 * 否则会漏到弹窗背后的页面上。
 *
 * 两个修饰键：
 *   · Ctrl/Cmd + 滚轮 → 直接放行（浏览器缩放）；
 *   · Shift + 滚轮 → **只横向**（原生行为）。滚到最左/最右就停住，绝不退回纵向 ——
 *     早期版本"到头退回纵向"会让画面忽然上下跳，比什么都不做更烦人。
 *
 * 「滚谁、滚多少」的决策在 `assets/wheel.js`（纯函数，单测 tools/test-wheel.mjs）；
 * 这里只做 DOM 那半：收集祖先链、判定能不能滚、把结果落到 scrollTop/scrollLeft。
 */

/** 该元素在指定方向上还能继续滚吗？必须看计算样式的 overflow，不能只看尺寸 */
function canScroll(node, axis, delta) {
  const scroll = axis === 'y' ? node.scrollHeight : node.scrollWidth;
  const client = axis === 'y' ? node.clientHeight : node.clientWidth;
  if (scroll <= client + 1) return false;
  const style = getComputedStyle(node);
  const overflow = axis === 'y' ? style.overflowY : style.overflowX;
  if (overflow !== 'auto' && overflow !== 'scroll') return false;
  const pos = axis === 'y' ? node.scrollTop : node.scrollLeft;
  return delta < 0 ? pos > 0 : pos + client < scroll - 1;
}

/**
 * 事件目标 → 祖先链（含自身）。指针在弹窗里时到弹窗根为止 ——
 * 滚到头就停，别漏到弹窗背后的页面上。
 */
function chainTo(node, scope) {
  const chain = [];
  for (let n = node; n; n = n.parentElement) {
    chain.push(n);
    if (n === scope) break;
  }
  return chain;
}

/** 把决策落到真实元素上 */
function applyPlan(plan) {
  if (plan.dy) plan.node.scrollTop += plan.dy;
  if (plan.dx) plan.node.scrollLeft += plan.dx;
}

function attachWheelScroll() {
  document.addEventListener(
    'wheel',
    (e) => {
      // Ctrl/Cmd + 滚轮 = 浏览器缩放，别抢
      if (e.ctrlKey || e.metaKey) return;
      const { dx, dy } = wheelDeltas(e);
      if (!dx && !dy) return;
      const start = e.target instanceof Element ? e.target : null;
      if (!start) return;
      // 指针落在弹窗里 → 滚动只允许发生在弹窗内部
      const scope = start.closest('.overlay');

      const plan = planWheel({ shift: e.shiftKey, dx, dy }, chainTo(start, scope), canScroll);
      if (plan.node) {
        applyPlan(plan);
        e.preventDefault(); // 确实滚动了才拦默认行为
        return;
      }
      // Shift + 滚轮只做横向：已经到最左/最右（或这块压根不能横滚）→ 就此打住，
      // 不退回纵向。拦默认行为是因为这次滚轮已经被我们"消费"了。
      if (plan.locked) {
        e.preventDefault();
        return;
      }

      // 弹窗里没找到可滚元素时（指针落在底部按钮条上等）→ 退回到弹窗正文，
      // 这是原来那版的行为：指针在弹窗内就该滚正文，别因为压在按钮上就失灵
      if (scope) {
        const body = start.closest('.dlg')?.querySelector('.dlg-body');
        const fallback = body && planWheel({ shift: e.shiftKey, dx, dy }, [body], canScroll);
        if (fallback?.node) {
          applyPlan(fallback);
          e.preventDefault();
        } else if (fallback?.locked) {
          e.preventDefault(); // 弹窗里同样是「Shift 只横向」
        }
        return;
      }

      // 谁都没接（例如指针在页面空白上）→ 页面本身还能滚就交给它
      const doc = document.scrollingElement;
      if (doc && dy && doc.scrollHeight > doc.clientHeight + 1) {
        const before = doc.scrollTop;
        doc.scrollTop = before + dy;
        if (doc.scrollTop !== before) e.preventDefault();
      }
    },
    { passive: false }
  );
}
attachWheelScroll();

/**
 * 环境自检：程序化 focus 后 activeElement 应该是输入框。
 * 不是 → 说明宿主环境（预览 iframe 等）在更底层拦截了焦点，
 * 在弹窗顶部明确提示，别让用户以为是自己点错了。
 *
 * 注意它探的是**程序化 focus**，走不到鼠标事件链 —— 所以"点输入框没反应"那类
 * 症状它不是负责的（那个根因是 v86 的鼠标适配器，见下面 grab() 的说明）。
 * 它只负责"这一层环境根本不给输入框焦点"这种情况。留着的成本极低，
 * 正常情况下永远静默，所以不删。
 */
function checkOverlayInputEnv() {
  const probe = document.getElementById('pkDisplay');
  const hint = document.getElementById('pkEnvHint');
  if (!probe || !hint) return;
  const ok = document.activeElement === probe;
  hint.textContent = ok ? '' :
    '⚠ 当前预览环境拦截了输入框焦点：鼠标点输入框可能无效。可尝试直接打字（光标已自动放入"显示名"），或把本页用系统浏览器打开。';
  hint.style.display = ok ? 'none' : 'block';
}

/*
 * 兜底：mousedown / touchstart 阶段就抢焦点（click 之前）。
 *
 * 起因是「打包弹窗里的输入框点不进、打不了字」。当时归因成 `<dialog>` 顶层渲染 /
 * 宿主吞事件，最后用这段兜底 + 把弹窗改成普通覆盖层绕过去了。**真正的原因后来才
 * 查出来**：v86 的鼠标适配器没传 screen_container，容器回落到 document.body，
 * 于是整页的 mousedown 都被它无条件 preventDefault()（默认行为里就包含"聚焦 +
 * 落光标"）—— guest 一启动就打开，而打包按钮本来就要先编译出产物才可点，所以这个
 * 弹窗**必然**在"适配器已生效"的状态下使用。根因已在 `assets/vm.js` 里修掉
 * （disable_mouse / disable_keyboard），这段兜底因此不再是必需的。
 *
 * 仍然保留：它零副作用（`focus()` 只会在点击本来就没能聚焦时补救；能正常聚焦时是
 * no-op，默认行为照旧把光标放到点击位置），而宿主环境五花八门、这里没法逐个验证。
 * 哪天确认所有宿主都不吞 mousedown 的默认行为，删掉这段也不会有任何影响。
 */
el.packOverlay.querySelectorAll('input, textarea').forEach((inp) => {
  const grab = () => { try { inp.focus(); } catch {} };
  inp.addEventListener('mousedown', grab);
  inp.addEventListener('touchstart', grab, { passive: true });
});

// 点遮罩关闭由 attachOverlayDismiss() 统一接管（见 openPackOverlay 附近）。
// Escape 关闭（原生 <dialog> 自带这个行为，换成覆盖层后要自己接）：
// 打包弹窗在上层，先关它；它没开才轮到帮助弹窗；两个都关着才轮到编辑器全屏。
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (el.packOverlay.classList.contains('show')) closePackOverlay();
  else if (el.helpOverlay.classList.contains('show')) closeHelpOverlay();
  else if (el.editorWrap.classList.contains('maxed')) setEditorMaxed(false);
});

/**
 * 用选区把某个元素的文本整个选中（Ctrl+A 全选编译输出区用）。
 * 编译输出区是 `<pre>`，不是表单元素、不能 `select()`，只能用 Range。
 */
function selectNodeText(node) {
  const sel = window.getSelection();
  if (!sel || !node) return;
  const range = document.createRange();
  range.selectNodeContents(node);
  sel.removeAllRanges();
  sel.addRange(range);
}

/**
 * Ctrl/Cmd + A 该全选谁：焦点在可编辑文本里（源码编辑窗 / 输入框）→ 交给浏览器原生；
 * 有弹窗（帮助 / 打包）打开 → 什么都不做；其它情况 → 全选编译输出区，而不是整个网页。
 * 「怎么分流」的决策在 `assets/selectall.js`（纯函数，单测覆盖），这里只做 DOM 那半。
 *
 * 顺带：`#console` 带 `tabindex="0"`，所以点了日志区之后焦点就在它上面，
 * 这条路同样命中 `'console'` → 全选日志，符合直觉。
 */
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
  if (String(e.key).toLowerCase() !== 'a') return;
  const active = document.activeElement;
  const plan = planSelectAll(
    active
      ? { tagName: active.tagName, type: active.type, isContentEditable: active.isContentEditable }
      : null,
    !!document.querySelector('.overlay.show')
  );
  if (plan === 'native') return; // 编辑窗 / 输入框：让浏览器原生全选
  e.preventDefault();
  if (plan === 'console') selectNodeText(el.console);
});

el.btnCopyLog.onclick = () => {
  const text = el.console.textContent.replace(/\s+$/, '');
  if (!text) {
    writeLine('\n（日志为空，没有可复制的内容）');
    return;
  }
  copyWithFeedback(el.btnCopyLog, text);
};

el.btnCopyErrors.onclick = () => {
  const errs = extractErrors(el.console.textContent);
  if (!errs.trim()) {
    writeLine('\n（当前日志里没有识别到报错行；可用「复制日志」拷完整内容）');
    return;
  }
  copyWithFeedback(el.btnCopyErrors, errs);
};

/**
 * 只清前端这份工程状态（不动虚拟机）：overrides / 勾选 / 编辑器 / 入口名。
 * 「恢复模板」要同时清它和虚拟机里的工程目录 —— 见 resetToTemplate()。
 */
function clearClientProject() {
  state.overrides.clear();
  state.fromGuest.clear();
  state.uploaded.clear();
  state.shell.clear();
  state.packRes.clear();
  state.packResTouched = false;
  state.fileEncoding.clear();
  state.selected = null;
  fileLog.clear(); // 「读取 / 已修改」的记录也一起清（工程要回到模板那份）
  clearEditor();
  el.editorHint.textContent = '未选择文件';
  // 入口源文件也回默认：导入的 main.c 之所以会让「恢复」看起来没生效，
  // 一半原因就是这个输入框还停在 main.c 上
  el.optApp.value = 'helloworld.c';
  renderFiles();
}

/**
 * 恢复模板。
 *
 * ⚠ 必须连**虚拟机里的工程目录**一起还原：工程目录是用户唯一会往里写东西的地方，
 * 只清前端那份状态的话，用户的 main.c / src/xxx.c 还留在 guest 里 ——
 * make 会照样拿它们编译，而且因为依赖都比 bin.elf 旧，直接回一句
 * `Nothing to be done for 'all'`，把上一次的产物当成新产物交出来
 * （实测踩到：导入源码编译 → 点恢复模板 → 再编译，0.3 秒「编译完成」）。
 *
 * 虚拟机里那份模板副本是装工具链时 `cp -a` 留的，换回来只要 0.2 秒。
 * 本来就没改动过（前端 pristine）就不必折腾虚拟机。
 */
async function resetToTemplate() {
  if (state.busy) return;
  const vm = state.vm;
  const dirty = !isTemplatePristine();
  clearClientProject();

  if (!vm) {
    writeLine('\n已重置界面状态（编译环境还没启动，虚拟机里没有东西要还原）');
    return;
  }
  if (!dirty) {
    writeLine('\n工程本来就没被改动过，只重置了界面状态');
    return;
  }

  setBusy(true);
  writeLine('\n===== 恢复模板：把虚拟机里的工程目录换回内置模板 =====');
  try {
    await vm.resetProject();
    // lib/ 里的引擎预编译归档也一起被换掉了 → 下次编译要重新推（否则会白重建一次）
    state.enginePushed = false;
    // 上一次的产物已经不属于这个工程了：别让「下载 bin.elf / 打包 .mrp」还拿着它
    state.artifact = null;
    el.btnDownload.disabled = true;
    refreshPackButton();
    // 工程目录换回来了 → 清单（名字 + 大小）重新问一次虚拟机，别拿旧的那份
    await refreshProjectIndex();
    state.pristineNames = [...state.template]; // 换回来的就是模板那份，快照重新对齐
    renderFiles();
    writeLine('✓ 已恢复：虚拟机里的工程目录换回了镜像内置那份（含 bin.elf 一起清掉）');
    writeLine('  再点「编译」会真正重新编译模板工程');
  } catch (e) {
    writeLine(`\n✗ ${e.message}`);
    writeLine('  可以点「启动编译环境」重启虚拟机，效果一样');
  } finally {
    setBusy(false);
  }
}

el.btnReset.onclick = resetToTemplate;

/* 输入时：行号 + 着色防抖重画（120ms），写回虚拟机再慢一拍（600ms）。
   两个定时器分开 —— 着色只影响观感，可以拖；写 9p 要尽量少触发。 */
function scheduleEditorRender() {
  clearTimeout(editorRenderTimer);
  editorRenderTimer = setTimeout(renderEditor, 120);
}

el.editor.addEventListener('input', () => {
  scheduleEditorRender();
  clearTimeout(el.editor._t);
  el.editor._t = setTimeout(saveEditor, 600);
});

el.editor.addEventListener('scroll', onEditorScroll, { passive: true });

/*
 * 中文输入法组字期间，组字文本是 textarea 自己画的 —— 而 textarea 的文字是透明的，
 * 不处理就会「打字时什么都看不见」。这段期间把着色层藏起来、把 textarea 的文字点亮，
 * 组字结束再交还给着色层（见 style.css 的 .editor-wrap.ime）。
 */
el.editor.addEventListener('compositionstart', () => {
  el.editorWrap.classList.add('ime');
});
el.editor.addEventListener('compositionend', () => {
  el.editorWrap.classList.remove('ime');
  scheduleEditorRender();
});

el.editor.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const s = el.editor.selectionStart;
    el.editor.setRangeText('    ', s, el.editor.selectionEnd, 'end');
    // setRangeText 不一定触发 input，这里自己补一次重画
    scheduleEditorRender();
  }
});

window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && state.phase === 'ready') {
    e.preventDefault();
    build();
  }
});

/**
 * 从一组 .c 路径里挑出「入口源文件」。
 * 优先级：main.c（根目录优先） > 任何定义了 main() 的 .c > null（保持默认）
 */
function detectEntrySource(cFiles, contents) {
  const text = new TextDecoder('utf-8', { fatal: false });
  const mains = cFiles.filter((n) => /(^|\/)main\.c$/i.test(n));
  if (mains.length) return mains.sort((a, b) => a.split('/').length - b.split('/').length)[0];
  const MAIN_RE = /(?:^|\n)[ \t]*(?:int|void|long|short|unsigned[ \t]+int|int32|uint32)?[ \t\n]*main[ \t]*\(/;
  for (const n of cFiles) {
    const src = stripCComments(text.decode(contents[n]));
    if (MAIN_RE.test(src)) return n;
  }
  return null;
}

/** 去掉 /*...*​/ 与 //... 注释，避免把注释里的 "int main(" 当成入口 */
function stripCComments(src) {
  // 先剥块注释（非贪婪，跨行），再剥行注释。字符串字面量里的 "/*" 极少见，
  // 对"判断哪个文件是入口"这个用途，误剥的代价远小于误判入口。
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}

/**
 * 把一批外来文件铺进工程。
 *
 * @param {File[]} fileList 选择文件 / 拖拽 / 选择文件夹 拿到的 File 列表
 * @param {{fromFolder?: boolean}} [opts] `fromFolder=true` 时按 `webkitRelativePath`
 *        取路径（「选择文件夹」用），公共顶层目录名由 `relativeNames()` 剥掉。
 *
 * 两种来源的差别只有一处：**文件夹导入不解压 `.zip`** —— 一个装着发布包的
 * 工程目录整个铺进来时，不该顺手把里面的 zip 炸开；要解压就单独把 zip 拖进来。
 *
 * 路径规则（剥公共顶层目录、跳过哪些垃圾文件）在 assets/ingest.js，
 * 与单测共用同一份实现。
 */
async function ingestFiles(fileList, { fromFolder = false } = {}) {
  let items;
  // 按选中目录里的 .gitignore 判定要跳过的（只对「选择文件夹」生效）
  let giIgnored = new Set();
  let giDirs = [];
  if (fromFolder) {
    // webkitRelativePath 形如 "myapp/src/base.c"：剥掉选中目录名后，
    // 剩下的相对路径就是工程内的路径
    const raw = [...fileList].map((f) => f.webkitRelativePath || f.name);
    const names = relativeNames(raw);
    items = [...fileList].map((f, i) => ({ f, name: names[i] }));

    /*
     * 先读 .gitignore —— 多数人不想把 node_modules / build / dist 这类
     * 「本来就不入库」的东西铺进工程，而它们恰恰写在 .gitignore 里。
     * .gitignore 自身是隐藏文件、不会进工程（isJunkEntry 会跳过它），
     * 但它的规则要遵守；子目录里的 .gitignore 也一起读（越深越优先）。
     */
    const gis = [];
    const giErrors = [];
    for (const it of items) {
      const n = it.name;
      if (!n || gis.length >= 20 || !/(^|\/)\.gitignore$/.test(n)) continue;
      try {
        const dir = n.includes('/') ? n.slice(0, n.lastIndexOf('/')) : '';
        gis.push({ dir, rules: parseGitignore(await it.f.text()) });
      } catch (e) {
        // 读不了就跳过这一份，但要说出来 —— 否则「规则怎么没生效」要查半天
        giErrors.push(`${n}（${e.message}）`);
      }
    }
    if (giErrors.length) {
      writeLine(`  ⚠ ${giErrors.length} 份 .gitignore 没读成功：${giErrors.join('、')}；本次不按它过滤`);
    }
    if (gis.some((g) => g.rules.length)) {
      giIgnored = applyGitignore(items.map((it) => it.name), gis);
      if (giIgnored.size) {
        // 排序后取前几个：日志与文件顺序无关，同一份工程每次都一样
        giDirs = [...new Set([...giIgnored].map((n) => n.split('/')[0]))].sort().slice(0, 4);
      }
    }
  } else {
    items = [...fileList].map((f) => ({ f, name: f.name }));
  }

  // 被跳过的分两类报给用户：系统/隐藏文件（外层的 + zip 内部的）、.gitignore 命中项
  const requested = items.length;
  let skipped = 0;
  let giSkipped = 0;
  const keptItems = [];
  for (const it of items) {
    if (!it.name || isJunkEntry(it.name)) {
      skipped++;
      continue;
    }
    if (giIgnored.has(it.name)) {
      giSkipped++;
      continue;
    }
    keptItems.push(it);
  }
  items = keptItems;

  const plain = [];
  let zipCount = 0;
  let zipFiles = 0;
  let detectedEntry = null;

  for (const it of items) {
    if (fromFolder || !/\.zip$/i.test(it.name)) {
      plain.push(it);
      continue;
    }

    // zip 源码包：解开铺进工程，并顺手判断入口源文件
    let entries;
    try {
      entries = await unzip(new Uint8Array(await it.f.arrayBuffer()));
    } catch (e) {
      writeLine(`\n✗ 解开 ${it.name} 失败：${e.message}`);
      continue;
    }

    const rawNames = Object.keys(entries);
    const keptNames = rawNames.filter((n) => !isJunkEntry(n));
    skipped += rawNames.length - keptNames.length;
    const names = relativeNames(keptNames);

    const contents = {};
    for (let i = 0; i < names.length; i++) {
      const data = entries[keptNames[i]]; // 与 names 一一对应（keptNames 才是过滤后的）
      contents[names[i]] = data;
      // demo 包里带回来的模板 Makefile 不当「用户文件」看（见 isTemplateMakefile）：
      // 否则它会挡住站点上那份（带引擎预编译逻辑）的注入 → 之后每次编译都全量重编。
      if (await isTemplateMakefile(names[i], data)) {
        state.overrides.delete(names[i]);
        state.uploaded.delete(names[i]);
        state.fromGuest.add(names[i]);
        continue;
      }
      state.overrides.set(names[i], data);
      state.fromGuest.delete(names[i]); // 外来内容，内容和虚拟机里那份无关，要推
      state.uploaded.add(names[i]);
    }

    zipCount++;
    zipFiles += names.length;
    const picked = detectEntrySource(
      names.filter((n) => /\.c$/i.test(n)),
      contents
    );
    if (picked) detectedEntry = picked;
  }

  // 普通文件（含「选择文件夹」铺进来的）：顺便看一眼哪个是入口源文件。
  // 候选按名字排一遍，免得结果随操作系统的目录顺序变（同一份工程每次导入都一样）。
  const cContents = {};
  for (const it of plain) {
    const data = new Uint8Array(await it.f.arrayBuffer());
    if (/\.c$/i.test(it.name)) cContents[it.name] = data;
    if (await isTemplateMakefile(it.name, data)) {
      state.overrides.delete(it.name);
      state.uploaded.delete(it.name);
      state.fromGuest.add(it.name);
      continue;
    }
    state.overrides.set(it.name, data);
    state.fromGuest.delete(it.name);
    state.uploaded.add(it.name);
  }
  if (!detectedEntry) {
    const cFiles = Object.keys(cContents).sort();
    if (cFiles.length) detectedEntry = detectEntrySource(cFiles, cContents);
  }

  // 有新资源进来就重算默认勾选
  state.packResTouched = false;
  renderFiles();
  refreshPackButton();

  if (zipCount) {
    writeLine(`\n已解开 ${zipCount} 个 zip 包，共 ${zipFiles} 个文件铺进工程`);
  } else if (fromFolder) {
    writeLine(`\n已从文件夹读取 ${plain.length} 个文件铺进工程（编译时同步进虚拟机）`);
  } else {
    writeLine(`\n已载入 ${plain.length} 个文件到工程（编译时同步进虚拟机）`);
  }
  const skippedParts = [];
  if (skipped > 0) skippedParts.push(`系统/隐藏文件 ${skipped} 个（.git、.DS_Store 之类）`);
  if (giSkipped > 0) {
    skippedParts.push(
      `.gitignore 命中 ${giSkipped} 项（${giDirs.join('、')}${giDirs.length ? ' 等' : ''}）`
    );
  }
  if (skippedParts.length) writeLine(`  已跳过：${skippedParts.join('；')}`);
  if (detectedEntry) {
    el.optApp.value = detectedEntry;
    writeLine(`  入口源文件已自动设为 ${detectedEntry}`);
  } else if (zipCount) {
    writeLine('  没找到 main.c 或带 main() 的源文件，入口保持 helloworld.c');
  }
  const res = [...state.overrides.keys()].filter(isResourceCandidate);
  if (res.length) writeLine(`  其中 ${res.length} 个是资源，打包 .mrp 时会默认带上`);
  if (state.overrides.get(PACK_ELF) && !state.artifact) {
    writeLine(`  检测到 bin.elf，可以直接点「打包 .mrp」，不必重新编译`);
  }
}

el.fileInput.onchange = () => {
  if (el.fileInput.files?.length) ingestFiles([...el.fileInput.files]);
  el.fileInput.value = '';
};

// 「选择文件夹」：按 webkitRelativePath 还原目录结构铺进工程（跳过 .git 等隐藏项）
el.dirInput.onchange = () => {
  if (el.dirInput.files?.length) ingestFiles([...el.dirInput.files], { fromFolder: true });
  el.dirInput.value = '';
};

['dragenter', 'dragover'].forEach((ev) =>
  el.drop.addEventListener(ev, (e) => {
    e.preventDefault();
    el.drop.classList.add('over');
  })
);
['dragleave', 'drop'].forEach((ev) =>
  el.drop.addEventListener(ev, (e) => {
    e.preventDefault();
    el.drop.classList.remove('over');
  })
);
el.drop.addEventListener('drop', (e) => {
  /*
   * 拖拽只能拿到「条目」，文件夹要递归读 —— 这里不做，只识别出来提示用
   * 「选择文件夹」按钮：否则它会被当成一个 0 字节的普通文件塞进工程
   * （名字就是文件夹名）。
   * 取文件仍然走 dataTransfer.files（原路径，最稳），只在检测到文件夹时
   * 把同名 0 字节的条目排掉。
   */
  const dirNames = new Set();
  for (const it of e.dataTransfer?.items || []) {
    if (it.kind !== 'file') continue;
    const entry = it.webkitGetAsEntry?.();
    if (entry?.isDirectory) dirNames.add(entry.name);
  }
  if (dirNames.size) {
    writeLine(
      `\n检测到 ${dirNames.size} 个文件夹（${[...dirNames].join('、')}）—— 拖拽请用 zip 包，` +
        '整个文件夹请点左上角「选择文件夹」'
    );
  }
  const files = [...(e.dataTransfer?.files || [])].filter(
    (f) => !(f.size === 0 && dirNames.has(f.name))
  );
  if (files.length) ingestFiles(files);
});

// 初始状态
setPhase('off', '环境未启动');
renderEditor(); // 行号槽 / 着色层的初始状态（空）
