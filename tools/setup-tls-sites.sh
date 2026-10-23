#!/usr/bin/env bash
# 主站域名上 HTTPS：
#   ykdesign.top / www.ykdesign.top  -> 作品集（根）+ /dianzhan/ 监控平台
#   lichu.ykdesign.top               -> 监控平台
# 用法：node tools/remote-run.js --file tools/setup-tls-sites.sh
set -e

echo "== 1/4 申请证书（三个域名一张证书）=="
sudo certbot certonly --webroot -w /var/www/html \
  -d ykdesign.top -d www.ykdesign.top -d lichu.ykdesign.top \
  --non-interactive --agree-tos --keep-until-expiring
sudo certbot certificates | grep -E 'Certificate Name|Domains|Expiry' | head -10

echo
echo "== 2/4 写 ykdesign.top 站点（80 跳转 + 443）=="
sudo tee /etc/nginx/sites-available/ykdesign.top >/dev/null <<'EOF'
server {
    listen 80;
    server_name ykdesign.top www.ykdesign.top;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
        default_type text/plain;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl;
    server_name ykdesign.top www.ykdesign.top;

    ssl_certificate     /etc/letsencrypt/live/ykdesign.top/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ykdesign.top/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 10m;

    root /var/www/portfolio;
    index index.html;

    # 监控平台（deploy-site.js 部署到 /var/www/lichu）
    location = /dianzhan { return 301 /dianzhan/; }
    location /dianzhan/ {
        alias /var/www/lichu/;
        index index.html;
    }

    location / {
        try_files $uri $uri/ =404;
    }
}
EOF

echo "== 3/4 写 lichu.ykdesign.top 站点（80 跳转 + 443）=="
sudo tee /etc/nginx/sites-available/lichu.ykdesign.top >/dev/null <<'EOF'
server {
    listen 80;
    server_name lichu.ykdesign.top;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
        default_type text/plain;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl;
    server_name lichu.ykdesign.top;

    ssl_certificate     /etc/letsencrypt/live/ykdesign.top/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ykdesign.top/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 10m;

    root /var/www/lichu;
    index index.html;

    location / {
        try_files $uri $uri/ =404;
    }
}
EOF

echo "== 4/4 校验并重载 =="
sudo nginx -t
sudo systemctl reload nginx
echo
echo "--- 本机 https 自测 ---"
curl -s -o /dev/null -w 'https://ykdesign.top/          -> %{http_code}\n' --resolve ykdesign.top:443:127.0.0.1 https://ykdesign.top/
curl -s -o /dev/null -w 'https://www.ykdesign.top/      -> %{http_code}\n' --resolve www.ykdesign.top:443:127.0.0.1 https://www.ykdesign.top/
curl -s -o /dev/null -w 'https://ykdesign.top/dianzhan/ -> %{http_code}\n' --resolve ykdesign.top:443:127.0.0.1 https://ykdesign.top/dianzhan/
curl -s -o /dev/null -w 'https://lichu.ykdesign.top/    -> %{http_code}\n' --resolve lichu.ykdesign.top:443:127.0.0.1 https://lichu.ykdesign.top/
curl -s -o /dev/null -w 'http://ykdesign.top/ 跳转 -> %{http_code} %{redirect_url}\n' -H 'Host: ykdesign.top' http://127.0.0.1/
echo
echo "--- 证书信息 ---"
echo | openssl s_client -connect 127.0.0.1:443 -servername ykdesign.top 2>/dev/null | openssl x509 -noout -subject -dates -ext subjectAltName
echo "== 完成 =="
