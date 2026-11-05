#!/bin/sh
# Stop hook：每轮结束后检查是否需要会话检查点（时间/体积阈值）。
# 不达阈值直接退出；达阈值才复制 transcript 并种会话树。
# pwd 在 Git Bash 里返回 /f/...，优先用 pwd -W 拿 Windows 路径
ROOT="$(cd "$(dirname "$0")/../.." && pwd -W 2>/dev/null)"
[ -n "$ROOT" ] || ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export TREES_HOME="${TREES_HOME:-$ROOT/forest}"
CLI="${TREES_CLI:-$ROOT/tools/bin/cli.js}"
[ -f "$CLI" ] || exit 0
TREES_CLI="$CLI" node "$ROOT/tools/checkpoint.mjs" >/dev/null 2>&1
exit 0
