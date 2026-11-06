#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""zcode-pilot 续跑内核：官方 Stop / UserPromptSubmit hook（权威续跑决策层）

契约：docs/CONTRACT.md §2.2（状态文件）、§2.3（职责与协议）、§3（计时常量）、§4（9 条文案）。
逆向依据：.research/rea-findings.md §3.2 / §7 —— ZCode 内核 @5234927 对 Stop hook 的处理：
`decision === "block"` → `stopShouldContinue = true`，`reason` 作为 additionalContext 注入，
本轮继续跑（每轮最多 3 条 additionalContext，`j6a = 3`）。渲染层 `window.zcode` **没有**发送/中断 API，
所以续跑决策只能落在本 hook 里。

协议
----
* `--event stop`：stdin 读 hook 输入 JSON；需要续跑时 stdout 写
  `{"decision":"block","reason":"<最终续跑文本>"}`；不需要续跑时**什么都不输出**。
* `--event user-prompt`：只把该 session 的 `consecutive` 清零，**不输出**。
* ★ 异常安全是硬要求：Stop 事件下退出码 2 等价于 `{"decision":"block","reason":<stderr>}`
  （内核 @5246918），任何未捕获异常都会把 traceback 当成续跑文本灌给模型。
  因此本文件 **全包 try/except**，永远 `exit 0`、出错时静默不输出。
* 只用标准库；stdout 走 UTF-8 字节直写，绕开 Windows 控制台代码页。

计时（§3，不得改动）
--------------------
* `GRACE_MS = 3000`：**只在确定要续跑之后** sleep，再输出 block（不无条件阻塞 3 秒）。
* `COOLDOWN_MS = 20000`：读状态文件 `lastContinueAt`，距今不足 20s → 放行 Stop。
* `MAX_CONSECUTIVE = 3`：按 `session_id` 分桶计数，每次续跑 +1。
* 以上三项都是**默认值**，可由设置页写入的 `settings` 覆盖（与 dsh-client-auto-continue 一致）。

会话模式（与 dsh-client-auto-continue 一致）
--------------------------------------------
* `sessions[sid].mode`：`default | off | recover | loop`，由渲染层按**当前会话**写入；
* `default` 表示跟随 `settings.defaultMode`（默认 `recover`）；
* `recover` 只恢复失败/中断/超限/静默回合，**不再接力正常完成的回合**；
* `loop` 额外允许正常完成后自主续跑（正常完成的接力不计入连续上限、不受冷却约束）；
* `off` 完全关闭该会话（含循环守卫）。

状态文件（§2.2）：`~/.zcode/pilot/state.json`，多方共用 —— 本 hook 只碰
`lastContinueAt` 与 `sessions`，其余字段（`enabled/paused/cancelToken/runtime/journal/settings/…`）原样保留，
读-改-写 + 「同目录临时文件 + os.replace」原子替换。
测试可用环境变量 `PILOT_STATE_DIR`（目录）或 `PILOT_STATE_FILE`（整文件路径）重定向，避免污染真实状态。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

# --------------------------------------------------------------------------
# 依赖（全部包在 try 里：模块级异常会直接变成 traceback → 污染上下文）
# --------------------------------------------------------------------------

try:  # 控制台编码安全网（见 _console.py 的说明）
    from _console import safe_stdio
except Exception:  # pragma: no cover - 兜底：没有它也照常工作
    try:
        from scripts._console import safe_stdio  # type: ignore
    except Exception:
        def safe_stdio() -> None:
            return None

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))
try:
    import loopguard  # 同目录；循环守卫（独立模块，见 loopguard.py）
except Exception:  # pragma: no cover
    loopguard = None


# --------------------------------------------------------------------------
# 常量（§3）与文案表（§4，逐字复制，勿改标点）
# --------------------------------------------------------------------------

GRACE_MS = 3000
COOLDOWN_MS = 20000
MAX_CONSECUTIVE = 3

TEXT_INTERRUPTED = "继续"      # 1 中断后自动发送
TEXT_OVER_LIMIT = "继续"       # 2 超限时
TEXT_MAX_TOKENS = "继续"       # 3 输出 token 上限触发
TEXT_NO_OUTPUT = "继续"        # 4 无输出回合
TEXT_REASONING_ONLY = (        # 5 仅输出推理即结束
    "你上一轮只输出内部推理，无回复也无工具调用，用户什么都没看到。"
    "每一轮须以工具调用或可见回复结束。"
)
TEXT_AUTONOMOUS = "继续"       # 6 自主循环续跑
GUARD_PENDING = "上一步工具「{tool}」可能未完成，先确认状态再继续，勿重复执行"          # 7
GUARD_DONE = "上一步工具「{tool}」已完成，结果:{result}。勿重复执行，直接继续"          # 8
TEXT_LOOP = "检测到循环，停止重复刚才动作，换方式继续"                                  # 9

