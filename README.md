# mrpbuilder —— MRP 纯前端编译环境

在浏览器里用 **arm-none-eabi-gcc** 编译功能机（MT6225 / 6235 / 6250 / 6276 等）的 MRP 程序，
产出 `bin.elf`。**不需要后端、不需要装任何本地工具**，任何有浏览器的设备打开就能用。

> 产物要能**在真机上跑**，编译参数里必须带 `-ffixed-r9 -ffixed-r10`：
> MRP 壳是 APCS 编译的，它拿 r9/r10 当静态基址和栈限，而 GCC 在 `-fPIC` 下默认也想用这两个
> 寄存器 —— 抢起来的症状就是「**模拟器里正常、MTK 真机卡在启动页**」。
> 内置模板 Makefile 已经带上了，详见「MRP 编译的硬约束」。

---

## 为什么要在浏览器里跑一台 Linux

这不是绕路，而是唯一的办法：

- **GCC 不可能被编译成 wasm 放进浏览器**。GCC 上游既没有 wasm32 后端，也没有官方 wasm 构建。
  能进浏览器的只有 Clang 系（Emscripten / WASI-SDK），但 MRP 编译必须复刻社区的
  **arm-none-eabi-gcc + `-nostdlib -nostartfiles -pie -fPIC`** 这套组合，
  换成 Clang 会重新踩上「GOT 表」那些坑（见下文）。
- 所以只有一条路：**在浏览器里跑一台 32 位 Linux，里面装真正的 arm-none-eabi-gcc**。

### 为什么是 v86

| | v86 | WebVM（CheerpX） |
|---|---|---|
| 授权 | BSD-2-Clause，可自由自托管、离线 | ⚠️ 个人免费，但**未经商业授权不允许把构建产物下载到别处自托管** |
| guest | 32 位 x86 | 64 位 x86，快得多 |
| 结论 | 本项目采用 | 与「自托管 + 离线」冲突，已排除 |

v86 只支持 32 位 guest，而 **ARM 官方不提供 32 位 Linux 版工具链**。
解决办法：**Debian 为 i386 构建了 `gcc-arm-none-eabi`**，直接拿来用。

---

## 编译速度：引擎只编一次

`src/` 下 19 个 `.c` 是 mythroad 运行时的完整源码（1.2 MB），**每个工程用的都是同一份**。
如果每次构建都重编一遍，在 v86 里实测要 **206.3 秒** —— 占整条链路（227.7 秒，含
启动虚拟机 8 秒 + 装工具链 21.7 秒）的 91%。这就是「编译一次四五分钟」的全部原因。

有个对照能说明问题：同一份工程在安卓上用 `arm-linux-androideabi-gcc` 编译只要 **9 秒**
—— 它在**真机 CPU 上原生跑**，没有模拟层。v86 是纯软件模拟（WebAssembly JIT），
跑不出原生速度。所以唯一致胜的方向不是「让 v86 更快」，而是**别在每次构建里重复
编译同一批代码**。

做法：把运行时预编成静态库 `mrp_demo/lib/libmrp_engine.a`（19 个成员 / 323 KiB），
构建时只编用户自己的代码再链接它。

| | 全量编译 | 用引擎归档 |
|---|---|---|
| 编运行时（19 个 `.c`） | 206.3 s | 0（预编译好，随页面下发 323 KiB） |
| 编用户代码 + 链接 | 含在上面 | 3.1 s |
| **编译总耗时** | **206.3 s** | **3.1 s（66×）** |
| 产物 | 14,664 字节 | **14,664 字节，逐字节一致（同 sha256）** |

产物经 `tools/check-elf.py` 判定：静态 PIE、无 `DT_NEEDED`、31 条重定位**全部**是
`R_ARM_RELATIVE` —— 与全量编译的产物完全等价。

### 归档什么时候会重建：内容摘要，不是时间戳

「预编译的引擎」和「工程里实际的源码」必须对得上 —— 尤其 `src/` 下就是兼容层与
适配层（`mrp_compat.c`、`mrc_android.c`、`bridge.h`、`ex_math.h`、`mpc.h` …），
用户改了这些，引擎必须跟着重编。所以判定用的是**内容摘要**：

```
key = sha256( sha256sum src/*.c src/*.h  +  OPT + CODEFLAGS )
```

先逐文件算一遍（把「文件名 + 长度 + 内容」都算进去，没有文件边界歧义），再对这张
清单取一次摘要，同时把编译参数也盖进去。`lib/libmrp_engine.key` 存着生成归档时的
那份；Makefile 每次构建都现算一份比对，**对不上就重建归档**：

- 摘要一致 → 直接用归档，**3 秒编完**（完全不看任何时间戳）；
- 改了 `src/` 下任何 `.c` **或 `.h`** → 摘要变了 → 自动重建归档（≈190 s），之后又快回来；
- 归档和源码对不上（站点上放了旧归档、换了镜像忘了重生成）→ 一样能查出来；
- 归档整个缺失 → 同样自动重建，功能不受影响。

> 上一版用的是「谁的时间戳更新」这种弱证据，**头文件改动会漏判** —— 已改成摘要。
> 摘要工具也是实测确认过的：guest 的 rootfs 里**有 `sha256sum`**
> （`/usr/bin/sha256sum`，buildroot 的 busybox 带的；`/opt/tc` 里 Debian 那份也有），
> `echo -n abc | sha256sum` 能得到正确摘要。万一哪天镜像里没有了，Makefile 会自动
> 退回时间戳规则，功能不受影响。

因为校验在 Makefile 里，**一致性不依赖前端的推送行为** —— 前端把归档推过去只是
为了让快路径能命中；它推错了最多多花一次重建，不会编出错的产物。

产物一致性是实测过的（`node .build/verify-keyguard.mjs`）：正常 → 快路径；摘要改坏 /
改 `.h` / 改 `mrp_compat.c` → 都判定要重建；重建后新归档里确实带着改后的源码（用一个
探针字符串验证）；重建完摘要自动更新，又回到快路径。

### 改过 mrp_demo/src 之后要重跑生成器

```bash
node tools/make-engine-lib.mjs   # 改过 src/ 下的 .c/.h 就重跑：重生成 libmrp_engine.{a,key}
```

- **`make-engine-lib.mjs`** 会在真实虚拟机里编一遍运行时（约 190 s，只此一次），
  把归档**和摘要**取回写进工程目录，并顺手用归档编一遍完整工程做验证。
- 生成物（`lib/libmrp_engine.{a,key}`）随仓库提交，跑完记得一起提交。

> `mrp_demo.zip` 已经**不再是仓库里的文件**了：「下载demo」按钮改成
> **从虚拟机里现取模板打包**（见下节），所以不存在「zip 与模板对不上」这种事了。

### 编译耗时统计

每次「编译完成」都会同时报出本轮耗时，分段之和就是总耗时：

```
✓ 编译完成：bin.elf（14.3 KB）
  本轮编译耗时 8.8 秒（同步源码 0.4 秒 · 编译 7.6 秒 · 取回产物 0.8 秒）
```

改过 `src/` 的那一轮，「编译」段会多一个注明，一眼就知道为什么这轮要 3 分钟：

```
  本轮编译耗时 196.2 秒（同步源码 1.4 秒 · 编译 194.1 秒（含重建引擎归档）· 取回产物 0.7 秒）
```

编译失败时也会报一次已耗时（用同样的格式，开头写「本轮已耗时」），免得只看到
「编译失败」却不知道卡了多久。数据来自 `assets/vm.js` 的 `build()` —— 它按
「同步源码 / 编译 / 取回产物」三段各自计时并随返回值带出来；文案格式统一用
`assets/bytes.js` 的 `fmtDuration()`（`tools/test-v86.mjs` 和界面共用同一份，
`tools/test-bytes.mjs` 盯着它）。是否走了引擎重建由 guest 打印的
`[make] precompiling engine runtime` 识别，不另做猜测。

### 下载 demo / 下载当前项目：内容只有一个来源

不再下载仓库里那个静态的 `mrp_demo.zip` —— 那种文件是打包时刻的快照，
和镜像里的模板是两份东西：改了模板忘了重新生成，就会发出去一个对不上的工程包。
（真发生过：zip 停在 9-16 那一版，仓库的 `src/` 已经是 9-17 之后的样子，
`test-zip` 里「内容与磁盘文件一致」那项一直红着。）

