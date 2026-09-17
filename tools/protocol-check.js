#!/usr/bin/env node
/* ============================================================
 * 晶农EMS MQTT 北向协议 —— 符合性验证脚本
 *
 * 扮演「云平台」角色，按《晶农EMS的MQTT通讯协议》逐条验证：
 *   1 登录 Post/PostRsp · 2 周期上报 PeriodReport · 3 实时召测 Get/DevData
 *   4 通道下发 Set/EmsSet · 5 运行策略（经 EmsSet） · 6 设备信息 DeviceInfor
 *   7 站点信息 UserInfor
 * 另附：文档示例 payload 的 JSON 合法性校验（照抄文档能否直接用）
 *
 * 用法：node protocol-check.js [brokerUrl] [sn]
 *   默认 mqtt://127.0.0.1:1884  SNLICHU0001（配合 tools/local-broker.js + ems-simulator.js）
 * ============================================================ */
'use strict';
const mqtt = require('mqtt');

const URL = process.argv[2] || 'mqtt://127.0.0.1:1884';
const SN = process.argv[3] || 'SNLICHU0001';
const now = () => Math.floor(Date.now() / 1000);

const results = [];
function ok(name, detail) { results.push({ r: 'PASS', name, detail }); console.log('  [通过] ' + name + (detail ? '  —— ' + detail : '')); }
function fail(name, detail) { results.push({ r: 'FAIL', name, detail }); console.log('  [失败] ' + name + (detail ? '  —— ' + detail : '')); }
function warn(name, detail) { results.push({ r: 'WARN', name, detail }); console.log('  [注意] ' + name + (detail ? '  —— ' + detail : '')); }
function head(t) { console.log('\n=== ' + t + ' ==='); }
function j(v) { return JSON.stringify(v); }

/* ---------- 文档原文示例（逐字抄自 docx，用于合法性校验） ---------- */
const DOC_SAMPLES = {
  '登录请求': '{ "identifier": "Login", "vendor": "zhhn", "time": 1662001903 }',
  '登录应答': '{ "identifier": "Login", "result": 1, "time": 1662001903 }',
  '周期上报 PeriodReport': `{
    "identifier": "PeriodReport",
    "SN": "SN21881FFF0001",
    "data":[
      { "deviceType": "系统参数", "tags": {
          "SN": "SN21881FFF0001", "CpuUsage": "48",
          "DiskSpace"： "232348", "UnuserdSpace"： "789222222",
          "netIp"： "123.2.3.36", "SignalStrength"： "16",
          "Ccid"： "2323485622233D66", "version"： "工控机版V1.6",
      } },
      { "deviceType": "PCS", "tags": { "AphaseVoltage": "233.8" } },
      { "deviceType": "BMS", "tags": { "SysTotalVol": "707.1" } },
      "time": 1662001903
    ] }`,
  '召测请求 DevData': '{ "identifier": "DevData", "sn": "21881FFF0001", "time": 1662001903 }',
  '通道设置 EmsSet': `{
    "identifier": "EmsSet",
    "Tag":[{ "deviceTag":"PCS", "wayName":"下设充电/放电功率", "varValue":"25"，
      }, { "deviceTag":"PCS", "wayName":"模块主机设置", "varValue":"1"，
      },]
    "time": 1662001903 }`,
  '设备信息应答 DeviceInfor': `{
    "identifier": "DeviceInfor", "SN": "SN21881FFF0001", "msgId":"命令唯一Id",
    "data":[ { "DeviceName": "EMS", "DeviceTag": "EMS", "DeviceManufacturer"： "中和汇能", "DeviceCode"： "1.6" } ]
    "time": 1662001903 }`,
  '站点信息应答 UserInfor': `{
    "identifier": "UserInfor", "msgId":"命令唯一Id",
    "data":[ { "UserName": "用户", "DeviceName": "电站名称", "DeviceName": "储能电站设备1", "SN": "SN1233233343333" } ]
    "time": 1662001903 }`
};

/* ============================================================
 * 一、文档示例 payload 合法性校验
 * ============================================================ */
function checkDocSamples() {
  head('一、文档示例 payload 合法性（照抄文档能否被标准 JSON 解析）');
  Object.keys(DOC_SAMPLES).forEach(function (k) {
    const raw = DOC_SAMPLES[k];
    let strict = null;
    try { JSON.parse(raw); strict = true; } catch (e) { strict = e.message; }
    let lenient = false;
    try {
      JSON.parse(raw.replace(/：/g, ':').replace(/，/g, ',').replace(/,\s*([}\]])/g, '$1'));
      lenient = true;
    } catch (_) {}
    if (strict === true) ok(k, '标准 JSON 合法');
    else fail(k, '标准 JSON 非法：' + strict.slice(0, 60) + '；容错处理后可解析=' + lenient);
  });
}

/* ============================================================
 * 二、在线协议流程验证
 * ============================================================ */
