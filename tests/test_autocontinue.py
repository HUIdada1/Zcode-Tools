#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""「自动继续 + 循环守卫」回归测试（纯标准库 unittest）

覆盖契约 docs/CONTRACT.md 的新增能力：
  §2.2 状态文件（写者分工 / 原子写 / 读-改-写 / 关闭保存即暂停并作废队列）
  §2.3 续跑主通道（Stop / UserPromptSubmit hook、判定表、宽限/冷却/上限）
  §3   默认计时常量（3000 / 20000 / 3；设置页可覆盖）
  §4   9 条文案（含与渲染层 zcode-pilot.js 的逐字一致性）
  §5   UI 落点（模式切换右侧开关、会话区状态同步）

为什么必须测：这一层的失败方式全部是**静默**的——stdout 多写一个字符会把 traceback
灌进模型上下文（Stop 下退出码 2 等价于 block），状态文件整体覆盖会抹掉渲染层的
journal，计数没按 session 分桶会让多会话互相顶掉额度。这些都不会在界面上露头。
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

# 兼容两种仓库布局：扁平（scripts/）与插件（skills/zcode-pilot/scripts/）
_HERE = Path(__file__).resolve().parent
for _cand in (_HERE.parent / "scripts",
              _HERE.parent / "skills" / "zcode-pilot" / "scripts"):
    if (_cand / "zcp_hook.py").is_file():
        sys.path.insert(0, str(_cand))
        _SCRIPTS = _cand
        break
else:  # pragma: no cover
    _SCRIPTS = _HERE.parent / "skills" / "zcode-pilot" / "scripts"

import zcp_hook as hook   # noqa: E402
import zcp_loopguard                   # noqa: E402
import zcp_sync                        # noqa: E402

PILOT_JS = _SCRIPTS / "zcode-pilot.js"
HOOK_PY = _SCRIPTS / "zcp_hook.py"
REPO_ROOT = _HERE.parent


# ------------------------------------------------------------------ 夹具

