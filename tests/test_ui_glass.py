#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""UI 玻璃化与功能下线的回归测试（纯标准库 unittest）

覆盖 2026-11 的五项界面改造：
  ① TPS 双框统一绿色 + 明细毛玻璃 + 无操作自动收起 + 底部边距减半
  ② 增强提示词按钮不再有原生 title；右键菜单毛玻璃
  ③ 模型弹窗加宽从功能矩阵/同步/安装器下线（只保留 --revert 清理）
  ④ 设置页模型拉取按钮/弹窗毛玻璃
  ⑤ 两框都带状态点（右侧与左侧一致）

前端脚本的样式是字符串拼接，`node --check` 抓不到花括号错位或规则被旧样式覆盖；
这里同时跑源码冒烟 + 关键字符串契约，保证 CI 能拦住回退。
"""

import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_HERE = Path(__file__).resolve().parent
_ROOT = _HERE.parent
for _cand in (_ROOT / "scripts",
              _ROOT / "skills" / "zcode-pilot" / "scripts"):
    if (_cand / "zcode-tps.js").is_file():
        _SCRIPTS = _cand
        break
else:  # pragma: no cover
    _SCRIPTS = _ROOT / "skills" / "zcode-pilot" / "scripts"

sys.path.insert(0, str(_SCRIPTS))


def _read(name: str) -> str:
    path = _SCRIPTS / name
    return path.read_text(encoding="utf-8") if path.is_file() else ""


NODE = shutil.which("node")


class UiGlassSmoke(unittest.TestCase):
    def _run_node(self, script: str, target: Path, extra_args=None):
        if not NODE:
            self.skipTest("未安装 node")
        cmd = [NODE, str(_HERE / script), str(target)] + list(extra_args or [])
        r = subprocess.run(cmd, capture_output=True, encoding="utf-8",
                           errors="replace", cwd=str(_ROOT), timeout=120)
        self.assertEqual(r.returncode, 0, (r.stdout or "") + (r.stderr or ""))

    def test_tps_double_chip_glass_smoke(self):
        self._run_node("tps_pct_smoke.js", _SCRIPTS / "zcode-tps.js")

    def test_model_puller_glass_smoke(self):
        self._run_node("puller_glass_smoke.js", _SCRIPTS / "zcode-model-puller.js")

    def test_enhance_button_has_no_native_title(self):
        src = _read("zcode-enhance-prompt.js")
        m = re.search(r"function setButton\(mode\)\s*\{(.*?)\n  \}", src, re.S)
        self.assertIsNotNone(m, "找不到 setButton")
        body = m.group(1)
        self.assertNotIn('btn.setAttribute("title"', body,
                         "润色按钮不得再设置原生 title（用户要求悬浮不弹提示）")
        self.assertIn('btn.setAttribute("aria-label"', body,
                      "去掉 title 后必须保留 aria-label（无障碍）")

    def test_enhance_button_defaults_to_hover_look(self):
        """按钮默认就要是「悬停态」：常驻绿色玻璃高亮，不必先悬停才看得见。"""
        src = _read("zcode-enhance-prompt.js")
        self.assertIn("background:rgba(16,185,129,.12);color:#047857;", src,
                      "按钮基础样式必须是原悬停态的绿色玻璃高亮")
        self.assertIn('box-shadow:inset 0 0 0 1px rgba(16,185,129,.22);"', src,
                      "按钮默认缺少悬停态的内描边")
        self.assertIn("background:rgba(16,185,129,.18)", src,
                      "悬停态应在默认高亮上再加深一档（保留交互反馈）")
        self.assertNotIn("background:transparent;cursor:pointer;", src,
                         "按钮默认不应再是全透明（即用户反馈的「看不见」）")

    def test_enhance_menu_is_glass(self):
        src = _read("zcode-enhance-prompt.js")
        for needle in ("backdrop-filter:blur(24px)", "zenhance-menu-foot",
                       "--ze-accent", "zenhanceMenuIn",
                       "zenhance-menu-item[data-active='1']::before"):
            self.assertIn(needle, src, needle)

    def test_tps_has_auto_close_and_green_both(self):
        src = _read("zcode-tps.js")
        for needle in ("POP_AUTO_CLOSE_MS", "armPopTimer", "visibilitychange",
                       "--ztps-green-strong", "--ztps-green-soft",
                       'marginTop: "3px"'):
            self.assertIn(needle, src, needle)
        self.assertRegex(src, r"fmtTok\(totalTok\)[\s\S]{0,160}\{ dot: true \}",
                         "右侧 Token 框必须和左侧一样带状态点")
        self.assertNotIn("width:20rem!important", src,
                         "模型弹窗加宽的 CSS 覆盖必须删掉")

    def test_model_width_is_offline_everywhere(self):
        import apply_after_exit as aae
        import sync
        import zcode_patcher as zp

        self.assertNotIn("model_width", zp.ALL_PATCH_FLAGS,
                         "已下线的 model_width 不能回到 --all 安装列表")
        self.assertIn("model_width", zp.LEGACY_PATCH_FLAGS,
                      "必须保留 --all --revert 的 legacy 还原能力")
        self.assertNotIn("model_width", [k for k, _a, _r in sync.PATCHES],
                         "sync 不能再把 model_width 当可安装功能")
        self.assertNotIn("model_width", aae.PATCH_ARGS,
                         "看护不能把 model_width 当可安装功能")
        self.assertIn("cleanup_model_width", aae.PATCH_ARGS,
                      "看护必须保留一次性的模型加宽还原入口")
        with tempfile.TemporaryDirectory() as d:
            with patch.object(aae, "WANT_FILE", Path(d) / "_watchdog.want"):
                self.assertEqual(aae.parse_wants(["--want=cleanup_model_width=off"]),
                                 [(["--model-width"], True)],
                                 "cleanup_model_width=off 必须转成 --model-width --revert")

    def test_sync_schedules_one_time_model_width_revert(self):
        import sync

        captured = {}
        with patch.object(sync, "resolve_wanted", return_value=({"model_width": True}, "test")), \
             patch.object(sync, "check_state", return_value="on"), \
             patch.object(sync, "start_watchdog", side_effect=lambda w: captured.update(w)), \
             patch.object(sync, "log", return_value=None), \
             patch.object(sync, "write_inject_record", return_value=None), \
             patch.object(sync, "mark_reinject_pending", return_value=None), \
             patch.object(sync, "clear_reinject_pending", return_value=None):
            sync.run_sync()
        self.assertEqual(captured.get("cleanup_model_width"), False,
                         "检测到残留时必须排一次清理（enabled=False → --model-width --revert）")
        self.assertNotIn("model_width", captured,
                         "不能把已下线的 model_width 重新排成安装任务")


if __name__ == "__main__":
    unittest.main()
