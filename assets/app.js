/**
 * MRP 纯前端编译环境 —— 界面逻辑
 *
 * 编译本身由 assets/vm.js 里的 MrpVm 完成（浏览器 / Node 共用同一份实现）：
 * 在浏览器里跑一台 32 位 Linux（v86），通过 9p 把工具链和源码送进去，
 * 再把 bin.elf 取回来。全程不联网、不需要后端。
 */

import { MrpVm } from './vm.js';
import { unzip } from './zip.js';
import { fmtBytes } from './bytes.js'; // 体积文案（B/KB/MB 自动换算），与命令行共用同一份
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
  fileList: $('fileList'),
  editor: $('editor'),
  editorHint: $('editorHint'),
  drop: $('drop'),
  console: $('console'),
  optApp: $('optApp'),
  optExtra: $('optExtra'),
};

const state = {
  vm: null,
  phase: 'off',        // off | boot | ready | err
  template: [],        // 镜像内置模板里的相对路径
  overrides: new Map(),// 相对路径 -> Uint8Array（用户上传/编辑过的）
  uploaded: new Set(), // 真正由用户上传/拖入的文件（用于挑「资源」）
  shell: new Map(),    // 壳文件字节缓存（lib/start.mr、lib/cfunction.ext）
  packRes: new Set(),  // 打包时勾选的资源
  packResTouched: false,
  selected: null,
  artifact: null,
  busy: false,
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
  state.logBuf.push(text);
  if (!flushTimer) flushTimer = setTimeout(flush, 80);
}

function writeLine(text) {
  state.logBuf.push(text + '\n');
  if (!flushTimer) flushTimer = setTimeout(flush, 80);
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
}

function setBusy(on) {
  state.busy = on;
  el.btnBuild.disabled = on || state.phase !== 'ready';
  el.btnBoot.disabled = on || state.phase === 'boot' || state.phase === 'ready';
}

// ---------------------------------------------------------------------------
// 文件列表
// ---------------------------------------------------------------------------

function allFiles() {
  const names = new Set(state.template);
  for (const k of state.overrides.keys()) names.add(k);
  return [...names].sort();
}

function renderFiles() {
  el.fileList.innerHTML = '';
  for (const name of allFiles()) {
    const li = document.createElement('li');
    li.setAttribute('aria-selected', String(name === state.selected));
    const label = document.createElement('span');
    label.textContent = name;
    const tag = document.createElement('span');
    const edited = state.overrides.has(name);
    tag.className = 'tag' + (edited ? ' new' : '');
    tag.textContent = edited ? '已修改' : '模板';
    li.append(label, tag);
    li.onclick = () => selectFile(name);
    el.fileList.append(li);
  }
}

async function selectFile(name) {
  state.selected = name;
  renderFiles();

  // 二进制资源不走编辑器：按 UTF-8 拆一份再保存回去会把内容改坏
  if (isBinaryName(name)) {
    el.editor.value = '';
    const inPack = isResourceCandidate(name);
    el.editorHint.textContent =
      `${name} —— 二进制资源，不在编辑器里打开` +
      (inPack ? '（打包 .mrp 时会按原样带上）' : '');
    return;
  }

  if (state.overrides.has(name)) {
    el.editor.value = new TextDecoder().decode(state.overrides.get(name));
    el.editorHint.textContent = `${name}（已修改，编译时写入虚拟机）`;
    return;
  }
  if (state.phase !== 'ready') {
    el.editor.value = '';
    el.editorHint.textContent = `${name} —— 先启动编译环境才能读取模板内容`;
    return;
  }
  el.editorHint.textContent = `正在读取 ${name} …`;
  try {
    const bytes = await state.vm.readProjectFile(name);
    state.overrides.set(name, bytes);
    el.editor.value = new TextDecoder().decode(bytes);
    el.editorHint.textContent = `${name}（已从模板载入）`;
    renderFiles();
  } catch (e) {
    el.editorHint.textContent = `读取失败：${e.message}`;
  }
}

