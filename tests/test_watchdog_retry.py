#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""退出后看护的重试语义回归测试（纯标准库 unittest）

背景（2026-11-05 实测）：ZCode 3.17.2 升级后，看护在 17:21:53 检测到退出开始写入，
客户端在 17:22:03 被更新器/用户重新拉起，`--auto-continue` 在 17:22:04 因
`WinError 5` 写入失败。旧实现随即 `_cleanup_singletons()` 删掉 `_watchdog.want`
并退出 —— 未完成项被彻底遗忘，用户看到的就是「重启了也没有自动注入」。

本测试锁死三条：
  1. 写入失败且客户端又被拉起 → 保留待办，等它下次完全退出再写，绝不丢需求；
  2. 连续失败到轮数上限 → 保留待办、只释放 PID，下次会话启动还能继续排期；
  3. 预检返回码 2（ZCode 在写之前被拉起）走同一套重试，不是一次性放弃。
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

_HERE = Path(__file__).resolve().parent
for _cand in (_HERE.parent / "scripts",
              _HERE.parent / "skills" / "zcode-pilot" / "scripts"):
    if (_cand / "apply_after_exit.py").is_file():
        sys.path.insert(0, str(_cand))
        break

import apply_after_exit as wd  # noqa: E402


class _Result:
    def __init__(self, returncode: int):
        self.returncode = returncode
        self.stdout = b""
        self.stderr = b""


class WatchdogRetryCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.pid = self.root / "_watchdog.pid"
        self.want = self.root / "_watchdog.want"
        self.log = self.root / "_apply_after_exit.log"
        self.want.write_text(json.dumps({"auto_continue": True}), encoding="utf-8")
        self._patches = [
            patch.object(wd, "PID_FILE", self.pid),
            patch.object(wd, "WANT_FILE", self.want),
            patch.object(wd, "LOG", self.log),
            patch.object(wd.time, "sleep", return_value=None),
            patch.object(wd.subprocess, "Popen", return_value=Mock()),
            patch.object(sys, "argv", ["apply_after_exit.py"]),
        ]
        for p in self._patches:
            p.start()

    def tearDown(self):
        for p in reversed(self._patches):
            p.stop()
        self.tmp.cleanup()

    def _log(self) -> str:
        return self.log.read_text(encoding="utf-8") if self.log.is_file() else ""

    def test_failure_keeps_wants_and_retries_until_success(self):
        calls = []

        def fake_run(cmd, **kwargs):
            calls.append(cmd)
            return _Result(1 if len(calls) == 1 else 0)

        # 轮 1 等待：False；轮 1 失败后：True（客户端被拉起）；轮 2 等待：False；
        # 成功后重启前：False。
        running = [False, True, False, False]
        with patch.object(wd.subprocess, "run", side_effect=fake_run), \
             patch.object(wd, "zcode_running", side_effect=running), \
             patch.object(wd, "resolve_install",
                          return_value=(self.root, self.root / "ZCode.exe")):
            rc = wd.main()

        self.assertEqual(rc, 0)
        self.assertEqual(len(calls), 2, "失败后必须重试一次")
        self.assertFalse(self.want.exists(), "成功后应清理待办")
        self.assertFalse(self.pid.exists(), "成功后应释放 PID")
        text = self._log()
        self.assertIn("未完成的补丁保留", text)
        self.assertIn("第 2/5 轮", text)

    def test_permanent_failure_keeps_wants_and_releases_pid(self):
        with patch.object(wd.subprocess, "run", return_value=_Result(1)), \
             patch.object(wd, "zcode_running", return_value=False), \
             patch.object(wd, "resolve_install") as resolve:
            rc = wd.main()

        self.assertEqual(rc, 1)
        self.assertEqual(wd.MAX_PATCH_ROUNDS, 5)
        self.assertFalse(self.pid.exists(), "放弃本轮时必须释放 PID，否则下次看护会误判已有实例")
        self.assertTrue(self.want.exists(), "写入失败绝不能删除待办，否则需求被永久遗忘")
        self.assertFalse(resolve.called, "补丁没写成功就不该重启客户端")
        self.assertIn("待办已保留", self._log())

    def test_precheck_returncode_2_retries_after_relaunch(self):
        calls = []

        def fake_run(cmd, **kwargs):
            calls.append(cmd)
            return _Result(2 if len(calls) == 1 else 0)

        running = [False, True, False, False]
        with patch.object(wd.subprocess, "run", side_effect=fake_run), \
             patch.object(wd, "zcode_running", side_effect=running), \
             patch.object(wd, "resolve_install",
                          return_value=(self.root, self.root / "ZCode.exe")):
            rc = wd.main()

        self.assertEqual(rc, 0)
        self.assertEqual(len(calls), 2, "预检被拒后必须等下次退出重试")
        self.assertIn("预检未通过", self._log())

    def test_release_pid_keeps_want_file(self):
        self.pid.write_text("12345", encoding="utf-8")
        wd._release_pid(12345)
        self.assertFalse(self.pid.exists())
        self.assertTrue(self.want.exists())


if __name__ == "__main__":
    unittest.main()
