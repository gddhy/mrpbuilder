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
/**
 * 界面看到的那份日志（`_forward` 过滤后的）—— 顺手断言它里面**不含我们自己命令的碎片**。
 * 反例：长命令的回显会被行编辑器在 80 列处折成多行，含哨兵那段被滤掉、碎片留下，
 * 用户就会在「✓ 已删除 xxx」旁边看到 `2=$?"` 这种一行（真被报过）。
 * 命令正文现在写在 9p 脚本文件里、敲进去的只有 `sh /mnt/__cmd`，所以碎片应当绝迹。
 */
const visibleLog = [];
const sentCommands = [];
const vm = new MrpVm({
  wasmPath: path.join(V86DIR, 'v86.wasm'),
  bios: { buffer: toArrayBuffer(path.join(V86DIR, 'bios', 'seabios.bin')) },
  vgaBios: { buffer: toArrayBuffer(path.join(V86DIR, 'bios', 'vgabios.bin')) },
  kernel: { buffer: toArrayBuffer(kernelPath) },
  // 和界面一样走过滤：这里要看的就是"用户实际看到什么"
  onOutput: (ch) => {
    process.stdout.write(ch);
    visibleLog.push(ch);
    lastLine += ch;
    if (lastLine.length > 400) lastLine = lastLine.slice(-400);
  },
  onStatus: (s) => process.stdout.write(`\n[vm] === ${s} ===\n`),
});

/*
 * 把 vm.run 包一层：**内部**调用（build / installToolchain / 列目录…）也要进 sentCommands，
 * 否则"日志里有没有自己命令的碎片"这条断言只盯着测试自己发的几条、等于没查。
 * 必须在 boot() 之前挂上。
 */
const rawRun = vm.run.bind(vm);
const runCmd = (cmd, opts) => {
  sentCommands.push(cmd);
  return rawRun(cmd, opts);
};
vm.run = (cmd, opts) => runCmd(cmd, opts);

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
  const listed = await vm.listProjectFiles();
  const template = listed.map((f) => f.name).filter((n) => !n.includes('libmrp_engine.'));
  console.log(`[vm] 内置模板 ${template.length} 个文件`);
  const noSize = listed.filter((f) => !(f.size > 0));
  if (noSize.length || !listed.length) {
    console.error(`[vm] ✗ 文件大小没取到：${listed.length} 项里 ${noSize.length} 项没有大小`);
    process.exitCode = 1;
  } else {
    const big = listed.slice().sort((a, b) => b.size - a.size)[0];
    console.log(`[vm] 文件大小 ✓ ${listed.length} 项都有（最大 ${big.name} = ${big.size} 字节）`);
  }

  /*
   * 工程文件的重命名 / 删除（界面里那两个按钮走的就是这几个方法）。
   * 用「带空格 + 中文」的临时文件：一次把「引号」和「非 ASCII 经串口」两件事都验了 ——
   * 早期 serial0_send 按 charCodeAt 发，中文会被截断成控制字符、直接把命令行打断。
   * 用完删掉，不碰内置模板。
   */
  if (!customCmd && !diag) {
    const { shProjectPath } = await import(
      pathToFileURL(path.join(ROOT, 'assets', 'serial.js')).href
    );
    const scratch = 'tmp 临时 文件.txt';
    const renamed = 'tmp 改名 之后.txt';
    const p = (rel) => shProjectPath('/opt/tc/mrp_demo', rel);
    const names = async () => (await vm.listProjectFiles()).map((f) => f.name);
    const find = async (n) => (await vm.listProjectFiles()).find((f) => f.name === n);

    await runCmd(`printf 'hello' > ${p(scratch)}`, { timeout: 60_000 });
    const created = await find(scratch);
    console.log(
      `[vm] 建临时文件「${scratch}」→ ${created ? `${created.size} 字节 ✓（名字原样回来）` : '没列出来 ✗'}`
    );
    if (!created || created.size !== 5) process.exitCode = 1;

    const back = new TextDecoder().decode(await vm.readProjectFile(scratch));
    if (back !== 'hello') {
      console.error(`[vm] ✗ 读回内容不对：${JSON.stringify(back)}`);
      process.exitCode = 1;
    } else {
      console.log('[vm] 按名字读回内容 ✓（非 ASCII 路径能拼进命令）');
    }

    await vm.renameProjectFile(scratch, renamed);
    const list1 = await names();
    const okRename = list1.includes(renamed) && !list1.includes(scratch);
    console.log(`[vm] 重命名 →「${renamed}」${okRename ? ' ✓' : ' ✗'}`);
    if (!okRename) process.exitCode = 1;

    await vm.deleteProjectFile(renamed);
    const list2 = await names();
    const okDelete = !list2.includes(renamed);
    console.log(`[vm] 删除 ✓ 剩余 ${list2.length} 个文件${okDelete ? '' : '（✗ 还列得出来）'}`);
    if (!okDelete) process.exitCode = 1;
  }

  if (customCmd) {
    const rc = await runCmd(customCmd, { timeout: 900_000 });
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
    await runCmd(
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

  /*
   * 可见日志干不干净：**里面不该出现我们自己命令的碎片**。
   * 长命令的回显会被行编辑器的 80 列折行切成几段，只有含哨兵那段会被滤掉 ——
   * 碎片（`2=$?"` / `?"`）混在「✓ 已删除 xxx」旁边，用户根本分不清状态。
   * 现在命令正文走 9p 脚本文件，敲进去的只有 `sh /mnt/__cmd`。
   * 这里用「某一行是不是我们发过的某条命令的子串」来兜底，比枚举坏样子靠谱。
   *
   * ⚠ 已知误报形态：命令里**自己 echo 一段字面量**（例如结尾写 `; echo linked`），
   *   那行输出天然是命令的子串 → 会命中。修法是别 echo 自己的文案，
   *   或者用 `echo "lin""ked"` 这种拆开写的写法（哨兵线也是这么处理的）。
   */
  {
    const text = visibleLog.join('');
    const leaks = [];
    for (const line of text.split(/\r?\n/)) {
      const t = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
      if (t.length < 3) continue;
      if (sentCommands.some((c) => c.includes(t))) leaks.push(t);
    }
    console.log(
      leaks.length
        ? `[vm] ✗ 日志里有 ${leaks.length} 行是我们自己命令的回显碎片：${leaks.slice(0, 3).map((l) => JSON.stringify(l)).join('、')}`
        : `[vm] 可见日志干净 ✓ 没有命令回显碎片（${sentCommands.length} 条命令，${text.split(/\r?\n/).length} 行输出）`
    );
    if (leaks.length) process.exitCode = 1;
  }
} catch (e) {
  console.error(`\n[vm] 失败：${e.message}`);
  process.exitCode = 1;
} finally {
  await vm.stop();
  process.exit(process.exitCode ?? 0);
}
