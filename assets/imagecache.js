/**
 * 工具链镜像的本地缓存（IndexedDB）。
 *
 * 为什么需要：rootfs 有 30.6 MiB（切成 2 段），而加载路径上一直是
 * `fetch(..., { cache: 'no-store' })` —— 每次打开页面都整包重下。慢网下这是
 * 十几秒到几十秒的纯等待，而且完全没必要：镜像只在重新打镜像时才变。
 *
 * 策略：下载完成后把**拼合好的整包**存进 IndexedDB，下次先用本地那份；
 * 只要 `image/rootfs.parts.json`（几百字节，永远 no-store）里的 sha256
 * 与本地记录一致就直接用，不一致说明线上换过镜像 → 重新拉取并覆盖。
 *
 * 三个边界情况：
 *   · file:// / 隐私模式 / 禁用存储 → 拿不到 indexedDB，全部降级成不缓存，
 *     行为与以前完全一致（只是慢），不抛错；
 *   · 没有 parts.json 清单时**不复用缓存** —— 没有清单就无法判断线上有没有变，
 *     宁可重下也不要用错版本的工具链；
 *   · 存进去的字节会在读出来之后按清单 sha256 再校验一遍，损坏就当成没命中
 *     并重新下载（自愈），所以本模块不需要额外的"清缓存"按钮。
 */

export const IMAGE_CACHE_DB = 'mrp-toolchain';
export const IMAGE_CACHE_STORE = 'images';
export const IMAGE_CACHE_KEY = 'rootfs.tar.gz';

/**
 * 内核也存一份。
 *
 * 为什么：启动快照（assets/snapshot.js）能让二次打开直接恢复内存状态，但
 * `new V86({ initial_state })` 仍然要把内核喂给 init —— 恢复路径上如果内核
 * 还得联网拉 10 MiB，那"离线可用"就只做了一半。工具链那份 31 MiB 都缓存了，
 * 没道理漏掉这个更小的。
 *
 * 判定比 rootfs 更保守：内核的 sha256 是后加到 image.json 的（kernel_sha256），
 * 老部署里没有这个字段 —— 那种情况下**不复用缓存**，宁可多下一次，也不要用
 * 一版来路不明的内核去引导虚拟机。
 */
export const KERNEL_CACHE_KEY = 'vmlinuz.bin';

/** 字节数（ArrayBuffer / Uint8Array / Blob 都吃） */
function byteLength(b) {
  if (!b) return 0;
  if (typeof b.byteLength === 'number') return b.byteLength;
  if (typeof b.size === 'number') return b.size;
  return 0;
}

/**
 * 缓存条目对这份分段清单还有效吗？（纯函数，单测盯这里）
 *
 * 有效必须同时满足：
 *   1. 有清单且清单带 sha256 + size —— 没有清单就没有"线上有没有变"的判断依据；
 *   2. 本地记录的 sha256 与清单一致 —— 线上镜像换过就得重下；
 *   3. 本地字节数 == 清单里的整包大小 —— 防止存了一半就被掐断。
 * 注意这里**不看** savedAt：时间新旧不能说明内容新旧，只有 sha 能。
 */
export function cacheEntryMatches(entry, manifest) {
  if (!entry) return false;
  const wantSha = manifest?.sha256;
  const wantSize = manifest?.size;
  if (!wantSha || !wantSize) return false;
  if (entry.sha256 !== wantSha) return false;
  if (entry.size !== wantSize) return false;
  return byteLength(entry.bytes) === wantSize;
}

/**
 * 「这次该用哪一份镜像」的总判定（纯函数，单测盯这里）。
 *
 * 启动时先做这一步，再决定用不用本地缓存、以及启动快照还能不能用。
 * 输入是**线上清单**（rootfs.parts.json / image.json，都是 no-store 现取的）
 * 和本地缓存记录，输出三件事：
 *
 *   1. rootfsSha / kernelSha —— 本次**实际会用到**的那份镜像的摘要。
 *      线上清单拿不到时回落到本地缓存记录的摘要（离线场景）。这一步很关键：
 *      启动快照的 key 就是拿它算的，若这里给空值，离线时快照会凭空失效、
 *      退化成每次冷启动。
 *   2. rootfsUpdated / kernelUpdated —— 线上跟本地缓存对不上（工具链换过）。
 *   3. updated —— 两者任一为真：调用方要**作废本地快照**并重新线上获取，
 *      因为旧快照里的 /opt/tc 是上一版工具链，拿它编出来的东西不可信。
 *
 * 注意「首次使用」不算更新：本地缓存摘要为空时 updated 必须为 false，
 * 否则第一次打开会打出「已更新」的误导文案（其实什么都没更新，只是还没缓存）。
 */
