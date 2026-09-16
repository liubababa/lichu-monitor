#!/usr/bin/env node
/* ============================================================
 * 晶农EMS 模拟器（力储未来平台联调用）
 *
 * 按《晶农EMS的MQTT通讯协议》2026-03-04 模拟一台 EMS：
 *   1. 上线即发 Login（zhhn/Post/Login/{SN}），等平台回 PostRsp(result=1) 后开始上报
 *   2. 周期上报 PeriodReport（系统参数/PCS/电芯/BMS/EMS，值随时间波动）
 *   3. 应答召测  Get/DevData   → GetRsp/DevData（5s × N 帧）
 *      应答下发  Set/EmsSet   → SetRsp/EmsSet（result=1，并把 RW 值并入后续上报）
 *      应答清单  Get/DeviceInfor → GetRsp/DeviceInfor
 *      应答站点  Get/UserInfor  → GetRsp/UserInfor
 *
 * 用法：
 *   node ems-simulator.js --url mqtt://broker.emqx.io:1883 --sn SNLICHU0001
 *   可选：--username --password --interval 秒(默认10) --station 电站名 --burst 召测应答帧数(默认12)
 * ============================================================ */
'use strict';
const mqtt = require('mqtt');

/* ---------- 参数 ---------- */
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i]] = process.argv[i + 1] || '';
const OPT = {
  url: args['--url'] || 'mqtt://broker.emqx.io:1883',
  username: args['--username'] || '',
  password: args['--password'] || '',
  sn: args['--sn'] || 'SNLICHU0001',
  interval: parseInt(args['--interval'] || '10', 10) * 1000,
  station: args['--station'] || '力储未来储能电站',
  burst: parseInt(args['--burst'] || '12', 10)
};

const T = {
  login: 'zhhn/Post/Login/' + OPT.sn,
  loginRsp: 'zhhn/PostRsp/Login/' + OPT.sn,
  period: 'zhhn/Post/PeriodReport/' + OPT.sn,
  devData: 'zhhn/Get/DevData/' + OPT.sn,
  devDataRsp: 'zhhn/GetRsp/DevData/' + OPT.sn,
  emsSet: 'zhhn/Set/EmsSet/' + OPT.sn,
  emsSetRsp: 'zhhn/SetRsp/EmsSet/' + OPT.sn,
  devInfor: 'zhhn/Get/DeviceInfor/' + OPT.sn,
  devInforRsp: 'zhhn/GetRsp/DeviceInfor/' + OPT.sn,
  userInfor: 'zhhn/Get/UserInfor/' + OPT.sn,
  userInforRsp: 'zhhn/GetRsp/UserInfor'
};

const log = (...a) => console.log(new Date().toTimeString().slice(0, 8), '|', ...a);

/* ---------- 模拟数据 ---------- */
/* RW 通道值（EmsSet 下发后更新，并入 EMS 上报） */
const RW = {
  ControlMode: 1, StratagyType: 0, OnOff: 1, SetConnect: 1,
  SOCmax: 95, SOCmin: 10, SetPower: 0, SetRePower: 0, K1: 85, Pmlmax: 630,
  TMSCtrlState: 2, EnProtectReverse: 1, EnTraceLoad: 0, EnProtectTransf: 1
};
let soc = 82.5, t0 = Date.now();

function jitter(base, pct) { return base + base * pct * (Math.random() - 0.5); }

/* PCS_P：以 10 分钟为周期的正负交变（负=充电 正=放电），便于看到曲线与状态切换 */
function pcsPower() {
  const ph = ((Date.now() - t0) % 600000) / 600000 * Math.PI * 2;
  return +(180 * Math.sin(ph)).toFixed(1);
}

