'use strict';
/* 东方日升（Risen）工商业储能柜 · Modbus TCP 探测：只读 0x03，不发送任何写指令
   注意：这条链路只针对东方日升的储能柜（柜内 EMS 控制器点表自称「金盾 / Golden Shield」），
         与阳光电源（光伏，tools/solar-service.js）是两家厂商、两类设备，两者无任何共用参数。

   用途：在能连到柜子网口的电脑上跑一遍，确认「能不能读到、数值和单位对不对」
   用法：
     node tools/risen-probe.js                     # 默认 192.168.1.136:502，从站号 1
     node tools/risen-probe.js --unit 2
     node tools/risen-probe.js --all-units         # 依次试从站号 1 / 2 / 255 / 0
     node tools/risen-probe.js --offset 1          # 地址整体 +1（有的设备按 4xxxx 计）
     node tools/risen-probe.js --raw               # 只打原始值，不做换算
     node tools/risen-probe.js --host 10.0.0.9 --port 502

   点表依据：refs/东方日升-金盾EMS对外点表-V6.3.xlsx（Add(Dec) 栏即寄存器号，0 基）
*/
const net = require('net');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].slice(0, 2) !== '--') continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    out[key] = next && next.slice(0, 2) !== '--' ? argv[++i] : true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const HOST = args.host || '192.168.1.136';
const PORT = parseInt(args.port || '502', 10);
const UNIT = parseInt(args.unit || '1', 10);
const OFFSET = parseInt(args.offset || '0', 10);
const RAW = !!args.raw;
const TIMEOUT = 3000;

const EXC = {
  1: '非法功能码（设备不支持读保持寄存器）',
  2: '非法地址（地址超出设备支持范围）',
  3: '非法数据值',
  4: '从站故障',
  5: '确认',
  6: '从站忙（可能连接数已满）',
  11: '网关目标设备无响应'
};

const ENUMS = {
  sysState: { 0: '待机', 1: '放电', 2: '充电' },
  subCmd: { 1: '运行', 2: '待机', 3: '关机' },
  subState: { 0: '自检', 1: '待机', 2: '启动', 3: '运行', 4: '停止', 5: '故障', 6: '关机' },
  pcsState: { 1: '待机', 2: '自检', 3: '并网', 4: '离网', 5: '故障' },
  pcsMode: { 0: '并网', 1: '离网', 2: 'VSG', 3: '并网下垂', 4: '离网下垂', 5: '自动并离网', 6: '本地优先', 7: '限制并网', 8: '经济模式' },
  online: { 0: '离网', 1: '并网' },
  runStop: { 0: '停', 1: '起' },
  onOff: { 0: '关闭', 1: '开启' }
};

const BITS = {
  subFault: {
    0: 'PCS通信故障', 1: 'BCU通信故障', 2: 'BCU故障', 3: 'PCS故障1',
    6: '外部电表通信故障', 7: '绝缘检测故障', 8: 'PCS故障2', 9: '云通信故障'
  },
  pcsAlarm1: {
    0: '环境温度告警', 1: '需要除霜', 2: '交流侧柜门打开', 3: '直流侧柜门打开',
    4: '机内空调告警', 5: 'BMS告警', 6: 'BMS降频', 7: '辅助电源异常',
    8: 'EMS通信故障', 9: 'BMS通信故障'
  }
};

