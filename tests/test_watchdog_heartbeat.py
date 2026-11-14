#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""看护心跳账本回归测试（纯标准库 unittest）

背景（0.9.3）：换台电脑「完全退出也不重注入」。旧单例判定只看 PID 文件 +
is_pid_alive —— 被连坐绞杀/崩溃的看护来不及清 PID 文件，Windows 又按顺序复用
PID，死号被无关进程顶上后，启动方永远误判「已有看护在跑」，看护从此不再被拉起。
心跳账本（watchdog.beat：{pid, ts}）自此成为「看护是否在跑」的唯一事实源。
本测试锁死：
  1. 心跳写/读回环；缺文件/坏 JSON/缺字段一律按「没有看护」处理，绝不上抛；
  2. live_watchdog_pid 三态：心跳新鲜+PID 活 / 心跳过期 / PID 已死 —— 只有第一态算活；
  3. wait_watchdog_alive：超时没等到心跳 → False（启动方据此降级兜底）；
  4. zcp_sync.start_watchdog：心跳活 → 只登记需求不重复拉起；心跳死 → 重新拉起接管；
  5. zcp_watchdog.main：启动时已有他者心跳 → 登记需求即退出；等待期出现他者心跳 → 让位。
"""

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

_HERE = Path(__file__).resolve().parent
for _cand in (_HERE.parent / "scripts",
              _HERE.parent / "skills" / "zcode-pilot" / "scripts"):
    if (_cand / "zcp_watchdog.py").is_file():
        sys.path.insert(0, str(_cand))
        break

import zcp_watchdog as wd   # noqa: E402
import zcp_sync as sy       # noqa: E402


def _spawn_sleeper():
    """起一个肯定活着的进程（拿它的 PID 做活体样本）。调用方负责 kill+wait。"""
    return subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


class HeartbeatCase(unittest.TestCase):
    """write/read/live 三态与脏数据容错。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self._patches = [
            patch.object(wd, "WANT_FILE", self.root / "watchdog.want"),
            patch.object(wd, "PID_FILE", self.root / "watchdog.pid"),
        ]
        for p in self._patches:
            p.start()

    def tearDown(self):
        for p in reversed(self._patches):
            p.stop()
        self.tmp.cleanup()

    def _put_beat(self, pid: int, age: float = 0.0) -> None:
        wd._beat_path().write_text(
            json.dumps({"pid": pid, "ts": time.time() - age}), encoding="utf-8")

    def test_roundtrip_and_missing(self):
        self.assertEqual(wd.read_beat(), {}, "心跳文件缺失必须按空处理，绝不上抛")
        wd.write_beat()
        hb = wd.read_beat()
        self.assertEqual(hb.get("pid"), os.getpid())
        self.assertLessEqual(time.time() - hb.get("ts", 0), 5)

    def test_fresh_beat_with_live_pid_is_live(self):
        p = _spawn_sleeper()
        try:
            self._put_beat(p.pid)
            self.assertEqual(wd.live_watchdog_pid(), p.pid)
        finally:
            p.kill()
            p.wait()

    def test_stale_beat_is_not_live(self):
        p = _spawn_sleeper()
        try:
            self._put_beat(p.pid, age=wd.BEAT_FRESH_SEC * 3)
            self.assertEqual(wd.live_watchdog_pid(), 0,
                             "心跳过期 = 看护已死（防 PID 复用被误判成看护在跑）")
        finally:
            p.kill()
            p.wait()

    def test_dead_pid_is_not_live(self):
        p = _spawn_sleeper()
        p.kill()
        p.wait()
        self._put_beat(p.pid)
        self.assertEqual(wd.live_watchdog_pid(), 0, "PID 已死 = 看护已死")

    def test_corrupt_beat_is_not_live(self):
        wd._beat_path().write_text("not json", encoding="utf-8")
        self.assertEqual(wd.live_watchdog_pid(), 0)
        wd._beat_path().write_text(json.dumps({"ts": time.time()}), encoding="utf-8")
        self.assertEqual(wd.live_watchdog_pid(), 0, "缺 pid 字段 = 没有看护")

    def test_wait_alive_timeout_and_hit(self):
        self.assertFalse(wd.wait_watchdog_alive(timeout=1.2),
                         "没等到心跳必须返回 False，让启动方降级兜底")
        p = _spawn_sleeper()
        try:
            self._put_beat(p.pid)
            self.assertTrue(wd.wait_watchdog_alive(timeout=3))
        finally:
            p.kill()
            p.wait()


