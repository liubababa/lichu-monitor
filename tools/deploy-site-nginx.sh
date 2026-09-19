#!/usr/bin/env bash
# 把网页挂到自己的服务器上：lichu.ykdesign.top -> /var/www/lichu
# 另外在 mqtt 站点下加一个临时预览路径 /dianzhan/（DNS 生效前也能看）
set -e
DOMAIN=lichu.ykdesign.top
ROOT=/var/www/lichu

echo "== 1/3 写站点配置（先只开 80，证书等 DNS 生效后再签）=="
sudo tee /etc/nginx/sites-available/$DOMAIN >/dev/null <<EOF
server {
    listen 80;
    server_name $DOMAIN;

    root $ROOT;
    index index.html;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
        default_type text/plain;
    }

    location / {
        try_files \$uri \$uri/ =404;
    }
}
EOF
sudo ln -sf /etc/nginx/sites-available/$DOMAIN /etc/nginx/sites-enabled/$DOMAIN

echo "== 2/3 在 mqtt 站点加临时预览路径 /dianzhan/ =="
if ! sudo grep -q 'location /dianzhan/' /etc/nginx/sites-available/mqtt.ykdesign.top; then
  sudo python3 - <<'PY'
p = '/etc/nginx/sites-available/mqtt.ykdesign.top'
s = open(p, encoding='utf-8').read()
add = """
    # 临时预览：网页本体（正式地址 lichu.ykdesign.top）
    location /dianzhan/ {
        alias /var/www/lichu/;
        index index.html;
    }
"""
marker = '    location / {\n        default_type text/plain;'
i = s.rindex(marker)
s = s[:i] + add.lstrip('\n') + '\n' + s[i:]
open(p, 'w', encoding='utf-8').write(s)
print('已插入 /dianzhan/ 预览路径')
PY
else
  echo "（已存在，跳过）"
fi

echo "== 3/3 校验并重载 =="
sudo nginx -t
sudo systemctl reload nginx
echo "监听/站点："
ls -l /etc/nginx/sites-enabled/
curl -s -o /dev/null -w '本机旧入口 /mqtt 站点 HTTP %{http_code}\n' -H "Host: mqtt.ykdesign.top" http://127.0.0.1/
curl -s -o /dev/null -w '本机预览 /dianzhan/ HTTP %{http_code}\n' -H "Host: mqtt.ykdesign.top" http://127.0.0.1/dianzhan/
curl -s -o /dev/null -w '本机新站点（Host 写死）HTTP %{http_code}\n' -H "Host: $DOMAIN" http://127.0.0.1/
echo "== 完成 =="