#: {result} 摘要截断上限（§2.3.3 护栏文：截断 ≤ 300 字符）
RESULT_MAX_CHARS = 300

#: 会话模式（与 dsh-client-auto-continue 的 SessionMode 一致）
VALID_MODES = ("default", "off", "recover", "loop")
VALID_DEFAULT_MODES = ("recover", "loop")

#: 设置页可写的默认值。**与渲染层/主进程 handler 的 default.settings 保持一致**。
#: 默认策略对齐 dsh-client-auto-continue：默认仅故障恢复（不接力正常完成的回合）、
#: 宽限 3s、冷却 20s、连续上限 3、静默回合续跑开、工具护栏开、循环守卫开。
DEFAULT_SETTINGS = {
    "defaultMode": "recover",
    "resumeSilentTurns": True,
    # TurnError 轮次由渲染层兜底（Stop hook 不会在这些失败上触发）；此键仅共享契约/设置页用。
    "resumeFailedTurns": True,
    "guardTools": True,
    "loopGuard": True,
    "graceMs": GRACE_MS,
    "cooldownMs": COOLDOWN_MS,
    "maxConsecutive": MAX_CONSECUTIVE,
    "continueText": TEXT_AUTONOMOUS,
    "continueTextMaxTokens": TEXT_MAX_TOKENS,
    "continueTextSilent": TEXT_REASONING_ONLY,
    "continueTextLoop": TEXT_AUTONOMOUS,
    "continueTextInterrupted": TEXT_INTERRUPTED,
    "guardPendingText": GUARD_PENDING,
    "guardDoneText": GUARD_DONE,
    "loopText": TEXT_LOOP,
}

_TEXT_KEYS = (
    "continueText", "continueTextMaxTokens", "continueTextSilent",
    "continueTextLoop", "continueTextInterrupted",
    "guardPendingText", "guardDoneText", "loopText",
)
_BOOL_KEYS = ("resumeSilentTurns", "resumeFailedTurns", "guardTools", "loopGuard")
_NUMBER_KEYS = ("graceMs", "cooldownMs", "maxConsecutive")


def settings_of(state: dict) -> dict:
    """把状态文件里的 `settings` 归一化成完整配置；坏值一律回落默认值。"""
    out = dict(DEFAULT_SETTINGS)
    raw = state.get("settings")
    if not isinstance(raw, dict):
        return out
    mode = raw.get("defaultMode")
    if mode in VALID_DEFAULT_MODES:
        out["defaultMode"] = mode
    for key in _BOOL_KEYS:
        if isinstance(raw.get(key), bool):
            out[key] = raw[key]
    for key in _NUMBER_KEYS:
        value = raw.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        if not (value >= 0):
            continue
        if key == "maxConsecutive":
            if value >= 1:
                out[key] = int(value)
        else:
            out[key] = int(value)
    for key in _TEXT_KEYS:
        value = raw.get(key)
        if isinstance(value, str) and value.strip():
            out[key] = value.strip()
    return out


def session_mode_of(state: dict, sid: str, settings: dict) -> str:
    """取该会话的**实际**模式；无记录时兼容旧的全局 `runtime`。"""
    sessions = state.get("sessions")
    entry = sessions.get(sid) if isinstance(sessions, dict) else None
    raw = entry.get("mode") if isinstance(entry, dict) else None
    if raw not in VALID_MODES:
        # 旧版本只有全局 runtime；false 视为关，其余跟随默认。
        raw = "off" if _flag(state.get("runtime"), True) is False else "default"
    if raw == "default":
        return settings.get("defaultMode", "recover")
    return raw


