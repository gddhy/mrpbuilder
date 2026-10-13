# MRP 构建 —— 与社区 gcc 方案（ssx01/mrpbuilder）保持一致的工具链与 flags
#
# 【真机兼容】两条硬约束，缺一不可：
#
#   1) 重定位只能有 RELATIVE。
#      MRP 壳里的 ELF 加载器只认 RELATIVE，所以必须用 -nostdlib -nostartfiles
#      避免链接进 libc / 软浮点库 —— 它们是 GOT 的来源，会带出加载器无法处理的
#      GLOB_DAT / JUMP_SLOT。
#
#   2) r9 / r10 必须让给壳（-ffixed-r9 -ffixed-r10）。
#      MRP 壳是按 APCS 编译的，r9(sb) 被它当静态基址、r10(sl) 被它当栈限；
#      而 GCC 在 -fPIC 下默认也会拿 r9 当 GOT/静态基址、拿 r10 当栈限，
#      两边抢同一个寄存器 —— 结果是：
#        · 安卓模拟器里碰巧没踩到（壳的栈限/基址那一路没被触发），能正常跑；
#        · MTK 真机（MT6225/6235/6250）上一进启动页就死住。
#      -ffixed-r9 -ffixed-r10 让编译器彻底不碰这两个寄存器，与壳安全共存。
#
# 下面这份 flags 与 TinalIDE（Mrp项目-TinalIDE）里跑通真机的 Makefile 对齐。

CC      := arm-none-eabi-gcc
TARGET  ?= bin.elf
APP     ?= helloworld.c
EXTRA   ?=

# src/ 是 mythroad 运行时的实现，全部参与编译。
# 注意 mrc_android.c 虽然叫 android，但 #ifdef C_RUN 之外的那个分支才是真机路径，
# 而 mrc_readFileFromAssets() 全工程只有它实现（mrc_graphics.c 依赖它），
# 所以不能排除，否则链接期报 undefined reference to `mrc_readFileFromAssets'。
#
# 除 src/ 外，工程还可能有别的源码目录（例：dsm_gm 的 info/，原作者 build.bat
# 里就是 `main.c info/ src/`，mrpinfo.h/mrpinfo.c 都在 info/ 下）——
# 这里自动发现所有含 .c 的子目录一起编译；含 .h 的目录（可能与 .c 同目录，
# 也可能独立存放，比如 include/）一律加入头文件搜索路径；
# 资源/壳/产物目录排除。
EXCLUDE_DIRS := lib/ assets/ temp/ build/ build_output/ out/
SRC_DIRS := $(sort $(filter-out $(EXCLUDE_DIRS),$(dir $(wildcard */*.c))))
INC_DIRS := $(sort $(SRC_DIRS) $(filter-out $(EXCLUDE_DIRS),$(dir $(wildcard */*.h))))
SRCS     := $(foreach d,$(SRC_DIRS),$(wildcard $(d)*.c))

INCLUDES := $(foreach d,$(INC_DIRS),-I$(patsubst %/,%,$(d)))

# -Os（原来是 -O2）：尺寸优先。单核 ARM7TDMI + 几 MB 内存的老机，体积比速度值钱。
# 想临时只验证语法可以填 EXTRA='-O0'，编起来快很多。
OPT      := -Os
WARN     := -Wall -Wno-implicit-function-declaration -Wno-implicit-int -Wno-builtin-declaration-mismatch

# 逐条说明（都是真机跑通的那一套）：
#
# -marm -march=armv5te -mfloat-abi=soft
#   ARM7TDMI 只有 ARM 态、没有 FPU，显式写死不靠工具链猜。
#
# -ffixed-r9 -ffixed-r10
#   见文件头第 2 条 —— 这是「模拟器能跑、真机卡启动页」的根因修复。
#
# -ffunction-sections -fdata-sections（配合链接期的 -Wl,--gc-sections）
#   每个函数/变量独立成 section，没被 _start 引用到的整段丢掉。
#
# -fno-common
#   未初始化的全局变量各自独立进 .bss，不再合并成 COMMON 块：
#   一是避免和壳里的同名符号互相覆盖，二是 gc-sections 才能按段回收。
#
# -fshort-enums
#   枚举按最小宽度存（能 1 字节就不占 4 字节），让 mr_table 那类大结构体明显变小。
#
# -g0
#   不生成调试信息（反正后面也要 strip）。
#
# -fno-tree-loop-distribute-patterns
#   优化一开（GCC 9 要 -O3，GCC 12 起 -O2 就会）GCC 会把「手写循环」
#   识别成标准库调用后直接发调用指令
#   （while(*p++) len++;  ->  strlen，for(...) a[j]=a[j+1];  ->  memmove，
#    数组填充/清零 -> memset）。关掉这个 pass 后循环保持原样。
#   注意：结构体拷贝与清零是 ABI 约定，即使关掉这个 pass 编译器照样会发
#   memcpy/memset 调用，所以 mrp_compat.c 里的实现仍然必须存在。
#   这里特意不用 -ffreestanding：它会把 __STDC_HOSTED__ 置 0，
#   有让 newlib <math.h> 不再声明 sqrt/atan2 的风险（那样会被当成隐式声明、
#   返回类型错成 int，codegen 静默出错），比链接报错危险得多。
CODEFLAGS := -marm -march=armv5te -mfloat-abi=soft -fPIC -g0 \
             -ffixed-r9 -ffixed-r10 \
             -ffunction-sections -fdata-sections \
             -fno-common -fshort-enums \
             -fno-tree-loop-distribute-patterns

