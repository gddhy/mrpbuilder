"""
交叉验证 MRP 容器格式：
  1. 按 mrpinfo.ts 的字段表解析样本头
  2. 解析文件列表，确认结构与偏移自洽
  3. 判定 CRC32 到底是哪种变体（跳过 84..87 / 置零 / 直接算）

用法: python tools/dev-inspect-mrp.py <file.mrp>
"""
import struct
import sys
import zlib


def gbk(b):
    i = b.find(b"\x00")
    if i >= 0:
        b = b[:i]
    try:
        return b.decode("gbk")
    except Exception:
        return b.decode("latin-1")


def crc32_variant_skip(data):
    """mrpinfo.ts 的算法：把 84..87 这四个字节从流里「删掉」再算"""
    crc = 0xFFFFFFFF
    for i, byte in enumerate(data):
        if 84 <= i < 88:
            continue
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ (0xEDB88320 if crc & 1 else 0)
    return crc ^ 0xFFFFFFFF


def crc32_variant_zero(data):
    """把 84..87 置零再算（常见做法）"""
    b = bytearray(data)
    b[84:88] = b"\x00\x00\x00\x00"
    return zlib.crc32(bytes(b)) & 0xFFFFFFFF


def crc32_variant_full(data):
    """不跳过任何字节"""
    return zlib.crc32(bytes(data)) & 0xFFFFFFFF


def inspect(path):
    data = open(path, "rb").read()
    print(f"文件   : {path}  ({len(data):,} 字节)")
    magic = data[0:4]
    print(f"magic  : {magic!r}  {'✓' if magic == b'MRPG' else '✗ 不是 MRPG'}")

    file_start, total_len, header_size = struct.unpack_from("<iii", data, 4)
    print(f"\n--- 头（按 mrpinfo.ts 字段表）---")
    print(f"  [4]  fileStart     = {file_start:,}")
    print(f"  [8]  mrpTotalLen   = {total_len:,}   {'✓ 与实际一致' if total_len == len(data) else '✗ 与实际 %d 不符' % len(data)}")
    print(f"  [12] mrpHeaderSize = {header_size}   {'✓' if header_size == 240 else '✗'}")
    print(f"  [16] fileName      = {gbk(data[16:28])!r}")
    print(f"  [28] displayName   = {gbk(data[28:52])!r}")
    print(f"  [52] authStr       = {gbk(data[52:68])!r}")
    appid, version, flag, builder = struct.unpack_from("<iiii", data, 68)
    print(f"  [68] appid         = {appid}")
    print(f"  [72] version       = {version}")
    print(f"  [76] flag          = {flag}")
    print(f"  [80] builderVer    = {builder}")
    stored_crc = struct.unpack_from("<i", data, 84)[0] & 0xFFFFFFFF
    print(f"  [84] crc32         = 0x{stored_crc:08X}")
    print(f"  [88] vendor        = {gbk(data[88:128])!r}")
    print(f"  [128] desc         = {gbk(data[128:192])!r}")
    appid_be = struct.unpack_from(">i", data, 192)[0]
    ver_be = struct.unpack_from(">i", data, 196)[0]
    r2 = struct.unpack_from("<i", data, 200)[0]
    sw, sh = struct.unpack_from("<hh", data, 204)
    print(f"  [192] appidBE      = {appid_be}  {'✓ 与 appid 字节序互换一致' if appid_be == appid else '✗'}")
    print(f"  [196] versionBE    = {ver_be}  {'✓' if ver_be == version else '✗'}")
    print(f"  [200] reserve2     = {r2}")
    print(f"  [204] screenW/H    = {sw} x {sh}")
    print(f"  [208] plat         = {data[208]}")
    print(f"  [209] reserve3     = {data[209:240].hex()}  (31 字节)")

    print(f"\n--- 文件列表 ---")
    list_end = file_start + 8
    off = header_size
    entries = []
    while off < list_end:
        name_len = struct.unpack_from("<i", data, off)[0]
        off += 4
        name = gbk(data[off:off + name_len])
        off += name_len
        f_off, f_len, reserved = struct.unpack_from("<iii", data, off)
        off += 12
        entries.append((name, name_len, f_off, f_len, reserved))
    print(f"  列表区间 = [240, {list_end})，实际解析到 {off}  {'✓ 正好对上' if off == list_end else '✗ 错位 %d' % (off - list_end)}")
    print(f"  条目数   = {len(entries)}")
    for name, nl, fo, fl, rv in entries:
        ok = ""
        if fo + fl > len(data):
            ok = "  ✗ 越界"
        elif fo < header_size + (off - header_size):
            ok = "  ! 偏移落在列表区内"
        print(f"    {name!r:<24} nameLen={nl:<4} offset={fo:<8} len={fl:<8} rsv={rv}{ok}")

    print(f"\n--- 数据区自洽性 ---")
    # 数据区每一段应当是： namelen(4) + name + 0 + len(4) + data
    pos = list_end
    ok_all = True
    for name, nl, fo, fl, rv in entries:
        got_nl = struct.unpack_from("<i", data, pos)[0]
        got_name = gbk(data[pos + 4:pos + 4 + got_nl])
        got_len = struct.unpack_from("<i", data, pos + 4 + got_nl)[0]
        data_at = pos + 4 + got_nl + 4
        good = (got_nl == nl and got_name == name and got_len == fl and data_at == fo)
        if not good:
            ok_all = False
            print(f"    ✗ {name}: nameLen {got_nl}/{nl} name {got_name!r}/{name!r} len {got_len}/{fl} dataAt {data_at}/offset {fo}")
        pos = data_at + got_len
    print(f"  数据区逐段校验  {'✓ 全部自洽（offset 确实指向数据，且列表顺序 = 数据顺序）' if ok_all else '✗ 有偏差'}")
    print(f"  数据区结束位置  {pos:,}  {'✓ 与文件长度一致' if pos == len(data) else '✗ 文件长度 %d' % len(data)}")

    print(f"\n--- CRC32 变体判定（存储值 0x{stored_crc:08X}）---")
    for label, fn in [
        ("跳过 84..87（mrpinfo.ts 的写法）", crc32_variant_skip),
        ("把 84..87 置零", crc32_variant_zero),
        ("不跳过任何字节", crc32_variant_full),
    ]:
        v = fn(data)
        print(f"    {'✓' if v == stored_crc else '✗'} {label:<34} = 0x{v:08X}")

    print(f"\n--- 首个文件内容抽样 ---")
    if entries:
        name, nl, fo, fl, rv = entries[0]
        head = data[fo:fo + min(16, fl)]
        print(f"  {name}: 前 16 字节 = {head.hex(' ')}")
        if fl >= 2 and data[fo] == 0x1F and data[fo + 1] == 0x8B:
            print("     （是 gzip 流）")


if __name__ == "__main__":
    for p in sys.argv[1:]:
        inspect(p)
        print("=" * 78)
