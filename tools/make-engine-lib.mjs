/**
 * 生成 / 更新「引擎预编译归档」lib/libmrp_engine.a（以及它的内容摘要 .key）
 *
 * 背景：src/ 下 19 个 .c 是 mythroad 运行时，每个工程都用同一份。原来每次编译
 * 都把整个运行时重编一遍 —— 在 v86 里实测 206.3 秒，占整条链路 91%。
 * 预编成静态库后，一次构建只剩「编你自己的代码 + 链接」，实测 3.1 秒，
 * 产物逐字节完全一致：同一份运行时没必要在每个工程里重编一遍。
 *
 * 校验：同目录的 libmrp_engine.key 是「src/ 下所有 .c/.h 内容 + 编译参数」的
 * sha256 摘要。Makefile 每次都会现算一份比对，对不上就重建归档 —— 所以改
 * src/ 里的兼容层/适配层（mrp_compat.c、mrc_android.c、各种 .h）都不会漏。
 *
 * 什么时候要重跑本脚本：**改动了 mrp_demo/src/ 下任何 .c/.h** 之后。
 * 生成物 mrp_demo/lib/libmrp_engine.{a,key} 要一起提交（前端会推进虚拟机）。
 *
 * 用法：
 *   node tools/make-engine-lib.mjs              # 生成归档 + 顺手编一遍验证
 *   node tools/make-engine-lib.mjs --no-verify  # 只生成
 *
 * 依赖：assets/image/{vmlinuz.bin,rootfs.tar.gz}（python tools/make-image.py 产物）
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMGDIR = path.join(ROOT, 'assets', 'image');
const V86DIR = path.join(ROOT, 'assets', 'v86');
const DEMO = path.join(ROOT, 'mrp_demo');
const ENGINE_A = path.join(DEMO, 'lib', 'libmrp_engine.a');
const ENGINE_KEY = path.join(DEMO, 'lib', 'libmrp_engine.key');

const args = process.argv.slice(2);
const verify = !args.includes('--no-verify');

const toAB = (p) => {
  const b = fs.readFileSync(p);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const need = (p, what) => {
  if (!fs.existsSync(p)) {
    console.error(`✗ 缺少${what}：${p}`);
    process.exit(2);
  }
  return p;
};

need(path.join(IMGDIR, 'vmlinuz.bin'), ' 内核（先跑 python tools/make-image.py）');
need(path.join(IMGDIR, 'rootfs.tar.gz'), ' 工具链镜像（先跑 python tools/make-image.py）');
need(path.join(DEMO, 'Makefile'), ' 模板 Makefile');

const v86mod = await import(pathToFileURL(path.join(V86DIR, 'libv86.js')).href);
const { MrpVm } = await import(pathToFileURL(path.join(ROOT, 'assets', 'vm.js')).href);
void v86mod;

const engineSrcs = fs.readdirSync(path.join(DEMO, 'src')).filter((n) => n.endsWith('.c'));
console.log(`[engine] 引擎源码 ${engineSrcs.length} 个（mrp_demo/src/*.c）`);

// 编译期的告警有几百行，只把「值得看」的挑出来，避免把工具输出刷爆。
// 注意：串口是逐字节解码的，guest 输出的非 ASCII 到这里一定是乱码，
// 所以匹配串只用 ASCII（Makefile 里那两条 [make] 提示也是刻意写成英文的）。
const INTERESTING = /error|warning: |\*\*\*|FAIL|undefined|cannot|No such|\[make\]/i;
let logLines = 0;
let rawAll = '';

const vm = new MrpVm({
  wasmPath: path.join(V86DIR, 'v86.wasm'),
  bios: { buffer: toAB(path.join(V86DIR, 'bios', 'seabios.bin')) },
  vgaBios: { buffer: toAB(path.join(V86DIR, 'bios', 'vgabios.bin')) },
  kernel: { buffer: toAB(path.join(IMGDIR, 'vmlinuz.bin')) },
  onOutput: (ch) => {
    rawAll += ch;
    for (const part of ch.split(/\r?\n/)) {
      if (!part.trim()) continue;
      logLines++;
      if (INTERESTING.test(part)) process.stdout.write(`  │ ${part.trim()}\n`);
    }
  },
  onStatus: (s) => console.log(`\n[engine] === ${s} ===`),
});

/** 最后一条匹配的数字（避开串口回显与哨兵里的杂数字） */
const lastNum = (re) =>
  Number([...vm.serial.matchAll(re)].at(-1)?.[1] ?? NaN);

