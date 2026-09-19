#!/usr/bin/env node
/* ============================================================
 * 高特 CCU 模拟器（按项目协议文档 SJ2025B3781ESCCU-MQTT 上报）
 *
 * 报文格式：JSON，KEY 为数字索引（见 js/gaote-points.js）
 * 主题：/{ProductSN}/{DeviceSN}/rtg/data|status/{维度}[/{堆}/{簇}/{设备号}][/extend/{型号}]
 * 周期：默认 30 秒（与协议一致，可调）
 *
 * 用法：
 *   node ccu-simulator.js --url mqtt://127.0.0.1:1884 \
 *        --username <用户名> --password <密码> \
 *        --psn kp23bhcpmt91n2v8 --dsn SN2025B3781TEST --interval 30 --arr 5 --cells 8
 * ============================================================ */
'use strict';
const mqtt = require('mqtt');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i]] = process.argv[i + 1] || '';
const OPT = {
  url: args['--url'] || 'mqtt://127.0.0.1:1884',
  username: args['--username'] || '',
  password: args['--password'] || '',
  psn: args['--psn'] || 'kp23bhcpmt91n2v8',
  dsn: args['--dsn'] || 'SN2025B3781TEST',
  interval: parseInt(args['--interval'] || '30', 10) * 1000,
  arrCount: parseInt(args['--arr'] || '5', 10),
  cells: parseInt(args['--cells'] || '8', 10)
};

const ts = () => Math.floor(Date.now() / 1000);
const log = (...a) => console.log(new Date().toTimeString().slice(0, 8), '|', ...a);
const T = path => '/' + OPT.psn + '/' + OPT.dsn + '/' + path;

/* 以 10 分钟为周期的充放电功率（负=充电 正=放电，与协议一致：正放负充） */
let t0 = Date.now();
function power() {
  const ph = ((Date.now() - t0) % 600000) / 600000 * Math.PI * 2;
  return +(120 * Math.sin(ph)).toFixed(1);
}
function soc() {
  const ph = ((Date.now() - t0) % 3600000) / 3600000 * Math.PI * 2;
  return +(78 + 8 * Math.sin(ph) - power() / 8000).toFixed(1);
}
const jit = (b, p) => +(b + b * p * (Math.random() - 0.5)).toFixed(1);