现在点按钮时**从虚拟机里现取文件**（`assets/zip.js` 的 `zipDeflate()` 打包，
约 1.3 MB → 360 KiB），写完还用项目自己的 `unzip()` 读回来核对条目数与每项长度，
对不上就不给下载。源头只有一个：浏览器里正在被编译的那份工程。

同一个按钮按状态分两种口味（文案自己变，不用去猜下到的是什么）：

| 工程状态 | 文案 | 下载内容 | 包名 |
|---|---|---|---|
| 还没点「启动编译环境」 | 下载demo（**灰的，点不了**） | —— | —— |
| 已启动、**没改动过** | **下载demo** | 内置示例工程（就是模板那份） | `mrp_demo.zip` |
| 改过（编辑 / 导入 / 重命名 / 删除） | **下载当前项目** | 当前工程，**含你的改动** | `mrp_project.zip` |

「改动过」的判定（`isTemplatePristine()`）看三件事：传过文件、有真实编辑
（只是点开看一眼不算 —— 那种字节与模板一致）、**文件集与启动时的模板快照不一致**
（重命名 / 删除在前端不留内容痕迹，只能靠比清单）。所以改回去（A→B 又改回 A）
它会自己变回「下载demo」，不需要手动复位。

两个细节：
- 包里带的是**导出那一刻虚拟机里的 `Makefile`**，可能正是镜像内置那份没有引擎预编译
  逻辑的旧版 —— 拖回来时会被识别成「模板自带的那份」而不会被当成你的 Makefile（见下节）；
- 前端手里有字节的文件（改过的、刚导入还没编译过的）直接用它，不去虚拟机读 ——
  否则「导入一个文件还没编译就下载」会失败。

「改过」的判定（`isTemplatePristine()`）：**传过文件**（拖入 / 选择 / 解压 zip）算改过；
在编辑器里选中某个模板文件看一眼**不算**（`state.fromGuest` 专门记着「从模板原样
读进来、没动过」的那些，它们的字节与虚拟机里那份一致，打包结果不受影响）。
编译过也不影响 —— 模板清单是启动时记下来的，编译产物（`bin.elf`、引擎归档）
本来就不在清单里。

`tools/test-v86.mjs` 会照着这条路走一遍：从虚拟机取全部模板文件 → `zipDeflate()`
→ 用 `unzip()` 读回核对条目数与每项长度；`tools/test-zip.mjs` 单独覆盖压缩器本身
（往返 + 用 Node 的 zlib 独立解压缩段与校验 CRC32 + 反斜杠路径/EOCD 注释这些外来形态）。

### demo 包拖回来：包里那份 Makefile 不会被当成「你的 Makefile」

「下载demo」会把**当时虚拟机里的 `Makefile`** 一起打进包（本地开发要用得上）。
如果在还没编译过的会话里导出，包里带的就是**镜像内置那份旧 Makefile** ——
它没有引擎预编译归档逻辑，是每次全量编译 `src/` 的老版本。

拖回来时若直接当成「用户自己的 Makefile」，站点上那份新模板就再也注入不进去，
之后每次编译都要全量重编运行时（实测**冷启动 229.6 s、热机约 140 s**），
而且日志里**看不到任何归档相关的行**（旧 Makefile 根本没那条输出）——
只能看着一个耗时数字猜。所以 `ingestFiles()` 里加了一道判断
（`isTemplateMakefile()`）：**内容与已知模板 Makefile（启动时虚拟机里那份 + 站点上那份）
逐字节相同 → 不算用户文件**，构建时照常注入站点模板。

反过来，用户真的自己改了/上传了一份 Makefile（与模板都不同）→ 照样用他的，
但日志会明说，并在它没有引擎预编译逻辑时给出提示：

```
  使用工程里的 Makefile（未注入站点上的模板）
  ⚠ 这份 Makefile 没有引擎预编译逻辑 → 本次会全量编译 src/ 下的运行时（约 2~3 分钟）
    不是你特意改的话，点「恢复模板」再编译一次（会换回站点上的模板 Makefile）
```

### 在编辑器里点开看一眼，不会改动文件

编辑器是 `<textarea>`，它的 `value` 会把 **CRLF / CR 归一化成 LF**（HTML 规范如此，
无头 Edge 实测：3 行的 CRLF 文本进去 34 字节、出来 31 字节）。而 `mrp_demo/src/`
下 42 个 `.c/.h` 里有 **30 个是 CRLF** —— 所以「解码进编辑器 → 再编码写回」
会把这些文件悄悄改小：引擎内容摘要随之变化，下一次编译白白重建一遍归档
（≈3 分钟），推给虚拟机的也不再是模板那份源码。

`saveEditor()` 现在先比**文本**（`state.editorBase`）：与刚载入时一模一样就直接返回，
一个字节都不写；真的改过才重新编码。项目里其它走编辑器的路径也照这个约定。

### 工具链镜像不再每次重新下载

30.6 MiB 的 `rootfs.tar.gz` 以前每次打开页面都整包重下（代码里是
`fetch(..., { cache: 'no-store' })`，浏览器缓存用不上）。现在拼合好的整包会存进
**IndexedDB**（`assets/imagecache.js`），下次先用本地那份：

- 只要 `image/rootfs.parts.json` 里的 `sha256` 与本地记录一致 → **直接命中，不联网**；
- 线上镜像换过（sha 变了）→ 重新分段下载并覆盖；
- 本地那份读出来还会按 sha256 自校验一遍，损坏就当成没命中重新下（自愈，不需要
  「清缓存」按钮）；
- `file://` / 隐私模式 / 禁用存储 → 拿不到 `indexedDB`，全部优雅退化，行为和以前一致；
- 没有 `rootfs.parts.json` 时**不复用缓存**（没有清单就无法判断线上有没有变，
  宁可贵一点也不用错版本的工具链）。

顺带把「镜像是否就位」的探测挪到了启动虚拟机之前，并且本地缓存命中时跳过
那几次 HEAD 探测 —— 所以镜像在本地时，断网也能开工。

### 试过但没用的手段（都实测过）

| 手段 | 实测 | 结论 |
|---|---|---|
| `make -j4` | 193.4 s（vs 206.3 s） | v86 是单线程模拟，多核只省 6%，不值得 |
| 全量构建改 `-O1` | 122.5 s（vs `-Os` 206.3 s） | 只快 1.7×，且体积变大 —— 不如直接用归档 |
| 优化串口 / I/O | — | 一次完整构建的串口输出只有 **19.2 KiB**，I/O 从来不是瓶颈 |

---

## 架构

```
┌─ 浏览器 ──────────────────────────────────────────────────────────┐
│  index.html + assets/app.js    界面：编辑源码、选文件、看输出、下载 │
│                 │                                                  │
│                 │  assets/vm.js  (MrpVm，浏览器与 Node 共用)        │
│                 ▼                                                  │
│  v86 (libv86.js + v86.wasm)                                       │
│  ┌─ 32 位 Linux（内核自带 rootfs，Buildroot + uClibc 6.8.12）────┐  │
│  │  /mnt            ← 9p 共享目录（宿主读写）                    │  │
│  │  /opt/tc         ← 解压出来的工具链（glibc + arm-none-eabi）  │  │
│  │  /opt/tc/mrp_demo← 工程模板                                    │  │
│  │  /lib/ld-linux.so.2 → /opt/tc/lib/i386-linux-gnu/ld-linux.so.2│  │
│  └──────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

### 两个关键设计决定（都是踩坑后定下来的）

**1. 不传 initrd，改用内核自带的 rootfs + 9p 推 tarball。**

v86 给的 `buildroot-bzimage68.bin` 内核自带内嵌 initramfs，实测 100MB 的外部 initramfs
会被内核忽略、回落到自带 rootfs；而且这个内核**没启用 8250 串口 console**
（`console=ttyS0` 被静默忽略），内核报错只出现在 VGA 上，很难排查。

改成用自带 rootfs 后：启动从 ~30s 降到 **~8s**，也不再有体积限制。工具链作为
一个 `rootfs.tar.gz`（约 31MB）通过 9p 推进去，在虚拟机里解压到 `/opt/tc`。

**2. 自带 rootfs 是 uClibc，工具链是 glibc，需要一个桥。**

工具链二进制的 interpreter 写死为 `/lib/ld-linux.so.2`，而 Buildroot 里没有这个路径，
所以可以安全地把它指向解压出来的 glibc：

```sh
ln -sf /opt/tc/lib/i386-linux-gnu/ld-linux.so.2 /lib/ld-linux.so.2
export LD_LIBRARY_PATH=/opt/tc/lib/i386-linux-gnu
export PATH=/opt/tc/usr/bin:$PATH
```

`gcc` 派生出的 `cc1` / `as` / `ld` 都继承同样的环境，所以整条工具链都能跑起来。

**3. 9p 只支持扁平文件。**

v86 的 9p 文件系统只有 `create_file` / `read_file`，**没有目录操作**。
所以：源码以扁平名 `__up_0`、`__up_1`… 写入，虚拟机里按清单 `cp` 到工程目录；
产物 `cp` 到 `/mnt/__artifact` 再由宿主读回。

**命令**也走 9p：`vm.run()` 把命令正文写进 `/mnt/__cmd`，敲进交互 shell 的只有
`sh /mnt/__cmd`（列目录用 `/mnt/__lscmd`）。理由见下一节；环境变量（PATH 等）
由 `vm.setEnv()` 记着、每个脚本开头重放 —— 不依赖「交互 shell 记住了上一条 export」这种隐式状态。

### 编译输出里那些 `2=$?"` 是怎么回事

