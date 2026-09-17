'use strict';
/* 实测 MQTT broker 连通性（TLS 8883 / WSS 8084）
   用法：node probe-emqx.js <broker地址> [用户名] [密码] */
const mqtt = require('mqtt');
const HOST = process.argv[2];
if (!HOST) {
  console.log('用法：node probe-emqx.js <broker地址> [用户名] [密码]');
  console.log('例如：node probe-emqx.js xxxx.ala.cn-hangzhou.emqxsl.cn lichu_web <密码>');
  process.exit(1);
}
const USER = process.argv[3] || '';
const PASS = process.argv[4] || '';

const cases = [
  ['MQTT over TLS (8883)', 'mqtts://' + HOST + ':8883'],
  ['WebSocket over TLS (8084)', 'wss://' + HOST + ':8084/mqtt'],
];

let done = 0;
cases.forEach(([name, url]) => {
  const t0 = Date.now();
  const opts = { connectTimeout: 12000, reconnectPeriod: 0, clientId: 'probe-' + Math.random().toString(16).slice(2, 8) };
  if (USER) { opts.username = USER; opts.password = PASS; }
  const c = mqtt.connect(url, opts);
  let fin = false;
  const finish = (status, note) => {
    if (fin) return;
    fin = true;
    console.log(status.padEnd(6) + name + '  (' + (Date.now() - t0) + 'ms)  ' + note);
    try { c.end(true); } catch (_) {}
    if (++done === cases.length) process.exit(0);
  };
  c.on('connect', (packet) => {
    const rc = packet && packet.returnCode !== undefined ? packet.returnCode : 'ok';
    finish('OK', '连接成功（CONNACK=' + rc + '）');
  });
  c.on('error', (e) => {
    const m = e.message || String(e);
    if (/not authorized|Not authorized|bad username|Not Authorized/i.test(m)) finish('AUTH', 'TLS 通了，但需要账号密码（' + m + '）');
    else finish('FAIL', m);
  });
  setTimeout(() => finish('TIMEOUT', '12 秒无响应'), 12000);
});
