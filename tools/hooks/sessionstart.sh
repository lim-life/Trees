#!/bin/sh
# SessionStart hook：把 Trees 索引带进新会话的上下文。
# 库是空的就什么都不说 —— 不制造噪音。
# 需要自定义位置时设 TREES_HOME / TREES_CLI。
# pwd 在 Git Bash 里返回 /f/... 这种 MSYS 路径，直接给 node 会变成 F:\...
# 所以优先用 pwd -W 拿 Windows 路径
ROOT="$(cd "$(dirname "$0")/../.." && pwd -W 2>/dev/null)"
[ -n "$ROOT" ] || ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export TREES_HOME="${TREES_HOME:-$ROOT/forest}"
CLI="${TREES_CLI:-$ROOT/tools/bin/cli.js}"
[ -f "$CLI" ] || exit 0
node "$CLI" index --print --if-any 2>/dev/null
node "$CLI" tip 2>/dev/null
exit 0
