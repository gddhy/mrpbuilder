#!/usr/bin/env python3
"""
在 Windows / macOS / Linux 上，用纯 Python 组装一个 v86 可启动的 Linux initramfs。

不需要 Docker，不需要 Linux，不需要 root。

产物：assets/image/initramfs.cpio.gz

内容：
  - Debian i386 的 arm-none-eabi-gcc / binutils / glibc
  - busybox（静态链接，提供 sh + 常用命令）
  - mrp_demo 工程模板
  - /init 启动脚本

用法：
  python tools/make-image.py                 # 构建
  python tools/make-image.py --list          # 只解析依赖并打印，不下载
  python tools/make-image.py --force         # 忽略缓存重新下载
"""

import argparse
import fnmatch
import glob
import gzip
import hashlib
import io
import json
import lzma
import os
import re
import shutil
import stat
import struct
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, ".build")
DEB_CACHE = os.path.join(BUILD, "debs")
ROOTFS = os.path.join(BUILD, "rootfs")
OUT_DIR = os.path.join(ROOT, "assets", "image")

# 默认用国内镜像：deb.debian.org 在部分网络下会中途断流。
# 可用 --mirror 覆盖，例如：
#   python tools/make-image.py --mirror https://deb.debian.org/debian
MIRROR = os.environ.get("DEBIAN_MIRROR", "https://mirrors.tuna.tsinghua.edu.cn/debian")
SUITE = "bookworm"
ARCH = "i386"

# 编译 MRP 只需要 C 编译器 + 汇编器 + 链接器，不需要 libc/libstdc++ 的运行期支持，
# 因为工程用 -nostdlib -nostartfiles 链接。
TARGET_PACKAGES = [
    "gcc-arm-none-eabi",
    "binutils-arm-none-eabi",
    "busybox-static",
    "make",             # busybox 里没有 make，必须单独装
    "libnewlib-dev",    # 标准 C 头文件（stdlib.h / math.h / string.h …）
                        #
                        # 注意：不要装 libnewlib-arm-none-eabi —— 那是 360 MiB 的
                        # newlib 多版本库，工程用 -nostdlib 链接，完全用不到。
                        # Debian 把 newlib 的头文件和库拆成了两个包，很容易漏。
]

# 这些包只是因为 Debian 的 Depends 字段被拉进来、但运行二进制时并不需要，
# 而且它们的 maintainer script 我们也不会执行，直接跳过以免拖进 dpkg/perl 一整套。
DEP_BLOCKLIST = {    "debconf", "dpkg", "init-system-helpers", "perl-base", "sensible-utils",
    "libc-bin", "usrmerge", "base-files", "base-passwd", "mawk", "sed", "grep",
    "install-info", "libselinux1", "libpcre2-8-0", "libattr1", "libacl1",
}

# 解包时直接丢弃的内容。用过滤而不是「先全解再删」，
# 因为部分受限环境会拦截文件删除，而且能省掉 400 MiB 的磁盘写入。
#
# 各项理由：
#   thumb/*       我们固定用 -marm 编译，Thumb 的全部多版本库都不需要（占 276 MiB）
#   cc1plus/lto1  C++ 与 LTO，用不到
#   plugin/       插件开发用，运行期不需要
#   lib/arm-none-eabi  newlib，工程用 -nostdlib 链接
#   usr/share     文档与本地化
PRUNE = [
    "usr/lib/gcc/arm-none-eabi/*/thumb",
    "usr/lib/gcc/arm-none-eabi/*/cc1plus",
    "usr/lib/gcc/arm-none-eabi/*/lto1",
    "usr/lib/gcc/arm-none-eabi/*/lto-wrapper",
    "usr/lib/gcc/arm-none-eabi/*/g++-mapper-server",
    "usr/lib/gcc/arm-none-eabi/*/plugin",
    "usr/lib/gcc/arm-none-eabi/*/include-fixed",
    "usr/lib/gcc/arm-none-eabi/*/install-tools",
    "usr/lib/gcc/arm-none-eabi/*/libgcov.a",
    "usr/lib/arm-none-eabi",
    "usr/share",
    "usr/bin/arm-none-eabi-lto-dump",
    "usr/bin/arm-none-eabi-g++",
    "usr/bin/arm-none-eabi-c++",
    "usr/bin/arm-none-eabi-gcov",
    "usr/bin/arm-none-eabi-gcov-dump",
    "usr/bin/arm-none-eabi-gcov-tool",
    "usr/bin/arm-none-eabi-gprof",
    "usr/bin/arm-none-eabi-c++filt",
]


