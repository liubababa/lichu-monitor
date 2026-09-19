#!/usr/bin/env bash
# 硬证据：把 broker 日志里所有连接、所有认证失败逐条列出来（带可读时间）
sudo python3 - <<'PY'
import re, time

LOG = '/var/log/mosquitto/mosquitto.log'
lines = open(LOG, encoding='utf-8', errors='replace').read().split('\n')

def t_of(l):
    m = re.match(r'^(\d+):', l)
    return time.strftime('%m-%d %H:%M:%S', time.localtime(int(m.group(1)))) if m else None

start = None
conns, fails = [], []
for l in lines:
    t = t_of(l)
    if not t:
        continue
    if start is None:
        start = t
    m = re.search(r"New client connected from ([0-9.]+):\d+ as (\S+) .*u'([^']*)'", l)
    if m:
        conns.append((t, m.group(1), m.group(2), m.group(3)))
        continue
    m2 = re.search(r"New connection from ([0-9.]+):\d+ on port (\d+)", l)
    if m2:
        conns.append((t, m2.group(1), '(TCP 连接后未完成认证)', 'port ' + m2.group(2)))
    if 'not authorised' in l:
        cid = re.search(r'Client (\S+) disconnected', l)
        fails.append((t, cid.group(1) if cid else '?'))

print('broker 日志起始时间：' + (start or '?'))
print('日志覆盖到：' + (t_of([l for l in lines if t_of(l)][-1]) if any(t_of(l) for l in lines) else '?'))
print()
print('===== 所有「认证成功的客户端连接」（按来源分组）=====')
by_ip = {}
for t, ip, cid, user in conns:
    if '(TCP' in cid and 'not authorised' in ' '.join(x for x in []):
        pass
    by_ip.setdefault(ip, []).append((t, cid, user))
for ip in sorted(by_ip, key=lambda k: -len(by_ip[k])):
    items = by_ip[ip]
    print('\n来源 %s：共 %d 次' % (ip, len(items)))
    for t, cid, user in items[:8]:
        print('   %s  客户端=%-28s 账号=%s' % (t, cid[:28], user))
    if len(items) > 8:
        print('   … 其余 %d 次省略' % (len(items) - 8))

print()
print('===== 认证失败（not authorised，说明「连到了但密码不对」会留痕）=====')
for t, cid in fails[-12:]:
    print('   %s  客户端=%s' % (t, cid))
print('   合计 %d 次' % len(fails))
PY
