/**
 * 虚拟机启动快照的本地存储（IndexedDB）。
 *
 * 为什么要它：v86 冷启动要 8 秒引导 Linux，再用 21.7 秒把 31 MiB 工具链推进去
 * 解压、建 ld-linux.so.2 软链、补 PATH —— 这 30 秒里没有任何用户价值，而结果
 * 每次完全一样。v86 的 `save_state()` 把「CPU + 内存 + 设备」整块存成一个
 * ArrayBuffer，下次用构造参数 `initial_state` 直接恢复，整段初始化就跳过了。
 *
 * 三条必须先讲清的前提（也是实现的边界）：
 *
 * 1. **只存初始状态**。快照在 boot() 末尾存一次 —— 那时工具链刚装好、工程还是
 *    内置模板。绝不存用户改过的状态：现在刷新页面就是回到模板，快照若存了"改到
 *    一半"的样子，刷新行为就变了。
 * 2. **与镜像强绑定**。rootfs 换过 / 内核换过 / 内存大小改过，旧快照必须作废。
 *    判定用 snapshotKeyOf()（镜像 built + rootfs sha + 内核 sha + 内存大小 + 版本号），
 *    不看时间戳 —— 与引擎归档 libmrp_engine.key 是同一套思路。
 * 3. **9p 共享目录不随快照走**。`filesystem: {}` 建出来的宿主侧 inode 表是 JS
 *    对象，不进 guest 内存，所以快照里 guest 的 /mnt 一旦保留着 fid，恢复后
 *    就指向一张空表。因此 captureSnapshot() 在 save 前先 umount、恢复后重新
 *    mount（见 vm.js）。这也是本模块要存 share 挂载参数的原因。
 *
 * 降级策略（全都只影响速度、不影响功能）：
 *   · file:// / 隐私模式 / 禁用存储 → 拿不到 indexedDB → 读不到也写不进，回退成
 *     每次冷启动（= 加这个功能之前的行为）；
 *   · 没有 CompressionStream（老浏览器）→ 不压缩也不存：384 MB 原始字节写进
 *     IndexedDB 只会把配额吃光，还不一定成功；
 *   · 配额不足 / 写入被拒 → 返回 false，界面只提示一句，下次照常冷启动。
 */

export const SNAPSHOT_DB = 'mrp-vm-snapshot';
export const SNAPSHOT_STORE = 'snapshots';
export const SNAPSHOT_KEY = 'current';

/**
 * 快照格式/生成逻辑的版本号。
 * 改了 captureSnapshot 的步骤（比如以后多存了别的东西、或 v86 升级导致 state
 * 格式不兼容），把它 +1 —— 旧快照会自动作废，不需要 user 手动清缓存。
 */
export const SNAPSHOT_VERSION = 1;

/**
 * 快照的"内容指纹"。任何一项变化都必须让旧快照失效：
 *
 *   imageBuilt  重打镜像会刷新这个时间戳（image.json 的 built）
 *   rootfsSha   工具链内容；它变了 = /opt/tc 里那份东西不对
 *   kernelSha   内核；快照里的 RAM 是按这版内核引导出来的
 *   memorySize  v86 restore_state 要求内存大小与存档时一致，否则直接崩
 *
 * 纯函数、不碰存储，单测盯这里（判错的代价是"恢复出一台坏掉的虚拟机"，
 * 表现为串口胡言乱语或直接卡死，比多启动一次难受得多）。
 */
export function snapshotKeyOf({
  version = SNAPSHOT_VERSION,
  imageBuilt,
  rootfsSha,
  kernelSha,
  memorySize,
} = {}) {
  return [
    `v${version}`,
    imageBuilt || 'no-built',
    (rootfsSha || 'no-sha').slice(0, 16),
    (kernelSha || 'no-ksha').slice(0, 16),
    String(memorySize || 0),
  ].join('|');
}

/** 这条记录能不能用来恢复这份 key？ */
export function snapshotRecordMatches(record, key) {
  if (!record || !record.bytes) return false;
  if (!key) return false;
  return record.key === key;
}

