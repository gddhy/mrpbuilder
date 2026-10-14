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
    this.scripts = []; // create_file 收到的脚本（命令正文）
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
  /** putFile → 9p 写文件：记下「命令正文被写进了哪个脚本」（不模拟落盘） */
  create_file(name, bytes) {
    this.scripts.push({ name, text: new TextDecoder().decode(bytes) });
    return Promise.resolve();
  }
  serial0_send(text) {
    // 上一条还没回哨兵就又发命令 —— 就是我们要防的并发
    if (this.inflight) this.violations++;
    this.inflight = true;
    this.sent.push(text);

    const t1 = setTimeout(() => this.emit(text.replace(/\n$/, '\r\n')), 5);
    this.timers.push(t1);

    // NOREPLY 用来模拟"guest 不回话"（测试超时分支）。
    // 命令正文现在写在脚本文件里，所以要看刚写进来的那份。
    const script = this.scripts[this.scripts.length - 1]?.text || '';
    if (text.includes('NOREPLY') || script.includes('NOREPLY')) return;

    // 形式一：run() 的退出码哨兵 —— 命令正文在脚本文件里，这里只有 sh + 哨兵
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

    // 形式二：listProjectFiles() —— 敲进去的是 `sh /mnt/__lscmd #__LSxxxxxx`
    const listMatch = text.match(/#(__LS[0-9a-z]+)/);
    if (listMatch) {
      const id = listMatch[1];
      this.timers.push(
        setTimeout(() => {
          this.emit(`${id}_B\r\n`);
          // du -b 的输出格式：<字节数>\t<路径>
          this.emit('6120\t./helloworld.c\r\n1106\t./src/mrp_compat.c\r\n');
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

function makeVm(codes, onOutput) {
  const emu = new FakeEmu(codes);
  const vm = new MrpVm({ onOutput: onOutput || (() => {}) });
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
  // 0. 命令正文走 9p 脚本文件：敲进 shell 的只有一行短命令
  //    （长命令的回显会被行编辑器在 80 列处折成多行，碎片没有哨兵 → 漏进可见日志）
  {
    const { vm, emu } = makeVm([0]);
    const long = 'echo 一条挺长的命令，用来确认它不会被回显到日志里';
    await vm.run(long, { timeout: 2000 });
    const typed = emu.sent[0] || '';
    ok('命令正文写进了脚本文件', emu.scripts.some((s) => s.text.includes('一条挺长')), emu.scripts[0]?.name);
    ok('  敲进 shell 的那行很短（不会触发 80 列折行）', typed.length < 80, `${typed.length} 字符`);
    ok('  正文没有出现在敲进去的那行里（不回显 → 日志干净）', !typed.includes('一条挺长'));
    ok('  脚本内容原样（UTF-8 经 9p，中文没问题）', /一条挺长的命令/.test(emu.scripts[0]?.text || ''));
    emu.destroy();
  }

  // 1. 并发两条命令：不能交错，且各自拿到自己的退出码
  {
    const { vm, emu } = makeVm([2, 0]);
    const [a, b] = await Promise.all([vm.run('echo A'), vm.run('echo B')]);
    ok('并发调用不交错（无并发下发）', emu.violations === 0, `violations=${emu.violations}`);
    ok('两条命令都已下发', emu.sent.length === 2, `sent=${emu.sent.length}`);
    ok('各自拿到正确的退出码', a === 2 && b === 0, `a=${a} b=${b}`);
    ok('下发顺序与调用顺序一致', /echo A/.test(emu.scripts[0].text) && /echo B/.test(emu.scripts[1].text),
      emu.scripts.map((x) => x.text.trim()).join(' | '));
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
    const seen = [];
    const { vm, emu } = makeVm([0], (line) => seen.push(line));
    emu.add_listener('serial0-output-byte', () => {});
    const p = vm.listProjectFiles().catch(() => null);
    const r = await vm.run('x', { timeout: 300 });
    const files = await p;
    ok('listProjectFiles 与 run 串行', emu.violations === 0, `violations=${emu.violations}`);
    // 顺带把解析也钉住：du -b 的「<字节数>\t<路径>」要变成 { name, size }，且按名字排序
    ok(
      '  解析出「名字 + 大小」并按名字排序',
      Array.isArray(files) &&
        files.length === 2 &&
        files[0].name === 'helloworld.c' &&
        files[0].size === 6120 &&
        files[1].name === 'src/mrp_compat.c' &&
        files[1].size === 1106,
      JSON.stringify(files)
    );
    ok('  文件名前的 ./ 被剥掉', !files.some((f) => f.name.startsWith('./')));
    // 列目录的输出是数据，不该出现在可见日志里（否则一启动就刷一屏文件名）
    const log = seen.join('');
    ok(
      '  列目录的数据不外泄到可见日志',
      !log.includes('helloworld.c') && !log.includes('6120'),
      JSON.stringify(log.slice(0, 120))
    );
    ok('  普通输出照旧转发（只静音列目录那一段）', (() => {
      seen.length = 0;
      emu.emit('compile: hello.c\r\n');
      return seen.join('').includes('compile: hello.c');
    })());
    emu.destroy();
  }
})();

console.log(`\n${failed ? `${failed} 项失败` : '全部通过'}`);
process.exit(failed ? 1 : 0);
