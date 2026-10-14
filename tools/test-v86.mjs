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

const mod = await import(pathToFileURL(path.join(V86DIR, 'libv86.js')).href);
const { MrpVm } = await import(pathToFileURL(path.join(ROOT, 'assets', 'vm.js')).href);
const { fmtDuration } = await import(pathToFileURL(path.join(ROOT, 'assets', 'bytes.js')).href);
const { zipDeflate, unzip } = await import(pathToFileURL(path.join(ROOT, 'assets', 'zip.js')).href);
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

  // v86 的鼠标 / 键盘适配器必须关掉：不传 screen_container 时它的「屏幕区域」回落到
  // document.body，且 mousedown / wheel / contextmenu 都无条件 preventDefault ——
  // guest 一启动就把宿主页面上这些默认行为全吃掉（输入框点不进去、选不中，滚轮失效）。
  // 适配器对象在 Node 里同样会被创建（只是不挂 window 监听），所以这条断言真的有效。
  const vmEmu = vm.emulator;
  console.log(
    `[vm] v86 适配器：mouse=${vmEmu.mouse_adapter ? '存在（❌ 会污染宿主页面）' : '不存在 ✓'}` +
      ` keyboard=${vmEmu.keyboard_adapter ? '存在' : '不存在 ✓'}`
  );
  if (vmEmu.mouse_adapter || vmEmu.keyboard_adapter) {
    console.error('[vm] ✗ 适配器没被关掉 → 见 tools/test-v86-mouse.mjs');
    process.exitCode = 1;
  }

  await vm.installToolchain(fs.readFileSync(rootfsPath), {
    onProgress: (p) => console.log(`[vm] 工具链进度 ${Math.round(p * 100)}%`),
  });
  console.log(`\n[vm] 工具链就绪，累计 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // 和界面一样：启动完先把内置模板清单记下来（「下载demo」用的就是这一份；
  // 编译之后工程目录里会多出 bin.elf / 引擎归档，那已经不是"内置模板"了）
  const template = (await vm.listProjectFiles()).filter((n) => !n.includes('libmrp_engine.'));
  console.log(`[vm] 内置模板 ${template.length} 个文件`);

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

    // 镜像里那份模板 Makefile 是打镜像那一刻的版本，可能还没有引擎归档逻辑，
    // 所以和 assets/app.js 一样：先推站点上最新的 Makefile 覆盖它。
    const mkPath = path.join(ROOT, 'mrp_demo', 'Makefile');
    if (fs.existsSync(mkPath)) {
      files['Makefile'] = new Uint8Array(fs.readFileSync(mkPath));
      console.log('[vm] 投入 mrp_demo/Makefile（站点最新版，覆盖镜像里的）');
    }

    // 引擎预编译归档 + 内容摘要：与 assets/app.js 的推送方式保持一致
    // （两个都推才走快路径 3 秒；只推 .a 会被摘要校验判成过期，在虚拟机里重编 ≈190 秒）。
    const engineDir = path.join(ROOT, 'mrp_demo', 'lib');
    for (const name of ['libmrp_engine.a', 'libmrp_engine.key']) {
      const p = path.join(engineDir, name);
      if (fs.existsSync(p)) {
        files[`lib/${name}`] = new Uint8Array(fs.readFileSync(p));
        console.log(`[vm] 投入 ${`lib/${name}`}（${(fs.statSync(p).size / 1024).toFixed(0)} KiB）`);
      } else {
        console.log(`[vm] ⚠ 没有 mrp_demo/lib/${name} —— 本次会在虚拟机里全量重编引擎`);
        console.log('[vm]   生成它：node tools/make-engine-lib.mjs');
        break;
      }
    }

    const res = await vm.build({
      files,
      app: process.env.APP || 'helloworld.c',
      target: process.env.TARGET || 'bin.elf',
      extra: process.env.EXTRA || '',
    });
    // 与界面同一套口径（assets/bytes.js 的 fmtDuration），别各自再写一份
    if (res.timing) {
      const t = res.timing;
      console.log(
        `[vm] 编译耗时 ${fmtDuration(t.totalMs)}` +
          `（同步源码 ${fmtDuration(t.syncMs)} · 编译 ${fmtDuration(t.compileMs)} · 取回产物 ${fmtDuration(t.artifactMs)}）`
      );
      console.log(
        t.compileMs < 30_000
          ? '[vm]   → 走的是引擎预编译归档（快路径）'
          : '[vm]   → 在虚拟机里全量重编了引擎（慢路径），检查 Makefile / 归档有没有推成功'
      );
    }

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

      // ---- 复现界面「下载demo」那条路：从虚拟机现取模板 → 打包 → 读回核对 ----
      console.log(`\n[vm] 打包 demo 工程包（从虚拟机取 ${template.length} 个模板文件）…`);
      const tDemo = Date.now();
      const demoFiles = [];
      for (const n of [...template].sort()) {
        demoFiles.push({ name: n, data: await vm.readProjectFile(n) });
      }
      const demoZip = await zipDeflate(demoFiles);
      const demoBack = await unzip(demoZip);
      const badDemo = demoFiles.filter((f) => demoBack[f.name]?.length !== f.data.length);
      const rawBytes = demoFiles.reduce((n, f) => n + f.data.length, 0);
      const demoOk = Object.keys(demoBack).length === demoFiles.length && !badDemo.length;
      console.log(
        `[vm] demo 包：${demoFiles.length} 个文件，${(rawBytes / 1024).toFixed(0)} KiB → ` +
          `${(demoZip.length / 1024).toFixed(0)} KiB，用时 ${fmtDuration(Date.now() - tDemo)}`
      );
      console.log(
        demoOk
          ? '[vm]   自检：用项目自己的 zip 解析器读回，条目数与每项长度一致 ✓'
          : `[vm]   ✗ 自检失败：${Object.keys(demoBack).length}/${demoFiles.length} 项` +
            (badDemo.length ? `，长度不符 ${badDemo.slice(0, 3).map((f) => f.name).join('、')}` : '')
      );
      if (!demoOk) process.exitCode = 1;
    }
  }
} catch (e) {
  console.error(`\n[vm] 失败：${e.message}`);
  process.exitCode = 1;
} finally {
  await vm.stop();
  process.exit(process.exitCode ?? 0);
}
