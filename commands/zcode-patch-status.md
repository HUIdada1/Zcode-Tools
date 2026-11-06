---
description: 只读检查 ZCode 客户端各补丁的注入状态（不修改任何文件）
---

加载本插件自带的 `zcode-pilot` 技能（`${CLAUDE_PLUGIN_ROOT}/skills/zcode-pilot/SKILL.md`；若该变量未展开，就按插件安装目录下的同名路径读取），按其「只读核实」步骤对本机 ZCode 安装执行全部检查命令：

```bash
python "<skill目录>/scripts/zcode_patcher.py" --reasoning-config --check   # 3.14+ 档位配置状态
python "<skill目录>/scripts/zcode_patcher.py" --check                       # 内核补丁（3.14+ 会提示"不需要本补丁"）
python "<skill目录>/scripts/zcode_patcher.py" --usage-chart --check
python "<skill目录>/scripts/zcode_patcher.py" --tps-footer --check
python "<skill目录>/scripts/zcode_patcher.py" --auto-continue --check
python "<skill目录>/scripts/zcode_patcher.py" --enhance-prompt --check
python "<skill目录>/scripts/zcode_patcher.py" --model-puller --check
```

要求：

- **纯只读**，不要执行任何写入或 `--revert`。
- 先确认目标 ZCode 版本，并按 skill 里的「版本现状」表判断哪些补丁适用（3.14.x 下思考等级内核补丁已过时，档位改走 `optionSpecs`）。
- 用中文汇总成一张表：每个补丁「已打 / 未打 / 锚点失配」，失配时给出脚本报告的原因，不要绕过脚本的拒绝结论。
