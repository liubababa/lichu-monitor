'use strict';
/* 本地链路验证：WS 9001（网页用）和 TCP 1884（设备用）两条通道各收 12 秒 */
const mqtt = require('mqtt');

function probe(name, url) {
  return new Promise(resolve => {
    const topics = new Set();
    let n = 0;
    const c = mqtt.connect(url, { clientId: 'probe-' + Math.random().toString(16).slice(2, 8), connectTimeout: 8000, reconnectPeriod: 0 });
    let connected = false;
    c.on('connect', () => { connected = true; c.subscribe('/#', { qos: 1 }, () => c.subscribe('zhhn/#', { qos: 1 }, () => {})); });
    c.on('message', (t, m) => { n++; topics.add(t); if (n === 1) console.log('   [' + name + '] 首帧 ' + t + '  ' + m.toString().slice(0, 80)); });
    c.on('error', e => console.log('   [' + name + '] 错误: ' + e.message));
    setTimeout(() => {
      console.log('   [' + name + '] ' + (connected ? '已连接' : '❌ 连不上') + '，12 秒收到 ' + n + ' 条 / ' + topics.size + ' 个主题');
      c.end(true);
      resolve({ name, connected, n, topics: topics.size });
    }, 12000);
  });
}

(async () => {
  console.log('== 本地两条通道实测 ==');
  await probe('WS 9001', 'ws://127.0.0.1:9001/mqtt');
  await probe('TCP 1884', 'mqtt://127.0.0.1:1884');
  console.log('== 完 ==');
  process.exit(0);
})();
