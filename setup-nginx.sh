#!/bin/bash
# 元宝爱财 - 宝塔 Nginx 反向代理一键配置
# 用法：把本文件传到服务器 /www/wwwroot/120.24.240.129/yuanbao/ 后执行：
#   bash setup-nginx.sh

set -e

echo "===== 1. 检查本机 server.js 是否监听 18765 ====="
CODE=$(curl -s --max-time 5 http://127.0.0.1:18765/ -o /dev/null -w "%{http_code}" || echo "000")
if [ "$CODE" = "200" ]; then
  echo "✅ 本机 18765 正常监听 (HTTP $CODE)"
else
  echo "❌ 本机 18765 无响应 (HTTP $CODE)"
  echo "   请先确认宝塔「进程守护管理器」中 yuanbao-server 状态为 RUNNING"
  exit 1
fi

echo "===== 2. 定位宝塔 Nginx 网站配置文件 ====="
CONF=$(grep -rl "120.24.240.129" /www/server/panel/vhost/nginx/ 2>/dev/null | head -1)
if [ -z "$CONF" ]; then
  echo "❌ 未找到包含 120.24.240.129 的 Nginx 配置"
  echo "   请手动确认 /www/server/panel/vhost/nginx/ 下的配置文件名"
  exit 1
fi
echo "配置文件: $CONF"

echo "===== 3. 插入 /yuanbao/ 反向代理（如尚未配置）====="
if grep -q "location /yuanbao/" "$CONF"; then
  echo "ℹ️  已存在 /yuanbao/ 反代配置，跳过插入"
else
  python3 - "$CONF" <<'PY'
import sys
conf = sys.argv[1]
with open(conf) as f:
    c = f.read()
block = '''
    # 元宝爱财反向代理 (yuanbao)
    location /yuanbao/ {
        proxy_pass http://127.0.0.1:18765/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
'''
idx = c.rfind('}')
new = c[:idx] + block + "\n" + c[idx:]
with open(conf, 'w') as f:
    f.write(new)
print("✅ 已插入反向代理配置")
PY
fi

echo "===== 4. 测试并重载 Nginx ====="
NGINX=/www/server/nginx/sbin/nginx
if [ -x "$NGINX" ]; then
  $NGINX -t
  $NGINX -s reload
else
  echo "未找到 $NGINX，尝试 bt reload"
  bt reload
fi
echo "✅ Nginx 已重载"

echo "===== 5. 验证接口 ====="
sleep 1
curl -s "http://120.24.240.129/yuanbao/api/detail?secid=0.002384" -w "\nHTTP: %{http_code}\n" | head -c 200
echo
echo "===== 完成 ====="
echo "手机访问: http://120.24.240.129/yuanbao/"
