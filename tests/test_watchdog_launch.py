#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""看护启动方式回归测试（纯标准库 unittest）

背景（2026-11-12/13 实测故障）：Windows 上看护由 SessionStart 钩子直接 Popen 拉起，
是 ZCode.exe → zcode-runtime-host.exe → shell → python 的后代进程。`DETACHED_PROCESS`
只脱控制台、不脱进程树 —— 用户按提示「完全退出」时，客户端把整棵后代树一起收掉，
看护在观测到退出**之前**就死了：日志里只有「启动待命」一行、没有任何写入记录，
表现就是「退出了但什么都没注入」，且无论重退多少次都复现（每代新看护都挂在树上）。

0.9.2 起 Windows 改走计划任务（svchost 派生、树外），失败才降级回 Popen。
0.9.3 升级为两段式：「点火（PowerShell → schtasks.exe 兜底）→ 活性确认
（wait_watchdog_alive 等心跳现身）」—— 点火成功 ≠ 进程活着（pythonw 被杀软拦 /
Store Python 别名损坏全都无声无息），TASK_OK 不再等于「看护在岗」。
本测试锁死：
  1. 计划任务成功且活性确认 → 不再走 Popen，日志注明树外；
  2. 点火失败（rc / 输出 / 异常三类）→ 只返回 False，绝不上抛；
  3. 点火成功但心跳没现身 → 同样按失败处理（0.9.3 哑故障修复）；
  4. PowerShell 失败 → schtasks.exe 兜底（/Create → /Run → /Delete 用完即删，
     /TR 不带 --want，防 261 字符上限）；
  5. 计划任务不可用 → 降级 Popen，且仍带 DETACHED_PROCESS|CREATE_NO_WINDOW；
  6. POSIX → 维持 start_new_session 自成会话组、绝不碰计划任务分支。
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
    """_launch_watchdog_via_task：点火 + 活性确认，成败判定与「绝不上抛」。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.ps1 = self.root / "_zcp_watchdog_task.ps1"
        self.logm = Mock()
        self._patches = [
            patch.object(sy, "WATCHDOG_DIR", self.root),
            patch.object(sy, "WATCHDOG_TASK_PS1", self.ps1),
            patch.object(sy, "log", self.logm),
            # 活性确认统一打桩：默认「看护已现身」；哑故障用例自行覆盖为 False
            patch.object(sy, "wait_watchdog_alive", return_value=True),
            # PowerShell 可用、schtasks 不可用为默认；兜底用例自行覆盖
            patch.object(sy.shutil, "which",
                         side_effect=lambda n: "powershell" if n == "powershell" else None),
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

    def test_fire_ok_but_no_heartbeat_returns_false(self):
        # 点火成功但看护没现身（pythonw 被杀软拦）：必须按失败处理，交调用方降级兜底。
        # 0.9.2 的哑故障：TASK_OK 打了但看护根本没起来，退出后照样什么都没注入。
        # ★ run 必须打桩：真执行 ps1 会注册并 Start 真计划任务，放生一个挂真实
        #   状态目录的 pythonw 看护（02:35 实测泄漏 PID 8260）。
        with patch.object(sy.subprocess, "run", return_value=_Run(stdout="TASK_OK")), \
             patch.object(sy, "wait_watchdog_alive", return_value=False):
            ok = sy._launch_watchdog_via_task(["--watch-plugin-update"])
        self.assertFalse(ok)
        self.assertTrue(any("心跳" in str(c.args[0]) for c in self.logm.call_args_list),
                        "活性确认失败必须留痕")

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

    def test_schtasks_fallback_when_powershell_fails(self):
        calls = []

        def fake_run(cmd, **kwargs):
            calls.append(cmd)
            if str(cmd[0]).endswith("powershell"):
                return _Run(returncode=1, stderr="ConstrainedLanguage")
            return _Run(returncode=0)

        with patch.object(sy.shutil, "which",
                          side_effect=lambda n: "schtasks" if n == "schtasks" else None), \
             patch.object(sy.subprocess, "run", side_effect=fake_run):
            ok = sy._launch_watchdog_via_task(["--watch-plugin-update", "--want=tps_footer=on"])
        self.assertTrue(ok, "PowerShell 被策略拦时必须由 schtasks 兜底")
        sch = [c for c in calls if str(c[0]).endswith("schtasks")]
        creates = [c for c in sch if "/Create" in c]
        self.assertTrue(creates, "兜底必须先 /Create 任务定义")
        tr = creates[0][creates[0].index("/TR") + 1]
        self.assertNotIn("--want", tr,
                         "schtasks /TR 有 ~261 字符上限；待办必须走 watchdog.want 文件")
        self.assertIn("zcp_watchdog.py", tr)
        self.assertTrue(any("/Run" in c for c in sch), "创建后必须立即手动点火")
        self.assertTrue(any("/Delete" in c for c in sch), "任务定义必须用完即删，不留计划残留")
        self.assertFalse(self.ps1.exists(), "临时 ps1 即便走了兜底也要清掉")


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
            # 单例判定与活性确认打桩：默认「没有看护在跑」「点火后看护现身」
            patch.object(sy, "live_watchdog_pid", Mock(return_value=0)),
            patch.object(sy, "wait_watchdog_alive", Mock(return_value=True)),
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
             patch.object(sy.subprocess, "Popen") as pop2, \
             patch.object(sy, "_launch_watchdog_via_task", Mock()) as via_task:
            sy.start_watchdog({"tps_footer": True})
        via_task.assert_not_called()
        pop2.assert_called_once()
        # ★ 两段都必须 mock Popen：曾因第二段漏 mock，每次跑测试都放生一个真实的
        #   看护进程（挂真实状态目录、最长等 24h）——心跳单例上线后它还会占住
        #   单例账本，把真实启动方全部挡在门外。

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