/* t: u16 / i16 / u32(低字在 lo)；k: 缩放；u: 单位；e: 枚举；b: 位；q: 缩放待确认 */
const BLOCKS = [
  {
    name: '系统总览', start: 1024, count: 38, points: [
      { a: 1024, n: '总电压', k: 0.1, u: 'V' },
      { a: 1025, n: '总电流', k: 0.1, u: 'A' },
      { a: 1026, n: '系统状态', e: ENUMS.sysState },
      { a: 1027, n: '平均温度', k: 0.1, u: '℃' },
      { a: 1028, n: '最高温度', k: 0.1, u: '℃' },
      { a: 1029, n: '最低温度', k: 0.1, u: '℃' },
      { a: 1030, n: '额定电量', k: 0.1, u: 'kWh' },
      { a: 1031, n: '剩余电量', k: 0.1, u: 'kWh' },
      { a: 1032, n: '日充电量', k: 0.1, u: 'kWh' },
      { a: 1033, n: '日放电量', k: 0.1, u: 'kWh' },
      { a: 1034, n: '累计充电量', t: 'u32', lo: 1035, k: 0.1, u: 'kWh' },
      { a: 1036, n: '累计放电量', t: 'u32', lo: 1037, k: 0.1, u: 'kWh' },
      { a: 1038, n: '交流总有功功率', k: 0.1, u: 'kW' },
      { a: 1039, n: '电网功率', t: 'i16', k: 0.1, u: 'kW' },
      { a: 1040, n: '负载功率', k: 0.1, u: 'kW' },
      { a: 1041, n: '日取电量', k: 0.1, u: 'kWh' },
      { a: 1042, n: '日馈电量', k: 0.1, u: 'kWh' },
      { a: 1056, n: '汇总SOC', q: true, u: '%' },
      { a: 1057, n: '策略整体状态', e: ENUMS.onOff },
      { a: 1060, n: '并离网状态', e: ENUMS.online },
      { a: 1061, n: '起停状态', e: ENUMS.runStop }
    ]
  },
  {
    name: '子系统1（柜1）', start: 304, count: 10, points: [
      { a: 304, n: '开关机指令', e: ENUMS.subCmd },
      { a: 305, n: '有功功率设定', t: 'i16', k: 0.1, u: 'kW' },
      { a: 306, n: '故障位', b: BITS.subFault },
      { a: 308, n: '运行状态', e: ENUMS.subState }
    ]
  },
  {
    name: '电池簇1', start: 4096, count: 48, points: [
      { a: 4096, n: '簇总电压', k: 0.1, u: 'V' },
      { a: 4097, n: '簇总电流', t: 'i16', k: 0.1, u: 'A' },
      { a: 4098, n: '簇SOC', q: true, u: '%' },
      { a: 4099, n: '簇SOH', q: true, u: '%' },
      { a: 4100, n: '簇SOE', k: 0.01, u: 'kWh' },
      { a: 4112, n: '最大允许放电电流', k: 0.1, u: 'A' },
      { a: 4113, n: '最大允许放电功率', k: 0.1, u: 'kW' },
      { a: 4114, n: '最大允许充电电流', k: 0.1, u: 'A' },
      { a: 4115, n: '最大允许充电功率', k: 0.1, u: 'kW' },
      { a: 4116, n: '正极绝缘阻值', u: 'KΩ' },
      { a: 4117, n: '负极绝缘阻值', u: 'KΩ' },
      { a: 4120, n: '最高单体电压', k: 0.001, u: 'V' },
      { a: 4121, n: '最高单体电压从机号' },
      { a: 4123, n: '最低单体电压', k: 0.001, u: 'V' },
      { a: 4126, n: '平均温度', t: 'i16', k: 0.1, u: '℃' },
      { a: 4128, n: '最高单体温度', t: 'i16', k: 0.1, u: '℃' },
      { a: 4131, n: '最低单体温度', t: 'i16', k: 0.1, u: '℃' }
    ]
  },
  {
    name: 'PCS1', start: 24576, count: 26, points: [
      { a: 24576, n: '运行状态', e: ENUMS.pcsState },
      { a: 24583, n: 'AB线电压', t: 'i16', k: 0.1, u: 'V' },
      { a: 24584, n: 'BC线电压', t: 'i16', k: 0.1, u: 'V' },
      { a: 24585, n: 'CA线电压', t: 'i16', k: 0.1, u: 'V' },
      { a: 24586, n: 'A相电流', t: 'i16', k: 0.1, u: 'A' },
      { a: 24587, n: 'B相电流', t: 'i16', k: 0.1, u: 'A' },
      { a: 24588, n: 'C相电流', t: 'i16', k: 0.1, u: 'A' },
      { a: 24589, n: '总有功功率', t: 'i16', k: 0.1, u: 'kW' },
      { a: 24590, n: '总无功功率', t: 'i16', k: 0.1, u: 'kVar' },
      { a: 24591, n: '总视在功率', t: 'i16', k: 0.1, u: 'kVA' },
      { a: 24592, n: '电网频率', k: 0.01, u: 'Hz' },
      { a: 24594, n: '功率因数', t: 'i16', k: 0.01 },
      { a: 24596, n: '散热器温度', t: 'i16', k: 0.1, u: '℃' },
      { a: 24597, n: '整机运行模式', e: ENUMS.pcsMode },
      { a: 24598, n: '环境温度', t: 'i16', k: 0.1, u: '℃' },
      { a: 24600, n: '整机告警码1', b: BITS.pcsAlarm1 }
    ]
  },
  {
    name: '内电表', start: 25858, count: 44, points: [
      { a: 25858, n: '正向总有功电能', t: 'u32', lo: 25859, k: 0.01, u: 'kWh' },
      { a: 25868, n: '反向总有功电能', t: 'u32', lo: 25869, k: 0.01, u: 'kWh' },
      { a: 25878, n: 'A相电压', k: 0.1, u: 'V' },
      { a: 25881, n: 'A相电流', k: 0.01, u: 'A' },
      { a: 25884, n: 'A相有功功率', t: 'i16', k: 0.1, u: 'kW' },
      { a: 25887, n: '总功率因数', t: 'i16', k: 0.001 },
      { a: 25888, n: '频率', k: 0.01, u: 'Hz' },
      { a: 25901, n: '总有功功率', t: 'i16', k: 0.1, u: 'kW' }
    ]
  },
  {
    name: '外电表', start: 26114, count: 45, points: [
      { a: 26114, n: '正向总有功电能', t: 'u32', lo: 26115, k: 0.01, u: 'kWh' },
      { a: 26124, n: '反向总有功电能', t: 'u32', lo: 26125, k: 0.01, u: 'kWh' },
      { a: 26134, n: 'A相电压', k: 0.1, u: 'V' },
      { a: 26137, n: 'A相电流', k: 0.01, u: 'A' },
      { a: 26144, n: '频率', k: 0.01, u: 'Hz' },
      { a: 26148, n: '电压变比PT' },
      { a: 26149, n: '电流变比CT' },
      { a: 26157, n: '总有功功率', t: 'u32', lo: 26158, k: 0.1, u: 'kW' }
    ]
  }
];

