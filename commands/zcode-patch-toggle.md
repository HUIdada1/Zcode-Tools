---
description: 逐项查看/切换 zcode-pilot 的注入功能开关
---

加载本插件自带的 `zcode-pilot` 技能（`${CLAUDE_PLUGIN_ROOT}/skills/zcode-pilot/SKILL.md`；若该变量未展开，就按插件安装目录下的同名路径读取），然后按下面的流程帮用户逐项开关补丁功能。

**开关的存储位置**：`~/.zcode/cli/config.json` 的 `plugins.options["zcode-pilot@<市场名>"]`（`@` 后面按**实际安装的市场**填；独立市场后本机是 `zcode-pilot`）。键名与功能对应：

| 键 | 功能 | 生效时机 |
|---|---|---|
| `reasoning_config` | 思考档位配置（3.14+ 原生 optionSpecs） | ZCode 退出时自动应用，再启动才生效 |
| `usage_chart` | 用量页去截断 | ZCode 退出时自动应用，再启动才生效 |
| `model_width` | 模型弹窗加宽 | ZCode 退出时自动应用，再启动才生效 |
| `tps_footer` | TPS 状态栏 | ZCode 退出时自动应用，再启动才生效 |
| `auto_continue` | 自动继续 + 循环守卫 | ZCode 退出时自动应用，再启动才生效；输入框开关只影响当前会话；**关闭并保存会全局暂停并作废排队中的继续**；设置页有独立「ZCode Pilot」侧边 tab |
| `enhance_prompt` | 增强提示词按钮 | ZCode 退出时自动应用，再启动才生效 |
| `model_puller` | 设置页模型拉取按钮 | ZCode 退出时自动应用，再启动才生效 |
| `core_patch` | 思考档位内核补丁（仅 ≤3.11.2，3.14+ 请保持关闭） | ZCode 退出时自动应用，再启动才生效 |

**流程**：

1. 读 `~/.zcode/cli/config.json`，取出上述键的当前值（缺失表示"用户未表态"，插件不会去动它）。
2. 同时跑 `python "<skill目录>/scripts/zcode_patcher.py" <对应参数> --check` 拿到**客户端实际注入状态**，把"配置值 / 实际状态"两列一起用中文表格展示给用户。
   注意 3.14+ 下 `core_patch` 对应的内核补丁会报「本补丁不适用」，这是预期；档位是否生效要看
   `--reasoning-config --check`（它列出每个模型当前配了几档、来源是 config 还是已在界面手动配置）。
3. 问用户要改哪个键、改成什么。用户明确指定后再改。
4. 改配置：**整份读入 → 只增改目标键 → 写回**，保持 JSON 缩进与其余内容不变；`plugins.options` 或插件 id 那一层不存在时按需创建。**不要动 `enabledPlugins` 等其他字段。**
5. 告诉用户生效时机（见上表）：**8 项都要等 ZCode 退出后由看护写入，再启动才生效**（zcode_patcher.py 在客户端运行时会直接拒绝写入，而会话钩子必然在运行中触发，所以「会话内立即生效」这条路走不通）。
   例外：`auto_continue` 的**运行态**开关写在 `~/.zcode/pilot/state.json`（只写一个小 JSON、不碰 app.asar），会话启动时即刻生效；关闭并保存会写入 `enabled=false`、`paused=true` 并把 `cancelToken` +1 —— **全局暂停并作废已排队的继续**，同时让循环守卫同步失效。
6. 若用户想立刻生效而不等下次会话，可以按技能里的「标准执行流程」直接执行对应命令（**前提是 ZCode 已完全退出**）。

**注意**：改 `config.json` 前建议先备份一份（`config.json.bak`）；若 ZCode 正在运行且用户在设置页保存过供应商配置，有被回写的可能，改完提示用户确认一次。