# -Wl,--gc-sections  → 丢掉没被 _start 引用到的 section（配合上面的 -f*-sections）
#                     这一个是真正减体积的那一个：demo 从 ~259KB 降到 ~15KB。
# -Wl,--strip-all    → 交给链接器去符号表。
# -Wl,--strip-debug  → 去掉调试段（其实 -g0 已经不产调试信息了）。
#                     实测 GNU ld 的这两个开关对本工程是空操作：加与不加产物字节数完全一样，
#                     符号表(.symtab)仍在。这里保留是为了跟 TinalIDE 的写法一致（也无副作用）。
#                     —— 顺带说明：真机跑通的那份 TinalIDE 产物同样带着 .symtab，
#                     所以壳是不看符号表的（cfunction.ext 里没有任何符号名字符串，
#                     .dynsym 里也只有一个空条目，入口取自 ELF 头 e_entry），别再多加一步
#                     `strip --strip-all` 去省那几 KB —— 少一个变量，少一个真机上的不确定性。
# -Wl,--entry=_start → 入口是 src/mrc_base.c 里的 outFuncs_st *_start(inFuncs_st *in)，
#                      它把 mrc_init/mrc_event/... 注册进返回给壳的函数表，
#                      gc-sections 从它出发就能保住所有真正要用的代码。
# -ffixed-r9 -ffixed-r10 在链接期再写一遍：与 TinalIDE 的写法保持一致（无副作用）。
LDFLAGS := -nostdlib -nostartfiles -pie -Wl,--entry=_start \
           -Wl,--gc-sections -Wl,--strip-all -Wl,--strip-debug \
           -ffixed-r9 -ffixed-r10

# 这里【故意不加】--specs=nano.specs -lc -lm：
#   · -nostdlib 已经保证不链 libc；一旦链进去就会带出 GOT / GLOB_DAT，壳直接拒绝加载；
#   · 镜像里也没装 libnewlib-arm-none-eabi（360MB 的多版本库），-lc 会直接 cannot find -lc；
#   · 工程用到的 memset / memmove / strlen / sqrt / atan2 / abs 由 src/mrp_compat.c 自己实现。
# 如果哪天真要切到 newlib 那套：先装 libnewlib-arm-none-eabi，再
#     LIBS_EXTRA := --specs=nano.specs -lc -lm
# 并把 $(LIBS_EXTRA) 追加到下面的链接命令行末尾，然后务必跑一遍 `make check`。

# ARM7TDMI 没有 FPU，浮点运算会生成对软浮点辅助函数的调用
# （__aeabi_fadd / __aeabi_fdiv / __aeabi_fcmplt …），这些由 libgcc.a 提供。
# -nostdlib 会把 libgcc 也一起禁掉，所以必须显式把这个 .a 传进去，
# 否则链接期报一堆 "undefined reference to `__aeabi_*'"。
LIBGCC := $(shell $(CC) $(CODEFLAGS) -print-libgcc-file-name)

