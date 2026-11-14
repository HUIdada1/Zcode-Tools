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

    def test_tps_host_mounts_outside_scroll_clip_and_hugs_bottom(self):
        """胶囊必须挂到滚动容器之外才能真正贴底（2026-11-13 两轮用户实测定案）。

        CDP 实测（ZCode 3.18.2）：`.v4-timeline` 是 overflow-y:auto 的滚动容器，
        composer dock 是它里面的 `position:sticky; bottom:0`。
        ① 宿主用 transform 位移 → 不参与布局高度，往上滚被 overflow 裁掉 6px（“遮挡一半”）。
        ② 宿主留在时间线内、只调 margin → 永远被裁在时间线底边，而那条边距窗体底还隔着
           父容器 pb-4(16px)+窗体(7px)，怎么调都“悬空/太高”。
        正解：把宿主挂到 v4-timeline **之外**作 flex 兄弟，再用「负 margin-bottom =
        父容器底部 padding」拉进 padding 区 —— 实测距窗体底 7px，时间线 flex-1 自动让位，
        无裁切、不压输入卡片。找不到时间线时退回卡片后的旧落点。
        """
        src = _read("zcode-tps.js")
        m = re.search(r"function attach\(host\) \{(.*?)\n  \}", src, re.S)
        self.assertIsNotNone(m, "找不到 attach()")
        body = m.group(1)
        self.assertFalse(re.search(r"transform:\s*[\"']", body),
                         "宿主内联样式禁止 transform：sticky dock 下它会越过滚动容器底边被裁")
        # 必须挂到滚动容器之外（否则永远到不了窗体底）
        self.assertIn('v4-timeline', body, "attach() 必须定位 v4-timeline 以挂到滚动容器之外")
        self.assertIn('insertAdjacentElement("afterend", host)', body)
        # 负 margin-bottom 把宿主拉进父容器底部 padding 区（贴底的关键）
        self.assertIn("paddingBottom", body, "必须读取父容器底部 padding 以计算负 margin")
        self.assertIn("marginBottom: (-padB)", body, "缺少贴底所需的负 margin-bottom")
        # 找不到时间线时的兜底落点仍要占布局、不用 transform
        self.assertIn('alignSelf: "stretch"', body, "兜底落点缺少与卡片同宽的 alignSelf")
        # 样式改版必须同步递增 LAYOUT_V，否则已挂载的旧宿主走快路径拿不到新内联样式
        self.assertRegex(src, r'const LAYOUT_V = "ztps-layout-\d+"',
                         "LAYOUT_V 缺失：attach() 的内联样式无法绕过快路径刷新")
        self.assertIn('host.getAttribute("data-ztps-layout") === LAYOUT_V', body,
                      "快路径必须校验布局版本")
        # 半透明胶囊会被滚过的正文透视遮挡：渐变下必须垫一层不透明画布色
        self.assertIn("--ztps-canvas", src, "缺少不透明画布色变量")
        self.assertIn("background-color:var(--ztps-canvas);", src,
                      "chip 必须有不透明底色垫在绿色渐变下")

    def test_model_width_is_offline_everywhere(self):
        import zcp_watchdog as aae
        import zcp_sync
        import zcp_patcher as zp

        self.assertNotIn("model_width", zp.ALL_PATCH_FLAGS,
                         "已下线的 model_width 不能回到 --all 安装列表")
        self.assertIn("model_width", zp.LEGACY_PATCH_FLAGS,
                      "必须保留 --all --revert 的 legacy 还原能力")
        self.assertNotIn("model_width", [k for k, _a, _r in zcp_sync.PATCHES],
                         "zcp_sync 不能再把 model_width 当可安装功能")
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
        import zcp_sync

        captured = {}
        with patch.object(zcp_sync, "resolve_wanted", return_value=({"model_width": True}, "test")), \
             patch.object(zcp_sync, "check_state", return_value="on"), \
             patch.object(zcp_sync, "start_watchdog", side_effect=lambda w: captured.update(w)), \
             patch.object(zcp_sync, "log", return_value=None), \
             patch.object(zcp_sync, "write_inject_record", return_value=None), \
             patch.object(zcp_sync, "mark_reinject_pending", return_value=None), \
             patch.object(zcp_sync, "clear_reinject_pending", return_value=None):
            zcp_sync.run_sync()
        self.assertEqual(captured.get("cleanup_model_width"), False,
                         "检测到残留时必须排一次清理（enabled=False → --model-width --revert）")
        self.assertNotIn("model_width", captured,
                         "不能把已下线的 model_width 重新排成安装任务")


if __name__ == "__main__":
    unittest.main()
