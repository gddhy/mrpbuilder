/**
 * 单测主题（浅色 / 深色）—— assets/theme.js + assets/style.css + 两处内联脚本。
 *
 * 为什么值得单独测：
 *   1. 主题的判定规则有三条（跟随系统 / 手动优先 / 记住上次），组合起来容易漏一种；
 *      而"漏了"的表现往往是**别人机器上才复现**（对方系统是深色才会暴露）。
 *   2. 深色是一整套颜色变量，漏定义某个变量不会报错，只会在深色下渲染出浅色底或透明，
 *      很难靠肉眼逐个发现 —— 所以这里直接对两套调色板做集合比对。
 *   3. data-theme 要在**首屏渲染前**就打好（否则先白一下再变深色），
 *      所以 index.html / 404.html 里各有一份等价的极小内联脚本：它们是重复逻辑，
 *      这里钉死"两处必须用同一个存储键 / 同一个媒体查询"，防止哪天改了一边。
 *
 * 不需要浏览器：theme.js 对 DOM 的依赖只有 documentElement.setAttribute、
 * matchMedia、addEventListener、localStorage 四样，下面用最小影子顶掉即可。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failed = 0;
function ok(name, pass, detail = '') {
  if (!pass) failed++;
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
}

const STORAGE_KEY = 'mrp-theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';
/** theme.js 里的过渡时长（摘掉过渡类的定时器按它算），下面会和 CSS 对一次 */
const ANIM_MS = Number((/ANIM_MS\s*=\s*(\d+)/.exec(read('assets/theme.js')) || [])[1]);

// ---------------------------------------------------------------------------
// 最小 DOM 影子（只覆盖 theme.js 用到的那几样）
// ---------------------------------------------------------------------------

function installShadow() {
  const attrs = new Map();
  const store = new Map();
  const classes = new Set();
  const win = {
    systemDark: false,
    mqListeners: [],
    winListeners: [],
    storageWorks: true,
  };

  globalThis.document = {
    documentElement: {
      setAttribute: (k, v) => attrs.set(k, String(v)),
      getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
      removeAttribute: (k) => attrs.delete(k),
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c),
      },
    },
  };
  globalThis.window = {
    matchMedia: (q) => ({
      media: q,
      get matches() {
        return q === DARK_QUERY ? win.systemDark : false;
      },
      addEventListener: (t, fn) => {
        if (t === 'change') win.mqListeners.push(fn);
      },
      removeEventListener: () => {},
    }),
    addEventListener: (t, fn) => win.winListeners.push([t, fn]),
  };
  globalThis.localStorage = {
    getItem: (k) => {
      if (!win.storageWorks) throw new Error('storage disabled');
      return store.has(k) ? store.get(k) : null;
    },
    setItem: (k, v) => {
      if (!win.storageWorks) throw new Error('storage disabled');
      store.set(k, String(v));
    },
    removeItem: (k) => {
      if (!win.storageWorks) throw new Error('storage disabled');
      store.delete(k);
    },
  };

  return {
    win,
    store,
    theme: () => attrs.get('data-theme'),
    animOn: () => classes.has('theme-anim'),
    fireSystemChange: () => win.mqListeners.forEach((fn) => fn({ matches: win.systemDark })),
    fireStorage: (key) => win.winListeners.filter(([t]) => t === 'storage').forEach(([, fn]) => fn({ key })),
  };
}

const S = installShadow();
const theme = await import(pathToFileURL(path.join(ROOT, 'assets', 'theme.js')).href);

// 假的切换按钮：theme.js 只往里写 title / aria-label
function makeButton() {
  return {
    title: '',
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
  };
}

console.log('===== theme.js 判定规则 =====');

// 1. 没存过偏好 → 跟随系统
S.win.systemDark = true;
ok('没存过偏好时不写任何值', theme.getThemeMode() === null);
ok('跟随系统：系统深色 → 深色', theme.resolveTheme() === 'dark');

S.win.systemDark = false;
ok('跟随系统：系统浅色 → 浅色', theme.resolveTheme() === 'light');

// 2. 初始化写属性 + 按钮文案
S.win.systemDark = true;
const btn = makeButton();
theme.initTheme(btn);
ok('初始化把生效主题写进 data-theme', S.theme() === 'dark', `data-theme=${S.theme()}`);
ok('按钮提示指向反方向（深色下提示去浅色）', btn.title === '切换到浅色模式（当前跟随系统）', btn.title);

