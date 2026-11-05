# dsh-trees

Trees 的 DeepSeek Harness 适配器（Cordis 插件）。补上 DSH 没有的两个生命周期点：

| 时机 | 行为 | 对应 Claude Code |
|---|---|---|
| 每条用户消息的第一次 pre-step | `trees hook-recall` 召回 ≤3 颗 / ≤700 token，命中才注入 | UserPromptSubmit hook |
| 会话 disposed | 会话转 JSONL → `trees auto --transcript` 记录成会话树 | SessionEnd hook |

只记录、不播种。种子仍然只在项目 `finish` 或显式 `plant` 时产生。

## 安装

```bash
node tools/adapters/dsh-plugin/install.mjs --profile desktop
# 重启 DeepSeek Harness
```

安装器会（可逆，先备份）：

1. 复制插件到 `~/.dsh/profiles/<profile>/node_modules/dsh-trees`
2. 在 profile 的 `package.json` 登记 `file:` 依赖
3. 往 `cordis.patch.yml` 追加 `id: trees` 的 loader row

先用 `--dry-run` 看它会改什么。

## 配置

```yaml
- id: trees
  name: "dsh-trees"
  config:
    cli: "F:/项目/Trees/tools/bin/cli.js"   # 或全局 trees
    home: "F:/项目/Trees/forest"            # 留空则用 TREES_HOME/机器默认库
    limit: 3
    budget: 700
    recall: true
    record: true
```

## 排错

- 加载日志：`~/.trees/dsh-plugin.log`（含 `loaded ...` 一行）
- CLI 失败：同一日志里的 `cli fail ...`，不会中断 DSH 对话
- 装了插件后请停掉旧的 `tree-bridge`，否则同一会话可能被记录两次
  （`recorded.json` 只能按内容去重，两者转换文本不一定完全一致）
