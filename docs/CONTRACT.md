# zcode-pilot 改造接口契约（唯一事实来源）

> 本文件由 Lead 维护。所有并行改造必须以本文件里的**名称、路径、ID、参数**为准；
> 需要变更契约时先找 Lead 更新本文件，不要在各自代码里另起一套。

## 0. 品牌与版本

| 项 | 值 |
| --- | --- |
| 插件名（plugin.json `name`） | `zcode-pilot` |
| 显示名（marketplace `displayName`） | `ZCode Pilot` |
| 中文显示名 | `ZCode 工具箱` |
| 技能目录 | `skills/zcode-pilot/` |
| 版本 | `0.8.2` |
| 仓库名 / 市场名 | 仓库为 `Zcode-Tools`（GitHub：`HUIdada1/Zcode-Tools`），**市场 id 与插件同名 = `zcode-pilot`**：本插件从旧市场里独立出来，配置键为 `zcode-pilot@zcode-pilot` |
| 图标 | `assets/icon.png` / `assets/banner.png`（由 `tools/make_logo.py` 生成） |

## 1. 补丁清单（zcode_patcher.py 的 `ALL_PATCH_FLAGS`）

改造后为 6 项（**移除 `thought_slider` 与 `model_width`，新增 `auto_continue`**）：

| 配置键 | CLI 参数 | 源码覆盖参数 | 级别 | 注入载体 |
| --- | --- | --- | --- | --- |
| `reasoning_config` | `--reasoning-config` | — | 立即 | provider_config.json |
| `usage_chart` | `--usage-chart` | — | 立即 | asar 内同长度改字节 |
| `tps_footer` | `--tps-footer` | `--tps-src` | 重打包 | 单脚本注入 |
| `auto_continue` | `--auto-continue` | `--pilot-src` | 重打包 | 四组件注入（renderer+index+preload+main） |
| `enhance_prompt` | `--enhance-prompt` | `--enhance-src` | 重打包 | 四组件注入 |
| `model_puller` | `--model-puller` | `--puller-src` | 重打包 | 四组件注入 |
| `core_patch` | （无参数，内核补丁） | — | 立即 | zcode.cjs |

`--all` 展开以上除 `core_patch` 外的 6 个补丁参数（沿用现有 `_expand_all`）。
已下线的 `model_width` 只在 `--all --revert` 时作为 legacy 项展开，用于清理老客户端残留；
它**不得**回到 `ALL_PATCH_FLAGS`，否则会把用户明确要求去掉的加宽重新打回。

## 2. 自动继续注入载体（新增）

| 项 | 值 |
| --- | --- |
| renderer 脚本 entry | `out/renderer/zcode-pilot.js` |
| index.html 标签 | `<script src="./zcode-pilot.js"></script>`（插在 `</body>` 前） |
| sidecar | `app.asar.pilot-patch.json` |
| 备份 | `app.asar.pilot.bak` |
| preload 注入块 id | `zcode-pilot` |
| main 注入块 id | `zcode-pilot` |
| 复用链路 | `_process_ipc_patch(..., PILOT_SPEC)`，锚点沿用 `PULLER_PRELOAD_ANCHOR` / `PULLER_MAIN_ANCHOR` |

### 2.1 IPC 桥（preload 暴露 + main 处理）

```
渲染层调用：window.zcode.pilotState(patch?)   // patch 省略 = 只读；传对象 = 合并写入后返回最新态
IPC 通道：  "zcode:pilot-state"
返回：      完整 state 对象（见 2.2）
```

**注意**：具体挂载写法必须照抄同文件里已有的 `_models_preload_block` / `_models_main_block`
（同样的 electron 别名捕获、同样的 `contextBridge.exposeInMainWorld("zcode", {...})` 形态），
不要自创第二种写法。

### 2.2 状态文件（唯一权威）

路径：`~/.zcode/pilot/state.json`（`Path.home()/".zcode"/"pilot"/"state.json"`）

