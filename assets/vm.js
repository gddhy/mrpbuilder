/**
 * MrpVm —— 浏览器 / Node 共用的 v86 驱动（无 DOM 依赖）
 *
 * 为什么不传 initrd：
 *   v86 配的内核（Buildroot + uClibc，6.8.12）会忽略 100MB 的外部 initramfs
 *   并回落到自带 rootfs；而且该内核没启用 8250 串口 console，报错也看不到。
 *   所以改成用内核自带的 rootfs（启动快、串口 shell 和 9p 都已验证可用），
 *   再通过 9p 把工具链 tarball 推进去解压。
 *
 * 为什么需要 ld-linux.so.2 软链：
 *   自带 rootfs 是 uClibc，而 Debian 的 arm-none-eabi 工具链是 glibc 的。
 *   工具链二进制的 PT_INTERP 写死为 /lib/ld-linux.so.2（buildroot 里没有这个路径，
 *   所以不冲突），再用 LD_LIBRARY_PATH 指到解压出来的 glibc。
 */

import { V86 } from './v86/libv86.js';
import { isGzip, looksLikeTar, gzipBytes, fmtBytes } from './bytes.js';

export const SHARE = '/mnt';           // 9p 挂载点（宿主 <-> 虚拟机）
export const TC = '/opt/tc';           // 工具链解压位置
export const PROJ = `${TC}/mrp_demo`;  // 工程模板位置
export const GLIBC = `${TC}/lib/i386-linux-gnu`;
// Debian 把库分散在两个目录：glibc 核心在 /lib，gcc 自己的依赖
// （libisl / libmpfr / libgmp / libmpc / libzstd / libstdc++）在 /usr/lib。
// 少一个就会报 "cc1: error while loading shared libraries"。
export const LIBDIRS =
  `${TC}/usr/lib/i386-linux-gnu:${TC}/lib/i386-linux-gnu`;

const DEFAULT_CMDLINE = 'tsc=reliable mitigations=off random.trust_cpu=on';

/**
 * 内部哨兵的行内特征。
 *   run()              -> `__RC` + 6 位随机串
 *   listProjectFiles() -> `__LS` + 6 位随机串
 *   waitForShell()     -> `__RDY` + 6 位随机串
 *
 * 哨兵在命令里是**拆成两段 echo** 的（`echo "__RC7w0x""lx=$?"`，为的是让串口
 * 回显的命令行本身凑不出完整哨兵、不被误判成已完成），所以回显出来的命令行里
 * 带的是 `__RC7w0x""lx` 这种断开形式。这里只认前缀 + 少量字母数字，
 * 两种形式都能覆盖到，也不会误伤编译输出。
 *
 * ⚠ 新增哨兵前缀时一定要加进来 —— 漏了就会像 `__RDY` 那样，
 * 把 `__RDY3mn17d` 这种行泄漏到可见日志里。
 */
const SENTINEL_RE = /__(?:RC|LS|RDY)[0-9a-z]{1,16}/;


export class MrpVm {
  /**
   * @param {object} opts
   * @param {string} opts.wasmPath  v86.wasm 的路径/URL
   * @param {object} opts.bios      seabios 镜像 {buffer}|{url}
   * @param {object} opts.vgaBios   vgabios 镜像
   * @param {object} opts.kernel    bzImage
   * @param {(text:string)=>void} [opts.onOutput] 串口输出回调（已滤掉内部哨兵行）
   * @param {(msg:string)=>void} [opts.onStatus]
   * @param {boolean} [opts.rawOutput] true 时不滤哨兵，原样输出（调试用）
   */
  constructor(opts) {
    this.opts = opts;
    this.emulator = null;
    this.serial = '';
    this.waiters = [];
    this.ready = false;
    this.onOutput = opts.onOutput || (() => {});
    this._outBuf = '';
  }

