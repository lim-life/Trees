#!/bin/sh
# SessionEnd hook：会话结束时把这次对话里有复用价值的判断播进库。
# 没开自动回写、没配模型、对话太短、或这个会话已经播过，都会安静跳过。
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export TREES_HOME="${TREES_HOME:-$ROOT/forest}"
CLI="${TREES_CLI:-$ROOT/tools/bin/cli.js}"
[ -f "$CLI" ] || exit 0
node "$CLI" auto --hook >/dev/null 2>&1
exit 0