class SyncSingletonCase(unittest.TestCase):
    """zcp_sync.start_watchdog：单例判定改心跳口径（PID 复用不再拦住重拉）。"""

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
            patch.object(sy, "live_watchdog_pid", Mock(return_value=0)),
            patch.object(sy, "wait_watchdog_alive", Mock(return_value=True)),
        ]
        for p in self._patches:
            p.start()

    def tearDown(self):
        for p in reversed(self._patches):
            p.stop()
        self.tmp.cleanup()

    def test_live_watchdog_skips_launch_but_records_wants(self):
        sy.live_watchdog_pid.return_value = 4321
        with patch.object(sy, "os", SimpleNamespace(name="posix")), \
             patch.object(sy.subprocess, "Popen") as pop:
            sy.start_watchdog({"tps_footer": True})
        pop.assert_not_called()
        self.assertTrue(any("心跳确认" in m for m in self.logs),
                        f"跳过启动必须留痕: {self.logs}")
        # 需求清单仍要登记（退出后由在跑的看护消费）
        self.assertEqual(json.loads((self.root / "watchdog.want").read_text(encoding="utf-8")),
                         {"tps_footer": True})

    def test_dead_watchdog_relaunches(self):
        # 心跳停更（返回 0）= 没有可信看护 → 必须重新拉起，而不是被 PID 残留劝退
        with patch.object(sy, "os", SimpleNamespace(name="posix")), \
             patch.object(sy.subprocess, "Popen") as pop:
            sy.start_watchdog({"tps_footer": True})
        pop.assert_called_once()


class WatchdogSingletonCase(unittest.TestCase):
    """zcp_watchdog.main：启动时让位 + 等待期让位（双看护竞态裁决）。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.log = self.root / "_zcp_watchdog.log"
        self.sleeper = _spawn_sleeper()
        self._patches = [
            patch.object(wd, "WANT_FILE", self.root / "watchdog.want"),
            patch.object(wd, "PID_FILE", self.root / "watchdog.pid"),
            patch.object(wd, "LOG", self.log),
            patch.object(wd.time, "sleep", return_value=None),
            patch.object(wd.subprocess, "Popen", return_value=Mock()),
            patch.object(sys, "argv", ["zcp_watchdog.py"]),
        ]
        for p in self._patches:
            p.start()

    def tearDown(self):
        for p in reversed(self._patches):
            p.stop()
        self.sleeper.kill()
        self.sleeper.wait()
        self.tmp.cleanup()

    def _log(self) -> str:
        return self.log.read_text(encoding="utf-8") if self.log.is_file() else ""

    def _put_foreign_beat(self) -> None:
        wd._beat_path().write_text(
            json.dumps({"pid": self.sleeper.pid, "ts": time.time()}), encoding="utf-8")

    def test_startup_yields_to_live_watchdog(self):
        self._put_foreign_beat()
        with patch.object(wd, "zcode_running", Mock()) as zr:
            rc = wd.main()
        self.assertEqual(rc, 0)
        zr.assert_not_called()
        self.assertIn("已有活跃看护", self._log())

    def test_midwait_yields_to_newer_watchdog(self):
        def takeover_then_running():
            # 第一次轮询时模拟「另一个看护刚写完心跳」→ 本实例必须让位
            self._put_foreign_beat()
            return True

        with patch.object(wd, "zcode_running", side_effect=takeover_then_running):
            rc = wd.main()
        self.assertEqual(rc, 0)
        self.assertIn("让位退出", self._log())
        self.assertNotIn("DONE", self._log(), "让位后绝不能走到重启客户端")


if __name__ == "__main__":
    unittest.main()
