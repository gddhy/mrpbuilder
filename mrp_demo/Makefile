# MRP 构建 —— 与社区 gcc 方案（ssx01/mrpbuilder）保持一致的工具链与 flags
#
# 关键点：MRP 壳里的 ELF 加载器只支持 RELATIVE 重定位，
# 因此必须用 -nostdlib -nostartfiles 避免链接进 libc / 软浮点库
# （它们是 GOT 的来源，会产生加载器无法处理的 GLOB_DAT / JUMP_SLOT）。

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
OPT      := -O2
WARN     := -Wall -Wno-implicit-function-declaration -Wno-implicit-int -Wno-builtin-declaration-mismatch

# -fno-tree-loop-distribute-patterns：
#   -O2 起 GCC 会把「手写循环」识别成标准库调用后直接发调用指令
#   （while(*p++) len++;  ->  strlen，for(...) a[j]=a[j+1];  ->  memmove，
#    数组填充/清零 -> memset）。关掉这个 pass 后循环保持原样。
#   注意：结构体拷贝与清零是 ABI 约定，即使关掉这个 pass 编译器照样会发
#   memcpy/memset 调用，所以 mrp_compat.c 里的实现仍然必须存在。
#   这里特意不用 -ffreestanding：它会把 __STDC_HOSTED__ 置 0，
#   有让 newlib <math.h> 不再声明 sqrt/atan2 的风险（那样会被当成隐式声明、
#   返回类型错成 int，codegen 静默出错），比链接报错危险得多。
CODEFLAGS := -marm -march=armv5te -fPIC -fno-tree-loop-distribute-patterns
LDFLAGS   := -nostdlib -nostartfiles -pie -Wl,--entry=_start

# ARM7TDMI 没有 FPU，浮点运算会生成对软浮点辅助函数的调用
# （__aeabi_fadd / __aeabi_fdiv / __aeabi_fcmplt …），这些由 libgcc.a 提供。
# -nostdlib 会把 libgcc 也一起禁掉，所以必须显式把这个 .a 传进去，
# 否则链接期报一堆 "undefined reference to `__aeabi_*'"。
LIBGCC := $(shell $(CC) $(CODEFLAGS) -print-libgcc-file-name)

.PHONY: all clean size check

all: $(TARGET)

$(TARGET): $(APP) $(SRCS)
	$(CC) -o $@ $(APP) $(SRCS) $(INCLUDES) $(OPT) $(WARN) $(CODEFLAGS) $(LDFLAGS) $(LIBGCC) $(EXTRA)

# 校验产物：确认只有 RELATIVE 重定位，否则 MRP 加载器会拒绝加载
check: $(TARGET)
	@echo "--- 动态重定位检查 ---"
	@arm-none-eabi-readelf -d $(TARGET) | grep -E "NEEDED|REL|JMPREL|FLAGS" || true
	@arm-none-eabi-readelf -r $(TARGET) | head -20 || true

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
