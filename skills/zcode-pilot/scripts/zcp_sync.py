#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""zcode-pilot 插件开关同步（由 SessionStart hook 调用）

把客户端补丁同步到期望状态：
  字节级补丁（用量图表 / 弹窗加宽 / 档位配置）—— 立即写入，下次启动可见
  重打包级补丁（状态栏 / 自动继续 / 增强 / 拉取）—— 交给退出后看护，ZCode 退出时写入
  运行态状态文件（~/.zcode/pilot/state.json）—— **立即写入**，ZCode 运行中也生效
  （自动继续的「关闭并保存」必须能立刻停掉已排队的继续，所以它不碰 app.asar）

**零配置自动注入**：ZCode 只在用户点过「保存配置」后才把开关写进 config.json。
如果没保存过就什么都不做，用户看到的就是「装好了但没生效」。所以这里改为：
**已保存的开关优先，没保存过的键退回插件清单 `plugin.json` 里声明的默认值**。
装完 → 重启 ZCode → 开个新会话，钩子就会按默认值自动注入，**不需要打开配置页**。

三种调用形态：
  zcp_sync.py --detach   钩子用：登记心跳后**立刻后台化**并返回，绝不阻塞会话启动
  zcp_sync.py --worker   内部用：真正干活的子进程（stdout 已被丢弃）
  zcp_sync.py            人工调试用：前台执行，输出直接打在终端上

为什么要后台化：hook 是**内联**执行的（`async` 字段当前无运行时效果），
同步一次要跑多次 `--check`（每次约 2 秒），会话启动会被硬生生拖住；
而且钩子有超时上限，机器慢/杀软扫盘时可能直接被砍掉，表现为「什么都没发生」。