def text_for(branch: str, settings: dict) -> str:
    """按判定分支选续跑文本（设置页可覆盖；空值已在 settings_of 回落默认）。"""
    if branch == "loop":
        return settings.get("loopText") or TEXT_LOOP
    if branch == "max-output-tokens":
        return settings.get("continueTextMaxTokens") or TEXT_MAX_TOKENS
    if branch in ("no-output", "reasoning-only"):
        return settings.get("continueTextSilent") or TEXT_REASONING_ONLY
    if branch == "interrupted":
        return settings.get("continueTextInterrupted") or TEXT_INTERRUPTED
    if branch == "over-limit":
        return settings.get("continueText") or TEXT_OVER_LIMIT
    if branch == "autonomous":
        return settings.get("continueTextLoop") or TEXT_AUTONOMOUS
    return settings.get("continueText") or TEXT_OVER_LIMIT


# --------------------------------------------------------------------------
# 状态文件（§2.2）
# --------------------------------------------------------------------------

def default_state() -> dict:
    """§2.2 的默认值（缺文件 / 字段缺失时补齐；enabled 默认 true 与插件清单一致）。"""
    return {
        "version": 1,
        "enabled": True,
        "runtime": True,
        "paused": False,
        "cancelToken": 0,
        "lastContinueAt": 0,
        "sessions": {},
        "journal": {},
        "settings": dict(DEFAULT_SETTINGS),
    }


def state_path() -> Path:
    """状态文件路径；`PILOT_STATE_DIR` / `PILOT_STATE_FILE` 仅供自测重定向。"""
    override_file = (os.environ.get("PILOT_STATE_FILE") or "").strip()
    if override_file:
        return Path(override_file)
    override_dir = (os.environ.get("PILOT_STATE_DIR") or "").strip()
    if override_dir:
        return Path(override_dir) / "state.json"
    return Path.home() / ".zcode" / "pilot" / "state.json"


def read_state() -> dict:
    """读状态文件（缺失/坏 JSON → 默认值；永远不抛异常）。"""
    st = default_state()
    try:
        path = state_path()
        if path.is_file():
            raw = path.read_text(encoding="utf-8")
            obj = json.loads(raw) if raw.strip() else {}
            if isinstance(obj, dict):
                st.update(obj)
        for key, value in default_state().items():     # 字段缺失 → 补齐默认值
            st.setdefault(key, value)
        if not isinstance(st.get("sessions"), dict):
            st["sessions"] = {}
        if not isinstance(st.get("journal"), dict):
            st["journal"] = {}
        if not isinstance(st.get("settings"), dict):
            st["settings"] = dict(DEFAULT_SETTINGS)
    except Exception:
        return default_state()
    return st


def write_state(state: dict) -> bool:
    """原子写回（同目录临时文件 + os.replace）；失败返回 False，绝不抛异常。"""
    try:
        path = state_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp-%d" % os.getpid())
        tmp.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, path)
        return True
    except Exception:
        return False


def _flag(value, default: bool) -> bool:
    """宽松布尔：缺字段用默认值；兼容 1/0、"true"/"false" 之类的写法。"""
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on")
    return default


def now_ms() -> int:
    return int(time.time() * 1000)


# --------------------------------------------------------------------------
# 输入解析与信号归一化
# --------------------------------------------------------------------------

def read_payload():
    """从 stdin 读 hook 输入 JSON；空/坏 JSON/无 stdin → None（= 不干预）。"""
    try:
        if sys.stdin is None or sys.stdin.isatty():
            return None
    except Exception:
        return None
    try:
        raw = sys.stdin.read()
    except Exception:
        return None
    if not raw or not raw.strip():
        return None
    try:
        obj = json.loads(raw.lstrip("\ufeff"))
    except Exception:
        return None
    return obj if isinstance(obj, dict) else None


def session_id(payload: dict) -> str:
    """会话桶 key：优先 hook 输入，其次 hook 环境变量，最后 "default"。"""
    for key in ("session_id", "sessionId", "conversation_id", "conversationId"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    for key in ("ZCODE_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID"):
        value = (os.environ.get(key) or "").strip()
        if value:
            return value
    return "default"


def _first_num(*values):
    """取第一个可解析为数字的值；全都没有 → None（不猜）。"""
    for value in values:
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)):
            return value
        if isinstance(value, str):
            try:
                return float(value.strip())
            except Exception:
                continue
    return None