def should_skip(rel):
    for pat in PRUNE:
        p = pat.rstrip("/")
        if fnmatch.fnmatch(rel, p) or fnmatch.fnmatch(rel, p + "/*"):
            return True
    return False


UA = {"User-Agent": "web-gcc-image-builder/1.0"}


def log(msg):
    print(f"[image] {msg}", flush=True)


def fetch(url, *, cache_path=None, force=False, expected_size=None):
    """
    下载。刻意不写临时文件再改名——某些受限环境（含沙箱）会拦截删除操作，
    删除临时文件会抛异常中断整个构建。直接写目标路径，用预期大小校验完整性。
    """
    if cache_path and os.path.exists(cache_path) and not force:
        size = os.path.getsize(cache_path)
        if expected_size is None or size == expected_size:
            log(f"缓存命中 {os.path.basename(cache_path)}（{size/1048576:.1f} MiB）")
            with open(cache_path, "rb") as f:
                return f.read()
        log(f"缓存不完整（{size} != {expected_size}），重新下载")

    log(f"下载 {url}")
    dest = cache_path or os.path.join(BUILD, "download.tmp")
    os.makedirs(os.path.dirname(dest), exist_ok=True)

    ok = False
    curl = shutil.which("curl")
    if curl:
        cmd = [curl, "-sSL", "--fail", "--retry", "3", "--retry-delay", "2",
               "-o", dest, url]
        try:
            subprocess.run(cmd, check=True, timeout=3600)
            ok = True
        except Exception as e:
            log(f"curl 失败（{type(e).__name__}），改用 urllib 重试")

    if not ok:
        req = urllib.request.Request(url, headers=UA)
        chunks = []
        with urllib.request.urlopen(req, timeout=600) as r:
            while True:
                b = r.read(1 << 16)
                if not b:
                    break
                chunks.append(b)
        with open(dest, "wb") as f:
            f.write(b"".join(chunks))

    size = os.path.getsize(dest)
    log(f"    {size/1048576:.1f} MiB")
    if expected_size is not None and size != expected_size:
        raise RuntimeError(f"{os.path.basename(dest)} 大小异常：{size} != {expected_size}")
    with open(dest, "rb") as f:
        return f.read()


# ---------------------------------------------------------------------------
# Debian 包索引与依赖解析
# ---------------------------------------------------------------------------

def safe_remove(path):
    """受限环境里删除可能被拦截，失败就忽略——绝不能因此中断构建。"""
    try:
        if os.path.lexists(path):
            os.remove(path)
    except Exception:
        pass


def safe_rmtree(path):
    try:
        shutil.rmtree(path)
    except Exception:
        pass


def tree_size(path):
    total = 0
    for r, _d, files in os.walk(path):
        for f in files:
            try:
                total += os.lstat(os.path.join(r, f)).st_size
            except OSError:
                pass
    return total


def reset_dir(path):
    """确保得到一个干净的空目录。删除失败时用改名让路，避免混入上一轮的残留文件。"""
    if not os.path.exists(path):
        os.makedirs(path, exist_ok=True)
        return
    try:
        shutil.rmtree(path)
    except Exception as e:
        stale = f"{path}.stale-{int(time.time())}"
        log(f"无法删除 {os.path.basename(path)}（{type(e).__name__}），改名为 {os.path.basename(stale)}")
        os.rename(path, stale)
    os.makedirs(path, exist_ok=True)