  // ---------------------------------------------------------------- 串口
  _attach() {
    let probe = 0;
    this.emulator.add_listener('serial0-output-byte', (b) => {
      const ch = String.fromCharCode(b);
      this.serial += ch;
      // 长会话下别让缓冲无限增长
      if (this.serial.length > 2_000_000) this.serial = this.serial.slice(-1_000_000);
      /*
       * 哨兵（__RCxxxxxx=$? 等）都按行结束，没必要逐字节匹配。
       * 逐字节对最长 2MB 的累计串跑正则，V8 每次都要先把 rope 字符串扁平化，
       * 长编译日志下几百万次拷贝会把 Node 直接打出
       * "Fatal process out of memory: Zone"（实测 dsm_gm 编译两次复现）。
       * 改为遇到换行时匹配，且只匹配串口尾部 4KB —— 哨兵必然刚输出在末尾。
       */
      if (this.waiters.length && (ch === '\n' || ++probe % 64 === 0)) {
        const tail = this.serial.slice(-4096);
        for (const w of [...this.waiters]) {
          if (w.re.test(tail)) {
            this.waiters.splice(this.waiters.indexOf(w), 1);
            clearTimeout(w.timer);
            w.resolve(this.serial);
          }
        }
      }
      this._forward(ch);
    });
  }