诊断日志：scripts/_zcp_sync.log
心跳文件：scripts/_zcp_sync.last（每次被调用都刷新，用来证明「钩子到底跑没跑」）
安装自检：python zcp_doctor.py（一条命令给出整条链路的结论）
"""

import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

try:                                   # 控制台编码/窗口安全网（见 zcp_console.py 的说明）
    from zcp_console import no_window_kwargs
except ImportError:                    # 被别处 import 时脚本目录可能不在 sys.path
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from zcp_console import no_window_kwargs

try:                                   # 单例判定与启动活性确认：统一以看护心跳为准（0.9.3）
    from zcp_watchdog import live_watchdog_pid, wait_watchdog_alive
except ImportError:                    # 被别处 import 时脚本目录可能不在 sys.path
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from zcp_watchdog import live_watchdog_pid, wait_watchdog_alive

HERE = Path(__file__).resolve().parent
PATCHER = HERE / "zcp_patcher.py"
WATCHDOG = HERE / "zcp_watchdog.py"
CONFIG = Path.home() / ".zcode" / "cli" / "config.json"
# 插件 id 会随安装方式变化（本地 dev-default-xxxx、市场安装的 id 等），
# 因此按前缀匹配而不是写死某个 id —— 换台机器/换安装方式也能正确定位配置。
PLUGIN_ID_PREFIX = "zcode-pilot"
# 插件改名前叫 zcode-tokenspeed：老用户配置里存的还是旧 id，必须能读出来（用于迁移提示
# 与历史开关的清理），否则改名后所有开关都会「凭空回到默认值」。
LEGACY_PLUGIN_ID_PREFIX = "zcode-tokenspeed"
# 自动继续的运行态状态文件（契约 docs/CONTRACT.md 2.2）：渲染层 1500ms 轮询它。
PILOT_DIR = Path.home() / ".zcode" / "pilot"
PILOT_STATE = PILOT_DIR / "state.json"
LOG = HERE / "_zcp_sync.log"
# 「钩子到底跑没跑」的心跳文件：每次被调用都刷新一次时间戳。
# 为什么需要它：没拨过开关时 zcp_sync 什么也不做、日志也是空的，「钩子没触发」与
# 「触发了但无事可做」在日志里长得一模一样——排查安装问题时这是最关键的一条信息。
STAMP = HERE / "_zcp_sync.last"
# 首次自动注入的标记：用来保证「装好了，正在自动注入」这条会话提示只出现一次，
# 不然后面每次开会话都弹一遍，很快就变成噪声。
MARKER = HERE / "_autoinject.done"
# 客户端指纹记录：用来检测「ZCode 客户端是否刚升级过」
CLIENT_FINGERPRINT = HERE / "_client_fingerprint.json"

# ---------- 看护状态与「注入版本」记录（都必须跨插件版本目录共享） ----------
# 市场更新会换一个版本目录（.../zcode-pilot/0.8.0 → .../0.9.0），旧目录里写的东西
# 新版本读不到。所以看护的单例文件、以及「app.asar 当前注入的是哪个插件版本」的记账，
# 一律放在 ~/.zcode/pilot/ 下 —— 这是升级后还能自动重注入的关键。
WATCHDOG_DIR = PILOT_DIR
WANT_FILE = WATCHDOG_DIR / "watchdog.want"
PID_FILE = WATCHDOG_DIR / "watchdog.pid"
WATCH_FLAG = WATCHDOG_DIR / "watchdog.watch"
INJECT_RECORD = WATCHDOG_DIR / "injected.json"
# 上次「退出后重注入」是否被客户端提前启动打断：写了待办但没能落盘时留下这个标记，
# 下次会话启动时据此提醒用户「还差一次完全退出，且期间别手动打开客户端」。
PENDING_FILE = WATCHDOG_DIR / "reinject.pending"
# 市场安装登记表：插件市场在「更新」完成的瞬间就会改写它（比插件目录里的清单更及时）。
INSTALLED_PLUGINS = Path.home() / ".zcode" / "cli" / "plugins" / "installed_plugins.json"

# 配置键 -> (zcp_patcher.py 参数, 是否重打包级)
#
# **关于「立即写」这条路**：zcp_patcher.py 的运行预检是**全局**的 —— `zcode_running()`
# 只查 tasklist 里有没有 `ZCode.exe`，与 target 无关；命中就直接 `return 2` 拒绝写入
# （理由：app.asar 被锁、config.json / provider_config.json 会被客户端回写覆盖）。
# 而 SessionStart 钩子**必然**在 ZCode 运行中触发，所以标 False 的两项
# （reasoning_config / usage_chart）在钩子里永远写不进去 ——
# 早期版本就是这样：每次装完都报「未处理: xxx(执行失败)」。
# 现在改成**先试立即写，被拒（refused）就自动转交 zcp_watchdog.py**：
# 桌面端场景退化成「退出时写入」，纯 CLI 场景（没有 ZCode.exe 在跑）仍能即时生效。
PATCHES = [
    ("reasoning_config", ["--reasoning-config"], False),   # 3.14+ 档位配置（配置侧原生）
    ("usage_chart", ["--usage-chart"], False),
    ("tps_footer", ["--tps-footer"], True),
    ("auto_continue", ["--auto-continue"], True),
    ("enhance_prompt", ["--enhance-prompt"], True),
    ("model_puller", ["--model-puller"], True),
    ("core_patch", [], False),                             # ≤3.11 内核补丁
]

# 已下线的「模型弹窗加宽」：不再随开关安装，只在老客户端里检测到残留时排一次还原。
LEGACY_MODEL_WIDTH_KEY = "cleanup_model_width"
LEGACY_MODEL_WIDTH_ARGS = ["--model-width"]

# 历史补丁「思考强度滑条」的残留清理（本插件已移除该功能）：不是用户开关，只在检测到
# 残留时排给退出后看护执行一次。见 zcp_patcher.py 的 --cleanup-legacy。
LEGACY_CLEANUP_KEY = "cleanup_legacy"
LEGACY_CLEANUP_ARGS = ["--cleanup-legacy"]

DETACHED_PROCESS = 0x00000008
CREATE_NO_WINDOW = 0x08000000


def log(msg: str) -> None:
    try:
        import time
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n")
    except Exception:
        pass


def beat(msg: str) -> None:
    """刷新心跳文件，证明「钩子确实被调用过」，并写明这次做了什么。

    排查「插件装了没生效」时这是第一条要看的信息：心跳文件不存在 = 钩子没跑；
    存在但写着「未保存过开关」= 钩子跑了，只是用户没在配置里拨开关（按设计不动客户端）。
    """
    try:
        import time
        STAMP.write_text(f"{time.strftime('%Y-%m-%d %H:%M:%S')}  [{_invocation()}] {msg}\n",
                         encoding="utf-8")
    except Exception:
        pass


def _invocation() -> str:
    """这次是被谁调起来的（写进心跳，便于区分「钩子」与「人工」）。"""
    argv = sys.argv[1:]
    if "--detach" in argv:
        return "钩子"
    if "--worker" in argv:
        return "钩子→后台" if "--from-hook" in argv else "后台"
    return "手动"


def spawn_detached(extra_args: list) -> bool:
    """把本脚本以后台进程方式再起一份，立刻返回（不等待、不阻塞会话启动）。"""
    cmd = [sys.executable, str(Path(__file__).resolve()), *extra_args]
    kw = {"cwd": str(HERE), "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
    if os.name == "nt":
        kw["creationflags"] = DETACHED_PROCESS | CREATE_NO_WINDOW
    else:
        kw["start_new_session"] = True
    try:
        subprocess.Popen(cmd, **kw)   # no-window-ok: 标志在 kw 里（含 CREATE_NO_WINDOW）
        return True
    except Exception as exc:
        log(f"后台启动失败: {exc!r}")
        return False


def _key_matches(key, prefix: str) -> bool:
    """配置键是不是 `prefix` 这个插件 id 的？

    ⚠️ 不能用裸 `startswith(prefix)`：那会把 **别的插件** 的配置也命中 ——
    `zcode-pilot-extra`、`zcode-pilot-pro`、`zcode-pilot-lite` 之类
    同前缀插件一旦同时安装，`_search()` 会先撞上谁取决于 dict 插入顺序，
    表现为「开关莫名串台」（甚至把别人的配置当自己的开关去注入/还原）。

    宿主的真实配置键形态是 `<插件名>@<市场名>`（见本项目记忆里的既有结论），
    所以只认两种：精确等于插件名，或 `<插件名>@` 开头。
    """
    s = str(key)
    return s == prefix or s.startswith(prefix + "@")


def _is_our_key(key) -> bool:
    """本插件（含改名前的旧 id zcode-tokenspeed）的配置键。"""
    return _key_matches(key, PLUGIN_ID_PREFIX) or _key_matches(key, LEGACY_PLUGIN_ID_PREFIX)


def _is_new_key(key) -> bool:
    return _key_matches(key, PLUGIN_ID_PREFIX)


def _is_legacy_key(key) -> bool:
    return _key_matches(key, LEGACY_PLUGIN_ID_PREFIX)


def _search(node, path="", depth=0, match=_is_our_key):
    """在配置树里找本插件的配置对象（键以插件名前缀开头的那一层）。"""
    if depth > 6 or not isinstance(node, dict):
        return None
    for key, val in node.items():
        if isinstance(val, dict) and val and match(key):
            return val, f"{path}.{key}"
    for key, val in node.items():
        if isinstance(val, dict):
            got = _search(val, f"{path}.{key}", depth + 1, match)
            if got:
                return got
    return None


def _coerce(raw):
    """把宿主可能写入的字符串布尔归一成 bool。"""
    out = {}
    for key, val in raw.items():
        if isinstance(val, bool):
            out[key] = val
        elif isinstance(val, str) and val.strip().lower() in ("true", "false"):
            out[key] = val.strip().lower() == "true"
    return out


def declared_defaults() -> dict:
    """读插件清单 `plugin.json` 里 `userConfig.*.default` 声明的默认值。

    **这是「零配置自动注入」的关键一环**：ZCode 只在用户点过「保存配置」之后才把
    `plugins.options` 写进 `config.json`；从没保存过就什么都没有。此时若按旧逻辑
    「没表态就不动」，用户看到的就是「装好了但没生效」——而这恰恰是最常见的抱怨。
    退回清单默认值之后，装完重启一次即自动注入，不必打开配置页、不必跑任何命令。

    向上找几层是为了兼容三种插件落点（市场根即插件根 / cache 的版本目录 / plugins 子目录）。

    ⚠️ 两道防护，都是为了「别读到**别人的**清单」：

    1. **只找到插件边界为止**（`_plugin_boundary`）—— 原先无条件 `HERE.parents[2:6]`，
       在仓库布局下会一路走到**盘符根**（`F:\\`）。用户把压缩包解到盘符根是常见操作，
       一旦那里躺着一个无关的 `.zcode-plugin/plugin.json`，开关默认值就会被它劫持，
       而且完全不报错。
    2. **清单必须确实是本插件的**（`name` 对得上）—— 上级目录里出现任何别的清单时，
       不能因为「它先被扫到」就用它的默认值。
    """
    for base in _plugin_boundary():
        for rel in (".zcode-plugin/plugin.json", ".claude-plugin/plugin.json"):
            p = base / rel
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                continue
            # 必须是本插件的清单：`name` 精确等于插件 id（`_is_our_key` 的同一套判定，
            # 含改名前的旧 id —— 老安装的清单还没更新，读不到默认值就等于「装完不生效」）
            name = data.get("name")
            if not _is_our_key(name):
                log(f"跳过不是本插件的清单（name={name!r}）：{p}")
                continue
            if _is_legacy_key(name):
                log(f"插件清单还是改名前的旧 id（name={name!r}）：{p} —— 按新 id 处理，建议更新插件")
            uc = data.get("userConfig")
            if not isinstance(uc, dict):
                continue
            out = {k: v["default"] for k, v in uc.items()
                   if isinstance(v, dict) and isinstance(v.get("default"), bool)}
            if out:
                return out
    log("没找到插件清单，取不到默认值")
    return {}


def _plugin_boundary() -> list[Path]:
    """从脚本目录向上返回「可能放着本插件清单」的目录，**到插件边界为止**。

    三种落点（见模块 docstring）对应清单所在层：
      * 市场根即插件根 : `<市场>/skills/<插件>/scripts` → 清单在 `parents[2]`
      * cache 版本目录 : `.../<插件>/<版本>/skills/<插件>/scripts` → 清单在 `parents[2]`
      * plugins 子目录 : `<市场>/plugins/<插件>/skills/<插件>/scripts` → 清单在 `parents[2]`

    所以正常情况下 `parents[2]` 就够了；再往上多找几层只是为历史/异形布局兜底。
    但**绝不能无限向上**：遇到盘符根（`F:\\`）或文件系统根（`/`）必须停 ——
    那里出现的同名清单不属于本插件，用它等于让无关文件劫持开关默认值。

    另外一旦发现某个目录**就是**本插件的根（含 `skills/<插件>` 结构），
    说明已经到边界，再往上只会看到无关目录，直接停。
    """
    out: list[Path] = []
    for base in list(HERE.parents):
        if base == base.parent:         # 盘符根 / 文件系统根 → 停，绝不参与
            break
        out.append(base)
        # 插件根特征：本目录下直接有 skills/<插件名> → 已到边界，再往上只会看到无关目录
        # （旧 id 的目录名也要认，否则老安装会一路往上走到无关目录）
        if ((base / "skills" / PLUGIN_ID_PREFIX).is_dir()
                or (base / "skills" / LEGACY_PLUGIN_ID_PREFIX).is_dir()):
            break
        if len(out) >= 6:               # 与原实现的搜索深度保持一致的兜底上限
            break
    return out


# ---------- 插件版本 / 市场安装位置 ----------
def _plugin_root() -> Path | None:
    """本插件的根目录（放着 `.zcode-plugin/plugin.json` 的那一层）。"""
    for base in _plugin_boundary():
        for rel in (".zcode-plugin/plugin.json", ".claude-plugin/plugin.json"):
            p = base / rel
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                continue
            if _is_our_key(data.get("name")):
                return base
    return None


def plugin_version() -> str:
    """本插件目录声明的版本号（读不到返回空串）。"""
    root = _plugin_root()
    if not root:
        return ""
    for rel in (".zcode-plugin/plugin.json", ".claude-plugin/plugin.json"):
        try:
            data = json.loads((root / rel).read_text(encoding="utf-8"))
        except Exception:
            continue
        if data.get("version"):
            return str(data["version"])
    return ""


def installed_plugin() -> dict:
    """市场登记表里本插件的当前安装：`{version, root}`；读不到返回 `{}`。

    为什么不用「自己所在的版本目录」判断：市场更新后，**正在运行的客户端**仍在用旧
    版本目录里的钩子，而登记表已经指向新目录。拿登记表当基准才能第一时间发现升级。
    """
    try:
        data = json.loads(INSTALLED_PLUGINS.read_text(encoding="utf-8"))
    except Exception:
        return {}
    for ent in data.get("plugins") or []:
        if not isinstance(ent, dict):
            continue
        name = str(ent.get("id") or "").split("@")[0] or str(ent.get("name") or "")
        if not _is_our_key(name):
            continue
        root = ent.get("installPath")
        if root and Path(root).is_dir():
            return {"version": str(ent.get("version") or ""),
                    "root": str(Path(root).resolve())}
    return {}


def read_inject_record() -> dict:
    try:
        return json.loads(INJECT_RECORD.read_text(encoding="utf-8"))
    except Exception:
        return {}


def write_inject_record(version: str = "", root: str = "") -> None:
    """记录「app.asar 里当前注入的是哪个插件版本」，供下次市场更新时判断。

    只在**本目录就是市场安装的当前版本目录**时才记账：从仓库/绿色目录里手工跑
    zcp_sync（开发调试）不应污染这条记录，否则会把自己的开发目录误判成一次「升级」。
    """
    root = root or (str(_plugin_root()) if _plugin_root() else "")
    version = version or plugin_version()
    if not version or not root:
        return
    cur = installed_plugin()
    try:
        if not cur or Path(cur["root"]).resolve() != Path(root).resolve():
            return
    except Exception:
        return
    try:
        WATCHDOG_DIR.mkdir(parents=True, exist_ok=True)
        INJECT_RECORD.write_text(json.dumps({
            "pluginVersion": version,
            "pluginRoot": str(Path(root).resolve()),
            "recordedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        }, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass


def plugin_update_pending() -> dict:
    """市场是否装了比「当前注入版本」更新的插件。没有则返回 `{}`。

    返回 `{version, root, from}` —— `root` 是**新版插件目录**。重注入必须用它的脚本，
    绝不能用当前（旧版）目录里的，否则注进去的仍是旧实现。
    """
    cur = installed_plugin()
    rec = read_inject_record()
    if not cur or not rec:
        return {}
    old = str(rec.get("pluginVersion") or "")
    if cur["version"] and old and cur["version"] != old:
        return {**cur, "from": old}
    return {}


# ---------- 「待重注入」标记：写入被客户端启动打断时，下次会话要明确告诉用户 ----------
def mark_reinject_pending(keys) -> None:
    try:
        WATCHDOG_DIR.mkdir(parents=True, exist_ok=True)
        PENDING_FILE.write_text(json.dumps({
            "keys": list(keys),
            "at": datetime.now().astimezone().isoformat(timespec="seconds"),
        }, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass


def read_reinject_pending() -> dict:
    try:
        data = json.loads(PENDING_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def clear_reinject_pending() -> None:
    try:
        PENDING_FILE.unlink(missing_ok=True)
    except Exception:
        pass


def read_options():
    """读本插件的开关值。返回 (options, source)；source 为 None 表示没找到配置。"""    # 宿主若把插件配置注入 hook 环境，优先用环境变量。
    # 键名必须 `.lower()` 归一：Windows 上 os.environ 会把键名**转成大写**
    # （CPython 对 nt 的实现就是「Env Var Names Must Be UPPERCASE」），
    # 于是 ZCODE_PLUGIN_CONFIG_reasoning_config 读出来是 REASONING_CONFIG，
    # 与开关名对不上 → `merged = {**defaults, **explicit}` 里默认值（全 true）胜出，
    # 用户保存的开关会被**整体忽略**。
    env_opts = _coerce({key[len("ZCODE_PLUGIN_CONFIG_"):].lower(): val
                        for key, val in os.environ.items()
                        if key.startswith("ZCODE_PLUGIN_CONFIG_")})
    if env_opts:
        return env_opts, "env"

    try:
        cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    except Exception as exc:
        log(f"读配置失败: {exc}")
        return {}, None
    found = _search(cfg, CONFIG.name, match=_is_new_key)
    if found:
        return _coerce(found[0]), found[1]
    # 改名前的旧 id：老用户 config.json 里存的是 zcode-tokenspeed@…，必须读出来，
    # 否则改名后所有开关都会静默回到默认值（用户以为自己关掉的项又被打开）。
    legacy = _search(cfg, CONFIG.name, match=_is_legacy_key)
    if legacy:
        log(f"读到改名前的旧插件配置 {legacy[1]} → 按新 id {PLUGIN_ID_PREFIX} 处理；"
            f"建议在「设置 → 插件 → 配置」重新保存一次以完成迁移")
        return _coerce(legacy[0]), f"{legacy[1]}（旧 id {LEGACY_PLUGIN_ID_PREFIX}）"
    # 没找到条目：把 plugins 下的键名记下来，便于确认宿主的实际存储位置
    plugins = cfg.get("plugins") if isinstance(cfg, dict) else None
    log(f"配置里没有 {PLUGIN_ID_PREFIX}；plugins 现有键: "
        f"{sorted(plugins) if isinstance(plugins, dict) else plugins}")
    return {}, None


def check_state(args) -> str:
    """跑 --check 判断当前注入状态：on / stale / off / na（本版本不适用）/ unknown。

    `na` 是必需的第三态：例如 ≤3.11 专用的内核补丁在 3.14+ 上会明确打印
    「本补丁不适用」。旧逻辑只看「未打」→ 把它当成 off → 去执行 → 脚本空转一圈，
    最后却报成「已生效」。默认值全开之后，这个误报每次装完都会出现，必须区分开。

    ★ `stale`（已打但内容旧）是 0.6.1 补的第四态，修的是一类**最容易被误判成
    「已生效」**的场景：

        插件更新到新版（注入脚本改了，比如 0.5.11 的按钮跑出输入框修复）
        → 用户按提示退出并重启 ZCode
        → 但 app.asar 里的注入片段**还是旧版**，因为「更新插件」只换了插件目录，
          **不会**重新注入 app.asar

    旧逻辑把 `--check` 输出里的「已打」一律当成 on，于是 `run_sync` 走
    `continue`（视为已一致）→ **永远不会重跑注入** → 用户看到的改动永远不生效，
    而且报告里一句「未处理」都没有，只有一个可疑的静默。

    判据是 zcp_patcher.py 自己在 `--check` 里给出的两种措辞：
      * 「已打（含旧版组件，重跑可自动更新）」   → 四组件齐但内容 != 现行实现
      * 「已打（四组件均为当前版本），跳过」     → 真正的最新
    前者必须归为 stale（要求重跑），不能归为 on。
    """
    r = subprocess.run([sys.executable, str(PATCHER), *args, "--check"],
                       capture_output=True, encoding="utf-8", errors="replace",
                       cwd=str(HERE), timeout=120,
                       env=dict(os.environ, PYTHONIOENCODING="utf-8"),
                       **no_window_kwargs())
    out = (r.stdout or "") + (r.stderr or "")
    if "不适用" in out:
        return "na"
    if "原生档位配置" in out:
        # 「无需写入」只出现在「not planned」分支（档位配置已是最新）；
        # 否则就是有 [ ] 待写入项 → off。别用「已是最新」判：该词在有待写入项时也会打印
        # （指的是另外 N 个已配好的模型），会误判成 on。
        return "on" if "无需写入" in out else "off"
    # 「已打（含旧版组件，重跑可自动更新）」必须排在 "已打" 之前判：
    # 这个串本身包含 "已打"，顺序反了就会被后面那条吃掉，stale 永远走不到。
    if "含旧版组件" in out:
        return "stale"
    if "未打" in out:
        return "off"
    if "已打" in out:
        return "on"
    return "unknown"


# 判定「真的没写成」的**精确**特征串。
#
# ⚠️ 这里绝不能用裸 "[!]"：zcp_patcher.py 有 60+ 处 `[!]` 输出，其中不少出现在
# **完全成功的路径**上，只是提示「顺带发现的问题」，例如：
#   * `发现 N 个模型同时存在于 providerModelRules 与 manualProviderModelRules…
#      建议在界面重新保存` —— 这是**事先就存在**的问题，脚本只报告、不修，仍然算成功；
#   * `备份读取/写入失败`（流程继续）、`integrity 分块数变化，跳过同步`（正常降级）。
# 早先写成 `any(mark in out for mark in ("锚点匹配异常", "拒绝", "[!]"))`，
# 后果是「补丁其实写成功了，却被判成 fail」→ summary 报「未处理: xxx(执行失败)」→
# 用户反复重试、每次都报失败（重试永远不会有别的结果）。实测已复现。
# 所以：只认「明确的拒绝/异常」特征串 + 退出码 + 汇总行的失败计数。
REJECT_MARKS = (
    "锚点匹配异常",
    "拒绝盲改",
    "无法安全更新，拒绝",
    "不符合预期，拒绝",
)


def _summary_failures(out: str) -> int | None:
    """解析 zcp_patcher.py 汇总行 `合计 N 项：成功 X，失败 Y` 里的 Y。

    这是比任何特征串都可靠的判据：它是脚本**自己**算出来的结论。
    解析不到（如 --check 之外的输出被截断）返回 None，交由其他判据决定。
    """
    m = re.search(r"合计\s*\d+\s*项：\s*成功\s*\d+\s*，\s*失败\s*(\d+)", out)
    return int(m.group(1)) if m else None


def run_patcher(args, revert: bool) -> str:
    """立即执行一次改写。返回 "ok" / "refused" / "fail"。

    `refused` 是独立的一态，不能和 `fail` 混在一起：zcp_patcher.py 在「ZCode 正在运行」
    时会明确打印拒绝原因并返回 2 —— 这不是失败，而是「现在不能写，等退出后写」，
    调用方要据此把这项转交给 zcp_watchdog.py（见 PATCHES 上方注释）。
    """
    cmd = [sys.executable, str(PATCHER), *args] + (["--revert"] if revert else [])
    r = subprocess.run(cmd, capture_output=True, encoding="utf-8", errors="replace",
                       cwd=str(HERE), timeout=300,
                       env=dict(os.environ, PYTHONIOENCODING="utf-8"),
                       **no_window_kwargs())
    out = (r.stdout or "") + (r.stderr or "")
    refused = r.returncode == 2 or "检测到 ZCode 正在运行" in out
    # zcp_patcher.py 拒绝改写时可能仍返回 0（只在输出里说明原因），必须看输出判定。
    # 三条判据，任一命中即为 fail（详见 REJECT_MARKS / _summary_failures 的注释）：
    #   1. 退出码非 0（2 已被 refused 吸收）
    #   2. 出现明确的「拒绝/异常」特征串
    #   3. 汇总行自报「失败 N」且 N > 0
    rejected = any(mark in out for mark in REJECT_MARKS)
    summary_failed = _summary_failures(out)
    ok = (r.returncode == 0 and not rejected
          and not (summary_failed is not None and summary_failed > 0))
    verdict = "refused" if refused else ("ok" if ok else "fail")
    log(f"$ zcp_patcher.py {' '.join(args)}{' --revert' if revert else ''} -> "
        f"{verdict}\n{out}".rstrip())
    return verdict


def _pilot_defaults() -> dict:
    """运行态状态文件的完整默认值（与 docs/CONTRACT.md 2.2 一致；enabled 与插件清单默认值相同）。

    只用于「缺字段补齐」（setdefault），绝不覆盖已有值 —— runtime / journal 归渲染层、
    lastContinueAt / sessions 归 Stop hook，这里补的是空默认值，由各自写入方填充。
    """
    return {"version": 1, "enabled": True, "runtime": True, "paused": False,
            "cancelToken": 0, "lastContinueAt": 0, "sessions": {}, "journal": {}}


def _read_pilot_state() -> dict:
    """读运行态状态文件（缺文件 / 坏 JSON → 空 dict）。"""
    try:
        d = json.loads(PILOT_STATE.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def write_pilot_state(enabled: bool) -> str:
    """把 auto_continue 开关同步进运行态状态文件 ~/.zcode/pilot/state.json。

    ★ 这一步**只写一个小 JSON、完全不碰 app.asar**，因此不受 zcp_patcher 的
    「ZCode 正在运行」预检限制 —— 而「关闭并保存」必须能立刻停掉已排队的自动继续，
    所以它只能在钩子（必然运行中触发）里做。

    契约（docs/CONTRACT.md 2.2）：
      开启 → enabled=true,  paused=false（cancelToken 不变）
      关闭 → enabled=false, paused=true，且 cancelToken +1（作废所有已排队的继续）

    ⚠️ 状态文件是**多方共用**的：runtime / journal 归渲染层，lastContinueAt / sessions 归
    Stop hook。所以这里严格**读-改-写**，只碰自己那三个字段，其它字段（含未知字段）原样保留；
    落盘用「同目录临时文件 + os.replace」原子替换，避免与渲染层/hook 并发写出半截 JSON。

    幂等：已经是目标态时不写盘、也**不**重复 +1 —— 否则每次开会话都会作废一次队列。
    任何异常都吞掉并记日志：写状态文件失败绝不能拖垮整次同步。
    返回 "" 表示成功/无需改动，否则返回一句原因（只用于日志与摘要）。
    """
    try:
        st = _read_pilot_state()                    # ① 读（不认识别人的字段也照单全收）
        for k, v in _pilot_defaults().items():      # 缺字段按契约默认值补齐
            st.setdefault(k, v)
        cur_enabled = st.get("enabled")
        cur_paused = st.get("paused")
        token = st.get("cancelToken")
        if isinstance(token, bool) or not isinstance(token, int):
            token = 0
        changed = cur_enabled is not enabled or cur_paused is not (not enabled)
        # 关闭时才作废队列；已经是关闭态就不重复 +1（幂等）
        if not enabled and cur_enabled is not False:
            token += 1
            changed = True
        if not changed:
            return ""
        st["version"] = 1                           # ② 改（只改自己那三个字段 + 时间戳）
        st["enabled"] = enabled
        st["paused"] = not enabled
        st["cancelToken"] = token
        st["updatedAt"] = datetime.now().astimezone().isoformat(timespec="seconds")
        PILOT_DIR.mkdir(parents=True, exist_ok=True)
        tmp = PILOT_STATE.with_name(PILOT_STATE.name + f".tmp-{os.getpid()}")
        tmp.write_text(json.dumps(st, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, PILOT_STATE)                # ③ 写（同目录临时文件 + 原子替换）
        log(f"已写运行态状态文件 {PILOT_STATE}：enabled={st['enabled']} "
            f"paused={st['paused']} cancelToken={st['cancelToken']}")
        return ""
    except Exception as exc:
        log(f"运行态状态文件写入失败（静默降级，不影响同步）: {exc!r}")
        return f"状态文件写入失败({type(exc).__name__})"


def legacy_cleanup_needed() -> bool:
    """只读探测：客户端里是否还留着历史「思考强度滑条」的注入残留。

    解析失败/超时一律按「没有」处理 —— 这是可选的清理项，不能因为它把同步拖成失败。
    """
    try:
        r = subprocess.run([sys.executable, str(PATCHER), *LEGACY_CLEANUP_ARGS, "--check"],
                           capture_output=True, encoding="utf-8", errors="replace",
                           cwd=str(HERE), timeout=120,
                           env=dict(os.environ, PYTHONIOENCODING="utf-8"),
                           **no_window_kwargs())
    except Exception as exc:
        log(f"历史滑条残留探测失败: {exc!r}")
        return False
    out = (r.stdout or "") + (r.stderr or "")
    return "历史滑条残留: 有" in out


#: Windows：看护启动用的计划任务名。任务定义只是「借道」——拉起看护后立即删除，
#: 不留任何计划残留（实测删除定义不影响已在运行的实例）。
WATCHDOG_TASK_NAME = "zcode-pilot-watchdog"
#: 临时 ps1 落盘位置（~/.zcode/pilot/ 下，用完即删）。放状态目录而不是 %TEMP%，
#: 是为了与看护的其他产物同生命周期，异常退出时 doctor 也看得到。
WATCHDOG_TASK_PS1 = WATCHDOG_DIR / "_zcp_watchdog_task.ps1"


def _psq(s) -> str:
    """PowerShell 单引号字符串的字面量转义（' → ''）。"""
    return str(s).replace("'", "''")


