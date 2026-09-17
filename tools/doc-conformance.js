#!/usr/bin/env node
/* ============================================================
 * 《晶农EMS的MQTT通讯协议》文档符合性验证（真实公网 broker）
 *
 * 思路：不使用任何模拟设备数据，只用【文档原文的示例 payload】，
 *       在真实 broker 上按文档规定的发布者/订阅者方向逐条收发，
 *       验证文档里定义的全部 Topic 链路是否真的走得通。
 *
 * 用法：node doc-conformance.js [brokerUrl] [SN]
 *   默认 mqtt://test.mosquitto.org:1883（公网真实 broker）
 * ============================================================ */
'use strict';
const mqtt = require('mqtt');

const URL = process.argv[2] || 'mqtt://test.mosquitto.org:1883';
const SN = process.argv[3] || ('SNCHK' + Math.random().toString(16).slice(2, 8).toUpperCase());
const USER = process.argv[4] || process.env.MQTT_USER || '';
const PASS = process.argv[5] || process.env.MQTT_PASS || '';
const now = () => Math.floor(Date.now() / 1000);
const T = t => 'zhhn/' + t + '/' + SN;

/* ---------- 文档原文示例 payload（逐字抄录） ---------- */
const DOC = {
  loginReq: '{ "identifier": "Login", "vendor": "zhhn", "time": 1662001903 }',
  loginRsp: '{ "identifier": "Login", "result": 1, "time": 1662001903 }',
  periodReport: `{
    "identifier": "PeriodReport",
    "SN": "SN21881FFF0001",
    "data":[
      { "deviceType": "系统参数", "tags": {
          "SN": "SN21881FFF0001", "CpuUsage": "48",
          "DiskSpace"： "232348", "UnuserdSpace"： "789222222",
          "netIp"： "123.2.3.36", "SignalStrength"： "16",
          "Ccid"： "2323485622233D66", "version"： "工控机版V1.6",
      } },
      { "deviceType": "PCS", "tags": { "AphaseVoltage": "233.8", "BphaseVoltage": "240.1" } },
      { "deviceType": "BMS", "tags": { "SysTotalVol": "707.1", "SysTotalCur": "60.3" } },
      "time": 1662001903
    ] }`,
  devDataReq: '{ "identifier": "DevData", "sn": "21881FFF0001", "time": 1662001903 }',
  devDataRsp: '{ "identifier": "PeriodReport", "SN": "SN21881FFF0001", "data":[], "time": 1662001903 }',
  emsSetReq: `{
    "identifier": "EmsSet",
    "Tag":[{ "deviceTag":"PCS", "wayName":"下设充电/放电功率", "varValue":"25"，
      }, { "deviceTag":"PCS", "wayName":"模块主机设置", "varValue":"1"，
      },]
    "time": 1662001903 }`,
  emsSetRsp: '{ "identifier": "EmsSet", "result": 1, "errormsg": "", "time": 1662001903 }',
  devInforReq: '{ "identifier": "DeviceInfor", "sn": "21881FFF0001", "msgId":"命令唯一Id", "time": 1662001903 }',
  devInforRsp: `{
    "identifier": "DeviceInfor", "SN": "SN21881FFF0001", "msgId":"命令唯一Id",
    "data":[ { "DeviceName": "EMS", "DeviceTag": "EMS", "DeviceManufacturer"： "中和汇能", "DeviceCode"： "1.6" } ]
    "time": 1662001903 }`,
  userInforReq: '{ "identifier": "UserInfor", "username": "zhhn", "password": "123456", "msgId":"命令唯一Id", "time": 1662001903 }',
  userInforRsp: `{
    "identifier": "UserInfor", "msgId":"命令唯一Id",
    "data":[ { "UserName": "用户", "DeviceName": "电站名称", "DeviceName": "储能电站设备1", "SN": "SN1233233343333" } ]
    "time": 1662001903 }`
};

/* 文档示例的“可解析修复版”：仅修正全角标点/多余逗号/缺失逗号，不改语义 */
function repair(s) {
  return s
    .replace(/：/g, ':').replace(/，/g, ',')
    .replace(/,\s*([}\]])/g, '$1')          // 去掉多余逗号
    .replace(/(\]|")\s*\n\s*"time"/g, '$1,\n"time"'); // 补 data 数组后缺失的逗号
}

const results = [];
function rec(r, name, detail) { results.push({ r, name, detail }); }

