#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ZCode 请求捕获代理（tap proxy）——验证思考等级等参数是否真的发出
=================================================================
在 ZCode 与供应商/网关之间插一层本地代理：原样转发请求与响应（含 SSE 流式），
同时把每个请求的**真实请求体**打到控制台并存成 JSONL，重点高亮思考参数：

  reasoning_effort / reasoningEffort / thinking{budget_tokens} / output_config.effort

用它能一眼确认三件事：
  1. 传输层：档位选择后，请求体里到底有没有对应参数（这是本地日志看不到的，
     rollout 里的 thinking 字段是脱敏剥掉的）
  2. 取值层：选了「最高」发的是 max 还是被折算成了 xhigh；选「关闭」是不发还是发 off
  3. 生效层：流式响应里 reasoning 内容长度 / usage 里的推理 token 数，
     对比不同档位是否有实质差异（同时验证网关的 supported_efforts 降级是否触发）

用法：
  python tap_proxy.py --listen 127.0.0.1:7864 --target http://127.0.0.1:7863
  # 然后在 ZCode 里把（测试用）供应商的 Base URL 指到 http://127.0.0.1:7864/v1
  # 发一轮对话，本工具会把请求体与流内统计打出来

  python tap_proxy.py --target https://api.deepseek.com --capture cap.jsonl
  python tap_proxy.py --target http://127.0.0.1:8000 --only chat   # 只看对话请求

选项：
  --listen HOST:PORT   监听地址（默认 127.0.0.1:7864）
  --target URL         转发目标（scheme://host:port，可带路径前缀）
  --capture FILE       把捕获记录写成 JSONL（默认 tap-capture.jsonl）
  --quiet              只打印思考参数与流内统计，不打印完整头部
  --full               额外打印完整请求体（默认只打印关键字段 + 摘要）

说明：为便于解析 SSE，转发时会把 Accept-Encoding 置为 identity（仅本代理内生效）。
      ZCode 运行中改供应商 Base URL 请在界面里改；测完记得改回。