  /**
   * 把串口输出转发给界面，同时滤掉我们自己灌进去的控制流量。
   *
   * run() / listProjectFiles() / waitForShell() 都是靠在交互 shell 里 echo 一个
   * 随机哨兵（__RCxxxxxx=$? 、__LSxxxxxx_B）来判断命令结束的，这些哨兵连同
   * 被回显的命令行会混进可见日志里（界面上会看到 `__RC7w0lx=2` 这种行）。
   * 这里按「整行」判定后再转发：哨兵行丢掉，其余原样送出。
   *
   * 注意 this.serial 保持原样 —— waitFor/run 靠它做匹配，不能动。
   * 因为要拿到完整一行才能判断，所以无换行的长串先攒着（超过 4096 字节就强制送出，
   * 避免永远攒不出换行时把日志憋死）。
   */
  _forward(ch) {
    if (this.opts.rawOutput) {
      this.onOutput(ch);
      return;
    }
    this._outBuf += ch;
    for (;;) {
      const m = this._outBuf.match(/\r\n|[\r\n]/);
      if (!m) {
        // 还没凑出换行：太长就强制送出，否则继续攒
        if (this._outBuf.length > 4096) {
          this.onOutput(this._outBuf);
          this._outBuf = '';
        }
        return;
      }
      // 缓冲区以 \r 结尾时，无法确定后面跟不跟 \n，等下一块再判，避免多出空行
      if (m[0] === '\r' && m.index + 1 === this._outBuf.length) return;

      const line = this._outBuf.slice(0, m.index + m[0].length);
      this._outBuf = this._outBuf.slice(m.index + m[0].length);
      if (!SENTINEL_RE.test(line)) this.onOutput(line);
    }
  }
  waitFor(re, timeoutMs, label) {
    if (re.test(this.serial)) return Promise.resolve(this.serial);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.re === re);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`等待超时：${label || re}`));
      }, timeoutMs);
      this.waiters.push({ re, timer, resolve });
    });
  }

  /**
   * 串口交互 shell 只有一条，命令必须串行执行。
   * 并发调用时两条命令的回显与哨兵会交错，waitFor 可能认到对方的结果，
   * 于是两边一起卡到超时。实测触发场景：打开打包对话框时会预读壳文件，
   * 如果用户此刻点「生成并下载」，就有两条命令同时打进 shell。
   * 所以所有会写 shell 的操作都从这里排队。
   */
  _enqueue(fn) {
    const prev = this._queue || Promise.resolve();
    let release;
    this._queue = new Promise((r) => {
      release = r;
    });
    return prev.then(fn).finally(release);
  }

  /** 把一条命令打进交互 shell，等待退出码 */
  async run(cmd, opts) {
    return this._enqueue(() => this._runOnce(cmd, opts));
  }

  async _runOnce(cmd, { timeout = 600_000, token } = {}) {
    const id = token || `__RC${Math.random().toString(36).slice(2, 8)}`;
    // 标记在命令里拆开写，避免串口回显的命令行本身被误判成已完成
    const a = id.slice(0, 8);
    const b = id.slice(8);
    this.serial = this.serial.slice(-200_000);
    this.emulator.serial0_send(`${cmd}; echo "${a}""${b}=$?"\n`);
    await this.waitFor(new RegExp(`${id}=(\\d+)`), timeout, cmd.slice(0, 60));
    const m = this.serial.match(new RegExp(`${id}=(\\d+)`));
    return m ? Number(m[1]) : NaN;
  }

  // ---------------------------------------------------------------- 生命周期
  async boot() {
    this.opts.onStatus?.('启动虚拟机');
    const em = new V86({
      wasm_path: this.opts.wasmPath,
      bios: this.opts.bios,
      vga_bios: this.opts.vgaBios,
      bzimage: this.opts.kernel,
      cmdline: this.opts.cmdline || DEFAULT_CMDLINE,
      memory_size: this.opts.memorySize || 384 * 1024 * 1024,
      filesystem: {},
      autostart: true,
    });
    this.emulator = em;
    this._attach();
    await this.waitForShell(this.opts.bootTimeoutMs || 180_000);
    this.ready = true;
  }

  /** 内核自带 rootfs 的 shell 没有固定提示符，用探针反复问直到它有回应 */
  async waitForShell(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const id = `__RDY${Math.random().toString(36).slice(2, 8)}`;
      const a = id.slice(0, 6);
      const b = id.slice(6);
      this.serial = this.serial.slice(-100_000);
      this.emulator.serial0_send(`echo "${a}""${b}"\n`);
      try {
        await this.waitFor(new RegExp(id), 4000, 'shell');
        return true;
      } catch {
        /* 继续等 */
      }
    }
    throw new Error('虚拟机 shell 未就绪（超时）');
  }

  async stop() {
    try {
      await this.emulator?.destroy?.();
    } catch {}
  }

  // ---------------------------------------------------------------- 文件通道
  async putFile(name, bytes) {
    await this.emulator.create_file(name, bytes);
  }

  async getFile(name) {
    return new Uint8Array(await this.emulator.read_file(name));
  }

  // ---------------------------------------------------------------- 工具链
  /** 把工具链 tarball 推进虚拟机并解压、配好 glibc 环境 */
  /**
   * 把工具链镜像推进虚拟机并解压、配好环境。
   * @param {Uint8Array} tarBytes 期望是 gzip 过的 tar
   * @returns {{bytes:number, regzipped:boolean, entriesHint?:string}}
   *          regzipped=true 表示拿到的其实不是 gzip，是被就地重新压过的
   */
  async installToolchain(tarBytes, { onProgress } = {}) {
    this.opts.onStatus?.('推送工具链');
    onProgress?.(0);

    /*
     * 传输层有可能已经把 .tar.gz 透明解压掉了 —— 只要服务端给响应带上
     * Content-Encoding: gzip，浏览器就会自动解码，拿到的其实是未压缩的 tar。
     * 那样推给 guest 后，`gzip -dc` 会报 "gzip: invalid magic"、tar 接着报 short read，
     * 而这两个报错完全指不到真正的原因（实测踩到过：30.6 MiB 的镜像变成 101.4 MiB 的 tar）。
     * 这里统一判一下格式，不是 gzip 就就地压回去。
     */
    let payload = tarBytes instanceof Uint8Array ? tarBytes : new Uint8Array(tarBytes);
    let regzipped = false;
    if (!isGzip(payload)) {
      if (!looksLikeTar(payload)) {
        const head = [...payload.subarray(0, 4)]
          .map((b) => b.toString(16).padStart(2, '0'))
          .join(' ');
        throw new Error(
          `工具链镜像既不是 gzip 也不是 tar（前 4 字节 ${head}）。` +
          `请重新运行：python tools/make-image.py`
        );
      }
      payload = await gzipBytes(payload);
      regzipped = true;
    }

    await this.putFile('rootfs.tar.gz', payload);
    onProgress?.(0.3);

    // 确认 9p 真的传完了：30MB 级的文件如果被截断，后面解压的报错同样很难懂
    let rc = await this.run(`wc -c < ${SHARE}/rootfs.tar.gz > ${SHARE}/__tcsize`);
    if (rc !== 0) throw new Error('无法读取虚拟机里的镜像大小');
    const sizeTxt = new TextDecoder().decode(await this.getFile('__tcsize')).trim();
    const guestSize = Number.parseInt(sizeTxt, 10);
    if (guestSize !== payload.length) {
      throw new Error(
        `工具链镜像传输不完整：本地 ${payload.length} 字节，虚拟机里只有 ${sizeTxt} 字节`
      );
    }

    this.opts.onStatus?.('解压工具链');
    // busybox 的 tar 不支持 -z，必须自己解压后喂给它
    rc = await this.run(
      `mkdir -p ${TC} && gzip -dc ${SHARE}/rootfs.tar.gz | tar xf - -C ${TC}`,
      { timeout: 900_000 }
    );
    if (rc !== 0) throw new Error(`解压工具链失败（rc=${rc}）`);
    onProgress?.(1);

    // 自带 rootfs 是 uClibc，工具链是 glibc 的，必须把 glibc 的 loader 放到
    // /lib/ld-linux.so.2（buildroot 没有这个路径，不冲突），并指定库搜索路径。
    this.opts.onStatus?.('配置运行环境');
    // 保险：tarball 是在 Windows 上打的，执行位可能丢失，显式补一遍。
    // cc1 / collect2 在 usr/lib/gcc 下，同样要给执行位，否则 gcc 会报
    // "cannot execute 'cc1': execvp: No such file or directory"（实际是没权限）。
    await this.run(
      `chmod 755 ${TC}/usr/bin ${TC}/usr/sbin ${TC}/bin ${TC}/sbin ` +
      `${TC}/usr/bin/* ${TC}/lib/i386-linux-gnu/ld-linux.so.2 2>/dev/null; ` +
      `chmod -R 755 ${TC}/usr/lib/gcc 2>/dev/null; true`,
      { timeout: 300_000 }
    );

    rc = await this.run(`ln -sf ${GLIBC}/ld-linux.so.2 /lib/ld-linux.so.2`);
    if (rc !== 0) throw new Error('创建 ld-linux.so.2 软链失败');
    rc = await this.run(`export LD_LIBRARY_PATH=${LIBDIRS}`);
    if (rc !== 0) throw new Error('设置 LD_LIBRARY_PATH 失败');
    rc = await this.run(`export PATH=${TC}/usr/bin:/usr/bin:/bin:/sbin`);
    if (rc !== 0) throw new Error('设置 PATH 失败');

    // 关键：工具链在 /opt/tc/usr 而不是编译期前缀 /usr，GCC 按自己的搜索路径
    // 找不到 assembler / linker，最后会退化成 execvp("as") 并报
    // "cannot execute 'as': No such file or directory"。
    // 直接补上不带前缀的软链，让 GCC 的两条查找路径都能命中。
    rc = await this.run(
      `cd ${TC}/usr/bin && for t in as ld nm objcopy objdump ar ranlib strip ` +
      `readelf strings size addr2line; do ` +
      `[ -e "$t" ] || ln -sf arm-none-eabi-$t "$t"; done; echo linked`,
      { timeout: 120_000 }
    );
    if (rc !== 0) throw new Error('创建无前缀工具软链失败');
    rc = await this.run(`export COMPILER_PATH=${TC}/usr/bin`);
    if (rc !== 0) throw new Error('设置 COMPILER_PATH 失败');

    // 标准 C 头文件：Debian 把 newlib 的头放在 usr/include/newlib。
    // 用 CPATH 显式加进去，保证 #include <stdlib.h> 之类一定能解析。
    rc = await this.run(`export CPATH=${TC}/usr/include/newlib`);
    if (rc !== 0) throw new Error('设置 CPATH 失败');

    // 自检：确认工具链真的能跑
    rc = await this.run(`${TC}/usr/bin/arm-none-eabi-gcc --version | head -1`);
    if (rc !== 0) throw new Error('工具链无法运行（glibc 环境不匹配？）');
    this.opts.onStatus?.('工具链就绪');
    return { bytes: payload.length, regzipped };
  }

  // ---------------------------------------------------------------- 编译
  /**
   * @param {object} o
   * @param {Record<string, Uint8Array>} [o.files] 覆盖/新增的工程文件（相对路径）
   * @param {string} [o.app]     入口源文件
   * @param {string} [o.target]  产物名
   * @param {string} [o.extra]   额外编译参数
   */
  async build({ files = {}, app = 'helloworld.c', target = 'bin.elf', extra = '' } = {}) {
    this.opts.onStatus?.('同步源码');
    let i = 0;
    for (const [name, bytes] of Object.entries(files)) {
      const stage = `__up_${i++}`;
      await this.putFile(stage, bytes);
      /*
       * 文件名不能直接拼进串口命令：serial0_send 是按 charCodeAt 逐字符发的，
       * 非 ASCII 字符（中文等）的码点 > 255，会被截断成低 8 位 ——
       * 实测「功能机开发规范.md」会打出 0x03(^C)/0x00(NUL) 等字节，
       * ^C 直接打断命令行、留下未闭合引号，shell 卡在 PS2 续行符，整条同步链超时。
       * 对策：非 ASCII 名走 base64（UTF-8），guest 里 base64 -d 还原后再落盘。
       * 单引号也不能直接进命令，所以可打印 ASCII 的判定里把它排除。
       */
      const safeName = /^[\x20-\x26\x28-\x7e]+$/.test(name);
      const cmd = safeName
        ? (() => {
            const dir = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '.';
            return `mkdir -p '${PROJ}/${dir}' && cp -f '${SHARE}/${stage}' '${PROJ}/${name}'`;
          })()
        : (() => {
            const b = new TextEncoder().encode(name);
            let bin = '';
            for (let k = 0; k < b.length; k++) bin += String.fromCharCode(b[k]);
            const b64 = btoa(bin);
            return (
              `d=$(printf '%s' '${b64}' | base64 -d) && ` +
              `mkdir -p "${PROJ}/$(dirname "$d")" && ` +
              `cp -f '${SHARE}/${stage}' "${PROJ}/$d"`
            );
          })();
      const rc = await this.run(cmd, { timeout: 120_000 });
      if (rc !== 0) throw new Error(`写入 ${name} 失败`);
    }

    this.opts.onStatus?.('编译中');
    const extraArg = extra ? ` EXTRA='${extra.replace(/'/g, "'\\''")}'` : '';
    const rc = await this.run(
      `cd ${PROJ} && make APP='${app}' TARGET='${target}'${extraArg}`,
      { timeout: 900_000 }
    );
    if (rc !== 0) return { ok: false, code: rc, artifact: null };

    // 取回产物
    const copyRc = await this.run(
      `cp -f '${PROJ}/${target}' ${SHARE}/__artifact`,
      { timeout: 180_000 }
    );
    if (copyRc !== 0) throw new Error('产物写回共享目录失败');
    const artifact = await this.getFile('__artifact');
    return { ok: true, code: 0, artifact: { name: target, bytes: artifact } };
  }

  /** 读一个工程内的文件（走 9p，不用串口，二进制也安全） */
  async readProjectFile(relPath) {
    const rc = await this.run(`cp -f '${PROJ}/${relPath}' ${SHARE}/__get`, { timeout: 120_000 });
    if (rc !== 0) throw new Error(`读取 ${relPath} 失败`);
    return await this.getFile('__get');
  }

  /** 列出工程模板文件（9p 不支持列目录，只能问 guest） */
  async listProjectFiles() {
    return this._enqueue(() => this._listProjectFilesOnce());
  }

  async _listProjectFilesOnce() {
    const id = `__LS${Math.random().toString(36).slice(2, 8)}`;
    const a = id.slice(0, 7);
    const b = id.slice(7);
    this.serial = this.serial.slice(-100_000);
    this.emulator.serial0_send(
      `cd ${PROJ} && echo "${a}""${b}_B" && find . -type f | sed 's|^\\./||' | sort && echo "${a}""${b}_E"\n`
    );
    await this.waitFor(new RegExp(`${id}_E`), 120_000, '列目录');
    const s = this.serial;
    const end = s.lastIndexOf(`${id}_E`);
    const begin = s.lastIndexOf(`${id}_B`, end);
    if (begin < 0 || end < 0) return [];
    return s
      .slice(begin + `${id}_B`.length, end)
      .split('\n')
      .map((x) => x.replace(/\r/g, '').trim())
      .filter(Boolean);
  }
}