def _transcript_of(payload: dict) -> str:
    for key in ("transcript_path", "transcriptPath", "transcript"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def signals(payload: dict, data: dict) -> dict:
    """把 hook 输入 + 转录摘要归一化成判定信号；取不到的字段保持 None（不臆测）。"""
    usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
    t_usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}

    message = payload.get("last_assistant_message")
    if not isinstance(message, str):
        message = payload.get("lastAssistantMessage")
    if not isinstance(message, str):
        message = data.get("last_assistant_text") or ""

    calls = payload.get("toolCalls")
    tool_calls = _first_num(
        payload.get("toolCallCount"), payload.get("tool_call_count"),
        len(calls) if isinstance(calls, list) else None,
        payload.get("toolCallsCount"),
    )

    finish = (payload.get("finishReason") or payload.get("finish_reason")
              or data.get("finish_reason") or "")
    status = (payload.get("status") or payload.get("turnStatus")
              or data.get("status") or "")
    if payload.get("error"):
        status = status or "error"
    if payload.get("is_interrupt") or payload.get("interrupted"):
        status = status or "cancelled"

    return {
        "visible": message.strip(),
        "tool_calls": tool_calls,
        "output_tokens": _first_num(
            payload.get("output_tokens"), payload.get("outputTokens"),
            usage.get("output_tokens"), usage.get("outputTokens"),
            t_usage.get("output_tokens"), t_usage.get("outputTokens"),
        ),
        "reasoning_tokens": _first_num(
            payload.get("reasoning_tokens"), payload.get("reasoningTokens"),
            usage.get("reasoning_tokens"), usage.get("reasoningTokens"),
            t_usage.get("reasoning_tokens"), t_usage.get("reasoningTokens"),
        ),
        "finish_reason": str(finish).strip().lower(),
        "status": str(status).strip().lower(),
    }


# --------------------------------------------------------------------------
# 判定（§2.3.3 判定表，按序命中即用）
# --------------------------------------------------------------------------

def gate(state: dict, sid: str | None = None) -> str:
    """前置开关：任一不满足即不续跑（也保证「关闭自动继续时 loopguard 不被调用」）。

    传入 `sid` 时不看旧的全局 `runtime` —— 按会话模式由 `session_mode_of` 决定；
    这样老用户 `runtime=false` 后只要把某个会话切回开启，该会话就能恢复，
    不会被遗留的全局位永久拦住。
    """
    if not _flag(state.get("enabled"), True):
        return "disabled"
    if _flag(state.get("paused"), False):
        return "paused"
    if sid is None and not _flag(state.get("runtime"), True):
        return "runtime-off"
    return ""


def in_cooldown(state: dict, now: int, cooldown_ms: int = COOLDOWN_MS) -> bool:
    """冷却：距上次续跑不足 cooldown_ms → 放行 Stop（§2.3.2）。"""
    try:
        last = int(state.get("lastContinueAt") or 0)
    except Exception:
        last = 0
    return (now - last) < max(0, int(cooldown_ms))


def consecutive_of(state: dict, sid: str) -> int:
    sessions = state.get("sessions")
    entry = sessions.get(sid) if isinstance(sessions, dict) else None
    if not isinstance(entry, dict):
        return 0
    try:
        return max(0, int(entry.get("consecutive") or 0))
    except Exception:
        return 0


def decide(payload: dict, state: dict, data: dict, consecutive: int,
           settings: dict | None = None, max_consecutive: int = MAX_CONSECUTIVE) -> tuple:
    """返回 `(文本, 是否超限分支, 分支名)`；文本为 None 表示不续跑。

    `decide` 只做**分支识别**。会话模式（recover/loop/off）与设置项在 `handle_stop`
    里应用，这样单元测试可以继续验证纯判定表。`settings` 传入时用于关闭循环守卫。
    """
    sig = signals(payload, data)

    # 序 1：连续触发已达上限 → 发一次超限文本（#2），随后把计数清零并停（§2.3.2 / §2.3.3 行 1）。
    # 说明：契约行 1 的 `stop_hook_active` 只是「当前处于续跑链」的描述性条件；计数本身
    # 按 session 持久化，比该瞬时字段更可靠，因此以 `consecutive >= max_consecutive` 为准。
    limit = int(max_consecutive)
    if limit > 0 and consecutive >= limit:
        return TEXT_OVER_LIMIT, True, "over-limit"

    # 序 2：重复动作循环（loopguard，独立模块）；设置页可关闭。
    guard_enabled = True if settings is None else bool(settings.get("loopGuard", True))
    if guard_enabled and loopguard is not None:
        try:
            hit = loopguard.detect(_transcript_of(payload))
        except Exception:
            hit = None
        if hit and hit.get("looped"):
            return TEXT_LOOP, False, "loop"

    # 序 3：输出 token 上限（provider finishReason 归一化：max_output_tokens → length）
    if sig["finish_reason"] in ("max_output_tokens", "length"):
        return TEXT_MAX_TOKENS, False, "max-output-tokens"

    # 序 4：本轮无任何可见输出与工具调用
    if (not sig["visible"] and sig["tool_calls"] == 0
            and sig["output_tokens"] in (0, None)
            and not (sig["reasoning_tokens"] or 0) > 0):
        return TEXT_NO_OUTPUT, False, "no-output"

    # 序 5：仅输出推理即结束（有 reasoning token，无可见文本、无工具调用）
    if (sig["reasoning_tokens"] or 0) > 0 and not sig["visible"] and sig["tool_calls"] == 0:
        return TEXT_REASONING_ONLY, False, "reasoning-only"

    # 序 6：上一轮被中断 / 出错
    if sig["status"] in ("cancelled", "canceled", "error"):
        return TEXT_INTERRUPTED, False, "interrupted"

    # 序 7：其他（自主循环续跑）
    return TEXT_AUTONOMOUS, False, "autonomous"