早期版本日志里会夹杂 `2=$?"` / `?"` 这种孤零零几行 —— 那是**我们自己命令的回显碎片**：
交互 shell 的行编辑器把发出的命令原样回显，长命令还会在 80 列处被插入真换行，
按整行过滤哨兵时只有含哨兵的那一段被滤掉，剩下的碎片就混进了给用户看的日志
（看着像状态，其实什么也不是）。现在命令正文一律先落到 `/mnt/__cmd` 再执行，
敲进去的只有一行 `sh /mnt/__cmd`，碎片绝迹 —— `tools/test-v86.mjs` 有一条通用断言盯着：
可见日志里任何一行都不该是我们发出去的命令的子串。

日志里「文件」相关的状态统一带 `[文件]` 前缀，一眼能分清是文件操作还是编译输出：

```
[文件] 读取 src/mrc_base.h（68.2 KB，来自虚拟机里的工程）
[文件] 已修改 helloworld.c —— 编译时会写进虚拟机
[文件] 同步到虚拟机：2 个改动（helloworld.c、src/mrc_base.h）
```

「已修改」**只在第一次真正改动时写一行**，不会每敲一个键刷一行（`app.js` 的 `logFile()`）。

---

## 目录结构

```
index.html                  主页面
assets/
  app.js                    界面逻辑
  vm.js                     MrpVm —— 虚拟机驱动（浏览器 / Node 共用，无 DOM 依赖）
  mrp-pack.js               MRP 容器打包器（浏览器 / Node 共用，无依赖，含 GBK 编解码）
  bytes.js                  gzip / tar 格式判定与压缩（打包器和镜像安装共用）
  imagecache.js             工具链镜像的本地缓存（IndexedDB；按清单 sha256 判断线上有没有变）
  ingest.js                 导入路径规则（剥公共顶层目录 / 跳过隐藏项 / .gitignore 匹配）
  codeview.js               C 源码着色 + 行号文本（纯函数，无 DOM 依赖）
  wheel.js                  滚轮决策：滚哪个元素、滚多少（纯函数，无 DOM 依赖）
  serial.js                 串口的收发编解码（UTF-8 字节级）+ 把路径安全拼进 shell 命令
  encoding.js               源码编码识别 + 编解码（UTF-8 / GBK，纯函数；GBK 复用 mrp-pack 的码表）
  theme.js                  浅色/深色主题（跟随浏览器 → 手动选择优先 → 记住上次）
  style.css                 两套调色板都在这里：:root 与 :root[data-theme="dark"]
  v86/                      v86 运行时（本地化，BSD-2-Clause）
    libv86.js  v86.wasm  v86-fallback.wasm
    bios/seabios.bin  bios/vgabios.bin
  image/                    虚拟机镜像（由 tools/make-image.py 生成）
    vmlinuz.bin             内核（10 MiB）
    rootfs.tar.gz           工具链（31 MiB 压缩 / 101 MiB 解开）
    rootfs.tar.gz.part*     按 20 MiB 切的分段（Cloudflare Pages / EdgeOne 的 25MB 限制）
    rootfs.parts.json       分段清单（大小 + sha256，浏览器按它拼合校验）
    image.json              构建元信息（含 sha256，可用于校验）
mrp_demo/                   MRP 工程模板（「下载demo」直接从虚拟机里这份现取打包，
                            仓库里不再有静态的 mrp_demo.zip —— 见「下载 demo」）
  Makefile                 按社区方案编写（含引擎预编译归档逻辑，见「编译速度」）
  helloworld.c  src/*.c  src/*.h  assets/
  lib/                      壳文件 start.mr / cfunction.ext
    libmrp_engine.a         运行时引擎预编译归档（19 个成员 / 323 KiB）——
                            有它编译 3 秒，没有它每次都要全量编 206 秒
    libmrp_engine.key       上面那份归档的内容摘要（src 的 .c+.h 内容 + 编译参数的
                            sha256）；Makefile 靠它判断归档与源码是否一致
tools/
  make-image.py             组装工具链镜像（纯 Python，不需要 Docker / Linux / root）
  make-engine-lib.mjs       生成/更新 libmrp_engine.{a,key}（改过 src/ 下 .c/.h 后要重跑）
  check-elf.py              校验产物是否满足 MRP 加载器要求
  pack-demo.mjs             命令行打包器：把 mrp_demo 打成 .mrp（不需要浏览器）
  dev-server.mjs            本地静态服务器（--gzip-static 可复现镜像被解压的问题）
  test-v86.mjs              在 Node 里跑通整条链路，无浏览器也能验证
  test-zip.mjs              验证 zip 读取/生成（含 Windows 反斜杠条目名归一化）
  test-pack.mjs             用两个真实 mrp 样本逐字节验证打包器
  test-bytes.mjs            验证 gzip/tar 格式判定 + 体积文案（B/KB/MB/GB）换算
  test-meta.mjs             验证打包前的字段校验（与界面共用 mrp-pack.js 的规则）
  test-vm-queue.mjs         验证虚拟机命令串行化
  test-forward.mjs          验证串口日志的哨兵过滤
  test-errors.mjs           验证「复制错误」的报错行提取
  test-theme.mjs            验证主题判定规则 + 两套调色板一致（含"没有字面颜色"守卫）
  test-imagecache.mjs       验证工具链镜像的本地缓存判定 + 无 indexedDB 时优雅退化
  test-ingest.mjs           验证导入路径规则 + .gitignore 解析与匹配（正反两面）
  test-v86-mouse.mjs        验证 v86 的鼠标/键盘适配器被关掉（否则启动后输入框点不进去）
  test-codeview.mjs         验证 C 着色（转义 / 往返无损 / 各类 token）+ 与 style.css 的契约
  test-wheel.mjs            验证滚轮决策：普通滚轮纵向、Shift 只横向（滚到尽头就停住不越界）
  test-serial.mjs           验证串口 UTF-8 往返 + shell 引号转义（含单引号/反引号/分号）+ 路径白名单
  test-encoding.mjs         验证源码编码识别（UTF-8/GBK，用 Python 算出的已知 GBK 字节做基准）
  test-project-files.mjs    工程文件那块：大小显示、重命名/删除同步、下载按钮文案与包名
  dev-inspect-mrp.py        独立的 mrp 解析器（另一个实现，用来交叉验证）
```

---

## 用法

### 1. 生成工具链镜像（一次性）

```bash
python tools/make-image.py
```

会从 Debian（默认清华镜像）下载 i386 的 `gcc-arm-none-eabi`、`binutils-arm-none-eabi`、
`make`，按裁剪规则过滤后打包成 `assets/image/rootfs.tar.gz`。

不需要 Docker、不需要 Linux、不需要 root。

| 参数 | 说明 |
|---|---|
| `--list` | 只看依赖解析结果，不下载 |
| `--repack-only` | 只重新打包（刷新软链 / 模板后打 tarball），不下载不解包 |
| `--skip-extract` | 沿用已有 `.build/rootfs` |
| `--mirror <url>` | 换镜像源（`deb.debian.org` 在部分网络下会中途断流） |

### 2. 起本地静态服务器

```bash
python -m http.server 8000     # 或者用项目自带的：
node tools/dev-server.mjs --port 8000
```