# Debian 的 busybox-static 只提供 /bin/busybox 这一个可执行文件，
# applet 的软链要自己建——否则连 /bin/sh 都没有，/init 这种 shell 脚本根本起不来。
BUSYBOX_APPLETS = [
    "sh", "ash", "mount", "umount", "mkdir", "rmdir", "mknod", "cp", "mv", "rm",
    "ls", "cat", "echo", "find", "sed", "tr", "head", "tail", "grep", "sort",
    "uniq", "wc", "chmod", "chown", "ln", "sleep", "env", "base64", "date",
    "printf", "test", "[", "dirname", "basename", "uname", "id", "ps", "kill",
    "sync", "dd", "tar", "gzip", "gunzip", "expr", "readlink", "realpath",
    "du", "df", "cut", "tee", "xargs", "touch", "stat", "setsid", "timeout",
]


def install_busybox_links(rootfs):
    bb = os.path.join(rootfs, "bin", "busybox")
    if not os.path.exists(bb):
        log("⚠ 没找到 /bin/busybox，跳过 applet 软链")
        return 0
    n = 0
    # 一律用绝对目标 /bin/busybox。
    # 之前用相对目标（../busybox）在 /usr/bin 下会指向不存在的 /usr/busybox，
    # 而 /usr/bin 在 PATH 里排在 /bin 前面，会把正确的 ls/cp 遮蔽掉。
    for d in (os.path.join(rootfs, "bin"), os.path.join(rootfs, "usr", "bin"),
              os.path.join(rootfs, "sbin"), os.path.join(rootfs, "usr", "sbin")):
        for a in BUSYBOX_APPLETS:
            p = os.path.join(d, a)
            if os.path.lexists(p):
                if not os.path.islink(p):
                    continue            # 真实文件（例如 make）不要动
                try:
                    if os.readlink(p) == "/bin/busybox":
                        continue        # 已经正确
                    safe_remove(p)
                except Exception:
                    continue
                if os.path.lexists(p):
                    continue            # 删不掉就放过，别制造冲突
            try:
                os.makedirs(d, exist_ok=True)
                os.symlink("/bin/busybox", p)
                n += 1
            except Exception:
                pass
    log(f"建立 busybox applet 软链 {n} 个")
    return n


def load_packages(force=False):
    url = f"{MIRROR}/dists/{SUITE}/main/binary-{ARCH}/Packages.xz"
    cache = os.path.join(BUILD, f"Packages-{SUITE}-{ARCH}.xz")
    text = None
    for attempt in range(2):
        raw = fetch(url, cache_path=cache, force=force or attempt > 0)
        try:
            text = lzma.decompress(raw).decode("utf-8", "replace")
            break
        except Exception as e:
            log(f"索引解压失败（{e}），重新下载")
            force = True
    if text is None:
        raise RuntimeError("无法获得有效的 Packages 索引")

    pkgs = {}
    for block in text.split("\n\n"):
        if not block.strip():
            continue
        fields = {}
        cur = None
        for line in block.split("\n"):
            if line.startswith(" ") and cur:
                fields[cur] += " " + line.strip()
            elif ":" in line:
                k, v = line.split(":", 1)
                cur = k.strip()
                fields[cur] = v.strip()
        name = fields.get("Package")
        if name:
            pkgs[name] = fields
    log(f"索引载入完成：{len(pkgs)} 个包（{SUITE}/{ARCH}）")
    return pkgs


def dep_names(expr):
    """把 Depends 表达式拆成候选包名列表（含多选一）"""
    out = []
    for alt in expr.split(","):
        alt = alt.strip()
        if not alt:
            continue
        # 多选一时取第一个
        first = alt.split("|")[0].strip()
        name = re.split(r"[\s(\[]", first)[0]
        if name:
            out.append(name)
    return out


def resolve(pkgs, roots):
    """广度优先解析依赖闭包；虚拟包（无实体文件）跳过"""
    need = []
    seen = set()
    queue = list(roots)
    while queue:
        name = queue.pop(0)
        if name in seen:
            continue
        seen.add(name)
        info = pkgs.get(name)
        if info is None:
            # 虚拟包或名字带架构后缀，忽略
            continue
        need.append(name)
        for field in ("Pre-Depends", "Depends"):
            for dep in dep_names(info.get(field, "")):
                if dep in DEP_BLOCKLIST or dep in seen:
                    continue
                queue.append(dep)
    return need


