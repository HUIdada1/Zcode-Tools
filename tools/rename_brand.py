#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一次性品牌改名脚本：zcode-tokenspeed -> zcode-pilot，ZCode Patcher -> ZCode Pilot。

设计要点：
  * **字节级替换**：只替换 ASCII 字节串，绝不解码/重编码，因此不会碰换行、
    不会引入 BOM、不会破坏任何非 ASCII 文案（仓库里全是中文注释）。
  * 跳过 .git 与二进制文件（前 4KB 含 NUL 判定）。
  * 幂等：重复运行结果不变。
  * 只做「改名」，不做功能改造（移除滑条等由后续任务负责）。

用法：
    python tools/rename_brand.py --dry-run
    python tools/rename_brand.py
"""
from __future__ import annotations

import argparse
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

# 顺序无关（两个模式不重叠），但保持显式列表便于审阅
REPLACEMENTS = [
    (b"zcode-tokenspeed", b"zcode-pilot"),
    (b"ZCode Patcher", b"ZCode Pilot"),
]

SKIP_DIRS = {".git", "__pycache__", "node_modules", ".research"}
# 本脚本自身不参与替换（否则文档里的对照示例会被自己改写，失去可读性）
SKIP_FILES = {pathlib.Path(__file__).resolve()}


def is_binary(head: bytes) -> bool:
    return b"\x00" in head


def iter_files():
    for p in sorted(ROOT.rglob("*")):
        if not p.is_file():
            continue
        if any(part in SKIP_DIRS for part in p.parts):
            continue
        if p.resolve() in SKIP_FILES:
            continue
        yield p


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    changed = []
    hits = 0
    for p in iter_files():
        try:
            data = p.read_bytes()
        except OSError:
            continue
        if is_binary(data[:4096]):
            continue
        new = data
        n = 0
        for old, rep in REPLACEMENTS:
            n += new.count(old)
            new = new.replace(old, rep)
        if n and new != data:
            hits += n
            changed.append((p.relative_to(ROOT), n))
            if not args.dry_run:
                p.write_bytes(new)

    for rel, n in changed:
        print(f"  {n:>4}  {rel}")
    print(f"\n{'[dry-run] 将修改' if args.dry_run else '已修改'} {len(changed)} 个文件，共 {hits} 处")
    return 0


if __name__ == "__main__":
    sys.exit(main())
