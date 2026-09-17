#!/usr/bin/env bash
# ============================================================
# 力储未来 · MQTT broker 一键部署脚本（EMQX 5.x）
#
# 作用：
#   1. 装 EMQX（优先 Docker，无 Docker 则用官方 apt/yum 源）
#   2. 开启 TCP 1883（给 EMS）+ WebSocket 8083（给网页）
#   3. 创建两个账号：zhhn_ems（给厂家 EMS）、lichu_web（给网页）
#   4. 输出 nginx 反代配置片段（让网页用 wss://域名/mqtt 接入）
#   5. 打印《给厂家的接入参数》
#
# 用法（在服务器上以 root 执行）：
#   bash deploy-broker.sh                       # 自动生成随机密码
#   bash deploy-broker.sh <EMS密码> <网页密码>   # 指定密码
#
# 执行完请把输出的「给厂家的接入参数」发给中和汇能。
# ============================================================
set -euo pipefail

EMS_USER="zhhn_ems"
WEB_USER="lichu_web"
EMS_PASS="${1:-$(head -c 12 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 14)}"
WEB_PASS="${2:-$(head -c 12 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 14)}"
WORKDIR="/opt/lichu-mqtt"
DOMAIN="${DOMAIN:-ykdesign.top}"

log() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[注意] %s\033[0m\n' "$*"; }

need_root() { [ "$(id -u)" = "0" ] || { echo "请用 root 执行（sudo -i 或 sudo bash $0）"; exit 1; }; }
need_root

HAS_DOCKER=0
command -v docker >/dev/null 2>&1 && HAS_DOCKER=1

if [ "$HAS_DOCKER" = "1" ]; then
  # ---------------- 方式 A：Docker ----------------
  log "使用 Docker 部署 EMQX"
  mkdir -p "$WORKDIR/etc"
  cat > "$WORKDIR/etc/emqx.conf" <<EOF
node {
  name = "emqx@127.0.0.1"
  cookie = "lichu$(date +%s)"
  data_dir = "/opt/emqx/data"
}
dashboard { listeners.http.bind = 18083 }
listeners.tcp.default { bind = "0.0.0.0:1883" }
listeners.ws.default  { bind = "0.0.0.0:8083" }
authentication = [
  {
    mechanism = password_based
    backend = built_in_database
    user_id_type = username
    bootstrap_file = "/opt/emqx/etc/auth-bootstrap.csv"
    bootstrap_type = plain
  }
]
authorization {
  no_match = allow
  deny_action = ignore
}
EOF
  printf 'user_id,password,is_superuser\n%s,%s,false\n%s,%s,false\n' \
    "$EMS_USER" "$EMS_PASS" "$WEB_USER" "$WEB_PASS" > "$WORKDIR/etc/auth-bootstrap.csv"

  docker rm -f lichu-emqx >/dev/null 2>&1 || true
  docker run -d --name lichu-emqx --restart always \
    -p 1883:1883 -p 8083:8083 -p 18083:18083 \
    -v "$WORKDIR/etc/emqx.conf:/opt/emqx/etc/emqx.conf:ro" \
    -v "$WORKDIR/etc/auth-bootstrap.csv:/opt/emqx/etc/auth-bootstrap.csv:ro" \
    -v "$WORKDIR/data:/opt/emqx/data" \
    emqx/emqx:5.8
  log "EMQX 容器已启动（docker logs -f lichu-emqx 查看日志）"

else
  # ---------------- 方式 B：官方源安装 ----------------
  warn "未检测到 Docker，尝试用官方源安装 EMQX"
  if command -v apt-get >/dev/null 2>&1; then
    . /etc/os-release
    CODENAME="${VERSION_CODENAME:-jammy}"
    curl -fsSL https://repos.emqx.io/gpg.pub | gpg --dearmor > /usr/share/keyrings/emqx.gpg
    echo "deb [signed-by=/usr/share/keyrings/emqx.gpg] https://repos.emqx.io/emqx-ce/deb/ubuntu/ ${CODENAME} stable" \
      > /etc/apt/sources.list.d/emqx.list
    apt-get update -qq && apt-get install -y emqx
  elif command -v yum >/dev/null 2>&1; then
    curl -fsSL https://repos.emqx.io/emqx-ce/rpm/emqx-ce.repo -o /etc/yum.repos.d/emqx-ce.repo
    yum install -y emqx
  else
    echo "无法自动安装，请先安装 Docker 后重跑本脚本"; exit 1
  fi

  mkdir -p /etc/emqx
  cp /etc/emqx/emqx.conf /etc/emqx/emqx.conf.bak 2>/dev/null || true
  cat >> /etc/emqx/emqx.conf <<EOF

listeners.tcp.default { bind = "0.0.0.0:1883" }
listeners.ws.default  { bind = "0.0.0.0:8083" }
authentication = [
  {
    mechanism = password_based
    backend = built_in_database
    user_id_type = username
    bootstrap_file = "/etc/emqx/auth-bootstrap.csv"
    bootstrap_type = plain
  }
]
authorization { no_match = allow }
EOF
  printf 'user_id,password,is_superuser\n%s,%s,false\n%s,%s,false\n' \
    "$EMS_USER" "$EMS_PASS" "$WEB_USER" "$WEB_PASS" > /etc/emqx/auth-bootstrap.csv
  systemctl enable --now emqx && systemctl restart emqx
  log "EMQX 已作为系统服务启动（systemctl status emqx）"
fi

# ---------------- 防火墙 ----------------
log "放行端口"
if command -v ufw >/dev/null 2>&1; then ufw allow 1883/tcp || true; ufw allow 443/tcp || true;
elif command -v firewall-cmd >/dev/null 2>&1; then firewall-cmd --permanent --add-port=1883/tcp || true; firewall-cmd --reload || true;
else warn "未检测到 ufw/firewalld，请确认云服务商安全组已放行 1883 与 443"; fi

# ---------------- nginx 反代（网页用 wss） ----------------
log "生成 nginx 反代配置"
SNIPPET="/etc/nginx/conf.d/lichu-mqtt.conf"
NGINX_BLOCK="location /mqtt {
    proxy_pass http://127.0.0.1:8083;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \"upgrade\";
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
}"
if [ -d /etc/nginx ]; then
  echo "$NGINX_BLOCK" > "$SNIPPET"
  if nginx -t >/dev/null 2>&1; then
    nginx -s reload && log "nginx 已重载，wss://${DOMAIN}/mqtt 可用"
  else
    warn "nginx 配置校验未通过，请检查 ${SNIPPET} 是否放在了正确的 server 块/或整站配置中"
  fi
