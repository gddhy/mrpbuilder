/**
 * 浅色 / 深色主题。
 *
 * 规则（三条，和顶栏那个切换按钮的行为一一对应）：
 *   1. 没手动选过 → 跟随浏览器（prefers-color-scheme），系统切深色页面就跟着变；
 *   2. 手动选过 → 以手动选择为准，写进 localStorage，下次打开直接恢复；
 *      此时不再跟随系统（系统深色下手动选浅色是合法状态，不该被系统覆盖）；
 *   3. 手动选择只记 'light' / 'dark' 两个值，「没选过」= 存储里没这个 key，
 *      所以「跟随系统」不需要额外的第三种状态值。
 *
 * 落地方式：把**生效值**写到 <html data-theme="light|dark">，
 * 样式侧所有颜色都走 CSS 变量，深色取值集中在 style.css 的 :root[data-theme="dark"]。
 *
 * 首屏防闪：index.html <head> 里有一段等价的内联脚本，在首次渲染前就把属性打上，
 * 否则会出现「先白一下再变深色」。这里不重复那段逻辑，只做同一套规则的后续同步
 * （按钮文案、系统主题变化、跨标签页改偏好）。
 */

const STORAGE_KEY = 'mrp-theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';
/**
 * 过渡时长，必须与 style.css 的 --theme-fade 一致（tools/test-theme.mjs 会对这两个数）。
 * 墨色是"到点跳变"（--theme-ink-delay 处用 0s 过渡），所以只要等表面渐变跑完即可。
 */
const ANIM_MS = 280;

/** 切换按钮（由 initTheme 注入；没有按钮时模块照样能用） */
let btnEl = null;
/** 摘掉过渡类的定时器 */
let animTimer = null;

/** 用户手动选择的值：'light' | 'dark'；没选过 / 存储不可用 → null（= 跟随系统） */
export function getThemeMode() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    // 隐私模式等场景下 localStorage 会直接抛异常：当成「没选过」，跟随系统
    return null;
  }
}

function saveThemeMode(mode) {
  try {
    if (mode === 'light' || mode === 'dark') localStorage.setItem(STORAGE_KEY, mode);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

function prefersDark() {
  try {
    return !!window.matchMedia && window.matchMedia(DARK_QUERY).matches;
  } catch {
    return false;
  }
}

/** 最终生效的主题：手动选择优先，其次系统 */
export function resolveTheme(mode = getThemeMode()) {
  return mode || (prefersDark() ? 'dark' : 'light');
}

/**
 * 切换按钮点击：以「当前看到的样子」取反，而不是以存储值为基准。
 * 这样系统深色 + 首次点击 → 浅色（符合直觉：看到深色，点一下变浅色）。
 */
export function toggleTheme() {
  const next = resolveTheme() === 'dark' ? 'light' : 'dark';
  saveThemeMode(next);
  applyTheme(next);
  return next;
}

/**
 * 初始化：同步一次当前主题（内联脚本已打过，这里幂等），
 * 挂上「系统主题变化」与「其他标签页改了偏好」两个监听。
 * @param {HTMLElement} [button] 切换按钮；只在点击之外多做一件事——同步它的提示文案
 */
export function initTheme(button = null) {
  btnEl = button;
  applyTheme(resolveTheme());

  const mq = window.matchMedia ? window.matchMedia(DARK_QUERY) : null;
  if (mq) {
    const onChange = () => {
      // 只有「跟随系统」时才跟着变；手动选过就以用户为准
      if (!getThemeMode()) applyTheme(resolveTheme());
    };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange); // 老 Safari
  }

  // 跨标签页：另一个标签页改了偏好，本页跟着走（storage 事件不会在本页触发）
  window.addEventListener('storage', (e) => {
    if (e.key === null || e.key === STORAGE_KEY) applyTheme(resolveTheme());
  });
}

/**
 * 应用主题：写 data-theme（颜色）+ 同步按钮文案。
 * 按钮图标不用 JS 管 —— 日/月两个 <svg> 都在 DOM 里，
 * 由 CSS 依 data-theme 决定显哪一个（见 style.css 的 .btn.icon）。
 */
function applyTheme(theme) {
  const root = document.documentElement;

  // 只在"真的换了主题"时开过渡（样式见 style.css 的 :root.theme-anim）：
  // 首屏初始化时值没变，就不该白挂一次过渡类 —— 否则那一瞬间 hover 会跟着变慢。
  // 类与属性在同一次样式计算里一起变，所以过渡会正常触发。
  if (root.getAttribute('data-theme') !== theme) {
    root.classList.add('theme-anim');
    clearTimeout(animTimer);
    animTimer = setTimeout(() => root.classList.remove('theme-anim'), ANIM_MS + 80);
  }

  root.setAttribute('data-theme', theme);
  if (!btnEl) return;

  const label = theme === 'dark' ? '切换到浅色模式' : '切换到深色模式';
  const hint = getThemeMode() ? '' : '（当前跟随系统）';
  btnEl.title = label + hint;
  btnEl.setAttribute('aria-label', label);
}
