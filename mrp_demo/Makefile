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

.PHONY: all clean size check selftest

all: $(TARGET)

$(TARGET): $(APP) $(SRCS)
	$(CC) -o $@ $(APP) $(SRCS) $(INCLUDES) $(OPT) $(WARN) $(CODEFLAGS) $(LDFLAGS) $(LIBGCC) $(EXTRA)

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
