#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""客户端升级契约核对（纯只读）。

用途：ZCode 每次升级都会整体覆盖 `app.asar`。补丁能不能原样重打，取决于注入所依赖的
结构锚点、渲染层 `data-testid`、DOM 属性与遥测字段还在不在。客户端一改版，先跑本脚本，
命中情况一目了然，不用逐个 `--check` 猜。

与 `zcp_patcher.py` 的分工（勿混用）：
  - 本脚本只看「客户端结构契约是否存在」，**不判断补丁打没打**；
  - 补丁状态与用量图截断表达式的落位，用
    `python skills/zcode-pilot/scripts/zcp_patcher.py --all --check`
    （未打时可用 `--all --dry-run` 预演，它会报「拒绝盲改」与否）。

用法：
  python tools/check_client_contract.py                      # 自动定位本机 ZCode 安装
  python tools/check_client_contract.py --asar D:\\ZCode\\resources\\app.asar
  python tools/check_client_contract.py --json               # 机器可读输出（贴给别人/CI 留档）

退出码：0 全部命中 / 1 有缺失（该重新提取锚点或补契约串）/ 3 定位不到安装或 asar。

判定口径：契约串按「在整包字节里出现 >= 1 次」计为命中。插件**自己写到 DOM 上**的属性
（`data-zpilot*` / `data-zps*` / `data-ztps*` / `data-zenhance*` 等）不作为契约 ——
未打补丁时它们本来就不存在，纳进来只会造成假失配。