let txId = 0;
function readBlock(sock, unit, start, count) {
  return new Promise((resolve, reject) => {
    const id = ++txId;
    const req = Buffer.alloc(12);
    req.writeUInt16BE(id, 0);
    req.writeUInt16BE(0, 2);
    req.writeUInt16BE(6, 4);
    req.writeUInt8(unit, 6);
    req.writeUInt8(3, 7);
    req.writeUInt16BE(start, 8);
    req.writeUInt16BE(count, 10);

    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => { cleanup(); reject(new Error('超时（' + TIMEOUT + 'ms 无响应）')); }, TIMEOUT);
    function cleanup() {
      clearTimeout(timer);
      sock.removeListener('data', onData);
      sock.removeListener('error', onError);
    }
    function onError(e) { cleanup(); reject(e); }
    function onData(d) {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 8) return;
      const len = buf.readUInt16BE(4);
      if (buf.length < 6 + len) return;
      cleanup();
      const func = buf.readUInt8(7);
      if (func & 0x80) {
        const code = buf.readUInt8(8);
        return reject(new Error('异常码 ' + code + '（' + (EXC[code] || '未知') + '）'));
      }
      const bytes = buf.readUInt8(8);
      const regs = [];
      for (let i = 0; i < bytes / 2; i++) regs.push(buf.readUInt16BE(9 + i * 2));
      resolve(regs);
    }
    sock.on('data', onData);
    sock.on('error', onError);
    sock.write(req);
  });
}