// 3. 点一下 → 以"看到的样子"取反并落盘
const next = theme.toggleTheme();
ok('系统深色下首次点击 → 浅色', next === 'light' && S.theme() === 'light');
ok('手动选择写入 localStorage', S.store.get(STORAGE_KEY) === 'light', String(S.store.get(STORAGE_KEY)));
ok('手动选择后按钮不再说"跟随系统"', btn.title === '切换到深色模式', btn.title);

// 3b. 过渡类：切换时挂上、ANIM_MS + 80ms 后自行摘掉（避免 hover 一直发黏）
ok('切换期间挂上过渡类（CSS 靠它才做渐变）', S.animOn());
await new Promise((r) => setTimeout(r, ANIM_MS + 200));
ok('过渡结束后摘掉过渡类', !S.animOn());

// 4. 手动优先：系统再怎么变都不覆盖
S.win.systemDark = true;
S.fireSystemChange();
ok('手动选择优先：系统变化不覆盖', S.theme() === 'light');
ok('再点一次 → 深色', theme.toggleTheme() === 'dark' && S.store.get(STORAGE_KEY) === 'dark');

// 5. 跨标签页同步
S.store.set(STORAGE_KEY, 'light');
S.fireStorage(STORAGE_KEY);
ok('其他标签页改偏好会同步过来', S.theme() === 'light');
S.store.set('other-key', 'x');
S.fireStorage('other-key');
ok('无关的 key 不触发主题变化（保持原样）', S.theme() === 'light');

// 6. 清除偏好 → 重新跟随系统
S.store.delete(STORAGE_KEY);
S.win.systemDark = true;
S.fireSystemChange();
ok('清除偏好后重新跟随系统（深色）', S.theme() === 'dark');
S.win.systemDark = false;
S.fireSystemChange();
ok('跟随系统时系统切换能实时跟上', S.theme() === 'light');

// 7. 脏数据 / 存储不可用不能炸
S.store.set(STORAGE_KEY, 'blue');
ok('非法存储值当没选过（跟随系统）', theme.getThemeMode() === null);
S.store.delete(STORAGE_KEY);
S.win.systemDark = true;
S.win.storageWorks = false;
let threw = false;
try {
  theme.initTheme(makeButton());
} catch {
  threw = true;
}
ok('localStorage 不可用时不抛异常', !threw);
ok('localStorage 不可用时退化为跟随系统', S.theme() === 'dark');
S.win.storageWorks = true;

// ---------------------------------------------------------------------------
// 调色板与"不许有字面颜色"
// ---------------------------------------------------------------------------

console.log('\n===== style.css 调色板 =====');

