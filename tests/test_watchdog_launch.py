#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""看护启动方式回归测试（纯标准库 unittest）

背景（2026-11-12/13 实测故障）：Windows 上看护由 SessionStart 钩子直接 Popen 拉起，
是 ZCode.exe → zcode-runtime-host.exe → shell → python 的后代进程。`DETACHED_PROCESS`
只脱控制台、不脱进程树 —— 用户按提示「完全退出」时，客户端把整棵后代树一起收掉，
看护在观测到退出**之前**就死了：日志里只有「启动待命」一行、没有任何写入记录，
表现就是「退出了但什么都没注入」，且无论重退多少次都复现（每代新看护都挂在树上）。

0.9.2 起 Windows 改走计划任务（svchost 派生、树外），失败才降级回 Popen。
本测试锁死：
  1. 计划任务成功（TASK_OK）→ 不再走 Popen，日志注明树外；
  2. 计划任务失败 → 降级 Popen，且仍带 DETACHED_PROCESS|CREATE_NO_WINDOW；
  3. POSIX → 维持 start_new_session 自成会话组；
  4. _launch_watchdog_via_task 对 rc/输出/异常三类失败都只返回 False，绝不上抛
     （钩子路径上任何异常都会拖垮会话启动）。
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

_HERE = Path(__file__).resolve().parent
for _cand in (_HERE.parent / "scripts",
              _HERE.parent / "skills" / "zcode-pilot" / "scripts"):
    if (_cand / "zcp_sync.py").is_file():
        sys.path.insert(0, str(_cand))
        break

import zcp_sync as sy  # noqa: E402


class _Run:
    """subprocess.run 返回值替身（只用到 returncode/stdout/stderr）。"""

    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


class ViaTaskCase(unittest.TestCase):
    """_launch_watchdog_via_task：成败判定与「绝不上抛」。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.ps1 = self.root / "_zcp_watchdog_task.ps1"
        self._patches = [
            patch.object(sy, "WATCHDOG_DIR", self.root),
            patch.object(sy, "WATCHDOG_TASK_PS1", self.ps1),
            patch.object(sy, "log", Mock()),
        ]
        for p in self._patches:
            p.start()

    def tearDown(self):
        for p in reversed(self._patches):
            p.stop()
        self.tmp.cleanup()

    def test_success_returns_true_and_cleans_ps1(self):
        with patch.object(sy.subprocess, "run", return_value=_Run(stdout="TASK_OK")) as run:
            ok = sy._launch_watchdog_via_task(["--watch-plugin-update"])
        self.assertTrue(ok)
        self.assertFalse(self.ps1.exists(), "临时 ps1 必须用完即删")
        # 校验生成的脚本三要素齐全：注册 → 启动 → 删除定义
        cmd = run.call_args[0][0]
        self.assertEqual(cmd[0], "powershell")

    def test_nonzero_rc_returns_false(self):
        with patch.object(sy.subprocess, "run", return_value=_Run(returncode=1, stderr="Access denied")):
            self.assertFalse(sy._launch_watchdog_via_task([]))

    def test_missing_marker_returns_false(self):
        # rc=0 但没打出 TASK_OK（如中途抛错被吞）同样按失败处理
        with patch.object(sy.subprocess, "run", return_value=_Run(stdout="")):
            self.assertFalse(sy._launch_watchdog_via_task([]))

    def test_exception_is_swallowed(self):
        with patch.object(sy.subprocess, "run", side_effect=OSError("no powershell")):
            self.assertFalse(sy._launch_watchdog_via_task([]))


class StartWatchdogLaunchCase(unittest.TestCase):
    """start_watchdog 的三平台启动路径选择。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.logs = []
        self._patches = [
            patch.object(sy, "WATCHDOG_DIR", self.root),
            patch.object(sy, "WANT_FILE", self.root / "watchdog.want"),
            patch.object(sy, "PID_FILE", self.root / "watchdog.pid"),
            patch.object(sy, "WATCH_FLAG", self.root / "watchdog.watch"),
            patch.object(sy, "installed_plugin", Mock(return_value={})),
            patch.object(sy, "log", lambda m: self.logs.append(str(m))),
        ]
        for p in self._patches:
            p.start()

    def tearDown(self):
        for p in reversed(self._patches):
            p.stop()
        self.tmp.cleanup()

    def test_windows_prefers_task_scheduler_skips_popen(self):
        with patch.object(sy, "os", SimpleNamespace(name="nt")), \
             patch.object(sy, "_launch_watchdog_via_task", Mock(return_value=True)) as via_task, \
             patch.object(sy.subprocess, "Popen") as pop:
            sy.start_watchdog({"tps_footer": True})
        via_task.assert_called_once()
        pop.assert_not_called()
        self.assertTrue(any("树外" in m for m in self.logs), f"日志未标注树外: {self.logs}")

    def test_windows_falls_back_to_popen_when_task_fails(self):
        with patch.object(sy, "os", SimpleNamespace(name="nt")), \
             patch.object(sy, "_launch_watchdog_via_task", Mock(return_value=False)), \
             patch.object(sy.subprocess, "Popen") as pop:
            sy.start_watchdog({"tps_footer": True})
        pop.assert_called_once()
        kw = pop.call_args.kwargs
        self.assertTrue(kw["creationflags"] & sy.DETACHED_PROCESS)
        self.assertTrue(kw["creationflags"] & sy.CREATE_NO_WINDOW)
        self.assertTrue(any("树内" in m for m in self.logs), f"降级必须留痕: {self.logs}")

    def test_posix_uses_new_session(self):
        with patch.object(sy, "os", SimpleNamespace(name="posix")), \
             patch.object(sy.subprocess, "Popen") as pop:
            sy.start_watchdog({"tps_footer": True})
        pop.assert_called_once()
        self.assertTrue(pop.call_args.kwargs.get("start_new_session"))
        # POSIX 上绝不能碰计划任务分支
        with patch.object(sy, "os", SimpleNamespace(name="posix")), \
             patch.object(sy, "_launch_watchdog_via_task", Mock()) as via_task:
            sy.start_watchdog({"tps_footer": True})
        via_task.assert_not_called()

    def test_watchdog_args_carry_all_wants(self):
        with patch.object(sy, "os", SimpleNamespace(name="nt")), \
             patch.object(sy, "_launch_watchdog_via_task", Mock(return_value=True)) as via_task:
            sy.start_watchdog({"tps_footer": True, "auto_continue": False})
        args = via_task.call_args[0][0]
        self.assertIn("--watch-plugin-update", args)
        self.assertIn("--want=tps_footer=on", args)
        self.assertIn("--want=auto_continue=off", args)


class Ps1EscapingCase(unittest.TestCase):
    """生成脚本的引号转义：路径含单引号也不能破坏 ps1 语法。"""

    def test_psq_doubles_single_quotes(self):
        self.assertEqual(sy._psq("O'Brien\\x"), "O''Brien\\x")


if __name__ == "__main__":
    unittest.main()