def _launch_watchdog_via_task(args: list) -> bool:
    """经 Windows 计划任务在 ZCode 进程树之外启动看护；活性确认后才返回 True。

    为什么必须树外（2026-11-12/13 实测故障的根因修复）：看护由 SessionStart 钩子
    拉起，是 ZCode.exe → zcode-runtime-host.exe → shell → python 的**后代**；托盘
    「退出」时客户端会把整个后代进程树一起收掉。DETACHED_PROCESS 只脱控制台、
    不脱树，于是看护在观测到「ZCode 已退出」之前就死了 —— 日志里只有「启动待命」
    一行、连失败记录都没有，用户看到的就是「按提示退出了，但什么都没注入」，
    而且无论重退多少次都一样（每次的新看护仍挂在树上）。历史上 5 次成功写入全是
    「等待 0s」场景 —— 看护启动时客户端本来就没在跑，恰好绕开了连坐，才掩盖到这里。

    0.9.3 改为两段式（别的电脑上「TASK_OK 打了但看护根本没起来，退出后照样什么
    都没注入」的修复）：
      阶段1 点火：PowerShell 优先；PowerShell 不可用/被策略拦（受限语言模式等）
        时退 schtasks.exe —— 同一个 Task Scheduler 服务，绕开对 PowerShell 的依赖。
      阶段2 活性确认：点火成功 ≠ 进程活着（pythonw 被杀软拦 / Store Python 别名
        损坏 / 组策略静默拒绝 Start，全都无声无息）。用 wait_watchdog_alive 等心跳
        现身，等不到按失败处理、交调用方降级 Popen —— 宁可多起一个（心跳单例账本
        会裁决），绝不能再「以为起来了」却一个都没有。

    计划任务的进程由 Task Scheduler 服务（svchost）派生，父链与 ZCode 完全无关；
    pythonw.exe 启动则无控制台窗口。
    """
    if not _fire_watchdog_task(args):
        return False
    if wait_watchdog_alive():
        return True
    log("计划任务已点火但未见看护心跳（pythonw 可能被拦/启动失败），按失败处理，走下一级兜底")
    return False