"""

import argparse
import http.client
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

try:                                   # 控制台编码安全网（见 _console.py 的说明）
    from _console import safe_stdio, warn_mark
except ImportError:                    # 被别处 import 时脚本目录可能不在 sys.path
    import os
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from _console import safe_stdio, warn_mark

HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "host", "content-length",
}

# 思考参数相关的键（命中就高亮）
THINK_KEYS = ("reasoning_effort", "reasoningEffort", "thinking", "budget_tokens",
              "budgetTokens", "effort", "output_config", "enable_thinking",
              "reasoning_enabled", "think")

ARGS = None
SEQ = 0
LOCK = threading.Lock()
CAP_FILE = None


def _log(msg: str) -> None:
    print(msg, flush=True)


def _next_seq() -> int:
    global SEQ
    with LOCK:
        SEQ += 1
        return SEQ


def extract_think_params(body: dict) -> dict:
    """从请求体里挑出与思考有关的字段（含嵌套若干层）。"""
    found = {}

    def walk(node, prefix=""):
        if isinstance(node, dict):
            for k, v in node.items():
                path = f"{prefix}{k}"
                if k in THINK_KEYS and not isinstance(v, (dict, list)):
                    found[path] = v
                elif k in THINK_KEYS and isinstance(v, dict):
                    # thinking:{type,budget_tokens} / output_config:{effort}
                    for kk, vv in v.items():
                        if not isinstance(vv, (dict, list)):
                            found[f"{path}.{kk}"] = vv
                    walk(v, path + ".")
                else:
                    walk(v, path + ".")
        elif isinstance(node, list):
            for i, v in enumerate(node[:3]):
                walk(v, f"{prefix}[{i}].")

    walk(body)
    return found


def parse_usage_from_sse(chunk_text: str, acc: dict) -> None:
    """从 SSE 文本里累积 usage 与 reasoning/正文长度。"""
    for line in chunk_text.splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            obj = json.loads(payload)
        except Exception:
            continue
        usage = obj.get("usage")
        if isinstance(usage, dict):
            acc["usage"] = usage
        for choice in obj.get("choices") or []:
            if not isinstance(choice, dict):
                continue
            delta = choice.get("delta") or choice.get("message") or {}
            if isinstance(delta, dict):
                for key in ("reasoning_content", "reasoning", "thinking"):
                    v = delta.get(key)
                    if isinstance(v, str):
                        acc["reason_chars"] = acc.get("reason_chars", 0) + len(v)
                v = delta.get("content")
                if isinstance(v, str):
                    acc["text_chars"] = acc.get("text_chars", 0) + len(v)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "zcode-tap/1.0"

    def log_message(self, *args):   # 静音默认访问日志
        pass

    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")

    def do_PUT(self):
        self._handle("PUT")

    def do_DELETE(self):
        self._handle("DELETE")

    def _handle(self, method: str) -> None:
        n = _next_seq()
        raw_len = int(self.headers.get("Content-Length") or 0)
        raw_body = self.rfile.read(raw_len) if raw_len else b""

        body_json = None
        if raw_body:
            try:
                body_json = json.loads(raw_body.decode("utf-8"))
            except Exception:
                body_json = None

        # ---- 打印请求侧 ----
        is_chat = "/chat/completions" in self.path or "/messages" in self.path
        if is_chat or not ARGS.only_chat:
            _log(f"\n{'='*78}\n[#{n}] {method} {self.path}")
            if body_json:
                model = body_json.get("model")
                _log(f"  model={model}  stream={body_json.get('stream')}  "
                     f"max_tokens={body_json.get('max_tokens') or body_json.get('max_completion_tokens')}")
                tp = extract_think_params(body_json)
                top = ("  ◆ 思考参数: " + "  ".join(f"{k}={v!r}" for k, v in tp.items())) if tp \
                    else "  ◆ 思考参数: （无！）"
                _log(top)
                msgs = body_json.get("messages")
                if isinstance(msgs, list):
                    _log(f"  messages={len(msgs)} 条")
            else:
                _log("  （无 JSON 请求体）")
            if ARGS.full and raw_body:
                _log("  --- 请求体 ---")
                _log(json.dumps(body_json, ensure_ascii=False, indent=2)[:4000]
                     if body_json else raw_body.decode("utf-8", "replace")[:4000])
            if not ARGS.quiet:
                _log("  --- 请求头 ---")
                for k, v in self.headers.items():
                    if k.lower() in ("authorization", "x-api-key"):
                        v = (v[:8] + "…") if len(v) > 8 else "…"
                    _log(f"    {k}: {v}")

        # ---- 转发 ----
        target = ARGS.target.rstrip("/")
        path = self.path
        # 目标带路径前缀时避免 /v1 重复拼接
        tparts = urlsplit(target)
        if tparts.path.rstrip("/").endswith("/v1") and path.startswith("/v1/"):
            path = path[3:]
        url = target + path
        parts = urlsplit(url)
        scheme = parts.scheme or "http"
        host = parts.hostname
        port = parts.port or (443 if scheme == "https" else 80)
        fpath = parts.path + (("?" + parts.query) if parts.query else "")

        fwd_headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP_BY_HOP}
        fwd_headers["Accept-Encoding"] = "identity"   # 便于解析 SSE 原文

        conn_cls = http.client.HTTPSConnection if scheme == "https" else http.client.HTTPConnection
        try:
            conn = conn_cls(host, port, timeout=ARGS.timeout)
            conn.request(method, fpath, body=raw_body or None, headers=fwd_headers)
            resp = conn.getresponse()
        except Exception as e:
            _log(f"  ✗ 转发失败: {e}")
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            payload = json.dumps({"error": {"message": f"tap proxy upstream error: {e}"}}).encode()
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return

        ctype = resp.getheader("Content-Type") or ""
        is_stream = "event-stream" in ctype.lower()

        # ---- 回送响应（流式用 chunked 边收边发） ----
        self.send_response(resp.status)
        for k, v in resp.getheaders():
            if k.lower() in HOP_BY_HOP:
                continue
            self.send_header(k, v)
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

        acc = {}
        sse_buf = ""
        total = 0
        try:
            while True:
                piece = resp.read1(8192) if hasattr(resp, "read1") else resp.read(8192)
                if not piece:
                    break
                total += len(piece)
                if is_stream:
                    sse_buf += piece.decode("utf-8", "replace")
                    while "\n" in sse_buf:
                        line, sse_buf = sse_buf.split("\n", 1)
                        parse_usage_from_sse(line + "\n", acc)
                self.wfile.write(b"%X\r\n" % len(piece) + piece + b"\r\n")
                self.wfile.flush()
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            try:
                conn.close()
            except Exception:
                pass

        # ---- 打印响应侧统计 ----
        if is_chat or not ARGS.only_chat:
            usage = acc.get("usage") or {}
            bits = [f"响应 {resp.status} {ctype or '-'}", f"{total:,}B"]
            if acc.get("reason_chars"):
                bits.append(f"推理字符 {acc['reason_chars']:,}")
            if acc.get("text_chars"):
                bits.append(f"正文 {acc['text_chars']:,}")
            if usage:
                rt = usage.get("completion_tokens_details", {}).get("reasoning_tokens") \
                    if isinstance(usage.get("completion_tokens_details"), dict) else None
                bits.append(f"usage: in={usage.get('prompt_tokens')} out={usage.get('completion_tokens')}"
                            + (f" 推理={rt}" if rt is not None else ""))
            _log("  ◇ " + " | ".join(bits))

        # ---- 落盘 ----
        if CAP_FILE is not None:
            rec = {
                "seq": n, "time": time.strftime("%Y-%m-%d %H:%M:%S"),
                "method": method, "path": self.path, "target": url,
                "model": (body_json or {}).get("model"),
                "think_params": extract_think_params(body_json) if body_json else {},
                "max_tokens": (body_json or {}).get("max_tokens"),
                "status": resp.status, "bytes": total,
                "stream": is_stream,
                "reason_chars": acc.get("reason_chars"),
                "text_chars": acc.get("text_chars"),
                "usage": acc.get("usage"),
                "request_body": body_json if ARGS.capture_body else None,
            }
            with LOCK:
                CAP_FILE.write(json.dumps(rec, ensure_ascii=False) + "\n")
                CAP_FILE.flush()


def main() -> None:
    global ARGS, CAP_FILE
    safe_stdio()          # 输出被重定向时 cp936 会编不出符号，先把这条路封死
    ap = argparse.ArgumentParser(description="ZCode 请求捕获代理：验证思考等级等参数是否真的发出")
    ap.add_argument("--listen", default="127.0.0.1:7864", help="监听地址（默认 127.0.0.1:7864）")
    ap.add_argument("--target", required=True, help="转发目标，如 http://127.0.0.1:7863")
    ap.add_argument("--capture", default="tap-capture.jsonl", help="JSONL 记录文件")
    ap.add_argument("--capture-body", action="store_true", help="记录里附完整请求体（注意含 Key）")
    ap.add_argument("--only-chat", dest="only_chat", action="store_true",
                    help="只显示对话/messages 请求，忽略 /models 等")
    ap.add_argument("--quiet", action="store_true", help="不打印请求头")
    ap.add_argument("--full", action="store_true", help="打印完整请求体")
    ap.add_argument("--timeout", type=float, default=600, help="上游超时秒数（默认 600，思考模型较慢）")
    ARGS = ap.parse_args()

    host, _, port = ARGS.listen.partition(":")
    CAP_FILE = open(ARGS.capture, "w", encoding="utf-8")

    _log(f"ZCode 请求捕获代理")
    _log(f"  监听 : http://{host}:{port}")
    _log(f"  转发 : {ARGS.target}")
    _log(f"  记录 : {ARGS.capture}")
    _log(f"  → 把 ZCode 里（测试用）供应商的 Base URL 指到 http://{host}:{port}/v1 即可")
    _log(f"  → Ctrl-C 结束\n")
    _log(f"  {warn_mark()} 安全提醒：本代理会**看到你的 API Key**（原样转发 Authorization / x-api-key 头），")
    _log("    捕获文件里含请求体与凭据 —— 不要提交到仓库、不要分享；")
    _log("    测完请把供应商的 Base URL 改回原地址，避免长期走代理。\n")

    srv = ThreadingHTTPServer((host, int(port)), Handler)
    srv.daemon_threads = True
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        _log("\n已停止")
    finally:
        CAP_FILE.close()


if __name__ == "__main__":
    main()