def write_jsonl(path: Path, rows) -> Path:
    with open(path, "w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    return path


def tool_use(turn: int, name: str = "read_file", **arguments) -> dict:
    return {"type": "tool_use", "id": "tu-%d" % turn, "name": name,
            "input": dict(arguments)}


def tool_result(turn: int, text: str, is_error: bool = False) -> dict:
    return {"type": "tool_result", "tool_use_id": "tu-%d" % turn,
            "content": text, "is_error": is_error}


def loop_transcript(path: Path, repeat: int, name: str = "read_file",
                    path_arg: str = "a.txt", results=None) -> Path:
    """造一份「尾部连续 repeat 次同指纹工具调用」的转录。"""
    rows = []
    for i in range(repeat):
        rows.append({"message": {"role": "assistant",
                                 "content": [tool_use(i, name, path=path_arg)]}})
        if results is not None:
            rows.append({"message": {"role": "user",
                                     "content": [tool_result(i, results[i])]}})
    return write_jsonl(path, rows)


class StateFileCase(unittest.TestCase):
    """把 hook 的状态文件重定向到临时目录（`PILOT_STATE_FILE`），绝不碰真实 `~/.zcode`。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.state_file = Path(self._tmp.name) / "state.json"
        env = patch.dict(os.environ, {"PILOT_STATE_FILE": str(self.state_file),
                                      "PILOT_HOOK_DEBUG_LOG": ""})
        env.start()
        self.addCleanup(env.stop)

    def seed(self, **fields) -> dict:
        state = hook.default_state()
        state.update(fields)
        self.state_file.write_text(json.dumps(state, ensure_ascii=False),
                                   encoding="utf-8")
        return state

    def load(self) -> dict:
        return json.loads(self.state_file.read_text(encoding="utf-8"))

    def run_stop(self, payload: dict, state: dict):
        """跑一次 handle_stop，屏蔽真实 sleep；返回 (sleep mock, emit 收到的最后对象)。"""
        emitted: list = []
        with patch.object(hook.time, "sleep") as slp, \
             patch.object(hook, "emit", side_effect=lambda o: emitted.append(o)):
            hook.handle_stop(payload, state)
        return slp, (emitted[-1] if emitted else None)


def read_script(name: str) -> str:
    """注入脚本源码（带缓存）：断言渲染层与 hook 两侧一致时用。"""
    path = _SCRIPTS / name
    return path.read_text(encoding="utf-8") if path.is_file() else ""


def code_only(src: str) -> str:
    """剥掉块注释与行注释，只留可执行代码。

    「绝不调用 port.start()」这类硬约束在源码里**本身就以注释形式反复出现**，
    直接 assertNotIn 会永远失败；只有注释之外的调用才算违规。
    """
    no_block = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    kept = [re.sub(r"//.*$", "", line) for line in no_block.splitlines()]
    return "\n".join(line for line in kept if line.strip())


def js_texts() -> dict:
    """把 JS 里的 `const TEXTS = { 1: "...", ... }` 解析成 {int: str}。"""
    src = read_script("zcode-pilot.js")
    m = re.search(r"const TEXTS\s*=\s*\{(.*?)\n  \};", src, re.S)
    if m is None:
        raise AssertionError("zcode-pilot.js 里找不到 TEXTS 文案表")
    out = {}
    for key, value in re.findall(r'(\d+)\s*:\s*"((?:[^"\\]|\\.)*)"', m.group(1)):
        out[int(key)] = json.loads('"%s"' % value)
    return out



# ================================================================== 契约 §3 / §4

class TestTimingConstants(StateFileCase):
    """§3 三个默认计时值必须与 dsh-client-auto-continue 对齐；设置页可覆盖。"""

    def test_grace_cooldown_max_streak(self):
        # 2026-11 起对齐 dsh-client-auto-continue 默认值：3s / 20s / 3 次。
        self.assertEqual(hook.GRACE_MS, 3000)
        self.assertEqual(hook.COOLDOWN_MS, 20000)
        self.assertEqual(hook.MAX_CONSECUTIVE, 3)
        self.assertEqual(hook.RESULT_MAX_CHARS, 300)

    def test_render_layer_agrees_on_max_streak(self):
        """渲染层默认上限必须与 hook 同源，否则界面数字与真实熔断点不一致。"""
        self.assertIn("MAX_CONSECUTIVE = 3", read_script("zcode-pilot.js"))


class TestSessionModes(StateFileCase):
    """dsh-client-auto-continue 的会话模式：默认 recover，loop 才自主接力。"""

    @staticmethod
    def normal_payload(sid="s"):
        return {"session_id": sid, "last_assistant_message": "正常收尾", "toolCallCount": 2}

    def test_default_mode_recover_does_not_continue_completed_turn(self):
        self.seed()
        _slp, emitted = self.run_stop(self.normal_payload(), hook.read_state())
        self.assertIsNone(emitted, "默认仅故障恢复：正常完成的回合不该被续跑")

    def test_settings_default_mode_loop_continues_completed_turn(self):
        self.seed(settings={"defaultMode": "loop"})
        _slp, emitted = self.run_stop(self.normal_payload(), hook.read_state())
        self.assertEqual(emitted["reason"], "继续")

    def test_session_mode_loop_continues_and_keeps_streak(self):
        self.seed(sessions={"s": {"mode": "loop", "consecutive": 2, "lastAt": 0}})
        _slp, emitted = self.run_stop(self.normal_payload(), hook.read_state())
        self.assertEqual(emitted["reason"], "继续")
        self.assertEqual(self.load()["sessions"]["s"]["consecutive"], 2,
                         "自主循环的正常接力不计入连续上限")

    def test_session_mode_off_skips_even_failures(self):
        self.seed(sessions={"s": {"mode": "off"}})
        _slp, emitted = self.run_stop(
            {"session_id": "s", "status": "cancelled"}, hook.read_state())
        self.assertIsNone(emitted)

    def test_session_modes_are_isolated(self):
        self.seed(sessions={"a": {"mode": "off"}, "b": {"mode": "recover"}})
        _slp, emitted = self.run_stop(
            {"session_id": "b", "status": "cancelled"}, hook.read_state())
        self.assertEqual(emitted["reason"], "继续")
        self.assertEqual(self.load()["sessions"]["a"], {"mode": "off"},
                         "别的会话的模式被改写了")

    def test_legacy_runtime_false_is_off_until_session_mode_is_set(self):
        cfg = hook.settings_of({})
        self.assertEqual(hook.session_mode_of({"runtime": False, "sessions": {}}, "s", cfg), "off")
        self.assertEqual(hook.session_mode_of({"runtime": True, "sessions": {}}, "s", cfg), "recover")
        self.assertEqual(hook.session_mode_of(
            {"sessions": {"s": {"mode": "loop"}}}, "s", cfg), "loop")

    def test_explicit_session_mode_overrides_legacy_runtime(self):
        """老用户 runtime=false 后，把当前会话切回开启必须真的生效。"""
        self.seed(runtime=False, sessions={"s": {"mode": "default"}})
        _slp, emitted = self.run_stop(
            {"session_id": "s", "status": "cancelled"}, hook.read_state())
        self.assertEqual(emitted["reason"], "继续")


class TestSettingsBehaviour(StateFileCase):
    """设置页写入的 settings 必须真的改变 hook 行为。"""

    def test_resume_silent_turns_off_skips_no_output(self):
        self.seed(settings={"resumeSilentTurns": False})
        _slp, emitted = self.run_stop({
            "session_id": "s", "last_assistant_message": "",
            "toolCallCount": 0, "output_tokens": 0,
        }, hook.read_state())
        self.assertIsNone(emitted, "关闭静默续跑后，无输出回合不该继续")

    def test_guard_tools_off_removes_guard_text(self):
        p = write_jsonl(Path(self._tmp.name) / "guard.jsonl", [
            {"message": {"content": [tool_use(1, "read_file", path="x")]}},
            {"message": {"content": [tool_result(1, "内容OK")]}},
        ])
        self.seed(settings={"defaultMode": "loop", "guardTools": False})
        _slp, emitted = self.run_stop(
            {"session_id": "s", "transcript_path": str(p),
             "last_assistant_message": "看到了"}, hook.read_state())
        self.assertEqual(emitted["reason"], "继续", "关闭护栏后不该追加护栏文")

    def test_max_consecutive_override(self):
        self.seed(settings={"maxConsecutive": 1},
                  sessions={"s": {"consecutive": 1}})
        _slp, emitted = self.run_stop(
            {"session_id": "s", "status": "cancelled"}, hook.read_state())
        self.assertEqual(emitted["reason"], "继续")
        self.assertEqual(self.load()["sessions"]["s"]["consecutive"], 0,
                         "自定义上限命中后必须清零")

    def test_loop_guard_off_skips_loop_detection(self):
        p = loop_transcript(Path(self._tmp.name) / "loop.jsonl", 3, path_arg="same.txt")
        self.seed(settings={"loopGuard": False, "continueTextInterrupted": "恢复"})
        _slp, emitted = self.run_stop(
            {"session_id": "s", "transcript_path": str(p), "status": "cancelled",
             "last_assistant_message": "x"}, hook.read_state())
        self.assertTrue(emitted["reason"].startswith("恢复"),
                        "关闭循环守卫后应按中断分支续跑，而不是循环提示")
        self.assertNotIn(hook.TEXT_LOOP, emitted["reason"])

    def test_settings_of_rejects_bad_values(self):
        cfg = hook.settings_of({"settings": {
            "defaultMode": "bad", "graceMs": -1, "cooldownMs": "x",
            "maxConsecutive": 0, "guardTools": "yes", "continueText": "   ",
        }})
        self.assertEqual(cfg, hook.DEFAULT_SETTINGS)

    def test_defaults_align_with_dsh_auto_continue(self):
        self.assertEqual(hook.DEFAULT_SETTINGS["defaultMode"], "recover")
        self.assertEqual(hook.DEFAULT_SETTINGS["graceMs"], 3000)
        self.assertEqual(hook.DEFAULT_SETTINGS["cooldownMs"], 20000)
        self.assertEqual(hook.DEFAULT_SETTINGS["maxConsecutive"], 3)
        self.assertTrue(hook.DEFAULT_SETTINGS["resumeSilentTurns"])
        self.assertTrue(hook.DEFAULT_SETTINGS["guardTools"])
        self.assertTrue(hook.DEFAULT_SETTINGS["loopGuard"])


class TestSettingsTabStatic(unittest.TestCase):
    """设置页侧边 tab 与按会话开关的静态契约（行为冒烟见 pilot_mount_smoke.js）。"""

    @classmethod
    def setUpClass(cls):
        cls.src = read_script("zcode-pilot.js")

    def test_settings_tab_selectors_present(self):
        for needle in ('[data-testid="settings-page"]', "aside nav",
                       "[data-settings-panel-frame]", "data-zpilot-settings-nav",
                       "data-zpilot-settings-panel"):
            self.assertIn(needle, self.src, needle)

    def test_toggle_writes_session_mode(self):
        self.assertIn("patchState({ sessionMode: { id: sid, mode: next } })", self.src)

    def test_renderer_defaults_align_with_dsh(self):
        self.assertIn('defaultMode: "recover"', self.src)
        self.assertIn("graceMs: 3000", self.src)
        self.assertIn("cooldownMs: 20000", self.src)
        self.assertIn("maxConsecutive: 3", self.src)


class TestFailedTurnFallback(unittest.TestCase):
    """TurnError 兜底：官方 Stop hook 只在成功路径触发，失败轮次必须由渲染层补发。

    这一组是「跨层契约」：hook 默认值、主进程 settings 白名单、渲染层事件判定
    三处任一漏改，失败轮次都会静默不续跑（界面上只看到一条报错，没有任何提示）。
    """

    def test_hook_defaults_carry_resume_failed_turns(self):
        self.assertTrue(hook.DEFAULT_SETTINGS["resumeFailedTurns"])
        self.assertIn("resumeFailedTurns", hook._BOOL_KEYS)

    def test_renderer_detects_failed_turn_and_sends(self):
        src = read_script("zcode-pilot.js")
        for needle in ('resumeFailedTurns', "function handleFailedTurn",
                       'state === "failed"', "function attemptResumeFailedTurn",
                       "errorResumeResult", "whyFailedWouldResume"):
            self.assertIn(needle, src, needle)
        # 用户主动停止不是 TurnError，绝不能进兜底分支
        self.assertNotIn('state === "completedInterrupted") handleFailedTurn', src)

    def test_main_handler_whitelists_resume_failed_turns(self):
        patcher = (_SCRIPTS / "zcp_patcher.py").read_text(encoding="utf-8")
        self.assertIn("resumeFailedTurns:!0", patcher)
        self.assertIn('"resumeFailedTurns","guardTools"', patcher)


class TestNineTexts(StateFileCase):
    """§4 九条文案是「唯一文案表」，标点都算契约内容。"""

    def test_continue_family_is_bare_continue(self):
        # 1 中断 / 2 超限 / 3 token 上限 / 4 无输出 / 6 自主续跑
        for name in ("TEXT_INTERRUPTED", "TEXT_OVER_LIMIT", "TEXT_MAX_TOKENS",
                     "TEXT_NO_OUTPUT", "TEXT_AUTONOMOUS"):
            self.assertEqual(getattr(hook, name), "继续", name)

    def test_reasoning_only_and_loop_texts_verbatim(self):
        self.assertEqual(
            hook.TEXT_REASONING_ONLY,
            "你上一轮只输出内部推理，无回复也无工具调用，用户什么都没看到。"
            "每一轮须以工具调用或可见回复结束。")
        self.assertEqual(hook.TEXT_LOOP, "检测到循环，停止重复刚才动作，换方式继续")

    def test_guard_templates_placeholders(self):
        self.assertEqual(
            hook.GUARD_PENDING, "上一步工具「{tool}」可能未完成，先确认状态再继续，勿重复执行")
        self.assertEqual(
            hook.GUARD_DONE, "上一步工具「{tool}」已完成，结果:{result}。勿重复执行，直接继续")
        # 渲染层只填 {tool}，不能把 {result} 漏进最终上下文
        self.assertNotIn("{result}", hook.GUARD_PENDING.format(tool="x"))
        self.assertNotIn("{tool}", hook.GUARD_DONE.format(tool="x", result="y"))

    def test_js_table_matches_python_verbatim(self):
        """渲染层（崩溃恢复路径）与 hook（正常路径）必须发同一套文本。"""
        js = js_texts()
        self.assertEqual(sorted(js), list(range(1, 10)), "JS 文案表必须齐 9 条")
        pairs = {1: hook.TEXT_INTERRUPTED, 2: hook.TEXT_OVER_LIMIT,
                 3: hook.TEXT_MAX_TOKENS, 4: hook.TEXT_NO_OUTPUT,
                 5: hook.TEXT_REASONING_ONLY, 6: hook.TEXT_AUTONOMOUS,
                 7: hook.GUARD_PENDING, 8: hook.GUARD_DONE, 9: hook.TEXT_LOOP}
        for num, py_text in pairs.items():
            self.assertEqual(js[num], py_text, "第 %d 条文案两侧不一致" % num)

    def test_recovery_uses_default_continue(self):
        self.assertIn('const RECOVER_TEXT = TEXTS[6]', read_script("zcode-pilot.js"))


# ================================================================== 契约 §2.2 状态文件

class TestStateFileReadWrite(StateFileCase):

    def test_missing_file_yields_defaults(self):
        st = hook.read_state()
        self.assertEqual(st["enabled"], True)
        self.assertEqual(st["runtime"], True)
        self.assertEqual(st["paused"], False)
        self.assertEqual(st["cancelToken"], 0)
        self.assertEqual(st["lastContinueAt"], 0)
        self.assertEqual(st["sessions"], {})
        self.assertEqual(st["journal"], {})

    def test_broken_json_falls_back_to_defaults(self):
        self.state_file.write_text("{ 这不是 JSON", encoding="utf-8")
        self.assertEqual(hook.read_state(), hook.default_state())

    def test_partial_file_is_padded_not_replaced(self):
        self.state_file.write_text(json.dumps({"runtime": False}), encoding="utf-8")
        st = hook.read_state()
        self.assertEqual(st["runtime"], False)      # 别人写的字段保住
        self.assertEqual(st["enabled"], True)       # 缺的补齐

    def test_sessions_journal_type_guard(self):
        self.state_file.write_text(json.dumps({"sessions": "x", "journal": []}),
                                   encoding="utf-8")
        st = hook.read_state()
        self.assertEqual((st["sessions"], st["journal"]), ({}, {}))

    def test_write_is_atomic_and_leaves_no_temp(self):
        self.assertTrue(hook.write_state(hook.default_state()))
        self.assertEqual(json.loads(self.state_file.read_text(encoding="utf-8"))["version"], 1)
        leftovers = [p.name for p in self.state_file.parent.iterdir()
                     if ".tmp-" in p.name]
        self.assertEqual(leftovers, [], "残留临时文件说明写入没有 replace 掉")

    def test_write_failure_is_silent_false(self):
        # 父目录无法建立（被普通文件挡住）→ 返回 False，绝不抛异常
        # （抛了就是 exit 2 = 把 traceback 当续跑文本灌给模型）
        blocker = self.state_file.parent / "blocker"
        blocker.write_text("x", encoding="utf-8")
        with patch.object(hook, "state_path",
                          return_value=blocker / "sub" / "state.json"):
            self.assertFalse(hook.write_state({"version": 1}))

    def test_env_redirect_precedence(self):
        with patch.dict(os.environ, {"PILOT_STATE_FILE": "/a/state.json",
                                     "PILOT_STATE_DIR": "/b"}):
            self.assertEqual(hook.state_path(), Path("/a/state.json"))
        with patch.dict(os.environ, {"PILOT_STATE_FILE": "",
                                     "PILOT_STATE_DIR": "/b"}):
            self.assertEqual(hook.state_path(), Path("/b/state.json"))


class TestSyncWritesPilotState(unittest.TestCase):
    """§2.2 写者分工：zcp_sync.py 只碰 enabled/paused/cancelToken，关闭即作废队列。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name) / "pilot"
        self.file = self.dir / "state.json"
        self.patcher = patch.multiple(zcp_sync, PILOT_DIR=self.dir, PILOT_STATE=self.file)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def seed(self, obj):
        self.dir.mkdir(parents=True, exist_ok=True)
        self.file.write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")

    def load(self):
        return json.loads(self.file.read_text(encoding="utf-8"))

    def test_enable_on_fresh_state_writes_nothing(self):
        """幂等：状态文件缺失 == 契约默认值 == 已开启，不该凭空造一个文件。
        （hook 与渲染层都把「缺文件」读成 enabled=true，写盘纯属多余。）"""
        self.assertEqual(zcp_sync.write_pilot_state(True), "")
        self.assertFalse(self.file.exists())

    def test_enable_creates_file_only_when_state_differs(self):
        self.seed({"enabled": False, "paused": True, "cancelToken": 1})
        zcp_sync.write_pilot_state(True)
        st = self.load()
        self.assertEqual((st["enabled"], st["paused"], st["cancelToken"]), (True, False, 1))

    def test_disable_pauses_and_bumps_cancel_token(self):
        self.seed({"version": 1, "enabled": True, "runtime": True, "paused": False,
                   "cancelToken": 3, "lastContinueAt": 111,
                   "sessions": {"s1": {"consecutive": 2, "lastAt": 9}},
                   "journal": {"s1": {"turnId": "t9", "text": "继续"}}})
        zcp_sync.write_pilot_state(False)
        st = self.load()
        self.assertEqual((st["enabled"], st["paused"]), (False, True))
        self.assertEqual(st["cancelToken"], 4, "关闭保存必须递增令牌以作废排队继续")

    def test_reenable_clears_pause_without_bumping_token(self):
        self.seed({"enabled": False, "paused": True, "cancelToken": 7, "runtime": True})
        zcp_sync.write_pilot_state(True)
        st = self.load()
        self.assertEqual((st["enabled"], st["paused"], st["cancelToken"]), (True, False, 7))

    def test_disable_is_idempotent_on_token(self):
        """已关闭时再关一次绝不能再 +1——否则每次开会话都白作废一次队列。"""
        self.seed({"enabled": False, "paused": True, "cancelToken": 5})
        before = self.file.read_text(encoding="utf-8")
        self.assertEqual(zcp_sync.write_pilot_state(False), "")
        self.assertEqual(self.load()["cancelToken"], 5)
        self.assertEqual(self.file.read_text(encoding="utf-8"), before, "无需改动却写了盘")

    def test_other_writers_fields_survive(self):
        self.seed({"enabled": True, "paused": False, "cancelToken": 0, "runtime": False,
                   "lastContinueAt": 999, "sessions": {"a": {"consecutive": 4}},
                   "journal": {"a": {"turnId": "x"}}, "unknownFutureField": {"k": 1}})
        zcp_sync.write_pilot_state(False)
        st = self.load()
        self.assertEqual(st["runtime"], False, "覆盖了渲染层的 runtime")
        self.assertEqual(st["lastContinueAt"], 999, "覆盖了 hook 的冷却时间戳")
        self.assertEqual(st["sessions"], {"a": {"consecutive": 4}}, "覆盖了 hook 的计数")
        self.assertEqual(st["journal"], {"a": {"turnId": "x"}}, "覆盖了崩溃恢复台账")
        self.assertEqual(st["unknownFutureField"], {"k": 1}, "丢字段")

    def test_corrupt_state_is_rewritten_from_defaults(self):
        """坏 JSON 不能把开关同步整个带崩：按默认值补齐后照常写出合法状态。"""
        self.dir.mkdir(parents=True, exist_ok=True)
        self.file.write_text("{坏 JSON", encoding="utf-8")
        zcp_sync.write_pilot_state(False)
        st = self.load()
        self.assertEqual((st["enabled"], st["paused"], st["cancelToken"]), (False, True, 1))

    def test_non_int_token_is_normalized(self):
        self.seed({"enabled": True, "paused": False, "cancelToken": "abc"})
        zcp_sync.write_pilot_state(False)
        self.assertEqual(self.load()["cancelToken"], 1)

    def test_write_failure_returns_note_and_never_raises(self):
        """写状态文件失败必须只回一句原因——绝不能拖垮整次配置同步。"""
        blocker = Path(self._tmp.name) / "blocker"
        blocker.write_text("x", encoding="utf-8")
        self.seed({"enabled": True, "paused": False, "cancelToken": 0})
        with patch.object(zcp_sync, "PILOT_DIR", Path(self._tmp.name) / "pilot"), \
             patch.object(zcp_sync, "PILOT_STATE", blocker / "sub" / "state.json"):
            note = zcp_sync.write_pilot_state(False)     # 关闭 → 必须写盘 → 落点不可用
        self.assertIn("状态文件写入失败", note)

    def test_sync_writes_state_before_any_repack(self):
        """关闭要**立刻**生效（不等客户端退出）：run_sync 必须在动 app.asar 之前写状态文件。"""
        src = (_SCRIPTS / "zcp_sync.py").read_text(encoding="utf-8")
        self.assertLess(src.index("write_pilot_state(bool(wanted[\"auto_continue\"]))"),
                        src.index("for key, args, repack in PATCHES:"),
                        "状态文件晚于补丁循环 → 关闭后已排队的继续不会被及时作废")