def _fire_watchdog_task(args: list) -> bool:
    """只负责点火（不确认活性）：PowerShell 优先，schtasks.exe 兜底。"""
    if _fire_watchdog_task_ps(args):
        return True
    log("PowerShell 点火未成功，改试 schtasks.exe（同一 Task Scheduler 服务，无 PS 依赖）")
    return _fire_watchdog_task_schtasks(args)


def _fire_watchdog_task_ps(args: list) -> bool:
    """PowerShell 点火：注册 → 立即启动 → 删除任务定义一气呵成（不留计划残留）。"""
    ps = shutil.which("powershell")     # which 已含可执行性校验，结果可能是裸名或全路径
    if not ps:
        ps = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
        if not Path(ps).is_file():      # 只有这条硬编码兜底路径才需要存在性复检
            log("找不到 powershell（PATH 与系统目录都没有）")
            return False
    runner = Path(sys.executable).with_name("pythonw.exe")
    if not runner.is_file():                     # 精简安装没有 pythonw：退回 python.exe，
        runner = Path(sys.executable)            # 配合 -Hidden 也不会弹控制台窗
    argline = f'"{WATCHDOG}" ' + " ".join(args)
    script = "\n".join([
        "$ErrorActionPreference = 'Stop'",
        "$action = New-ScheduledTaskAction -Execute '{}' -Argument '{}' -WorkingDirectory '{}'".format(
            _psq(runner), _psq(argline), _psq(HERE)),
        "$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddHours(8)",
        "$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries "
        "-DontStopIfGoingOnBatteries -StartWhenAvailable -Hidden -MultipleInstances IgnoreNew",
        f"Register-ScheduledTask -TaskName '{_psq(WATCHDOG_TASK_NAME)}' "
        "-Action $action -Trigger $trigger -Settings $settings -Force | Out-Null",
        f"Start-ScheduledTask -TaskName '{_psq(WATCHDOG_TASK_NAME)}'",
        "Start-Sleep -Seconds 2",
        f"Unregister-ScheduledTask -TaskName '{_psq(WATCHDOG_TASK_NAME)}' -Confirm:$false",
        "Write-Output 'TASK_OK'",
    ])
    try:
        WATCHDOG_DIR.mkdir(parents=True, exist_ok=True)
        WATCHDOG_TASK_PS1.write_text(script, encoding="utf-8")
        r = subprocess.run([ps, "-NoProfile", "-ExecutionPolicy", "Bypass",
                            "-File", str(WATCHDOG_TASK_PS1)],
                           capture_output=True, encoding="utf-8", errors="replace",
                           timeout=90, **no_window_kwargs())
        if r.returncode == 0 and "TASK_OK" in (r.stdout or ""):
            return True
        log(f"计划任务启动看护未成功（rc={r.returncode}）："
            f"{(r.stderr or r.stdout or '').strip()[:200]}")
        return False
    except Exception as exc:
        log(f"计划任务启动看护异常：{exc!r}")
        return False
    finally:
        try:
            WATCHDOG_TASK_PS1.unlink(missing_ok=True)
        except Exception:
            pass