打开 `http://localhost:8000/`。

> 必须用 HTTP 打开。直接双击 `index.html` 会因为同源策略导致 v86 无法加载内核与 wasm。
>
> **⚠ 别用会给响应加 `Content-Encoding` 的服务器 / 代理。** nginx 开了 `gzip_static`、
> 某些 CDN 会把 `foo.tar.gz` 当成「foo.tar 的 gzip 表示」，直接回
> `Content-Encoding: gzip` + 文件原始字节 —— 浏览器就会自动解压，
> 页面拿到的变成**未压缩的 tar**（30.6 MiB 的镜像变成 101.4 MiB），
> 虚拟机里 `gzip -dc` 报 `invalid magic`。
> 现在安装程序会自己识别并重新压回去，日志里会有
> 「镜像不是 gzip（被传输层透明解压过），已重新压缩」的提示；
> `node tools/dev-server.mjs --gzip-static` 可以复现这个场景做回归验证。

### 3. 页面上

1. 点「启动编译环境」——启动虚拟机并装入工具链（首次约 20~30 秒；
   镜像按 20 MiB 分段下载、拼合后做 sha256 校验，兼容单文件 25MB 限制的静态托管）
2. 左侧选模板文件编辑；导入自己的代码有三种方式：
   · 点「**选择文件**」或把 `.c` / `.h` / 资源文件**拖进页面**；
   · 点「**选择文件夹**」选一个工程目录 —— 按相对路径铺进工程（你选中的那级目录名
     会自动剥掉），**目录里的 `.gitignore` 会被读来当过滤规则**（`node_modules/`、
     `build/`、`*.o` 这类本来就不入库的东西直接跳过；支持 `!` 取反与子目录里的
     `.gitignore`），`.git` / `.DS_Store` 等隐藏项也跳过，里面的 `.zip` **不会被解开**；
   · 把一个 **zip 源码包**拖进来 —— 会解开铺进工程（zip 不读 `.gitignore`，按包内容原样铺）。
   后两种都会自动判断入口源文件（优先 `main.c`，其次扫描含真实 `main(` 定义的 `.c`
   —— 先剥掉注释再判断，避免把注释里的示例代码当入口；都没有则保持默认 `helloworld.c`）
3. 「工程文件」列表每行是 `文件名 + 大小 + 状态 + 两个按钮`：
   · **大小**用 KB / MB 显示（改过 / 传过的文件以内存里那份字节为准 —— 那才是编译时写进虚拟机的长度）；
   · **铅笔** = 重命名：只改名字本身（目录不动），就地输入，<kbd>Enter</kbd> 确定 / <kbd>Esc</kbd> 取消；
   · **垃圾桶** = 删除：第一次点变成「再点一次删除」（6 秒内有效），防手滑。
   两个动作都是**直接改虚拟机里的工程目录**（和编辑器改内容一样，数据只有一份 ——
   前端不另存副本），改完会重新问虚拟机要一遍清单；编辑器里正打开的那份、入口源文件
   输入框都会跟着调整。想整体退回模板用「恢复模板」。
4. 源码编辑区带**行号**和 **C 语法着色**（注释 / 字符串 / 预处理指令 / 数字 / 关键字 /
   类型 / 函数名，浅色深色各一套配色）。做法是「**透明的 textarea 叠在着色层上**」——
   输入、光标、选区都还是原生 textarea 的，所以撤销、输入法、鼠标拖选全不受影响；
   行号槽与着色层跟着滚动逐像素镜像。单份文件超过 200 KB 会自动**关掉着色**
   （那会生成几万个 span，输入会发涩），行号照常显示。
   打开文件时**自动识别 UTF-8 / GBK 编码**（MRP 工程里常有 GBK 源文件，硬按 UTF-8 解中文注释会
   变 �；识别见 `assets/encoding.js`），保存时**按原编码写回** —— 中文字符串字面量的字节不会变，
   编译进真机才不会乱码。GBK 文件在编辑器底部和「编译输出」里会标注「GBK 编码」。
   选中文字时选区用**半透明**底色，让下层的语法配色透出来 —— 用不透明色会把所选代码
   整段盖成一片纯色块（看着像「一选中字就没了」）；而关掉着色的那两种状态
   （超长文件 / 输入法组字，文字由 textarea 自己画）反过来用不透明底 + 亮色文字。
   滚轮：直接滚是**纵向**，<kbd>Shift</kbd> + 滚轮**只做横向**（长行不用去够滚动条），
   到头就停住、不会改成上下滚。
   （宿主预览面板会吞掉 `wheel` 事件，所以这份滚动是我们自己接管的，见 `assets/wheel.js`）
   编辑器右下角的「**全屏**」把它铺满整个网页（只是加个 class，不走 Fullscreen API ——
   那会把浏览器 UI 一起切走、嵌入式宿主里还常被禁用）；再点一次或按 <kbd>Esc</kbd> 退出。
   全屏时顶栏被盖住，但 <kbd>Ctrl/Cmd</kbd>+<kbd>Enter</kbd> 编译仍然可用。
   **读 / 改的状态会在「编译输出」里明说**（`[文件]` 前缀，见「编译输出里那些 `2=$?"` 是
   怎么回事」那节）：`[文件] 读取 xxx（大小）`、`[文件] 已修改 xxx`、
   编译前 `[文件] 同步到虚拟机：N 个改动（…）`。不用盯着编辑器底下那行小字猜。
5. 点「编译」（或 <kbd>Ctrl/Cmd</kbd>+<kbd>Enter</kbd>）—— **约 3 秒**
   （走引擎预编译归档；改过 `src/` 之后那一次会重建归档，≈190s）
6. 点「打包 .mrp」填好信息 → 生成并下载；也可以只点「下载 bin.elf」拿裸产物
7. 「下载demo / 下载当前项目」按钮 —— 编译环境就绪后就能点（未启动时是灰的）；
   **没改动过工程**时文案是「下载demo」（下的是内置模板那份，`mrp_demo.zip`），
   **改过**（编辑 / 导入 / 重命名 / 删除）文案变成「下载当前项目」（`mrp_project.zip`）。
   两种都是从虚拟机里现取文件打包，所以要先「启动编译环境」。
   详见「下载 demo：内容只有一个来源」
8. 「**恢复模板**」= 把工程退回内置模板。注意它不只清界面：**虚拟机里的工程目录
   （`/opt/tc/mrp_demo`）也会整目录换回镜像里那份** —— 用户加的文件、改过的源码、
   上次的 `bin.elf` 一并清掉，所以恢复之后再编译是**真正重编一次模板工程**，
   不会出现「点完恢复模板、再点编译，0.3 秒就说编译完成、产物还是上一个」这种事
   （那正是只清前端状态时的表现：`make` 发现没变化，回一句
   `Nothing to be done for 'all'`，把旧产物交出来）。
   模板副本是装工具链时 `cp -a` 留的（0.2 秒），换回来也只要 0.2 秒；
   没有任何改动时点它只重置界面状态，不动虚拟机。
9. 右上角「帮助」按钮随时调出速览弹窗：把整条流程（加载环境 → 编译 → 打包）和三种导入方式列在一起
10. 最右边那个日/月图标是**主题切换**：默认跟随浏览器（系统深色页面就是深色），
   点一下就切成另一套并记住 —— 下次打开直接恢复上次用的那套
   （偏好存在 `localStorage` 的 `mrp-theme`，值只有 `light` / `dark`；
   删掉这个键就回到「跟随浏览器」。图标显示的是**点了会去的那一侧**）

> 已经有编好的 `bin.elf` 时，直接把它拖进页面就能打包，不必重跑一遍编译。

### 4. 命令行打包（不走浏览器）

```bash
node tools/pack-demo.mjs --display "我的应用" --appid 30001 --version 1 \
     --vendor "AI Studio" --desc "一句话介绍" --out dist/demo.mrp

# 指定别的产物 / 资源
node tools/pack-demo.mjs --display "X" --elf path/to/bin.elf --res res/a.bmp --out x.mrp

# 交叉验证（另一个独立的解析器实现）
python tools/dev-inspect-mrp.py dist/demo.mrp
```

### 5. 无浏览器时验证

```bash
node tools/test-v86.mjs              # 完整流程
node tools/test-v86.mjs --diag       # 只装工具链并打印环境信息
node tools/test-v86.mjs --cmd "..."  # 装完工具链后跑自定义命令
SRC_FILE=path/to/main.c APP=main.c node tools/test-v86.mjs
```

