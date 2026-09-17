'use strict';
/* 测试 EMQX Cloud 允许哪些订阅通配符，并用可用的过滤器观察数据 */
const mqtt = require('mqtt');
const HOST = process.argv[2], USER = process.argv[3], PASS = process.argv[4];
const filters = [
  '#',
  '+/+/#',
  '+/#',
  '/#',
  '/kp23bhcpmt91n2v8/#',
  'kp23bhcpmt91n2v8/#',
  'zhhn/#',
  'zhhn/Post/PeriodReport/+'
];
const client = mqtt.connect('mqtts://' + HOST + ':8883', { username: USER, password: PASS, clientId: 'filtertest-' + Date.now(), reconnectPeriod: 0 });
const hits = [];
client.on('message', (t, m) => hits.push(t + '  ' + m.length + 'B  ' + m.toString().slice(0, 120)));

client.on('connect', async () => {
  console.log('已连接，逐个测试订阅过滤器：\n');
  for (const f of filters) {
    const g = await new Promise(r => client.subscribe(f, { qos: 1 }, (e, granted) => r({ e, granted })));
    const code = g.granted && g.granted[0] ? g.granted[0].qos : '?';
    console.log((g.e ? ' 失败' : ' 可用') + '  ' + f.padEnd(28) + ' qos=' + code + (g.e ? '  ' + g.e.message : ''));
  }
  console.log('\n观察 25 秒，看有没有任何报文进来…');
  await new Promise(r => setTimeout(r, 25000));
  if (hits.length) {
    console.log('收到 ' + hits.length + ' 条报文：');
    hits.slice(0, 20).forEach(h => console.log('  · ' + h));
  } else {
    console.log('25 秒内没有收到任何报文');
  }
  client.end(true, () => process.exit(0));
});
client.on('error', e => { console.error('错误：' + e.message); process.exit(1); });