/** 字节数（ArrayBuffer / Uint8Array / Blob 都吃） */
function byteLength(b) {
  if (!b) return 0;
  if (typeof b.byteLength === 'number') return b.byteLength;
  if (typeof b.size === 'number') return b.size;
  return 0;
}

/** 打开数据库；不支持/被拒时返回 null（调用方据此降级） */
export async function openSnapshotDb() {
  try {
    if (typeof indexedDB === 'undefined' || !indexedDB) return null;
    return await new Promise((resolve) => {
      const req = indexedDB.open(SNAPSHOT_DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) {
          db.createObjectStore(SNAPSHOT_STORE);
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

/**
 * 读快照。key 对不上时顺手删掉旧记录（自愈），并返回 null ——
 * 调用方据此走正常的冷启动路径，不需要"清缓存"按钮。
 */
export async function readSnapshot(key) {
  const db = await openSnapshotDb();
  if (!db) return null;
  try {
    const rec = await new Promise((resolve) => {
      const req = db.transaction(SNAPSHOT_STORE, 'readonly')
        .objectStore(SNAPSHOT_STORE)
        .get(SNAPSHOT_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
    if (!rec || !snapshotRecordMatches(rec, key)) {
      // 旧镜像/旧版本的快照留着只会占几十 MB，直接清掉
      if (rec) await clearSnapshot();
      return null;
    }
    return rec;
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {}
  }
}

/**
 * 写快照。失败（配额、隐私模式、超大）只返回 false，不抛 ——
 * 存不下最多是下次再冷启动一次，不该让"启动编译环境"报错。
 */
export async function writeSnapshot(key, { bytes, compressed, rawSize, share }) {
  const db = await openSnapshotDb();
  if (!db) return false;
  try {
    const record = {
      key,
      bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
      compressed: !!compressed,
      rawSize: rawSize || byteLength(bytes),
      share: share || null,
      savedAt: Date.now(),
    };
    await new Promise((resolve, reject) => {
      const tx = db.transaction(SNAPSHOT_STORE, 'readwrite');
      tx.objectStore(SNAPSHOT_STORE).put(record, SNAPSHOT_KEY);
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

/** 删快照（恢复失败时自愈用） */
export async function clearSnapshot() {
  const db = await openSnapshotDb();
  if (!db) return false;
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(SNAPSHOT_STORE, 'readwrite');
      tx.objectStore(SNAPSHOT_STORE).delete(SNAPSHOT_KEY);
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

/**
 * 压缩快照。384 MB 的线性内存里绝大部分是零页，gzip 之后通常只剩几十 MB
 * （主要就是解压后的工具链）。没有 CompressionStream 就返回 compressed=false，
 * 由调用方决定要不要存（当前策略：不存）。
 */
export async function compressSnapshot(bytes) {
  if (typeof CompressionStream === 'undefined') {
    return { bytes, compressed: false };
  }
  try {
    const blob = bytes instanceof Blob ? bytes : new Blob([bytes]);
    const stream = blob.stream().pipeThrough(new CompressionStream('gzip'));
    const out = new Uint8Array(await new Response(stream).arrayBuffer());
    // 极端情况（全零内存？）压缩反而变大，那就别压
    return out.length < byteLength(bytes)
      ? { bytes: out, compressed: true }
      : { bytes, compressed: false };
  } catch {
    return { bytes, compressed: false };
  }
}

/**
 * 解压快照。返回 null 表示这份字节不可用（压缩格式坏了 / 没有解压能力）——
 * 调用方把快照当"没命中"处理，并把它删掉。
 */
export async function decompressSnapshot(bytes, { compressed = true, rawSize = 0 } = {}) {
  const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!compressed) return raw;
  if (typeof DecompressionStream === 'undefined') return null;
  try {
    const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'));
    const out = new Uint8Array(await new Response(stream).arrayBuffer());
    // 大小对不上说明字节被截断过：宁可重来，也不要把半截 state 灌给 v86
    if (rawSize && out.length !== rawSize) return null;
    return out;
  } catch {
    return null;
  }
}
