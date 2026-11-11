---
description: 从备份精确还原 ZCode 客户端补丁
---

加载本插件自带的 `zcode-pilot` 技能（`${CLAUDE_PLUGIN_ROOT}/skills/zcode-pilot/SKILL.md`；若该变量未展开，就按插件安装目录下的同名路径读取），按用户点名的功能执行还原：

```bash
python "<skill目录>/scripts/zcp_patcher.py" --reasoning-config --revert   # 档位配置（3.14+）
python "<skill目录>/scripts/zcp_patcher.py" --usage-chart --revert
python "<skill目录>/scripts/zcp_patcher.py" --model-width --revert   # 已下线功能的残留清理（可选）
python "<skill目录>/scripts/zcp_patcher.py" --tps-footer --revert
python "<skill目录>/scripts/zcp_patcher.py" --auto-continue --revert
python "<skill目录>/scripts/zcp_patcher.py" --enhance-prompt --revert
python "<skill目录>/scripts/zcp_patcher.py" --model-puller --revert
python "<skill目录>/scripts/zcp_patcher.py" --revert        # 思考等级（仅 3.11.2 及更早）
```

要求：

- 先确认 ZCode 已**完全退出**——重打包级补丁（TPS / 自动继续 / 增强提示词 / 拉取按钮）还原会写 `app.asar`；
  脚本会预检进程，运行中直接拒绝（退出码 2）。
- 老用户客户端里历史注入的旧滑条残留（0.7.0 已移除的能力），用
  `python "<skill目录>/scripts/zcp_patcher.py" --cleanup-legacy` 一次性外科手术式摘除
  （只读检查加 `--check`；`zcp_sync.py` 常规流程会自动触发一次，通常无需手动执行）。
- 内核补丁还原前会校验备份指纹：若备份与当前内核不是同一版本（例如客户端升级过），脚本会**拒绝还原**
  并提示改用 `zcp_restore.py`——不要用 `--force` 绕过，那会把旧版内核盖回新客户端。
- 还原按外科手术式进行，不依赖整包备份；多个补丁共存时互不误伤，可按需只还原其中一个。
- 还原后提示用户重启 ZCode 确认已恢复原状。
- 若客户端已经异常到打不开，改用紧急整包还原：`python "<skill目录>/scripts/zcp_restore.py" --latest`（改文件前可先 `--backup` 存一份干净副本）。
