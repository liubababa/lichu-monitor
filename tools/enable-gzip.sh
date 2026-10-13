#!/usr/bin/env bash
# 打开 nginx 的 gzip：原来只写了 `gzip on;`，而 gzip_types 是注释状态，
# nginx 默认只压 text/html —— js/css/图片全是裸传（three.min.js 603KB、echarts 1MB）。
# 用法：node tools/remote-run.js --file tools/enable-gzip.sh
set -e

CONF=/etc/nginx/nginx.conf
sudo cp "$CONF" "$CONF.bak.gzip.$(date +%Y%m%d%H%M)"
echo "已备份 $CONF"

if sudo grep -qE '^[[:space:]]*gzip_types' "$CONF"; then
  echo "(已存在 gzip_types，跳过写入)"
else
  sudo sed -i '/^[[:space:]]*gzip on;/a \\tgzip_vary on;\n\tgzip_proxied any;\n\tgzip_comp_level 6;\n\tgzip_min_length 1024;\n\tgzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript image/svg+xml;' "$CONF"
  echo "已写入 gzip_types 等配置"
fi

echo "--- 配置检查 ---"
sudo nginx -t
sudo systemctl reload nginx
echo "已 reload"

echo
echo "--- 实测（带 Accept-Encoding: gzip 请求）---"
for f in /dianzhan/libs/three.min.js /dianzhan/libs/echarts.min.js /dianzhan/libs/mqtt.min.js /dianzhan/css/style.css /dianzhan/js/solar-scene3d.js /dianzhan/; do
  hdr=$(curl -s -o /dev/null -D - -H 'Accept-Encoding: gzip' "https://mqtt.ykdesign.top$f" | tr -d '\r')
  len=$(echo "$hdr" | awk 'tolower($1)=="content-length:"{l=$2} END{print l}')
  enc=$(echo "$hdr" | awk 'tolower($1)=="content-encoding:"{e=$2} END{print e}')
  printf '  %-38s %8s 字节  压缩=%s\n' "$f" "${len:-?}" "${enc:-无}"
done