function buildReport() {
  soc = Math.min(96, Math.max(8, soc - pcsPower() / 26000)); // 放电降 SOC、充电升 SOC
  const p = pcsPower();
  const chargeToday = +(Math.abs(p) < 5 ? 3120.4 : 3120.4 + Math.abs(p) / 3600 * (OPT.interval / 1000)).toFixed(1);
  const sysTime = Math.floor(Date.now() / 1000);
  const tagsEMS = Object.assign({
    SysStoped: 0, MeterError: 0, IoProtect: 0, AllFire: 0, Fire: 0, ExFire: 0,
    SysStatus: 0, SysStatusWord: 1, EMSCircleBeat: Math.floor(Date.now() / 3000) % 2,
    MaxDemand: 480, GridPower: +((jitter(260, .3)).toFixed(1)), LoadPower: +jitter(420, .25).toFixed(1),
    ExpectPower: p, LocalCtrlPower: 0, CabPower: 500, CabCapacity: 1000,
    AlarmCnt: 0, ProhibiteCha: 0, ProhibiteDisc: 0, LastChaDiscSta: p,
    BmsLimited: 0, DcTotalVolLow: 0, MaxChargePower: 250, MaxDischaPower: 250,
    PvCurPercent: 0, PcsActivePower: p, PcsReactivePower: +jitter(12, .5).toFixed(1),
    TotalActivePower: +(420 + p).toFixed(1), TotalReactivePower: 96.2,
    TotalForwardEnergy: 125834.6, TotalReverseEnergy: 98221.3,
    GRID_P: +jitter(270, .3).toFixed(1), GRID_Q: 45.2, PCU_P: 0,
    PCS_P: p, PCS_Q: 12.1, MPPT_P: 0, BMS_P: +(p * 0.95).toFixed(1),
    BMS_SOC: +soc.toFixed(1), PV_P: 0, PV_Q: 0, Online: 1
  }, RW);

  const data = [
    { deviceType: '系统参数', tags: {
      SN: OPT.sn, CpuUsage: String(Math.round(jitter(18, .4))), DiskSpace: '232348',
      UnusedSpace: '789222222', netIp: '192.168.1.66', SignalStrength: '26',
      Ccid: '89860121802209000000', Rss: '1024', version: '工控机版V1.6',
      dataFlow: '2.35', Online: 1 } },
    { deviceType: 'PCS', tags: {
      AphaseVoltage: +jitter(233, .02).toFixed(1), BphaseVoltage: +jitter(235, .02).toFixed(1), CphaseVoltage: +jitter(231, .02).toFixed(1),
      AphaseCurrent: +(Math.abs(p) / 3 / 0.23).toFixed(1), BphaseCurrent: +(Math.abs(p) / 3 / 0.23).toFixed(1), CphaseCurrent: +(Math.abs(p) / 3 / 0.23).toFixed(1),
      Frequency: +jitter(50, .001).toFixed(2), ActivePower: p, ReactivePower: 12.1, ApparentPower: +(Math.abs(p) + 12).toFixed(1),
      ACFactor: 0.998, BatVolt: +jitter(707, .01).toFixed(1), BatCurr: +(p / 0.707).toFixed(1), BatPower: +(p * 0.95).toFixed(1),
      RunStatu: Math.abs(p) < 5 ? 5 : 257, IGBTTemp: +jitter(38, .2).toFixed(1),
      GridOnOff: 0, Online: 1,
      DC5: 52341, DC6: chargeToday, DC7: 48112, DC8: +(chargeToday * 0.92).toFixed(1),
      FireAlarmFault: 0, BMSTelecomFault: 0, EMSTelecomFault: 0 } },
    { deviceType: 'BMS', tags: {
      RackVoltage: +jitter(707, .01).toFixed(1), RackCurrent: +(p / 0.707).toFixed(1),
      RackCagDsgState: Math.abs(p) < 5 ? 0 : (p < 0 ? 2 : 1),
      SOC: +soc.toFixed(1), SOH: 99, SOE: 92.6,
      RackPosInsulatVal: 5120, RackNegInsulatVal: 5088,
      RackRunState: 7, TempCollectionPoints: 112,
      RackMaxTemp: Math.round(jitter(31, .1)), RackMaxTempModuleId: 1, RackMaxTempCellId: 48,
      RackMinTemp: Math.round(jitter(26, .1)), RackMinTempModuleId: 2, RackMinTempCellId: 7,
      RackAverageTemp: +jitter(28.4, .05).toFixed(1), RackCellnum: 224,
      RackAverageVolt: +jitter(3157, .01).toFixed(1),
      RackMaxVoltage: Math.round(jitter(3189, .01)), RackMaxVoltageModuleId: 1, RackMaxVolCellId: 102,
      RackMinVoltage: Math.round(jitter(3121, .01)), RackMinVoltageModuleId: 2, RackMinVolCellId: 11,
      Online: 1,
      RackVolHighWarn1: 0, RackVolLowAlarm1: 0, CellVolHighWarn1: 0, CellVolLowWarn1: 0,
      SOCLowWarn1: 0, SOCHighWarn1: 0, EMSCommunicateFault: 0, PCSCommunicateFault: 0 } },
    { deviceType: '电芯', tags: (() => {
        const t = {};
        for (let i = 1; i <= 224; i++) t['RkCeVolt' + String(i).padStart(3, '0')] = String(Math.round(jitter(3157, .02)));
        for (let i = 1; i <= 112; i++) t['RkCeTemp' + String(i).padStart(3, '0')] = String(+jitter(28.5, .2).toFixed(1));
        t.Online = 1; return t;
      })() },
    { deviceType: '储能表', tags: {
      ActiveEnergy: '523411.2', ReactiveEnergy: '481122.9',
      AphaseVoltage: '233.2', BphaseVoltage: '234.9', CphaseVoltage: '231.6',
      AphaseCurrent: +(Math.abs(p) / 3 / 0.233).toFixed(2), BphaseCurrent: +(Math.abs(p) / 3 / 0.233).toFixed(2), CphaseCurrent: +(Math.abs(p) / 3 / 0.233).toFixed(2),
      ActivePower: p, ReactivePower: 12.0, ApparentPower: +(Math.abs(p) + 12).toFixed(1),
      PowerFactor: 0.998, Online: 1 } },
    { deviceType: '关口表', tags: {
      ActiveEnergy: '1258340.6', ReactiveEnergy: '982213.4',
      AphaseVoltage: '234.1', BphaseVoltage: '235.8', CphaseVoltage: '232.4',
      AphaseCurrent: +(Math.abs(300) / 3 / 0.234).toFixed(2), BphaseCurrent: +(Math.abs(300) / 3 / 0.234).toFixed(2), CphaseCurrent: +(Math.abs(300) / 3 / 0.234).toFixed(2),
      ActivePower: +(300 + 30 * Math.sin(Date.now() / 400000)).toFixed(1), ReactivePower: 45.2,
      ApparentPower: 302.4, PowerFactor: 0.989, Online: 1 } },
    { deviceType: 'EMS', tags: tagsEMS },
    { deviceType: '液冷机', tags: {
      InflowTemp: +jitter(24.6, .05).toFixed(1), EffluentTemp: +jitter(28.9, .05).toFixed(1),
      AmbientTemp: +jitter(26, .1).toFixed(1), WaterInPreVal: +jitter(2.4, .1).toFixed(2),
      WaterOutPreVal: +jitter(2.1, .1).toFixed(2), PressSpeed: +jitter(2100, .1).toFixed(0),
      PumpStatus: 1, CompressorStatus: 1, Read_15: 2, Online: 1 } }
  ];
  return { identifier: 'PeriodReport', SN: OPT.sn, data: data, time: sysTime };
}

