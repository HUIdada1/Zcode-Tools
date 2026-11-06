#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""插件市场更新后「自动重新注入」回归测试（纯标准库 unittest）

要锁死的行为：
  1. 注入版本记录（~/.zcode/pilot/injected.json）能识别市场版本变化；
  2. 记录只在「本目录就是市场安装的当前版本目录」时写入——从仓库/绿色目录手工跑
     sync 不能污染记录，否则会把自己的开发目录误判成一次升级；
  3. 看护在客户端退出时发现版本变化 → 改用**新版插件目录**的 sync.py 重注入，
     绝不用旧目录的 patcher 把旧实现写回去；
  4. 纯监听模式（--watch-plugin-update）没有待办时安静退出，不重启客户端。
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_HERE = Path(__file__).resolve().parent
for _cand in (_HERE.parent / "scripts",
              _HERE.parent / "skills" / "zcode-pilot" / "scripts"):
    if (_cand / "apply_after_exit.py").is_file():
        sys.path.insert(0, str(_cand))
        break

import apply_after_exit as wd  # noqa: E402
import sync  # noqa: E402


class InjectRecordCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="zpatch-injrec-", ignore_cleanup_errors=True)
        self.root = Path(self.tmp.name)
        self.record = self.root / "injected.json"
        self._orig = (sync.INJECT_RECORD, sync.installed_plugin, sync._plugin_root)
        sync.INJECT_RECORD = self.record

    def tearDown(self):
        sync.INJECT_RECORD, sync.installed_plugin, sync._plugin_root = self._orig
        self.tmp.cleanup()

    def test_pending_when_market_version_differs_from_record(self):
        self.record.write_text(json.dumps({"pluginVersion": "0.8.0"}), encoding="utf-8")
        sync.installed_plugin = lambda: {"version": "0.8.1", "root": str(self.root / "new")}
        pending = sync.plugin_update_pending()
        self.assertEqual(pending.get("version"), "0.8.1")
        self.assertEqual(pending.get("from"), "0.8.0")

    def test_no_record_means_no_pending(self):
        sync.installed_plugin = lambda: {"version": "0.8.1", "root": str(self.root / "new")}
        self.assertEqual(sync.plugin_update_pending(), {})

    def test_same_version_means_no_pending(self):
        self.record.write_text(json.dumps({"pluginVersion": "0.8.1"}), encoding="utf-8")
        sync.installed_plugin = lambda: {"version": "0.8.1", "root": str(self.root / "new")}
        self.assertEqual(sync.plugin_update_pending(), {})

    def test_record_is_skipped_when_running_outside_the_market_install(self):
        """开发目录（非市场安装目录）跑 sync 不能写记录，否则会误判升级。"""
        sync.installed_plugin = lambda: {"version": "0.8.1", "root": str(self.root / "install")}
        sync._plugin_root = lambda: self.root / "dev"
        sync.write_inject_record(version="0.8.1", root=str(self.root / "dev"))
        self.assertFalse(self.record.is_file())

    def test_record_written_for_the_market_install(self):
        install = self.root / "install"
        install.mkdir()
        sync.installed_plugin = lambda: {"version": "0.8.1", "root": str(install)}
        sync._plugin_root = lambda: install
        sync.write_inject_record(version="0.8.1")
        self.assertEqual(json.loads(self.record.read_text(encoding="utf-8"))["pluginVersion"],
                         "0.8.1")


class WatchdogUpdateCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="zpatch-updwd-", ignore_cleanup_errors=True)
        self.root = Path(self.tmp.name)
        self.want = self.root / "watchdog.want"
        self.pid = self.root / "watchdog.pid"
        self.log = self.root / "_apply_after_exit.log"
        self._patches = [
            patch.object(wd, "WANT_FILE", self.want),
            patch.object(wd, "PID_FILE", self.pid),
            patch.object(wd, "LOG", self.log),
        ]
        for p in self._patches:
            p.start()
        self._orig = (wd._installed_plugin, wd._inject_record)
        wd.WANT_FILE.parent.mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        wd._installed_plugin, wd._inject_record = self._orig
        for p in reversed(self._patches):
            p.stop()
        self.tmp.cleanup()

    def _log(self) -> str:
        return self.log.read_text(encoding="utf-8") if self.log.is_file() else ""

    def test_watch_only_parses_to_empty_task_list(self):
        """--watch-plugin-update 必须解析成「空任务」，不能落回 DEFAULT_TASKS 把开关全装一遍。"""
        self.assertEqual(wd.parse_wants(["--watch-plugin-update"]), [])

    def test_update_pending_ignores_flagless_instances(self):
        wd._installed_plugin = lambda: {"version": "0.8.1", "root": self.root}
        wd._inject_record = lambda: {"pluginVersion": "0.8.0"}
        self.assertEqual(wd.update_pending(), {}, "没有常驻开关时不应触发更新判定")

    def test_update_pending_detects_version_bump(self):
        (self.root / "watchdog.watch").write_text("0.8.1", encoding="utf-8")
        wd._installed_plugin = lambda: {"version": "0.8.1", "root": self.root}
        wd._inject_record = lambda: {"pluginVersion": "0.8.0"}
        self.assertEqual(wd.update_pending().get("version"), "0.8.1")

    def test_apply_update_runs_new_root_sync_and_confirms_record(self):
        """成功判据 = 新版 sync 写下了新版本记录，而不是退出码。"""
        new_root = self.root / "0.8.1"
        scripts = new_root / "skills" / "zcode-pilot" / "scripts"
        scripts.mkdir(parents=True)
        record = self.root / "injected.json"
        (scripts / "sync.py").write_text(
            "import json, pathlib\n"
            f"pathlib.Path({str(record)!r}).write_text(json.dumps({{'pluginVersion': '0.8.1'}}),"
            " encoding='utf-8')\n",
            encoding="utf-8")
        ok = wd.apply_plugin_update({"version": "0.8.1", "root": str(new_root), "from": "0.8.0"})
        self.assertTrue(ok)
        self.assertIn("改用新版脚本重注入", self._log())

    def test_apply_update_without_sync_script_falls_back(self):
        ok = wd.apply_plugin_update({"version": "0.8.1", "root": str(self.root / "missing"),
                                     "from": "0.8.0"})
        self.assertFalse(ok)

    def test_watch_only_exits_without_restart_when_no_update(self):
        with patch.object(wd, "zcode_running", return_value=False), \
             patch.object(wd, "resolve_install") as resolve, \
             patch.object(sys, "argv", ["apply_after_exit.py", "--watch-plugin-update"]):
            rc = wd.main()
        self.assertEqual(rc, 0)
        self.assertFalse(resolve.called, "没有待办也没有更新时绝不能重启客户端")
        self.assertIn("常驻监听插件市场更新", self._log())


class ReinjectPendingCase(unittest.TestCase):
    """「写入被客户端提前启动打断」必须留痕，并在下次会话明确告诉用户怎么做。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="zpatch-pending-", ignore_cleanup_errors=True)
        self.root = Path(self.tmp.name)
        self._orig = sync.PENDING_FILE
        sync.PENDING_FILE = self.root / "reinject.pending"

    def tearDown(self):
        sync.PENDING_FILE = self._orig
        self.tmp.cleanup()

    def test_mark_read_clear_roundtrip(self):
        self.assertEqual(sync.read_reinject_pending(), {})
        sync.mark_reinject_pending(["tps_footer", "enhance_prompt"])
        self.assertEqual(sync.read_reinject_pending().get("keys"),
                         ["tps_footer", "enhance_prompt"])
        sync.clear_reinject_pending()
        self.assertEqual(sync.read_reinject_pending(), {})

    def test_repack_deferral_marks_pending(self):
        orig = (sync.read_options, sync.declared_defaults, sync.check_state,
                sync.start_watchdog, sync.legacy_cleanup_needed,
                sync.write_inject_record, sync.log)
        try:
            sync.read_options = lambda: ({"tps_footer": True}, "test")
            sync.declared_defaults = lambda: {}
            sync.check_state = lambda args: "stale"
            sync.start_watchdog = lambda wanted: None
            sync.legacy_cleanup_needed = lambda: False
            sync.write_inject_record = lambda *a, **kw: None
            sync.log = lambda msg: None
            sync.run_sync(echo=False)
        finally:
            (sync.read_options, sync.declared_defaults, sync.check_state,
             sync.start_watchdog, sync.legacy_cleanup_needed,
             sync.write_inject_record, sync.log) = orig
        self.assertEqual(sync.read_reinject_pending().get("keys"), ["tps_footer"])

    def test_notice_warns_not_to_open_manually(self):
        text = sync.build_notice(reinject=True)
        self.assertIn("完全退出 ZCode 一次", text)
        self.assertIn("不要手动打开", text)
        upd = sync.build_notice(plugin_version="0.8.2")
        self.assertIn("0.8.2", upd)
        self.assertIn("不要", upd)


if __name__ == "__main__":
    unittest.main()