# ================================================================== 前置开关 §2.3

class TestGate(StateFileCase):

    def test_armed_allows(self):
        self.assertEqual(hook.gate(hook.default_state()), "")

    def test_three_blockers(self):
        self.assertEqual(hook.gate({**hook.default_state(), "enabled": False}), "disabled")
        self.assertEqual(hook.gate({**hook.default_state(), "paused": True}), "paused")
        self.assertEqual(hook.gate({**hook.default_state(), "runtime": False}),
                         "runtime-off")

    def test_precedence_enabled_first(self):
        self.assertEqual(hook.gate({"enabled": False, "paused": True, "runtime": False}),
                         "disabled")

    def test_loose_boolean_forms(self):
        for truthy in ("true", "ON", 1):
            self.assertEqual(hook.gate({"enabled": truthy, "runtime": truthy}), "")
        for falsy in ("false", "off", 0, ""):
            self.assertEqual(hook.gate({"enabled": falsy}), "disabled")

    def test_missing_fields_default_to_enabled(self):
        self.assertEqual(hook.gate({}), "")

    def test_zcp_loopguard_not_called_when_switch_off(self):
        """契约 §2.3：关闭自动继续时循环守卫必须同步失效（不许白读转录）。"""
        payload = {"session_id": "s", "transcript_path": "whatever.jsonl"}
        state = hook.default_state()
        state["enabled"] = False
        with patch.object(hook.zcp_loopguard, "detect",
                          side_effect=AssertionError("不该被调用")) as det, \
             patch.object(hook.zcp_loopguard, "load_transcript",
                          side_effect=AssertionError("不该被调用")):
            slp, emitted = self.run_stop(payload, state)
        self.assertEqual(det.call_count, 0)
        self.assertEqual(emitted, None)
        self.assertEqual(slp.call_count, 0, "关闭态还阻塞宽限期")


