/**
 * 单测 assets/imagecache.js —— 工具链镜像本地缓存的判定规则。
 *
 * 这里判错的代价不对称：
 *   误判「缓存有效」→ 用错版本的工具链编译，产物可能上真机才发现不对；
 *   误判「缓存无效」→ 多下一次 30.6 MiB，只是慢。
 * 所以判定必须保守：只要有一项对不上就当没命中。
 * 另外还盯住「环境不支持存储时必须优雅退化」——file:// 打开、隐私模式都不该炸。
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  cacheEntryMatches,
  openImageCache,
  readImageCache,
  writeImageCache,
  clearImageCache,
} = await import(pathToFileURL(path.join(ROOT, 'assets', 'imagecache.js')).href);

let failed = 0;
function ok(name, pass, detail = '') {
  if (!pass) failed++;
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
}

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const bytesOf = (n) => new Uint8Array(n).fill(7);

const manifest = { size: 32_134_639, sha256: SHA_A, parts: [{ name: 'p0', size: 32_134_639 }] };
const goodEntry = { bytes: bytesOf(32_134_639), sha256: SHA_A, size: 32_134_639, savedAt: 1 };

console.log('===== imagecache.js 缓存判定 =====');

ok('正常的缓存命中', cacheEntryMatches(goodEntry, manifest) === true);

// —— 每一项对不上都必须判为「没命中」——
ok('没有缓存条目', cacheEntryMatches(null, manifest) === false);
ok('没有清单（判断不了线上有没有变）', cacheEntryMatches(goodEntry, null) === false);
ok('清单没有 sha256', cacheEntryMatches(goodEntry, { size: 32_134_639 }) === false);
ok('清单没有 size', cacheEntryMatches(goodEntry, { sha256: SHA_A }) === false);
ok(
  '线上换过镜像（sha 不同）',
  cacheEntryMatches({ ...goodEntry, sha256: SHA_B }, manifest) === false
);
ok(
  '本地记录的大小与清单不符',
  cacheEntryMatches({ ...goodEntry, size: 1 }, manifest) === false
);
ok(
  '实际字节数与清单不符（存了一半）',
  cacheEntryMatches({ ...goodEntry, bytes: bytesOf(1000) }, manifest) === false
);
ok('bytes 缺失', cacheEntryMatches({ sha256: SHA_A, size: 32_134_639 }, manifest) === false);
ok('清单 size 为 0', cacheEntryMatches(goodEntry, { sha256: SHA_A, size: 0 }) === false);

// ArrayBuffer 形态也要能算出长度（IndexedDB 可能把 Uint8Array 还原成 ArrayBuffer）
ok(
  'bytes 是 ArrayBuffer 也能判',
  cacheEntryMatches(
    { bytes: bytesOf(4096).buffer, sha256: SHA_A, size: 4096 },
    { sha256: SHA_A, size: 4096 }
  ) === true
);

// —— 环境不支持存储时：不抛错，全部降级成「没有缓存」——
console.log('===== 无 indexedDB 时优雅退化（Node 下就是这种情况）=====');
ok('openImageCache 返回 null', (await openImageCache()) === null);
ok('readImageCache 返回 null', (await readImageCache()) === null);
ok('writeImageCache 返回 false（不抛）', (await writeImageCache(bytesOf(16), {})) === false);
ok('clearImageCache 返回 false（不抛）', (await clearImageCache()) === false);

console.log(`\n${failed ? `${failed} 项失败` : '全部通过'}`);
process.exit(failed ? 1 : 0);