def guard_text(data: dict, settings: dict | None = None) -> str:
    """护栏文（§2.3.3 末段）：解析转录里最后一次工具调用的结局。

    * 有 tool_use 但无对应 tool_result（或 result 为失败/中断）→ #7「可能未完成」；
    * 有 tool_use 且 result 成功 → #8「已完成，结果:{result}」（结果截断 ≤ 300 字符）。
    * `settings` 可覆盖两段护栏文案；`guardTools=false` 时由调用方直接跳过。
    """
    cfg = settings or {}
    pending_tpl = cfg.get("guardPendingText") or GUARD_PENDING
    done_tpl = cfg.get("guardDoneText") or GUARD_DONE
    calls = data.get("calls") or []
    if not calls:
        return ""
    last = calls[-1]
    tool = str(last.get("name") or "").strip() or "unknown"
    result = (data.get("results") or {}).get(str(last.get("id") or ""))
    if result is None or result.get("is_error"):
        return pending_tpl.format(tool=tool)
    summary = str(result.get("text") or "").strip() or "(无输出)"
    return done_tpl.format(tool=tool, result=summary[:RESULT_MAX_CHARS])


# --------------------------------------------------------------------------
# 输出与调试
# --------------------------------------------------------------------------

def emit(obj) -> None:
    """UTF-8 字节直写 stdout（绕开 Windows 控制台代码页），永不抛异常。"""
    try:
        data = json.dumps(obj, ensure_ascii=False)
        buf = getattr(sys.stdout, "buffer", None)
        if buf is not None:
            buf.write(data.encode("utf-8"))
            buf.flush()
        else:
            sys.stdout.write(data)
            sys.stdout.flush()
    except Exception:
        pass


def debug_log(event: str, branch: str, detail: str = "") -> None:
    """可选决策追踪（`PILOT_HOOK_DEBUG_LOG=<path>` 时开启；默认完全关闭）。

    只写文件、不碰 stdout/stderr —— 避免任何输出污染模型上下文。用于自测取证与现场排障。
    """
    path = (os.environ.get("PILOT_HOOK_DEBUG_LOG") or "").strip()
    if not path:
        return
    try:
        line = json.dumps(
            {"ts": now_ms(), "event": event, "branch": branch, "detail": detail},
            ensure_ascii=False,
        )
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except Exception:
        pass


# --------------------------------------------------------------------------
# 两个事件的处理
# --------------------------------------------------------------------------

def handle_user_prompt(payload: dict, state: dict) -> None:
    """UserPromptSubmit：用户自己说话了 → 该 session 的连续触发计数清零，不输出。"""
    sid = session_id(payload)
    sessions = state.setdefault("sessions", {})
    entry = sessions.get(sid)
    if not isinstance(entry, dict):
        entry = {}
    entry["consecutive"] = 0
    entry["lastAt"] = now_ms()
    sessions[sid] = entry
    write_state(state)
    debug_log("user-prompt", "reset", sid)