```json
{
  "version": 1,
  "enabled": true,      // 插件配置页托管开关（sync.py 写）
  "runtime": true,      // 旧版全局开关（兼容读取）；新版本以 sessions[sid].mode 为准
  "paused": false,      // 全局暂停（sync.py 写；true 时停止一切自动继续）
  "cancelToken": 0,     // 递增即作废所有已排队的继续
  "updatedAt": "2026-10-28T16:00:00+08:00",

  "lastContinueAt": 0,          // 上次自动续跑的毫秒时间戳（冷却判定）
  "sessions": {                 // 按 session_id 分桶，避免多会话互相污染
    "<session_id>": { "mode": "default", "consecutive": 0, "lastAt": 0 }
  },
  "journal": {                  // 崩溃恢复台账：在途轮次
    "<session_id>": { "turnId": "...", "startedAt": 0, "lastActivityAt": 0, "text": "继续" }
  },
  "settings": {                 // 设置页侧边 tab 写入；默认策略对齐 dsh-client-auto-continue
    "defaultMode": "recover",   // recover | loop
    "resumeSilentTurns": true,
    "resumeFailedTurns": true,  // TurnError 轮次由渲染层兜底（Stop hook 不会触发）
    "guardTools": true,
    "loopGuard": true,
    "graceMs": 3000,
    "cooldownMs": 20000,
    "maxConsecutive": 3,
    "continueText": "继续",
    "continueTextMaxTokens": "继续",
    "continueTextSilent": "……",
    "continueTextLoop": "继续",
    "continueTextInterrupted": "继续",
    "guardPendingText": "……",
    "guardDoneText": "……",
    "loopText": "……"
  }
}
```

* `settings` 由渲染层设置页写、由 hook 读；主进程 handler 逐键合并并校验类型，
  空文本/坏数字回落默认值。默认策略与 `dsh-client-auto-continue` 一致：
  **默认仅故障恢复（不接力正常完成的回合）**、宽限 3s、冷却 20s、连续上限 3。

* 写入方必须**读-改-写**（不要整体覆盖别人的字段）：`enabled/paused/cancelToken` 归 sync.py，
  `sessions[sid].mode` 归渲染层（按当前会话切换），`sessions[sid].consecutive/lastAt` 与
  `lastContinueAt` 归 hook，`journal` 归渲染层。
* 会话模式：`default`（跟随 `settings.defaultMode`）/ `off`（仅本会话关）/ `recover` / `loop`；
  旧版全局 `runtime=false` 在会话没有 `mode` 时兼容为 `off`。
* 并发写用「同目录临时文件 + `os.replace`」原子替换，避免半截 JSON。

* 缺文件 / 字段缺失 → 按上面默认值补齐（`enabled:true` 与插件清单默认值一致）。
* 渲染层每 **1500ms** 轮询一次（`document.hidden` 时跳过），并在 `visibilitychange` 时立即拉取。
* 关闭并保存（`enabled:false`）：`sync.py` 写 `enabled:false`、`paused:true`，并把 `cancelToken` +1。
* 重新开启并保存（`enabled:true`）：写 `enabled:true`、`paused:false`。
* 渲染层收到 `cancelToken` 变化 → 清空队列与所有待发定时器；收到 `paused:true` → 停止但不丢队列。

### 2.2.1 注入版本记录与常驻看护（插件市场更新自动重注入）

插件市场「更新」只替换插件目录（`.../zcode-pilot/<版本>/`），**不会**重写 `app.asar`。
为了让更新后无需手动操作、也不用退两次，注入链路增加了跨版本目录共享的约定：

| 文件（均在 `~/.zcode/pilot/`） | 写入方 | 语义 |
| --- | --- | --- |
| `watchdog.pid` / `watchdog.want` | `sync.py` / `apply_after_exit.py` | 看护单例与待办；**必须共享**，否则新旧版本的看护会同时存在并互相覆盖 |
| `watchdog.watch` | `sync.py`（`start_watchdog`） | 常驻监听开关；存在时看护即使没有待办也等到客户端退出 |
| `injected.json` | `sync.py`（`write_inject_record`） | `{pluginVersion, pluginRoot}`：`app.asar` 当前注入的是哪个插件版本 |
| `reinject.pending` | `sync.py`（`mark_reinject_pending`） | 重打包级补丁尚未落盘（被客户端提前启动打断）；下次会话据此提示「再完全退出一次、等看护自动拉起、别手动打开」 |