function frames() {
  const p = power();
  const s = soc();
  const out = [];
  const now = ts();

  /* EMU：系统汇总 */
  out.push([T('rtg/data/emu'), {
    1: p, 2: jit(8, 0.4), 3: jit(710, 0.01), 4: +(p / 0.71).toFixed(1), 5: s,
    7: OPT.arrCount * OPT.cells, 8: jit(27, 0.05), 10: 3.312, 11: 3.245,
    16: 250, 17: 250, 19: 1, 20: 180, 21: 150, 22: now,
    23: 0, 24: 2, 26: Math.abs(p) < 5 ? 0 : (p < 0 ? 1 : 2)
  }]);
  /* 4G 信息：给「系统参数」板块用 */
  out.push([T('rtg/data/t4GInfo'), {
    1: '已插入', 2: 'SIMCOM', 3: 'A7670C', 4: 'V1.2.3', 5: '861234567890123',
    6: '89860121802209000000', 10: '已注册', 11: 'LTE', 14: Math.round(jit(85, 0.2)), 15: '10.12.33.7', 16: now
  }]);
  /* EMS 本体：SN/版本 */
  out.push([T('rtg/data/ems'), { 0: 1, 1: 'EMS-125K261K', 2: OPT.dsn, 3: 'V1.7.5', 4: '89860121802209000000', 5: 'Asia/Shanghai' }]);

  for (let a = 0; a < OPT.arrCount; a++) {
    const pa = p / OPT.arrCount;
    /* 堆 */
    out.push([T('rtg/data/array/' + a + '/-1/0'), {
      0: a, 1: a, 2: Math.abs(pa) < 1 ? 0 : 1, 3: 1,
      17: jit(710 + a, 0.005), 18: +(pa / 0.71).toFixed(1), 19: s, 20: 99,
      27: jit(0.06, 0.3), 28: 3.312, 29: 3.245, 30: jit(4.5, 0.2), 31: jit(31 + a * 0.3, 0.05), 32: jit(26, 0.05),
      39: 120, 40: 120, 47: now
    }]);
    /* 簇（每堆 1 簇） */
    out.push([T('rtg/data/cluster/' + a + '/-1/0'), {
      0: a, 1: a, 2: 0, 3: s, 4: 99, 5: Math.abs(pa) < 1 ? 0 : (pa < 0 ? 2 : 1),
      6: jit(710 + a, 0.005), 7: +(pa / 0.71).toFixed(1),
      8: 3.312, 9: 3.245, 10: jit(31 + a * 0.3, 0.05), 11: jit(26, 0.05),
      16: jit(5200, 0.05), 17: jit(5100, 0.05), 18: 8, 19: 2, 20: 3, 21: 6,
      31: pa, 32: 52341, 33: 48112, 34: 120 + a, 35: 98 + a, 36: 180, 37: 150, 38: now
    }]);
    /* PCS 变流器 */
    out.push([T('rtg/data/pcs/' + a + '/-1/0'), {
      0: a, 1: a, 2: 0, 3: 0, 4: now,
      110010024: +(pa * 0.98).toFixed(1), 110010025: +(pa / 0.71).toFixed(1),
      110010043: jit(233, 0.01), 110010044: jit(235, 0.01), 110010045: jit(231, 0.01),
      110010049: +(pa / 3).toFixed(1), 110010050: +(pa / 3).toFixed(1), 110010051: +(pa / 3).toFixed(1),
      110010052: jit(4, 0.4), 110010053: jit(4, 0.4), 110010054: jit(4, 0.4),
      110010055: +(Math.abs(pa) / 3).toFixed(1), 110010056: +(Math.abs(pa) / 3).toFixed(1), 110010057: +(Math.abs(pa) / 3).toFixed(1),
      110010058: 0.998, 110010059: 0.998, 110010060: 0.998,
      110010061: pa, 110010062: jit(8, 0.4), 110010063: +Math.abs(pa).toFixed(1), 110010064: 0.998,
      110010068: +(50 + (Math.random() - 0.5) * 0.04).toFixed(2),
      110010069: 120.5 + a, 110010070: 98.2 + a, 110010071: 52341, 110010072: 48112,
      110010076: 0, 110010078: Math.abs(pa) < 1 ? 0 : (pa < 0 ? 1 : 2), 110010083: Math.abs(pa) < 1 ? 5 : 257,
      110010089: jit(38, 0.1), 110010090: jit(26, 0.1), 110010109: jit(710, 0.005),
      110010110: jit(710, 0.005), 110010111: +(pa / 0.71).toFixed(1),
      110010119: 1260 + a, 110010120: 1010 + a
    }]);
    /* 液冷 */
    out.push([T('rtg/data/liqcool/' + a + '/-1/0/extend/blackshields-comm-g1'), {
      0: a, 1: a, 2: 0, 3: 0, 4: now,
      110040010: 1, 110040011: 1, 110040012: 0, 110040014: jit(24.6, 0.04), 110040015: jit(28.9, 0.04),
      110040016: jit(2.1, 0.05), 110040018: jit(26, 0.05), 110040021: 0, 110040088: jit(42, 0.05),
      110040091: jit(2.4, 0.05), 110040092: 2, 110040151: Math.round(jit(2100, 0.1))
    }]);
    /* 除湿机 / 消防 */
    out.push([T('rtg/data/drier/' + a + '/-1/0/extend/sanda-sdcs-v5'), {
      0: a, 1: a, 2: 0, 3: 0, 4: now,
      110100002: Math.round(jit(55, 0.15)), 110100003: Math.round(jit(27, 0.1)),
      110100010: 1, 110100014: 0
    }]);
    out.push([T('rtg/data/fire/' + a + '/-1/0/extend/zhta-v1-v4'), {
      0: a, 1: a, 2: 0, 3: 0, 4: now,
      110020006: 2, 110020007: 1, 110020186: 3, 110020392: 0, 110020393: Math.round(jit(26, 0.1))
    }]);
    /* 单体（每堆若干节，便于电芯热力图显示） */
    for (let c = 1; c <= OPT.cells; c++) {
      const v = 3.28 + 0.02 * Math.sin(c * 0.7 + a) + (Math.random() - 0.5) * 0.004;
      out.push([T('rtg/data/cell/' + a + '/-1/' + c), {
        0: a, 1: a, 2: -1, 3: +v.toFixed(3), 4: +(27 + 2 * Math.sin(c * 0.5) + Math.random()).toFixed(1),
        5: s, 6: 99, 7: now
      }]);
    }
  }

  /* 电表：AEMS 储能计量 / LEMS 防逆流 */
  out.push([T('rtg/data/meter/aems/storage/-1/-1/0/extend/acrel-dtsd1352-model'), {
    0: 0, 1: -1, 2: -1, 3: 0, 4: now,
    110110004: 50.01, 110110005: jit(233, 0.01), 110110006: jit(235, 0.01), 110110007: jit(231, 0.01),
    110110008: +(Math.abs(p) / 3 / 0.233).toFixed(2), 110110009: +(Math.abs(p) / 3 / 0.233).toFixed(2), 110110010: +(Math.abs(p) / 3 / 0.233).toFixed(2),
    110110014: +(p / 3).toFixed(1), 110110015: +(p / 3).toFixed(1), 110110016: +(p / 3).toFixed(1),
    110110017: p, 110110018: 4, 110110019: 4, 110110020: 4, 110110021: 12.0,
    110110025: +Math.abs(p).toFixed(1), 110110029: 0.998,
    110110066: 523411.2, 110110067: 481122.9
  }]);
  out.push([T('rtg/data/meter/lems/antireflux/-1/-1/1/extend/acrel-adl400-v13'), {
    0: 0, 1: -1, 2: -1, 3: 1, 4: now,
    110110004: 50.01, 110110005: jit(234, 0.01), 110110006: jit(236, 0.01), 110110007: jit(232, 0.01),
    110110008: 427.35, 110110009: 427.35, 110110010: 427.35,
    110110014: 1258340.6, 110110017: +(p + 300).toFixed(1), 110110021: 45.2, 110110025: 302.4, 110110029: 0.989,
    110110066: 1258340.6, 110110067: 982213.4
  }]);

  /* 遥信（状态）示例：PCS / 簇 / 液冷 / 消防 的状态帧 */
  out.push([T('rtg/status/pcs/0/-1/0'), { 1: 0, 2: 0, 3: 5 }]);
  out.push([T('rtg/status/cluster/0/-1/0'), { 1: 0, 2: 0 }]);
  out.push([T('rtg/status/liqcool/0/-1/0/extend/blackshields-comm-g1'), { 1: 0, 2: 0, 3: 0 }]);
  out.push([T('rtg/status/fire/0/-1/0/extend/zhta-v1-v4'), { 1: 0, 2: 0 }]);

  return out;
}

