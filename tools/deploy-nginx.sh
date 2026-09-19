#!/usr/bin/env bash
# 阶段 A：配置 nginx 80 端口站点（mqtt.ykdesign.top），为证书申请做准备
set -e

echo "== 写 nginx 站点配置 =="
sudo tee /etc/nginx/sites-available/mqtt.ykdesign.top >/dev/null <<'EOF'
server {
    listen 80;
    server_name mqtt.ykdesign.top;
    location / {
        default_type text/plain;
        return 200 'lichu mqtt gateway ok\n';
    }
}
EOF

echo "== 启用站点，停用默认站点 =="
sudo ln -sf /etc/nginx/sites-available/mqtt.ykdesign.top /etc/nginx/sites-enabled/mqtt.ykdesign.top
sudo rm -f /etc/nginx/sites-enabled/default

echo "== 校验并重载 =="
sudo nginx -t
sudo systemctl reload nginx
echo "== 本机访问测试 =="
curl -s -o /dev/null -w 'HTTP %{http_code}\n' http://127.0.0.1/
curl -s -H 'Host: mqtt.ykdesign.top' http://127.0.0.1/ || true
echo "== 完成 =="