### 6. 跑全部测试

```bash
node tools/test-pack.mjs        # 打包器（含两个真实样本的逐字节往返）
node tools/test-meta.mjs        # 打包表单字段校验（显示名/内部名/appid/版本/开发者）
node tools/test-bytes.mjs       # gzip/tar 格式判定 + 体积文案换算
node tools/test-vm-queue.mjs    # 虚拟机命令串行化
node tools/test-forward.mjs     # 串口日志哨兵过滤
node tools/test-errors.mjs      # 报错行提取
node tools/test-theme.mjs       # 主题：判定规则 + 两套调色板一致性 + 内联脚本不漂移
node tools/test-imagecache.mjs   # 镜像本地缓存：判定规则 + 存储不可用时优雅退化
node tools/test-ingest.mjs      # 导入路径规则：剥顶层目录 + 隐藏项 + .gitignore 匹配
node tools/test-v86-mouse.mjs   # v86 适配器：不关掉的话，启动虚拟机后输入框会点不进去
node tools/test-codeview.mjs    # 源码着色：HTML 往返无损 + token 类与调色板的契约
node tools/test-wheel.mjs       # 滚轮决策：Shift 只横向（到头停住）/ 普通滚轮纵向 / 链式滚动
node tools/test-serial.mjs     # 串口 UTF-8 收发 + 单引号转义（不能出现命令注入）
node tools/test-encoding.mjs   # 源码编码识别：UTF-8/GBK，GBK 字节与 Python 一致
node tools/test-project-files.mjs  # 工程文件：大小 / 重命名 / 删除 / 下载按钮文案与包名
python tools/check-elf.py .build/bin.elf   # 产物重定位校验
```

---

## MRP 编译的硬约束

### 加载器只认 RELATIVE 重定位

MRP 壳里的 ELF 加载器（`loader/elfloader.c` 的 `el_applyrel`）**只处理 `RELATIVE` 一种重定位**，
其余类型一律返回 `EL_BADREL`，并且不加载 `DT_NEEDED`、不处理 `DT_JMPREL`。

这就是社区反复提到的「GOT 表问题」：如果链接进 C 库或软浮点库，就会带出
`GLOB_DAT` / `JUMP_SLOT` 重定位，加载器直接拒绝。

### 2) r9 / r10 必须让给壳

MRP 壳是 APCS 编译的，它自己拿 **r9(sb)** 当静态基址、**r10(sl)** 当栈限；
而 GCC 在 `-fPIC` 下默认也会把 r9 当 GOT/静态基址、把 r10 当栈限。
两边抢同一对寄存器，于是出现那个很典型的症状：

- **安卓模拟器 / v86 里跑得好好的** —— 壳那条路径碰巧没被踩到；
- **MTK 真机（6225 / 6235 / 6250）一进启动页就死住** —— 卡在启动页，无报错、无日志。

所以编译参数里**必须**有 `-ffixed-r9 -ffixed-r10`，让编译器彻底不碰这两个寄存器。

同一份 `helloworld.c` + `src/`（19 个 .c），加上这一对开关前后对比：

| | 旧参数（`-O2`，无 `-ffixed`） | 新参数（见下） |
|---|---|---|
| 反汇编里出现 r9/r10 的行数 | **702** | **0** |
| 产物大小 | 259,124 字节 | 14,640 字节 |
| 动态重定位 | 89 条，全 `R_ARM_RELATIVE` | 31 条，全 `R_ARM_RELATIVE` |

`make check` 会把 r9/r10 占用行数直接打出来，不是 0 就说明这个开关没生效。

### 完整编译参数

```makefile
CODEFLAGS := -marm -march=armv5te -mfloat-abi=soft -fPIC -g0 \
             -ffixed-r9 -ffixed-r10 \
             -ffunction-sections -fdata-sections \
             -fno-common -fshort-enums \
             -fno-tree-loop-distribute-patterns
LDFLAGS   := -nostdlib -nostartfiles -pie -Wl,--entry=_start \
             -Wl,--gc-sections -Wl,--strip-all -Wl,--strip-debug
```

这套与 **TinalIDE**（`Mrp项目-TinalIDE`）里跑通真机的 Makefile 对齐；逐条为什么这么写，
见 `mrp_demo/Makefile` 顶部的注释。三点值得单独说明：

- **`-nostdlib -nostartfiles` 是关键**：不链接任何库，符号全部内部解析，
  动态重定位就只剩 `R_ARM_RELATIVE`。
  **故意不加** `--specs=nano.specs -lc -lm` —— 链进 libc 会带出 GOT / `GLOB_DAT`，
  而且镜像里本来也没装 `libnewlib-arm-none-eabi`，`-lc` 会直接 `cannot find -lc`。
- **`-Wl,--gc-sections` 才是真正减体积的那一个**（demo 从 ~259KB 降到 ~15KB）。
- `-Wl,--strip-all` / `-Wl,--strip-debug` 实测在 GNU ld 上是**空操作**
  （加与不加产物字节数完全一样），保留只是为了跟 TinalIDE 的写法一致、也无副作用。

`tools/check-elf.py` 专门检查重定位这件事，编译后建议跑一次。

### 但 libgcc 必须手动链进来

ARM7TDMI 没有 FPU，只要代码里有浮点运算，GCC 就会生成对软浮点辅助函数的调用
（`__aeabi_fadd` / `__aeabi_fdiv` / `__aeabi_fcmplt` …），而这些由 `libgcc.a` 提供。
`-nostdlib` 会把 libgcc 一起禁掉，所以 Makefile 里显式把它传进去：

```makefile
LIBGCC := $(shell $(CC) $(CODEFLAGS) -print-libgcc-file-name)
$(CC) -o $@ $(SRCS) ... $(LDFLAGS) $(LIBGCC)
```

实测链接 libgcc **不会**破坏「只有 RELATIVE 重定位」这个性质（88 条仍然全是 `R_ARM_RELATIVE`）。

### 标准 C 头文件要单独装

Debian 把 newlib 拆成了两个包：

- **`libnewlib-dev`**（0.2 MiB）—— 标准 C 头文件，装在 `usr/include/newlib/`
- `libnewlib-arm-none-eabi`（360 MiB）—— newlib 多版本库

只装 `gcc-arm-none-eabi` 是**没有** `stdlib.h` / `math.h` 的。
本项目的做法是只装前者，并用 `CPATH` 指过去；后者用不到（`-nostdlib`）。

### 工具链版本敏感

社区验证过的组合是 **arm-none-eabi-gcc 9.3.1**。本项目用的是 Debian bookworm 的
**12.2.rel1**（i386 版里较新的稳定版本）。如果产物在真机上有异常，可以换 Debian
历史版本（pool 里有 `8-2019-q3-1+b1_i386.deb`，更接近 9.3.1）。

> ⚠️ 但**换版本之前先确认 r9/r10 那对开关在**（见「MRP 编译的硬约束」）。
> 「模拟器能跑、真机卡启动页」这个现象**不是**版本问题，是 `-ffixed-r9 -ffixed-r10` 没加；
> 换工具链版本治不了它。

---

## 打包成 .mrp

`bin.elf` 还要和壳文件、资源一起打成 `.mrp` 才能装到手机上。顺序是：

```
start.mr  →  bin.elf  →  资源文件  →  cfunction.ext
```

这一步是纯数据处理，已经**完全用 JS 实现**（`assets/mrp-pack.js`），浏览器和命令行共用同一份：

- 浏览器：点「打包 .mrp」，填显示名 / 内部名 / appid / 版本 / 开发者 / 介绍，勾选资源 → 生成并下载
- 命令行：`node tools/pack-demo.mjs --display "..." --out dist/demo.mrp`

### 容器格式

