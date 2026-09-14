/**
 * 单测 MrpVm._forward —— 串口输出的哨兵过滤。
 * 直接 import 真实模块，不启动虚拟机。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { MrpVm } = await import(pathToFileURL(path.join(ROOT, 'assets', 'vm.js')).href);

function collect() {
  const out = [];
  const vm = new MrpVm({ onOutput: (t) => out.push(t) });
  return { vm, text: () => out.join('') };
}

const cases = [];
function check(name, fn) {
  try {
    const r = fn();
    cases.push({ name, ok: r.ok, detail: r.detail });
  } catch (e) {
    cases.push({ name, ok: false, detail: `${e.name}: ${e.message}` });
  }
}

// 1. 哨兵行被丢掉（真实串口上提示符和哨兵在同一行，会一起被丢掉，属于预期）
check('哨兵结果行 __RCxxxxxx=2 被过滤', () => {
  const { vm, text } = collect();
  vm._forward('mrp_demo% ');
  vm._forward('__RC7w0lx=2\r\n');
  vm._forward('next line\n');
  return { ok: text() === 'next line\n', detail: JSON.stringify(text()) };
});

// 2. 回显的命令行（哨兵被拆成两段引号）被丢掉
check('回显的命令行被过滤（哨兵是拆开的）', () => {
  const { vm, text } = collect();
  vm._forward('cd /opt/tc/mrp_demo && make; echo "__RC7w0x""lx=$?"\r\n');
  vm._forward('compiling a.c\n');
  return { ok: text() === 'compiling a.c\n', detail: JSON.stringify(text()) };
});

// 3. 哨兵被切开在两块里也能识别（必须等整行到齐再判定），且 \r\n 不出空行
check('跨 chunk 的哨兵行被过滤且不产生空行', () => {
  const { vm, text } = collect();
  vm._forward('__LSise');
  vm._forward('gf8_E\r');
  vm._forward('\n');
  vm._forward('src/foo.c\n');
  return { ok: text() === 'src/foo.c\n', detail: JSON.stringify(text()) };
});

// 4. 正常内容（含编译告警、MRPIMG）原样保留
check('正常内容不被误伤', () => {
  const { vm, text } = collect();
  const keep = 'MRPIMG: ready\nsrc/bitmap.c:547:12: warning: variable \'color565\' set but not used\n';
  vm._forward(keep);
  return { ok: text() === keep, detail: JSON.stringify(text()) };
});

// 5. 不含换行的超长串会被强制送出，不会把日志憋死
check('超长无换行串被强制送出', () => {
  const { vm, text } = collect();
  vm._forward('x'.repeat(5000));
  return { ok: text().length === 5000, detail: `len=${text().length}` };
});

// 6. rawOutput 模式不过滤
check('rawOutput=true 时不过滤', () => {
  const out = [];
  const vm = new MrpVm({ rawOutput: true, onOutput: (t) => out.push(t) });
  vm._forward('__RC7w0lx=2\n');
  return { ok: out.join('') === '__RC7w0lx=2\n', detail: JSON.stringify(out.join('')) };
});

// 7. 逐字节喂入（模拟真实 serial0-output-byte 回调）
check('逐字节喂入结果一致', () => {
  const { vm, text } = collect();
  const src = 'a\n__RCabc123=0\nb\n';
  for (const ch of src) vm._forward(ch);
  return { ok: text() === 'a\nb\n', detail: JSON.stringify(text()) };
});

let bad = 0;
for (const c of cases) {
  if (!c.ok) bad++;
  console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}`);
  if (!c.ok) console.log(`      实际: ${c.detail}`);
}
console.log(bad ? `\n${bad} 项失败` : '\n全部通过');
process.exit(bad ? 1 : 0);
