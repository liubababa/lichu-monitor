#!/usr/bin/env bash
echo "=== 1) 抓包：所有外部进来的连接尝试（按 来源IP → 目的端口）==="
sudo grep -E 'In +IP' /var/log/mqtt-syn.log | sed -E 's/.*In +IP ([0-9.]+)\.[0-9]+ > [0-9.]+\.([0-9]+):.*/\1 -> \2/' \
  | grep -v '^112.38.77.202' | sort | uniq -c | sort -rn | head -25

echo
echo "=== 2) 抓包里跟 MQTT 相关的端口（1883/8883/8083/9001/1884）有没有外部来源 ==="
sudo grep -E 'In +IP' /var/log/mqtt-syn.log | grep -E '\.(1883|8883|8083|9001|1884):' | grep -v '112.38.77.202' | tail -10 || echo "（没有任何外部来源打过这些端口）"

echo
echo "=== 3) 那几个可疑中国 IP 的细节（看是不是扫描器）==="
for ip in 180.93.138.150 183.3.221.211 111.170.9.137; do
  echo "--- $ip ---"
  sudo grep -E "In +IP $ip" /var/log/mqtt-syn.log | head -3
done

echo
echo "=== 4) nginx 有没有收到过异常的 TLS/HTTP（比如设备把 MQTT 打到 443）==="
sudo tail -5 /var/log/nginx/error.log 2>/dev/null || echo "（nginx 错误日志为空）"
echo "--- 访问日志里有没有非浏览器请求 ---"
sudo grep -vE 'Mozilla|bot|spider|crawler|Chrome|Safari' /var/log/nginx/access.log 2>/dev/null | tail -5 || echo "（都是浏览器/爬虫）"

echo
echo "=== 5) 抓包进程还在吗 ==="
pgrep -af tcpdump | head -1 | cut -c1-80 || echo "（抓包已停）"
