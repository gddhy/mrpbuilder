/**
 * 在 Node 里跑通整条链路（不需要浏览器）。
 *
 * 用法：
 *   node tools/test-v86.mjs              # 完整流程：启动 → 装工具链 → 编译 → 取回 bin.elf
 *   node tools/test-v86.mjs --diag       # 只启动 + 装工具链，然后打印环境信息
 *   node tools/test-v86.mjs --cmd "..."  # 装完工具链后执行自定义命令
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMGDIR = path.join(ROOT, 'assets', 'image');
const V86DIR = path.join(ROOT, 'assets', 'v86');
const BUILD_DIR = path.join(ROOT, '.build');

function toArrayBuffer(p) {
  const b = fs.readFileSync(p);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

function need(p, hint) {
  if (!fs.existsSync(p)) {
    console.error(`缺少文件：${p}\n${hint || ''}`);
    process.exit(2);
  }
  return p;
}

const kernelPath = need(path.join(IMGDIR, 'vmlinuz.bin'), '请先运行：python tools/make-image.py');
const rootfsPath = need(path.join(IMGDIR, 'rootfs.tar.gz'), '请先运行：python tools/make-image.py');

const mod = await import(pathToFileURL(path.join(V86DIR, 'libv86.mjs')).href);
const { MrpVm } = await import(pathToFileURL(path.join(ROOT, 'assets', 'vm.js')).href);
void mod; // v86 由 vm.js 内部导入

const args = process.argv.slice(2);
const diag = args.includes('--diag');
const cmdIdx = args.indexOf('--cmd');
const customCmd = cmdIdx >= 0 ? args[cmdIdx + 1] : null;

console.log('[vm] 启动中 ...');
console.log(`     内核     ${(fs.statSync(kernelPath).size / 1048576).toFixed(1)} MiB`);
console.log(`     工具链   ${(fs.statSync(rootfsPath).size / 1048576).toFixed(1)} MiB`);

const t0 = Date.now();
let lastLine = '';
const vm = new MrpVm({
  wasmPath: path.join(V86DIR, 'v86.wasm'),
  bios: { buffer: toArrayBuffer(path.join(V86DIR, 'bios', 'seabios.bin')) },
  vgaBios: { buffer: toArrayBuffer(path.join(V86DIR, 'bios', 'vgabios.bin')) },
  kernel: { buffer: toArrayBuffer(kernelPath) },
  // 这是排查用的 harness，保留完整串口流（含内部哨兵），别过滤
  rawOutput: true,
  onOutput: (ch) => {
    process.stdout.write(ch);
    lastLine += ch;
    if (lastLine.length > 400) lastLine = lastLine.slice(-400);
  },
  onStatus: (s) => process.stdout.write(`\n[vm] === ${s} ===\n`),
});

try {
  await vm.boot();
  console.log(`\n[vm] shell 就绪，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  await vm.installToolchain(fs.readFileSync(rootfsPath), {
    onProgress: (p) => console.log(`[vm] 工具链进度 ${Math.round(p * 100)}%`),
  });
  console.log(`\n[vm] 工具链就绪，累计 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  if (customCmd) {
    const rc = await vm.run(customCmd, { timeout: 900_000 });
    console.log(`\n[vm] 命令退出码 ${rc}`);
    // 自定义命令模式下，如果它把产物写到了 /mnt/__artifact 就顺手取回来
    try {
      const bytes = await vm.getFile('__artifact');
      fs.mkdirSync(BUILD_DIR, { recursive: true });
      const out = path.join(BUILD_DIR, 'artifact');
      fs.writeFileSync(out, bytes);
      console.log(`[vm] 已取回产物 ${out}（${bytes.length} 字节）`);
    } catch {
      /* 没有就算了 */
    }
  }

  if (diag) {
    await vm.run(
      'echo "--- /opt/tc ---"; ls /opt/tc; echo "--- 模板 ---"; ls /opt/tc/mrp_demo | head; ' +
      'echo "--- gcc ---"; arm-none-eabi-gcc --version | head -1; ' +
      'echo "--- as/ld ---"; which arm-none-eabi-as arm-none-eabi-ld make tar; ' +
      'echo "--- 9p ---"; ls -l /mnt; ' +
      'echo "__DIAG""_DONE__"'
    );
    await vm.waitFor(/__DIAG_DONE__/, 120_000, '诊断输出');
  } else if (!customCmd) {
    const files = {};
    const src = process.env.SRC_FILE;
    if (src) {
      files[path.basename(src)] = new Uint8Array(fs.readFileSync(src));
      console.log(`[vm] 额外投入源码 ${path.basename(src)}`);
    }

    const res = await vm.build({
      files,
      app: process.env.APP || 'helloworld.c',
      target: process.env.TARGET || 'bin.elf',
      extra: process.env.EXTRA || '',
    });

    if (!res.ok) {
      console.log(`\n[vm] ✗ 编译失败（make 返回 ${res.code}）`);
      process.exitCode = 1;
    } else {
      fs.mkdirSync(BUILD_DIR, { recursive: true });
      const out = path.join(BUILD_DIR, res.artifact.name);
      fs.writeFileSync(out, res.artifact.bytes);
      console.log(`\n[vm] ✓ 编译成功，产物 ${out}（${res.artifact.bytes.length} 字节）`);
      console.log(`[vm] 校验：python tools/check-elf.py ${out}`);
      console.log(`[vm] 总用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
  }
} catch (e) {
  console.error(`\n[vm] 失败：${e.message}`);
  process.exitCode = 1;
} finally {
  await vm.stop();
  process.exit(process.exitCode ?? 0);
}
