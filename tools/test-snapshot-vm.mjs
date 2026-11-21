/**
 * 端到端：验证「抓快照 → 新实例恢复 → 9p 重挂 → 编译产物一致」。
 *
 * 这是启动快照唯一的真凭实据：单测只能证明指纹算得对、gzip 能往返，
 * 证明不了 v86 的 save_state/restore_state 在真实镜像上能不能用，更证明不了
 * 恢复出来的虚拟机能编出**逐字节相同**的产物。
 *
 * 跑一遍约 50 秒（两次启动，其中一次是冷启动 33 秒）。
 * 用法：node tools/test-snapshot-vm.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMGDIR = path.join(ROOT, 'assets', 'image');
const V86DIR = path.join(ROOT, 'assets', 'v86');
const SHARE = '/mnt';

function need(p, hint) {
  if (!fs.existsSync(p)) {
    console.error(`✗ 缺少 ${path.relative(ROOT, p)}\n  ${hint}`);
    process.exit(2);
  }
  return p;
}

const kernelPath = need(path.join(IMGDIR, 'vmlinuz.bin'), '请先运行：python tools/make-image.py');
const rootfsPath = need(path.join(IMGDIR, 'rootfs.tar.gz'), '请先运行：python tools/make-image.py');

const { MrpVm } = await import(pathToFileURL(path.join(ROOT, 'assets', 'vm.js')).href);
const { compressSnapshot, decompressSnapshot } = await import(
  pathToFileURL(path.join(ROOT, 'assets', 'snapshot.js')).href
);

const toAB = (p) => {
  const b = fs.readFileSync(p);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const sec = (t) => `${((Date.now() - t) / 1000).toFixed(1)}s`;
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

let failed = 0;
const ok = (name, pass, detail = '') => {
  if (!pass) failed++;
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
};

function mk(tag) {
  const tail = [];
  const vm = new MrpVm({
    wasmPath: path.join(V86DIR, 'v86.wasm'),
    bios: { buffer: toAB(path.join(V86DIR, 'bios', 'seabios.bin')) },
    vgaBios: { buffer: toAB(path.join(V86DIR, 'bios', 'vgabios.bin')) },
    kernel: { buffer: toAB(kernelPath) },
    onOutput: (ch) => {
      tail.push(ch);
      if (tail.length > 400) tail.shift();
    },
    onStatus: (s) => console.log(`    [${tag}] ${s}`),
  });
  vm.__tail = tail;
  return vm;
}

/** 9p 写进去、guest 读出来、宿主再读回来 —— 任何一环断了都会暴露 */
async function probe9p(vm, tag) {
  const payload = new TextEncoder().encode(`probe-${tag}-${Date.now()}`);
  await vm.putFile('__probe', payload);
  const rc = await vm.run(`cat ${SHARE}/__probe > ${SHARE}/__probe.out`);
  if (rc !== 0) return `cat rc=${rc}`;
  const back = new TextDecoder().decode(await vm.getFile('__probe.out')).trim();
  return back === new TextDecoder().decode(payload).trim() ? true : `mismatch: ${back}`;
}

/** 编一个不含 include 的小文件（只走 cc1 + as），返回 .o 的 sha256 */
async function compileProbe(vm) {
  const rc = await vm.run(
    `printf 'int f(int x){return x*3+1;}' > /tmp/t.c && ` +
      `arm-none-eabi-gcc -c -Os -marm -march=armv5te -mfloat-abi=soft ` +
      `-ffixed-r9 -ffixed-r10 -fPIC /tmp/t.c -o /tmp/t.o && ` +
      `sha256sum /tmp/t.o > ${SHARE}/__sha`
  );
  if (rc !== 0) return { ok: false, rc, tail: vm.__tail.join('').slice(-1200) };
  const txt = new TextDecoder().decode(await vm.getFile('__sha')).trim();
  return { ok: true, sha: txt.split(/\s+/)[0] };
}

const tAll = Date.now();
console.log('[1] 冷启动');
const vm1 = mk('A');
let t = Date.now();
await vm1.boot();
console.log(`    shell 就绪 ${sec(t)}`);

console.log('\n[2] 安装工具链');
t = Date.now();
await vm1.installToolchain(new Uint8Array(fs.readFileSync(rootfsPath)));
console.log(`    完成 ${sec(t)}（累计 ${sec(tAll)}）`);

