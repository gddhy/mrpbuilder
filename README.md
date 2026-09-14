# mrpbuilder —— MRP 纯前端编译环境

在浏览器里用 **arm-none-eabi-gcc** 编译功能机（MT6225 / 6235 / 6250 / 6276 等）的 MRP 程序，
产出 `bin.elf`。**不需要后端、不需要装任何本地工具**，任何有浏览器的设备打开就能用。

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

---

## 目录结构

```
index.html                  主页面
assets/
  app.js                    界面逻辑
  vm.js                     MrpVm —— 虚拟机驱动（浏览器 / Node 共用，无 DOM 依赖）
  mrp-pack.js               MRP 容器打包器（浏览器 / Node 共用，无依赖，含 GBK 编解码）
  bytes.js                  gzip / tar 格式判定与压缩（打包器和镜像安装共用）
  style.css
  v86/                      v86 运行时（本地化，BSD-2-Clause）
    libv86.js  v86.wasm  v86-fallback.wasm
    bios/seabios.bin  bios/vgabios.bin
  image/                    虚拟机镜像（由 tools/make-image.py 生成）
    vmlinuz.bin             内核（10 MiB）
    rootfs.tar.gz           工具链（31 MiB 压缩 / 101 MiB 解开）
    rootfs.tar.gz.part*     按 20 MiB 切的分段（Cloudflare Pages / EdgeOne 的 25MB 限制）
    rootfs.parts.json       分段清单（大小 + sha256，浏览器按它拼合校验）
    image.json              构建元信息（含 sha256，可用于校验）
mrp_demo/                   MRP 工程模板
  Makefile                 按社区方案编写
  helloworld.c  src/*.c  src/*.h  lib/  assets/
mrp_demo.zip                上面这份模板的 zip（页面「下载demo」按钮直接下载）
tools/
  make-image.py             组装工具链镜像（纯 Python，不需要 Docker / Linux / root）
  check-elf.py              校验产物是否满足 MRP 加载器要求
  pack-demo.mjs             命令行打包器：把 mrp_demo 打成 .mrp（不需要浏览器）
  dev-server.mjs            本地静态服务器（--gzip-static 可复现镜像被解压的问题）
  test-v86.mjs              在 Node 里跑通整条链路，无浏览器也能验证
  test-zip.mjs              验证 zip 读取/生成（含 Windows 反斜杠条目名归一化）
  test-pack.mjs             用两个真实 mrp 样本逐字节验证打包器
  test-bytes.mjs            验证 gzip/tar 格式判定
  test-vm-queue.mjs         验证虚拟机命令串行化
  test-forward.mjs          验证串口日志的哨兵过滤
  test-errors.mjs           验证「复制错误」的报错行提取
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
2. 左侧选模板文件编辑，或拖入自己的 `.c` / `.h`；**也可以直接拖一个 zip 源码包**，
   会解开铺进工程并自动判断入口源文件（优先 `main.c`，其次扫描含真实 `main(`
   定义的 `.c` —— 会先剥掉注释再判断，避免把注释里的示例代码当入口；
   都没有则保持默认 `helloworld.c`）
3. 点「编译」（或 <kbd>Ctrl/Cmd</kbd>+<kbd>Enter</kbd>）
4. 点「打包 .mrp」填好信息 → 生成并下载；也可以只点「下载 bin.elf」拿裸产物
5. 「下载demo」按钮直接下载 `mrp_demo.zip`（完整工程模板，可改完再拖回来）

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
node tools/test-vm-queue.mjs    # 虚拟机命令串行化
node tools/test-forward.mjs     # 串口日志哨兵过滤
node tools/test-errors.mjs      # 报错行提取
python tools/check-elf.py .build/bin.elf   # 产物重定位校验
```

---

## MRP 编译的硬约束

### 加载器只认 RELATIVE 重定位

MRP 壳里的 ELF 加载器（`loader/elfloader.c` 的 `el_applyrel`）**只处理 `RELATIVE` 一种重定位**，
其余类型一律返回 `EL_BADREL`，并且不加载 `DT_NEEDED`、不处理 `DT_JMPREL`。

这就是社区反复提到的「GOT 表问题」：如果链接进 C 库或软浮点库，就会带出
`GLOB_DAT` / `JUMP_SLOT` 重定位，加载器直接拒绝。

所以编译参数必须是这样：

```makefile
arm-none-eabi-gcc -o bin.elf <sources> \
    -marm -march=armv5te -fPIC \
    -nostdlib -nostartfiles -pie -Wl,--entry=_start
```

`-nostdlib -nostartfiles` 是关键：不链接任何库，符号全部内部解析，
动态重定位就只剩 `R_ARM_RELATIVE`。

`tools/check-elf.py` 专门检查这件事，编译后建议跑一次。

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
（`game2048.mrp`、`WasteLand_240.mrp`）。

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
| 编译完整工程（`helloworld.c` + `src/` 下 19 个 .c，约 1.3MB 源码） | ✅ 全部编译通过，仅 warning |
| 软浮点（`__aeabi_*`）链接 | ✅ 正确链入 libgcc |
| 产物格式 | ✅ ARM 静态 PIE（ET_DYN），无 `DT_NEEDED` |
| 动态重定位 | ✅ **89 条全部是 `R_ARM_RELATIVE`** |
| 9p 取回产物 | ✅ 266,576 字节（`-O2` 完整构建，`tools/check-elf.py` 判定通过） |

自检产物（`make selftest`，符号全部解析干净）经 `check-elf.py` 判定为 **0 条动态重定位**，
完全满足 MRP 加载器要求 —— 说明编译器 / 链接器 / flags 这条链是可靠的。

**真实浏览器里也跑通了**（用 `agent-browser` 驱动 Chromium 走完整流程）：

| 环节 | 结果 |
|---|---|
| 页面启动虚拟机 + 装工具链 | ✅ 点「启动编译环境」后约 **20 秒**到「环境就绪」 |
| 读到内置模板 | ✅ 50 个文件（含 `src/mrp_compat.c`） |
| 点「编译」跑完整 `-O2` 构建 | ✅ **编译成功**，与 Node 侧结果一致（**266,576 字节**） |
| 「下载 bin.elf」 | ✅ 按钮变为可用 |
| 输出框文本选择 | ✅ `user-select: text`（`Ctrl/Cmd+A` 可全选） |
| 「复制错误」/「复制日志」 | ✅ 前者只留报错行 + `in function` 上下文，过滤 warning 与普通输出 |
| **「打包 .mrp」真实鼠标点击** | ✅ 对话框打开 → 填表 → 生成并下载，产物 **216,777 字节**，页面自检通过 |
| 只上传 `bin.elf` 不编译就打包 | ✅ 按钮自动可用，日志提示"不必重新编译" |

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
| **两个真实样本逐字节往返**：把 `game2048.mrp` / `WasteLand_240.mrp` 里已 gzip 的数据原样取出，用自己的容器逻辑重新组装 | ✅ 两个都**一个字节都不差** |
| CRC 变体判定 | ✅ 置零版吻合、`mrpinfo.ts` 的跳过版不吻合 |
| **独立解析器交叉验证**：`tools/dev-inspect-mrp.py`（另一套实现）解析自己生成的产物 | ✅ 头 / 列表区 / 偏移 / CRC 全部自洽 |
| **内容往返**：解开 `.mrp` 里的每个文件与源文件比对 | ✅ 5 个文件全部逐字节一致 |
| **浏览器产物 vs 命令行产物**（参数相同） | ✅ **逐字节完全相同**（216,777 字节，指纹一致） |

顺带确认了一件好事：Chrome 的 `CompressionStream` 与 Node 的 zlib
对同一输入的 gzip 输出是字节一致的，所以两条路径可互换。

### 顺手修掉的六个 bug

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

**6. 打包弹窗的输入框点不进（原生 `<dialog>` 的兼容性问题）。**
普通 Chromium 里一切正常，但用户的嵌入预览环境里 `<dialog>` 的顶层渲染
让表单元素收不到鼠标事件。最终放弃 `<dialog>`，改成**普通覆盖层**
（`position: fixed` + `z-index` + `.show` class 切换，Escape / 点遮罩关闭自行实现），
行为在所有环境一致。
（另一个坑：入口源文件的自动判断差点把 `src/encode.c` **注释块**里的
`int main(` 例子当成真入口 —— 判断前先把 C 注释剥掉。）

### 工程缺口的解决方式：`src/mrp_compat.c`

内置模板一开始**编译不过**，报 9 个未定义符号。它们全都是 `mrp_demo/` 工程自身的问题，
**不是工具链问题**：

| 符号 | 出现位置 | 根因 |
|---|---|---|
| `memset`、`memmove`×2、`strlen` | `display_object.c`、`mrc_win.c`、`mrc_sound.c` | GCC 在 `-O2` 下把**手写循环**识别成标准库调用后直接发调用指令（`-ftree-loop-distribute-patterns`）。手里写 `while(*p++) len++;` 也会被换成 `strlen` |
| `sqrt`×3、`atan2` | `bitmap.c` | 直接 `#include <math.h>`，而 `-nostdlib` 不链接 libm |
| `abs` | `mrc_base.c`（`mrc_drawLine`） | 同上的内联决策问题（见下） |
| `mrc_getSysMem`、`mrc_getMemoryRemain` | `mrc_ram.c` | 全工程**只有声明、没有实现**（armcc 时代由厂商 `.lib` 提供） |
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
- 语言标准：工程要求 C99，且变量必须在块首声明（见 `mrp_demo/功能机开发规范.md`）
- 虚拟机内存固定 384MB，v86 会一次性分配
- **编译耗时**：`-O2` 完整构建约 **6~7 分钟**（浏览器与 Node 实测一致，脚本约 400s）；
  临时想快一点可以在「额外参数」里填 `-O0`，大约 1 分钟
- **`libnewlib-arm-none-eabi`（360MB 的 newlib 多版本库）没有装**，因为工程用 `-nostdlib`。
  如果需要链接 newlib 的 libc/libm，要把它加进 `TARGET_PACKAGES`，镜像会明显变大。
- **`.mrp` 打包已完成**（浏览器 + 命令行两条路径，逐字节互相验证过）；
  剩下的只是把它装到真机上验证 —— 那一步需要 FlashTool，仍在 Windows 上做
- 打包时**授权串 authStr 默认填的是 `ea50027c8`**，取自本机两个可运行样本的值。
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
