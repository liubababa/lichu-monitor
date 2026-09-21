#!/usr/bin/env bash
# 在 MQTT 服务器上安装「连接尝试留痕」服务。
# 用法（服务器上）：sudo bash install-mqtt-connlog.sh
# 或本机：把本目录 scp 上去后执行。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
install -m 0755 "$ROOT/mqtt-connlog.sh" /usr/local/bin/mqtt-connlog.sh
install -m 0644 "$ROOT/mqtt-connlog.service" /etc/systemd/system/mqtt-connlog.service

mkdir -p /var/log/mqtt-watch
touch /var/log/mqtt-watch/connections.log
chmod 755 /var/log/mqtt-watch
chmod 644 /var/log/mqtt-watch/connections.log

# 加强 mosquitto 连接相关日志（幂等）
CONF=/etc/mosquitto/conf.d/zhhn.conf
if [ -f "$CONF" ] && ! grep -q '^connection_messages' "$CONF"; then
  cat >> "$CONF" <<'EOF'

# 连接留痕（供 mqtt-connlog 抽取：成功/失败/协议错误都要有）
connection_messages true
log_timestamp true
log_type error
log_type warning
log_type notice
log_type information
EOF
  systemctl reload mosquitto || systemctl restart mosquitto
fi

# 轮转：连接日志与报文日志一起保留更久，避免证据被 size=100k 冲掉
cat > /etc/logrotate.d/mqtt-watch <<'EOF'
/var/log/mqtt-watch/messages.log
/var/log/mqtt-watch/connections.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
EOF

# mosquitto 本体日志也加大保留（连接证据的原始源）
if [ -f /etc/logrotate.d/mosquitto ]; then
  cat > /etc/logrotate.d/mosquitto <<'EOF'
/var/log/mosquitto/mosquitto.log {
	rotate 14
	daily
	compress
	delaycompress
	size 10M
	missingok
	notifempty
	copytruncate
	postrotate
		if invoke-rc.d mosquitto status > /dev/null 2>&1; then \
			invoke-rc.d mosquitto reload > /dev/null 2>&1; \
		fi;
	endscript
}
EOF
fi

systemctl daemon-reload
systemctl enable --now mqtt-connlog.service
systemctl restart mqtt-connlog.service
systemctl --no-pager --full status mqtt-connlog.service | head -20
echo
echo "查看连接尝试： sudo tail -50 /var/log/mqtt-watch/connections.log"
echo "查看上报报文： sudo tail -50 /var/log/mqtt-watch/messages.log"