class TestCooldown(StateFileCase):

    def test_boundaries(self):
        now = hook.now_ms()
        self.assertTrue(hook.in_cooldown({"lastContinueAt": now}, now))
        self.assertTrue(hook.in_cooldown({"lastContinueAt": now - 19999}, now))
        self.assertFalse(hook.in_cooldown({"lastContinueAt": now - 20000}, now))

    def test_never_continued_is_not_cooling(self):
        self.assertFalse(hook.in_cooldown({"lastContinueAt": 0}, hook.now_ms()))

    def test_garbage_timestamp_is_not_cooling(self):
        self.assertFalse(hook.in_cooldown({"lastContinueAt": "nonsense"}, hook.now_ms()))

    def test_cooling_stop_outputs_nothing(self):
        self.seed(lastContinueAt=hook.now_ms())
        slp, emitted = self.run_stop({"session_id": "s"}, hook.read_state())
        self.assertEqual(emitted, None)
        self.assertEqual(slp.call_count, 0, "冷却中也白等 5 秒，会拖慢整轮收尾")


class TestConsecutiveBucketing(StateFileCase):

    def test_per_session_isolation(self):
        state = {"sessions": {"a": {"consecutive": 5}, "b": {"consecutive": 1}}}
        self.assertEqual(hook.consecutive_of(state, "a"), 5)
        self.assertEqual(hook.consecutive_of(state, "b"), 1)
        self.assertEqual(hook.consecutive_of(state, "missing"), 0)

    def test_tolerates_junk(self):
        self.assertEqual(hook.consecutive_of({"sessions": "x"}, "a"), 0)
        self.assertEqual(hook.consecutive_of({"sessions": {"a": "x"}}, "a"), 0)
        self.assertEqual(hook.consecutive_of({"sessions": {"a": {"consecutive": -3}}}, "a"), 0)
        self.assertEqual(hook.consecutive_of({"sessions": {"a": {"consecutive": "z"}}}, "a"), 0)

    def test_session_id_sources(self):
        self.assertEqual(hook.session_id({"session_id": " s1 "}), "s1")
        self.assertEqual(hook.session_id({"conversationId": "c1"}), "c1")
        with patch.dict(os.environ, {"ZCODE_SESSION_ID": "env1"}):
            self.assertEqual(hook.session_id({}), "env1")
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(hook.session_id({}), "default")


# ================================================================== 判定表 §2.3.3

class TestDecideTable(StateFileCase):

    def t(self, **kw):
        # decide(payload, state, data, consecutive)：state 只服务序 1 之外的前置，判定表本身不读
        return hook.decide(kw.get("payload", {}), {}, kw.get("data", {}),
                           kw.get("consecutive", 0))

    def setUp(self):
        super().setUp()
        self._tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmpdir.cleanup)

    def test_row1_over_limit_before_everything(self):
        """连续触发到上限 → 超限文本（#2）且 over_limit=True（随后清零并停）。"""
        payload = {"last_assistant_message": "还没写完", "toolCallCount": 3,
                   "status": "cancelled"}
        text, over, branch = self.t(payload=payload, consecutive=hook.MAX_CONSECUTIVE)
        self.assertEqual((text, over, branch), ("继续", True, "over-limit"))
        text2, over2, _ = self.t(payload=payload, consecutive=hook.MAX_CONSECUTIVE + 4)
        self.assertEqual((text2, over2), ("继续", True), "超过上限也必须走超限分支")

    def test_row2_loop(self):
        p = loop_transcript(Path(self._tmpdir.name) / "loop.jsonl", 3, path_arg="same.txt")
        text, over, branch = self.t(payload={"transcript_path": str(p)})
        self.assertEqual((text, over, branch), (hook.TEXT_LOOP, False, "loop"))

    def test_row2_loop_beats_lower_priority_rows(self):
        p = loop_transcript(Path(self._tmpdir.name) / "loop2.jsonl", 4)
        text, _o, branch = self.t(payload={"transcript_path": str(p),
                                           "finishReason": "max_output_tokens"})
        self.assertEqual(branch, "loop")

    def test_no_loop_means_fallthrough(self):
        p = loop_transcript(Path(self._tmpdir.name) / "noloop.jsonl", 2)
        _text, _o, branch = self.t(payload={"transcript_path": str(p)})
        self.assertNotEqual(branch, "loop")

    def test_row3_max_output_tokens_both_spellings(self):
        for reason in ("max_output_tokens", "length", "MAX_OUTPUT_TOKENS", " Length "):
            text, over, branch = self.t(payload={"finishReason": reason,
                                                 "last_assistant_message": "写了一半"})
            self.assertEqual((text, over, branch), ("继续", False, "max-output-tokens"),
                             reason)

    def test_row4_no_output(self):
        text, over, branch = self.t(payload={"last_assistant_message": "   ",
                                             "toolCallCount": 0, "output_tokens": 0})
        self.assertEqual((text, over, branch), ("继续", False, "no-output"))

    def test_row4_needs_explicit_zero_tool_calls(self):
        """toolCallCount 缺失时不许臆测成 0，否则会误判「无输出」。"""
        _t, _o, branch = self.t(payload={"last_assistant_message": "", "output_tokens": 0})
        self.assertEqual(branch, "autonomous")

    def test_row4_requires_no_reasoning_tokens(self):
        _t, _o, branch = self.t(payload={"last_assistant_message": "", "toolCallCount": 0,
                                         "output_tokens": 0, "reasoning_tokens": 42})
        self.assertEqual(branch, "reasoning-only")

    def test_row5_reasoning_only(self):
        text, _over, branch = self.t(payload={"last_assistant_message": "",
                                              "toolCallCount": 0,
                                              "reasoning_tokens": 1200})
        self.assertEqual((text, branch), (hook.TEXT_REASONING_ONLY, "reasoning-only"))

    def test_row6_interrupted_and_error(self):
        for status in ("cancelled", "canceled", "error"):
            text, _o, branch = self.t(payload={"last_assistant_message": "半句话",
                                               "status": status})
            self.assertEqual((text, branch), ("继续", "interrupted"), status)

    def test_row7_autonomous_default(self):
        text, over, branch = self.t(payload={"last_assistant_message": "正常收尾",
                                             "toolCallCount": 2})
        self.assertEqual((text, over, branch), ("继续", False, "autonomous"))

    def test_transcript_can_supply_the_signals(self):
        """payload 没带字段时，回落到转录摘要（data），而不是当成「无输出」。"""
        data = {"last_assistant_text": "我看完了", "usage": {"output_tokens": 50},
                "finish_reason": "max_output_tokens", "status": None,
                "calls": [], "results": {}}
        _t, _o, branch = hook.decide({}, {}, data, 0)
        self.assertEqual(branch, "max-output-tokens")

    def test_error_flag_implies_error_status(self):
        _t, _o, branch = self.t(payload={"last_assistant_message": "x", "error": "boom"})
        self.assertEqual(branch, "interrupted")

    def test_interrupt_flag_implies_cancelled(self):
        _t, _o, branch = self.t(payload={"last_assistant_message": "x", "interrupted": True})
        self.assertEqual(branch, "interrupted")