# ---------------------------------------------------------------------------
# .deb 解析（ar + tar.xz）
# ---------------------------------------------------------------------------

def ar_members(data):
    if not data.startswith(b"!<arch>\n"):
        raise ValueError("不是 ar 归档")
    off = 8
    out = {}
    while off + 60 <= len(data):
        hdr = data[off:off + 60]
        name = hdr[0:16].decode("ascii", "replace").strip()
        try:
            size = int(hdr[48:58].decode("ascii").strip())
        except ValueError:
            break
        start = off + 60
        out[name.rstrip("/")] = data[start:start + size]
        off = start + size + (size & 1)
    return out


def extract_deb(path, dest, skipped=None):
    if skipped is None:
        skipped = [0]
    with open(path, "rb") as f:
        members = ar_members(f.read())
    data_member = next((k for k in members if k.startswith("data.tar")), None)
    if not data_member:
        raise ValueError(f"{path} 里没有 data.tar")
    blob = members[data_member]
    mode = "r:xz" if data_member.endswith(".xz") else "r:gz" if data_member.endswith(".gz") else "r:"
    tf = tarfile.open(fileobj=io.BytesIO(blob), mode=mode)
    count = 0
    for member in tf.getmembers():
        # 去掉开头的 ./，统一成相对路径
        name = member.name.lstrip("./")
        if not name or name in (".", ".."):
            continue
        if should_skip(name):
            skipped[0] += 1
            continue
        target = os.path.join(dest, name)
        # 防目录穿越
        real = os.path.realpath(os.path.dirname(target))
        if not real.startswith(os.path.realpath(dest)):
            continue
        if member.isdir():
            os.makedirs(target, exist_ok=True)
        elif member.issym():
            os.makedirs(os.path.dirname(target), exist_ok=True)
            safe_remove(target)
            os.symlink(member.linkname, target)
        elif member.islnk():
            # 硬链接：内容与目标相同，直接复制（cpio 里不保留硬链接语义也够用）
            src = os.path.join(dest, member.linkname.lstrip("./"))
            os.makedirs(os.path.dirname(target), exist_ok=True)
            if os.path.exists(src):
                shutil.copy2(src, target)
        elif member.isfile():
            os.makedirs(os.path.dirname(target), exist_ok=True)
            f = tf.extractfile(member)
            with open(target, "wb") as out:
                shutil.copyfileobj(f, out)
            os.chmod(target, member.mode & 0o7777)
            count += 1
    return count


INIT_SH = r"""#!/bin/sh
# MRP Web 编译环境 —— v86 内运行的 init
#
# 重要：v86 用的内核没有启用 8250 串口 console（console=ttyS0 会被忽略），
# 内核消息和 PID1 的 stdout 默认都跑到 VGA 去。
# 所以这里必须主动把标准流接到 /dev/ttyS0，否则串口上什么都看不到。
/bin/mount -t devtmpfs devtmpfs /dev 2>/dev/null
if [ -c /dev/ttyS0 ]; then
  exec </dev/ttyS0 >/dev/ttyS0 2>&1
fi

echo "MRPIMG: init starting"
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export HOME=/root
export TERM=linux

mount -t proc  none /proc 2>/dev/null
mount -t sysfs none /sys  2>/dev/null
mkdir -p /dev/pts /tmp /root
mount -t devpts none /dev/pts 2>/dev/null

# 挂载宿主 9p 文件系统：网页通过 create_file() 写进来的源码就在这里
mkdir -p /mnt
if mount -t 9p -o trans=virtio,version=9p2000.L host9p /mnt 2>/dev/null; then
  echo "MRPIMG: 9p mounted at /mnt"
else
  echo "MRPIMG: 9p mount FAILED"
fi

echo "MRPIMG: ready"
echo "MRPIMG: gcc -> $(arm-none-eabi-gcc --version 2>&1 | head -1)"

# 标准流已经接到 /dev/ttyS0，直接起交互 shell 即可；
# 网页通过 emulator.serial0_send() 往这里输入命令
exec sh
"""

