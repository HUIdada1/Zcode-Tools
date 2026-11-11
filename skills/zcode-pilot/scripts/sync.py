#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""兼容入口（0.9.0 起同步脚本更名为 zcp_sync.py）。

为什么保留：插件市场「更新」只换插件版本目录，旧版（≤0.8.2）的退出看护会到
**新版目录**里按 `sync.py` 找重注入入口。少了这个转发器，升级当次就会退回旧目录
的脚本，把旧实现写回 app.asar。转发器只有几行，确认没有旧版看护在跑之后可删。

用法与 zcp_sync.py 完全一致（参数原样透传，退出码不变）。
"""

import runpy
import sys
from pathlib import Path

if __name__ == "__main__":
    here = Path(__file__).resolve().parent
    if str(here) not in sys.path:
        sys.path.insert(0, str(here))
    runpy.run_path(str(here / "zcp_sync.py"), run_name="__main__")