else
  warn "未检测到 nginx，请把下面的配置加到你的站点配置里（宝塔：网站→设置→配置文件）："
  echo "$NGINX_BLOCK"
fi

sleep 3
# ---------------- 输出接入参数 ----------------
cat <<EOF

################################################################
#              给【中和汇能】的 EMS 接入参数（请转发）
################################################################
MQTT 服务器地址（host） : ${DOMAIN}
端口（port）            : 1883            ← 普通 TCP
用户（username）        : ${EMS_USER}
密码（password）        : ${EMS_PASS}
协议版本                : MQTT 3.1.1 / 5.0 均可
QoS                     : 0 或 1
Keepalive               : 60 秒
ClientId                : 建议填 EMS 的 SN（保证唯一即可）
上报 Topic              : zhhn/Post/Login/{SN}、zhhn/Post/PeriodReport/{SN}
（如需 TLS 加密请告知，我们另开 8883 端口并提供证书）

################################################################
#                     平台网页侧参数（自己留存）
################################################################
浏览器配置面板填写   : wss://${DOMAIN}/mqtt
用户名               : ${WEB_USER}
密码                 : ${WEB_PASS}
EMQX 管理台          : http://服务器IP:18083   默认 admin/public（请立刻改密码）
配置文件目录         : ${WORKDIR}/etc（Docker）或 /etc/emqx（系统服务）
################################################################
EOF
