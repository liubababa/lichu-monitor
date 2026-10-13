#!/usr/bin/env bash
# 让 /dianzhan/ 的入口 HTML 每次都回源校验（Cache-Control: no-cache）。
#
# 为什么：HTML 自己不带版本号，浏览器按启发式缓存会一直用旧的那份，
# 连带里面的 <script src="js/xxx.js?v=旧日期"> 也停在旧值 —— 于是改了代码、
# 甚至提了版本号，页面上还是老样子。html 改成每次校验后，版本号一变就能拿到新文件。
# js / css 不动：它们靠 ?v= 版本号，继续走长缓存。
#
# 用法：node tools/remote-run.js --file tools/enable-html-nocache.sh
set -e

CONF=/etc/nginx/sites-enabled/mqtt.ykdesign.top
# 备份要放到 nginx 不加载的目录：sites-enabled/* 通配会把 .bak 也当配置读进来，
# 于是出现 "conflicting server name" 警告
sudo mkdir -p /etc/nginx/backups
sudo cp "$CONF" "/etc/nginx/backups/mqtt.ykdesign.top.bak.nocache.$(date +%Y%m%d%H%M)"
echo "已备份到 /etc/nginx/backups/"

if sudo grep -q 'no-cache' "$CONF"; then
  echo "(已有 no-cache 规则，跳过写入)"
else
  sudo awk '/^[[:space:]]*location \/dianzhan\/ \{/ && !done {
    print "    # 入口 HTML 每次回源校验：否则页面被缓存后，里面的 ?v= 版本号也停在旧值，";
    print "    # 新代码永远拉不到（js/css 仍靠 ?v= 版本号走缓存）";
    print "    location ~* ^/dianzhan/(.*\\.html)$ {";
    print "        alias /var/www/lichu/$1;";
    print "        add_header Cache-Control \"no-cache\";";
    print "    }";
    print "";
    done=1
  } { print }' "$CONF" > /tmp/mqtt.nocache.conf
  sudo cp /tmp/mqtt.nocache.conf "$CONF"
  echo "已写入 HTML no-cache 规则"
fi

echo "--- 配置检查 ---"
sudo nginx -t
sudo systemctl reload nginx
echo "已 reload"

echo
echo "--- 实测响应头 ---"
for u in "/dianzhan/" "/dianzhan/index.html" "/dianzhan/js/main.js" "/dianzhan/css/style.css"; do
  h=$(curl -s -o /dev/null -D - "https://mqtt.ykdesign.top$u" | tr -d '\r')
  cc=$(echo "$h" | awk 'tolower($1)=="cache-control:"{print $2}' | head -1)
  et=$(echo "$h" | awk 'tolower($1)=="etag:"{print $2}' | head -1)
  printf '  %-28s Cache-Control=%-10s ETag=%s\n' "$u" "${cc:-（未设置）}" "${et:-无}"
done
echo
echo "--- 再请求一次，看是否 304（说明回源校验生效）---"
curl -s -o /dev/null -D - -H 'If-None-Match: '"$(curl -s -o /dev/null -D - https://mqtt.ykdesign.top/dianzhan/ | tr -d '\r' | awk 'tolower($1)=="etag:"{print $2}')" https://mqtt.ykdesign.top/dianzhan/ | head -1