PROFILE_SH = r"""# 登录时提示
echo ""
echo "  MRP 纯前端编译环境 (v86 + arm-none-eabi-gcc)"
echo "  源码目录: /mnt   工程模板: /opt/mrp_demo"
echo ""
"""

# 自检时要求必须存在的条目（这些是整条链路真正依赖的东西）
TAR_REQUIRED = [
    "usr/bin/arm-none-eabi-gcc",     # 编译器驱动
    "usr/bin/arm-none-eabi-as",      # 汇编器（GCC 会 execvp 一个裸名 as，靠软链命中）
    "usr/bin/arm-none-eabi-ld",      # 链接器
    "usr/lib/gcc/arm-none-eabi/12.2.1/cc1",   # 真正的 C 编译器后端
    "usr/bin/make",                  # busybox 没有 make，必须单独装
    "usr/include/newlib/stdio.h",    # newlib 头文件（用 CPATH 指进去）
    "lib/i386-linux-gnu/ld-linux.so.2",       # glibc 加载器（桥接 uClibc rootfs）
    "lib/i386-linux-gnu/libc.so.6",
    "usr/lib/i386-linux-gnu/libisl.so.23",    # gcc 自身依赖，少一个就 cc1 起不来
    "mrp_demo/Makefile",
    "mrp_demo/lib/start.mr",         # 壳
    "mrp_demo/lib/cfunction.ext",    # 壳里的 ELF 加载器
]


def verify_tarball(path, blob):
    """
    校验刚写出的 rootfs.tar.gz。

    为什么要做这一步：如果产物不小心写成「未压缩的 tar」或者写截断了，
    到浏览器里只会表现成 `gzip: invalid magic` + `tar: short read`
    ——这两句报错完全指不到真正的原因（实际踩过一次，排查花了不少时间）。
    所以在生成端就把「是 gzip / 能解开 / 是完整 tar / 关键文件在」验掉。
    """
    if blob[:2] != b"\x1f\x8b":
        raise SystemExit(
            f"✗ {path} 不是 gzip（前 2 字节 {blob[:2].hex()}）——"
            f"浏览器里会报 `gzip: invalid magic`"
        )
    try:
        raw = gzip.decompress(blob)
    except Exception as e:
        raise SystemExit(f"✗ {path} 的 gzip 流损坏：{e}")
    if len(raw) < 512 or raw[257:262] != b"ustar":
        raise SystemExit(f"✗ 解压结果不像 tar（{len(raw)} 字节，未找到 ustar 标记）")
    try:
        tf = tarfile.open(fileobj=io.BytesIO(raw), mode="r:")
        names = set(tf.getnames())
    except Exception as e:
        raise SystemExit(f"✗ 解压结果不是完整可读的 tar：{e}")

    missing = [n for n in TAR_REQUIRED if n not in names]
    if missing:
        raise SystemExit("✗ tar 里缺少关键文件：\n    " + "\n    ".join(missing))
    return len(raw), len(names), missing