function fmt(point, regs, blkStart) {
  const i = point.a - blkStart;
  let raw;
  if (point.t === 'u32') raw = regs[i] * 65536 + regs[point.lo - blkStart];
  else raw = regs[i];
  const signed = point.t === 'i16' && raw > 32767 ? raw - 65536 : raw;
  if (RAW) return String(raw);
  if (point.b) {
    const hit = [];
    for (let b = 0; b < 16; b++) if (raw & (1 << b)) hit.push((point.b[b] || ('bit' + b)));
    return hit.length ? '位=> ' + hit.join('、') : '无';
  }
  if (point.e && point.e[raw] !== undefined) return raw + '  →  ' + point.e[raw];
  if (point.q) {
    return raw + '  →  ÷10=' + (raw / 10).toFixed(1) + '% / ÷100=' + (raw / 100).toFixed(2) +
      '% / ÷10000=' + (raw / 10000).toFixed(2) + '%   ← 缩放待厂家确认';
  }
  const scaled = point.k ? signed * point.k : signed;
  const text = Number.isInteger(scaled) ? scaled : parseFloat(scaled.toFixed(4));
  return raw + '  →  ' + text + (point.u ? ' ' + point.u : '');
}

function connect() {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: HOST, port: PORT });
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('连接超时')); }, TIMEOUT);
    sock.on('connect', () => { clearTimeout(timer); resolve(sock); });
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

function hint(err) {
  const m = err.message || String(err);
  if (/ECONNREFUSED/.test(m)) return '对方拒绝连接：IP 是通的，但 502 端口没开（或设备限制了来源 IP）';
  if (/ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|连接超时/.test(m)) return '网络不通：这台电脑和 ' + HOST + ' 不在同一网段，或路由/防火墙没放行';
  if (/ENOTFOUND/.test(m)) return '地址解析失败：主机名写错或没有 DNS';
  if (/EPERM|EACCES/.test(m)) return '系统拦截了这次连接（本机防火墙/杀软）';
  return m;
}

async function scanUnits() {
  for (const unit of [1, 2, 255, 0]) {
    let sock;
    try {
      sock = await connect();
      const regs = await readBlock(sock, unit, 1024 - 1, 2);
      console.log('从站号 ' + unit + ' 有响应：原始值 ' + regs.join(', ') + '（按总电压 ÷10 = ' + (regs[0] / 10) + ' V）');
    } catch (e) {
      console.log('从站号 ' + unit + ' 无响应：' + (e.message || e));
    } finally {
      if (sock) sock.destroy();
    }
  }
}

async function main() {
  console.log('== 金盾 Modbus TCP 探测 ' + HOST + ':' + PORT + ' 从站号 ' + UNIT +
    (OFFSET ? ' 地址偏移 ' + OFFSET : '') + ' ==');

  if (args['all-units']) {
    await scanUnits();
    return;
  }

  let sock;
  try {
    sock = await connect();
  } catch (e) {
    console.log('连接失败：' + hint(e));
    process.exit(1);
  }
  console.log('TCP 已连接，开始只读采集（0x03）...\n');

  let ok = 0;
  let bad = 0;
  for (const blk of BLOCKS) {
    const start = blk.start + OFFSET;
    process.stdout.write('-- ' + blk.name + '  [' + start + '~' + (start + blk.count - 1) + '] --\n');
    try {
      const regs = await readBlock(sock, UNIT, start, blk.count);
      for (const p of blk.points) {
        const label = '  ' + String(p.a).padEnd(6) + p.n;
        process.stdout.write(label.padEnd(34) + fmt(p, regs, blk.start) + '\n');
      }
      ok++;
    } catch (e) {
      bad++;
      process.stdout.write('  读取失败：' + (e.message || e) + '\n');
      if (/异常码 2/.test(e.message || '')) {
        process.stdout.write('  提示：地址被拒，试 --offset 1 / --offset -1，或换 --unit，或用 --all-units 扫一遍从站号\n');
      }
    }
    process.stdout.write('\n');
  }
  sock.destroy();
  console.log('读块成功 ' + ok + ' / 失败 ' + bad + '。能出合理数值（SOC、电压、温度在常识范围）就说明这条路通。');
}

main();
