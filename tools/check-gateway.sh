#!/usr/bin/env bash
echo "=== 网关服务状态 ==="
systemctl status mqtt-gateway --no-pager 2>&1 | head -12
echo
echo "=== 重启次数 ==="
systemctl show mqtt-gateway -p NRestarts
echo
echo "=== 网关配置（隐藏密码）==="
sudo sed -E 's/("(password|pass)"[[:space:]]*:[[:space:]]*")[^"]*/\1***/' /opt/mqtt-gateway/config.json
echo
echo "=== 网关日志（最近 20 行）==="
sudo journalctl -u mqtt-gateway -n 20 --no-pager
echo
echo "=== 当前健康 ==="
curl -s -m 5 http://127.0.0.1:8090/healthz
echo