const client = mqtt.connect(OPT.url, {
  username: OPT.username || undefined, password: OPT.password || undefined,
  clientId: 'ccu-sim-' + Math.random().toString(16).slice(2, 8),
  keepalive: 30, reconnectPeriod: 5000, connectTimeout: 10000
});

let timer = null;
function publishAll() {
  const fs2 = frames();
  let bytes = 0;
  fs2.forEach(([topic, payload]) => {
    const text = JSON.stringify(payload);
    bytes += text.length;
    client.publish(topic, text, { qos: 1 });
  });
  log('已上报 ' + fs2.length + ' 帧　约 ' + (bytes / 1024).toFixed(1) + ' KB　功率=' + power() + ' kW　SOC=' + soc() + '%');
}

client.on('connect', () => {
  log('已连接 ' + OPT.url + '　ProductSN=' + OPT.psn + '　DeviceSN=' + OPT.dsn);
  client.subscribe('/' + OPT.psn + '/' + OPT.dsn + '/cmd/set/#', { qos: 1 }, (e) => {
    if (e) log('订阅下发主题失败：' + e.message);
    else log('已订阅下发主题，等待平台指令');
  });
  publishAll();
  clearInterval(timer);
  timer = setInterval(publishAll, OPT.interval);
});

/* 模拟真机：收到 cmd/set 后立即回读 cmd/get（协议手册 4.3：设备处理后触发上送结果） */
client.on('message', (topic, buf) => {
  if (topic.indexOf('/cmd/set/') < 0) return;
  let p = {};
  try { p = JSON.parse(buf.toString()); } catch (_) {}
  log('收到下发指令 ' + topic + '　' + JSON.stringify(p).slice(0, 200));
  const rspTopic = topic.replace('/cmd/set/', '/cmd/get/');
  setTimeout(() => {
    client.publish(rspTopic, JSON.stringify(p), { qos: 1 });
    log('已回读 ' + rspTopic);
  }, 1000);
});
client.on('error', e => log('错误：' + e.message));
client.on('close', () => log('连接断开，重连中…'));
process.on('SIGINT', () => { clearInterval(timer); client.end(true); process.exit(0); });