性能口径：整包 370MB+，只做 `bytes.count` 与必要的窗口邻近校验；**不要在整包上跑带
`\\w+` 的正则**（实测单次可达分钟级，是本脚本曾经的超时根因）。混淆变量名一律用
「固定子串 + 前置子串邻近」表达，语义等价且快两个数量级。
"""

import argparse
import importlib.util
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "skills" / "zcode-pilot" / "scripts"
JS_FILES = ("zcode-pilot.js", "zcode-tps.js", "zcode-enhance-prompt.js", "zcode-model-puller.js")

# 注入脚本自己往 DOM 上写的属性前缀/名字：不作为客户端契约
OWN_PREFIXES = ("data-zpilot", "data-zps", "data-ztps", "data-zenhance", "data-zcp")
OWN_ATTRS = {"data-busy", "data-runtime", "data-placement", "data-show", "data-state",
             "data-open", "data-index", "data-role", "data-key"}

# —— 手写核心契约：客户端提供的注入点 / test-id / DOM / 遥测字段 ——
# 依据：README「历史版本审计」0.9.0 逐项复核过的清单，及 0.9.1 在 3.18.1 上的实测命中。
# (名称, 固定子串, 前置邻近子串或 None, 邻近窗口字节数)
ANCHORS = [
    ("preload 桥挂载点", 'contextBridge.exposeInMainWorld("zcode",{', None, 0),
    ("main IPC 挂载点", ".SaveMcpToUserDirectory", ".handle(", 40),
]
TIDS = ["v4-composer", "v4-stop", "v4-model-config",
        "chat-mode-select-trigger", "model-provider-add-model-button"]
DOM = ["data-workspace-conversation-frame", "data-session-id", "data-turn-id", "data-settings-"]
# data-session-id 的降级备选链：主键缺失时脚本会退到这两个，三者全缺才算真失配
DOM_FALLBACK = ["data-conversation-id", "data-thread-id"]
TELEMETRY = ["turnHeader", "usage.delta", "modelDurationMs", "toolDurationMs",
             "cacheReadTokens", "cacheWriteTokens", "inputTokens", "outputTokens",
             "reasoningTokens", "totalTokens", "requestId", "finishReason"]

# 契约串最小长度：短于它的混淆名（如历史兜底 `Goe`）在整包里必然假命中，不作契约
MIN_TOKEN_LEN = 6

# 从注入脚本里自动提取 testid / data-*，避免清单随 JS 演进过时
RX_TESTID = [
    re.compile(r'data-testid\s*=\s*["\'`]([A-Za-z0-9_.\-]+)["\'`]'),
    re.compile(r'\[data-testid=(["\'`]?)([A-Za-z0-9_.\-]+)\1\]'),
]
RX_DATA_ATTR = [
    re.compile(r'["\']data-([a-z][a-z0-9-]{3,})["\']'),
    re.compile(r'\[data-([a-z][a-z0-9-]{3,})[=~^$*|]'),
]


def load_patcher():
    """按路径加载 zcp_patcher，复用它的安装探测与 asar 解析（避免复制一份 header 解析逻辑）。"""
    path = SCRIPTS / "zcp_patcher.py"
    if not path.is_file():
        raise SystemExit(f"[!] 找不到 {path}")
    spec = importlib.util.spec_from_file_location("zcp_patcher", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def locate_asar(zp, explicit: str | None) -> Path | None:
    if explicit:
        p = Path(explicit)
        if p.is_file():
            return p
        for root in (p, p / "Contents"):
            cand = root / "resources" / "app.asar"
            if cand.is_file():
                return cand
        return None
    for cjs in zp.discover():
        asar = cjs.parent.parent / "app.asar"
        if asar.is_file():
            return asar
    return None


def count_needle(blob: bytes, needle: str, prefix: str | None = None, window: int = 0) -> int:
    """固定子串命中数；给了 prefix 则只统计「其前 window 字节内出现 prefix」的那些命中。

    整包只做 memmem 级的查找，不用大正则 —— 370MB 上跑 `\\w+` 正则是分钟级开销。
    """
    nb, pb = needle.encode(), (prefix.encode() if prefix else None)
    n, start = 0, 0
    while True:
        i = blob.find(nb, start)
        if i < 0:
            return n
        start = i + 1
        if pb is None:
            n += 1
        elif blob.rfind(pb, max(0, i - window), i) != -1:
            n += 1


def scan_js_contracts(seen: set[str]):
    """从 4 个注入脚本里提取 testid / data-* 契约，剔除插件自有属性与已核对项。

    长度门槛（MIN_TOKEN_LEN）是必需的：注入脚本里留着老客户端的兜底选择器（如
    `button[data-testid="Goe"]`），这类 3 字母混淆串在 370MB 整包里必然「假命中」，
    当作契约既无信息量又会掩盖真实失配。
    """
    tids, attrs = [], []
    for name in JS_FILES:
        p = SCRIPTS / name
        if not p.is_file():
            continue
        txt = p.read_text(encoding="utf-8", errors="replace")
        for rx in RX_TESTID:
            g2 = rx.groups >= 2
            for m in rx.finditer(txt):
                v = (m.group(2) or m.group(1)) if g2 else m.group(1)
                if v and "${" not in v and len(v) >= MIN_TOKEN_LEN and v not in seen:
                    seen.add(v)
                    tids.append(v)
        for rx in RX_DATA_ATTR:
            for m in rx.finditer(txt):
                full = "data-" + m.group(1)
                if full.startswith(OWN_PREFIXES) or full in OWN_ATTRS or full in seen:
                    continue
                if full in DOM_FALLBACK or full == "data-testid":   # 备选链 / 属性名自身
                    seen.add(full)
                    continue
                seen.add(full)
                attrs.append(full)
    return sorted(set(tids)), sorted(set(attrs))


def main() -> int:
    ap = argparse.ArgumentParser(description="核对注入依赖的客户端结构契约是否还在（只读）")
    ap.add_argument("--asar", help="app.asar 路径或其安装根目录（缺省自动探测本机安装）")
    ap.add_argument("--json", action="store_true", help="以 JSON 输出")
    ap.add_argument("--verbose", action="store_true", help="列出命中项（默认只报缺失）")
    args = ap.parse_args()

    zp = load_patcher()
    asar = locate_asar(zp, args.asar)
    if not asar:
        print("[!] 定位不到 ZCode 安装（找不到 app.asar）—— 用 --asar 指定路径")
        return 3

    blob = asar.read_bytes()
    version = zp.asar_version(asar) or "未知"
    results = []                                    # (分组, 名称, 命中次数, 是否达标)

    # 1) 注入锚点：固定子串 +（可选）前置邻近
    for label, needle, prefix, window in ANCHORS:
        n = count_needle(blob, needle, prefix, window)
        results.append(("注入锚点", label, n, n >= 1))

    # 2) index.html 的单 </body>：挂载 script tag 依赖它唯一，多个则注入点不确定
    try:
        raw, header, data_start = zp._asar_header_raw(asar)
        ent = dict(zp._asar_walk_entries(header)).get("out/renderer/index.html")
        html = zp._asar_entry_bytes(raw, data_start, ent) if ent else b""
        n = html.count(b"</body>")
        results.append(("注入锚点", "index.html 唯一 </body>", n, n == 1))
    except Exception as e:                          # noqa: BLE001
        results.append(("注入锚点", f"index.html 解析失败：{type(e).__name__}", 0, False))

    # 3) 手写清单 + 4) 从 JS 自动提取的清单（去重，同一串只数一次）
    auto_tids, auto_attrs = scan_js_contracts(set(TIDS) | set(DOM))
    for group, keys in (("渲染层 test-id", TIDS),
                        ("DOM 契约", DOM),
                        ("遥测字段", TELEMETRY),
                        ("test-id（JS 自动提取）", auto_tids),
                        ("DOM 契约（JS 自动提取）", auto_attrs)):
        for k in keys:
            n = blob.count(k.encode())
            ok = n >= 1
            if group == "DOM 契约" and not ok and k in DOM:
                ok = any(blob.count(x.encode()) for x in DOM_FALLBACK)
            results.append((group, k, n, ok))

    missing = [r for r in results if not r[3]]

    if args.json:
        print(json.dumps({
            "asar": str(asar), "version": version, "bytes": len(blob),
            "total": len(results), "missing": len(missing),
            "items": [{"group": g, "name": n, "count": c, "ok": o} for g, n, c, o in results],
        }, ensure_ascii=False, indent=2))
    else:
        print(f"=== 客户端契约核对 | 版本 {version} | {len(blob):,} 字节 ===")
        cur = None
        for g, name, n, ok in results:
            if g != cur:
                print(f"\n[{g}]")
                cur = g
            if ok and args.verbose:
                print(f"  [√] {name}  ×{n}")
            elif not ok:
                print(f"  [×] {name}  ×{n}   ← 缺失")
        if not args.verbose:
            print(f"\n命中 {len(results) - len(missing)} / {len(results)}")
        if missing:
            print(f"\n[!] {len(missing)} 项契约在当前客户端里找不到：")
            for g, name, n, _ in missing:
                print(f"    - {g} · {name}（×{n}）")
            print("    下一步：用 `zcp_patcher.py --all --dry-run` 确认补丁能否落位；"
                  "仍失败就要重新提取锚点/补契约串，并更新本清单。")
        else:
            print("\n[√] 全部契约命中，本插件对该客户端版本可直接重注入。")
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