```
┌────────────────── 240 字节固定头 ──────────────────┐
│ [0:4]   "MRPG"                                     │
│ [4:8]   fileStart = 240 + 列表区长度 - 8            │
│ [8:12]  文件总长度                                  │
│ [12:16] 固定 240                                    │
│ [16:28] 内部名      GBK，12 字节                     │
│ [28:52] 显示名      GBK，24 字节                     │
│ [52:68] 授权串 authStr                              │
│ [68]    appid        [72] version                   │
│ [76]    flag         [80] builderVersion = 10002    │
│ [84]    CRC32（计算时本字段为 0）                     │
│ [88:128] 开发者     GBK，40 字节                     │
│ [128:192] 介绍      GBK，64 字节                     │
│ [192] 大端 appid    [196] 大端 version              │
│ [200] 保留  [204] 屏宽  [206] 屏高  [208] plat=1    │
│ [209:240] 保留 31 字节                              │
├────────────────── 文件列表区 ──────────────────────┤
│ 每项：名称长度(4) 名称+\0 偏移(4) 长度(4) 保留(4)     │
├────────────────── 文件数据区 ──────────────────────┤
│ 每项：名称长度(4) 名称+\0 长度(4) gzip 数据           │
└────────────────────────────────────────────────────┘
```

依据三份来源互相印证：`MrpProjects/MrpEditor` 的 `mrpinfo.ts`、
`mrpbuilder` 的 Go 版 `mrp.go`，以及两个真机可跑的样本
（样本不随仓库分发，见 `tools/test-pack.mjs`）。

### 四个容易踩错的点

1. **`fileStart` 要减 8。** Go 源码里的原话是「不明白为什么要减8，但是必需这样做」，
   实测样本确实如此。
2. **CRC32 是「把 [84:88] 置零后对整个文件计算」**，而不是跳过这 4 字节。
   `MrpEditor` 的 `mrpinfo.ts` 写的是「跳过」，那是错的 —— 在样本上验过，
   算出来的值和真实产物对不上（`0x78D2333` vs 正确的 `0x0E4BDE9D`）。
3. **每个文件都要单独 gzip。** 两个样本里的 5 个文件全是 gzip 流，
   Go 打包器也是无条件 `gzipFile()`。不是只压 `start.mr`。
4. **内部名/显示名/开发者/介绍全是 GBK 编码**，字段定长、超长要截断。
   浏览器里没有 GBK 编码器（只有解码器），这里是**把全部 23940 个双字节码位
   一次性解码成字符串、反向建表**得到的编码器 —— 零外部依赖、不用附带码表文件
   （实测解码 3ms + 建表 14ms，只在首次打包时做一次）。

### 关于名字

`cfunction.ext` 里的 ELF 加载器就是按字符串 `bin.elf` 去找文件的
（二进制里能搜到 `bin.elf` 和 `load bin.elf fail.`），所以**文件名不能改**。
`start.mr` 里也写死了引用 `cfunction.ext`。

---

## 验证状态

工具链这一侧已经**在真实环境跑通并逐项校验**（`node tools/test-v86.mjs`）：

| 环节 | 结果 |
|---|---|
| v86 启动 32 位 Linux | ✅ shell 就绪约 **8 秒** |
| 推送 31MB 工具链 + 解压 + 配环境 | ✅ 约 **20 秒** |
| `arm-none-eabi-gcc` 运行 | ✅ `12.2.1 20221205`（Debian bookworm 12.2.rel1-1） |
| 编译完整工程（`helloworld.c` + `src/` 下 19 个 .c，约 1.3MB 源码） | ✅ 全部编译通过，仅 warning；实测 **206.3 秒** |
| 用引擎归档编译（只编用户代码 + 链接 `libmrp_engine.a`） | ✅ **3.1 秒**，产物与全量编译**逐字节一致（同 sha256）** |
| 软浮点（`__aeabi_*`）链接 | ✅ 正确链入 libgcc |
| 产物格式 | ✅ ARM 静态 PIE（ET_DYN），无 `DT_NEEDED` |
| 动态重定位 | ✅ **31 条全部是 `R_ARM_RELATIVE`** |
| r9 / r10 占用 | ✅ **反汇编里 0 行**（`-ffixed-r9 -ffixed-r10` 生效） |
| 9p 取回产物 | ✅ **14,664 字节**（`-Os` + `--gc-sections` 完整构建，`tools/check-elf.py` 判定通过） |

自检产物（`make selftest`，符号全部解析干净）经 `check-elf.py` 判定为 **0 条动态重定位**，
完全满足 MRP 加载器要求 —— 说明编译器 / 链接器 / flags 这条链是可靠的。

**真实浏览器里也跑通了**（用 `agent-browser` 驱动 Chromium 走完整流程）：

| 环节 | 结果 |
|---|---|
| 页面启动虚拟机 + 装工具链 | ✅ 点「启动编译环境」后约 **20 秒**到「环境就绪」 |
| 读到内置模板 | ✅ 50 个文件（含 `src/mrp_compat.c`） |
| 点「编译」跑完整 `-Os` 构建 | ✅ **编译成功**，与 Node 侧结果一致（**14,664 字节**） |
| 用引擎归档的两次构建（推归档 → 快路径 / 归档缺失 → 自动重建） | ✅ 3.6s / 196.0s，两次产物都与全量编译**逐字节一致** |
| 「下载 bin.elf」 | ✅ 按钮变为可用 |
| 输出框文本选择 | ✅ `user-select: text`（`Ctrl/Cmd+A` 可全选） |
| 「复制错误」/「复制日志」 | ✅ 前者只留报错行 + `in function` 上下文，过滤 warning 与普通输出 |
| **「打包 .mrp」真实鼠标点击** | ✅ 对话框打开 → 填表 → 生成并下载，产物 **216,777 字节**，页面自检通过 |
| 只上传 `bin.elf` 不编译就打包 | ✅ 按钮自动可用，日志提示"不必重新编译" |

**深色模式也在真实浏览器里核过**（无头 Edge + 同源 iframe 跑真页面，25 项断言全过）：

| 环节 | 结果 |
|---|---|
| 默认跟随浏览器 | ✅ 系统浅色 → `data-theme=light`；桩成系统深色 → 深色 |
| 点按钮切换 | ✅ 真的点 `#btnTheme`，`data-theme` 翻转且立刻写入 `localStorage` |
| 关掉再打开 | ✅ 恢复上次手动选择的那套（断言重新加载后的 `data-theme`） |
| 深色确实生效 | ✅ 计算样式 `body` = `rgb(27,27,25)`、控制台 = `rgb(19,19,18)`（浅色下是 `#fff` / `#f1efe8`） |
| 图标随主题换 | ✅ 浅色显示月亮（点了去深色），深色显示太阳 |
| 弹窗 / 表单 / 粘底按钮 | ✅ 打包与帮助弹窗在深色下逐个截图核对，无浅色残留 |
| 窄屏（820px） | ✅ 顶栏单行放下 6 个按钮 + 图标按钮，无横向溢出 |
| 切换按钮尺寸 | ✅ 6 个按钮高度全部 `31.19px`、内边距一致，图标垂直偏差 `0.00px`（与文字按钮同高） |
| 切换是渐变不是硬切 | ✅ 表面（背景/边框/投影）淡入淡出 `0.28s`，实测起 150+ 条 running 过渡 |
| 切换途中不"闪" | ✅ 逐点拨动画时间轴实测：全程最低对比度 **3.43:1**；把墨色也做成淡入淡出时只有 **1.03:1**，那就是肉眼看到的"闪一下" |
| 日月图标换色 | ✅ 两个图标叠在同一格、靠 `opacity` 切换（用 `display` 切不会起过渡，颜色会卡在旧色） |
| 回归测试 | ✅ `node tools/test-theme.mjs`（判定规则 + 两套调色板一致 + 内联脚本不漂移 + 按钮尺寸/过渡） |

> **为什么墨色（文字/图标）不做淡入淡出**：深浅两套的墨色与底色亮度是**反的**，
> 两边同时淡，中途必然出现"墨色 ≈ 底色"——实测正文/正文底对比度会掉到 1.03:1，
> 相当于内容在过渡中间整片消失再回来，眼睛看到的就是"闪"。
> 所以表面照旧渐变，墨色改成在 `--theme-ink-delay`（0.12s）处**一次性跳变**，
> 跳变点取表面渐变到 ~40% 时（此时底色亮度正好落在两套墨色中间），全程最差也有 3:1 左右。
> 另一个坑：图标是 SVG 画笔，靠 `stroke="currentColor"` 继承父级 `color` 时，
> Chrome 不会在父级颜色过渡的过程中重新解析它（实测整段切换里 `stroke` 卡在旧色、
> 连一条 `stroke` 过渡都起不来）→ 图标必须**自己持有墨色**（`.ico { color: var(--text) }`），
> 并且两个图标要**叠着用 `opacity` 切换**：从 `display:none` 变可见的元素按规范不会启动过渡。

