#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""zcode-pilot 循环守卫（独立模块，契约 docs/CONTRACT.md §2.3）

职责：从 hook 传入的 `transcript_path`（JSONL 全量转录）里识别「重复动作循环」，
命中时返回 `{"looped": True, "tool": <工具名>, "repeat": <重复次数>}`，未命中返回 None。

判据（任务 task-6 C 节）：
  最近 WINDOW 次工具调用中，同一 `tool_name + 归一化参数指纹` **尾部连续重复 ≥ REPEAT_MIN 次**，
  且这些调用的输出之间**没有任何差异信号**（结果文本逐字等价，或缺结果）→ 判循环。
  * 参数归一化忽略时间戳、UUID/长 hex、临时目录、requestId/sessionId 等噪声；
  * 结果归一化同样抹掉时间戳/UUID/临时路径，再比对摘要；
  * 尾部连续 = 「现在仍卡在同一个动作上」；中途换了别的动作并已产生输出 → 不算循环（避免误伤）。

独立可单测：
    python loopguard.py --transcript <transcript.jsonl>      # 打印 JSON 结果

本模块**只做判定**，不读状态文件、不写盘、不打印到 stderr；由 autocontinue_hook.py 调用，
且只在「自动继续处于开启态」时才会被调用（前置判定由 hook 负责，见契约 §2.3 表格）。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys

# --------------------------------------------------------------------------
# 常量
# --------------------------------------------------------------------------

#: 只看最近多少次工具调用
WINDOW = 12
#: 同一指纹尾部连续重复多少次判为循环
REPEAT_MIN = 3
#: 转录文件读取上限（防超大文件拖慢 hook；超出即截断读取）
MAX_READ_BYTES = 8 * 1024 * 1024

#: 参与「参数指纹」计算时需要整体丢弃的噪声键（小写比较）
_NOISE_KEYS = frozenset({
    "timestamp", "time", "ts", "createdat", "updatedat", "startedat", "finishedat",
    "requestid", "request_id", "traceid", "trace_id", "turnid", "turn_id",
    "uuid", "id", "sessionid", "session_id", "tooluseid", "tool_use_id",
    "nonce", "random", "seed", "duration", "durationms", "duration_ms",
    "elapsed", "elapsed_ms", "index", "sequence", "seq",
})

_RE_UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
_RE_ISO = re.compile(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?")
#: 13 位毫秒时间戳（2001–2033）与 10 位秒时间戳；刻意不用宽泛的 \d+，避免误伤普通数字
_RE_EPOCH_MS = re.compile(r"\b1\d{12}\b")
_RE_EPOCH_S = re.compile(r"\b1\d{9}\b")
_RE_TMPPATH = re.compile(r"(?i)([\\/](?:tmp|temp|var[\\/]folders|appdata[\\/]local[\\/]temp)[\\/])[^\\/\s\"']+")
_RE_HEX = re.compile(r"\b[0-9a-fA-F]{16,}\b")
_RE_WS = re.compile(r"\s+")


# --------------------------------------------------------------------------
# 归一化
# --------------------------------------------------------------------------

def _clean_str(text: str) -> str:
    """抹掉字符串里的时间戳 / UUID / 长 hex / 临时路径等噪声，并压平空白。"""
    s = _RE_UUID.sub("<uuid>", text)
    s = _RE_ISO.sub("<ts>", s)
    s = _RE_EPOCH_MS.sub("<ts>", s)
    s = _RE_EPOCH_S.sub("<ts>", s)
    s = _RE_TMPPATH.sub(r"\1<tmp>", s)
    s = _RE_HEX.sub("<hex>", s)
    return _RE_WS.sub(" ", s).strip()


def _normalize(value, depth: int = 0):
    """递归归一化参数值：丢噪声键、字符串去噪、限制深度与列表长度。"""
    if depth > 6:
        return "<deep>"
    if isinstance(value, dict):
        out = {}
        for key in sorted(value.keys(), key=str):
            if str(key).strip().lower() in _NOISE_KEYS:
                continue
            out[str(key)] = _normalize(value[key], depth + 1)
        return out
    if isinstance(value, (list, tuple)):
        return [_normalize(v, depth + 1) for v in list(value)[:50]]
    if isinstance(value, str):
        return _clean_str(value)
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, float):
        return round(value, 6)
    return value


def fingerprint(call: dict) -> str:
    """工具调用指纹：`tool_name` + 归一化参数 的 sha1 前 16 位。"""
    name = str(call.get("name") or "").strip().lower()
    payload = json.dumps(
        {"tool": name, "input": _normalize(call.get("input"))},
        sort_keys=True, ensure_ascii=False, default=str,
    )
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:16]


def result_digest(result) -> str:
    """工具结果的指纹；None（结果未回填）单独成一类。"""
    if result is None:
        return "<none>"
    text = _clean_str(str(result.get("text") or ""))
    flag = "E" if result.get("is_error") else "O"
    return hashlib.sha1((flag + text).encode("utf-8")).hexdigest()[:16]


# --------------------------------------------------------------------------
# 转录解析（JSONL；容错，绝不抛异常）
# --------------------------------------------------------------------------

def _result_of(block: dict) -> dict:
    """把 tool_result 块压成 `{"text": <摘要>, "is_error": bool}`。"""
    raw = block.get("content")
    parts: list[str] = []
    if isinstance(raw, str):
        parts.append(raw)
    elif isinstance(raw, list):
        for item in raw:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                if isinstance(item.get("text"), str):
                    parts.append(item["text"])
                elif item.get("type") == "image":
                    parts.append("[image]")
    elif isinstance(raw, dict):
        if isinstance(raw.get("text"), str):
            parts.append(raw["text"])
        else:
            parts.append(json.dumps(raw, ensure_ascii=False, default=str))
    elif raw is not None:
        parts.append(str(raw))
    return {
        "text": _RE_WS.sub(" ", " ".join(parts)).strip(),
        "is_error": bool(block.get("is_error") or block.get("isError")),
    }


