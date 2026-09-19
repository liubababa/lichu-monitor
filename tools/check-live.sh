#!/usr/bin/env bash
echo "=== 现在时间 ==="; date
echo
echo "=== 1) broker：今天 09:00 之后有没有非本机连接 ==="
sudo python3 - <<'PY'
import re, time
lines = open('/var/log/mosquitto/mosquitto.log', encoding='utf-8', errors='replace').read().split('\n')
cut = time.mktime(time.strptime('2026-09-19 09:00:00', '%Y-%m-%d %H:%M:%S'))
out = []
for l in lines:
    m = re.match(r'^(\d+):', l)
    if not m: continue
    t = int(m.group(1))
    if t < cut: continue
    if '127.0.0.1' in l: continue
    out.append(time.strftime('%H:%M:%S', time.localtime(t)) + '  ' + l.split(': ', 1)[-1])
print('\n'.join(out[-25:]) if out else '（09:00 之后没有任何非本机连接）')
PY

echo
echo "=== 2) 抓包还在跑吗（能抓到任意端口的连接尝试）==="
pgrep -af 'tcpdump' | head -2 | cut -c1-90 || echo "（抓包已结束）"

echo
echo "=== 3) 抓包记录里的外部来源（按 IP:端口 汇总）==="
if [ -f /var/log/mqtt-syn.log ]; then
  sudo grep -E 'In +IP' /var/log/mqtt-syn.log | sed -E 's/.*In +IP ([0-9.]+)\.[0-9]+ > [0-9.]+\.([0-9]+):.*/\1 -> \2/' | sort | uniq -c | sort -rn | head -15
  echo "--- 其中来自中国电信/移动/联通网段（含 112.38 / 111.170 / 180.101 / 183.60 等）---"
  sudo grep -E 'In +IP' /var/log/mqtt-syn.log | grep -E 'In +IP (112\.|111\.|180\.|183\.|117\.|120\.|218\.|219\.|221\.|222\.)' | tail -10 || echo "（无）"
else
  echo "（没有抓包文件）"
fi

echo
echo "=== 4) 留痕日志（真实设备报文）==="
sudo cat /var/log/mqtt-watch/messages.log | tail -3
