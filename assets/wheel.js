/**
 * 滚轮兜底的**纯逻辑**：决定一次滚轮该滚哪个元素、滚多少。
 *
 * 这里不碰 DOM —— 「元素能不能朝这个方向滚」通过 `canScroll` 回调问，
 * 所以能在 Node 里直接单测（`tools/test-wheel.mjs`）。app.js 只负责：
 * 从事件目标往上收集祖先链、把结果落到真实元素上。
 *
 * 背景（为什么要有这一层）：部分宿主环境（嵌入式预览 iframe）会把 wheel 事件
 * 整体吃掉，表现为「触摸能滑、鼠标滚轮没反应」，所以滚动得自己接管。
 * 详见 app.js 里 attachWheelScroll 的注释。
 */

export const WHEEL_LINE_PX = 40; // 行模式滚轮（Firefox 等 deltaMode=1）：1 行折合多少像素

/** wheel 事件的原始量 → 像素增量（行模式按 40px/行换算） */
export function wheelDeltas({ deltaX = 0, deltaY = 0, deltaMode = 0 }) {
  const toPx = (v) => (deltaMode === 1 ? v * WHEEL_LINE_PX : v);
  return { dx: toPx(deltaX), dy: toPx(deltaY) };
}

/**
 * 在链上找**第一个朝这个方向还能滚**的元素。
 * 同一个元素上两个轴分别判定：能滚的轴才带增量，别把滚不动的轴也塞给它
 * （塞了会让 scrollLeft += 0 这种空动作被当成「滚过了」而提前收工）。
 */
function pickIn(chain, dx, dy, canScroll) {
  for (const node of chain) {
    const okX = dx && canScroll(node, 'x', dx);
    const okY = dy && canScroll(node, 'y', dy);
    if (okX || okY) return { node, dx: okX ? dx : 0, dy: okY ? dy : 0 };
  }
  return null;
}

/**
 * 一次滚轮的完整决策。
 *
 * 返回 `{ node, dx, dy, locked }`：
 *   · `node` 有值 → 滚它（`dx`/`dy` 是这条元素上要落的增量）；
 *   · `node === null` + `locked === false` → 这条链谁都没接住，调用方再走
 *     「弹窗正文 / 页面本身」那两级兜底；
 *   · `node === null` + `locked === true` → **这次滚轮到此为止，什么都别做**
 *     （调用方仍要 preventDefault，别让底层再把它当别的滚动处理）。
 *
 * Shift 的语义 —— **只横向，不做任何其它滚动**：
 *   · 两种浏览器的给法不同，都要认：Chromium 只把滚动量放在 deltaY 里配一个 shiftKey，
 *     Firefox 会自己换算成 deltaX；
 *   · 横向滚到头（最左 / 最右）就**停住**。早期版本到了头会"退回纵向"，
 *     结果是「一直滚，滚到头忽然开始上下跳」，比什么都不做更烦人 —— 已去掉。
 *
 * @param {{shift?: boolean, dx?: number, dy?: number}} input
 * @param {Array} chain  从事件目标往上的元素数组（弹窗场景已按 .overlay 截断）
 * @param {(node, axis: 'x'|'y', delta: number) => boolean} canScroll
 */
export function planWheel({ shift = false, dx = 0, dy = 0 }, chain, canScroll) {
  if (shift) {
    const hx = dx || dy; // 横向的量：优先 deltaX，没有就用 deltaY（Chromium 的给法）
    const horiz = hx ? pickIn(chain, hx, 0, canScroll) : null;
    // 接不住（到头了 / 这个区域压根不能横滚）也返回同一形状，但 locked 让调用方"就此打住"
    return horiz
      ? { node: horiz.node, dx: horiz.dx, dy: 0, locked: true }
      : { node: null, dx: 0, dy: 0, locked: true };
  }
  const plan = pickIn(chain, dx, dy, canScroll);
  return plan
    ? { node: plan.node, dx: plan.dx, dy: plan.dy, locked: false }
    : { node: null, dx: 0, dy: 0, locked: false };
}
