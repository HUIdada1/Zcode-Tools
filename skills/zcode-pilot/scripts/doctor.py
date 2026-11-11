#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""兼容入口（0.9.0 起体检脚本更名为 zcp_doctor.py）。

保留原因：README 里那条「全电脑通用单行自愈命令」按 `**/doctor.py` 搜索；
老用户收藏的旧命令不应在改名后失效。参数原样透传，退出码不变。
"""

import runpy
import sys
from pathlib import Path

if __name__ == "__main__":
    here = Path(__file__).resolve().parent
    if str(here) not in sys.path:
        sys.path.insert(0, str(here))
    runpy.run_path(str(here / "zcp_doctor.py"), run_name="__main__")
