#!/usr/bin/env python3
"""
校验 arm-none-eabi-gcc 产出的 ELF 是否满足 MRP 壳的加载条件。

MRP 的 elfloader（loader/elfloader.c）只处理一种重定位：
    R_ARM_RELATIVE（arm32）/ R_AARCH64_RELATIVE（aarch64）
其他任何类型都会直接返回 EL_BADREL 导致加载失败。
同时它不处理 DT_NEEDED（不加载依赖库），也不处理 DT_JMPREL。

所以一个可用的 bin.elf 必须满足：
  1. e_type == ET_DYN（静态 PIE），且带 PT_DYNAMIC
  2. 没有 DT_NEEDED
  3. 没有 DT_JMPREL / .rel.plt
  4. .rel.dyn 里只有 R_ARM_RELATIVE

用法：
  python tools/check-elf.py mrp_demo/bin.elf
退出码：0 = 通过，1 = 不通过
"""

import struct
import sys

ET_DYN = 3
EM_ARM = 40
EM_AARCH64 = 183
PT_DYNAMIC = 2
PT_LOAD = 1

DT = {
    1: "NEEDED", 2: "PLTRELSZ", 3: "PLTGOT", 4: "HASH", 5: "STRTAB",
    6: "SYMTAB", 7: "RELA", 8: "RELASZ", 9: "RELAENT", 10: "STRSZ",
    11: "SYMENT", 12: "INIT", 13: "FINI", 14: "SONAME", 15: "RPATH",
    16: "SYMBOLIC", 17: "REL", 18: "RELSZ", 19: "RELENT", 20: "PLTREL",
    21: "DEBUG", 22: "TEXTREL", 23: "JMPREL", 24: "BIND_NOW",
    0x6FFFFFF9: "RELACOUNT", 0x6FFFFFFA: "RELCOUNT", 0x6FFFFFFB: "FLAGS_1",
    0x6FFFFFFE: "VERNEED", 0x6FFFFFFF: "VERNEEDNUM",
}

ARM_RELOC = {
    0: "R_ARM_NONE", 1: "R_ARM_PC24", 2: "R_ARM_ABS32", 3: "R_ARM_REL32",
    4: "R_ARM_LDR_PC_G0", 5: "R_ARM_ABS16", 6: "R_ARM_ABS12", 7: "R_ARM_THM_ABS5",
    8: "R_ARM_ABS8", 9: "R_ARM_SBREL32", 10: "R_ARM_THM_CALL",
    20: "R_ARM_COPY", 21: "R_ARM_GLOB_DAT", 22: "R_ARM_JUMP_SLOT",
    23: "R_ARM_RELATIVE", 24: "R_ARM_GOTOFF32", 25: "R_ARM_BASE_PREL",
    26: "R_ARM_GOT_BREL", 28: "R_ARM_CALL", 29: "R_ARM_JUMP24",
    30: "R_ARM_THM_JUMP24", 31: "R_ARM_BASE_ABS", 38: "R_ARM_TARGET1",
    40: "R_ARM_V4BX", 42: "R_ARM_PREL31", 43: "R_ARM_MOVW_ABS_NC",
    44: "R_ARM_MOVT_ABS", 45: "R_ARM_MOVW_PREL_NC", 46: "R_ARM_MOVT_PREL",
    47: "R_ARM_THM_MOVW_ABS_NC", 48: "R_ARM_THM_MOVT_ABS",
}
AARCH64_RELOC = {
    0: "R_AARCH64_NONE", 257: "R_AARCH64_ABS64", 258: "R_AARCH64_ABS32",
    1024: "R_AARCH64_COPY", 1025: "R_AARCH64_GLOB_DAT",
    1026: "R_AARCH64_JUMP_SLOT", 1027: "R_AARCH64_RELATIVE",
    1028: "R_AARCH64_TLS_DTPMOD64",
}

