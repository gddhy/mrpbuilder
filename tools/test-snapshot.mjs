/**
 * 单测 assets/snapshot.js（启动快照的指纹与压缩）+ imagecache.js 的内核缓存判定。
 *
 * 这里判错的代价不对称，和 imagecache 一样：
 *   误判「快照可用」→ restore_state 灌进一份与镜像不匹配的 state，表现是串口
 *     胡言乱语、/mnt 挂不上、甚至整台虚拟机卡死 —— 比多启动一次难受得多；
 *   误判「快照不可用」→ 白冷启动一次（≈30 秒）。
 * 所以指纹判定必须保守：任何一项对不上都当没命中。
 *
 * IndexedDB 在 Node 里不存在 —— 顺带验证「拿不到存储时优雅降级」（file://、
 * 隐私模式走的就是这条路）。
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const snap = await import(pathToFileURL(path.join(ROOT, 'assets', 'snapshot.js')).href);
const ic = await import(pathToFileURL(path.join(ROOT, 'assets', 'imagecache.js')).href);

let failed = 0;
function ok(name, pass, detail = '') {
  if (!pass) failed++;
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
}

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const base = {
  imageBuilt: '2026-09-16T21:07:06',
  rootfsSha: SHA_A,
  kernelSha: SHA_B,
  memorySize: 384 * 1024 * 1024,
};

console.log('===== snapshot.js：快照指纹 =====');

const key0 = snap.snapshotKeyOf(base);
ok('同样的输入 → 同样的 key', key0 === snap.snapshotKeyOf({ ...base }));
ok('rootfs 换了 → key 变', key0 !== snap.snapshotKeyOf({ ...base, rootfsSha: SHA_C }));
ok('内核换了 → key 变', key0 !== snap.snapshotKeyOf({ ...base, kernelSha: SHA_C }));
ok('内存大小改了 → key 变', key0 !== snap.snapshotKeyOf({ ...base, memorySize: 256 * 1024 * 1024 }));
ok('镜像重打了（built 变）→ key 变', key0 !== snap.snapshotKeyOf({ ...base, imageBuilt: '2026-11-20T10:00:00' }));
ok('快照格式版本参与 key', key0 !== snap.snapshotKeyOf({ ...base, version: 99 }));
ok('什么都没有也不炸', typeof snap.snapshotKeyOf({}) === 'string' && snap.snapshotKeyOf({}).length > 0);

console.log('\n===== snapshot.js：记录可用性 =====');
const rec = { key: key0, bytes: new Uint8Array([1, 2, 3]) };
ok('key 对得上 → 可用', snap.snapshotRecordMatches(rec, key0) === true);
ok('key 不同 → 不可用', snap.snapshotRecordMatches(rec, 'other') === false);
ok('没有字节 → 不可用', snap.snapshotRecordMatches({ key: key0 }, key0) === false);
ok('null 记录 → 不可用', snap.snapshotRecordMatches(null, key0) === false);
ok('空 key → 不可用', snap.snapshotRecordMatches(rec, '') === false);

console.log('\n===== snapshot.js：压缩往返 =====');
// 384MB 全零页在测试里太大，用 4MB 稀疏数据代表（压缩率同样是几十倍）
const raw = new Uint8Array(4 * 1024 * 1024);
for (let i = 0; i < raw.length; i += 4096) raw[i] = i & 0xff;
const packed = await snap.compressSnapshot(raw);
ok('有 CompressionStream 时确实压缩了', packed.compressed === true, `${raw.length} → ${packed.bytes.length} 字节`);
ok('压缩率合理（< 1/10）', packed.bytes.length < raw.length / 10);

const back = await snap.decompressSnapshot(packed.bytes, { compressed: true, rawSize: raw.length });
ok('解压后长度一致', !!back && back.length === raw.length);
ok(
  '解压后逐字节一致',
  !!back && back.every((v, i) => v === raw[i])
);
ok(
  'rawSize 对不上 → 判为不可用（防止半截 state 灌给 v86）',
  (await snap.decompressSnapshot(packed.bytes, { compressed: true, rawSize: raw.length - 1 })) === null
);
ok('compressed=false 时原样返回', (await snap.decompressSnapshot(raw, { compressed: false })) === raw);
ok('坏字节 → null', (await snap.decompressSnapshot(new Uint8Array([1, 2, 3]), { compressed: true })) === null);

console.log('\n===== 无 IndexedDB 时优雅降级（file:// / 隐私模式）=====');
ok('readSnapshot → null', (await snap.readSnapshot(key0)) === null);
ok('writeSnapshot → false', (await snap.writeSnapshot(key0, { bytes: new Uint8Array(1) })) === false);
ok('clearSnapshot → false', (await snap.clearSnapshot()) === false);

console.log('\n===== imagecache.js：内核缓存判定 =====');
const KERNEL_SIZE = 10_068_480;
const meta = { sha256: SHA_A, size: KERNEL_SIZE };
const entry = { bytes: new Uint8Array(KERNEL_SIZE), sha256: SHA_A, size: KERNEL_SIZE, savedAt: 1 };
ok('正常的缓存命中', ic.kernelCacheMatches(entry, meta) === true);
ok('sha 不符 → 不命中', ic.kernelCacheMatches({ ...entry, sha256: SHA_B }, meta) === false);
ok('记录里的大小不符 → 不命中', ic.kernelCacheMatches({ ...entry, size: KERNEL_SIZE - 1 }, meta) === false);
ok('实际字节数不符 → 不命中', ic.kernelCacheMatches({ ...entry, bytes: new Uint8Array(16) }, meta) === false);
ok('老 image.json（没有 kernel_sha256）→ 不复用', ic.kernelCacheMatches(entry, {}) === false);
ok('元信息缺 size → 不复用', ic.kernelCacheMatches(entry, { sha256: SHA_A }) === false);
ok('空条目 → 不命中', ic.kernelCacheMatches(null, meta) === false);
ok('无 IndexedDB 时 readKernelCache → null', (await ic.readKernelCache()) === null);
ok('无 IndexedDB 时 writeKernelCache → false', (await ic.writeKernelCache(new Uint8Array(4), meta)) === false);

console.log('\n===== imagecache.js：启动前的版本对账 =====');
const planBase = {
  manifest: { sha256: SHA_A, size: 32_134_639, parts: [{ name: 'p0', size: 32_134_639 }] },
  meta: { kernel_sha256: SHA_B, kernel_bytes: KERNEL_SIZE, built: '2026-09-16T21:07:06' },
  cachedRootfs: { sha256: SHA_A, size: 32_134_639, bytes: new Uint8Array(4) },
  cachedKernel: { sha256: SHA_B, size: KERNEL_SIZE, bytes: new Uint8Array(4) },
};

const same = ic.resolveImagePlan(planBase);
ok('线上与本地一致 → 不算更新', same.updated === false && same.online === true && same.hasCache === true);
ok('一致时摘要取线上那份', same.rootfsSha === SHA_A && same.kernelSha === SHA_B);

const rootfsChanged = ic.resolveImagePlan({ ...planBase, manifest: { ...planBase.manifest, sha256: SHA_C } });
ok('线上 rootfs 变了 → rootfsUpdated', rootfsChanged.rootfsUpdated === true && rootfsChanged.updated === true);
ok('rootfs 变了 → 摘要跟着线上走', rootfsChanged.rootfsSha === SHA_C);

const kernelChanged = ic.resolveImagePlan({ ...planBase, meta: { ...planBase.meta, kernel_sha256: SHA_C } });
ok('线上内核变了 → kernelUpdated（也要作废快照）', kernelChanged.kernelUpdated === true && kernelChanged.updated === true);

const firstTime = ic.resolveImagePlan({
  manifest: planBase.manifest,
  meta: planBase.meta,
  cachedRootfs: null,
  cachedKernel: null,
});
ok('首次使用不算「已更新」', firstTime.updated === false && firstTime.hasCache === false);
ok('首次也拿得到线上摘要', firstTime.rootfsSha === SHA_A && firstTime.kernelSha === SHA_B);

const offlineCached = ic.resolveImagePlan({ ...planBase, manifest: null, meta: null });
ok('离线（无清单）但有缓存 → online=false', offlineCached.online === false);
ok('离线时摘要回落本地缓存（快照才不会白失效）', offlineCached.rootfsSha === SHA_A);
ok('离线且没有内核元信息 → kernelSha 也回落缓存', offlineCached.kernelSha === SHA_B);
ok('离线不会误判成「已更新」', offlineCached.updated === false);

const offlineCold = ic.resolveImagePlan({ manifest: null, meta: null });
ok('离线且没缓存 → 摘要为空，交给后续报错', offlineCold.rootfsSha === '' && offlineCold.hasCache === false);

const oldDeploy = ic.resolveImagePlan({
  manifest: planBase.manifest,
  meta: { built: 'x' }, // 老部署：没有 kernel_sha256
  cachedRootfs: planBase.cachedRootfs,
  cachedKernel: planBase.cachedKernel,
});
ok('老部署缺 kernel 元信息 → 用缓存摘要且不判更新', oldDeploy.kernelSha === SHA_B && oldDeploy.kernelUpdated === false);

console.log('\n===== vm.js：共享目录挂载参数解析 =====');
const { parseShareMount, kernelOption } = await import(
  pathToFileURL(path.join(ROOT, 'assets', 'vm.js')).href
);

console.log('\n===== vm.js：内核入参规范化（v86 只认 ArrayBuffer）=====');
// v86 的 Da() 是 `if (a.buffer instanceof ArrayBuffer)`，传 Uint8Array 会静默返回
// undefined → 内核不加载 → 卡在「启动虚拟机」没有任何输出。这条真踩过。
const ab = new ArrayBuffer(8);
const view = new Uint8Array(ab);
const sub = new Uint8Array(ab, 2, 4);
ok('{buffer: ArrayBuffer} 原样通过', kernelOption({ buffer: ab })?.buffer === ab);
ok(
  '{buffer: Uint8Array} 转成 ArrayBuffer',
  kernelOption({ buffer: view })?.buffer instanceof ArrayBuffer
);
ok(
  'Uint8Array 子视图只取自己那一段（不越界）',
  (() => {
    const o = kernelOption({ buffer: sub });
    return o?.buffer instanceof ArrayBuffer && o.buffer.byteLength === 4;
  })()
);
ok('裸 Uint8Array 也能转', kernelOption(view)?.buffer instanceof ArrayBuffer);
ok('{url} 原样交给 v86', kernelOption({ url: 'image/vmlinuz.bin' })?.url === 'image/vmlinuz.bin');
ok('null / undefined 不炸', kernelOption(null) === null && kernelOption(undefined) === undefined);

// 这两行都是真实抓到的（v86 的 9p tag 是 host9p，不是 hostshare）
const procLine = 'host9p /mnt 9p rw,relatime,access=client,trans=virtio 0 0';
const mountLine = 'host9p on /mnt type 9p (rw,relatime,access=client,trans=virtio)';

const fromProc = parseShareMount(procLine);
ok(
  '/proc/mounts 格式能解析',
  !!fromProc && fromProc.device === 'host9p' && fromProc.type === '9p',
  JSON.stringify(fromProc)
);
ok('只留 trans / access，丢掉 rw、relatime', fromProc?.options === 'trans=virtio,access=client', fromProc?.options);
const fromMount = parseShareMount(mountLine);
ok('mount(8) 格式结果一致', !!fromMount && fromMount.device === 'host9p' && fromMount.options === fromProc?.options);
ok(
  '带 version 时保留 version',
  parseShareMount('host9p /mnt 9p rw,trans=virtio,version=9p2000.L 0 0')?.options ===
    'trans=virtio,version=9p2000.L'
);
ok('认不出 trans → null（不是 virtio-9p 就不冒险挂）', parseShareMount('tmpfs /mnt tmpfs rw 0 0') === null);
ok('别的挂载点不算', parseShareMount('host9p /mnt2 9p rw,trans=virtio 0 0') === null);
ok('空输入 → null', parseShareMount('') === null && parseShareMount(null) === null);
ok(
  '多行里挑出 /mnt 那行',
  parseShareMount('dev / ext4 rw 0 0\nhost9p /mnt 9p rw,trans=virtio 0 0\n')?.device === 'host9p'
);

console.log(`\n${failed ? `✗ ${failed} 项失败` : '✓ 全部通过'}`);
process.exit(failed ? 1 : 0);