/* ---------- MQTT ---------- */
const client = mqtt.connect(OPT.url, {
  username: OPT.username || undefined, password: OPT.password || undefined,
  clientId: 'zhhn-sim-' + OPT.sn + '-' + Math.random().toString(16).slice(2, 8),
  keepalive: 30, reconnectPeriod: 5000, connectTimeout: 10000
});
let logged = false, burstTimer = null, burstLeft = 0, loginTimer = null;

function pub(topic, obj, note) {
  const text = JSON.stringify(obj);
  client.publish(topic, text, { qos: 1 });
  log((note || '上报') + ' → ' + topic + '（' + text.length + 'B）');
}

function tryLogin() {
  if (logged) return;
  pub(T.login, { identifier: 'Login', vendor: 'zhhn', time: Math.floor(Date.now() / 1000) }, '登录');
}

client.on('connect', () => {
  logged = false;
  log('已连接 broker：' + OPT.url + '　SN=' + OPT.sn);
  client.subscribe([
    T.loginRsp, T.devData, T.emsSet, T.devInfor, T.userInfor
  ], { qos: 1 }, (e) => { if (e) log('订阅失败：', e.message); });
  tryLogin();
  clearInterval(loginTimer);
  loginTimer = setInterval(tryLogin, 5000);   /* 未收到 PostRsp 前每 5s 重发登录 */
});