def main():
    global MIRROR
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true", help="只解析并打印依赖，不下载")
    ap.add_argument("--force", action="store_true", help="忽略缓存重新下载")
    ap.add_argument("--kernel", default="buildroot-bzimage68.bin", help="v86 内核文件名")
    ap.add_argument("--mirror", default=MIRROR, help="Debian 镜像地址")
    ap.add_argument("--skip-extract", action="store_true",
                    help="沿用已有 .build/rootfs，不重新解包（改裁剪规则后需重新解包）")
    ap.add_argument("--repack-only", action="store_true",
                    help="只重新打包（刷新软链 / init / 模板后打 tarball），不下载不解包")
    args = ap.parse_args()

    MIRROR = args.mirror.rstrip("/")
    log(f"使用镜像 {MIRROR}（{SUITE}/{ARCH}）")

    os.makedirs(BUILD, exist_ok=True)
    os.makedirs(DEB_CACHE, exist_ok=True)

    pkgs = load_packages(force=args.force)
    needed = resolve(pkgs, TARGET_PACKAGES)

    log(f"依赖闭包 {len(needed)} 个包：")
    for n in sorted(needed):
        info = pkgs[n]
        log(f"    {n:<28} {info.get('Version','?'):<22} {int(info.get('Installed-Size','0') or 0)//1024} MiB")

    if args.list:
        return 0

    repack_only = args.repack_only and os.path.isdir(ROOTFS)
    if args.repack_only and not repack_only:
        log("没有可复用的 rootfs，改为完整构建")

    kern_local = os.path.join(BUILD, args.kernel)

    if not repack_only:
        # 下载 .deb
        for n in needed:
            info = pkgs[n]
            fn = info["Filename"]
            url = f"{MIRROR}/{fn}"
            local = os.path.join(DEB_CACHE, os.path.basename(fn))
            exp = int(info["Size"]) if info.get("Size") else None
            log(f"[{n}]")
            fetch(url, cache_path=local, force=args.force, expected_size=exp)

        # 内核
        fetch(f"https://i.copy.sh/{args.kernel}", cache_path=kern_local, force=args.force)
    else:
        log("--repack-only：跳过大包下载与解包")

    # 解包（带裁剪过滤）
    skipped = [0]
    if repack_only or (args.skip_extract and os.path.isdir(ROOTFS)):
        log(f"沿用已有 rootfs：{ROOTFS}")
    else:
        reset_dir(ROOTFS)
        total = 0
        for n in needed:
            fn = os.path.basename(pkgs[n]["Filename"])
            path = os.path.join(DEB_CACHE, fn)
            cnt = extract_deb(path, ROOTFS, skipped)
            total += cnt
            log(f"解包 {n:<28} {cnt:>5} 个文件")
        log(f"rootfs 共写入 {total} 个文件，按裁剪规则跳过 {skipped[0]} 项")
    rootfs_bytes = tree_size(ROOTFS)
    log(f"rootfs 体积 {rootfs_bytes/1048576:.1f} MiB")

    install_busybox_links(ROOTFS)

    # 补齐 /init 与模板
    # 模板放在顶层 mrp_demo/：tarball 会解到 /opt/tc，于是变成 /opt/tc/mrp_demo
    demo_src = os.path.join(ROOT, "mrp_demo")
    if os.path.isdir(demo_src):
        legacy = os.path.join(ROOTFS, "opt", "mrp_demo")
        if os.path.isdir(legacy):
            safe_rmtree(legacy)          # 早期版本放在 /opt 下，清掉避免残留
        dst = os.path.join(ROOTFS, "mrp_demo")
        # dirs_exist_ok：受限环境里删除目录可能被拦截，直接就地覆盖更稳
        shutil.copytree(demo_src, dst, dirs_exist_ok=True)
        log(f"已内置工程模板 mrp_demo（{sum(len(f) for _,_,f in os.walk(dst))} 个文件）")

    with open(os.path.join(ROOTFS, "init"), "w", newline="\n") as f:
        f.write(INIT_SH)
    os.chmod(os.path.join(ROOTFS, "init"), 0o755)

    etc = os.path.join(ROOTFS, "etc")
    os.makedirs(etc, exist_ok=True)
    with open(os.path.join(etc, "profile"), "w", newline="\n") as f:
        f.write(PROFILE_SH)

    # 打包成 rootfs tarball。
    #
    # 为什么不用 initramfs：实测 v86 配的内核（Buildroot / uClibc / 6.8.12）
    # 会把 100MB 的外部 initrd 忽略掉、回落到自带 rootfs，而且它没启用 8250 串口
    # console，所以内核的报错还看不到。改成「不传 initrd + 用 9p 把 tarball 推进
    # 虚拟机解压」后，启动更快、体积限制也没有了，而且自带 rootfs 的 shell 与 9p
    # 都已经验证可用。
    log("打包 rootfs tarball ...")
    os.makedirs(OUT_DIR, exist_ok=True)
    tar_path = os.path.join(OUT_DIR, "rootfs.tar.gz")

    # Windows 上 os.chmod 只认只读位，存不了执行权限，打 tar 时权限会退化成 0666，
    # 结果虚拟机里所有二进制都「Permission denied」。
    # 这里按内容判定：ELF 与带 shebang 的脚本给 0755，其余 0644，目录 0755。
    def fix_mode(ti):
        if ti.isdir():
            ti.mode = 0o755
        elif ti.issym() or ti.islnk():
            ti.mode = 0o777
        else:
            mode = 0o644
            try:
                with open(os.path.join(ROOTFS, ti.name), "rb") as f:
                    head = f.read(2)
                if head == b"\x7fE" or head == b"#!":
                    mode = 0o755
            except OSError:
                pass
            ti.mode = mode
        ti.uid = ti.gid = 0
        ti.uname = ti.gname = "root"
        ti.mtime = 0
        return ti

    with open(tar_path, "wb") as f:
        with gzip.GzipFile(fileobj=f, mode="wb", compresslevel=9, mtime=0) as gz:
            with tarfile.open(fileobj=gz, mode="w") as tf:
                for entry in sorted(os.listdir(ROOTFS)):
                    tf.add(os.path.join(ROOTFS, entry), arcname=entry,
                           recursive=True, filter=fix_mode)
    tgz_bytes = os.path.getsize(tar_path)
    with open(tar_path, "rb") as f:
        blob = f.read()
    tgz_sha = hashlib.sha256(blob).hexdigest()
    inner_bytes, tar_entries, missing = verify_tarball(tar_path, blob)
    log(f"已生成 {tar_path}  ({tgz_bytes/1048576:.1f} MiB 压缩 / "
        f"{inner_bytes/1048576:.1f} MiB 解开)")
    log(f"自检：gzip ✓  tar 可读 ✓  {tar_entries} 个条目 ✓  关键文件齐全 ✓")

    # ---- 按 20MiB 分段 ----
    # Cloudflare Pages / EdgeOne Pages 这类静态托管对单个文件有 25MB 上限，
    # rootfs.tar.gz（30.6 MiB）超了。浏览器端读 rootfs.parts.json 把分段拼回来。
    PART_BYTES = 20 * 1024 * 1024
    for stale in glob.glob(os.path.join(OUT_DIR, "rootfs.tar.gz.part*")):
        safe_remove(stale)
    parts = []
    for i in range(0, len(blob), PART_BYTES):
        idx = i // PART_BYTES
        pname = f"rootfs.tar.gz.part{idx:02d}"
        with open(os.path.join(OUT_DIR, pname), "wb") as f:
            f.write(blob[i:i + PART_BYTES])
        parts.append({"name": pname, "size": min(PART_BYTES, len(blob) - i)})
    with open(os.path.join(OUT_DIR, "rootfs.parts.json"), "w", encoding="utf-8") as f:
        json.dump({
            "file": "rootfs.tar.gz",
            "size": len(blob),
            "sha256": tgz_sha,
            "partBytes": PART_BYTES,
            "parts": parts,
        }, f, ensure_ascii=False, indent=2)
    log(f"已按 {PART_BYTES/1048576:.0f} MiB 切成 {len(parts)} 段（rootfs.parts.json）")

    # 把内核也复制过去（网页要一起加载）
    shutil.copy2(kern_local, os.path.join(OUT_DIR, "vmlinuz.bin"))
    log(f"已复制内核到 {os.path.join(OUT_DIR, 'vmlinuz.bin')}")

    # 记录元信息
    meta = {
        "suite": SUITE,
        "arch": ARCH,
        "packages": {n: pkgs[n].get("Version") for n in needed},
        "kernel": args.kernel,
        "rootfs_bytes": rootfs_bytes,
        "rootfs_tar_bytes": tgz_bytes,
        "rootfs_tar_sha256": tgz_sha,
        "template": "mrp_demo",
        "built": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    with open(os.path.join(OUT_DIR, "image.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)
    log("完成")
    return 0


if __name__ == "__main__":
    sys.exit(main())
