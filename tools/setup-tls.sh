#!/usr/bin/env bash
# ============================================================
# 力储未来 · 阶段 B：给 mqtt.ykdesign.top 签证书 + 开放 443
#   · 80 端口保留 ACME 校验目录（证书自动续期用）
#   · 443 反代本机 mosquitto 的 WebSocket 8083 → wss://mqtt.ykdesign.top/mqtt
#   需要 sudo 权限（ubuntu 用户已配置免密 sudo）
# ============================================================
set -e
export DEBIAN_FRONTEND=noninteractive

DOMAIN=mqtt.ykdesign.top
WEBROOT=/var/www/html

echo "== 1/5 确认 certbot =="
if ! command -v certbot >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq certbot
fi
certbot --version

echo "== 2/5 准备 webroot，80 端口先只提供校验目录 =="
sudo mkdir -p "$WEBROOT/.well-known/acme-challenge"
sudo tee /etc/nginx/sites-available/$DOMAIN >/dev/null <<EOF
server {
    listen 80;
    server_name $DOMAIN;

    location /.well-known/acme-challenge/ {
        root $WEBROOT;
        default_type text/plain;
    }

    location / {
        default_type text/plain;
        return 200 'lichu mqtt gateway ok\n';
    }
}
EOF
sudo nginx -t
sudo systemctl reload nginx

echo "== 3/5 申请证书（webroot 方式，不中断 80 端口）=="
sudo certbot certonly --webroot -w "$WEBROOT" -d "$DOMAIN" \
  --non-interactive --agree-tos --register-unsafely-without-email --keep-until-expiring

echo "== 4/5 写正式站点配置：80 跳转 + 443 反代 wss =="
sudo tee /etc/nginx/sites-available/$DOMAIN >/dev/null <<EOF
server {
    listen 80;
    server_name $DOMAIN;

    location /.well-known/acme-challenge/ {
        root $WEBROOT;
        default_type text/plain;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl;
    server_name $DOMAIN;

    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 10m;

    # 网页接入：wss://mqtt.ykdesign.top/mqtt
    location /mqtt {
        proxy_pass http://127.0.0.1:8083;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    location / {
        default_type text/plain;
        return 200 'lichu mqtt gateway ok\n';
    }
}
EOF
sudo nginx -t
sudo systemctl reload nginx

echo "== 5/5 自测 =="
echo -n "本机 https 站点:  "; curl -sk -o /dev/null -w 'HTTP %{http_code}\n' -H "Host: $DOMAIN" https://127.0.0.1/
echo -n "本机 /mqtt 反代:  "; curl -s -o /dev/null -w 'HTTP %{http_code}\n' http://127.0.0.1:8083/mqtt
echo "监听端口："
ss -lnt | grep -E ':1883|:8083|:80 |:443' || true
echo "证书到期时间："
sudo openssl x509 -enddate -noout -in /etc/letsencrypt/live/$DOMAIN/fullchain.pem
echo "== 完成 =="
