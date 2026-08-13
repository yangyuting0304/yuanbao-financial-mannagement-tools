#!/usr/bin/env bash
# 前台运行 server.js —— 给宝塔 Supervisor / 进程守护管理器用
# 不要手动 ./run.sh，它会被 Supervisor 自动拉起
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# 金十 token 优先级: 环境变量 > server.js 内置
if [ -n "${JIN10_TOKEN:-}" ]; then
  export JIN10_TOKEN
fi

exec node server.js
