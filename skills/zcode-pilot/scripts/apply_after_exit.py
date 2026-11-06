#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ZCode 退出后自动打补丁看护（计划任务 / 插件开关同步调用，勿手动常跑）
轮询等待 ZCode.exe 全部退出 → 按期望状态应用/还原补丁（重打包级需文件未被占用）
→ 重启 ZCode → 记录日志后退出。日志: scripts/_apply_after_exit.log

两种调用方式：
  1) 无参数（本地计划任务）：应用 档位配置 + TPS 状态栏 + 自动继续 + 拉取按钮（见 DEFAULT_TASKS）
  2) `--want=<键>=on|off`（插件 sync.py 传入，可多个）：只处理指定开关，off 走 --revert

取消方式: schtasks /Delete /TN ZCodePatchApply /F（并删除本脚本）

退出码约定（与 zcode_patcher.py 一致）：0=成功、1=有项目失败/等待超时、2=预检失败（ZCode 仍在运行）。
"""

import os
import subprocess
import sys
import time
from pathlib import Path

try:                                   # 控制台编码/窗口安全网（见 _console.py 的说明）
    from _console import no_window_kwargs
except ImportError:                    # 被别处 import 时脚本目录可能不在 sys.path
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from _console import no_window_kwargs

HERE = Path(__file__).resolve().parent
LOG = HERE / "_apply_after_exit.log"
# 单例文件必须跨插件版本目录共享：市场更新会换版本目录（0.8.0 → 0.8.1），
# 若把 pid/want 留在插件目录里，新旧两个看护会同时存在并互相覆盖注入结果。
STATE_DIR = Path.home() / ".zcode" / "pilot"
PID_FILE = STATE_DIR / "watchdog.pid"
WANT_FILE = STATE_DIR / "watchdog.want"
POLL_SEC = 1
#: 常驻监听插件更新时（没有待办）用低频轮询，避免整场会话每秒都去 tasklist；
#: 真有待办补丁时仍用 POLL_SEC，保证退出后尽快落盘。
IDLE_POLL_SEC = 5
MAX_WAIT_SEC = 24 * 3600
#: 客户端改完/更新后常在几秒内被重新拉起。一次写不进去不代表永久失败：
#: 保留待办、等它下次完全退出再写。轮数是防死循环的硬上限，不是正常路径。
MAX_PATCH_ROUNDS = 5
RETRY_DELAY_SEC = 2
PYTHON = sys.executable or "python"
#: 子进程超时（秒）。看护是**无人值守**运行的，一旦某个子进程挂死就再也没有人
#: 会来收拾 —— 表现为「明明退出了却永远不生效」（与 7.5 节那个故障长得一样）。
#: tasklist 正常 <1s；zcode_patcher 在 311MB asar 上实测 2~3s，给足余量。
TASKLIST_TIMEOUT = 30
PATCH_TIMEOUT = 600


def _import_patcher():
    """导入主脚本模块；sys.path 只在缺失时插入。

    看护轮询循环每 POLL_SEC 秒调一次 zcode_running() → 本函数被反复执行，
    不能每次都 insert（sys.path 会无界增长——24h 上限约 2.9 万个重复项）。
    """
    if str(HERE) not in sys.path:
        sys.path.insert(0, str(HERE))
    import zcode_patcher as zp
    return zp


def log(msg: str) -> None:
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n")


def is_pid_alive(pid: int) -> bool:
    """检查指定 PID 进程是否仍在存活运行。"""
    if pid <= 0:
        return False
    if sys.platform == "win32":
        try:
            import ctypes
            PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
            SYNCHRONIZE = 0x00100000
            h = ctypes.windll.kernel32.OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, False, pid
            )
            if not h:
                return False
            exit_code = ctypes.c_ulong()
            ctypes.windll.kernel32.GetExitCodeProcess(h, ctypes.byref(exit_code))
            ctypes.windll.kernel32.CloseHandle(h)
            return exit_code.value == 259  # STILL_ACTIVE
        except Exception:
            return False
    else:
        try:
            import os
            os.kill(pid, 0)
            return True
        except OSError:
            return False


def zcode_running() -> bool:
    # 复用主脚本 zcode_patcher.zcode_running() 的跨平台检测（Windows: tasklist 检索
    # ZCode.exe；POSIX: pgrep -f ZCode）。看护的判定必须与补丁预检同源，否则会出现
    # 「看护以为退干净了、动手时又被预检拒绝」的永久错位。
    # 历史问题：这里曾直接跑 ["tasklist"] 并检索 b"ZCode.exe" —— macOS/Linux 上没有
    # tasklist，FileNotFoundError 未被捕获（except 只接 TimeoutExpired），看护在第一次
    # 轮询就崩溃；启动方又把 stderr 定向到 DEVNULL，崩溃完全无声，表现为
    # 「等退出 0 次、完成 0 次」、补丁永远写不进去。
    try:
        return _import_patcher().zcode_running()
    except Exception as e:
        log(f"运行检测失败: {type(e).__name__}: {e}，本轮按「仍在运行」处理")
        return True


def _find_exe(res: Path) -> Path | None:
    """从 asar 所在目录（<安装根>/resources）推出各平台的 ZCode 主程序路径。"""
    root = res.parent                       # Windows: 安装根；macOS: ZCode.app/Contents
    cands: list[Path] = [root / "ZCode.exe"]            # Windows
    if sys.platform == "darwin":
        cands.insert(0, root / "MacOS" / "ZCode")       # macOS .app 包
    else:
        cands += [root / "zcode", root / "ZCode"]       # Linux 常见命名
    for c in cands:
        if c.is_file():
            return c
    return None


def resolve_install() -> tuple[Path | None, Path | None]:
    """复用主脚本的跨平台探测拿到 (asar 目录, ZCode 可执行文件)。"""
    try:
        zp = _import_patcher()
        for cjs in zp.discover():
            res = cjs.parent.parent
            if (res / "app.asar").is_file():
                return res, _find_exe(res)
    except Exception as e:
        log(f"安装探测失败: {type(e).__name__}: {e}")
    return None, None


# 配置键 -> zcode_patcher.py 参数（与 sync.py 的 PATCHES 一一对应，顺序也保持一致）
# 漏一个键的后果：`--want=<键>=on` 会被 parse_wants 当「未知开关」忽略，
# 于是那个开关**开不起来也关不干净**（enhance_prompt 就漏过这一条）。
PATCH_ARGS = {
    "reasoning_config": ["--reasoning-config"],
    "usage_chart": ["--usage-chart"],
    "tps_footer": ["--tps-footer"],
    "auto_continue": ["--auto-continue"],
    "enhance_prompt": ["--enhance-prompt"],
    "model_puller": ["--model-puller"],
    "core_patch": [],
    # 历史补丁「思考强度滑条」的残留清理：不是用户开关，只在 sync.py 探测到残留时排一次。
    # 它天然是「删除」动作，off 与 on 同义（parse_wants 只在 enabled=True 时才会排进来）。
    "cleanup_legacy": ["--cleanup-legacy"],
    # 已下线的「模型弹窗加宽」：只用于还原老客户端里的残留，不再作为可安装功能。
    # sync.py 以 enabled=False 排进来 → parse_wants 转成 --model-width --revert。
    "cleanup_model_width": ["--model-width"],
}
# 未收到 --want 时的默认动作（本地计划任务用）：按序应用现行补丁，
# 外加一次历史滑条残留清理（无残留时是空转，不会误删东西）。
DEFAULT_TASKS = [
    ["--cleanup-legacy"],
    ["--reasoning-config"],
    ["--usage-chart"],
    ["--tps-footer"],
    ["--auto-continue"],
    ["--enhance-prompt"],
    ["--model-puller"],
]


def _watch_flag() -> Path:
    """常驻开关文件：与 WANT_FILE 同目录（测试里 WANT_FILE 被改到临时目录时自动隔离）。"""
    return WANT_FILE.with_name("watchdog.watch")


def _watch_enabled(argv: list[str] | None = None) -> bool:
    return "--watch-plugin-update" in (argv if argv is not None else sys.argv[1:]) \
        or _watch_flag().is_file()


def _installed_plugin() -> dict:
    """市场登记表里的当前安装：`{version, root}`。读不到返回 `{}`。"""
    import json
    path = Path.home() / ".zcode" / "cli" / "plugins" / "installed_plugins.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    for ent in data.get("plugins") or []:
        if not isinstance(ent, dict):
            continue
        name = str(ent.get("id") or "").split("@")[0] or str(ent.get("name") or "")
        if name not in ("zcode-pilot", "zcode-tokenspeed"):
            continue
        root = ent.get("installPath")
        if root and Path(root).is_dir():
            return {"version": str(ent.get("version") or ""),
                    "root": Path(root).resolve()}
    return {}


def _inject_record() -> dict:
    import json
    try:
        return json.loads((WANT_FILE.parent / "injected.json").read_text(encoding="utf-8"))
    except Exception:
        return {}


def update_pending() -> dict:
    """客户端退出时：市场装的是不是比「已注入版本」更新的插件？是则返回新版信息。

    这是「插件市场更新后自动重新注入」的判定点：更新发生在会话中途，客户端退出那一刻
    不会再有钩子被触发，只有常驻看护能在这里发现版本变了，并改用**新版插件目录**的
    sync.py 完成重注入。
    """
    if not _watch_enabled():
        return {}
    cur = _installed_plugin()
    rec = _inject_record()
    if not cur or not rec:
        return {}
    old = str(rec.get("pluginVersion") or "")
    if cur["version"] and old and cur["version"] != old:
        return {**cur, "from": old}
    return {}


def _sync_script(root: Path) -> Path | None:
    """在新版插件根下找到 sync.py（兼容市场缓存与「市场根即插件根」两种布局）。"""
    for rel in (("skills", "zcode-pilot", "scripts", "sync.py"),
                ("skills", "zcode-tokenspeed", "scripts", "sync.py"),
                ("scripts", "sync.py")):
        p = root.joinpath(*rel)
        if p.is_file():
            return p
    return None


def apply_plugin_update(upd: dict) -> bool:
    """用**新版插件目录**的 sync.py 重注入。返回 True=确认已落地。

    成功判据不是退出码（sync 总是 0），而是它写下的注入版本记录变成了新版本 ——
    这保证「记录说新版本已注入」与「app.asar 里真的是新脚本」是同一件事。
    """
    script = _sync_script(Path(upd["root"]))
    if script is None:
        log(f"插件已更新至 v{upd['version']}，但在 {upd['root']} 下找不到 sync.py，改走本地补丁")
        return False
    log(f"检测到插件已更新 {upd.get('from', '?')} → v{upd['version']}，改用新版脚本重注入：{script}")
    try:
        r = subprocess.run([PYTHON, str(script), "--apply-now"], capture_output=True,
                           timeout=PATCH_TIMEOUT, cwd=str(script.parent),
                           **no_window_kwargs())
        out = ((r.stdout or b"") + (r.stderr or b"")).decode("utf-8", "replace")
        log(f"$ sync.py --apply-now  [exit={r.returncode}]\n{out}".rstrip())
    except subprocess.TimeoutExpired:
        log(f"插件更新后重注入超时（{PATCH_TIMEOUT}s），改走本地补丁")
        return False
    ok = str(_inject_record().get("pluginVersion") or "") == str(upd["version"])
    if not ok:
        log("新版脚本没有确认落地（注入版本记录未更新），改走本地补丁兜底")
    return ok


def _record_injected() -> None:
    """本地补丁成功后记下注入版本（只在市场安装目录里才会真正写入）。"""
    try:
        import sync
        sync.write_inject_record()
    except Exception:
        pass


def _save_wants(argv: list[str]) -> None:
    """把传入的 --want 参数与已存的合并并写入 WANT_FILE。"""
    wants_dict = {}
    if WANT_FILE.is_file():
        try:
            import json
            wants_dict = json.loads(WANT_FILE.read_text(encoding="utf-8"))
        except Exception:
            wants_dict = {}
    for a in argv:
        if a.startswith("--want="):
            key, _, val = a[len("--want="):].partition("=")
            key = key.strip()
            if key in PATCH_ARGS:
                enabled = val.strip().lower() not in ("off", "false", "0", "no")
                if key == "reasoning_config" and not enabled:
                    # 思考档位配置关闭为"不托管"语义：绝不记录还原请求
                    wants_dict.pop(key, None)
                else:
                    wants_dict[key] = enabled
    if wants_dict:
        try:
            import json
            WANT_FILE.parent.mkdir(parents=True, exist_ok=True)
            WANT_FILE.write_text(json.dumps(wants_dict, ensure_ascii=False), encoding="utf-8")
        except Exception:
            pass
    elif WANT_FILE.is_file():
        try:
            WANT_FILE.unlink(missing_ok=True)
        except Exception:
            pass


def parse_wants(argv: list[str]):
    """解析 sync.py 传入的 --want=<key>=on|off 或 WANT_FILE。

    返回 [(args, revert), ...]；没有任何输入时返回 None（走 DEFAULT_TASKS）。
    `--watch-plugin-update` 表示「常驻监听插件市场更新」：此时即使没有待办，
    也必须返回空列表（而不是 None），否则会误落进 DEFAULT_TASKS 把开关全装一遍。"""
    watch_only = "--watch-plugin-update" in argv
    has_explicit_input = (any(a.startswith("--want=") for a in argv)
                          or WANT_FILE.is_file() or watch_only)
    merged_wants = {}
    if WANT_FILE.is_file():
        try:
            import json
            merged_wants = json.loads(WANT_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    for a in argv:
        if a.startswith("--want="):
            key, _, val = a[len("--want="):].partition("=")
            key = key.strip()
            if key in PATCH_ARGS:
                merged_wants[key] = val.strip().lower() not in ("off", "false", "0", "no")

    if not has_explicit_input and not merged_wants:
        return None
    tasks = []
    for key, enabled in merged_wants.items():
        # 兼容旧版 want 文件：已下线的开关（如 0.7.0 移除的 thought_slider）可能还留在文件里。
        # 直接忽略未知键，绝不能 KeyError —— 否则整个退出看护会崩，补丁永远装不上。
        if key not in PATCH_ARGS:
            continue
        if key == "reasoning_config" and not enabled:
            # 思考档位配置关闭为"不托管"语义：绝不执行 revert，避免覆盖客户端文件并导致重启死循环
            continue
        tasks.append((PATCH_ARGS[key], not enabled))
    return tasks


def batch_tasks(tasks: list[tuple[list[str], bool]]) -> list[tuple[list[str], bool]]:
    """将同方向（revert 或 apply）的补丁参数合并为批量调用，避免多次解包/重打包 asar。

    规则：
      1. 先执行 revert（还原关闭的项），再执行 apply（应用开启的项）；
      2. 针对同一方向：
         - 拥有具体命令行参数的补丁（如 --tps-footer, --enhance-prompt 等）合并为单次批量调用，
           参数保持既有顺序并去重；
         - 空参数项（即 core_patch 思维强度内核补丁）保持独立调用（因为 zcode_patcher 在
           接收 asar 标志时不会跑内核补丁）。
    """
    batched = []
    for target_revert in (True, False):
        subset = [args for args, rev in tasks if rev == target_revert]
        if not subset:
            continue
        merged_args = []
        has_core_patch = False
        for args in subset:
            if not args:
                has_core_patch = True
            else:
                for a in args:
                    if a not in merged_args:
                        merged_args.append(a)
        if merged_args:
            batched.append((merged_args, target_revert))
        if has_core_patch:
            batched.append(([], target_revert))
    return batched


def _cleanup_singletons(cur_pid: int) -> None:
    try:
        if PID_FILE.is_file() and PID_FILE.read_text(encoding="utf-8").strip() == str(cur_pid):
            PID_FILE.unlink(missing_ok=True)
        WANT_FILE.unlink(missing_ok=True)
    except Exception:
        pass


def _release_pid(cur_pid: int) -> None:
    """只释放 PID 文件，保留 WANT_FILE。

    写入失败时必须保留待办，否则下一次会话启动会忘记「还差哪些补丁」；
    但 PID 必须释放，否则下一轮看护会把自己当成「已有活跃实例」而直接退出。
    """
    try:
        if PID_FILE.is_file() and PID_FILE.read_text(encoding="utf-8").strip() == str(cur_pid):
            PID_FILE.unlink(missing_ok=True)
    except Exception:
        pass


def main() -> int:
    import os
    cur_pid = os.getpid()
    if PID_FILE.is_file():
        try:
            old_pid = int(PID_FILE.read_text(encoding="utf-8").strip())
            if old_pid != cur_pid and is_pid_alive(old_pid):
                log(f"已有活跃看护运行中 (PID {old_pid})，已登记最新需求，本实例退出")
                _save_wants(sys.argv[1:])
                return 0
        except Exception:
            pass
    try:
        PID_FILE.parent.mkdir(parents=True, exist_ok=True)
        PID_FILE.write_text(str(cur_pid), encoding="utf-8")
    except Exception:
        pass
    _save_wants(sys.argv[1:])

    # 常驻监听（插件市场更新）：没有待办也要等退出，届时检查版本是否变了。
    watch = _watch_enabled()

    # 预检：如果明确指定了需求但过滤后无待办任务（如仅 reasoning_config=off），直接退出
    early_tasks = parse_wants(sys.argv[1:])
    if early_tasks is not None and not early_tasks and not watch:
        log("没有待应用的补丁任务，看护退出，不进行等待与重启")
        _cleanup_singletons(cur_pid)
        return 0

    log(f"看护启动，等待 ZCode 退出 (PID {cur_pid})…")

    raw_tasks = parse_wants(sys.argv[1:])
    if raw_tasks is None:
        raw_tasks = [(args, False) for args in DEFAULT_TASKS]
    if not raw_tasks and not watch:
        log("ZCode 已退出，但检查后无有效补丁任务需要执行，看护完成，不重启 ZCode")
        _cleanup_singletons(cur_pid)
        return 0
    desc = "、".join(("还原 " if rev else "应用 ") + (" ".join(a) or "内核补丁") for a, rev in raw_tasks)
    if desc:
        log(f"待处理：{desc}")
    if not raw_tasks:
        log("无待办补丁：常驻监听插件市场更新（退出时若版本变化会自动重注入）")

    tasks = batch_tasks(raw_tasks)
    # 有待办时保持 1s 轮询（退出后尽快落盘）；纯监听时降到 5s，避免整场会话高频 tasklist。
    poll = POLL_SEC if tasks else IDLE_POLL_SEC
    failed = 0
    applied_update = False
    update_failed = False
    for round_no in range(1, MAX_PATCH_ROUNDS + 1):
        waited = 0
        while zcode_running():
            time.sleep(poll)
            waited += poll
            if waited >= MAX_WAIT_SEC:
                log("等待超时（24h），放弃本轮；待办保留")
                _release_pid(cur_pid)
                return 1

        log(f"ZCode 已退出（等待 {waited}s），开始写入（第 {round_no}/{MAX_PATCH_ROUNDS} 轮）")

        # ★ 插件市场更新优先：更新只换了插件目录，旧目录的脚本还是旧实现。
        #   必须改用**新版目录**的 sync.py 按期望状态重写，绝不能用本地 patcher 把旧版写回去。
        upd = update_pending()
        if upd:
            if apply_plugin_update(upd):
                applied_update = True
                failed = 0
                break
            log("插件更新重注入未确认成功：保留待办等下次会话继续（不写回旧版脚本）")
            failed = 1
            update_failed = True
            break

        if not tasks:
            log("ZCode 已退出，但没有待办补丁，本次不重启 ZCode")
            _cleanup_singletons(cur_pid)
            return 0

        failed = 0
        for args, revert in tasks:
            cmd = [PYTHON, str(HERE / "zcode_patcher.py"), *args] + (["--revert"] if revert else [])
            try:
                r = subprocess.run(cmd, capture_output=True, timeout=PATCH_TIMEOUT,
                                   **no_window_kwargs())
            except subprocess.TimeoutExpired:
                # 超时 = 这一项没做成。继续跑剩下的项（能写一项是一项），最后计入 failed。
                log(f"$ zcode_patcher.py {' '.join(cmd[2:])}  [超时 {PATCH_TIMEOUT}s]")
                failed += 1
                continue
            out = ((r.stdout or b"") + (r.stderr or b"")).decode("utf-8", "replace")
            log(f"$ zcode_patcher.py {' '.join(cmd[2:])}  [exit={r.returncode}]\n{out}".rstrip())
            if r.returncode == 2:
                # 等待期间客户端被重新拉起：本轮到此为止，但**绝不能丢待办**。
                log("预检未通过（ZCode 被重新拉起）——保留未完成项，继续等下次完全退出")
                failed = 1
                break
            if r.returncode != 0:
                failed += 1

        if failed == 0:
            break

        # 写失败：如果客户端又跑起来了，等它下次退出再写（这才是最常见的真实场景）。
        if zcode_running():
            log("检测到 ZCode 已再次运行：本轮未完成的补丁保留，继续等待下次完全退出")
            continue
        if round_no < MAX_PATCH_ROUNDS:
            log(f"写入失败（客户端当前未运行），{RETRY_DELAY_SEC}s 后原地重试")
            time.sleep(RETRY_DELAY_SEC)
            continue
        break

    if failed:
        if update_failed:
            log("插件更新重注入未完成；待办已保留，下次会话启动会继续排期（无需手动处理）")
        else:
            log(f"已重试 {MAX_PATCH_ROUNDS} 轮仍有 {failed} 类写入未成功；"
                "待办已保留，下次会话启动会继续排期（无需手动处理）")
        _release_pid(cur_pid)
        return 1

    # 本地补丁写完 → 记下注入版本（新版重注入已由 sync 自己记过）。
    if not applied_update:
        _record_injected()

    res, exe = resolve_install()
    _cleanup_singletons(cur_pid)
    if exe is None:
        log("未找到 ZCode 主程序（Windows: ZCode.exe / macOS: .app 包内 MacOS/ZCode），请手动启动")
        return 1
    log("处理完成，重启 ZCode")
    if zcode_running():
        log("检测到 ZCode 已再次运行，跳过重启")
        return 0
    try:
        if os.name == "nt":
            subprocess.Popen([str(exe)], cwd=str(exe.parent),
                             creationflags=0x00000008)   # DETACHED_PROCESS——保持上游原样，Windows 行为零变化
        elif sys.platform == "darwin" and res is not None and res.parent.parent.suffix == ".app":
            # macOS 经 Launch Services 打开 .app 包。注意 creationflags 是 Windows 专属
            # 参数，POSIX 上传入会直接抛 ValueError，所以必须按平台分流。
            subprocess.Popen(["open", str(res.parent.parent)],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             **no_window_kwargs())
        else:
            subprocess.Popen([str(exe)], cwd=str(exe.parent), start_new_session=True,
                             **no_window_kwargs())
    except Exception as e:
        log(f"重启 ZCode 失败（请手动启动）: {e}")
        return 1
    log("DONE")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        # 看护无人值守：崩溃必须留痕。此前 stderr 被 start_watchdog 定向到 DEVNULL，
        # 崩溃无声 —— 这正是 macOS 上「等退出 0 次」长期没被发现的原因。
        import traceback
        log("看护异常退出:\n" + traceback.format_exc())
        sys.exit(1)
