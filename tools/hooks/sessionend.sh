#!/bin/sh
# SessionEnd hook：会话结束时把这次对话里有复用价值的判断播进库。
# 没开自动回写、没配模型、对话太短、或这个会话已经播过，都会跳过 ——
# 但**跳过原因要落到日志里**，否则失败一次你永远不知道。
# pwd 在 Git Bash 里返回 /f/... 这种 MSYS 路径，直接给 node 会变成 F:\...
# 所以优先用 pwd -W 拿 Windows 路径
ROOT="$(cd "$(dirname "$0")/../.." && pwd -W 2>/dev/null)"
[ -n "$ROOT" ] || ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export TREES_HOME="${TREES_HOME:-$ROOT/forest}"
CLI="${TREES_CLI:-$ROOT/tools/bin/cli.js}"
[ -f "$CLI" ] || exit 0

LOG="${TREES_SESSION_LOG:-$HOME/.trees/sessionend.log}"
mkdir -p "${LOG%/*}" 2>/dev/null

# stdout 保持干净（hook 输出可能被回注），一切写进日志
{
  printf '[%s] ' "$(date '+%Y-%m-%d %H:%M:%S')"
  node "$CLI" auto --hook 2>&1
} >> "$LOG" 2>&1

exit 0
