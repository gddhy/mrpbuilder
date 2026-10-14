/**
 * 单测 assets/wheel.js —— 滚轮该滚谁、滚多少（纯逻辑）。
 *
 * 这段逻辑存在的理由：某些宿主环境会把 wheel 事件整体吞掉，滚动得自己接管。
 * 判定错的后果都是「用户以为坏了」那种：
 *   · Shift + 滚轮没走横向  → 编辑区里长行看不了右边
 *   · Shift + 滚轮接了竖向量 → 滚到左右尽头忽然开始上下跳（用户报过这个）
 *   · Shift 之外还吞掉事件 → 只能竖滚的区域、外层链式滚动都会失灵
 * 所以这里用假元素链把决策逐条钉住，不需要浏览器。
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { planWheel, wheelDeltas, WHEEL_LINE_PX } = await import(
  pathToFileURL(path.join(ROOT, 'assets', 'wheel.js')).href
);

let failed = 0;
function ok(name, pass, detail = '') {
  if (!pass) failed++;
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
}

/**
 * 造一个假元素：range 用 [起点, 终点] 表示某个轴的可滚区间（null = 这个轴压根不能滚），
 * 初始位置就是区间起点（需要停在中途/尽头就自己赋 scrollLeft / scrollTop）。
 * canScroll 照着真实现（app.js 的 canScroll）的语义写：能不能滚 + 朝这个方向还有没有余量。
 */
function fakeEl(name, { x = null, y = null } = {}) {
  return { name, scrollLeft: x ? x[0] : 0, scrollTop: y ? y[0] : 0, range: { x, y } };
}
function can(node, axis, delta) {
  const r = node.range[axis];
  if (!r) return false;
  const pos = axis === 'y' ? node.scrollTop : node.scrollLeft;
  return delta < 0 ? pos > 0 : pos < r[1];
}
function applyAll(plan) {
  if (!plan?.node) return false;
  if (plan.dy) plan.node.scrollTop += plan.dy;
  if (plan.dx) plan.node.scrollLeft += plan.dx;
  return true;
}
const run = (input, chain) => planWheel(input, chain, can);
const desc = (p) => JSON.stringify({ node: p.node ? p.node.name : null, dx: p.dx, dy: p.dy, locked: p.locked });

// ---------------------------------------------------------------------------
console.log('===== 1. 行模式换算（deltaMode=1 → 40px/行）=====');

ok('像素模式原样返回', wheelDeltas({ deltaY: 120, deltaX: -30 }).dy === 120 &&
  wheelDeltas({ deltaY: 120, deltaX: -30 }).dx === -30);
ok('行模式 3 行 = 120px', wheelDeltas({ deltaY: 3, deltaMode: 1 }).dy === 3 * WHEEL_LINE_PX,
  String(WHEEL_LINE_PX));
ok('行模式两个轴都换算', wheelDeltas({ deltaY: 2, deltaX: -1, deltaMode: 1 }).dy === 80 &&
  wheelDeltas({ deltaY: 2, deltaX: -1, deltaMode: 1 }).dx === -40);
ok('没给 deltaMode 按像素算', wheelDeltas({ deltaY: 5 }).dy === 5);

// ---------------------------------------------------------------------------
console.log('\n===== 2. 普通滚轮 = 纵向（Shift 之外照旧）=====');

{
  const ed = fakeEl('editor', { x: [0, 800], y: [0, 4000] });
  const p = run({ dx: 0, dy: 120 }, [ed]);
  ok('纵向滚 120px，落在同一个元素上', p.node === ed && p.dy === 120 && p.dx === 0, desc(p));
  ok('  不是 locked（没接住时才轮到调用方兜底）', p.locked === false);
}

{
  const ed = fakeEl('editor', { x: [0, 800], y: [0, 4000] });
  const p = run({ dx: 40, dy: 120 }, [ed]);
  ok('斜向滑动（触摸板）：横竖都滚', p.dx === 40 && p.dy === 120);
}

{
  const outer = fakeEl('pane', { y: [0, 2000] });
  const inner = fakeEl('filebar', { y: [0, 400] });
  inner.scrollTop = 400; // 已经滚到底了
  const p = run({ dx: 0, dy: 120 }, [inner, outer]);
  ok('内层滚到头 → 落到外层（链式滚动不卡死）', p.node === outer && p.dy === 120, p.node.name);
}

{
  const a = fakeEl('a', { y: [0, 0] }); // 内容不够长，不可滚
  const p = run({ dx: 0, dy: 120 }, [a]);
  ok('谁都不能滚 → node=null 且 locked=false（交给调用方兜底）',
    p.node === null && p.locked === false, desc(p));
}

// ---------------------------------------------------------------------------
console.log('\n===== 3. Shift + 滚轮 = **只横向** =====');

{
  // Chromium：量在 deltaY + shiftKey
  const ed = fakeEl('editor', { x: [0, 800], y: [0, 4000] });
  const p = run({ shift: true, dx: 0, dy: 120 }, [ed]);
  ok('Chromium 式（deltaY + shift）→ 横向 120px', p.node === ed && p.dx === 120 && p.dy === 0, desc(p));
}

{
  // Firefox：自己把量换算进 deltaX
  const ed = fakeEl('editor', { x: [0, 800], y: [0, 4000] });
  const p = run({ shift: true, dx: 90, dy: 0 }, [ed]);
  ok('Firefox 式（deltaX + shift）→ 横向 90px', p.dx === 90 && p.dy === 0);
}

