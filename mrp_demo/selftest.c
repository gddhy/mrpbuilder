/* 工具链自检程序
 *
 * 不依赖任何 MRP 运行时接口，只用来验证 arm-none-eabi-gcc 能产出
 * MRP 加载器认可的静态 PIE：ET_DYN、无 DT_NEEDED、.rel.dyn 只有 R_ARM_RELATIVE。
 *
 *   make selftest
 *   python tools/check-elf.py selftest.elf
 *
 * 之所以要单独做这件事：完整工程会引用 mrc_readFileFromMrp / mrc_getSysMem 之类
 * 运行时接口，链接期必然有未定义符号；用 --unresolved-symbols=ignore-all 糊过去
 * 会让产物不可信。这个文件把所有符号都解析干净，用来单独验证工具链本身。
 */

typedef int int32;
typedef unsigned int uint32;

/* ARM 没有浮点单元，这里故意用一点浮点运算，
 * 顺便验证 libgcc 的软浮点辅助函数（__aeabi_f*）能被正常链接进来。 */
static float scale(float v, int32 k)
{
    return v * (float)k + 1.5f;
}

int32 _start(void *in)
{
    volatile int32 acc = 0;
    volatile float f = 0.0f;
    int32 i;

    (void)in;

    for (i = 0; i < 100; i++) {
        acc += i;
    }
    f = scale((float)acc, 2);

    return acc + (int32)f;
}
