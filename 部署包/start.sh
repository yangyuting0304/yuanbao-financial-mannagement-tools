#!/usr/bin/env bash
set -euo pipefail

# ============================================================
#  元宝爱财 数据代理服务 - Linux 一键启动脚本
#  适用: 阿里云 / 腾讯云 / 任意 Linux 服务器
#  用法:
#    ./start.sh                       # 用 server.js 内置 token 启动
#    ./start.sh "你的金十token"        # 用命令行传入的 token (推荐, 不泄露硬编码)
#    JIN10_TOKEN=xxx ./start.sh       # 或用环境变量
# ============================================================

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

PORT=18765

echo "========================================"
echo "  元宝爱财 数据代理服务 启动器"
echo "  目录 : $DIR"
echo "  端口 : $PORT"
echo "========================================"

# 1) 检查 Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "❌ 未检测到 Node.js, 请先安装 (>= v18): https://nodejs.org/"
  exit 1
fi
echo "✅ node 版本: $(node -v) (需 >= v18)"

# 2) 端口占用检测与释放
if command -v lsof >/dev/null 2>&1; then
  if lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "⚠️  端口 $PORT 已被占用, 尝试终止已有进程..."
    lsof -iTCP:"$PORT" -sTCP:LISTEN -t | xargs -r kill -9 2>/dev/null || true
    sleep 1
  fi
elif command -v fuser >/dev/null 2>&1; then
  fuser -k "${PORT}/tcp" 2>/dev/null || true
  sleep 1
fi

# 3) 金十 token 来源 (公网暴露时强烈建议用环境变量/命令行, 避免硬编码泄露)
if [ -n "${1:-}" ]; then
  export JIN10_TOKEN="$1"
  echo "✅ 使用命令行传入的 JIN10_TOKEN"
elif [ -n "${JIN10_TOKEN:-}" ]; then
  echo "✅ 使用环境变量 JIN10_TOKEN"
else
  echo "ℹ️  未提供 JIN10_TOKEN, 将使用 server.js 内置 token (公网暴露有泄露风险)"
fi

# 4) 后台启动
LOG="$DIR/server.log"
echo "🚀 后台启动 server.js (日志: $LOG)"
nohup node server.js > "$LOG" 2>&1 &
PID=$!
echo "   PID=$PID"

# 5) 健康检查
sleep 2
if curl -s -m 5 "http://127.0.0.1:${PORT}/" -o /dev/null; then
  echo "✅ 启动成功! 访问地址:"
  echo "   公网/局域网: http://<你的服务器公网IP>:${PORT}/"
  echo "   手机(流量或WiFi): 直接打开上面的公网地址即可"
else
  echo "❌ 启动可能失败, 最近日志:"
  tail -n 20 "$LOG" || true
  exit 1
fi
