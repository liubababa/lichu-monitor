#!/usr/bin/env bash
echo "=== 1) 网关服务 ==="
printf '  运行状态：'; systemctl is-active mqtt-gateway 2>/dev/null || echo "inactive（已停）"
printf '  开机自启：'; systemctl is-enabled mqtt-gateway 2>/dev/null || echo "disabled（不自启）"
echo
echo "=== 2) 8090 端口 ==="
sudo ss -lnt | grep ':8090' || echo "  8090 已无监听"
echo
echo "=== 3) 网关进程 ==="
pgrep -af 'gateway.js' || echo "  没有 gateway.js 进程"
echo
echo "=== 4) nginx /mqtt 指向 ==="
grep -A1 'location /mqtt' /etc/nginx/sites-available/mqtt.ykdesign.top | head -2
echo
echo "=== 5) 服务清单 ==="
for s in mosquitto nginx mqtt-watch mqtt-gateway; do
  printf '  %-14s %s\n' "$s" "$(systemctl is-active $s 2>/dev/null)"
done
echo
echo "=== 6) 监听端口 ==="
sudo ss -lnt | grep -E ':1883|:8883|:8083|:8090|:443' || true
echo
echo "=== 7) 网关文件是否还在（保留以便回滚）==="
ls -d /opt/mqtt-gateway 2>/dev/null && ls /opt/mqtt-gateway | head -5
