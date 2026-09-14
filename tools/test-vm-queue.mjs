/**
 * 单测 MrpVm 的命令串行化（_enqueue）。
 *
 * 背景：串口交互 shell 只有一条，run() 靠在 shell 里 echo 一个随机哨兵来判断命令结束。
 * 如果两条命令并发下发，回显与哨兵会交错，waitFor 可能认到对方的结果 → 双方一起卡死。
 * 实测触发场景：打包对话框打开时预读壳文件，用户此刻点「生成」。
 *
 * 这里用一个假 emulator 模拟 guest，断言：
 *   1. 前一条命令的哨兵返回之前，后一条命令不会被发出去
 *   2. 两条命令都拿到各自正确的退出码
 *   3. 命令抛错（超时）时队列不会卡死，后续命令仍能正常执行
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { MrpVm } = await import(pathToFileURL(path.join(ROOT, 'assets', 'vm.js')).href);

/** 假 emulator：把 serial0_send 当成"guest 收到一条命令"，稍后回哨兵 */
class FakeEmu {
  constructor(codes = []) {
    this.listeners = new Map();
    this.sent = [];
    this.codes = [...codes];
    this.inflight = false;
    this.violations = 0;
    this.timers = [];
  }
  add_listener(ev, fn) {
    if (!this.listeners.has(ev)) this.listeners.set(ev, []);
    this.listeners.get(ev).push(fn);
  }
  emit(text) {
    for (const fn of this.listeners.get('serial0-output-byte') || []) {
      for (const ch of text) fn(ch.charCodeAt(0));
    }
  }
  serial0_send(text) {
    // 上一条还没回哨兵就又发命令 —— 就是我们要防的并发
    if (this.inflight) this.violations++;
    this.inflight = true;
    this.sent.push(text);

    const t1 = setTimeout(() => this.emit(text.replace(/\n$/, '\r\n')), 5);
    this.timers.push(t1);

    // NOREPLY 用来模拟"guest 不回话"（测试超时分支）
    if (text.includes('NOREPLY')) return;

    // 形式一：run() 的退出码哨兵 —— echo "__RCxxxx""xx=$?"
    const rcMatch = text.match(/echo "([^"]*)""([^"]*)=\$\?"/);
    if (rcMatch) {
      const rc = this.codes.length ? this.codes.shift() : 0;
      this.timers.push(
        setTimeout(() => {
          this.emit(`${rcMatch[1]}${rcMatch[2]}=${rc}\r\n`);
          this.inflight = false;
        }, 40)
      );
      return;
    }

    // 形式二：listProjectFiles() 的起止标记 —— echo "a""b_B" … echo "a""b_E"
    const listMatch = text.match(/echo "([^"]*)""([^"]*)_B"/);
    if (listMatch) {
      const id = listMatch[1] + listMatch[2];
      this.timers.push(
        setTimeout(() => {
          this.emit(`${id}_B\r\n`);
          this.emit('helloworld.c\r\nsrc/mrp_compat.c\r\n');
          this.emit(`${id}_E\r\n`);
          this.inflight = false;
        }, 40)
      );
      return;
    }

    // 认不出来的命令别卡住，直接当作已完成
    this.timers.push(
      setTimeout(() => {
        this.inflight = false;
      }, 40)
    );
  }
  destroy() {
    for (const t of this.timers) clearTimeout(t);
  }
}

function makeVm(codes) {
  const emu = new FakeEmu(codes);
  const vm = new MrpVm({ onOutput: () => {} });
  vm.emulator = emu;
  vm._attach();
  return { vm, emu };
}

let failed = 0;
function ok(name, pass, detail = '') {
  if (!pass) failed++;
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
}

console.log('===== MrpVm 命令串行化 =====');

await (async () => {
  // 1. 并发两条命令：不能交错，且各自拿到自己的退出码
  {
    const { vm, emu } = makeVm([2, 0]);
    const [a, b] = await Promise.all([vm.run('echo A'), vm.run('echo B')]);
    ok('并发调用不交错（无并发下发）', emu.violations === 0, `violations=${emu.violations}`);
    ok('两条命令都已下发', emu.sent.length === 2, `sent=${emu.sent.length}`);
    ok('各自拿到正确的退出码', a === 2 && b === 0, `a=${a} b=${b}`);
    ok('下发顺序与调用顺序一致', /echo A/.test(emu.sent[0]) && /echo B/.test(emu.sent[1]), emu.sent.map((s) => s.split(';')[0]).join(' | '));
    emu.destroy();
  }

  // 2. 三条并发，退出码 1/2/3 一一对应（错认哨兵会串码）
  {
    const { vm, emu } = makeVm([1, 2, 3]);
    const rs = await Promise.all([vm.run('c1'), vm.run('c2'), vm.run('c3')]);
    ok('三条并发串行执行且退出码一一对应', rs.join(',') === '1,2,3' && emu.violations === 0, `rs=${rs.join(',')} violations=${emu.violations}`);
    emu.destroy();
  }

  // 3. 前一条超时抛错，队列不能卡死
  {
    const { vm, emu } = makeVm([0]);
    let threw = false;
    try {
      await vm.run('NOREPLY never-returns', { timeout: 150 });
    } catch {
      threw = true;
    }
    ok('超时会抛错', threw);
    const rc = await vm.run('after-timeout', { timeout: 2000 });
    ok('超时后队列仍可用', rc === 0, `rc=${rc}`);
    emu.destroy();
  }

  // 4. listProjectFiles 也走同一条队列
  {
    const { vm, emu } = makeVm([0]);
    emu.add_listener('serial0-output-byte', () => {});
    const p = vm.listProjectFiles().catch(() => null);
    const r = await vm.run('x', { timeout: 300 });
    await p;
    ok('listProjectFiles 与 run 串行', emu.violations === 0, `violations=${emu.violations}`);
    emu.destroy();
  }
})();

console.log(`\n${failed ? `${failed} 项失败` : '全部通过'}`);
process.exit(failed ? 1 : 0);