console.log('\n[3] 快照前 9p 自检');
const p1 = await probe9p(vm1, 'before');
ok('9p 可写可读', p1 === true, p1 === true ? '' : String(p1));

console.log('\n[4] 抓快照（umount → save_state → remount）');
t = Date.now();
let cap;
try {
  cap = await vm1.captureSnapshot();
} catch (e) {
  ok('captureSnapshot 成功', false, e.message);
  console.log(vm1.__tail.join('').slice(-2000));
  process.exit(1);
}
ok('captureSnapshot 成功', true, `${sec(t)}，state ${mb(cap.state.byteLength)}`);
ok('state 含完整内存（> 100 MB）', cap.state.byteLength > 100 * 1048576);
ok('解析出共享目录挂载参数', !!(cap.share?.device && cap.share?.type), JSON.stringify(cap.share));

const p2 = await probe9p(vm1, 'after');
ok('存完快照后 9p 已挂回（当前会话仍可用）', p2 === true, p2 === true ? '' : String(p2));

console.log('\n[4.5] 压缩 / 解压（IndexedDB 里存的就是压缩后的字节）');
t = Date.now();
const packed = await compressSnapshot(cap.state);
console.log(`    压缩 ${mb(cap.state.byteLength)} → ${mb(packed.bytes.length)}，${sec(t)}`);
ok('确实压缩了', packed.compressed === true);
t = Date.now();
const unzipped = await decompressSnapshot(packed.bytes, {
  compressed: packed.compressed,
  rawSize: cap.state.byteLength,
});
console.log(`    解压 ${sec(t)}`);
ok('压缩后能原样还原', !!unzipped && unzipped.byteLength === cap.state.byteLength);

console.log('\n[5] 冷启动侧编译探针');
const c1 = await compileProbe(vm1);
if (!c1.ok) {
  ok('编译探针成功', false, `rc=${c1.rc}`);
  console.log(c1.tail);
} else {
  ok('编译探针成功', true, `sha256 ${c1.sha.slice(0, 16)}…`);
}

await vm1.stop();
console.log('    A 实例已销毁');

console.log('\n[6] 新实例从快照恢复');
t = Date.now();
const vm2 = mk('B');
try {
  await vm2.boot({ initialSnapshot: cap.state });
  ok('restore_state 成功', true, `${sec(t)}（对比冷启动 ${sec(tAll)} 里含 33s 初始化）`);
} catch (e) {
  ok('restore_state 成功', false, e.message);
  console.log(vm2.__tail.join('').slice(-2000));
  process.exit(1);
}

console.log('\n[7] 恢复后重新挂载 9p');
t = Date.now();
try {
  await vm2.mountShare(cap.share);
  ok('重新挂载成功', true, sec(t));
} catch (e) {
  ok('重新挂载成功', false, e.message);
  console.log(vm2.__tail.join('').slice(-2000));
  // 没挂上就别往下走：后面的 probe9p 会往 /mnt 写脚本，只会卡到超时
  process.exit(1);
}

const p3 = await probe9p(vm2, 'restored');
ok('恢复后 9p 可写可读', p3 === true, p3 === true ? '' : String(p3));

console.log('\n[8] 恢复后编译，产物应与冷启动一致');
const c2 = await compileProbe(vm2);
if (!c2.ok) {
  ok('恢复后编译成功', false, `rc=${c2.rc}`);
  console.log(c2.tail);
} else {
  ok('恢复后编译成功', true, `sha256 ${c2.sha.slice(0, 16)}…`);
  ok('产物与冷启动逐字节一致', !!(c1.ok && c1.sha === c2.sha), `${c1.sha} vs ${c2.sha}`);
}

console.log('\n[9] 工具链环境变量是否补齐（PATH / LD_LIBRARY_PATH）');
const ver = await vm2.run(`arm-none-eabi-gcc --version | head -1 > ${SHARE}/__ver`);
const verTxt = ver === 0 ? new TextDecoder().decode(await vm2.getFile('__ver')).trim() : '';
ok('恢复后 gcc 可直接调用', ver === 0 && /arm-none-eabi-gcc/.test(verTxt), verTxt);

await vm2.stop();

console.log(`\n总用时 ${sec(tAll)}`);
console.log(failed ? `✗ ${failed} 项失败` : '✓ 全部通过');
process.exit(failed ? 1 : 0);