RELATIVE = {EM_ARM: 23, EM_AARCH64: 1027}


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    path = sys.argv[1]
    data = open(path, "rb").read()

    if data[:4] != b"\x7fELF":
        print(f"✗ {path} 不是 ELF 文件")
        return 1

    ei_class, ei_data = data[4], data[5]
    if ei_class != 1:
        print(f"✗ 期望 32 位 ELF（class=1），实际 class={ei_class}")
        return 1
    if ei_data != 1:
        print("✗ 期望小端序")
        return 1

    (e_type, e_machine, _ver, e_entry, e_phoff, _e_shoff, e_flags,
     _ehsize, e_phentsize, e_phnum, *_rest) = struct.unpack_from("<HHIIIIIHHH", data, 16)

    arch = {EM_ARM: "ARM", EM_AARCH64: "AArch64"}.get(e_machine, f"unknown({e_machine})")
    print(f"文件      : {path}（{len(data)} 字节）")
    print(f"架构      : {arch}   e_machine={e_machine}")
    print(f"类型      : {'ET_DYN（PIE，符合要求）' if e_type == ET_DYN else f'e_type={e_type}  —— 加载器要求 ET_DYN'}")
    print(f"入口      : 0x{e_entry:08x}   e_flags=0x{e_flags:x}")

    if e_machine not in RELATIVE:
        print("✗ 不支持的架构")
        return 1

    # 收集 PT_LOAD 用于 vaddr -> file offset 映射
    loads = []
    dynamic = None
    for i in range(e_phnum):
        off = e_phoff + i * e_phentsize
        p_type, p_offset, p_vaddr, p_paddr, p_filesz, p_memsz, p_flags, _align = \
            struct.unpack_from("<IIIIIIII", data, off)
        if p_type == PT_LOAD:
            loads.append((p_vaddr, p_offset, p_filesz))
        elif p_type == PT_DYNAMIC:
            dynamic = (p_offset, p_filesz)

    def vaddr_to_off(v):
        for vaddr, offset, size in loads:
            if vaddr <= v < vaddr + size:
                return offset + (v - vaddr)
        return None

    if dynamic is None:
        print("✗ 没有 PT_DYNAMIC —— 加载器靠它做重定位，必须有")
        return 1

    dyn_off, dyn_size = dynamic
    tags = {}
    for i in range(dyn_size // 8):
        d_tag, d_val = struct.unpack_from("<iI", data, dyn_off + i * 8)
        if d_tag == 0:
            break
        tags.setdefault(d_tag, d_val)

    print("\n动态段:")
    for tag in sorted(tags):
        print(f"    {DT.get(tag, hex(tag)):<12} = 0x{tags[tag]:x}")

    problems = []

    if e_type != ET_DYN:
        problems.append("e_type 不是 ET_DYN，加载器不会做重定位")

    needed = [t for t in tags if t == 1]
    if needed:
        problems.append("存在 DT_NEEDED（依赖外部库），加载器不会加载依赖")

    # 注意：加载器只遍历 DT_REL（arm32 走 EL_ARCH_USES_REL 分支），
    # 从不读 DT_JMPREL。所以 DT_JMPREL / .rel.plt 存在本身不致命——
    # 致命的是「有需要运行时填的项」（JUMP_SLOT / GLOB_DAT），那会留下未修补的 PLT。
    notes = []
    if 23 in tags:
        notes.append(f"存在 DT_JMPREL（0x{tags[23]:x}）——加载器不读它，只要里面没有 JUMP_SLOT/GLOB_DAT 就无碍")

    # 统计 .rel.dyn / .rel.plt 的重定位类型
    def count_rel(table_vaddr, table_size, entry_size, label):
        if not table_vaddr or not table_size:
            return {}
        off = vaddr_to_off(table_vaddr)
        if off is None:
            problems.append(f"{label} 的虚拟地址 0x{table_vaddr:x} 无法映射到文件偏移")
            return {}
        esz = entry_size or 8
        counts = {}
        for i in range(table_size // esz):
            r_offset, r_info = struct.unpack_from("<II", data, off + i * esz)
            rtype = r_info & 0xFF
            counts[rtype] = counts.get(rtype, 0) + 1
        return counts

    rel_counts = count_rel(tags.get(17), tags.get(18), tags.get(19), "DT_REL")
    plt_counts = count_rel(tags.get(23), tags.get(2), 8, "DT_JMPREL")

    want = RELATIVE[e_machine]
    name_of = ARM_RELOC if e_machine == EM_ARM else AARCH64_RELOC

    print(f"\nDT_REL（.rel.dyn）重定位共 {sum(rel_counts.values())} 条:")
    for t, c in sorted(rel_counts.items()):
        mark = "✓" if t == want else ("o" if t == 0 else "✗")
        print(f"    {mark} {name_of.get(t, f'type={t}'):<22} × {c}")
    if not rel_counts:
        print("    （无）")

    if plt_counts:
        print(f"\nDT_JMPREL（.rel.plt）重定位共 {sum(plt_counts.values())} 条:")
        for t, c in sorted(plt_counts.items()):
            mark = "o" if t == 0 else ("✓" if t == want else "✗")
            print(f"    {mark} {name_of.get(t, f'type={t}'):<22} × {c}")

    bad = {t: c for t, c in rel_counts.items() if t != want and t != 0}
    if bad:
        named = ", ".join(f"{name_of.get(t, t)}×{c}" for t, c in bad.items())
        problems.append(f".rel.dyn 含有非 RELATIVE 重定位：{named}")

    # .rel.plt 里只有 NONE / RELATIVE 是可以接受的（NONE 是空操作，加载器也不看这张表）
    plt_bad = {t: c for t, c in plt_counts.items() if t not in (0, want)}
    if plt_bad:
        named = ", ".join(f"{name_of.get(t, t)}×{c}" for t, c in plt_bad.items())
        problems.append(f".rel.plt 含有需要运行时填充的重定位：{named}（会留下未修补的 PLT）")

    print()
    for n in notes:
        print(f"提示：{n}")

    if problems:
        print("✗ 不满足 MRP 加载器要求：")
        for p in problems:
            print(f"    - {p}")
        print("\n建议：确认编译时带了 -nostdlib -nostartfiles；")
        print("      若仍有 JUMP_SLOT / GLOB_DAT，可尝试加 -Wl,-Bsymbolic 让链接器内部绑定；")
        print("      若有 undefined symbol，说明工程缺少实现，别用 --unresolved-symbols=ignore-all 糊过去。")
        return 1

    total_rel = sum(rel_counts.values())
    print(f"\n✓ 通过：静态 PIE，无依赖库，{total_rel} 条动态重定位全部是 RELATIVE，可被 MRP 加载器加载")
    return 0


if __name__ == "__main__":
    sys.exit(main())
