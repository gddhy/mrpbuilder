#!/usr/bin/env python3
"""
流式重打包 assets/image/rootfs.tar.gz：
把模板里的 功能机开发规范.md 重命名为 README.md，其余条目原样保留
（元数据、软链、执行位全部不动 —— 工具链本身一字节不变）。

输出与 tools/make-image.py 完全同构：
  - rootfs.tar.gz          gzip(mtime=0, level=9) + tar
  - rootfs.tar.gz.part00/01  20MiB 分段
  - rootfs.parts.json      file/size/sha256/partBytes/parts
  - image.json             更新 rootfs_tar_bytes / rootfs_tar_sha256 / built

用法：python tools/repack-image.py
"""
import gzip
import hashlib
import io
import json
import os
import sys
import tarfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "assets", "image")
TAR_PATH = os.path.join(OUT_DIR, "rootfs.tar.gz")
PART_BYTES = 20 * 1024 * 1024

OLD = "mrp_demo/功能机开发规范.md"
NEW = "mrp_demo/README.md"


def log(msg):
    print(msg, flush=True)


def main():
    # ---- 读旧 tar，重命名目标成员，写新 tar.gz ----
    tmp_path = TAR_PATH + ".new"
    renamed = 0
    already = 0
    entries = 0
    with open(tmp_path, "wb") as f:
        with gzip.GzipFile(fileobj=f, mode="wb", compresslevel=9, mtime=0) as gz:
            with tarfile.open(fileobj=gz, mode="w") as tf_out:
                with tarfile.open(TAR_PATH, "r:gz") as tf_in:
                    for ti in tf_in:
                        entries += 1
                        if ti.name == OLD:
                            ti.name = NEW
                            # PAX 格式把非 ASCII 名字存在 pax_headers['path']，
                            # 写出时它会覆盖 ti.name，必须一并改
                            ti.pax_headers = {**ti.pax_headers, "path": NEW}
                            renamed += 1
                        elif ti.name == NEW:
                            already += 1
                        if ti.isfile():
                            tf_out.addfile(ti, tf_in.extractfile(ti))
                        else:
                            tf_out.addfile(ti)
    if renamed != 1 and already != 1:
        os.remove(tmp_path)
        log(f"✗ 期望 {OLD}×1 或 {NEW}×1，实际 renamed={renamed} already={already}，未改动")
        return 1

    os.replace(tmp_path, TAR_PATH)
    log(f"已重命名 {OLD} -> {NEW}（renamed={renamed} already={already}，共 {entries} 个条目）")

    # ---- 自检 ----
    with tarfile.open(TAR_PATH, "r:gz") as tf:
        names = tf.getnames()
        assert NEW in names, "新名字不在 tar 里"
        assert OLD not in names, "旧名字还在 tar 里"
        assert len(names) == entries, "条目数不符"
    log("自检：gzip ✓  tar 可读 ✓  新名在/旧名无/条目数一致 ✓")

    # ---- 分段 + 清单（与 make-image.py 相同格式）----
    with open(TAR_PATH, "rb") as f:
        blob = f.read()
    tgz_sha = hashlib.sha256(blob).hexdigest()

    for stale in os.listdir(OUT_DIR):
        if stale.startswith("rootfs.tar.gz.part"):
            os.remove(os.path.join(OUT_DIR, stale))
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
    log(f"已生成 {TAR_PATH}（{len(blob)/1048576:.1f} MiB），"
        f"切成 {len(parts)} 段（rootfs.parts.json）")

    # ---- 同步 image.json ----
    meta_path = os.path.join(OUT_DIR, "image.json")
    if os.path.exists(meta_path):
        with open(meta_path, encoding="utf-8") as f:
            meta = json.load(f)
        meta["rootfs_tar_bytes"] = len(blob)
        meta["rootfs_tar_sha256"] = tgz_sha
        meta["built"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2, ensure_ascii=False)
        log("image.json 已同步（sha256 / 大小 / 时间）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