def _collect_block(block: dict, acc: dict) -> None:
    kind = block.get("type")
    if kind == "tool_use":
        acc["calls"].append({
            "id": str(block.get("id") or block.get("tool_use_id") or ""),
            "name": str(block.get("name") or ""),
            "input": block.get("input"),
        })
    elif kind == "tool_result":
        tid = str(block.get("tool_use_id") or block.get("toolUseId") or "")
        if tid:
            acc["results"][tid] = _result_of(block)
    elif kind == "text" and isinstance(block.get("text"), str):
        acc["texts"].append(block["text"])


def _collect(obj, acc: dict) -> None:
    """从一条转录记录里抽取工具调用 / 结果 / 文本 / usage / finishReason / status。"""
    if not isinstance(obj, dict):
        return
    # 1) 标准块形态：message.content 与 content（去重，避免同一 dict 被走两遍）
    seen: set[int] = set()
    for container in (obj.get("message"), obj):
        if not isinstance(container, dict) or id(container) in seen:
            continue
        seen.add(id(container))
        content = container.get("content")
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict):
                    _collect_block(block, acc)
        elif isinstance(content, dict):
            _collect_block(content, acc)
        usage = container.get("usage")
        if isinstance(usage, dict):
            acc["usage"] = usage
        fr = container.get("finish_reason") or container.get("finishReason")
        if isinstance(fr, str) and fr.strip():
            acc["finish_reason"] = fr.strip()
    # 2) 扁平形态（部分转录实现会把 tool_use 直接摊在顶层）
    if obj.get("type") == "tool_use" and obj.get("name") and "input" in obj:
        acc["calls"].append({
            "id": str(obj.get("id") or obj.get("tool_use_id") or ""),
            "name": str(obj.get("name") or ""),
            "input": obj.get("input"),
        })
    elif obj.get("type") == "tool_result" and (obj.get("tool_use_id") or obj.get("toolUseId")):
        acc["results"][str(obj.get("tool_use_id") or obj.get("toolUseId"))] = _result_of(obj)
    # 3) 状态信号
    status = obj.get("status")
    if isinstance(status, str) and status.strip():
        acc["status"] = status.strip()
    subtype = obj.get("subtype")
    if isinstance(subtype, str) and subtype.strip().lower() in ("error", "cancelled", "canceled", "interrupted"):
        acc["status"] = subtype.strip().lower()
    if obj.get("type") == "error" or obj.get("is_error") is True:
        acc["status"] = "error"


def load_transcript(path) -> dict:
    """读 JSONL 转录，返回结构化摘要；文件缺失/坏行一律静默跳过。

    返回：`{"calls": [...], "results": {id: {...}}, "last_assistant_text": str,
            "usage": {...}, "finish_reason": str|None, "status": str|None}`
    """
    acc: dict = {
        "calls": [], "results": {}, "texts": [],
        "usage": {}, "finish_reason": None, "status": None,
    }
    if not path:
        return _finish_acc(acc)
    try:
        with open(str(path), "r", encoding="utf-8", errors="replace") as fh:
            data = fh.read(MAX_READ_BYTES)
    except Exception:
        return _finish_acc(acc)
    for line in data.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        try:
            _collect(obj, acc)
        except Exception:
            continue
    return _finish_acc(acc)


def _finish_acc(acc: dict) -> dict:
    texts = [t for t in acc.get("texts", []) if isinstance(t, str) and t.strip()]
    acc["last_assistant_text"] = texts[-1].strip() if texts else ""
    return acc


# --------------------------------------------------------------------------
# 判定
# --------------------------------------------------------------------------

def detect(transcript_path) -> dict | None:
    """检测重复动作循环；命中返回 `{"looped": True, "tool", "repeat"}`，否则 None。"""
    data = load_transcript(transcript_path)
    calls = data.get("calls") or []
    if len(calls) < REPEAT_MIN:
        return None
    window = calls[-WINDOW:]
    fps = [fingerprint(c) for c in window]
    last = fps[-1]
    repeat = 0
    for fp in reversed(fps):
        if fp == last:
            repeat += 1
        else:
            break
    if repeat < REPEAT_MIN:
        return None
    group = window[len(window) - repeat:]
    # 「期间没有产生新的输出差异信号」：同指纹调用的结果摘要必须等价（或缺结果）
    digests = {result_digest(data["results"].get(str(c.get("id") or ""))) for c in group}
    if len(digests) > 1:
        return None
    return {"looped": True, "tool": str(window[-1].get("name") or ""), "repeat": repeat}


def _emit(obj) -> None:
    """UTF-8 字节直写 stdout（绕开 Windows 控制台代码页）。"""
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


def main(argv=None) -> int:
    try:
        parser = argparse.ArgumentParser(
            prog="loopguard.py",
            description="zcode-pilot 循环守卫：检测转录里的重复动作循环（只读、不写盘）",
        )
        parser.add_argument("--transcript", required=True, help="hook 传入的 JSONL 转录路径")
        args = parser.parse_args(argv)
        result = detect(args.transcript)
    except SystemExit:
        raise
    except Exception:
        result = None
    _emit(result if result else {"looped": False})
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except BaseException:
        sys.exit(0)
