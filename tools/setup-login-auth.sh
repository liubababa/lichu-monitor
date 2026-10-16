#!/usr/bin/env bash
# 给 mqtt.ykdesign.top 加 HTTP Basic 登录（网页 + 所有数据接口一起保护）。
#
# 为什么放在 nginx 而不是前端页面：
#   前端密码框挡不住任何人——JS 能直接看、能直接跳过，数据接口照样裸奔。
#   nginx 的 auth_basic 才是真门：不登录连 js/css/接口都拿不到。
#   注意 auth_basic 必须写在 **443 server 块** 里（写在 80 块里不生效，因为 443 是独立 server 块）。
#
# 账号密码在服务器上随机生成，密码只在执行时打印一次，不写进仓库。
# 重跑本脚本 = 重置该账号密码；带参数可加新账号（不会动别人的密码）。
#
# 用法（本机）：
#   node tools/remote-run.js --file tools/setup-login-auth.sh
#   node tools/remote-run.js --file tools/setup-login-auth.sh -- zhangsan
set -e

SITE=/etc/nginx/sites-available/mqtt.ykdesign.top
HTP=/etc/nginx/.htpasswd-lichu
REALM='力储未来 · 请登录'
USER_NAME="${1:-lichu}"
DOMAIN=mqtt.ykdesign.top

echo "== 1/4 账号 =="
if [ ! -f "$HTP" ]; then
  sudo install -m 640 -o root -g www-data /dev/null "$HTP"
fi
if [ -n "$RESET_PW" ]; then
  PW="$RESET_PW"
  echo "使用外部指定密码（重置）"
else
  PW="$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | cut -c1-12)"
fi
HASH="$(openssl passwd -apr1 "$PW")"
if sudo grep -q "^${USER_NAME}:" "$HTP"; then
  sudo sed -i "s|^${USER_NAME}:.*|${USER_NAME}:${HASH}|" "$HTP"
  echo "已重置账号 ${USER_NAME} 的密码"
else
  echo "${USER_NAME}:${HASH}" | sudo tee -a "$HTP" >/dev/null
  echo "已新建账号 ${USER_NAME}"
fi
sudo chown root:www-data "$HTP"; sudo chmod 640 "$HTP"
echo "ACCOUNT ${USER_NAME} / PASSWORD ${PW}"

echo "== 2/4 备份并写入 nginx（插到 443 server 块） =="
TS="$(date +%Y%m%d%H%M%S)"
sudo mkdir -p /etc/nginx/backups
sudo cp "$SITE" "/etc/nginx/backups/mqtt.ykdesign.top.bak.auth.${TS}"
echo "备份：/etc/nginx/backups/mqtt.ykdesign.top.bak.auth.${TS}"

sudo python3 - "$SITE" "$HTP" "$REALM" "$DOMAIN" <<'PY'
import re, sys
site, htp, realm, domain = sys.argv[1:5]
src = open(site, encoding='utf-8').read()
# 先撤掉可能的旧插入（历史上有一版误插到 80 端口块）
src2 = re.sub(r'\n[ \t]*# ---- 全站登录（HTTP Basic）.*?location = /healthz \{ auth_basic off; \}\n',
              '\n', src, flags=re.S)
if src2 != src:
    print('撤掉旧插入（80 端口块）')
src = src2
if 'htpasswd-lichu' in src:
    print('443 块里已有登录指令，跳过插入')
else:
    out, done, in443 = [], False, False
    for ln in src.split('\n'):
        out.append(ln)
        if 'listen' in ln and '443' in ln:
            in443 = True
        if in443 and not done and ln.strip().startswith('server_name') and domain in ln:
            out += ['    # ---- 全站登录（HTTP Basic）：公网不能直接进 ----',
                    '    auth_basic "%s";' % realm,
                    '    auth_basic_user_file %s;' % htp,
                    '    add_header X-Robots-Tag "noindex, nofollow, noarchive" always;']
            done = True
    src = '\n'.join(out)
    print('443 块写入 auth_basic：%s' % done)
open(site, 'w', encoding='utf-8').write(src)
PY

echo "== 3/4 校验并重载 =="
if ! sudo nginx -t; then
  echo "配置校验失败，回滚"
  sudo cp "/etc/nginx/backups/mqtt.ykdesign.top.bak.auth.${TS}" "$SITE"
  sudo nginx -t && sudo systemctl reload nginx
  exit 1
fi
sudo systemctl reload nginx && echo "nginx 已重载"

echo "== 4/4 验证（未登录必须 401，已登录必须 200，WS 必须 101） =="
p_page="$(curl -s -o /dev/null -w '%{http_code}' https://${DOMAIN}/dianzhan/)"
p_page_ok="$(curl -s -o /dev/null -w '%{http_code}' -u "${USER_NAME}:${PW}" https://${DOMAIN}/dianzhan/)"
p_api="$(curl -s -o /dev/null -w '%{http_code}' https://${DOMAIN}/risen/full)"
p_api_ok="$(curl -s -o /dev/null -w '%{http_code}' -u "${USER_NAME}:${PW}" https://${DOMAIN}/risen/full)"
p_ws="$(curl -s -o /dev/null -w '%{http_code}' -u "${USER_NAME}:${PW}" -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' https://${DOMAIN}/mqtt)"
echo "网页 未登录=${p_page} 已登录=${p_page_ok}"
echo "接口 未登录=${p_api} 已登录=${p_api_ok}"
echo "WebSocket 握手 已登录=${p_ws}"
if [ "$p_page" = "401" ] && [ "$p_page_ok" = "200" ] && [ "$p_api" = "401" ] && [ "$p_api_ok" = "200" ]; then
  echo "结果：公网直接访问已挡住，登录后网页/接口/实时数据都正常"
else
  echo "结果：状态不符合预期。回滚：sudo cp /etc/nginx/backups/mqtt.ykdesign.top.bak.auth.${TS} ${SITE} && sudo nginx -t && sudo systemctl reload nginx"
  exit 1
fi