* **只在市场安装目录里记账**：`pluginRoot` 必须等于 `installed_plugins.json` 里本插件的
  `installPath`。从仓库/绿色目录手工跑 sync 不会污染记录（否则开发目录会被误判成升级）。
* 看护在客户端退出的一瞬间比对「`injected.json` 的版本」与「市场登记表里的当前版本」；
  不一致 → 改用**新版插件目录**的 `sync.py --apply-now` 重注入（绝不用旧目录的 patcher
  把旧实现写回去），成功后自动重启客户端。
* 成功判据是 `injected.json` 的版本已变成新版（`sync.py` 总返回 0，退出码不可信）。
* `sync.py --apply-now`：客户端已退出场景使用，重打包级补丁当场写入且不拉起新看护。
* **退出确认**：看护判定「已退出」后再等 `EXIT_CONFIRM_SEC`（2s）复查一次，
  防止把「更新器正在重启」误判成退出——那会让写入被预检拒绝并白白消耗一轮。
* 写入被拒绝/未获得窗口时 **绝不删待办**：`watchdog.want` 与 `reinject.pending` 都保留，
  下次会话启动继续排期，并在会话里提示「退出后等看护自动拉起、别手动打开」。

## 2.3 续跑主通道 = 官方 Stop Hook（**权威**，2026-10-28 依据 REA 结论定稿）

逆向结论（证据见 `.research/rea-findings.md` §3.2、§5.1、§7）：
* ZCode 官方插件系统支持 7 个 hook 事件：`SessionStart / UserPromptSubmit / PreToolUse / PermissionRequest / PostToolUse / PostToolUseFailure / Stop`；
* `Stop` hook 输出 `{"decision":"block","reason":"<续跑文本>"}` → 内核置 `stopShouldContinue=true`，reason 作为上下文注入，**本轮继续跑**（等价于「打断后重启运行」）；
* 渲染层 `window.zcode` **没有**任何「发送文本 / 入队 / 中断本轮」API。

因此职责划分（**不得混用**）：

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 续跑决策（权威） | `skills/zcode-pilot/scripts/autocontinue_hook.py` | `Stop` / `UserPromptSubmit` hook：判定是否需要续跑、选文本、计时与计数、循环守卫 |
| 循环守卫（独立模块） | `skills/zcode-pilot/scripts/loopguard.py` | 独立识别重复动作循环，输出循环提示文；由 hook 调用，**关闭自动继续时同步失效** |
| 控制面/观测面 | `skills/zcode-pilot/scripts/zcode-pilot.js` | 开关 UI（状态只显示在开关自身）、状态文件读写、**崩溃恢复**的续跑发送 |
| 补丁链路 | `zcode_patcher.py` 的 `PILOT_SPEC` | 只负责把 `zcode-pilot.js` 与 preload/main 桥注入 asar |

### 2.3.1 hook 注册（`hooks/hooks.json`）

```json
"Stop":             [{ "hooks": [{ "type": "command",
   "command": "python \"${CLAUDE_PLUGIN_ROOT}/skills/zcode-pilot/scripts/autocontinue_hook.py\" --event stop || python3 ...",
   "shell": true, "timeoutMs": 30000 }] }],
"UserPromptSubmit": [{ "hooks": [{ "type": "command",
   "command": "python \".../autocontinue_hook.py\" --event user-prompt || python3 ...",
   "shell": true, "timeoutMs": 15000 }] }]
```

* hook 从 stdin 读 JSON，向 stdout 写 JSON；**不输出 = 不干预**。
* `Stop` 输入关键字段：`last_assistant_message`、`toolCallCount`、`stop_hook_active`、`transcript_path`、`session_id`、`turnId`。
* `UserPromptSubmit` 用于把「连续触发计数」清零（用户自己说话了，重新计数）。
* 退出码 2 在 Stop 下等价 `{"decision":"block","reason":<stderr>}`——**任何异常都必须 exit 0 且不输出**，否则会把错误信息当成续跑文本灌给模型。