class TestSignalsNormalization(StateFileCase):

    def sig(self, payload, data=None):
        return hook.signals(payload, data or {})

    def test_none_means_absent_not_zero(self):
        s = self.sig({})
        for key in ("tool_calls", "output_tokens", "reasoning_tokens"):
            self.assertIsNone(s[key], key)

    def test_alternative_spellings(self):
        for payload in ({"toolCallCount": 3}, {"tool_call_count": 3},
                        {"toolCalls": [{"a": 1}, {"b": 2}, {"c": 3}]}):
            self.assertEqual(self.sig(payload)["tool_calls"], 3)

    def test_nested_usage_sources(self):
        self.assertEqual(self.sig({"usage": {"output_tokens": "77"}})["output_tokens"], 77.0)
        self.assertEqual(self.sig({}, {"usage": {"outputTokens": 9}})["output_tokens"], 9)

    def test_bool_is_not_a_count(self):
        self.assertIsNone(self.sig({"toolCallCount": True})["tool_calls"])

    def test_finish_reason_normalized(self):
        self.assertEqual(self.sig({"finish_reason": "  MaxOutput  "})["finish_reason"],
                         "maxoutput")

    def test_message_three_shapes(self):
        self.assertEqual(self.sig({"lastAssistantMessage": " b "})["visible"], "b")
        self.assertEqual(self.sig({}, {"last_assistant_text": "c"})["visible"], "c")
        self.assertEqual(self.sig({"last_assistant_message": 123})["visible"], "")


# ================================================================== 护栏文 §2.3.3 末段

class TestGuardText(StateFileCase):

    def test_no_calls_means_no_guard(self):
        self.assertEqual(hook.guard_text({"calls": []}), "")

    def test_pending_result_uses_guard7(self):
        data = {"calls": [{"id": "t1", "name": "write_file", "input": {}}], "results": {}}
        self.assertEqual(hook.guard_text(data),
                         "上一步工具「write_file」可能未完成，先确认状态再继续，勿重复执行")

    def test_error_result_also_pending(self):
        data = {"calls": [{"id": "t1", "name": "grep", "input": {}}],
                "results": {"t1": {"text": "失败", "is_error": True}}}
        self.assertIn("可能未完成", hook.guard_text(data))

    def test_success_uses_guard8_with_result(self):
        data = {"calls": [{"id": "t1", "name": "grep", "input": {}}],
                "results": {"t1": {"text": "命中 3 处", "is_error": False}}}
        self.assertEqual(hook.guard_text(data),
                         "上一步工具「grep」已完成，结果:命中 3 处。勿重复执行，直接继续")

    def test_result_truncated_to_300(self):
        data = {"calls": [{"id": "t1", "name": "read", "input": {}}],
                "results": {"t1": {"text": "甲" * 500, "is_error": False}}}
        out = hook.guard_text(data)
        self.assertIn("甲" * 300, out)
        self.assertNotIn("甲" * 301, out)

    def test_blank_result_placeholder(self):
        data = {"calls": [{"id": "t1", "name": "read", "input": {}}],
                "results": {"t1": {"text": "   ", "is_error": False}}}
        self.assertIn("结果:(无输出)", hook.guard_text(data))

    def test_unknown_tool_name(self):
        data = {"calls": [{"id": "t1", "name": "", "input": {}}], "results": {}}
        self.assertIn("「unknown」", hook.guard_text(data))

    def test_only_last_call_matters(self):
        data = {"calls": [{"id": "t1", "name": "first", "input": {}},
                          {"id": "t2", "name": "last", "input": {}}],
                "results": {"t2": {"text": "ok", "is_error": False}}}
        out = hook.guard_text(data)
        self.assertIn("last", out)
        self.assertNotIn("first", out)


# ================================================================== handle_stop 端到端

class TestHandleStop(StateFileCase):

    def test_continues_with_block_and_grace(self):
        self.seed()
        payload = {"session_id": "s1", "last_assistant_message": "半句话",
                   "status": "cancelled"}
        slp, emitted = self.run_stop(payload, hook.read_state())
        self.assertEqual(emitted, {"decision": "block", "reason": "继续"})
        slp.assert_called_once_with(hook.GRACE_MS / 1000.0)

    def test_final_text_joins_guard_with_blank_line(self):
        """§4 拼装规则：续跑文 + `\\n\\n` + 护栏文。"""
        p = write_jsonl(Path(self._tmp.name) / "tr.jsonl", [
            {"message": {"content": [tool_use(1, "read_file", path="x")]}},
            {"message": {"content": [tool_result(1, "内容OK")]}},
        ])
        # 正常完成后的续跑只在 loop 模式发生；默认 recover 不接力。
        self.seed(settings={"defaultMode": "loop"})
        _slp, emitted = self.run_stop(
            {"session_id": "s", "transcript_path": str(p),
             "last_assistant_message": "看到了"}, hook.read_state())
        reason = emitted["reason"]
        self.assertTrue(reason.startswith("继续\n\n"), repr(reason))
        self.assertIn("上一步工具「read_file」已完成，结果:内容OK", reason)

    def test_state_written_after_continue(self):
        self.seed()
        self.run_stop({"session_id": "s7", "status": "cancelled"}, hook.read_state())
        st = self.load()
        self.assertEqual(st["sessions"]["s7"]["consecutive"], 1)
        self.assertGreater(st["lastContinueAt"], 0)

    def test_over_limit_resets_streak(self):
        self.seed(sessions={"s8": {"consecutive": hook.MAX_CONSECUTIVE, "lastAt": 1}})
        _slp, emitted = self.run_stop({"session_id": "s8"}, hook.read_state())
        self.assertEqual(emitted["reason"], "继续")
        st = self.load()
        self.assertEqual(st["sessions"]["s8"]["consecutive"], 0, "超限后必须清零并停")

    def test_streak_is_per_session(self):
        self.seed(sessions={"a": {"consecutive": 5}})
        self.run_stop({"session_id": "b", "status": "cancelled"}, hook.read_state())
        st = self.load()
        self.assertEqual(st["sessions"]["a"]["consecutive"], 5, "别的会话把计数顶掉了")
        self.assertEqual(st["sessions"]["b"]["consecutive"], 1)

    def test_read_modify_write_preserves_other_fields(self):
        self.seed(runtime=False, journal={"s": {"turnId": "keep"}}, cancelToken=9,
                  enabled=True, sessions={"s": {"consecutive": 1, "lastAt": 5}})
        state = hook.read_state()
        state["runtime"] = False                      # 模拟渲染层刚写过的值
        with patch.object(hook.time, "sleep"), patch.object(hook, "emit"):
            hook.handle_stop({"session_id": "s"}, state)
        st = self.load()
        self.assertEqual(st["runtime"], False, "hook 覆盖了渲染层的 runtime")
        self.assertEqual(st["journal"], {"s": {"turnId": "keep"}}, "hook 覆盖了恢复台账")
        self.assertEqual(st["cancelToken"], 9, "hook 覆盖了作废令牌")

    def test_paused_emits_nothing(self):
        self.seed(paused=True, enabled=True)
        slp, emitted = self.run_stop({"session_id": "s"}, hook.read_state())
        self.assertEqual((emitted, slp.call_count), (None, 0))

    def test_closing_switch_stops_output_and_writes_nothing(self):
        """§2.2「关闭并保存」→ enabled=false：立即停止续跑，不再排任何继续。"""
        self.seed(enabled=False, paused=True, cancelToken=2)
        before = self.state_file.read_text(encoding="utf-8")
        _slp, emitted = self.run_stop({"session_id": "s"}, hook.read_state())
        self.assertEqual(emitted, None)
        self.assertEqual(self.state_file.read_text(encoding="utf-8"), before)

    def test_cooldown_blocks_and_does_not_extend_itself(self):
        t0 = hook.now_ms() - 1000
        self.seed(lastContinueAt=t0)
        state = hook.read_state()
        _slp, emitted = self.run_stop({"session_id": "s", "status": "cancelled"}, state)
        self.assertEqual(emitted, None)
        self.assertEqual(state["lastContinueAt"], t0, "被冷却拦下却刷新了冷却起点")