/* ============================================================
 * 第一部分：文档示例 payload 是否可直接使用
 * ============================================================ */
function part1() {
  console.log('\n===== 一、文档示例 payload 能否被标准 JSON 解析 =====');
  Object.keys(DOC).forEach(function (k) {
    let strict = true, msg = '';
    try { JSON.parse(DOC[k]); } catch (e) { strict = false; msg = e.message; }
    let rep = true;
    try { JSON.parse(repair(DOC[k])); } catch (e) { rep = false; }
    let struct = '—';
    if (k === 'periodReport') struct = DOC[k].indexOf('"time"') > -1 && DOC[k].lastIndexOf('"time"') > DOC[k].lastIndexOf(']') ? 'time 位于 data 数组内（结构错误）' : '—';
    const r = strict ? 'PASS' : 'FAIL';
    rec(r, '文档示例·' + k, strict ? '原样合法' : '原样非法：' + msg.slice(0, 48) + '｜修复后=' + rep + '｜' + struct);
    console.log('  [' + (strict ? '通过' : '失败') + '] ' + k.padEnd(16) + ' ' + (strict ? '原样即合法 JSON' : '原样非法 JSON → ' + msg.slice(0, 52)));
    if (struct !== '—') console.log('           ⚠ ' + struct);
  });
}

/* ============================================================
 * 第二部分：真实 broker 上按文档逐条走链路
 * ============================================================ */
const client = mqtt.connect(URL, {
  clientId: 'doccheck-' + Math.random().toString(16).slice(2, 10),
  connectTimeout: 10000, reconnectPeriod: 0,
  username: USER || undefined, password: PASS || undefined
});
const inbox = [];
client.on('message', (topic, buf) => inbox.push({ topic, text: buf.toString(), at: Date.now() }));
client.on('close', () => console.log('[诊断] 连接被关闭 ' + new Date().toTimeString().slice(0, 8)));
client.on('offline', () => console.log('[诊断] 连接离线 ' + new Date().toTimeString().slice(0, 8)));
client.on('disconnect', (p) => console.log('[诊断] 收到 DISCONNECT ' + JSON.stringify(p && p.reasonCode)));
client.on('error', (e) => console.log('[诊断] 连接错误 ' + e.message));