def handle_stop(payload: dict, state: dict) -> None:
    """Stop：判定是否需要续跑；需要则（宽限期后）输出 block，否则什么都不输出。

    判定顺序（与 dsh-client-auto-continue 对齐）：
      1. 全局开关（enabled/paused）与**本会话模式**；`off` 直接放行。
      2. 分支识别（loop / 超限 / 无输出 / 仅推理 / 中断 / 正常完成）。
      3. 模式门控：`recover` 不接力正常完成；`loop` 才允许自主循环。
      4. 静默开关、连续上限、冷却（自主循环接力不受后两者约束）。
      5. 选文本 + 幂等护栏 → 宽限 → 输出 block。
    """
    sid = session_id(payload)
    now = now_ms()

    blocked = gate(state, sid)
    if blocked:
        debug_log("stop", blocked, sid)
        return

    cfg = settings_of(state)
    mode = session_mode_of(state, sid, cfg)
    if mode == "off":
        debug_log("stop", "session-off", sid)
        return

    consecutive = consecutive_of(state, sid)
    max_consecutive = int(cfg.get("maxConsecutive") or MAX_CONSECUTIVE)
    transcript = _transcript_of(payload)
    data = loopguard.load_transcript(transcript) if loopguard is not None else {
        "calls": [], "results": {}, "last_assistant_text": "",
        "usage": {}, "finish_reason": None, "status": None,
    }

    # loop 模式下先不把连续上限塞给 decide，避免正常完成的自主接力被误判为超限；
    # 失败分支的连续上限在下面单独处理。
    probe_limit = 0 if mode == "loop" else max_consecutive
    _text, over_limit, branch = decide(payload, state, data, consecutive,
                                       cfg, probe_limit)

    # 模式门控：仅故障恢复不接力正常完成的回合。
    if branch == "autonomous" and mode != "loop":
        debug_log("stop", "mode-recover", sid)
        return
    # 静默回合开关（无输出 / 仅推理）。
    if branch in ("no-output", "reasoning-only") and not cfg.get("resumeSilentTurns", True):
        debug_log("stop", "silent-off", sid)
        return

    # loop 模式下失败分支的连续上限（decide 被 probe_limit=0 跳过）。
    if mode == "loop" and branch != "autonomous" and not over_limit:
        if consecutive >= max_consecutive:
            over_limit, branch = True, "over-limit"

    # 冷却只约束故障恢复；正常完成的自主循环接力不受限。
    if branch != "autonomous" and in_cooldown(state, now, int(cfg.get("cooldownMs") or COOLDOWN_MS)):
        debug_log("stop", "cooldown", sid)
        return

    text = text_for(branch, cfg)
    guard = "" if not cfg.get("guardTools", True) else guard_text(data, cfg)
    final = text + ("\n\n" + guard if guard else "")

    # 宽限期：只在「确定要续跑」之后等（§2.3.2）。
    try:
        time.sleep(max(0, int(cfg.get("graceMs") or GRACE_MS)) / 1000.0)
    except Exception:
        pass

    # 读-改-写：只碰 lastContinueAt / sessions，其余字段（含 settings）原样保留。
    sessions = state.setdefault("sessions", {})
    entry = sessions.get(sid)
    if not isinstance(entry, dict):
        entry = {}
    if over_limit:
        entry["consecutive"] = 0
    elif branch == "autonomous":
        entry["consecutive"] = consecutive          # 自主接力不计入连续上限
    else:
        entry["consecutive"] = consecutive + 1
    entry["lastAt"] = now_ms()
    sessions[sid] = entry
    state["lastContinueAt"] = now_ms()
    write_state(state)

    debug_log("stop", branch, "%s | mode=%s | consecutive=%s" % (sid, mode, entry["consecutive"]))
    emit({"decision": "block", "reason": final})


# --------------------------------------------------------------------------
# 入口
# --------------------------------------------------------------------------

def main(argv=None) -> int:
    try:
        parser = argparse.ArgumentParser(add_help=False)
        parser.add_argument("--event", default="")
        args, _unknown = parser.parse_known_args(argv)
    except Exception:
        return 0
    try:
        safe_stdio()
    except Exception:
        pass

    event = str(args.event or "").strip().lower()
    if event not in ("stop", "user-prompt"):
        return 0

    payload = read_payload()
    if payload is None:
        return 0

    try:
        state = read_state()
        if event == "user-prompt":
            handle_user_prompt(payload, state)
        else:
            handle_stop(payload, state)
    except Exception as exc:  # 兜底：绝不把异常写进 stdout/stderr
        debug_log(event, "error", type(exc).__name__)
    return 0


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        pass
    sys.exit(0)
