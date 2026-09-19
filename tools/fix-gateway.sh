#!/usr/bin/env bash
# 关闭网关的"最后一条缓存回放"（retainLast），并重启清空已有缓存；顺带核对 broker 账号
set -e
CFG=/opt/mqtt-gateway/config.json

echo "=== 1) 备份并修改配置 ==="
sudo cp -n "$CFG" "$CFG.bak.$(date +%Y%m%d%H%M)" 2>/dev/null || true
sudo python3 - <<'PY'
import json, io
p = '/opt/mqtt-gateway/config.json'
d = json.load(io.open(p, encoding='utf-8'))
d['retainLast'] = False
io.open(p, 'w', encoding='utf-8').write(json.dumps(d, ensure_ascii=False, indent=2))
print('retainLast ->', d['retainLast'])
PY

echo
echo "=== 2) 重启网关（同时清空内存里的旧缓存）==="
sudo systemctl restart mqtt-gateway
sleep 3
systemctl is-active mqtt-gateway
curl -s -m 5 http://127.0.0.1:8090/healthz | head -20

echo
echo "=== 3) broker 账号清单 ==="
sudo cut -d: -f1 /etc/mosquitto/passwd

echo
echo "=== 4) 确认 nginx /mqtt 指向 ==="
grep -A2 'location /mqtt' /etc/nginx/sites-available/mqtt.ykdesign.top | head -3