def _fire_watchdog_task_schtasks(args: list) -> bool:
    """schtasks.exe 直接点火：受限语言模式 / PowerShell 被禁环境下的兜底。

    /TR 刻意不带 --want：待办已由 start_watchdog 先写进 watchdog.want、常驻监听
    标志在 watchdog.watch，看护无参启动就能拿到同一份期望状态；schtasks 的 /TR
    有 ~261 字符上限，深插件缓存路径 + 全量 --want 会超限。
    """
    exe = shutil.which("schtasks")
    if not exe:
        log("找不到 schtasks.exe（PATH 与系统目录都没有），无法走计划任务兜底")
        return False
    runner = Path(sys.executable).with_name("pythonw.exe")
    if not runner.is_file():
        runner = Path(sys.executable)
    # /SC ONCE 需要 /ST；反正马上手动 /Run，触发时刻只要「像未来」即可。
    # 跨零点的边缘情况 /Create 可能报错 → 返回 False 降级 Popen，不影响正确性。
    st = (datetime.now() + timedelta(minutes=2)).strftime("%H:%M")
    tr = f'"{runner}" "{WATCHDOG}"'
    try:
        r = subprocess.run([exe, "/Create", "/F", "/TN", WATCHDOG_TASK_NAME,
                            "/SC", "ONCE", "/ST", st, "/TR", tr],
                           capture_output=True, encoding="utf-8", errors="replace",
                           timeout=30, **no_window_kwargs())
        if r.returncode != 0:
            log(f"schtasks /Create 未成功（rc={r.returncode}）："
                f"{(r.stderr or r.stdout or '').strip()[:200]}")
            return False
        r = subprocess.run([exe, "/Run", "/TN", WATCHDOG_TASK_NAME],
                           capture_output=True, encoding="utf-8", errors="replace",
                           timeout=30, **no_window_kwargs())
        ok = r.returncode == 0
        if not ok:
            log(f"schtasks /Run 未成功（rc={r.returncode}）："
                f"{(r.stderr or r.stdout or '').strip()[:200]}")
        try:   # 任务定义用完即删（与 PowerShell 路径同一约定；不影响已运行实例）
            subprocess.run([exe, "/Delete", "/TN", WATCHDOG_TASK_NAME, "/F"],
                           capture_output=True, timeout=30, **no_window_kwargs())
        except Exception:
            pass
        return ok
    except Exception as exc:
        log(f"schtasks 点火异常：{exc!r}")
        return False


