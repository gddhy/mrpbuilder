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
import { serialBytes, decodeSerial, shProjectPath, shQuote } from './serial.js';

export const SHARE = '/mnt';           // 9p 挂载点（宿主 <-> 虚拟机）
export const TC = '/opt/tc';           // 工具链解压位置
export const PROJ = `${TC}/mrp_demo`;  // 工程模板位置
export const GLIBC = `${TC}/lib/i386-linux-gnu`;

/**
 * 命令正文落在 9p 共享目录里的脚本名：敲进 shell 的只有 `sh /mnt/__cmd`，
 * 命令本身从不回显（否则长命令的折行碎片会漏进可见日志，见 _runOnce 的说明）。
 */
const CMD_SCRIPT = '__cmd';
const LS_SCRIPT = '__lscmd';
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

/**
 * 列目录的起止标记（`__LSxxxxxx_B` / `_E`）。这两行之间是**数据**，不是日志：
 * `<字节数>\t<路径>`，50 个文件就是 50 行 —— 不滤掉的话，一点「启动编译环境」
 * 编译输出栏里就会刷出一屏 `20241\t./README.md`。
 * （`this.serial` 里仍然完整保留 —— waitFor / 解析都靠它，这里只挡转发。）
 */
const LS_BEGIN_RE = /__LS[0-9a-z]{1,16}_B/;
const LS_END_RE = /__LS[0-9a-z]{1,16}_E/;


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
    this._quiet = false; // 正在转发列目录的数据段（见 LS_BEGIN_RE）
    this.env = new Map(); // 每条命令开头都要带上的环境变量（见 setEnv）
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
      // 列目录：标记本身不转发，中间那一段数据也不转发（否则日志里刷一屏文件名）
      if (LS_BEGIN_RE.test(line)) {
        this._quiet = true;
        continue;
      }
      if (LS_END_RE.test(line)) {
        this._quiet = false;
        continue;
      }
      if (!this._quiet && !SENTINEL_RE.test(line)) this.onOutput(line);
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

  /**
   * 往串口写一段命令（自己带换行）。
   *
   * 必须走 serialBytes：`serial0_send` 是按 charCodeAt 逐字符发的，非 ASCII 字符
   * （码点 > 255）会被截断成低 8 位 —— 直接发中文路径会打出 0x03(^C) / 0x00(NUL)，
   * ^C 当场打断命令行、留下未闭合引号，shell 卡在续行符上直到超时。
   * 先按 UTF-8 编成字节再逐字节发，中文路径才能原样到达（见 assets/serial.js）。
   */
  _send(text) {
    this.emulator.serial0_send(serialBytes(text));
  }

  /**
   * 给之后所有命令加一段环境设置（PATH / LD_LIBRARY_PATH / CPATH…）。
   *
   * 不能用「往交互 shell 里 `export` 一次就算数」：命令是在子 shell 的脚本里跑的
   * （见 `_runOnce`），子 shell 只继承环境变量，不继承"上一条命令的 export 生效了没"
   * 这种状态 —— 那样 PATH 会丢，`make` 直接 `command not found`（127，实测踩到）。
   * 存在实例上、由 `_runOnce` 写进每个脚本开头，自包含且顺带省掉几次串口往返。
   */
  setEnv(name, value) {
    this.env.set(name, String(value));
  }

  /** 每次要跑的命令 = 环境设置 + 命令正文（见 _runOnce 的说明） */
  _scriptFor(cmd) {
    const env = [...this.env].map(([k, v]) => `export ${k}=${shQuote(v)}`);
    return `${env.join('\n')}${env.length ? '\n' : ''}${cmd}\n`;
  }

  async _runOnce(cmd, { timeout = 600_000, token } = {}) {
    const id = token || `__RC${Math.random().toString(36).slice(2, 8)}`;
    // 标记在命令里拆开写，避免串口回显的命令行本身被误判成已完成
    const a = id.slice(0, 8);
    const b = id.slice(8);
    this.serial = this.serial.slice(-200_000);
    /*
     * 命令正文**先写进 9p 里的脚本文件**，敲进去的只有 `sh /mnt/__cmd`（一行很短）。
     *
     * 为什么不直接把命令打进 shell：交互 shell 的行编辑器会把它收到的每个字符
     * **回显**出来，而长命令在 80 列处还会被插入真换行 —— 含哨兵的那一段会被
     * `_forward` 滤掉，**剩下的碎片（`2=$?"` / `?"` 这种）没有哨兵就漏进了可见日志**，
     * 混在「✓ 已从虚拟机里删除 xxx」这类消息里，根本分不清哪行是状态、哪行是噪音。
     * 走脚本文件之后：敲进去那行短且含哨兵（一行内 → 被过滤），命令正文从不回显；
     * 顺带也不必再操心命令行的长度。正文经 9p 写入（UTF-8 原样）→ 脚本里写中文路径也行。
     */
    await this.putFile(CMD_SCRIPT, new TextEncoder().encode(this._scriptFor(cmd)));
    this._send(`sh ${SHARE}/${CMD_SCRIPT}; echo "${a}""${b}=$?"\n`);
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
      /*
       * 关掉 v86 的鼠标 / 键盘适配器 —— 本项目只用串口（界面里没有 guest 画面，
       * 也从不往 guest 注入按键），但它俩的默认行为会**污染整个宿主页面**：
       *
       * · 鼠标适配器的「屏幕区域」= 构造参数 screen_container；本项目不传，于是它
       *   回落到 document.body —— 页面上**任何一处**鼠标事件都被算成「落在屏幕里」。
       *   它的监听挂在 window 上，mousedown / wheel / contextmenu 三个处理里都
       *   无条件 preventDefault()。
       * · 平时它是关的（`enabled` 由总线的 mouse-enable 消息打开）；guest 的 PS/2
       *   鼠标驱动一启用数据上报（Linux 启动时就会发），v86 就把它打开 ——
       *   正好对应「点『启动编译环境』之前输入框能点，之后就点不进去」。
       * · 打开之后：mousedown 的默认行为（聚焦 + 落光标 + 起选区）被取消 → 源码
       *   编辑区 / 入口源文件 / 额外参数这些输入框点不进去、选不中；wheel 被吃掉
       *   → 页面滚轮失效（app.js 的 attachWheelScroll 还得跟它抢一遍）；右键菜单也没了。
       *
       * 键盘适配器虽然会跳过 INPUT / TEXTAREA 目标，但同样把 window 上的按键转给
       * guest，没需求就一起关。将来真要显示 guest 画面时，改成传 screen_container
       * 并去掉这两项即可（届时鼠标也随之恢复）。
       */
      disable_mouse: true,
      disable_keyboard: true,
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
      this._send(`echo "${a}""${b}"\n`);
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
      // 「对不上」的报错，两个口径都给：精确字节用于判断差多少，KB/MB 用于一眼看懂量级
      const said = Number.isFinite(guestSize)
        ? `${guestSize.toLocaleString()} 字节（${fmtBytes(guestSize)}）`
        : `读不出来（wc -c 返回 "${sizeTxt}"）`;
      throw new Error(
        `工具链镜像传输不完整：本地 ${payload.length.toLocaleString()} 字节` +
        `（${fmtBytes(payload.length)}），虚拟机里只有 ${said}`
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

    /*
     * 顺手留一份「没被改动过」的模板副本。
     * 工程目录是用户唯一会往里写东西的地方，而「恢复模板」必须把它整目录换回来 ——
     * 只清前端那份状态的话，用户的 main.c / src/xxx.c 还留在 guest 里，
     * make 照样拿它们编译，甚至因为觉得没变化而直接交回上一次的产物
     * （`Nothing to be done for 'all'`）。
     * 实测 cp -a 这份（1.3 MB / 50 个文件）只要 0.2 秒，比重启虚拟机（≈30s）划算得多。
     */
    rc = await this.run(`rm -rf ${TC}/.mrp_demo_pristine && cp -a ${PROJ} ${TC}/.mrp_demo_pristine`, {
      timeout: 300_000,
    });
    if (rc !== 0) throw new Error('留存模板副本失败（「恢复模板」要用它）');

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
    /*
     * 这几个环境变量**不是** export 到交互 shell 里就算完 —— 命令是在子 shell 的
     * 脚本里跑的（见 _runOnce），子 shell 只继承环境、不继承"上一条命令里的 export
     * 有没有生效"这种状态。所以记在实例上，由 _runOnce 写进每个脚本的开头：
     * 自包含、不依赖 shell 状态，也省掉 4 次串口往返。
     */
    this.setEnv('LD_LIBRARY_PATH', LIBDIRS);
    this.setEnv('PATH', `${TC}/usr/bin:/usr/bin:/bin:/sbin`);

    // 关键：工具链在 /opt/tc/usr 而不是编译期前缀 /usr，GCC 按自己的搜索路径
    // 找不到 assembler / linker，最后会退化成 execvp("as") 并报
    // "cannot execute 'as': No such file or directory"。
    // 直接补上不带前缀的软链，让 GCC 的两条查找路径都能命中。
    // （结尾故意**不加** `echo linked` 这类"回显自己文案"的标记：那行输出正好是命令的
    //   子串，会被「日志里不能有自己命令的碎片」那条断言当成漏网的回显 —— 见 test-v86。）
    rc = await this.run(
      `cd ${TC}/usr/bin && for t in as ld nm objcopy objdump ar ranlib strip ` +
      `readelf strings size addr2line; do ` +
      `[ -e "$t" ] || ln -sf arm-none-eabi-$t "$t"; done; true`,
      { timeout: 120_000 }
    );
    if (rc !== 0) throw new Error('创建无前缀工具软链失败');
    this.setEnv('COMPILER_PATH', `${TC}/usr/bin`);

    // 标准 C 头文件：Debian 把 newlib 的头放在 usr/include/newlib。
    // 用 CPATH 显式加进去，保证 #include <stdlib.h> 之类一定能解析。
    this.setEnv('CPATH', `${TC}/usr/include/newlib`);

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
   * @returns {{ok:boolean, code:number, artifact:object|null,
   *            timing:{syncMs:number, compileMs:number, artifactMs:number, totalMs:number}}}
   *          timing 各段之和 = totalMs（同步源码 + 编译 + 取回产物）；
   *          失败时也返回，方便调用方报出「已经花了多久」。
   */
  async build({ files = {}, app = 'helloworld.c', target = 'bin.elf', extra = '' } = {}) {
    const t0 = Date.now();
    this.opts.onStatus?.('同步源码');
    let i = 0;
    for (const [name, bytes] of Object.entries(files)) {
      const stage = `__up_${i++}`;
      await this.putFile(stage, bytes);
      /*
       * 路径整体加单引号再拼（shProjectPath）：文件名里带空格、中文、$ 都安全。
       * 中文路径能直接发是因为 _send 走的是「UTF-8 字节逐个发」——
       * 早期版本在这里绕了一圈 base64 -d，就是为了躲开 charCodeAt 的截断。
       */
      const dir = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '.';
      const cmd =
        `mkdir -p ${shProjectPath(PROJ, dir)} && ` +
        `cp -f ${shProjectPath(SHARE, stage)} ${shProjectPath(PROJ, name)}`;
      const rc = await this.run(cmd, { timeout: 120_000 });
      if (rc !== 0) throw new Error(`写入 ${name} 失败`);
    }
    const syncMs = Date.now() - t0;

    this.opts.onStatus?.('编译中');
    const extraArg = extra ? ` EXTRA='${extra.replace(/'/g, "'\\''")}'` : '';
    const tCompile = Date.now();
    const rc = await this.run(
      `cd ${PROJ} && make APP='${app}' TARGET='${target}'${extraArg}`,
      { timeout: 900_000 }
    );
    const compileMs = Date.now() - tCompile;
    if (rc !== 0) {
      return {
        ok: false,
        code: rc,
        artifact: null,
        timing: { syncMs, compileMs, artifactMs: 0, totalMs: Date.now() - t0 },
      };
    }

    // 取回产物
    const tArtifact = Date.now();
    const copyRc = await this.run(
      `cp -f '${PROJ}/${target}' ${SHARE}/__artifact`,
      { timeout: 180_000 }
    );
    if (copyRc !== 0) throw new Error('产物写回共享目录失败');
    const artifact = await this.getFile('__artifact');
    return {
      ok: true,
      code: 0,
      artifact: { name: target, bytes: artifact },
      timing: {
        syncMs,
        compileMs,
        artifactMs: Date.now() - tArtifact,
        totalMs: Date.now() - t0,
      },
    };
  }

  /**
   * 把工程目录整个还原成镜像内置的模板。
   *
   * 为什么非要在虚拟机里做：工程目录是用户唯一会往里写东西的地方。
   * 前端那份状态（overrides / 勾选 / 编辑器）清了并不等于虚拟机里干净 ——
   * 用户的 main.c、src/xxx.c 还在，make 会照样拿它们去编，甚至因为
   * 「依赖都比产物的时间戳旧」而直接交回上一次的产物（`Nothing to be done for 'all'`）。
   *
   * 模板副本是装工具链时用 `cp -a` 留的（见 installToolchain，0.2 秒）。
   * 连同 bin.elf 一起换掉，所以恢复之后必然是一次真正的编译。
   * 引擎预编译归档在 lib/ 里，也一起没了 —— 调用方要把「已经推过归档」的标记复位。
   */
  async resetProject() {
    const rc = await this.run(
      `if [ -d ${TC}/.mrp_demo_pristine ]; then ` +
        `rm -rf ${PROJ} && cp -a ${TC}/.mrp_demo_pristine ${PROJ}; ` +
        `else echo NO_PRISTINE >&2; exit 3; fi`,
      { timeout: 300_000 }
    );
    if (rc !== 0) throw new Error('恢复模板失败：虚拟机里的工程目录没能还原');
  }

  /** 读一个工程内的文件（走 9p，不用串口，二进制也安全） */
  async readProjectFile(relPath) {
    const rc = await this.run(`cp -f ${shProjectPath(PROJ, relPath)} ${SHARE}/__get`, {
      timeout: 120_000,
    });
    if (rc !== 0) throw new Error(`读取 ${relPath} 失败`);
    return await this.getFile('__get');
  }

  /**
   * 改工程内某个文件的名字（同目录内改名，目录部分由调用方保持不变）。
   * 直接在 guest 里 `mv`，所以虚拟机里的工程目录立刻就是新的样子 ——
   * 和编辑器改内容走的是同一条思路：前端不另存一份，改完再回来列一次。
   */
  async renameProjectFile(from, to) {
    const rc = await this.run(
      `mv -f ${shProjectPath(PROJ, from)} ${shProjectPath(PROJ, to)}`,
      { timeout: 60_000 }
    );
    if (rc !== 0) throw new Error(`重命名失败：${from} → ${to}`);
  }

  /** 删掉工程内的某个文件（`test ! -e` 复核一次，别只信 rm 的退出码） */
  async deleteProjectFile(name) {
    const p = shProjectPath(PROJ, name);
    const rc = await this.run(`rm -f ${p} && test ! -e ${p}`, { timeout: 60_000 });
    if (rc !== 0) throw new Error(`删除失败：${name}`);
  }

  /**
   * 列工程文件：`[{ name, size }]`（9p 不支持列目录，只能问 guest）。
   *
   * 取大小用 `find . -type f -exec du -b {} +`：实测这台 guest 里的 busybox
   * **没有编译 `stat`（`stat: applet not found`）也没有 `find -printf`**（软链在、
   * applet 不在 —— 别信 make-image.py 那份软链清单），而 `du -b` 与
   * `-exec … +` 都可用，且一次 fork 就能拿到全部文件的「字节数 + 路径」。
   *
   * 路径按 UTF-8 解回来（串口回来的是按字节拼的 Latin-1 串）：中文文件名才不会是乱码。
   */
  async listProjectFiles() {
    return this._enqueue(() => this._listProjectFilesOnce());
  }

  async _listProjectFilesOnce() {
    const id = `__LS${Math.random().toString(36).slice(2, 8)}`;
    const a = id.slice(0, 7);
    const b = id.slice(7);
    this.serial = this.serial.slice(-100_000);
    // 同样走脚本文件：命令正文不回显（`cd` 也留在子 shell 里，不污染交互 shell 的提示符）
    await this.putFile(
      LS_SCRIPT,
      new TextEncoder().encode(
        this._scriptFor(
          `cd ${PROJ} && echo "${a}""${b}_B" && ` +
            `find . -type f -exec du -b {} + && echo "${a}""${b}_E"`
        )
      )
    );
    // 敲进去这行挂一个同前缀的标记（`#` 后面是注释，不影响执行）→ 回显会被 `_forward` 滤掉
    this._send(`sh ${SHARE}/${LS_SCRIPT} #${id}\n`);
    await this.waitFor(new RegExp(`${id}_E`), 120_000, '列目录');
    const s = this.serial;
    const end = s.lastIndexOf(`${id}_E`);
    const begin = s.lastIndexOf(`${id}_B`, end);
    if (begin < 0 || end < 0) return [];
    const files = [];
    for (const raw of s.slice(begin + `${id}_B`.length, end).split('\n')) {
      const row = raw.replace(/\r/g, '');
      // du -b 的输出是「<字节数>\t<路径>」；按第一个制表符切，名字里再有制表符也不怕
      const tab = row.indexOf('\t');
      if (tab <= 0) continue; // 空行 / du 的报错行
      const size = Number(row.slice(0, tab));
      let name = decodeSerial(row.slice(tab + 1));
      if (name.startsWith('./')) name = name.slice(2);
      if (!name || !Number.isFinite(size)) continue;
      files.push({ name, size });
    }
    // 排序放在这里（不靠 guest 的 sort）：界面上的顺序与文件名一致
    files.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
    return files;
  }
}
