#!/usr/bin/env bash
# 全端口诊断抓包（TCP SYN + 全部 UDP），窗口 6 小时
sudo pkill -f 'tcpdump -i any' 2>/dev/null || true
sudo rm -f /var/log/mqtt-syn.log

sudo bash -c "nohup timeout 21600 tcpdump -i any -n -l '(tcp[tcpflags] & tcp-syn != 0 and tcp[tcpflags] & tcp-ack == 0 or udp) and not host 127.0.0.1 and not port 22' > /var/log/mqtt-syn.log 2>&1 &"

sleep 3
echo "抓包进程："; pgrep -af tcpdump | head -2 | cut -c1-120
echo "--- 抓包文件 ---"; sudo ls -l /var/log/mqtt-syn.log
echo "--- 当前时间 ---"; date
echo "--- 已经开始抓到的（前 5 条）---"; sudo grep -cE 'In +IP' /var/log/mqtt-syn.log || true