### 2.3.2 宽限期 / 冷却 / 上限的落法

* **宽限期 3000ms**：仅在**判定为需要续跑**之后 `sleep(3)` 再输出 block —— 一轮结束时先立刻判定，不无条件阻塞 3 秒（否则不需要续跑时也会卡 3 秒）。
* **冷却 20000ms**：读状态文件 `lastContinueAt`，距今不足 20s 则不续跑（放行 Stop）。
* **最大连续触发 3 次**：状态文件 `consecutive`，每次续跑 +1，达到 3 则**发一次超限文本后清零并停**；`UserPromptSubmit` 时清零。
* 以上计数按 `session_id` 分桶，避免多会话互相污染。

### 2.3.3 判定表（一轮结束时按序判定，命中即用）

| 序 | 条件 | 文本 |
| --- | --- | --- |
| 1 | `stop_hook_active` 为真且已连续触发 ≥ MAX_CONSECUTIVE | 超限文本（#2 = `继续`），随后停 |
| 2 | 检测到重复动作循环（loopguard） | #9 循环提示文 |
| 3 | `finishReason == "max_output_tokens"`（归一化 `length`） | #3 = `继续` |
| 4 | 本轮无任何可见输出与工具调用（`output_tokens==0` 且无 assistant 文本） | #4 = `继续` |
| 5 | 仅输出推理即结束（`reasoning_tokens>0`，无可见文本、无工具调用） | #5 长文本 |
| 6 | 上一轮被中断/取消（`status in (cancelled, error)`） | #1 = `继续` |
| 7 | 其他（正常完成） | #6 = `继续` |

**模式门控（`sessions[sid].mode` / `settings.defaultMode`）**：
* `recover`（默认）：只续跑失败/中断/超限/静默回合；第 7 行**不续跑**。
* `loop`：第 7 行按自主循环续跑；正常完成的接力**不计入连续上限、不受冷却约束**。
* `off`：本会话完全关闭（含循环守卫）。
* `settings.resumeSilentTurns=false` → 第 4/5 行不续跑；`settings.guardTools=false` → 不追加护栏文；
  `settings.loopGuard=false` → 不检测第 2 行。

护栏文追加（#7 / #8）：解析 `transcript_path` 的最后一次工具调用 ——
* 有 tool_use 但无对应 tool_result → 追加 #7（`{tool}` = 工具名）；
* 有 tool_use 且 result 成功 → 追加 #8（`{tool}`、`{result}` = 结果摘要，截断 ≤ 300 字符）。
最终文本 = 续跑文本 + `\n\n` + 护栏文（无护栏文则不加）。

### 2.3.4 崩溃恢复（渲染层唯一需要「发送」的地方）

`zcode-pilot.js` 在每轮进行中把「在途轮次」写进状态文件 `journal`；启动时若发现 `journal` 里有未收尾的轮次且当前会话空闲，则：
1. 用**已在本仓库验证过的五级写回**（见 `zcode-enhance-prompt.js` 的 `writeText`：React Fiber `editorApiRef.setText` → Lexical `parseEditorState/setEditorState` → 合成 `paste` 事件 → `execCommand('insertText')` → 原生 setter + InputEvent 链）把续跑文本写进 composer；
2. 点击 `[data-testid="v4-composer-send"]`（缺失时回退 `[data-testid="v4-composer-send"]` 的父按钮 / 表单提交）；
3. 校验：1.5s 内出现新的流式活动才算成功，否则重试 1 次，再失败则只提示不重试。
* 该路径**只在崩溃恢复时使用**；正常续跑一律走 Stop hook。
* **「同一轮」的判定必须比 `turnId`，绝不能比对象身份**：状态文件是唯一权威，渲染层每次
  轮询都会把 `journal` 整体换成 IPC 返回的副本（对象身份必变）。比身份会把同一轮误判成
  「已被新轮次接管」→ 校验窗口之后既不重试也不收尾，台账永久滞留，下次启动还会误发「继续」。
  回归用例：`tests/pilot_mount_smoke.js`（场景 3a/3b/3c，3c 是证明取消真的生效的对照组）。