class TestHandleUserPrompt(StateFileCase):

    def test_resets_only_that_session(self):
        self.seed(sessions={"a": {"consecutive": 4}, "b": {"consecutive": 3}})
        state = hook.read_state()
        with patch.object(hook, "emit") as em:
            hook.handle_user_prompt({"session_id": "a"}, state)
        self.assertEqual(em.call_count, 0, "UserPromptSubmit 不许有任何输出")
        st = self.load()
        self.assertEqual(st["sessions"]["a"]["consecutive"], 0)
        self.assertEqual(st["sessions"]["b"]["consecutive"], 3)

    def test_creates_bucket_for_new_session(self):
        self.seed()
        hook.handle_user_prompt({"session_id": "brand-new"}, hook.read_state())
        self.assertEqual(self.load()["sessions"]["brand-new"]["consecutive"], 0)

    def test_reset_then_5_more_allows_again(self):
        """用户插话重新计数：清零后再连发 4 次不该超限。"""
        self.seed(sessions={"s": {"consecutive": hook.MAX_CONSECUTIVE}})
        hook.handle_user_prompt({"session_id": "s"}, hook.read_state())
        self.seed(lastContinueAt=0, sessions={"s": {"consecutive": 0}})
        _slp, emitted = self.run_stop({"session_id": "s", "status": "cancelled"},
                                      hook.read_state())
        self.assertEqual(emitted["reason"], "继续")


# ================================================================== 异常安全（exit 0）

class TestCliSafety(unittest.TestCase):
    """Stop 下退出码 2 等价于 `{"decision":"block","reason":<stderr>}`：
    任何未捕获异常都会把 traceback 灌进模型上下文。这里逐条验证「静默失败」。"""

    def run_hook(self, event, stdin_text, state=None):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_file = Path(tmp.name) / "state.json"
        if state is not None:
            state_file.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
        env = dict(os.environ, PILOT_STATE_FILE=str(state_file),
                   PYTHONIOENCODING="utf-8", PILOT_HOOK_DEBUG_LOG="")
        r = subprocess.run([sys.executable, str(HOOK_PY), "--event", event],
                           input=stdin_text, capture_output=True, env=env,
                           text=True, encoding="utf-8", errors="replace", timeout=60)
        return r, state_file

    def test_bad_json_is_silent_exit0(self):
        r, _ = self.run_hook("stop", "{坏 JSON")
        self.assertEqual((r.returncode, r.stdout, r.stderr.strip()), (0, "", ""))

    def test_empty_stdin_is_silent(self):
        r, _ = self.run_hook("stop", "   ")
        self.assertEqual((r.returncode, r.stdout), (0, ""))

    def test_json_array_is_ignored(self):
        """hook 输入必须是对象；数组/字符串不能当 payload 用。"""
        r, _ = self.run_hook("stop", "[1,2,3]")
        self.assertEqual((r.returncode, r.stdout), (0, ""))

    def test_unknown_event_is_noop(self):
        r, _ = self.run_hook("PreToolUse", json.dumps({"session_id": "s"}))
        self.assertEqual((r.returncode, r.stdout), (0, ""))

    def test_missing_event_argument(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(lambda: __import__("shutil").rmtree(tmp, ignore_errors=True))
        env = dict(os.environ, PILOT_STATE_FILE=str(Path(tmp) / "state.json"))
        r = subprocess.run([sys.executable, str(HOOK_PY)], input="{}",
                           capture_output=True, env=env, text=True,
                           encoding="utf-8", errors="replace", timeout=60)
        self.assertEqual((r.returncode, r.stdout, r.stderr.strip()), (0, "", ""))

    def test_paused_state_emits_nothing_fast(self):
        """关闭/暂停态走真实进程，验证「不等宽限期」。"""
        import time as _t
        started = _t.monotonic()
        r, _ = self.run_hook("stop", json.dumps({"session_id": "s"}),
                             {"enabled": False, "paused": True, "runtime": True,
                              "lastContinueAt": 0})
        self.assertEqual((r.returncode, r.stdout), (0, ""))
        self.assertLess(_t.monotonic() - started, 4.0, "关闭态仍被宽限期阻塞")

    def test_user_prompt_resets_through_real_process(self):
        r, state_file = self.run_hook(
            "user-prompt", json.dumps({"session_id": "zz"}),
            {"enabled": True, "runtime": True, "paused": False, "cancelToken": 0,
             "lastContinueAt": 0, "sessions": {"zz": {"consecutive": 5}}, "journal": {}})
        self.assertEqual((r.returncode, r.stdout), (0, ""))
        st = json.loads(state_file.read_text(encoding="utf-8"))
        self.assertEqual(st["sessions"]["zz"]["consecutive"], 0)
        self.assertEqual(st["journal"], {}, "写坏了别人的字段")

    def test_stdout_is_valid_json_when_it_emits(self):
        """真要续跑时 stdout 必须是一条可解析的 block JSON（UTF-8，无杂字符）。"""
        r, _ = self.run_hook(
            "stop", json.dumps({"session_id": "s", "last_assistant_message": "半句",
                                "status": "cancelled"}),
            {"enabled": True, "runtime": True, "paused": False, "cancelToken": 0,
             "lastContinueAt": 0, "sessions": {}, "journal": {}})
        self.assertEqual(r.returncode, 0, r.stderr[-400:])
        obj = json.loads(r.stdout)
        self.assertEqual(obj["decision"], "block")
        self.assertTrue(obj["reason"].startswith("继续"))
        self.assertEqual(r.stderr.strip(), "", "stderr 有内容会被内核当成续跑文本")


# ================================================================== 循环守卫 zcp_loopguard

class TestLoopguardNormalization(unittest.TestCase):

    def test_noise_keys_are_dropped_from_fingerprint(self):
        base = {"name": "Read", "input": {"file_path": "a.ts", "offset": 1}}
        for noise in ({"requestId": "r1"}, {"timestamp": "2026-10-29T08:00:00Z"},
                      {"sessionId": "s1"}, {"trace_id": "t1"}, {"id": "9"}):
            variant = {"name": "Read",
                       "input": {**base["input"], **noise}}
            self.assertEqual(zcp_loopguard.fingerprint(base),
                             zcp_loopguard.fingerprint(variant), str(noise))

    def test_noise_inside_strings_is_normalized(self):
        a = {"name": "Bash", "input": {"cmd": "cat /tmp/abcdef01-2345-6789-abcd-ef0123456789/x"}}
        b = {"name": "Bash", "input": {"cmd": "cat /tmp/99999999-1111-2222-3333-444444444444/x"}}
        self.assertEqual(zcp_loopguard.fingerprint(a), zcp_loopguard.fingerprint(b))

    def test_timestamps_in_strings(self):
        a = {"name": "Bash", "input": {"c": "started 2026-10-29T08:00:00.123Z"}}
        b = {"name": "Bash", "input": {"c": "started 2026-10-28T01:02:03.456+08:00"}}
        self.assertEqual(zcp_loopguard.fingerprint(a), zcp_loopguard.fingerprint(b))

    def test_real_argument_difference_is_detected(self):
        a = {"name": "Read", "input": {"file_path": "a.ts"}}
        b = {"name": "Read", "input": {"file_path": "b.ts"}}
        self.assertNotEqual(zcp_loopguard.fingerprint(a), zcp_loopguard.fingerprint(b))

    def test_tool_name_case_is_ignored(self):
        self.assertEqual(zcp_loopguard.fingerprint({"name": "Read", "input": {}}),
                         zcp_loopguard.fingerprint({"name": "read", "input": {}}))

    def test_result_digest_none_is_own_class(self):
        self.assertEqual(zcp_loopguard.result_digest(None), "<none>")
        self.assertNotEqual(zcp_loopguard.result_digest(None),
                            zcp_loopguard.result_digest({"text": ""}))

    def test_error_flag_separates_digests(self):
        same = "boom"
        self.assertNotEqual(zcp_loopguard.result_digest({"text": same, "is_error": False}),
                            zcp_loopguard.result_digest({"text": same, "is_error": True}))


class TestLoopguardTranscript(unittest.TestCase):

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)

    def parse(self, rows):
        return zcp_loopguard.load_transcript(str(write_jsonl(self.dir / "t.jsonl", rows)))

    def test_missing_path_is_empty_shape(self):
        data = zcp_loopguard.load_transcript("")
        self.assertEqual(set(data) >= {"calls", "results", "last_assistant_text",
                                       "usage", "finish_reason", "status"}, True)
        self.assertEqual(data["calls"], [])

    def test_nonexistent_file_is_silent(self):
        self.assertEqual(zcp_loopguard.load_transcript(str(self.dir / "nope.jsonl"))["calls"], [])

    def test_bad_lines_are_skipped_good_kept(self):
        p = self.dir / "mixed.jsonl"
        p.write_text("{坏行\n" + json.dumps({"message": {"content": [tool_use(1)]}})
                     + "\n\n", encoding="utf-8")
        self.assertEqual(len(zcp_loopguard.load_transcript(str(p))["calls"]), 1)

    def test_nested_and_flat_tool_use_both_collected(self):
        data = self.parse([
            {"message": {"content": [tool_use(1, name="A")]}},
            {"type": "tool_use", "id": "tu-2", "name": "B", "input": {}},
        ])
        self.assertEqual([c["name"] for c in data["calls"]], ["A", "B"])

    def test_result_matching_by_tool_use_id(self):
        data = self.parse([
            {"message": {"content": [tool_use(1)]}},
            {"message": {"content": [tool_result(1, "好了")]}},
        ])
        self.assertEqual(data["results"]["tu-1"]["text"], "好了")
        self.assertFalse(data["results"]["tu-1"]["is_error"])

    def test_image_and_list_content_flattened(self):
        data = self.parse([
            {"message": {"content": [{"type": "tool_result", "tool_use_id": "tu-9",
                                     "content": [{"type": "text", "text": "一"},
                                                 {"type": "image"}, "二"]}]}},
        ])
        self.assertEqual(data["results"]["tu-9"]["text"], "一 [image] 二")

    def test_dict_content_serialized(self):
        data = self.parse([{"message": {"content": [
            {"type": "tool_result", "tool_use_id": "tu-9", "content": {"k": 1}}]}}])
        self.assertIn('"k": 1', data["results"]["tu-9"]["text"])

    def test_last_assistant_text(self):
        data = self.parse([
            {"message": {"content": [{"type": "text", "text": "第一段"}]}},
            {"message": {"content": [{"type": "text", "text": "  最后一段  "}]}},
        ])
        self.assertEqual(data["last_assistant_text"], "最后一段")

    def test_usage_finish_reason_status(self):
        data = self.parse([{"message": {"usage": {"output_tokens": 3},
                                        "finish_reason": " max_output_tokens "}}])
        self.assertEqual(data["usage"], {"output_tokens": 3})
        self.assertEqual(data["finish_reason"], "max_output_tokens")

    def test_error_subtype_becomes_status(self):
        for row, want in (({"subtype": "error"}, "error"),
                          ({"subtype": "cancelled"}, "cancelled"),
                          ({"type": "error"}, "error"),
                          ({"status": "RUNNING"}, "RUNNING")):
            self.assertEqual(self.parse([row])["status"], want, str(row))

    def test_double_collect_guard(self):
        """message 与 obj 是同一个 dict 时不能把块走两遍（会虚增调用次数）。"""
        data = self.parse([{"content": [tool_use(1)]}])
        self.assertEqual(len(data["calls"]), 1)


