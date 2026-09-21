#!/bin/bash
# ============================================================
# MQTT 连接尝试留痕
#
# 订阅报文（Publish）仍由 mqtt-watch → messages.log 记录。
# 本脚本专门从 mosquitto 日志抽出「有没有人来连」相关事件：
#   · TCP 新连接（含尚未鉴权）
#   · 鉴权成功（New client connected + 用户名）
#   · 鉴权失败（not authorised / bad username or password）
#   · 协议错误（连了端口但不是合法 MQTT）
#   · 正常/异常断开
#
# 输出：/var/log/mqtt-watch/connections.log
# 用法：作为 systemd 服务常驻，或手动：
#   sudo bash tools/mqtt-connlog.sh
# ============================================================
set -u

SRC="${MQTT_CONNLOG_SRC:-/var/log/mosquitto/mosquitto.log}"
DST="${MQTT_CONNLOG_DST:-/var/log/mqtt-watch/connections.log}"
DIR="$(dirname "$DST")"

mkdir -p "$DIR"
touch "$DST"
chmod 644 "$DST" 2>/dev/null || true

PATTERN='New connection from|New client connected|disconnected|not authorised|not authorized|Bad username|protocol error|Socket error|OpenSSL Error|Client connection from|closing old connection|failed to|http request'

classify() {
  local line="$1"
  case "$line" in
    *"New client connected"*) echo "AUTH_OK" ;;
    *"not authorised"*|*"not authorized"*|*"Bad username"*) echo "AUTH_FAIL" ;;
    *"protocol error"*|*"Protocol error"*|*"OpenSSL Error"*|*"http request"*) echo "PROTO_ERR" ;;
    *"New connection from"*) echo "CONNECT" ;;
    *"Client connection from"*) echo "CONNECT_FAIL" ;;
    *"disconnected"*|*"closed its connection"*|*"closing old connection"*) echo "DISCONNECT" ;;
    *"Socket error"*|*"failed to"*) echo "ERROR" ;;
    *) echo "OTHER" ;;
  esac
}

# mosquitto 行首是 unix 时间戳：1789784692: message...
format_line() {
  local raw="$1"
  local ts rest human kind
  if [[ "$raw" =~ ^([0-9]+):\ (.*)$ ]]; then
    ts="${BASH_REMATCH[1]}"
    rest="${BASH_REMATCH[2]}"
    human="$(date -d "@$ts" '+%Y-%m-%dT%H:%M:%S%z' 2>/dev/null || date -r "$ts" '+%Y-%m-%dT%H:%M:%S%z' 2>/dev/null || echo "?")"
  else
    human="$(date '+%Y-%m-%dT%H:%M:%S%z')"
    rest="$raw"
  fi
  kind="$(classify "$rest")"
  printf '%s  %-12s  %s\n' "$human" "$kind" "$rest"
}

emit() {
  format_line "$1" >> "$DST"
}

# 启动时回填最近相关行，避免服务重启后空白（最多 500 条匹配）
if [ -f "$SRC" ]; then
  {
    echo "-------- mqtt-connlog start $(date '+%Y-%m-%dT%H:%M:%S%z') pid=$$ src=$SRC --------"
    grep -E "$PATTERN" "$SRC" 2>/dev/null | tail -n 500 | while IFS= read -r line || [ -n "$line" ]; do
      format_line "$line"
    done
    echo "-------- live follow --------"
  } >> "$DST" || true
fi

# -F：跟随文件名，兼容 logrotate 换文件；从末尾开始，避免与回填重复
stdbuf -oL tail -n 0 -F "$SRC" 2>/dev/null | while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    *"New connection from"*|*"New client connected"*|*"disconnected"*|*"not authorised"*|*"not authorized"*|*"Bad username"*|*"protocol error"*|*"Protocol error"*|*"Socket error"*|*"OpenSSL Error"*|*"Client connection from"*|*"closing old connection"*|*"failed to"*|*"http request"*)
      emit "$line"
      ;;
  esac
done