### 2.3.5 设置页侧边 tab（`zcode-pilot.js` 注入）

设置页 DOM 锚点（ZCode 3.16.x 实测）：

| 元素 | 选择器 |
| --- | --- |
| 设置页根 | `[data-testid="settings-page"]` |
| 侧边导航 | `aside nav`（原生项带 `[data-settings-section-nav]`） |
| 内容面板 | `[data-settings-panel-frame]` |
| 注入的 tab | `[data-zpilot-settings-nav]`（`data-settings-section-nav="pilot"`） |
| 注入的面板 | `[data-zpilot-settings-panel]`（绝对定位覆盖内容区） |

* 点击原生侧边项 → 收起注入面板；React 重渲染把注入节点摘掉 → 1s 巡检自动补回。
* 面板只写 `settings`，**不改插件配置页的 `enabled` 总开关**；总开关仍由插件配置页托管。
* 输入框开关只写 `sessionMode: {id, mode}`，主进程 handler 落到 `sessions[id].mode`；
  其他会话的 `mode/consecutive` 原样保留。

### 2.3.6 TurnError 兜底（渲染层，2026-11-05 新增）

**结构性事实**：内核 `zcode.cjs` 里 `runStopHooks` 只有**一个**调用点，位于模型循环的
成功收尾分支（`turnMachine.complete(..., "success")`）。provider 流中断
（如 `upstream_stream_read_error`）、SSE JSON 解析失败、上游 200 + error 等
`TurnError` 会直接 emit `TurnError` 并抛错，**不会进入 Stop hook**。
因此「失败轮次自动继续」必须由渲染层补发；这是官方 hook 的能力盲区，
不是 hook 判定漏了一条。

检测与执行（`zcode-pilot.js`）：

* 事件流 `row.kind === "turnHeader" && row.state === "failed"` 触发；同一 `turnId`
  只处理一次（防同轮多次 upsert 连发）；`completedInterrupted` = 用户主动停止，**不接力**。
* 触发前按序校验（任一不满足即放弃，并在 `__zpilotDiag.failedTurn.reason` 留痕）：
  `stateReady`/桥存在 → 有 session → `sid === 当前 DOM 会话` → 会话未关/未暂停 →
  `settings.resumeFailedTurns !== false` → 当前不在流式 → `origin === "userInput"` →
  `executionKind` 为 `agent`（或缺失）→ 连续次数未达 `maxConsecutive` → 冷却已过。
* 通过后等 `graceMs`，再用 §2.3.4 同一套五级写回 + `v4-composer-send` 发送
  `settings.continueTextInterrupted`（默认 #1 `继续`）；1.5s 内无新流式活动则重试，
  单个 `turnId` 最多 2 次发送尝试。
* 计数：成功发送后按 `session_id` 记入 `localStorage["zpilot-error-streak"]`
  （`{count,lastAt}`，不入状态文件，避免与 hook 的 `consecutive` 抢写）；
  `completedSuccess` 或真人 `userInput`（`origin === "realUser"`）时清零。
* 用户在这几秒内自己发消息/切会话 → `lastTurnBySid` 变化，兜底自动取消，
  绝不把「继续」盖到新输入上。

> 该兜底依赖渲染层脚本注入。**Stop hook 本身不依赖 asar**，客户端升级后仍然存活；
> 失败轮次兜底则必须等插件重新注入（完全退出后由看护写入）后才生效。


## 3. 默认计时与护栏参数（可被 settings 覆盖）

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `GRACE_MS` | `3000` | 判定需要续跑后、发出续跑前的等待（见 §2.3.2） |
| `COOLDOWN_MS` | `20000` | 两次自动继续之间的最小间隔 |
| `MAX_CONSECUTIVE` | `3` | 最大连续自动触发次数（超过即发超限文本并停） |

> 以上为**默认值**，设置页可分别覆盖 `graceMs` / `cooldownMs` / `maxConsecutive`。
> 自主循环的正常接力不受冷却与连续上限约束（与 dsh-client-auto-continue 一致）。

## 4. 续跑文本（唯一文案表）

