#!/usr/bin/env node
/* ============================================================
 * broker 监视 + 登录应答（常驻服务的雏形）
 *
 * 作用：
 *   1. 订阅 zhhn/#   —— 看厂家 EMS 是否已登录/上报（含其真实 SN）
 *   2. 自动回登录应答 PostRsp(Login) result=1 —— 否则 EMS 不继续通信
 *   3. 把收到的报文落盘到 logs/ 目录，便于事后查
 *
 * 用法：node watch-broker.js <broker地址> <用户名> <密码> [运行秒数，默认0=一直跑]
 *   例：node watch-broker.js aa50f11a.ala.cn-hangzhou.emqxsl.cn lichu_web 872373 120
 * ============================================================ */
'use strict';
const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');

const HOST = process.argv[2];
const USER = process.argv[3];
const PASS = process.argv[4];
const RUN_SEC = parseInt(process.argv[5] || '0', 10);
const FILTER = process.argv[6] || 'zhhn/#';
if (!HOST || !USER) {
  console.log('用法：node watch-broker.js <broker地址> <用户名> <密码> [运行秒数，0=一直跑] [主题过滤器，默认 zhhn/#]');
  process.exit(1);
}
const URL = 'mqtts://' + HOST + ':8883';
const LOG_DIR = path.join(__dirname, '..', 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, 'broker-' + new Date().toISOString().slice(0, 10) + '.log');

const ts = () => new Date().toTimeString().slice(0, 8);
function log(line, alsoConsole) {
  const text = ts() + '  ' + line;
  fs.appendFileSync(LOG_FILE, text + '\n');
  if (alsoConsole !== false) console.log(text);
}

const stat = { login: 0, period: 0, other: 0, sns: new Set(), devices: new Set(), lastAt: null, lastTagCount: 0 };

const client = mqtt.connect(URL, {
  username: USER, password: PASS, clientId: 'lichu-watch-' + Date.now(),
  keepalive: 30, reconnectPeriod: 5000, connectTimeout: 15000
});

client.on('connect', () => {
  log('已连接 broker：' + URL);
  client.subscribe(FILTER, { qos: 1 }, (err) => {
    if (err) return log('订阅失败：' + err.message);
    log('已订阅 ' + FILTER + '，等待设备上线…');
  });
});
client.on('reconnect', () => log('重连中…'));
client.on('error', (e) => log('连接错误：' + e.message));
client.on('close', () => log('连接断开'));

function safeParse(text) {
  try { return JSON.parse(text); } catch (_) {}
  try {
    return JSON.parse(text.replace(/：/g, ':').replace(/，/g, ',').replace(/,\s*([}\]])/g, '$1'));
  } catch (_) { return null; }
}

client.on('message', (topic, buf) => {
  const text = buf.toString();
  const p = safeParse(text);
  const sn = topic.split('/')[3] || '';
  stat.lastAt = Date.now();
  if (sn) stat.sns.add(sn);

  /* 登录请求：必须回应，否则 EMS 不上报 */
  if (topic.indexOf('zhhn/Post/Login/') === 0) {
    stat.login++;
    log('收到登录请求 ' + topic + '　vendor=' + (p && p.vendor) + '　→ 回 PostRsp(result=1)');
    const rspTopic = 'zhhn/PostRsp/Login/' + sn;
    client.publish(rspTopic, JSON.stringify({ identifier: 'Login', result: 1, time: Math.floor(Date.now() / 1000) }), { qos: 1 });
    return;
  }

  if (topic.indexOf('zhhn/Post/PeriodReport/') === 0) {
    stat.period++;
    const list = (p && p.data) || [];
    let tags = 0;
    list.forEach(d => { if (d && d.tags) { tags += Object.keys(d.tags).length; d.deviceType && stat.devices.add(d.deviceType); } });
    stat.lastTagCount = tags;
    log('周期上报 ' + topic + '　设备 ' + list.length + ' 类（' + list.map(d => d.deviceType).join('/') + '）点位 ' + tags + ' 个　' + text.length + 'B');
    fs.appendFileSync(path.join(LOG_DIR, 'last-report.json'), text);
    return;
  }

  /* 其它所有主题（含高特协议的 /ProductSN/DeviceSN/... ）一律记录 */
  stat.other++;
  log('报文 ' + topic + '　' + text.length + 'B　' + text.slice(0, 200));
  fs.appendFileSync(path.join(LOG_DIR, 'other-topics.log'),
    new Date().toISOString() + '\t' + topic + '\t' + text + '\n');
});

/* 每 30 秒打一次汇总 */
const timer = setInterval(() => {
  log('—— 汇总：登录 ' + stat.login + ' 次，周期上报 ' + stat.period + ' 帧，其它 ' + stat.other +
      ' 条；SN=' + (stat.sns.size ? Array.from(stat.sns).join(',') : '（暂无）') +
      '；设备类型=' + (stat.devices.size ? Array.from(stat.devices).join('/') : '（暂无）') +
      '；最近报文=' + (stat.lastAt ? new Date(stat.lastAt).toTimeString().slice(0, 8) : '无'), true);
}, 30000);

if (RUN_SEC > 0) {
  setTimeout(() => {
    log('—— 运行结束：共收到登录 ' + stat.login + ' 次、周期上报 ' + stat.period + ' 帧');
    if (!stat.period && !stat.login) log('—— 结论：监控期间没有收到任何厂家 EMS 报文');
    else log('—— 结论：收到厂家数据，SN=' + Array.from(stat.sns).join(','));
    client.end(true, () => process.exit(0));
  }, RUN_SEC * 1000);
}
process.on('SIGINT', () => { client.end(true); process.exit(0); });