const css = read('assets/style.css');
const noComment = css.replace(/\/\*[\s\S]*?\*\//g, '');

function block(selectorText) {
  const i = noComment.indexOf(selectorText);
  if (i < 0) return null;
  const start = noComment.indexOf('{', i);
  const end = noComment.indexOf('}', start);
  return noComment.slice(start + 1, end);
}
const varsOf = (body) =>
  new Map(
    [...(body || '').matchAll(/(--[a-z-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()])
  );

const lightBody = block(':root');
const darkBody = block(':root[data-theme="dark"]');
ok('存在 :root 浅色调色板', !!lightBody);
ok('存在 :root[data-theme="dark"] 深色调色板', !!darkBody);

const light = varsOf(lightBody);
const dark = varsOf(darkBody);

// 字体栈与主题切换时序都与主题无关，只在 :root 里定义一次（深色块继承即可），不算漏定义。
// 除了这几个，其余变量都必须在两套调色板里成对出现。
const SHARED_VARS = new Set(['--mono', '--sans', '--theme-fade', '--theme-ink-delay']);

const onlyLight = [...light.keys()].filter((k) => !dark.has(k) && !SHARED_VARS.has(k));
const onlyDark = [...dark.keys()].filter((k) => !light.has(k) && !SHARED_VARS.has(k));
ok('两套调色板变量完全同名（漏一个 = 深色下取到浅色值）',
  onlyLight.length === 0 && onlyDark.length === 0,
  [onlyLight.length ? `缺深色: ${onlyLight.join(',')}` : '', onlyDark.length ? `多余: ${onlyDark.join(',')}` : ''].filter(Boolean).join('  '));
ok('共用变量（字体栈 / 切换时序）在浅色块里有定义',
  [...SHARED_VARS].every((k) => light.has(k)),
  [...SHARED_VARS].filter((k) => light.has(k)).join(', '));

ok('深色的背景与正文颜色确实换了一套',
  light.get('--bg') !== dark.get('--bg') && light.get('--text') !== dark.get('--text'),
  `${light.get('--bg')}/${light.get('--text')} → ${dark.get('--bg')}/${dark.get('--text')}`);
ok('深色下 --accent 提亮了（深色底上要有足够对比度）',
  dark.get('--accent') !== light.get('--accent') && dark.get('--accent-soft') !== light.get('--accent-soft'));

// 变量即颜色常量：组件样式里出现字面颜色 = 加主题时必漏
const stripped = noComment
  .replace(block(':root') || '', '')
  .replace(block(':root[data-theme="dark"]') || '', '');
const literals = [...stripped.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/g)].map((m) => m[0]);
ok('调色板块之外没有字面颜色（一律走 var()）', literals.length === 0,
  literals.length ? `出现 ${literals.length} 处: ${[...new Set(literals)].join(' ')}` : '');

// 用到的每个变量都得有定义，否则静默失效（继承成父级的颜色）
const used = new Set([...noComment.matchAll(/var\((--[a-z-]+)/g)].map((m) => m[1]));
const undefinedVars = [...used].filter((v) => !light.has(v));
ok('用到的 CSS 变量都有定义', undefinedVars.length === 0, undefinedVars.join(', '));

// ---------------------------------------------------------------------------
// 三处内联脚本 / 按钮位置（防规则漂移）
// ---------------------------------------------------------------------------

console.log('\n===== 内联防闪脚本与按钮 =====');

const indexHtml = read('index.html');
const notFound = read('404.html');

ok('index.html 有防闪内联脚本（首屏前打 data-theme）',
  indexHtml.includes('setAttribute(\'data-theme\'') && indexHtml.includes(STORAGE_KEY));
ok('404.html 也跟随同一份偏好', notFound.includes('setAttribute(\'data-theme\'') && notFound.includes(STORAGE_KEY));
for (const [name, html] of [['index.html', indexHtml], ['404.html', notFound]]) {
  ok(`${name} 内联脚本用同一媒体查询`, html.includes(`'${DARK_QUERY}'`));
}

const themeJs = read('assets/theme.js');
ok('theme.js 与内联脚本同键同查询',
  themeJs.includes(`'${STORAGE_KEY}'`) && themeJs.includes(`'${DARK_QUERY}'`));

// 顺序：切换按钮在「帮助」后面
const iHelp = indexHtml.indexOf('id="btnHelp"');
const iTheme = indexHtml.indexOf('id="btnTheme"');
ok('切换按钮排在「帮助」按钮之后', iHelp > 0 && iTheme > iHelp, `帮助@${iHelp} 主题@${iTheme}`);
ok('切换按钮是纯图标（含日/月两个 svg）',
  indexHtml.includes('ico-sun') && indexHtml.includes('ico-moon'));
ok('app.js 已接线 theme.js（点按钮真的会切）',
  read('assets/app.js').includes("from './theme.js'") && read('assets/app.js').includes('toggleTheme'));

// ---------------------------------------------------------------------------
// 顶栏图标按钮的尺寸 + 切换过渡
// ---------------------------------------------------------------------------

console.log('\n===== 顶栏按钮尺寸与切换过渡 =====');

// 图标按钮必须和旁边那排文字按钮一样大（用户反馈过"小一号"）。
// 做法是与 .btn 共用内边距 + 用零宽撑高块占住"一行行高"，所以这里逐条钉住。
const btnBlock = block('.btn') || '';
const iconBlock = block('.btn.icon') || '';
const iconStrut = block('.btn.icon::before') || '';
const iconSvg = block('.btn.icon .ico') || '';

const decl = (body, prop) => {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(body.replace(/\s+/g, ' '));
  return m ? m[1].trim() : '';
};

ok('.btn.icon 的内边距与 .btn 相同', !!iconBlock && decl(iconBlock, 'padding') === decl(btnBlock, 'padding'),
  `图标按钮=${decl(iconBlock, 'padding')} 文字按钮=${decl(btnBlock, 'padding')}`);
ok('.btn.icon 用 grid 居中（图标不会偏心）',
  /inline-grid/.test(iconBlock) && /place-items\s*:\s*center/.test(iconBlock), iconBlock.replace(/\s+/g, ' ').slice(0, 60));
ok('.btn.icon 靠"一行行高"撑高，没写死像素',
  /1lh/.test(iconStrut) && !/height\s*:\s*\d+px/.test(iconBlock),
  `撑高块=${decl(iconStrut, 'height') || '(缺)'}`);
ok('撑高块留了 1.6em 兜底（老浏览器不认 lh 单位）', /1\.6em/.test(iconStrut) || /1\.6em/.test(iconStrut.replace('1lh', '')));
ok('图标尺寸固定 14px', decl(iconSvg, 'width') === '14px' && decl(iconSvg, 'height') === '14px',
  `${decl(iconSvg, 'width')}×${decl(iconSvg, 'height')}`);

// 日月图标必须"叠着 + opacity 切换"，不能用 display 切换：
// 从 display:none 变可见的元素**不会启动过渡**（规范如此），图标颜色就会在第一帧定死，
// 落在还没暗下来的底色上 —— 那正是用户反馈的"图标在闪"。
const sunRule = block('.btn.icon .ico-sun') || '';
const darkSunRule = block(':root[data-theme="dark"] .btn.icon .ico-sun') || '';
const darkMoonRule = block(':root[data-theme="dark"] .btn.icon .ico-moon') || '';
ok('日月图标叠在同一格（grid-area 相同）', /grid-area/.test(iconSvg) && /grid-area/.test(iconStrut));
ok('图标显隐用 opacity，不用 display',
  decl(sunRule, 'opacity') === '0' && decl(darkSunRule, 'opacity') === '1' && decl(darkMoonRule, 'opacity') === '0' &&
    !/display\s*:\s*none/.test(sunRule + darkSunRule + darkMoonRule),
  `浅色 sun=${decl(sunRule, 'opacity')} / 深色 sun=${decl(darkSunRule, 'opacity')} moon=${decl(darkMoonRule, 'opacity')}`);
ok('图标自己持有墨色并让画笔跟随自己（不靠父级 currentColor 继承）',
  /color\s*:\s*var\(--text\)/.test(iconSvg) && /stroke\s*:\s*currentColor/.test(iconSvg),
  iconSvg.replace(/\s+/g, ' ').slice(-60));

// 切换过渡：只过渡颜色类属性（transition: all 会把布局属性也带上，弹窗会"滑"）
const animBlock = block(':root.theme-anim *') || '';
const animProps = decl(animBlock, 'transition');
ok('存在 :root.theme-anim 过渡声明', !!animBlock);
ok('过渡覆盖背景 / 边框 / 投影（表面渐变）',
  ['background-color', 'border-color', 'box-shadow'].every((p) => animProps.includes(p)),
  animProps.replace(/\s+/g, ' ') || '(空)');
ok('过渡不含 all / 布局属性（否则会带动位移）',
  !/\ball\b/.test(animProps) && !/width|height|padding|margin/.test(animProps));
// 墨色不能跟着淡：深浅两套的墨色与底色亮度是反的，同时淡必然在中途"墨色≈底色"
// （实测对比度掉到 1.03:1 = 内容整片消失再回来，就是"闪"）。改成到点跳变。
ok('墨色（color）是"0s + 延迟"的跳变，不是淡入淡出',
  /(?:^|,\s*)color 0s linear var\(--theme-ink-delay\)/.test(animProps.replace(/\s+/g, ' ')),
  ((/(?:^|,\s*)color[^,]*/.exec(animProps.replace(/\s+/g, ' ')) || ['(缺 color)'])[0].replace(/^,\s*/, '')));
ok('日月图标的 opacity 也跟着同一次跳变',
  /opacity 0s linear var\(--theme-ink-delay\)/.test(animProps.replace(/\s+/g, ' ')));
const reduceBlock = block('@media (prefers-reduced-motion: reduce)') || '';
ok('减少动态效果时关掉过渡（无障碍）', /transition\s*:\s*none/.test(reduceBlock), reduceBlock.replace(/\s+/g, ' ').slice(-24));

// 时序三处必须自洽：CSS 变量 ↔ theme.js 的 ANIM_MS，且跳变要早于渐变结束
const fadeSec = parseFloat(light.get('--theme-fade') || '');
const inkSec = parseFloat(light.get('--theme-ink-delay') || '');
ok('--theme-fade 与 theme.js 的 ANIM_MS 一致',
  Number.isFinite(fadeSec) && ANIM_MS === Math.round(fadeSec * 1000),
  `CSS ${light.get('--theme-fade')} vs theme.js ${ANIM_MS}ms`);
ok('墨色跳变早于表面渐变结束（否则会出现"墨色≈底色"的糊片瞬间）',
  Number.isFinite(inkSec) && Number.isFinite(fadeSec) && inkSec < fadeSec,
  `ink ${light.get('--theme-ink-delay')} < fade ${light.get('--theme-fade')}`);

ok('theme.js 挂着过渡类（切完会摘掉）',
  /classList\.add\('theme-anim'\)/.test(themeJs) && /classList\.remove\('theme-anim'\)/.test(themeJs));
ok('首屏初始化不会白挂一次过渡类（值没变就不该开过渡）',
  /getAttribute\('data-theme'\)\s*!==\s*theme/.test(themeJs));

console.log(`\n${failed ? `${failed} 项失败` : '全部通过'}`);
process.exit(failed ? 1 : 0);