class TestLoopguardDetect(unittest.TestCase):

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)

    def path(self, name):
        return self.dir / name

    def test_constants(self):
        self.assertEqual(zcp_loopguard.WINDOW, 12)
        self.assertEqual(zcp_loopguard.REPEAT_MIN, 3)

    def test_hits_at_threshold(self):
        p = loop_transcript(self.path("d1.jsonl"), 3)
        hit = zcp_loopguard.detect(str(p))
        self.assertEqual(hit["looped"], True)
        self.assertEqual(hit["repeat"], 3)
        self.assertEqual(hit["tool"], "read_file")

    def test_below_threshold(self):
        self.assertIsNone(zcp_loopguard.detect(str(loop_transcript(self.path("d2.jsonl"), 2))))

    def test_counts_all_tail_repeats(self):
        p = loop_transcript(self.path("d3.jsonl"), 6)
        self.assertEqual(zcp_loopguard.detect(str(p))["repeat"], 6)

    def test_only_tail_consecutive_runs_count(self):
        """中途换了别的动作并已产生输出 → 现在没卡住，不算循环（避免误伤）。"""
        rows = [tool_use(i, path="same.txt") for i in range(3)]
        rows.insert(0, tool_use(99, name="other_tool", path="z.txt"))
        p = write_jsonl(self.path("d4.jsonl"),
                        [{"message": {"content": [r]}} for r in rows])
        hit = zcp_loopguard.detect(str(p))
        self.assertTrue(hit and hit["repeat"] == 3)
        # 尾部被别的动作打断
        rows = [tool_use(i, path="same.txt") for i in range(3)]
        rows.append(tool_use(50, name="other", path="q"))
        p = write_jsonl(self.path("d5.jsonl"),
                        [{"message": {"content": [r]}} for r in rows])
        self.assertIsNone(zcp_loopguard.detect(str(p)))

    def test_differing_results_break_the_loop(self):
        """同指纹但每次输出不同 → 有差异信号，不是死循环。"""
        p = loop_transcript(self.path("d6.jsonl"), 4,
                            results=["结果一", "结果二", "结果三", "结果四"])
        self.assertIsNone(zcp_loopguard.detect(str(p)))

    def test_identical_results_still_a_loop(self):
        p = loop_transcript(self.path("d7.jsonl"), 3, results=["同样报错", ] * 3)
        self.assertTrue(zcp_loopguard.detect(str(p))["looped"])

    def test_timestamp_only_result_difference_is_noise(self):
        p = loop_transcript(
            self.path("d8.jsonl"), 3,
            results=["耗时 2026-10-29T08:00:00Z", "耗时 2026-10-29T08:00:01Z",
                     "耗时 2026-10-29T08:00:02Z"])
        self.assertTrue(zcp_loopguard.detect(str(p))["looped"],
                        "结果只差时间戳应视为无差异（仍在原地打转）")

    def test_window_caps_lookback(self):
        """3 次相同 → 中间夹 10 次不同 → 尾部连续只有 1 次 → 不算循环。"""
        rows = [tool_use(i, path="same.txt") for i in range(3)]
        rows += [tool_use(100 + i, name="other", path="p%d" % i) for i in range(10)]
        p = write_jsonl(self.path("d9.jsonl"), [{"message": {"content": [r]}} for r in rows])
        self.assertIsNone(zcp_loopguard.detect(str(p)))

    def test_missing_or_empty_path(self):
        self.assertIsNone(zcp_loopguard.detect(""))
        self.assertIsNone(zcp_loopguard.detect(None))
        self.assertIsNone(zcp_loopguard.detect("no-such-file.jsonl"))

    def test_cli_prints_looped_and_exits_zero(self):
        p = loop_transcript(self.path("cli.jsonl"), 3)
        r = subprocess.run([sys.executable, str(_SCRIPTS / "zcp_loopguard.py"),
                            "--transcript", str(p)],
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr[-300:])
        self.assertEqual(json.loads(r.stdout)["looped"], True)

    def test_cli_defaults_to_not_looped(self):
        r = subprocess.run([sys.executable, str(_SCRIPTS / "zcp_loopguard.py"),
                            "--transcript", "no-such-file.jsonl"],
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=60)
        self.assertEqual((r.returncode, json.loads(r.stdout)), (0, {"looped": False}))


# ================================================================== 注入 / 注册 / 落点

class TestHookRegistration(unittest.TestCase):
    """新能力的权威注册点在 hooks/hooks.json；漏注册会**静默**失效（日志干净、界面无异常）。"""

    @classmethod
    def setUpClass(cls):
        cls.hooks = json.loads((REPO_ROOT / "hooks" / "hooks.json")
                               .read_text(encoding="utf-8"))["hooks"]

    def test_stop_and_userpromptsubmit_registered(self):
        for event, flag in (("Stop", "--event stop"),
                           ("UserPromptSubmit", "--event user-prompt")):
            self.assertIn(event, self.hooks)
            cmds = [h["command"] for group in self.hooks[event] for h in group["hooks"]]
            joined = " ".join(cmds)
            self.assertIn("zcp_hook.py", joined, event)
            self.assertIn(flag, joined, event)
            self.assertIn("skills/zcode-pilot/scripts/", joined, event)

    def test_timeouts_cover_grace_plus_work(self):
        """宽限期 5s 是 sleep 掉的；Stop 的 timeoutMs 必须明显大于它，否则续跑会被掐死。"""
        for group in self.hooks["Stop"]:
            for h in group["hooks"]:
                self.assertGreaterEqual(h["timeoutMs"], hook.GRACE_MS + 5000,
                                        "Stop 超时小于宽限期 + 余量 → block 永远发不出去")

    def test_sessionstart_still_syncs(self):
        """保持原有能力：SessionStart 仍要拉一次配置同步。"""
        joined = " ".join(h["command"] for group in self.hooks["SessionStart"]
                          for h in group["hooks"])
        self.assertIn("zcp_sync.py", joined)