function sub(topics) {
  return new Promise(r => client.subscribe(topics, { qos: 1 }, r));
}
/* EMQX Cloud Serverless 单客户端最多 10 个订阅，每条链路验完即退订，避免越限静默丢消息 */
function unsub(topics) {
  return new Promise(r => client.unsubscribe(topics, () => r()));
}
function waitMsg(topic, ms, fromIndex) {
  const t0 = Date.now();
  return new Promise((res, rej) => {
    (function loop() {
      const hit = inbox.slice(fromIndex || 0).find(m => m.topic === topic);
      if (hit) return res(hit);
      if (Date.now() - t0 > ms) return rej(new Error('超时未收到 ' + topic));
      setTimeout(loop, 200);
    })();
  });
}
function pub(topic, payload) {
  return new Promise(r => client.publish(topic, payload, { qos: 1 }, () => setTimeout(r, 400)));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 一条链路：订阅者先订阅 → 发布者发文档原样 payload → 校验到达与合法性 */
async function hop(desc, pubTopic, subTopic, payloadKey, useRepaired) {
  const payload = useRepaired ? repair(DOC[payloadKey]) : DOC[payloadKey];
  await sub(subTopic);
  await sleep(500);
  const before = inbox.length;
  console.log('         [诊断] 发布前连接状态: ' + (client.connected ? '已连接' : '已断开'));
  await pub(pubTopic, payload);
  try {
    const m = await waitMsg(subTopic, 12000, before);
    let parsed = null, valid = false;
    try { parsed = JSON.parse(m.text); valid = true; } catch (_) {}
    const idOk = valid && parsed.identifier === payloadKey.replace(/(Req|Rsp)$/, '').replace(/^login$/, 'Login');
    rec('PASS', desc, '发布 ' + pubTopic + ' → 订阅 ' + subTopic + ' 收到 ' + m.text.length + 'B，JSON=' + (valid ? '合法' : '非法'));
    console.log('  [通过] ' + desc);
    console.log('         发布 ' + pubTopic);
    console.log('         订阅 ' + subTopic + ' → 收到 ' + m.text.length + ' 字节，JSON ' + (valid ? '合法' : '非法'));
    await unsub(subTopic);
    return { m, parsed, valid };
  } catch (e) {
    rec('FAIL', desc, e.message + '（发布 ' + pubTopic + ' → 订阅 ' + subTopic + '）');
    console.log('  [失败] ' + desc + ' —— ' + e.message);
    await unsub(subTopic);
    return null;
  }
}

client.on('connect', async function () {
  console.log('\n真实 broker 连接成功：' + URL + '　（客户端 ' + client.options.clientId + '，测试 SN=' + SN + '）');

  console.log('\n===== 二、文档定义的链路在真实 broker 上逐条验证 =====');

  /* 1. 登录：EMS → 云平台 */
  await hop('① 登录请求 EMS→云平台（Post/Login/SN）', T('Post/Login'), T('Post/Login'), 'loginReq');
  /* 登录应答：云平台 → EMS */
  await hop('② 登录应答 云平台→EMS（PostRsp/Login/SN）', T('PostRsp/Login'), T('PostRsp/Login'), 'loginRsp');
  /* 2. 周期上报 */
  await hop('③ 周期上报 EMS→云平台（Post/PeriodReport/SN）· 文档原样 payload', T('Post/PeriodReport'), T('Post/PeriodReport'), 'periodReport');
  await hop('④ 周期上报 · 修正标点后 payload', T('Post/PeriodReport'), T('Post/PeriodReport'), 'periodReport', true);
  /* 3. 召测 */
  await hop('⑤ 召测请求 云平台→EMS（Get/DevData/SN）', T('Get/DevData'), T('Get/DevData'), 'devDataReq');
  await hop('⑥ 召测应答 EMS→云平台（GetRsp/DevData/SN）', T('GetRsp/DevData'), T('GetRsp/DevData'), 'devDataRsp');
  /* 4. 通道下发 */
  await hop('⑦ 通道下发 云平台→EMS（Set/EmsSet/SN）· 文档原样 payload', T('Set/EmsSet'), T('Set/EmsSet'), 'emsSetReq');
  await hop('⑧ 通道下发 · 修正标点后 payload', T('Set/EmsSet'), T('Set/EmsSet'), 'emsSetReq', true);
  await hop('⑨ 下发应答 EMS→云平台（SetRsp/EmsSet/SN）', T('SetRsp/EmsSet'), T('SetRsp/EmsSet'), 'emsSetRsp');
  /* 6. 设备信息 */
  await hop('⑩ 设备信息请求 云平台→EMS（Get/DeviceInfor/SN）', T('Get/DeviceInfor'), T('Get/DeviceInfor'), 'devInforReq');
  await hop('⑪ 设备信息应答 EMS→云平台（GetRsp/DeviceInfor/SN）· 文档原样 payload', T('GetRsp/DeviceInfor'), T('GetRsp/DeviceInfor'), 'devInforRsp');
  await hop('⑫ 设备信息应答 · 修正标点后 payload', T('GetRsp/DeviceInfor'), T('GetRsp/DeviceInfor'), 'devInforRsp', true);
  /* 7. 站点信息（应答 Topic 无 SN 后缀） */
  await hop('⑬ 站点信息请求 EMS桌面版→EMS（Get/UserInfor/SN）', T('Get/UserInfor'), T('Get/UserInfor'), 'userInforReq');
  await hop('⑭ 站点信息应答 EMS→云平台（GetRsp/UserInfor，无 SN 后缀）', 'zhhn/GetRsp/UserInfor', 'zhhn/GetRsp/UserInfor', 'userInforRsp', true);

  /* ---------- 汇总 ---------- */
  console.log('\n===== 三、验证汇总 =====');
  const c = { PASS: 0, FAIL: 0 };
  results.forEach(x => c[x.r]++);
  console.log('链路/报文检查：通过 ' + c.PASS + ' 项，失败 ' + c.FAIL + ' 项');
  const fails = results.filter(x => x.r === 'FAIL');
  if (fails.length) {
    console.log('\n未通过项：');
    fails.forEach(f => console.log('  · ' + f.name + ' —— ' + f.detail));
  }
  console.log('\n结论：文档定义的 Topic 链路在真实 broker 上' + (results.filter(x => x.r === 'FAIL' && /发布|超时/.test(x.detail)).length === 0 ? '全部可达' : '存在不可达项'));
  client.end(true, () => process.exit(0));
});

client.on('error', e => { console.error('broker 连接失败：' + e.message); process.exit(1); });

part1();