占位符：`{tool}`、`{result}`。所有文本共用同一套占位符替换（`支持相同占位符`）。

| # | 场景 | 文本 |
| --- | --- | --- |
| 1 | 中断后自动发送 | `继续` |
| 2 | 超限时 | `继续` |
| 3 | 输出 token 上限触发 | `继续` |
| 4 | 无输出回合 | `继续` |
| 5 | 仅输出推理即结束 | `你上一轮只输出内部推理，无回复也无工具调用，用户什么都没看到。每一轮须以工具调用或可见回复结束。` |
| 6 | 自主循环续跑 | `继续` |
| 7 | 结果未确认护栏（附于继续文后） | `上一步工具「{tool}」可能未完成，先确认状态再继续，勿重复执行` |
| 8 | 工具已成功护栏（附于继续文后） | `上一步工具「{tool}」已完成，结果:{result}。勿重复执行，直接继续` |
| 9 | 循环提示文（打断后重启运行） | `检测到循环，停止重复刚才动作，换方式继续` |

拼装规则：`最终文本 = 续跑文本`（1/2/3/4/6 之一，或 5、9）+ 可选换行 + 护栏文（7 或 8）。
护栏文按最近一次工具调用的结局二选一：结果未确认 → 7；已成功 → 8。

## 5. UI 落点

| 元素 | 落点 | 说明 |
| --- | --- | --- |
| 自动继续开关 | composer 工具条中 `[data-testid="chat-mode-select-trigger"]` **紧邻右侧**；锚点尚未渲染时退化到父行末尾并标记「待搬回」 | 必须是可点击 toggle，状态即时生效。「已在右侧」按 `previousElementSibling === trigger` **严格相邻**判定，宽松的同父下标比较会把「漂到行尾」误判成合规（实测缺陷，2026-10-29 CDP） |
| 设置页侧边 tab | `[data-testid="settings-page"]` 的 `aside nav` 末尾「扩展」分组 | 独立「ZCode Pilot」tab；点击后在 `[data-settings-panel-frame]` 内覆盖显示设置表单。只写 `settings`，不碰插件配置页总开关 |
| ~~开关状态同步显示~~ | **已移除**（用户要求）：不再往会话顶部插状态框 | 状态只有开关自身一处显示；插回去就是「被误认成官方控件、挡住标题行」的回归，`[data-zpilot-status]` 不得再出现 |
| TPS 遥测条 | **固定**在输入框下方（`composer-below`），**位置不可更改** | 左右双框：左框 `N轮M步 · Xtok/s`（点击看会话统计），右框 `总 Token · 缓存命中`（点击看 Token 用量）；右键切位置整套下线，历史偏好 `ztps-pos` 启动时清除 |

状态显示优先级（只有开关一处产出）：
`!enabled` → `off`；否则 `paused` → `paused`；否则按当前会话 `sessions[sid].mode`：
`off` → `off`、`loop` → `loop`、其余 → `on`。
即「配置页关闭保存」显示为**已关闭**（比暂停更强）；输入框开关只影响当前会话，其他对话各自独立。

## 6. 写者分工（advisory，勿越界）

| 写者 | 独占写域 |
| --- | --- |
| lead | `docs/CONTRACT.md`、`tools/*`、`assets/*`、`README.md`、`NOTICE.md`、`marketplace.json`、`.zcode-plugin/plugin.json` |
| js-tps | `skills/zcode-pilot/scripts/zcode-tps.js` |
| js-pilot | `skills/zcode-pilot/scripts/zcode-pilot.js`（新建） |
| py-core | `skills/zcode-pilot/scripts/zcode_patcher.py`、`sync.py`、`apply_after_exit.py`、`doctor.py`、`restore_clean.py`、`hooks/hooks.json`、删除 `zcode-thought-slider.js` |
| docs-skill | `skills/zcode-pilot/SKILL.md`、`commands/*.md`、`bootstrap.py`、`autopilot.py`、`.github/workflows/ci.yml` |
| tests | `tests/*` |

`tests/` 与 `docs/` 的更新必须在 py-core 与 js-pilot 落地之后进行（依赖最终形态）。