class TestManifestSwitch(unittest.TestCase):

    def test_auto_continue_switch_declared_and_default_on(self):
        manifest = json.loads((REPO_ROOT / ".zcode-plugin" / "plugin.json")
                              .read_text(encoding="utf-8"))
        cfg = manifest["userConfig"]
        self.assertIn("auto_continue", cfg)
        self.assertEqual(cfg["auto_continue"]["default"], True)

    def test_slider_switch_removed(self):
        """思考强度滑条已整体移除，不能再作为开关出现。"""
        cfg = json.loads((REPO_ROOT / ".zcode-plugin" / "plugin.json")
                         .read_text(encoding="utf-8"))["userConfig"]
        self.assertNotIn("thought_slider", cfg)
        self.assertFalse((_SCRIPTS / "zcode-thought-slider.js").exists())

    def test_patcher_exposes_auto_continue_flag(self):
        import zcp_patcher as zp
        self.assertIn("auto_continue", zp.ALL_PATCH_FLAGS)
        self.assertNotIn("thought_slider", zp.ALL_PATCH_FLAGS)


class TestRendererMountPoints(unittest.TestCase):
    """契约 §5：开关紧邻「模式切换」右侧；状态只显示在开关本身。"""

    @classmethod
    def setUpClass(cls):
        cls.src = read_script("zcode-pilot.js")
        cls.code = code_only(cls.src)

    def test_script_exists(self):
        self.assertTrue(PILOT_JS.is_file(), "渲染层脚本缺失：自动继续开关无处挂载")

    def test_switch_is_right_of_mode_toggle(self):
        self.assertIn('chat-mode-select-trigger', self.src)
        # 紧邻判定必须用 previousElementSibling：宽松的同父下标比较会把「漂到行尾」判成合规
        self.assertIn("toggleEl.previousElementSibling === trigger", self.src)
        self.assertIn("trigger.parentElement.insertBefore(toggleEl, trigger.nextSibling)", self.src)

    def test_degraded_mount_is_temporary_and_corrected(self):
        """无锚点只是临时落点：必须标「待搬回」，锚点后到时下一轮巡检搬回右侧。"""
        self.assertIn("toolbar-end(待搬回)", self.src)
        self.assertIn("after-trigger", self.src)

    def test_session_status_strip_removed(self):
        """用户明确要求去掉会话顶部的「自动继续 开」显示框：节点、样式、挂载代码都不许留。"""
        self.assertNotIn("zpilot-status", self.src)
        self.assertNotIn("v4-session-pane", self.src)

    def test_cancel_token_clears_queue(self):
        self.assertIn("cancelToken", self.src)
        self.assertRegex(self.src, r"st\.cancelToken\s*!==\s*prevToken")

    def test_state_poll_period_matches_contract(self):
        self.assertIn("POLL_MS = 1500", self.src)

    def test_does_not_call_port_start(self):
        """硬约束：调用 port.start() 会吃掉应用的 Initialize 握手，客户端直接卡启动。"""
        self.assertNotIn("port.start()", self.code)

    def test_no_steamroller_over_tps_bar(self):
        """与 zcode-tps.js 抢挂载点会把状态栏顶掉。"""
        self.assertIn("data-ztps-bar", self.src)

    def test_crash_recovery_send_path(self):
        for token in ("v4-composer-send", "writeText", "__zcpCoreDiag"):
            self.assertIn(token, self.src)

    def test_reduced_motion_and_theme_colors(self):
        """TPS/开关的展示美化必须有暗色适配与减弱动效开关。"""
        self.assertIn("prefers-color-scheme: dark", self.src)
        self.assertIn("prefers-reduced-motion", self.src)


class TestRendererMountBehaviour(unittest.TestCase):
    """契约 §5 / §2.2 / §2.3.4 的**行为级**验证：用 DOM 桩把 zcode-pilot.js 真跑一遍。

    静态断言（TestRendererMountPoints）只看代码里有没有关键字，抓不到三类真故障：
      · 落点是索引相关的 —— 插错一位就是插到模式切换左边；
      · cancelToken 作废只写在注释里、队列照发；
      · 崩溃恢复的「同一轮」判定比了对象身份：轮询把 journal 换成 IPC 副本后
        永远误判成「已被新轮次接管」→ 不重试、不收尾、台账滞留、下次启动误发「继续」。
    """

    @classmethod
    def setUpClass(cls):
        cls.node = shutil.which("node") or shutil.which("node.exe")
        cls.smoke = _HERE / "pilot_mount_smoke.js"
        cls.script = _SCRIPTS / "zcode-pilot.js"
        cls.src = read_script("zcode-pilot.js")

    def _run(self, *args):
        return subprocess.run([self.node, *args], capture_output=True,
                              text=True, encoding="utf-8", errors="replace", timeout=120)

    def _require_node(self):
        if not self.node:
            self.skipTest("本机没有 node，跳过渲染层行为冒烟测试")
        if not self.smoke.is_file():
            self.skipTest("未找到 pilot_mount_smoke.js")

    def test_mount_smoke_passes(self):
        """开关落点、双处同源、暂停/关闭态、崩溃恢复、作废排队、降级、幂等。"""
        self._require_node()
        r = self._run(str(self.smoke), str(self.script))
        self.assertEqual(r.returncode, 0,
                         f"渲染层行为冒烟测试失败：{(r.stdout + r.stderr)[:1200]}")
        self.assertIn("pilot mount smoke OK", r.stdout)

    def test_mount_smoke_without_argument_fails_helpfully(self):
        """缺参数要给「用法」提示并退 2，而不是甩 Node 裸堆栈。"""
        self._require_node()
        r = self._run(str(self.smoke))
        self.assertEqual(r.returncode, 2, "缺参数应以退出码 2 结束（区别于测试失败）")
        self.assertIn("用法", r.stderr + r.stdout)
        self.assertNotIn("ERR_INVALID_ARG_TYPE", r.stderr)

    def test_recovery_same_turn_uses_turnid_not_object_identity(self):
        """锁死上面那个身份比较缺陷（行为测试已通过，这里防回退）。"""
        self.assertRegex(self.src, r"journal\[sid\]\s*\.turnId\s*!==\s*entry\.turnId")
        self.assertRegex(self.src, r"journal\[sid\]\s*\.turnId\s*===\s*entry\.turnId")


class TestTpsPresentation(unittest.TestCase):
    """「美化 TPS 展示」：加小图标、位置固定；不得动数据层，也不许留第二个挂载点。"""

    @classmethod
    def setUpClass(cls):
        cls.src = read_script("zcode-tps.js")
        cls.code = code_only(cls.src)

    def test_statusbar_capsules_present(self):
        self.assertIn("data-ztps-bar", self.src)
        self.assertIn("tok/s", self.src)

    def test_no_port_start(self):
        self.assertNotIn("port.start()", self.code)

    def test_dark_theme(self):
        self.assertIn("prefers-color-scheme: dark", self.src)

    def test_icons_are_inline_svg_only(self):
        """图标必须是内联 SVG：本插件零外部资源，不许图片/字体/网络。"""
        self.assertIn('const NS_SVG = "http://www.w3.org/2000/svg"', self.src)
        self.assertIn("document.createElementNS(NS_SVG, \"svg\")", self.src)
        self.assertIn("ztps-ico", self.src)
        for banned in ("<img", "url(", "background-image", "fetch(", "XMLHttpRequest"):
            self.assertNotIn(banned, self.code, "引入了外部资源：" + banned)

    def test_position_fixed_no_second_mount(self):
        """位置不可更改：只有一个 composer-below 落点，位置偏好彻底不再读写。"""
        self.assertIn('const MODE = "composer-below"', self.src)
        self.assertIn("attach(host)", self.code)
        for gone in ("getPos(", "setPos(", "session-top", "findSessionScroller",
                     "findToolbarRow", "openPosMenu", "closePosMenu"):
            self.assertNotIn(gone, self.code, "位置切换残留未清干净：" + gone)
        # 代码里只允许出现一次 ztps-pos —— 启动时清掉历史偏好那一句
        self.assertEqual(self.code.count("ztps-pos"), 1,
                         "位置偏好读写没清干净")


if __name__ == "__main__":
    unittest.main(verbosity=2)
