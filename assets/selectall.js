/**
 * `Ctrl/Cmd + A` 该全选谁 —— 纯决策函数（DOM 那半留在 app.js）。
 *
 * 需求（按「当前焦点」分流）：
 *   · 焦点在**可编辑文本**里（源码编辑窗 textarea / 任意输入框，含打包弹窗里的）
 *     → 放行浏览器原生全选：编辑窗就全选编辑窗、输入框就全选输入框；
 *   · 有弹窗（帮助 / 打包 .mrp）打开、但焦点不在输入框
 *     → **什么都不做**（别让它去全选底层页面）；
 *   · 其它情况
 *     → 全选「编译输出区」的文本，而不是整个网页。
 *
 * 决策抽在这里是为了能单测（假对象即可，不必开浏览器）；app.js 只负责
 * 读 `document.activeElement` / `.overlay.show` 和真正落地选区。
 */

/** `<input>` 里哪些 `type` 算「文本输入」（Ctrl+A 应当全选它自己的内容） */
const TEXT_INPUT_TYPES = [
  'text',
  'search',
  'url',
  'tel',
  'email',
  'password',
  'number',
  'date',
  'datetime-local',
  'month',
  'week',
  'time',
];

/**
 * 这个焦点元素是「可编辑文本」吗（Ctrl+A 该交给浏览器原生处理）？
 * 入参是**纯描述对象**（`{ tagName, type, isContentEditable }`），便于单测。
 *
 * 说明：`<input>` 不写 type 时浏览器按 `text` 处理，所以空 type 也算文本输入。
 */
export function isEditableTarget(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = String(target.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    const type = String(target.type || 'text').toLowerCase();
    return TEXT_INPUT_TYPES.includes(type);
  }
  return false;
}

/**
 * Ctrl+A 该走哪条路：
 *   `'native'`  —— 放行（焦点在可编辑文本里，浏览器原生全选它）；
 *   `'block'`   —— 什么都不做（有弹窗打开）；
 *   `'console'` —— 全选编译输出区。
 *
 * @param {{tagName?:string, type?:string, isContentEditable?:boolean}|null} target 当前焦点元素
 * @param {boolean} overlayOpen 是否有弹窗（帮助 / 打包）打开
 * @returns {'native'|'block'|'console'}
 */
export function planSelectAll(target, overlayOpen) {
  if (isEditableTarget(target)) return 'native';
  if (overlayOpen) return 'block';
  return 'console';
}