function saveEditor() {
  if (!state.selected) return;
  if (isBinaryName(state.selected)) return; // 二进制资源不经过编辑器，避免被改坏
  state.overrides.set(state.selected, new TextEncoder().encode(el.editor.value));
  renderFiles();
  el.editorHint.textContent = `${state.selected}（已修改，编译时写入虚拟机）`;
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

let rootfsCache = null;

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

/** sha256 → hex。非安全上下文（file:// 或局域网 http）没有 crypto.subtle，返回 null */
async function sha256Hex(bytes) {
  if (!globalThis.crypto?.subtle) return null;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 下载工具链镜像。
 * 优先读 rootfs.parts.json 按分段下载再拼合 —— Cloudflare Pages / EdgeOne Pages
 * 这类静态托管对单个文件有 25MB 上限，而镜像有 30.6 MiB，所以 make-image.py
 * 会把它按 20MiB 切开。拼好后校验总大小与 sha256（可用时），防止拼错或传输损坏。
 */
async function loadRootfs() {
  let manifest = null;
  try {
    const r = await fetch(new URL('image/rootfs.parts.json', ASSETS), { cache: 'no-store' });
    if (r.ok) manifest = await r.json();
  } catch {
    /* 没有清单就按单文件走 */
  }

  if (!manifest?.parts?.length) {
    const r = await fetch(URLS.rootfs);
    if (!r.ok) throw new Error(`工具链下载失败（HTTP ${r.status}）`);
    return new Uint8Array(await r.arrayBuffer());
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
    writeLine('  ⚠ sha256 与清单不符（若服务器对镜像做过转码可忽略，后续仍会校验）');
  } else if (hex) {
    writeLine('  sha256 校验通过');
  }
  return all;
}

async function boot() {
  if (state.phase === 'boot' || state.phase === 'ready') return;
  setPhase('boot', '正在启动 …');
  setBusy(true);
  clearConsole();
  writeLine('正在加载内核与工具链（首次约 1~3 分钟，取决于机器性能）…');

  try {
    // 先确认镜像文件都在，避免白等。
    // 工具链优先按分段清单校验（EdgeOne/CF Pages 等 25MB 限制的静态托管上
    // 完整 rootfs.tar.gz 根本不存在，HEAD 它必然 404）：有清单就逐段 HEAD，
    // 完全不碰完整镜像；没有清单才回退检查单文件。
    const mRes = await fetch(new URL('image/rootfs.parts.json', ASSETS), { cache: 'no-store' });
    const manifest = mRes.ok ? await mRes.json().catch(() => null) : null;
    const rootfsChecks = manifest?.parts?.length
      ? manifest.parts.map((p) => [`工具链分段 ${p.name}`, new URL(`image/${p.name}`, ASSETS).href])
      : [['工具链', URLS.rootfs]];
    for (const [label, url] of [['内核', URLS.kernel], ...rootfsChecks]) {
      const r = await fetch(url, { method: 'HEAD' });
      if (!r.ok) throw new Error(`${label}缺失（HTTP ${r.status}）`);
    }
  } catch (e) {
    setPhase('err', '镜像缺失');
    writeLine(`\n✗ ${e.message}`);
    writeLine('\n还没有生成虚拟机镜像。请在项目根目录运行：');
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
      writeLine('正在下载工具链镜像 …');
      rootfsCache = await loadRootfs();
      writeLine(`  收到 ${fmtBytes(rootfsCache.length)}`);
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

    state.template = await vm.listProjectFiles();
    state.overrides.clear();
    state.selected = null;
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
    const files = Object.fromEntries(state.overrides);
    // 用户没自带 Makefile 时，注入站点上最新的模板 Makefile（镜像里可能是旧版）
    if (!files['Makefile']) {
      const mk = await getTemplateMakefile();
      if (mk) files['Makefile'] = mk;
    }

    const res = await state.vm.build({
      files,
      app,
      target,
      extra,
    });

    if (!res.ok) {
      writeLine(`\n✗ 编译失败（make 返回 ${res.code}）`);
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
 * 滚轮兜底：正常浏览器里 .dlg-body（overflow:auto）天生响应鼠标滚轮，
 * 但部分宿主环境（预览 iframe 等）会把 wheel 事件吃掉，表现为电脑端
 * 只能拖滚动条、滚轮无反应（手机端触摸不受影响）。这里手动接管：
 * 指针在弹窗上时把 deltaY 落到 .dlg-body 的 scrollTop 上。
 * 内部还有自己可滚的区域（如「介绍」textarea）且没滚到头时先放行给它。
 */
function attachOverlayWheel(overlay) {
  overlay.addEventListener('wheel', (e) => {
    if (!e.deltaY) return;
    const dlg = e.target instanceof Element && e.target.closest('.dlg');
    if (!dlg) return; // 指针在遮罩上，不接管
    const body = dlg.querySelector('.dlg-body');
    if (!body) return;
    // 逐层向上找事件目标与 .dlg-body 之间有没有「自己还能滚」的元素
    let node = e.target;
    while (node instanceof Element && node !== body) {
      if (node.scrollHeight > node.clientHeight + 1) {
        const oy = getComputedStyle(node).overflowY;
        if (oy === 'auto' || oy === 'scroll') {
          const atTop = node.scrollTop <= 0;
          const atBottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
          if ((e.deltaY < 0 && !atTop) || (e.deltaY > 0 && !atBottom)) return;
        }
      }
      node = node.parentElement;
    }
    // Firefox 的滚轮是行单位（deltaMode=1），换算成像素
    const step = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
    const before = body.scrollTop;
    body.scrollTop = before + step;
    if (body.scrollTop !== before) e.preventDefault(); // 确实滚动了才拦默认行为
  }, { passive: false });
}
attachOverlayWheel(el.packOverlay);
attachOverlayWheel(el.helpOverlay);

/**
 * 环境自检：程序化 focus 后 activeElement 应该是输入框。
 * 不是 → 说明宿主环境（预览 iframe 等）在更底层拦截了焦点，
 * 在弹窗顶部明确提示，别让用户以为是自己点错了。
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

// 兜底：mousedown / touchstart 阶段就抢焦点（click 之前），部分宿主会吃掉
// mousedown 的默认行为导致 focus 不发生，这里手动补上。
el.packOverlay.querySelectorAll('input, textarea').forEach((inp) => {
  const grab = () => { try { inp.focus(); } catch {} };
  inp.addEventListener('mousedown', grab);
  inp.addEventListener('touchstart', grab, { passive: true });
});

// 点遮罩关闭由 attachOverlayDismiss() 统一接管（见 openPackOverlay 附近）。
// Escape 关闭（原生 <dialog> 自带这个行为，换成覆盖层后要自己接）：
// 打包弹窗在上层，先关它；它没开才轮到帮助弹窗。
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (el.packOverlay.classList.contains('show')) closePackOverlay();
  else if (el.helpOverlay.classList.contains('show')) closeHelpOverlay();
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

el.btnReset.onclick = () => {
  state.overrides.clear();
  state.uploaded.clear();
  state.shell.clear();
  state.packRes.clear();
  state.packResTouched = false;
  state.selected = null;
  el.editor.value = '';
  el.editorHint.textContent = '未选择文件';
  renderFiles();
};

el.editor.addEventListener('input', () => {
  clearTimeout(el.editor._t);
  el.editor._t = setTimeout(saveEditor, 600);
});

el.editor.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const s = el.editor.selectionStart;
    el.editor.setRangeText('    ', s, el.editor.selectionEnd, 'end');
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

/** 如果所有路径都以同一个顶层目录开头，返回该目录（含斜杠），否则返回空串 */
function commonRoot(names) {
  if (!names.length) return '';
  const first = names[0].split('/')[0];
  if (!first || !names.every((n) => n.startsWith(first + '/'))) return '';
  return first + '/';
}

async function ingestFiles(fileList) {
  const plain = [];
  let zipCount = 0;
  let zipFiles = 0;
  let detectedEntry = null;

  for (const f of fileList) {
    if (!/\.zip$/i.test(f.name)) {
      plain.push(f);
      continue;
    }

    // zip 源码包：解开铺进工程，并顺手判断入口源文件
    let entries;
    try {
      entries = await unzip(new Uint8Array(await f.arrayBuffer()));
    } catch (e) {
      writeLine(`\n✗ 解开 ${f.name} 失败：${e.message}`);
      continue;
    }

    const skip = (n) =>
      n.startsWith('__MACOSX/') || /(^|\/)(\.DS_Store|Thumbs\.db)$/i.test(n);
    const rawNames = Object.keys(entries).filter((n) => !skip(n));
    const prefix = commonRoot(rawNames);
    const names = rawNames.map((n) => (prefix ? n.slice(prefix.length) : n));

    const contents = {};
    for (let i = 0; i < names.length; i++) {
      const data = entries[rawNames[i]];
      contents[names[i]] = data;
      state.overrides.set(names[i], data);
      state.uploaded.add(names[i]);
    }

    zipCount++;
    zipFiles += names.length;
    detectedEntry = detectEntrySource(
      names.filter((n) => /\.c$/i.test(n)),
      contents
    );
  }

  for (const f of plain) {
    state.overrides.set(f.name, new Uint8Array(await f.arrayBuffer()));
    state.uploaded.add(f.name);
  }

  // 有新资源进来就重算默认勾选
  state.packResTouched = false;
  renderFiles();
  refreshPackButton();

  if (zipCount) {
    writeLine(`\n已解开 ${zipCount} 个 zip 包，共 ${zipFiles} 个文件铺进工程`);
    if (detectedEntry) {
      el.optApp.value = detectedEntry;
      writeLine(`  入口源文件已自动设为 ${detectedEntry}`);
    } else {
      writeLine('  没找到 main.c 或带 main() 的源文件，入口保持 helloworld.c');
    }
  } else {
    writeLine(`\n已载入 ${plain.length} 个文件到工程（编译时同步进虚拟机）`);
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
  const files = e.dataTransfer?.files;
  if (files?.length) ingestFiles([...files]);
});

// 初始状态
setPhase('off', '环境未启动');