> 首屏防闪靠 `index.html` / `404.html` 里那段极小内联脚本，在首次渲染前就打上 `data-theme`；
> 这段逻辑与 `assets/theme.js` 是**刻意重复**的（模块脚本跑得太晚），所以用测试钉住两边
> 必须用同一个存储键与媒体查询。

### 输出框的复制能力

- 显式 `user-select: text` + `tabindex="0"`，鼠标拖选、`Ctrl/Cmd+A` 全选都可用
- **「复制错误」**：只提取报错行（`undefined reference` / `error:` / `ld:` / `collect2:` /
  `make: ***` / `No such file` / `cannot ...` / `fatal error` / `编译失败`），
  并把紧邻的 ``in function `xxx':`` 上下文行一起带上 —— 直接贴出来就能给别人看
- **「复制日志」**：全文
- `navigator.clipboard` 只在安全上下文可用；`file://` 或局域网 http 下会退回
  `execCommand('copy')`，再不行就提示手动选中
- 日志里的**内部哨兵已被过滤**（见下），所以拷出来的内容是干净的

### 日志为什么是干净的

`vm.js` 判断一条命令是否跑完，靠在交互 shell 里 `echo` 一个随机哨兵
（`__RCxxxxxx=$?` / `__LSxxxxxx_B`）。这些哨兵连同被回显的命令行会混进串口流，
界面上就会出现 `__RC7w0lx=2` 这种行。`MrpVm._forward()` 现在按**整行**判定后再转发：
哨兵行丢掉，其余原样送出（`this.serial` 保持原样，`waitFor`/`run` 的匹配不受影响）。
调试时可用 `rawOutput: true` 关掉过滤（`tools/test-v86.mjs` 就是这么设的）。

### 打包器的验证

打包这件事不能只看「能生成一个文件」，所以做了四层校验：

| 校验 | 结果 |
|---|---|
| **两个真实样本逐字节往返**：把两份真机可跑的 `.mrp` 里已 gzip 的数据原样取出，用自己的容器逻辑重新组装 | ✅ 两个都**一个字节都不差** |
| CRC 变体判定 | ✅ 置零版吻合、`mrpinfo.ts` 的跳过版不吻合 |
| **独立解析器交叉验证**：`tools/dev-inspect-mrp.py`（另一套实现）解析自己生成的产物 | ✅ 头 / 列表区 / 偏移 / CRC 全部自洽 |
| **内容往返**：解开 `.mrp` 里的每个文件与源文件比对 | ✅ 5 个文件全部逐字节一致 |
| **浏览器产物 vs 命令行产物**（参数相同） | ✅ **逐字节完全相同**（216,777 字节，指纹一致） |

顺带确认了一件好事：Chrome 的 `CompressionStream` 与 Node 的 zlib
对同一输入的 gzip 输出是字节一致的，所以两条路径可互换。

### 顺手修掉的七个 bug

**1. 虚拟机命令没有串行化。** 串口交互 shell 只有一条，而 `run()` 靠在 shell 里
`echo` 哨兵来判断命令结束。打包对话框打开时会预读壳文件，如果用户此刻点「生成」，
两条命令同时打进 shell，哨兵互相错认 → 双方一起卡到超时。
修法：`MrpVm._enqueue()` 把 `run()` / `listProjectFiles()` 全部排队。
回归测试见 `tools/test-vm-queue.mjs`（含"超时后队列不能卡死"）。

**2. 打包对话框的按钮点不到。** 对话框内容（表单 + 打包清单）高 797px，
但盒子只有 537px，底部按钮被裁到可视区之外 —— 真实鼠标点击落不到按钮上
（诊断时 playwright 报 "✓ Done"，是加了个 `entered` 钩子才确认 handler 根本没触发）。
修法：`.dlg` 限高 `calc(100vh - 40px)` + 内部滚动，`.dlg-actions` 用 `position: sticky`
粘在底部，保证任何窗口高度下按钮都可见可点。

**3. 弹窗在页面加载时就显示出来了。** 根因是 CSS 里给 `.dlg` 写了 `display: flex` ——
**作者样式会盖过浏览器默认的 `dialog:not([open]) { display: none }`**，
于是关闭状态的 `<dialog>` 也占位显示。修法：基础 `.dlg` 不设 `display`，
只在 `.dlg[open]` 里设 `flex`。
（这类坑值得记一下：原生 `<dialog>` 的显隐完全靠 `open` 属性 + 那条 UA 规则，
任何作者侧的 `display` 声明都会把它破坏掉。）

**4. 工具链镜像装不进虚拟机（`gzip: invalid magic` + `tar: short read`）。**
镜像本身是好的（30.6 MiB gzip），但**传输层把它透明解压了**：服务器给响应带上
`Content-Encoding: gzip`，浏览器自动解码一次，页面拿到的就是未压缩 tar
（**101.4 MiB** —— 这就是为什么日志里的数字"看起来不对"）。
推给虚拟机后 `gzip -dc` 自然报 invalid magic，而且这个报错完全指不到原因。
修法分三层：
- `installToolchain` 先判格式：不是 gzip 就地压回去，结果由日志提示；
  既不是 gzip 也不是 tar 则报出**前 4 字节**让人一眼看清拿错了什么
- 推送后用 `wc -c` 核对虚拟机里镜像的字节数，9p 截断也能立刻发现
- `make-image.py` 生成后自检（gzip 魔数 / 解开 / tar 可读 / 关键文件齐全），
  把问题挡在生成端
回归验证：`node tools/dev-server.mjs --gzip-static` 复现该行为，
页面应能自动恢复并正常安装。
（顺带修了同源的哨兵泄漏：`waitForShell` 用的 `__RDY` 前缀没进 `SENTINEL_RE`，
日志里会漏出 `__RDY3mn17d` 这种行。）

**5. 分段清单的段大小写错。** `make-image.py` 切 20 MiB 分段时把每段的
`size` 写成了 `len(blob) - i`（从该段起点到文件末尾的长度），
part00 的"期望大小"于是等于**整个文件的大小**，浏览器下载 20 MiB 后
反而报「分段不完整」。修法：`min(PART_BYTES, len(blob) - i)`。
教训：**清单里每个字段的语义要在生成端和消费端各验证一遍**，
第一版只在浏览器里"能拼出来"是不够的。

**6. 打包弹窗的输入框点不进（当时以为是原生 `<dialog>` 的兼容性问题）。**
普通 Chromium 里一切正常，但用户的嵌入预览环境里 `<dialog>` 的输入框点不进、打不了字。
于是放弃 `<dialog>`，改成**普通覆盖层**（`position: fixed` + `z-index` + `.show` class 切换，
Escape / 点遮罩关闭自行实现），又补了一段 `mousedown → focus()` 的兜底和一个焦点自检提示条。

> **归因更正**：后来（见第 7 条）查明根因是 **v86 的鼠标适配器**在整页无条件
> `preventDefault()` 掉 `mousedown`（默认行为里就包含"聚焦 + 落光标"）。
> 打包按钮本来就要先编译出产物才可点，所以这个弹窗**必然**是在"适配器已生效"的状态下
> 被使用的 —— 症状完全吻合，"`<dialog>` 顶层渲染"那条只是当时的猜测。
> 改成普通覆盖层本身仍是好事（各环境行为一致、显隐可控），那段 `mousedown → focus()`
> 兜底于是降级成了可选的保险（零副作用，删掉也不影响普通浏览器），
> 详见 `assets/app.js` 里那段注释。

（另一个坑：入口源文件的自动判断差点把 `src/encode.c` **注释块**里的
`int main(` 例子当成真入口 —— 判断前先把 C 注释剥掉。）

**7. 启动虚拟机之后，页面上的输入框点不进去。** 点「启动编译环境」之前
源码编辑区 / 入口源文件 / 额外参数都能正常选中、正常输入；启动之后
这三个框点不进、选不中（但按钮还能点）。

根因在 v86 的**鼠标适配器**：它的「屏幕区域」取自构造参数 `screen_container`，
而本项目界面上没有 guest 画面、没传这个参数，于是它**回落到 `document.body`** ——
页面上任何一处鼠标事件都被判定成「落在屏幕里」。它的监听挂在 `window` 上，
`mousedown` / `wheel` / `contextmenu` 三个处理里都无条件 `preventDefault()`。
平时它是关的（`enabled` 由总线的 `mouse-enable` 消息打开），而 guest 的
PS/2 鼠标驱动一启用数据上报（Linux 启动时就会发），v86 就把它打开 ——
时间点正好是「点了启动编译环境之后」。之后 `mousedown` 的默认行为
（聚焦 + 落光标 + 起选区）被取消，输入框自然点不进去；而 `click` 是独立事件，
所以按钮照常能用 —— 这也解释了症状为什么只出现在文本输入上。

