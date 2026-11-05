#!/bin/sh
# PreCompact hook：上下文快满、压缩前强制记录一颗会话树。
# 与 SessionEnd 的区别：这是中途检查点，会记录当时已经发生的对话；
# 同一会话多次压缩会生成多个检查点（材料不同，去重按内容哈希，不会误合并）。
# pwd 在 Git Bash 里返回 /f/...，优先用 pwd -W 拿 Windows 路径
ROOT="$(cd "$(dirname "$0")/../.." && pwd -W 2>/dev/null)"
[ -n "$ROOT" ] || ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export TREES_HOME="${TREES_HOME:-$ROOT/forest}"
CLI="${TREES_CLI:-$ROOT/tools/bin/cli.js}"
[ -f "$CLI" ] || exit 0

LOG="${TREES_SESSION_LOG:-$HOME/.trees/precompact.log}"
mkdir -p "${LOG%/*}" 2>/dev/null

# stdout 保持干净；跳过原因写日志
{
  printf '[%s] ' "$(date '+%Y-%m-%d %H:%M:%S')"
  node "$CLI" auto --hook --force 2>&1
} >> "$LOG" 2>&1

exit 0
