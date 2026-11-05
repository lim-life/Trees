#!/bin/sh
# UserPromptSubmit hook：每条用户消息进来时先做一次轻量召回。
# 没有命中就什么都不输出（不制造噪音）；有命中才把种子注进这一轮的上下文。
# pwd 在 Git Bash 里返回 /f/...，优先用 pwd -W 拿 Windows 路径
ROOT="$(cd "$(dirname "$0")/../.." && pwd -W 2>/dev/null)"
[ -n "$ROOT" ] || ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export TREES_HOME="${TREES_HOME:-$ROOT/forest}"
CLI="${TREES_CLI:-$ROOT/tools/bin/cli.js}"
[ -f "$CLI" ] || exit 0
node "$CLI" hook-recall 2>/dev/null
exit 0