client.on('message', (topic, msg) => {
  let p = null; try { p = JSON.parse(msg.toString()); } catch (_) { return; }
  const now = () => Math.floor(Date.now() / 1000);

  if (topic === T.loginRsp) {
    if (p.result === 1) {
      if (!logged) {
        logged = true;
        clearInterval(loginTimer);
        log('平台已确认登录（result=1），开始周期上报，间隔 ' + (OPT.interval / 1000) + 's');
      }
      return;
    }
    log('登录被拒绝：', JSON.stringify(p));
    return;
  }
  if (topic === T.devData) { /* 召测：5s × burst 帧 */
    log('收到召测 Get/DevData');
    clearInterval(burstTimer); burstLeft = OPT.burst;
    const send = () => {
      if (burstLeft-- <= 0) { clearInterval(burstTimer); return; }
      pub(T.devDataRsp, buildReport(), '召测应答(' + (OPT.burst - burstLeft) + '/' + OPT.burst + ')');
    };
    send(); burstTimer = setInterval(send, 5000);
    return;
  }
  if (topic === T.emsSet) {
    const tags = Array.isArray(p.Tag) ? p.Tag : [];
    tags.forEach(t => { if (t && t.wayName) RW[t.wayName] = isNaN(parseFloat(t.varValue)) ? t.varValue : parseFloat(t.varValue); });
    log('收到下发 EmsSet：' + tags.map(t => t.wayName + '=' + t.varValue).join('、'));
    pub(T.emsSetRsp, { identifier: 'EmsSet', result: 1, errormsg: '', time: now() }, '下发应答');
    return;
  }
  if (topic === T.devInfor) {
    pub(T.devInforRsp, {
      identifier: 'DeviceInfor', SN: OPT.sn, msgId: p.msgId || '', time: now(),
      data: [
        { DeviceName: 'EMS', DeviceTag: 'EMS', DeviceManufacturer: '中和汇能', DeviceCode: '1.6' },
        { DeviceName: '储能表', DeviceTag: 'CNB', DeviceManufacturer: '安科瑞', DeviceCode: 'AMC72-E4/KC' },
        { DeviceName: '关口表', DeviceTag: 'CNB', DeviceManufacturer: '安科瑞', DeviceCode: 'AMC72-E4/KC' },
        { DeviceName: '变流器', DeviceTag: 'PCS', DeviceManufacturer: '科华', DeviceCode: 'KHR-500' },
        { DeviceName: '主控', DeviceTag: 'BMS', DeviceManufacturer: '高特', DeviceCode: 'B CU 05' },
        { DeviceName: '电芯', DeviceTag: 'BMS_CELLS', DeviceManufacturer: '亿纬', DeviceCode: 'LF280K' },
        { DeviceName: '液冷机', DeviceTag: 'TMS', DeviceManufacturer: '英维克', DeviceCode: 'XGlC-05' }
      ]
    }, '设备清单应答');
    return;
  }
  if (topic === T.userInfor) {
    pub(T.userInforRsp, {
      identifier: 'UserInfor', msgId: p.msgId || '', time: now(),
      data: [{ UserName: '力储未来', DeviceName: OPT.station, SN: OPT.sn }]
    }, '站点信息应答');
    return;
  }
});

setInterval(() => { if (logged) pub(T.period, buildReport(), '周期上报'); }, OPT.interval);

client.on('error', e => log('MQTT 错误：' + e.message));
client.on('close', () => { logged = false; clearInterval(burstTimer); });
process.on('SIGINT', () => { client.end(true); process.exit(0); });
