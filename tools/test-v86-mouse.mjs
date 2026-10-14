/**
 * v86 的鼠标 / 键盘适配器必须关掉 —— 否则 guest 一启动，页面上的输入框就点不进去了。
 *
 * 背景（结论都是从 assets/v86/libv86.js 里读出来的）：
 *   · 适配器的「屏幕区域」= 构造参数 screen_container；本项目不传 → 它回落到
 *     document.body —— 于是页面上**任何一处**鼠标事件都被算成「落在屏幕里」。
 *   · 它的监听挂在 window 上，且 mousedown / wheel / contextmenu 三个处理里都
 *     无条件 preventDefault()。
 *   · 平时它是关的（enabled 由总线的 mouse-enable 消息打开）；guest 的 PS/2 鼠标
 *     驱动一启用数据上报（Linux 启动时就会），v86 就把它打开 —— 时间点正好是
 *     「点了『启动编译环境』之后」。
 *   · 打开之后：mousedown 的默认行为（聚焦 + 落光标 + 起选区）被取消 → 源码编辑区 /
 *     入口源文件 / 额外参数这些输入框点不进去、选不中；wheel 被吃掉 → 页面滚轮失效；
 *     右键菜单也没了。
 *
 * 本测试做两件事（都能在 Node 里跑，不需要浏览器）：
 *   ① 静态守卫：assets/vm.js 里创建 V86 时必须传 disable_mouse / disable_keyboard；
 *   ② 行为证明：真的各造一个 V86，确认「不传就有适配器、传了就没有」——
 *      适配器对象是构造函数里同步创建的，跟有没有 window、有没有真启动虚拟机无关。
 *
 * 用法： node tools/test-v86-mouse.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
function ok(name, pass, detail = '') {
  if (!pass) failed++;
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
}

console.log('===== 1. assets/vm.js 必须显式关掉这两个适配器 =====');
const vmSrc = fs.readFileSync(path.join(ROOT, 'assets', 'vm.js'), 'utf8');
// 只取 new V86({...}) 的那一段，别被别处的同名字样骗过
const m = vmSrc.match(/new V86\(\{([\s\S]*?)\n\s*\}\);/);
const opts = m ? m[1] : '';
ok('找得到 new V86({ … }) 的选项块', !!m);
ok('选项里有 disable_mouse: true', /disable_mouse\s*:\s*true/.test(opts));
ok('选项里有 disable_keyboard: true', /disable_keyboard\s*:\s*true/.test(opts));
// 注释里会提到 screen_container（解释为什么不用它），先剥注释再判断有没有真的传
const optsCode = opts.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
ok('没有真的传 screen_container（本项目不显示 guest 画面）', !/screen_container\s*:/.test(optsCode));

console.log('\n===== 2. 行为证明：传与不传，适配器有没有被创建 =====');
const { V86 } = await import(pathToFileURL(path.join(ROOT, 'assets', 'v86', 'libv86.js')).href);

/*
 * 注意：导出的 V86 是个**包装类**，内部核心对象是等 wasm 实例化完才建的
 * （`f({env}).then(g => { this.v86 = new G(...); this.continue_init(...) })`），
 * 适配器就在那个核心的构造函数里创建 —— 所以不能 new 完立刻断言，要等
 * `emulator-ready`（核心 `init()` 里发的，跟 autostart 无关）。
 */
const base = {
  wasm_path: path.join(ROOT, 'assets', 'v86', 'v86.wasm'),
  filesystem: {},
  autostart: false, // 只要核心建起来就够，不用真跑 CPU
};
const waitReady = (em) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('等 emulator-ready 超时')), 30_000);
    em.add_listener('emulator-ready', () => {
      clearTimeout(t);
      res();
    });
  });

const off = new V86({ ...base, disable_mouse: true, disable_keyboard: true });
await waitReady(off);
ok('传了 disable_* → 不创建 mouse_adapter', off.mouse_adapter === undefined);
ok('传了 disable_* → 不创建 keyboard_adapter', off.keyboard_adapter === undefined);

const on = new V86({ ...base });
await waitReady(on);
ok(
  '没传 → mouse_adapter 被创建（这就是 bug 的来源）',
  !!on.mouse_adapter,
  `mouse=${on.mouse_adapter ? 'object' : 'undefined'} keyboard=${on.keyboard_adapter ? 'object' : 'undefined'}`
);
ok('没传 → keyboard_adapter 被创建', !!on.keyboard_adapter);

for (const em of [off, on]) {
  try {
    await em.destroy();
  } catch {
    /* 没真启动过，destroy 可能抛，忽略 */
  }
}

console.log(`\n${failed ? `${failed} 项失败` : '全部通过'}`);
process.exitCode = failed ? 1 : 0;
// V86 内部可能挂着定时器 / 未决的 wasm 载入，别让进程干等
setTimeout(() => process.exit(process.exitCode), 50).unref();