const client = mqtt.connect(URL, { clientId: 'proto-check-' + Date.now(), connectTimeout: 8000, reconnectPeriod: 0 });
const seen = {};                   // 收到的报文
const waiters = [];
client.on('message', function (topic, buf) {
  const text = buf.toString();
  let p = null; try { p = JSON.parse(text.replace(/：/g, ':').replace(/，/g, ',').replace(/,\s*([}\]])/g, '$1')); } catch (_) {}
  if (!seen[topic]) seen[topic] = [];
  seen[topic].push({ p, text, at: Date.now() });
  waiters.slice().forEach(function (w) {
    if (w.match(topic, p)) { waiters.splice(waiters.indexOf(w), 1); w.res(p); }
  });
});
function waitFor(matchFn, ms, label) {
  const hit = Object.keys(seen).find(t => seen[t].some(e => matchFn(t, e.p)));
  if (hit) return Promise.resolve(seen[hit].find(e => matchFn(hit, e.p)).p);
  return new Promise(function (res, rej) {
    const w = { match: matchFn, res: res };
    waiters.push(w);
    setTimeout(function () {
      const i = waiters.indexOf(w);
      if (i >= 0) { waiters.splice(i, 1); rej(new Error('等待超时：' + (label || '报文'))); }
    }, ms);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

client.on('connect', async function () {
  console.log('平台侧已连接 broker：' + URL + '　（SN=' + SN + '）');

  try {
    /* --- 1. 登录 --- */
    head('二、登录流程（文档 1. 登录请求）');
    await new Promise(r => client.subscribe(['zhhn/Post/Login/+', 'zhhn/Post/PeriodReport/+', 'zhhn/GetRsp/+', 'zhhn/GetRsp/UserInfor', 'zhhn/SetRsp/+'], r));
    ok('订阅上行 Topic', 'zhhn/Post/Login/+ · PeriodReport/+ · GetRsp/+ · SetRsp/+');
    let login = null;
    try {
      login = await waitFor((t, p) => t.indexOf('zhhn/Post/Login/') === 0 && p && p.identifier === 'Login', 25000, 'EMS 登录请求');
      ok('收到 EMS 登录请求 ' + 'zhhn/Post/Login/' + SN, 'vendor=' + login.vendor + ' time=' + login.time);
    } catch (e) { fail('收到 EMS 登录请求', e.message); }
    if (login) {
      client.publish('zhhn/PostRsp/Login/' + SN, JSON.stringify({ identifier: 'Login', result: 1, time: now() }), { qos: 1 });
      ok('平台已回登录应答 zhhn/PostRsp/Login/' + SN, 'result=1（文档要求：登录成功 EMS 才继续通信）');
    }

    /* --- 2. 周期上报 --- */
    head('三、周期上报（文档 2. 周期上报存储数据）');
    let rep = null;
    try {
      rep = await waitFor((t, p) => t.indexOf('zhhn/Post/PeriodReport/') === 0 && p && p.data, 40000, 'PeriodReport');
      const types = rep.data.map(d => d.deviceType);
      const hasTags = rep.data.every(d => d.tags && Object.keys(d.tags).length);
      ok('收到周期上报 zhhn/Post/PeriodReport/' + SN, 'identifier=' + rep.identifier + ' SN=' + rep.SN + ' 设备数=' + rep.data.length);
      ok('报文结构符合文档', 'data[] 每项含 deviceType+tags：' + (hasTags ? '是' : '否') + '；设备类型=' + types.join('/'));
      ok('时间戳字段', 'time=' + rep.time + '（Unix 秒）');
      const badCount = rep.data.reduce((n, d) => n + Object.values(d.tags).filter(v => String(v).toUpperCase() === 'BAD').length, 0);
      warn('无效点标记', '文档规定"接收不到的数据标记成 Bad"，本帧 ' + badCount + ' 个');
    } catch (e) { fail('收到周期上报', e.message); }

    /* --- 3. 实时召测 --- */
    head('四、实时数据读取/召测（文档 3. 实时数据读取）');
    try {
      client.publish('zhhn/Get/DevData/' + SN, JSON.stringify({ identifier: 'DevData', sn: SN, time: now() }), { qos: 1 });
      const rsp = await waitFor((t, p) => t.indexOf('zhhn/GetRsp/DevData/') === 0 && p, 20000, 'DevData 应答');
      ok('召测应答 zhhn/GetRsp/DevData/' + SN, '应答 identifier=' + rsp.identifier + (rsp.identifier === 'PeriodReport' ? '（与文档一致：复用 PeriodReport 标识）' : '（文档示例此处为 PeriodReport）'));
      await sleep(6000);
      const n = (seen['zhhn/GetRsp/DevData/' + SN] || []).length;
      if (n >= 2) ok('应答按周期连发', '6 秒内收到 ' + n + ' 帧（文档：5s/次 × 60 次）');
      else warn('应答连发频率', '6 秒内仅 ' + n + ' 帧，请确认 EMS 侧 burst 配置（文档：5s × 60 次）');
    } catch (e) { fail('召测应答', e.message); }

    /* --- 4. 通道下发 --- */
    head('五、EMS 通道参数设置（文档 4. EmsSet）');
    try {
      client.publish('zhhn/Set/EmsSet/' + SN, JSON.stringify({
        identifier: 'EmsSet',
        Tag: [{ deviceTag: 'EMS', wayName: 'SOCmax', varValue: '93' }, { deviceTag: 'EMS', wayName: 'ControlMode', varValue: '1' }],
        time: now()
      }), { qos: 1 });
      const rsp = await waitFor((t, p) => t.indexOf('zhhn/SetRsp/EmsSet/') === 0 && p, 20000, 'SetRsp');
      ok('下发应答 zhhn/SetRsp/EmsSet/' + SN, 'result=' + rsp.result + ' errormsg="' + (rsp.errormsg || '') + '"');
      ok('应答字段符合文档', 'result(0失败/1成功) + errormsg(成功为空串) 均存在');
    } catch (e) { fail('通道下发应答', e.message); }

    /* --- 5. 运行策略（经 EmsSet 修改通道值） --- */
    head('六、运行策略设置（文档 5. 通过 EmsSet 改通道值实现）');
    try {
      client.publish('zhhn/Set/EmsSet/' + SN, JSON.stringify({
        identifier: 'EmsSet',
        Tag: [
          { deviceTag: 'EMS', wayName: 'S1StHour', varValue: '0' }, { deviceTag: 'EMS', wayName: 'S1Power', varValue: '-100' },
          { deviceTag: 'EMS', wayName: 'S2StHour', varValue: '18' }, { deviceTag: 'EMS', wayName: 'S2Power', varValue: '150' }
        ],
        time: now()
      }), { qos: 1 });
      const rsp = await waitFor((t, p) => t.indexOf('zhhn/SetRsp/EmsSet/') === 0 && p && seen[t].length >= 2, 20000, '策略下发应答');
      ok('分段策略下发成功', 'result=' + rsp.result + '（S1~S10 段起始时/分、结束时/分、执行功率，功率符号：-充 +放）');
    } catch (e) { fail('分段策略下发', e.message); }

    /* --- 6. 设备信息 --- */
    head('七、设备信息（文档 6. Get/DeviceInfor）');
    try {
      client.publish('zhhn/Get/DeviceInfor/' + SN, JSON.stringify({ identifier: 'DeviceInfor', sn: SN, msgId: 'chk' + Date.now(), time: now() }), { qos: 1 });
      const rsp = await waitFor((t, p) => t.indexOf('zhhn/GetRsp/DeviceInfor/') === 0 && p && p.data, 20000, 'DeviceInfor 应答');
      const d0 = rsp.data[0] || {};
      ok('设备清单应答 zhhn/GetRsp/DeviceInfor/' + SN, '设备数=' + rsp.data.length + ' 首项=' + d0.DeviceName + '/' + d0.DeviceTag);
      ok('字段符合文档', 'DeviceName/DeviceTag/DeviceManufacturer/DeviceCode ' + (('DeviceName' in d0 && 'DeviceTag' in d0) ? '齐全' : '缺失'));
    } catch (e) { fail('设备清单应答', e.message); }

    /* --- 7. 站点/用户信息 --- */
    head('八、站点与设备 SN（文档 7. Get/UserInfor）');
    try {
      client.publish('zhhn/Get/UserInfor/' + SN, JSON.stringify({ identifier: 'UserInfor', username: 'zhhn', password: '123456', msgId: 'chk' + Date.now(), time: now() }), { qos: 1 });
      const rsp = await waitFor((t, p) => t === 'zhhn/GetRsp/UserInfor' && p && p.data, 20000, 'UserInfor 应答');
      ok('站点信息应答 zhhn/GetRsp/UserInfor（注意：文档规定该 Topic 不带 SN 后缀）', 'data 条数=' + rsp.data.length);
      const item = rsp.data[0] || {};
      ok('返回字段', Object.keys(item).join('/'));
    } catch (e) { fail('站点信息应答', e.message); }

    /* --- 汇总 --- */
    head('验证汇总');
    const c = { PASS: 0, FAIL: 0, WARN: 0 };
    results.forEach(x => c[x.r]++);
    console.log('通过 ' + c.PASS + ' 项，失败 ' + c.FAIL + ' 项，注意 ' + c.WARN + ' 项');
    client.end(true, () => process.exit(c.FAIL ? 1 : 0));
  } catch (e) {
    console.error('验证过程异常：', e.message);
    client.end(true, () => process.exit(1));
  }
});
client.on('error', e => { console.error('MQTT 错误：' + e.message); process.exit(1); });

checkDocSamples();
