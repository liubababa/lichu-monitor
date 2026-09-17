'use strict';
/* 检查是否有保留消息/实时报文：覆盖 1~2 段式主题 */
const mqtt = require('mqtt');
const HOST = process.argv[2], USER = process.argv[3], PASS = process.argv[4];
const filters = ['+', '+/+', '+/+/+', '/+', '/+/+', 'zhhn/+', 'kp23bhcpmt91n2v8/+'];
const client = mqtt.connect('mqtts://' + HOST + ':8883', { username: USER, password: PASS, clientId: 'rmcheck-' + Date.now(), reconnectPeriod: 0 });
const hits = [];
client.on('message', (t, m, pkt) => hits.push((pkt && pkt.retain ? '[保留] ' : '[实时] ') + t + '  ' + m.length + 'B  ' + m.toString().slice(0, 140)));

client.on('connect', async () => {
  console.log('逐个订阅（订阅瞬间若有保留消息会立即推送）：\n');
  for (const f of filters) {
    const before = hits.length;
    const g = await new Promise(r => client.subscribe(f, { qos: 1 }, (e) => r(e)));
    await new Promise(r => setTimeout(r, 1200));
    const got = hits.length - before;
    console.log((g ? ' 失败' : ' 可用') + '  ' + f.padEnd(20) + ' 订阅后立即收到 ' + got + ' 条' + (g ? '  ' + g.message : ''));
  }
  console.log('\n再观察 40 秒实时报文…');
  await new Promise(r => setTimeout(r, 40000));
  if (hits.length) {
    console.log('共收到 ' + hits.length + ' 条：');
    hits.slice(0, 30).forEach(h => console.log('  · ' + h));
  } else {
    console.log('没有任何保留消息，也没有实时报文');
  }
  client.end(true, () => process.exit(0));
});
client.on('error', e => { console.error('错误：' + e.message); process.exit(1); });