# ---------------------------------------------------------------------------
# 引擎预编译归档（编译提速的唯一关键项）
# ---------------------------------------------------------------------------
# 为什么：src/ 下 19 个 .c 是 mythroad 运行时（1.2MB），每个工程都用同一份，
#   而且它们每次构建都被原样重编一遍。在 v86 里这一步实测 **206.3 秒**，
#   占整条编译链路（227.7s）的 91%。把运行时预先编成静态库之后，一次构建
#   只剩「编你自己的代码 + 链接」= **3.1 秒**（实测 66×），产物逐字节完全
#   一致（同 sha256、31 条 R_ARM_RELATIVE，check-elf 通过）。
#   这也说明：这类工程绝大部分编译时间都在重复编同一份运行时，把引擎预先编成库
#   就能全部省掉。
#
# 过期判定：用「内容摘要」，不用时间戳
#   实测 guest 的 rootfs 里**有 sha256sum**（/usr/bin/sha256sum，buildroot 的
#   busybox 带的；/opt/tc 里 Debian 那份也有），所以这里按内容判定：
#
#     key = sha256( sha256sum src/*.c src/*.h  +  OPT + CODEFLAGS )
#
#   先逐文件算一遍（把「文件名 + 长度 + 内容」都算进去，没有文件边界歧义），
#   再对这张清单取一次摘要，同时把编译参数也盖进去。
#   key 与 lib/libmrp_engine.key 不一致 → 重建归档。好处：
#     · 改 src/ 下任何 **.c 或 .h** 都会重建 —— 兼容层/适配层（mrp_compat.c、
#       mrc_android.c、bridge.h、ex_math.h、mpc.h …）都在 src/ 下，一个都漏不掉；
#     · 「归档和源码对不上」也能查出来（换了镜像忘了重生成归档、站点上的归档
#       是旧版…），不靠「谁的时间戳更新」这种弱证据；
#     · 内容改回原样 → 摘要又一致 → 自动复用，不会白重建一次。
#   sha256sum 万一不存在（换镜像被裁掉了）→ 自动退回时间戳规则，功能不受影响。
#
# 归档放哪里：lib/libmrp_engine.a（+ 摘要 lib/libmrp_engine.key）。lib/ 本来
#   就在 EXCLUDE_DIRS 里，不会被当源码目录扫到；打包 .mrp 时
#   isResourceCandidate() 也会跳过 lib/，不会被误当成资源塞进包。
#   生成/更新：node tools/make-engine-lib.mjs
#
# ⚠ 下面几条 echo 只能写 ASCII：串口是逐字节收发 + 逐字节 String.fromCharCode
#   解码（libv86.js 的 serial0_send / serial0-output-byte），guest 里输出的
#   非 ASCII 到前端日志里必然是乱码。日志其余部分都是编译器自己的英文输出，
#   这里保持 ASCII 才一致。要写中文提示就走 assets/app.js 的 writeLine()。
ENGINE_DIR  := src
ENGINE_A    := lib/libmrp_engine.a
ENGINE_KEYF := lib/libmrp_engine.key
ENGINE_SRCS := $(wildcard $(ENGINE_DIR)/*.c)
# 引擎的头文件：src/ 下的 + 其它被 -I 搜到的目录（用户自己的 include/ 之类）
ENGINE_HDRS := $(foreach d,$(INC_DIRS),$(wildcard $(d)*.h))
ENGINE_INPUTS := $(ENGINE_SRCS) $(ENGINE_HDRS)
# src/ 之外的源码目录（用户自己的 info/ 之类）照旧每次都参与编译
USER_DIRS   := $(filter-out $(ENGINE_DIR)/,$(SRC_DIRS))
USER_SRCS   := $(foreach d,$(USER_DIRS),$(wildcard $(d)*.c))
# arm-none-eabi-gcc -> arm-none-eabi-ar
AR          := $(subst gcc,ar,$(CC))

# 摘要命令：逐文件 sha256 + 编译参数，再整体取一次 sha256
ENGINE_HAS_SHA := $(shell command -v sha256sum >/dev/null 2>&1 && echo yes)
ENGINE_KEY_CMD  = { sha256sum $(ENGINE_INPUTS) 2>/dev/null; echo '$(OPT) $(CODEFLAGS)'; } | sha256sum

ifeq ($(ENGINE_HAS_SHA),yes)
  ENGINE_KEY_NOW   := $(shell $(ENGINE_KEY_CMD))
  ENGINE_KEY_SAVED := $(shell cat $(ENGINE_KEYF) 2>/dev/null)
  ifeq ($(ENGINE_KEY_NOW),$(ENGINE_KEY_SAVED))
    # 摘要一致 → 归档与源码、参数都对得上，直接用（不看任何时间戳）
    ENGINE_A_PREREQ :=
  else
    # 不一致（含归档 / 摘要文件缺失）→ 强制重建
    ENGINE_A_PREREQ := force
  endif
else
  # 没有 sha256sum：退回时间戳规则（.c 与 .h 都当依赖）
  ENGINE_A_PREREQ := $(ENGINE_INPUTS)
endif

ifeq ($(strip $(ENGINE_SRCS)),)
  # 工程里没有 src/（不是 mythroad 运行时那套）→ 保持原来的全量编译
  BUILD_SRCS := $(SRCS)
  BUILD_LIBS :=
else
  BUILD_SRCS := $(USER_SRCS)
  BUILD_LIBS := $(ENGINE_A)
endif

.PHONY: all clean size check selftest engine-archive force

# 默认目标显式钉死：下面那个空目标 `force: ;` 如果排在 all 前面，
# make 会把 force 当成默认目标 —— 裸跑 `make` 就什么都不做（还返回 0），
# 前端会看到「编译成功但产物写不回来」这种莫名其妙的错。
.DEFAULT_GOAL := all

all: $(TARGET)

$(TARGET): $(APP) $(BUILD_SRCS) $(BUILD_LIBS)
	$(CC) -o $@ $(APP) $(BUILD_SRCS) $(INCLUDES) $(OPT) $(WARN) $(CODEFLAGS) $(LDFLAGS) $(BUILD_LIBS) $(LIBGCC) $(EXTRA)

# 只给「摘要对不上时强制重建归档」用的空目标（必须放在 all 之后）
force: ;

# 显式目标：给 tools/make-engine-lib.mjs 用（也是「引擎源码改了、想立刻重建」的手工入口）
engine-archive: $(ENGINE_A)

# 摘要对不上（或归档缺失）才重建
$(ENGINE_A): $(ENGINE_A_PREREQ)
	@mkdir -p $(dir $@) .engine-obj
	@echo "  [make] precompiling engine runtime: $(words $(ENGINE_SRCS)) sources -> $@ (one-off, ~3 min)"
	@for f in $(ENGINE_SRCS); do \
	   o=.engine-obj/$${f#$(ENGINE_DIR)/}; o=$${o%.c}.o; \
	   $(CC) -c "$$f" $(INCLUDES) $(OPT) $(WARN) $(CODEFLAGS) -o "$$o" || exit 1; \
	 done
	$(AR) rcs $@ .engine-obj/*.o
	@echo "  [make] engine archive ready: $$(wc -c < $@) bytes, $(words $(ENGINE_SRCS)) members"
	@rm -rf .engine-obj
ifeq ($(ENGINE_HAS_SHA),yes)
	@$(ENGINE_KEY_CMD) > $(ENGINE_KEYF)
	@echo "  [make] engine key recorded: $(ENGINE_KEYF)"
endif

# 校验产物：确认只有 RELATIVE 重定位（否则 MRP 加载器会拒绝加载），
# 并确认 r9/r10 确实没被占用（否则真机可能卡在启动页）。
check: $(TARGET)
	@echo "--- 动态重定位检查 ---"
	@arm-none-eabi-readelf -d $(TARGET) | grep -E "NEEDED|REL|JMPREL|FLAGS" || true
	@arm-none-eabi-readelf -r $(TARGET) | head -20 || true
	@echo "--- r9/r10 占用检查（期望 0）---"
	@n=$$(arm-none-eabi-objdump -d $(TARGET) | grep -cE '[^a-z0-9_]r(9|10)[^0-9]' || true); \
	echo "  指令里出现 r9/r10 的行数：$$n"; \
	if [ "$$n" = "0" ]; then echo "  ✓ 未使用 r9/r10，与 APCS 壳安全共存"; \
	else echo "  ✗ 仍有 r9/r10 被占用，检查 -ffixed-r9 -ffixed-r10 是否生效"; fi

size: $(TARGET)
	@arm-none-eabi-size $(TARGET)

# 工具链自检：只编译 selftest.c，所有符号都解析干净，
# 用来单独验证编译器/链接器/flags 能产出合格的静态 PIE
.PHONY: selftest
selftest:
	$(CC) -o selftest.elf selftest.c $(OPT) $(CODEFLAGS) $(LDFLAGS) $(LIBGCC)
	@echo "--- selftest.elf 已生成 ---"
	@arm-none-eabi-readelf -d selftest.elf | grep -E "NEEDED|REL|JMPREL" || true

clean:
	rm -f $(TARGET) selftest.elf *.o
	rm -rf .engine-obj
# 注意：clean 故意不删 lib/libmrp_engine.a —— 它是随工程下发的预编译产物，
# 不是构建中间件（删了下次编译要多花约 190s 重建）。想强制重建就
# `rm -f lib/libmrp_engine.a && make`。