def start_watchdog(wanted: dict) -> None:
    """启动退出后看护：等 ZCode 退出 → 应用重打包级补丁；顺带盯紧插件市场更新。

    **为什么即使用不上补丁也要拉起（watch 模式）**：市场「更新」只替换插件目录，
    不会重新注入 app.asar；而更新发生在会话中途，此刻没有任何钩子会被再次触发。
    只有提前常驻的看护能在客户端退出的一瞬间发现「版本目录已经换了」，并直接用
    **新版目录的脚本**重写注入 —— 用户更新完照常退出一次即可，无需再退第二次。
    
    非市场安装（开发目录 / 绿色版）没有「版本目录」可换，就没有常驻的必要。
    """
    # 过滤掉 reasoning_config 关闭项（不托管语义，绝不调度看护）
    wanted = {k: v for k, v in wanted.items() if not (k == "reasoning_config" and not v)}
    market = installed_plugin()
    if not wanted and not market:
        return
    try:
        WATCHDOG_DIR.mkdir(parents=True, exist_ok=True)
        cur_wants = {}
        if WANT_FILE.is_file():
            try:
                cur_wants = json.loads(WANT_FILE.read_text(encoding="utf-8"))
            except Exception:
                cur_wants = {}
        cur_wants.update(wanted)
        if cur_wants:
            WANT_FILE.write_text(json.dumps(cur_wants, ensure_ascii=False), encoding="utf-8")
        else:
            WANT_FILE.unlink(missing_ok=True)
        # 常驻开关：看护据此判断「即使没有待办，也要等到退出并检查插件版本」
        WATCH_FLAG.write_text(str(market.get("version") or ""), encoding="utf-8")
    except Exception:
        pass

    # 单例判定以心跳为准（0.9.3）：旧方案只看 PID 文件 + is_pid_alive，被绞杀/崩溃的
    # 看护残留的 PID 号被 Windows 复用给无关进程后，就永远误判「已有看护在跑」、从此
    # 不再拉起 —— 换台电脑「完全退出也不重注入」的头号嫌疑。心跳停更/缺失一律按
    # 「没有看护」处理重新拉起；就算误判成双看护，看护自己的心跳裁决也会让位退出。
    live = live_watchdog_pid()
    if live:
        log(f"看护进程已在运行中 (PID {live}，心跳确认)，已更新需求清单，无需重复启动")
        return

    args = ["--watch-plugin-update"]
    args += [f"--want={k}={'on' if v else 'off'}" for k, v in wanted.items()]
    way = ""
    if os.name == "nt":
        # Windows：优先经计划任务把看护放到 ZCode 进程树之外，理由与实测故障见
        # _launch_watchdog_via_task 的 docstring（树内看护会被客户端退出连坐绞杀）。
        if _launch_watchdog_via_task(args):
            way = "计划任务·树外"
    if not way:
        kw = {"cwd": str(HERE), "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
        if os.name == "nt":
            # 降级路径：计划任务被组策略禁用 / PowerShell 与 schtasks 都不可用时至少
            # 让看护起来；但要清楚——这种起法仍挂在客户端进程树上，客户端重启大概率打断写入。
            kw["creationflags"] = DETACHED_PROCESS | CREATE_NO_WINDOW
            way = "Popen·树内（计划任务不可用，客户端若被重启写入可能被打断）"
        else:
            # POSIX：自成会话组（与 spawn_detached 同一做法），否则看护留在钩子的
            # 进程组里，应用退出/清理时可能被整组信号连带杀掉。
            kw["start_new_session"] = True
            way = "新会话组"
        try:
            subprocess.Popen([sys.executable, str(WATCHDOG), *args], **kw)  # no-window-ok: kw 已按平台携带 DETACHED_PROCESS|CREATE_NO_WINDOW（Windows）/ start_new_session（POSIX）
        except Exception as exc:
            log(f"看护 Popen 启动失败: {exc!r}")
            return
        # 树内降级也要确认活性：派生成功 ≠ 进程活着（被杀软拦截同样无声无息）。
        if not wait_watchdog_alive():
            log("Popen 已派生但心跳未现身（可能被杀软拦截），本次退出注入可能无人执行")
    log(f"已启动退出后看护（{way}）: {' '.join(args)}")


def resolve_wanted() -> tuple[dict, str]:
    """算出这次要同步成什么样，返回 (期望状态, 来源说明)。

    规则：**已保存的开关优先，没保存过的键退回清单里声明的默认值。**
      * 从没保存过配置 → 全部用默认值（这就是「零配置自动注入」）
      * 保存过一部分   → 保存的照做，没提到的用默认值（插件升级新增开关时不会漏）
      * 显式关掉的开关 → 保存值是 false，优先于默认值，会被正常还原
    """
    opts, source = read_options()
    defaults = declared_defaults()
    if source is None:
        if not defaults:
            return {}, ""
        log("配置里没有本插件（从未保存过开关）→ 改用插件清单声明的默认值")
        return dict(defaults), "插件默认值（从未保存过开关）"
    explicit = {k: v for k, v in opts.items() if isinstance(v, bool)}
    if not explicit:
        if not defaults:
            return {}, ""
        log(f"配置来自 {source}，但没有可用布尔值 → 退回插件默认值")
        return dict(defaults), "插件默认值（配置里没有可用开关）"
    merged = {**defaults, **explicit}          # 保存值优先，缺的键补默认值
    return merged, source


def run_sync(echo: bool = False, inline_repack: bool = False, watch: bool = True) -> str:
    """真正干活的同步逻辑。返回一句话结论（同时写进日志与心跳）。

    echo=False 时**不往 stdout 写任何东西**：钩子的 stdout 会被按 JSON schema 严格校验，
    输出非 JSON 会被判为「钩子运行失败」（虽然脚本副作用已经生效，但日志里会留下假故障）。

    inline_repack=True 是「客户端已退出」场景（看护在插件升级后调用）：重打包级补丁
    当场写入，不再转交看护。watch=False 时也不拉起新的看护（我们就在看护里）。
    """
    wanted, origin = resolve_wanted()
    if not wanted:
        # 开关一个都解析不出来（配置损坏 / 清单缺失）时，历史滑条残留照样要清 ——
        # 这条清理与开关无关（功能已在 0.7.0 移除），不能因为早退就永远清不掉。
        if legacy_cleanup_needed():
            log("检测到历史「思考强度滑条」注入残留 → 已排入 ZCode 退出后清理（开关不可解析）")
            if watch:
                start_watchdog({LEGACY_CLEANUP_KEY: True})
            return "既没有已保存的开关，也读不到插件清单默认值 → 仅安排清理历史「思考强度滑条」残留"
        return "既没有已保存的开关，也读不到插件清单默认值 → 未做任何操作"

    # ★ 运行态状态文件必须**先**写：它不碰 app.asar，ZCode 运行中也照样生效。
    # 「关闭自动继续并保存」要立刻作废已排队的继续，不能等到客户端退出。
    state_note = ""
    if "auto_continue" in wanted:
        state_note = write_pilot_state(bool(wanted["auto_continue"]))

    changed, deferred, failed, skipped, refreshed = [], {}, [], [], []
    legacy_pending = False
    legacy_model_width_pending = False
    for key, args, repack in PATCHES:
        if key not in wanted:
            continue
        want = wanted[key]
        if key == "reasoning_config" and not want:
            # 「思考档位配置」关闭时语义为"不托管"：
            # 不主动写入，绝不主动还原 provider_config.json（客户端会自行写回，还原注定失效且会触发看护无限重启死循环）。
            continue
        state = check_state(args)
        if state == "na":
            skipped.append(key)          # 本版本不需要这个补丁（如 3.14+ 的内核补丁）
            continue
        if state == "unknown":
            failed.append(f"{key}(状态未知)")
            continue
        if state == "stale":
            # 已装的是旧版注入片段 → 无论开关要求开还是关，都必须重跑一次：
            #   want=True  → 重跑会把四组件更新到与现行脚本一致
            #   want=False → 反正要还原，直接走还原分支，不必先更新
            if not want:
                verdict = run_patcher(args, revert=True)
                if verdict == "ok":
                    changed.append(f"{key}→关")
                elif verdict == "refused":
                    deferred[key] = False
                else:
                    failed.append(f"{key}(执行失败)")
                continue
            if repack and not inline_repack:
                deferred[key] = want
                refreshed.append(key)
                continue
            verdict = run_patcher(args, revert=False)
            if verdict == "ok":
                changed.append(f"{key}→开（更新为当前版本）")
            elif verdict == "refused":
                deferred[key] = want
                refreshed.append(key)
            else:
                failed.append(f"{key}(更新失败)")
            continue
        if want and state == "off":
            need_revert = False
        elif not want and state == "on":
            need_revert = True
        else:
            continue  # 已一致
        if repack and not inline_repack:
            deferred[key] = want
            continue
        verdict = run_patcher(args, revert=need_revert)
        if verdict == "ok":
            changed.append(f"{key}→{'开' if want else '关'}")
        elif verdict == "refused":
            # 客户端在运行 → 现在写不了，转交退出后看护（这不是失败）
            deferred[key] = want
        else:
            failed.append(f"{key}(执行失败)")

    # 历史「思考强度滑条」残留：本插件已移除该功能，检测到就排一次退出后清理
    if legacy_cleanup_needed():
        deferred[LEGACY_CLEANUP_KEY] = True
        legacy_pending = True
        log("检测到历史「思考强度滑条」注入残留 → 已排入 ZCode 退出后清理")

    # 已下线的「模型弹窗加宽」：不再随开关安装。只有老用户配置里还留着这个键时，
    # 才去检测客户端残留并排一次还原（避免每次同步都跑一次无关的 --check）。
    if "model_width" in wanted:
        try:
            if check_state(LEGACY_MODEL_WIDTH_ARGS) == "on":
                deferred[LEGACY_MODEL_WIDTH_KEY] = False
                legacy_model_width_pending = True
                log("检测到已下线的「模型弹窗加宽」补丁 → 已排入 ZCode 退出后还原")
        except Exception as exc:  # 检测失败不影响其它补丁
            log(f"模型弹窗加宽残留检测失败（忽略）: {type(exc).__name__}: {exc}")

    # 常驻看护（watch=True）：即使这次没有待办也要拉起 —— 它是「市场更新后自动
    # 重新注入」的唯一触发点（更新发生在会话中途，客户端退出时不会再有钩子）。
    if watch:
        start_watchdog(deferred)

    # 记账：所有重打包级补丁都与当前脚本一致（没有待办/失败）→ 记下注入版本，
    # 下次市场更新时就能据此判断「注入内容已经旧了」。
    repack_deferred = [k for k, _a, rep in PATCHES if rep and k in deferred]
    if repack_deferred:
        # 还差一次「退出后写入」：留标记，下次会话启动时提醒用户别手动抢跑。
        mark_reinject_pending(repack_deferred)
    else:
        clear_reinject_pending()
    if not failed and not repack_deferred:
        write_inject_record()

    parts = []
    if changed:
        parts.append("已写入: " + "、".join(changed))
    if state_note:
        parts.append("运行态状态文件未写入: " + state_note)
    if refreshed:
        parts.append("插件已更新，客户端退出时重注入为新版（下次启动可见）: "
                     + "、".join(refreshed))
    if legacy_pending:
        parts.append("ZCode 退出时清理历史「思考强度滑条」残留（下次启动可见）")
    if legacy_model_width_pending:
        parts.append("ZCode 退出时还原已下线的「模型弹窗加宽」（下次启动可见）")
    # 排除已在 refreshed / legacy 里说明过的键，避免同一项被报两遍（一个空串也是这个原因）
    rest = {k: v for k, v in deferred.items()
            if k not in refreshed and k not in (LEGACY_CLEANUP_KEY, LEGACY_MODEL_WIDTH_KEY)}
    if rest:
        parts.append("ZCode 退出时写入（下次启动可见）: " + "、".join(
            f"{k}→{'开' if v else '关'}" for k, v in rest.items()))
    if skipped:
        parts.append("本版本不适用: " + "、".join(skipped))
    if failed:
        parts.append("未处理: " + "、".join(failed))
    summary = (" | ".join(parts) if parts
               else f"所有开关都已与客户端一致（来源：{origin}），无需改动")
    log(f"同步结果（来源：{origin}）—— {summary}")
    if echo:
        print(f"[zcode-pilot] {summary}")
    return summary


def get_client_fingerprint() -> dict:
    """获取当前 ZCode 客户端安装指纹（版本号、asar 路径、大小与修改时间）。"""
    try:
        sys.path.insert(0, str(HERE))
        import zcp_patcher as zp
        asars = zp._resolve_asars(None)
        if not asars:
            return {}
        asar = asars[0]
        stat = asar.stat()
        ver = str(zp.asar_version(asar) or "")
        return {
            "asar_path": str(asar.resolve()),
            "version": ver,
            "size": stat.st_size,
            "mtime": int(stat.st_mtime),
        }
    except (Exception, SystemExit):
        # SystemExit 不是 Exception 子类：`_resolve_asars` 在没装客户端的机器上
        # （CI / 纯 CLI / 用户卸载后）就是抛它。不一起接住会把整个 zcp_sync 打断，
        # 连唯一正常的提示都发不出来。
        return {}


def detect_upgrade_or_first_run() -> tuple[bool, bool, str]:
    """检测是否是首次自动注入，或是客户端升级后的首次自愈注入。
    返回: (should_notify, is_upgrade, client_version)
    """
    cur_fp = get_client_fingerprint()
    cur_ver = cur_fp.get("version", "")
    is_upgrade = False

    if cur_fp and CLIENT_FINGERPRINT.is_file():
        try:
            old_fp = json.loads(CLIENT_FINGERPRINT.read_text(encoding="utf-8"))
            if old_fp.get("asar_path") == cur_fp.get("asar_path"):
                if old_fp.get("version") and cur_ver and old_fp.get("version") != cur_ver:
                    is_upgrade = True
                elif old_fp.get("size") != cur_fp.get("size"):
                    is_upgrade = True
        except Exception:
            pass

    if cur_fp:
        try:
            CLIENT_FINGERPRINT.write_text(json.dumps(cur_fp, ensure_ascii=False), encoding="utf-8")
        except Exception:
            pass

    if is_upgrade:
        MARKER.unlink(missing_ok=True)
        try:
            MARKER.write_text(time.strftime("%Y-%m-%d %H:%M:%S"), encoding="utf-8")
        except Exception:
            pass
        log(f"检测到客户端升级 (v{cur_ver})，重置注入提示并准备自动重新注入")
        return True, True, cur_ver

    if not MARKER.exists():
        try:
            MARKER.write_text(time.strftime("%Y-%m-%d %H:%M:%S"), encoding="utf-8")
        except Exception:
            return False, False, cur_ver
        return True, False, cur_ver

    return False, False, cur_ver


def first_auto_inject() -> bool:
    """是不是这个插件安装后的第一次自动注入（兼容旧接口与测试断言）。"""
    try:
        if MARKER.exists():
            return False
        MARKER.write_text(time.strftime("%Y-%m-%d %H:%M:%S"), encoding="utf-8")
        return True
    except Exception:
        return False


NOTICE_HEAD = "ZCode Pilot 已自动接管本地补丁注入（无需手动配置）"


def build_notice(is_upgrade: bool = False, version: str = "",
                 plugin_version: str = "", reinject: bool = False) -> str:
    """自动注入时注入会话的说明（客户端升级 / 插件市场更新 / 上次重注入被打断 / 首次安装）。"""
    doctor_script = HERE / "zcp_doctor.py"
    ver_tag = f"至 v{version} " if version else ""
    if is_upgrade:
        return (
            f"检测到 ZCode 客户端已升级{ver_tag}！官方升级会覆盖客户端文件，增强补丁已在后台自动重新排期：\n"
            "· 全部补丁项将在你**完全退出 ZCode**（托盘图标右键 → 退出，关窗口不算）时由后台看护自动写入；\n"
            "  写入完成后看护会自动重启 ZCode，下次启动即可重新恢复全部增强功能！\n"
            "  ⚠️ 退出后请等看护把客户端自动拉起来（约 10–60 秒），**不要在写入完成前手动打开 ZCode** ——\n"
            "  手动打开会让写入被拒绝（app.asar 被锁），只能再等下次退出。\n"
            "· 随时可运行自检核对当前各补丁状态（只读）：\n"
            f'    python "{doctor_script}"'
        )
    if plugin_version:
        tail = ("\n⚠️ 上次的写入就是在客户端提前启动时被拒绝的：这次退出后请耐心等待自动拉起，"
                "不要手动打开。") if reinject else ""
        return (
            f"检测到插件已从市场更新至 v{plugin_version}。新版注入脚本需要一次**完全退出 ZCode**"
            "（托盘图标右键 → 退出）的写入窗口，退出后看护会自动重新拉起客户端。\n"
            "⚠️ 写入通常需要 10–60 秒：**不要在写入完成前手动打开 ZCode** —— 手动打开会让写入被拒绝"
            "（app.asar 被锁），只能再退一次。" + tail + "\n"
            f'想看当前状态可运行（只读，可选）：\n    python "{doctor_script}"'
        )
    if reinject:
        return (
            "上次的补丁写入没有完成：客户端在写入前被重新打开了（app.asar 被锁，补丁脚本按设计拒绝硬改）。\n"
            "请再**完全退出 ZCode 一次**（托盘图标右键 → 退出），并等待看护自动把客户端拉起来"
            "（约 10–60 秒）—— **期间不要手动打开 ZCode**，否则会再次被打断。\n"
            f'想核对当前状态可运行（只读，可选）：\n    python "{doctor_script}"'
        )
    return (
        f"{NOTICE_HEAD}。本次会话启动时已在后台开始同步：\n"
        "· 六项补丁（思考档位配置、用量页去截断、TPS 状态栏、自动继续、"
        "增强提示词、模型拉取按钮）都要等你**完全退出 ZCode**（托盘图标右键 → 退出）时才会写入 ——\n"
        "  客户端运行期间会拒绝改写 app.asar 与 provider_config.json；退出后由看护写入，"
        "并自动把 ZCode 重新拉起来，再启动即可见。\n"
        "  ⚠️ 退出后请等看护自动拉起（约 10–60 秒），不要让手动打开抢先，否则写入会被拒绝。\n"
        "  「自动继续」的开关状态是例外：它写的是运行态状态文件 ~/.zcode/pilot/state.json，"
        "运行中也立即生效。\n"
        "这一条只在首次自动注入时出现。想核对结果可以运行（只读，可选）：\n"
        f'    python "{doctor_script}"'
    )


def emit_notice(is_upgrade: bool = False, version: str = "", plugin_version: str = "",
                reinject: bool = False) -> None:
    """往会话里注入一条说明，让「自动注入到底做没做」看得见。"""
    try:
        print(json.dumps({"additionalContext": build_notice(is_upgrade, version,
                                                            plugin_version, reinject)},
                         ensure_ascii=False))
    except Exception as exc:
        log(f"提示输出失败: {exc!r}")


def main() -> None:
    """入口分流：钩子只负责「登记心跳 + 后台化」，干活交给 --worker 子进程。"""
    argv = sys.argv[1:]

    if "--apply-now" in argv:
        # 看护在客户端**已退出**后调用（插件市场更新后的重注入）：重打包级补丁当场写入，
        # 也不再拉起看护。成功后写注入版本记录，供看护确认「新版本已经落地」。
        beat("插件更新后重注入")
        beat(run_sync(echo=False, inline_repack=True, watch=False))
        return

    if "--worker" in argv:
        beat("后台同步已启动")
        beat(run_sync(echo=False))
        return

    if "--detach" in argv:
        # 钩子模式：先留下心跳（哪怕后台起不来也证明钩子跑过），再立刻返回
        beat("已启动（后台同步）")
        notify, is_up, ver = detect_upgrade_or_first_run()
        pending = plugin_update_pending()
        reinj = read_reinject_pending()
        if notify or pending or reinj:
            emit_notice(is_upgrade=is_up, version=ver,
                        plugin_version="" if is_up else str(pending.get("version") or ""),
                        reinject=bool(reinj))
        if not spawn_detached(["--worker", "--from-hook"]):
            beat(run_sync(echo=False))  # 兜底：后台起不来就前台做完
        return

    # 人工前台执行：把结论直接打在终端上
    beat("手动执行")
    summary = run_sync(echo=True)
    beat(summary)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # hook 绝不能因自身异常打断会话启动
        log(f"zcp_sync 异常: {exc!r}")
        beat(f"异常退出: {exc!r}")