{
  // 两个都给（理论上不该同时有，但要有确定行为）：优先 deltaX
  const ed = fakeEl('editor', { x: [0, 800], y: [0, 4000] });
  const p = run({ shift: true, dx: 60, dy: 200 }, [ed]);
  ok('两个都有时以 deltaX 为准', p.dx === 60 && p.dy === 0, desc(p));
}

{
  const ed = fakeEl('editor', { x: [0, 800], y: [0, 4000] });
  ed.scrollLeft = 400; // 已经在中间，往回滚得动
  const p = run({ shift: true, dx: 0, dy: -120 }, [ed]);
  ok('往回滚也是横向（负号保留）', p.dx === -120 && p.dy === 0, desc(p));
}

/* ---------- 尽头：绝不退回纵向（用户报过的 bug）---------- */

{
  // 滚到最右继续往右 → 什么都不该发生
  const ed = fakeEl('editor', { x: [0, 800], y: [0, 4000] });
  ed.scrollLeft = 800; // 已经在最右
  const before = { x: ed.scrollLeft, y: ed.scrollTop };
  const p = run({ shift: true, dx: 0, dy: 120 }, [ed]);
  applyAll(p); // 万一决策里带了纵向，这里就会暴露
  ok('横向到最右后继续滚 → 不滚（尤其不能改成往下滚）',
    p.node === null && p.locked === true && ed.scrollTop === before.y && ed.scrollLeft === before.x,
    desc(p) + ` scrollTop=${ed.scrollTop}`);
}

{
  // 滚到最左继续往左 → 什么都不该发生
  const ed = fakeEl('editor', { x: [0, 800], y: [0, 4000] });
  ed.scrollTop = 900;
  const p = run({ shift: true, dx: 0, dy: -120 }, [ed]);
  applyAll(p);
  ok('横向到最左后继续滚 → 不滚（尤其不能改成往上滚）',
    p.node === null && p.locked === true && ed.scrollTop === 900, desc(p) + ` scrollTop=${ed.scrollTop}`);
}

{
  // 只能竖滚的区域（文件列表 / 编译输出）：Shift 下**什么都不做**，不能退成纵向
  const list = fakeEl('filebar', { y: [0, 1000] });
  const p = run({ shift: true, dx: 0, dy: 90 }, [list]);
  applyAll(p);
  ok('只能竖滚的区域：Shift 下不滚纵向（保持"只横向"语义）',
    p.node === null && p.locked === true && list.scrollTop === 0, desc(p));
}

{
  // 只有横向量、又接不住 → 同样打住
  const list = fakeEl('filebar', { y: [0, 1000] });
  const p = run({ shift: true, dx: 90, dy: 0 }, [list]);
  ok('只有横向量且接不住 → locked（调用方拦掉默认行为，别让它变成别的滚动）',
    p.node === null && p.locked === true, desc(p));
}

{
  // 横向接得住时不能顺手把纵向也滚了
  const ed = fakeEl('editor', { x: [0, 800], y: [0, 4000] });
  applyAll(run({ shift: true, dx: 0, dy: 200 }, [ed]));
  ok('Shift 横滚时纵向纹丝不动', ed.scrollTop === 0 && ed.scrollLeft === 200,
    `x=${ed.scrollLeft} y=${ed.scrollTop}`);
}

{
  // 横向的第一个能滚的祖先（编辑区自己横不了时给外层）
  const inner = fakeEl('editor', { x: [0, 0], y: [0, 4000] }); // 横向不可滚
  const outer = fakeEl('pane', { x: [0, 500], y: [0, 4000] });
  const p = run({ shift: true, dx: 0, dy: 120 }, [inner, outer]);
  ok('内层横不了 → 外层横滚', p.node === outer && p.dx === 120, desc(p));
}

{
  // 不变式：只要按下 Shift，**任何链**都不可能产生纵向滚动
  const chains = [
    [fakeEl('editor', { x: [0, 800], y: [0, 4000] })],
    [fakeEl('list', { y: [0, 1000] })],
    [fakeEl('atRightEnd', { x: [200, 200], y: [0, 4000] })],
    [fakeEl('a', { y: [0, 500] }), fakeEl('b', { y: [0, 900] })],
    [fakeEl('none', {})],
  ];
  const bad = [];
  for (const chain of chains) {
    for (const dy of [120, -120]) {
      const p = run({ shift: true, dx: 0, dy }, chain);
      if (p.dy !== 0 || (p.node && p.dx === 0)) bad.push(desc(p));
    }
  }
  ok('不变式：Shift 下 dy 永远是 0，且要么横滚、要么 locked', bad.length === 0, bad.join(' '));
}

// ---------------------------------------------------------------------------
console.log('\n===== 4. 应用决策（落到真实滚动位置上）=====');

{
  const ed = fakeEl('editor', { x: [0, 800], y: [0, 4000] });
  const p = run({ shift: true, dx: 0, dy: 120 }, [ed]);
  ok('applyPlan 之后 scrollLeft 变了', applyAll(p) === true && ed.scrollLeft === 120 && ed.scrollTop === 0,
    `x=${ed.scrollLeft} y=${ed.scrollTop}`);
}
{
  ok('node=null 的决策：什么都别滚', applyAll({ node: null, dx: 0, dy: 0, locked: true }) === false);
}

// ---------------------------------------------------------------------------
console.log(`\n${failed ? `${failed} 项失败` : '全部通过'}`);
process.exitCode = failed ? 1 : 0;