const t0 = Date.now();
try {
  console.log('[engine] 启动虚拟机 …');
  await vm.boot();
  console.log(`[engine] shell 就绪（${((Date.now() - t0) / 1000).toFixed(1)}s）`);

  await vm.installToolchain(fs.readFileSync(path.join(IMGDIR, 'rootfs.tar.gz')));
  console.log(`[engine] 工具链就绪（累计 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);

  /*
   * 镜像内置的 mrp_demo/src 与仓库里那份是否一致？
   *
   * 生成出来的归档/摘要描述的是**镜像里**那份源码（因为虚拟机会用它编译）。
   * 两者不一致就意味着：站点上给人看/给人改的源码，和浏览器里真正被编译的
   * 引擎是两个版本 —— 这是最危险的一类不一致（改了半天没生效、或者以为改生效了）。
   * 所以在生成之前先核对一遍，把差异摆出来。
   */
  await vm.run('cd /opt/tc/mrp_demo && sha256sum src/*.c src/*.h', { timeout: 300_000 });
  const guestHashes = new Map();
  for (const m of rawAll.matchAll(/^([0-9a-f]{64})\s+(\S+)$/gm)) guestHashes.set(m[2], m[1]);
  rawAll = '';
  const localFiles = fs
    .readdirSync(path.join(DEMO, 'src'))
    .filter((n) => n.endsWith('.c') || n.endsWith('.h'))
    .sort();
  const mismatched = [];
  for (const n of localFiles) {
    const rel = `src/${n}`;
    const local = crypto.createHash('sha256').update(fs.readFileSync(path.join(DEMO, rel))).digest('hex');
    const guest = guestHashes.get(rel);
    if (guest === undefined) mismatched.push(`${rel}（镜像里没有）`);
    else if (guest !== local) mismatched.push(rel);
  }
  const extraInGuest = [...guestHashes.keys()].filter((k) => !localFiles.includes(k.slice(4)));
  const total = localFiles.length + extraInGuest.length;
  if (!mismatched.length && !extraInGuest.length) {
    console.log(`[engine] 镜像模板与仓库一致（src 下 ${total} 个 .c/.h 全部同摘要）✓`);
  } else {
    console.log(
      `[engine] ⚠ 镜像内置的 mrp_demo/src 与仓库不一致：${total} 个文件里 ` +
        `${mismatched.length + extraInGuest.length} 个对不上`
    );
    for (const f of [...mismatched, ...extraInGuest.map((k) => `${k}（只在镜像里）`)].slice(0, 20)) {
      console.log(`[engine]     ${f}`);
    }
    console.log(
      '[engine]   影响：归档描述的是**镜像里**那份源码。要让仓库里的改动生效，' +
        '得先 `python tools/make-image.py` 重打镜像，再重跑本脚本。'
    );
    console.log('[engine]   （本次仍按镜像里那份源码生成归档 —— 浏览器里编译的正是它）');
  }

  // 用仓库里最新的 Makefile，别用镜像里那份旧的可能没有 engine-archive 目标
  await vm.putFile('__mk', new Uint8Array(fs.readFileSync(path.join(DEMO, 'Makefile'))));
  let rc = await vm.run(
    'cp -f /mnt/__mk /opt/tc/mrp_demo/Makefile && ' +
      'rm -f /opt/tc/mrp_demo/lib/libmrp_engine.a /opt/tc/mrp_demo/lib/libmrp_engine.key'
  );
  if (rc !== 0) throw new Error('写入 Makefile 失败');

  // 真正编译引擎 —— 这是唯一一次 150s 级别的成本
  console.log('[engine] 编译运行时引擎（约 190s，只做这一次）…');
  const tb = Date.now();
  rc = await vm.run('cd /opt/tc/mrp_demo && make engine-archive', { timeout: 1_200_000 });
  if (rc !== 0) throw new Error(`make engine-archive 失败（rc=${rc}）`);
  console.log(`[engine] 归档生成完成，用时 ${((Date.now() - tb) / 1000).toFixed(1)}s`);

  // 成员数必须等于源文件数，否则说明有 .c 编译失败被静默跳过
  rc = await vm.run(
    'cd /opt/tc/mrp_demo && echo "A_MEM""BERS=$(ar t lib/libmrp_engine.a | wc -l)" && ' +
      'echo "A_BYT""ES=$(wc -c < lib/libmrp_engine.a)" && ' +
      'echo "A_KE""YLEN=$(wc -c < lib/libmrp_engine.key)"'
  );
  if (rc !== 0) throw new Error('读取归档信息失败');
  const members = lastNum(/A_MEMBERS=(\d+)/g);
  const bytes = lastNum(/A_BYTES=(\d+)/g);
  const keyLen = lastNum(/A_KEYLEN=(\d+)/g);
  console.log(`[engine] 归档：${members} 个成员 / ${bytes} 字节 / 内容摘要 ${keyLen} 字节`);
  if (members !== engineSrcs.length) {
    throw new Error(`成员数 ${members} ≠ 源文件数 ${engineSrcs.length}，有 .c 没编进去`);
  }
  if (!Number.isFinite(keyLen) || keyLen < 32) {
    throw new Error('内容摘要（lib/libmrp_engine.key）没生成 —— 归档无法校验一致性');
  }

  // 取回归档 + 摘要（摘要决定下次构建要不要重建，缺了会白重建一次 ≈190s）
  for (const [src, dst] of [
    ['/opt/tc/mrp_demo/lib/libmrp_engine.a', ENGINE_A],
    ['/opt/tc/mrp_demo/lib/libmrp_engine.key', ENGINE_KEY],
  ]) {
    rc = await vm.run(`cp -f ${src} /mnt/__pull`);
    if (rc !== 0) throw new Error(`取回 ${src} 失败`);
    const got = await vm.getFile('__pull');
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, got);
    console.log(`[engine] ✓ 已写入 ${path.relative(ROOT, dst)}（${got.length} 字节）`);
  }

  // 自检：摘要与归档、源码三者已一致 → 下一次 make 不该再计划重建
  await vm.run('cd /opt/tc/mrp_demo && make -n engine-archive > /tmp/k 2>&1; echo "A_REBUI""LD=$(grep -c precompiling /tmp/k)"');
  const rebuild = lastNum(/A_REBUILD=(\d+)/g);
  console.log(`[engine] 自检：摘要一致后 make 仍计划重建 = ${rebuild === 0 ? '否 ✓' : '是 ✗'}`);
  if (rebuild !== 0) throw new Error('摘要写回后仍判定要重建，说明 key 的算法前后不一致');

  if (verify) {
    console.log('[engine] 验证：用归档编一遍完整工程 …');
    const tv = Date.now();
    rc = await vm.run('cd /opt/tc/mrp_demo && rm -f bin.elf && make', { timeout: 600_000 });
    if (rc !== 0) throw new Error(`用归档链接失败（rc=${rc}）`);
    await vm.run('cp -f /opt/tc/mrp_demo/bin.elf /mnt/__artifact');
    const elf = await vm.getFile('__artifact');
    fs.mkdirSync(path.join(ROOT, '.build'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, '.build', 'bin.elf'), elf);
    const isElf =
      elf.length > 4 && elf[0] === 0x7f && elf[1] === 0x45 && elf[2] === 0x4c && elf[3] === 0x46;
    console.log(
      `[engine] ✓ 快路径编译 ${((Date.now() - tv) / 1000).toFixed(1)}s，bin.elf ${elf.length} 字节` +
        `${isElf ? '' : ' ⚠ 不是 ELF'} → .build/bin.elf`
    );
    console.log('[engine]   校验：python tools/check-elf.py .build/bin.elf');
  }

  console.log(`\n[engine] 全部完成，总用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('[engine] 记得把 mrp_demo/lib/libmrp_engine.a 与 .key 一起提交（前端靠它们提速）。');
} catch (e) {
  console.error(`\n[engine] ✗ 失败：${e.message}`);
  process.exitCode = 1;
} finally {
  console.log(`[engine] 串口共 ${logLines} 行`);
  await vm.stop();
  process.exit(process.exitCode ?? 0);
}
