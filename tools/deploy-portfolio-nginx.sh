#!/usr/bin/env bash
# 把 ykdesign.top 主站（作品集）搬到自己的服务器：
#   /var/www/portfolio  <- GitHub 仓库 liubababa.github.io（浅克隆，--depth 1）
#   nginx: ykdesign.top / www.ykdesign.top  -> 作品集
#          ykdesign.top/dianzhan/           -> /var/www/lichu（监控平台，deploy-site.js 部署）
# 用法：node tools/remote-run.js --file tools/deploy-portfolio-nginx.sh
# 更新作品集：ssh 上服务器执行  sudo git -C /var/www/portfolio pull
set -e

echo "== 1/3 克隆作品集 =="
if [ ! -d /var/www/portfolio/.git ]; then
  sudo git clone --depth 1 https://github.com/liubababa/liubababa.github.io /var/www/portfolio
else
  echo "(已存在，执行增量更新)"
  sudo git -C /var/www/portfolio pull --depth 1
fi
sudo du -sh /var/www/portfolio
ls /var/www/portfolio | head -20

echo "== 2/3 写 nginx 站点 ykdesign.top =="
sudo tee /etc/nginx/sites-available/ykdesign.top >/dev/null <<'EOF'
server {
    listen 80;
    server_name ykdesign.top www.ykdesign.top;

    root /var/www/portfolio;
    index index.html;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
        default_type text/plain;
    }

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
sudo ln -sf /etc/nginx/sites-available/ykdesign.top /etc/nginx/sites-enabled/ykdesign.top

echo "== 3/3 校验并重载 =="
sudo nginx -t
sudo systemctl reload nginx
echo "--- 启用中的站点 ---"
ls -l /etc/nginx/sites-enabled/
echo "--- 本机自测（Host 头）---"
curl -s -o /dev/null -w 'ykdesign.top  /          -> %{http_code}\n' -H 'Host: ykdesign.top' http://127.0.0.1/
curl -s -o /dev/null -w 'www           /          -> %{http_code}\n' -H 'Host: www.ykdesign.top' http://127.0.0.1/
curl -s -o /dev/null -w 'ykdesign.top  /dianzhan/ -> %{http_code}\n' -H 'Host: ykdesign.top' http://127.0.0.1/dianzhan/
curl -s -o /dev/null -w 'lichu         /          -> %{http_code}\n' -H 'Host: lichu.ykdesign.top' http://127.0.0.1/
curl -s -o /dev/null -w '作品集图片抽查 assets/images/portrait.jpg -> %{http_code}\n' -H 'Host: ykdesign.top' http://127.0.0.1/assets/images/portrait.jpg
echo "== 完成 =="