修法：创建 `V86` 时显式传 `disable_mouse: true` + `disable_keyboard: true`
（本项目只用串口，既没有 guest 画面也从不往 guest 注入按键）。
顺带把上面那个「滚轮没反应」也一并解决了 —— 那个 `wheel` 处理器本来就会
`preventDefault` 掉页面的滚轮。
回归测试见 `tools/test-v86-mouse.mjs`（静态守卫 + 在 Node 里真的各造一个 V86
对比适配器有没有被创建），`tools/test-v86.mjs` 启动后也会断言一次。
将来若要显示 guest 画面，改成传 `screen_container` 并去掉这两项即可。

### 工程缺口的解决方式：`src/mrp_compat.c`

内置模板一开始**编译不过**，报 9 个未定义符号。它们全都是 `mrp_demo/` 工程自身的问题，
**不是工具链问题**：

| 符号 | 出现位置 | 根因 |
|---|---|---|
| `memset`、`memmove`×2、`strlen` | `display_object.c`、`mrc_win.c`、`mrc_sound.c` | GCC 一开优化（`-O2` / `-O3`）就把**手写循环**识别成标准库调用后直接发调用指令（`-ftree-loop-distribute-patterns`）。手里写 `while(*p++) len++;` 也会被换成 `strlen` |
| `sqrt`×3、`atan2` | `bitmap.c` | 直接 `#include <math.h>`，而 `-nostdlib` 不链接 libm |
| `abs` | `mrc_base.c`（`mrc_drawLine`） | 同上的内联决策问题（见下） |
| `mrc_getSysMem`、`mrc_getMemoryRemain` | `mrc_ram.c` | 全工程**只有声明、没有实现**（这两个符号历来由厂商的预编译库提供，gcc 这套没有） |
| `mrc_readFileFromAssets` | `mrc_graphics.c` | 唯一实现在 `src/mrc_android.c`，而 Makefile 原先把它 `filter-out` 了 |

对应的两处修改：

1. **新增 `mrp_demo/src/mrp_compat.c`**，补齐这些符号：
   - `memset` / `memmove` / `strlen` —— 纯字节循环。注意**结构体拷贝与清零是 ABI 约定**，
     编译器无论如何都会发调用，所以这些实现无法省略，只能自己提供。
   - `abs` / `labs` —— 绝大多数情况下 `abs()` 被内联成 `cmp`/`rsb` 不发调用，
     但链接结果不该依赖编译器的内联决策，补一份让行为确定。
   - `sqrt` —— 牛顿迭代，初值用「指数减半、尾数保留」的位技巧（误差 <10%），6 次迭代收敛。
   - `atan2` —— 经典三次多项式近似（误差约 0.01 rad），对旋转/扇形/阴影绘制足够。
   - `mrc_getSysMem` / `mrc_getMemoryRemain` —— 按 mythroad 语义读 `mr_table` 的
     `LG_mem_len`（VM 内存总量）与 `LG_mem_left`（剩余内存），这两个是「指向值的指针」字段。
2. **`Makefile`**：
   - 去掉 `filter-out src/mrc_android.c` —— 该文件虽然叫 android，
     但 `#ifdef C_RUN` 之外的分支才是真机路径，而 `mrc_readFileFromAssets()` 全工程只有它实现。
   - `CODEFLAGS` 加上 **`-fno-tree-loop-distribute-patterns`**，关掉「循环 → 库调用」那个 pass。
     换用 `-fno-builtin` 也能达到目的，但它会让 `abs()` 之类原本内联的函数统统退化成真实调用，
     进而引入新的未定义符号；这个开关更精准，不影响其他内联与折叠优化。
   - **特意没有加 `-ffreestanding`**：它会把 `__STDC_HOSTED__` 置 0，有让 newlib `<math.h>`
     不再声明 `sqrt`/`atan2` 的风险 —— 那样这两个调用会变成隐式声明、返回类型被当成 `int`，
     codegen 静默出错（比链接报错危险得多）。

全部实现都是纯算术，不引入外部依赖，**产物重定位依然只有 `R_ARM_RELATIVE`**。

> 新增了直接用到的 C 库函数时，记得在 `mrp_compat.c` 里补上实现 ——
> 缺了会在链接期报 `undefined reference`，不会静默生成坏产物。

> ⚠️ 不要用 `-Wl,--unresolved-symbols=ignore-all` 糊过去：那样能生成文件，
> 但产物里那些调用是空的，上机必然出问题。只适合用来单独验证工具链。

---

## 已知问题

- `tools/make-image.py` 重新解包时若删不掉旧 `rootfs`，会改名为 `.build/rootfs.stale-*`，可手动清理
- 语言标准：工程要求 C99，且变量必须在块首声明（见 `mrp_demo/README.md`）
- 虚拟机内存固定 384MB，v86 会一次性分配
- **编译耗时**：走引擎归档时 **约 8 秒**（编译本身 3.1s；`tools/test-v86.mjs` 的完整
  链路含启动虚拟机 8s + 装工具链 21.7s 共约 33s）。改动 `src/` 之后那一次会重建归档，
  ≈190s，之后恢复。详见「编译速度：引擎只编一次」
- **改过 `mrp_demo/src/` 下任何 `.c` 或 `.h` 之后要重跑 `node tools/make-engine-lib.mjs`**，
  并把 `mrp_demo/lib/libmrp_engine.a` 与 `mrp_demo/lib/libmrp_engine.key` 一起提交 ——
  否则站点上还是旧引擎（虚拟机里靠摘要校验能自己发现并重建，只是每个新会话都要多花一次 190s）
- **串口是逐字节收发的**（`libv86.js` 的 `serial0_send` 用 `charCodeAt`、输出用
  `String.fromCharCode`），所以 guest 里输出的非 ASCII 到前端日志必然是乱码：
  Makefile 里的提示一律写 ASCII；要写中文提示就走 `assets/app.js` 的 `writeLine()`。
  同一个原因，`listProjectFiles()` 拿到含中文的文件名也会乱码（尚未修）
- **`libnewlib-arm-none-eabi`（360MB 的 newlib 多版本库）没有装**，因为工程用 `-nostdlib`。
  如果需要链接 newlib 的 libc/libm，要把它加进 `TARGET_PACKAGES`，镜像会明显变大。
- **`.mrp` 打包已完成**（浏览器 + 命令行两条路径，逐字节互相验证过）；
  剩下的只是把它装到真机上验证 —— 那一步需要 FlashTool 刷入真机（刷机步骤不在本仓库范围内）
- 打包时**授权串 authStr 默认填的是 `ea50027c8`**（这个默认值来自两份真机可跑的真实产物）。
  如果换台机器/换套 Mrpbuilder，这个值可能要跟着改（对话框「高级选项」里可改）
- `flag` 默认 7（可见 + CPU 3 + start 启动），与真实样本一致；`plat` 固定 1（MTK）
- 工程里有一批 `-Wunused-*` / `-Wpointer-sign` 警告（`uc3_mfont.c`、`xl_coding.c`、`bitmap.c` 等），
  不影响产物，但日志会比较长

---

## 许可

**本仓库整体按 GPL-3.0 发布**（见 `LICENSE`）。选它的原因：`mrp_demo/` 的运行时源码
来自 `fengdeyingzi/mrpbuilder`（GPL-3.0），工具链镜像里又包含 Debian 的 GPL 组件
（gcc / binutils / busybox / make）——GPL-3.0 是唯一能同时覆盖这些内容的选项，
MIT/Apache 都与之冲突。

- `assets/v86/` —— v86，BSD-2-Clause，见 `assets/v86/LICENSE-v86.txt`（与 GPL 兼容，按其原许可随仓库分发）
- `mrp_demo/` —— 来自 `fengdeyingzi/mrpbuilder`，GPL-3.0
- 工具链镜像内含 Debian 的 `gcc-arm-none-eabi`（GPL）、`binutils`（GPL）、
  `busybox`（GPL-2.0）、`make`（GPL-3.0）以及 glibc（LGPL），分发镜像需一并遵守其许可