export function resolveImagePlan({ manifest, meta, cachedRootfs, cachedKernel } = {}) {
  const onlineRootfsSha = manifest?.sha256 || '';
  const onlineKernelSha = meta?.kernel_sha256 || '';
  const cachedRootfsSha = cachedRootfs?.sha256 || '';
  const cachedKernelSha = cachedKernel?.sha256 || '';

  // 有 rootfs 清单，才谈得上「知道线上是什么版本」
  const online = !!onlineRootfsSha;
  const rootfsUpdated = !!(onlineRootfsSha && cachedRootfsSha && onlineRootfsSha !== cachedRootfsSha);
  const kernelUpdated = !!(onlineKernelSha && cachedKernelSha && onlineKernelSha !== cachedKernelSha);

  return {
    online,
    rootfsSha: onlineRootfsSha || cachedRootfsSha,
    kernelSha: onlineKernelSha || cachedKernelSha,
    rootfsUpdated,
    kernelUpdated,
    updated: rootfsUpdated || kernelUpdated,
    hasCache: !!cachedRootfsSha,
    built: meta?.built || '',
  };
}

/** 打开数据库；不支持/被拒时返回 null（调用方据此降级） */
export async function openImageCache() {
  try {
    if (typeof indexedDB === 'undefined' || !indexedDB) return null;
    return await new Promise((resolve) => {
      const req = indexedDB.open(IMAGE_CACHE_DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IMAGE_CACHE_STORE)) {
          db.createObjectStore(IMAGE_CACHE_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
  } catch {
    return null;
  }
}

/** 读一条记录（内部共用）：{ bytes, sha256, size, savedAt } | null */
async function readRecord(key) {
  const db = await openImageCache();
  if (!db) return null;
  try {
    return await new Promise((resolve) => {
      const req = db.transaction(IMAGE_CACHE_STORE, 'readonly').objectStore(IMAGE_CACHE_STORE).get(key);
      req.onsuccess = () => {
        const v = req.result;
        resolve(v && v.bytes ? v : null);
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {}
  }
}

/** 写一条记录（内部共用）。失败只返回 false，不抛 —— 缓存失败不该挡住编译 */
async function writeRecord(key, record) {
  const db = await openImageCache();
  if (!db) return false;
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IMAGE_CACHE_STORE, 'readwrite');
      tx.objectStore(IMAGE_CACHE_STORE).put(record, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    return true;
  } catch {
    return false;
  } finally {
    try {
      db.close();
    } catch {}
  }
}

/** 读缓存：{ bytes:Uint8Array, sha256, size, savedAt } | null */
export async function readImageCache() {
  return readRecord(IMAGE_CACHE_KEY);
}

/** 写缓存。失败（配额、隐私模式）只返回 false，不抛 —— 缓存失败不该挡住编译 */
export async function writeImageCache(bytes, meta = {}) {
  return writeRecord(IMAGE_CACHE_KEY, {
    bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
    sha256: meta.sha256 || null,
    size: byteLength(bytes),
    savedAt: Date.now(),
  });
}

/**
 * 内核缓存能直接用吗？（纯函数，单测盯这里）
 *
 * 与 rootfs 的 cacheEntryMatches 同一个取向：判不准就当没命中。
 * 没有 sha256 元信息（老 image.json）→ 不复用。
 */
export function kernelCacheMatches(entry, meta) {
  if (!entry || !entry.bytes) return false;
  const wantSha = meta?.sha256;
  const wantSize = meta?.size;
  if (!wantSha || !wantSize) return false;
  if (entry.sha256 !== wantSha) return false;
  if (entry.size !== wantSize) return false;
  return byteLength(entry.bytes) === wantSize;
}

/** 读内核缓存：{ bytes:Uint8Array, sha256, size, savedAt } | null */
export async function readKernelCache() {
  return readRecord(KERNEL_CACHE_KEY);
}

/** 写内核缓存。失败只返回 false */
export async function writeKernelCache(bytes, meta = {}) {
  return writeRecord(KERNEL_CACHE_KEY, {
    bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
    sha256: meta.sha256 || null,
    size: byteLength(bytes),
    savedAt: Date.now(),
  });
}

/** 删缓存（工具/测试用；正常流程不需要 —— 校验失败会自愈） */
export async function clearImageCache() {
  const db = await openImageCache();
  if (!db) return false;
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IMAGE_CACHE_STORE, 'readwrite');
      tx.objectStore(IMAGE_CACHE_STORE).delete(IMAGE_CACHE_KEY);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
    return true;
  } catch {
    return false;
  } finally {
    try {
      db.close();
    } catch {}
  }
}
