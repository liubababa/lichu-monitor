/* ============================================================
 * 数据层（接真实数据只改这个文件）
 *
 * ▸ APP_CONFIG.mode = 'mock'   演示模式：本地模拟数据（默认，可随时切回）
 *                  = 'mqtt'   厂家实时数据：中和汇能《晶农EMS MQTT 北向通讯协议》
 *                             （由 js/mqtt.js 收报文，本文件负责映射为标准快照）
 *                  = 'http'   HTTP 轮询：填 http.url，在 mapReal() 里做字段映射
 *                  = 'websocket' WS 推送：填 ws.url，在 mapReal() 里做字段映射
 *
 * ▸ 标准"数据快照"结构（页面所有模块都吃这个结构，见 README.md）：
 * {
 *   kpis: { chargeToday, loadToday, gridToday },   // 三个 KPI（kWh）
 *   soc: 87,                                        // 实时容量 %
 *   pcs:   { labels:[], actual:[], rated:[] },      // PCS运行情况曲线
 *   load:  { labels:[], user:[], storage:[] },      // 主要设备负载曲线
 *   devices: {                                      // 3D 场景设备标签 + 详情卡
 *     storage: { name, stats:[[k,v],..], card:{ title, rows:[[k,v],..], status } },
 *     ...
 *   },
 *   alarms: [],                                     // 告警列表，空 = 无告警
 *   flowSpeed: 1.2                                  // 能流动画速度(可选)
 * }
 *
 * ▸ 厂家报文 → 快照映射规则（mqtt 模式，依据点表 js/points.js）
 *    KPI 储能充放电量 : PCS 交流日充电量(DC6) + 交流日放电量(DC8)，缺失则功率积分
 *    KPI 负载用电量   : EMS LoadPower 功率积分（会话累计）
 *    KPI 变压器发电量 : EMS GRID_P / 关口表 ActivePower 功率积分（会话累计）
 *    SOC              : EMS BMS_SOC → BMS SOC
 *    PCS 曲线         : 实际 = EMS PCS_P，额定 = EMS CabPower
 *    负载曲线         : 用户负载 = EMS LoadPower，储能充放电 = EMS PCS_P
 * ============================================================ */

window.APP_CONFIG = {
  siteName:   '力储未来远程监控平台',     // 顶部标题
  stationName:'力储未来储能电站',         // 电站名称（左上角显示）
  weather:    '晴 26℃',                  // 顶栏天气文案
  tickMs:     3000,                      // 模拟数据刷新间隔(ms)

  /* 数据接入模式：'mock' | 'mqtt' */
  mode: 'mock',

  /* 厂家信息（晶农EMS 北向协议）；DeviceInfor 上报的制造商会自动覆盖 company */
  vendor: {
    company: '中和汇能（山东）电气科技有限公司',
    product: '晶农EMS',
    protocol:'晶农EMS MQTT 北向通讯协议（2026-03-04）'
  },

  /* MQTT 接入参数默认值；页面「数据源」面板配置后持久化到 localStorage（键：dianzhan.mqtt.cfg）
     生产环境：服务器部署 EMQX 后，nginx 将 wss://域名/mqtt 反代到 EMQX 8083(WS) 端口，详见 部署指南.md */
  mqtt: {
    url: 'wss://ykdesign.top/mqtt', port: '', username: '', password: '',
    sn: '', stationName: ''
  },

  http: { url: 'http://your-api/realtime', interval: 5000 },
  ws:   { url: 'ws://your-api/realtime' }
};

window.DataService = (function () {
  'use strict';
  const C = APP_CONFIG;
  let cb = null, chartMode = 'realtime', timer = null, ws = null;

  /* 数据来源：mock / mqtt（http、websocket 保留原有分支，默认不启用） */
  let source = (C.mode === 'mqtt') ? 'mqtt'
             : (C.mode === 'http') ? 'http'
             : (C.mode === 'websocket') ? 'websocket' : 'mock';

  const WIN = 40; // 实时曲线滚动窗口点数
  const S = { chargeToday: 24089, loadToday: 14628, gridToday: 26089, soc: 87, win: null };

  function rnd(a, p) { return a * (1 + (Math.random() - .5) * p); }

  /* ---- 模拟曲线（按一天内的小时数取值） ---- */
  function pcsBase(h) {
    let p;
    if (h < 6)        p = 200;
    else if (h < 8)   p = 200 + (h - 6) / 2 * 3200;      // 早间充电爬坡
    else if (h < 11)  p = 3400 + 500 * Math.sin((h - 8) * 1.2);
    else if (h < 14)  p = 2800 + 300 * Math.sin(h * 1.7);
    else if (h < 17)  p = 2800 - (h - 14) / 3 * 2500;
    else if (h < 20)  p = 300 + (h - 17) / 3 * 5700;     // 晚高峰放电
    else if (h < 22)  p = 6000 - (h - 20) / 2 * 5700;
    else              p = 300;
    return Math.max(120, p);
  }
  function loadBase(h) {
    let p;
    if (h < 7)        p = 1900;
    else if (h < 9)   p = 1900 + (h - 7) / 2 * 2600;
    else if (h < 11)  p = 4500 + 400 * Math.sin(h);
    else if (h < 13)  p = 5200;
    else if (h < 17)  p = 4800 + 300 * Math.sin(h * 1.3);
    else if (h < 19)  p = 4800 + (h - 17) / 2 * 2200;
    else if (h < 21)  p = 7000 + 800 * Math.sin(h * 2);
    else if (h < 23)  p = 6000;
    else              p = 2800;
    return Math.max(800, p);
  }

  /* ---- 实时滚动窗口（mock） ---- */
  function fmtT(d) { return d.toTimeString().slice(0, 8); }
  function pushPoint(d, jitter) {
    const h = d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
    const w = S.win;
    w.labels.push(fmtT(d));
    w.actual.push(Math.round(jitter ? rnd(pcsBase(h), .06) : pcsBase(h)));
    w.rated.push(6000);
    w.user.push(Math.round(jitter ? rnd(loadBase(h), .05) : loadBase(h)));
    w.storage.push(Math.round(rnd(pcsBase(h) * .92, .08)));
    for (const k of ['labels', 'actual', 'rated', 'user', 'storage'])
      while (w[k].length > WIN) w[k].shift();
  }
  function seedWin() {
    S.win = { labels: [], actual: [], rated: [], user: [], storage: [] };
    const now = Date.now();
    for (let i = WIN - 1; i >= 0; i--) pushPoint(new Date(now - i * (C.tickMs || 3000)), false);
  }
  function mockHistory() {
    const o = { labels: [], actual: [], rated: [], user: [], storage: [] };
    for (let m = 0; m < 1440; m += 10) {
      const h = m / 60;
      o.labels.push(String(Math.floor(h)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'));
      o.actual.push(Math.round(pcsBase(h)));
      o.rated.push(6000);
      o.user.push(Math.round(loadBase(h)));
      o.storage.push(Math.round(pcsBase(h) * .92));
    }
    return o;
  }

  /* ---- 3D 设备标签 / 详情卡数据（mock） ---- */
  function devices() {
    return {
      grid: {
        name: '电网',
        stats: [['并网电压', '10.2kV'], ['频率', (50 + (Math.random() - .5) * .08).toFixed(2) + 'Hz']],
        card: { title: '并网运行情况', rows: [['A相电压', '10.21kV'], ['B相电压', '10.18kV'], ['C相电压', '10.22kV'], ['频率', (50 + (Math.random() - .5) * .08).toFixed(2) + 'Hz']] }
      },
      transformer: {
        name: '变压器',
        stats: [['负载', Math.round(rnd(132, .15)) + 'kW'], ['油温', (55 + Math.random() * 3).toFixed(1) + '℃']],
        card: { title: '变压器运行情况', rows: [['负载率', Math.round(rnd(62, .2)) + '%'], ['A相电流', (0.8 + Math.random() * .05).toFixed(2) + 'kA'], ['B相电流', '0.79kA'], ['C相电流', '0.81kA'], ['油温', '56.3℃']] }
      },
      meterA: {
        name: '计量点',
        stats: [['有功功率', Math.round(rnd(300, .1)) + 'kW'], ['无功功率', Math.round(rnd(100, .2)) + 'kvar']],
        card: { title: '计量点 · 储能侧', rows: [['有功功率', Math.round(rnd(300, .1)) + 'kW'], ['无功功率', Math.round(rnd(100, .2)) + 'kvar'], ['功率因数', '0.95'], ['电能质量', '合格']] }
      },
      storage: {
        name: '储能电站',
        stats: [['端蓄容量', Math.round(rnd(16059, .02)) + 'kW'], ['端蓄电压', (549 + Math.random() * 4).toFixed(1) + 'V']],
        card: { title: '系统运行情况', rows: [['A相电压', (230 + Math.random() * .6).toFixed(1) + 'V'], ['B相电压', (229.6 + Math.random() * .8).toFixed(1) + 'V'], ['C相电压', (219.4 + Math.random() * .8).toFixed(1) + 'V'], ['端蓄电压', '549.9V'], ['内接温度', (50 + Math.random() * 2).toFixed(1) + '℃']], status: '充电中' }
      },
      meterB: {
        name: '计量点',
        stats: [['有功功率', Math.round(rnd(2000, .08)) + 'kW'], ['电能质量', '全合格']],
        card: { title: '系统消纳情况', rows: [['有功功率', Math.round(rnd(2000, .08)) + 'kW'], ['无功功率', '320kvar'], ['工作状态', '充电中'], ['电能质量', '全合格']] }
      },
      load: {
        name: '用户负载',
        stats: [['有功功率', Math.round(rnd(3000, .06)) + 'kW'], ['电能质量', '全合格']],
        card: { title: '用户负载', rows: [['有功功率', Math.round(rnd(3000, .06)) + 'kW'], ['无功功率', '480kvar'], ['功率因数', '0.98'], ['电能质量', '全合格']] }
      }
    };
  }

  /* ---- mock 标准快照 ---- */
  function mockSnapshot() {
    const chart = chartMode === 'history'
      ? mockHistory()
      : { labels: S.win.labels.slice(), actual: S.win.actual.slice(), rated: S.win.rated.slice(), user: S.win.user.slice(), storage: S.win.storage.slice() };
    return {
      time: new Date(),
      source: 'mock',
      mode: chartMode,
      kpis: {
        chargeToday: Math.round(S.chargeToday),
        loadToday: Math.round(S.loadToday),
        gridToday: Math.round(S.gridToday)
      },
      soc: S.soc,
      pcs:   { labels: chart.labels, actual: chart.actual, rated: chart.rated },
      load:  { labels: chart.labels, user: chart.user, storage: chart.storage },
      devices: devices(),
      alarms: [],
      flowSpeed: 1 + Math.random() * .8,
      vendor: C.vendor
    };
  }

  function tick() {
    S.chargeToday += Math.random() * 18;
    S.loadToday   += Math.random() * 30;
    S.gridToday   += Math.random() * 26;
    S.soc = Math.min(96, Math.max(78, S.soc + (Math.random() - .5) * .5));
    pushPoint(new Date(), true);
  }

  /* ============================================================
   * 厂家 MQTT（晶农EMS 北向协议）数据接入
   * 报文示例（周期上报 / 召测应答）：
   * { "identifier":"PeriodReport", "SN":"21881FFF0001",
   *   "data":[ { "deviceType":"EMS", "tags":{ "PCS_P":"320.5", ... } } ],
   *   "time":1662001903 }
   * 点值均为字符串（'Bad' 表示无效）。设备类型 → 点表设备号见 js/points.js 的 resolve()。
   * ============================================================ */
  const M = {
    win: { labels: [], actual: [], rated: [], user: [], storage: [] },
    tags: null, devices: null, alarms: [], soc: null, flow: 1,
    acc: { storage: 0, load: 0, grid: 0, tPrev: 0 },
    dailyEnergy: null,
    hints: { storage: '', load: '', grid: '' }
  };
  let lastReport = null;

  /* 报文 data[] → { 设备号或设备类型名: { TAG: 字符串值 } } */
  function flatReport(report) {
    const out = {};
    const list = (report && report.data) || [];
    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      if (!d || !d.deviceType) continue;
      const def = (typeof POINTS !== 'undefined' && POINTS.resolve) ? POINTS.resolve(d.deviceType) : null;
      const no = def ? def.no : d.deviceType;
      out[no] = Object.assign(out[no] || {}, d.tags || {});
      if (!out[d.deviceType]) out[d.deviceType] = out[no];
    }
    return out;
  }
  function num(v) {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    if (!s || /^bad$/i.test(s) || s === '--') return null;
    const n = parseFloat(s);
    return isFinite(n) ? n : null;
  }
  function pick(map, no, tag) {
    const d = map[no];
    if (!d) return null;
    return num(d[tag]);
  }
  /* 按优先级依次取第一个有效值：[[设备号/类型, TAG], ...] */
  function pickFrom(map, list) {
    for (let i = 0; i < list.length; i++) {
      const v = pick(map, list[i][0], list[i][1]);
      if (v !== null) return v;
    }
    return null;
  }
  function fmt(v, unit, digits) {
    if (v === null || v === undefined) return '--';
    const dig = (digits === undefined || digits === null)
      ? (Math.abs(v) >= 1000 ? 0 : (Math.abs(v) >= 100 ? 1 : 2)) : digits;
    return Number(v).toFixed(dig) + (unit || '');
  }

  /* 厂家上报值 → 3D 设备标签 / 详情卡 */
  function mqttDevices(map) {
    const P  = tag => pick(map, 'EMS', tag);
    const GM = tag => pick(map, 'GRID_METER', tag);
    const PM = tag => pick(map, 'PCS_METER', tag);
    const B  = tag => pick(map, 'BMS', tag);
    const pcsP = P('PCS_P');
    return {
      grid: {
        name: '电网',
        stats: [['市电有功', fmt(P('GRID_P'), 'kW')], ['系统状态', fmt(P('SysStatus'), '')]],
        card: {
          title: '并网运行情况',
          rows: [
            ['A相电压', fmt(GM('AphaseVoltage'), 'V')], ['B相电压', fmt(GM('BphaseVoltage'), 'V')], ['C相电压', fmt(GM('CphaseVoltage'), 'V')],
            ['市电有功', fmt(P('GRID_P'), 'kW')], ['市电无功', fmt(P('GRID_Q'), 'kVar')],
            ['功率因数', fmt(GM('PowerFactor'), '', 3)]
          ]
        }
      },
      transformer: {
        name: '变压器',
        stats: [['关口有功', fmt(GM('ActivePower'), 'kW')], ['最大需量', fmt(P('MaxDemand'), 'kW')]],
        card: {
          title: '变压器运行情况',
          rows: [
            ['关口有功', fmt(GM('ActivePower'), 'kW')], ['关口无功', fmt(GM('ReactivePower'), 'kVar')],
            ['最大需量', fmt(P('MaxDemand'), 'kW')], ['额定功率', fmt(P('CabPower'), 'kW')],
            ['额定容量', fmt(P('CabCapacity'), 'kWh')], ['在线', fmt(GM('Online'), '')]
          ]
        }
      },
      meterA: {
        name: '计量点',
        stats: [['有功功率', fmt(PM('ActivePower'), 'kW')], ['无功功率', fmt(PM('ReactivePower'), 'kVar')]],
        card: {
          title: '计量点 · 储能侧',
          rows: [
            ['A相电压', fmt(PM('AphaseVoltage'), 'V')], ['B相电压', fmt(PM('BphaseVoltage'), 'V')], ['C相电压', fmt(PM('CphaseVoltage'), 'V')],
            ['有功功率', fmt(PM('ActivePower'), 'kW')], ['无功功率', fmt(PM('ReactivePower'), 'kVar')],
            ['功率因数', fmt(PM('PowerFactor'), '', 3)], ['在线', fmt(PM('Online'), '')]
          ]
        }
      },
      storage: {
        name: '储能电站',
        stats: [['储能有功', fmt(pcsP, 'kW')], ['储能SOC', fmt(P('BMS_SOC') !== null ? P('BMS_SOC') : B('SOC'), '%', 1)]],
        card: {
          title: '系统运行情况',
          rows: [
            ['储能有功功率', fmt(pcsP, 'kW')], ['储能无功功率', fmt(P('PCS_Q'), 'kVar')],
            ['储能直流功率', fmt(P('BMS_P'), 'kW')], ['储能SOC', fmt(P('BMS_SOC') !== null ? P('BMS_SOC') : B('SOC'), '%', 1)],
            ['电池簇电压', fmt(B('RackVoltage'), 'V')], ['电池簇电流', fmt(B('RackCurrent'), 'A')],
            ['最高单体电压', fmt(B('RackMaxVoltage'), 'V', 3)], ['最高温度', fmt(B('RackMaxTemp'), '℃', 1)],
            ['额定功率', fmt(P('CabPower'), 'kW')], ['额定容量', fmt(P('CabCapacity'), 'kWh')]
          ],
          /* PCS_P 符号约定：负值充电、正值放电（同点表 S*Power「-充 +放」） */
          status: pcsP === null ? '数据等待中' : (pcsP < 0 ? '充电中' : (pcsP > 0 ? '放电中' : '待机'))
        }
      },
      meterB: {
        name: '计量点',
        stats: [['关口有功', fmt(GM('ActivePower'), 'kW')], ['功率因数', fmt(GM('PowerFactor'), '', 3)]],
        card: {
          title: '系统消纳情况',
          rows: [
            ['关口有功', fmt(GM('ActivePower'), 'kW')], ['关口无功', fmt(GM('ReactivePower'), 'kVar')],
            ['正向电能', fmt(GM('ActiveEnergy'), 'kWh', 1)], ['反向电能', fmt(GM('ReactiveEnergy'), 'kWh', 1)],
            ['功率因数', fmt(GM('PowerFactor'), '', 3)]
          ]
        }
      },
      load: {
        name: '用户负载',
        stats: [['负载功率', fmt(P('LoadPower'), 'kW')], ['最大需量', fmt(P('MaxDemand'), 'kW')]],
        card: {
          title: '用户负载',
          rows: [
            ['负载功率', fmt(P('LoadPower'), 'kW')], ['期望有功功率', fmt(P('ExpectPower'), 'kW')],
            ['最大可充功率', fmt(P('MaxChargePower'), 'kW')], ['最大可放功率', fmt(P('MaxDischaPower'), 'kW')],
            ['市电有功功率', fmt(P('GRID_P'), 'kW')]
          ]
        }
      }
    };
  }

  /* 厂家上报的告警位（点表 a:'alarm'，1 = 报警） */
  function mqttAlarms(map) {
    const out = [];
    const cnt = pick(map, 'EMS', 'AlarmCnt');
    if (cnt !== null && cnt > 0) out.push('厂家告警数量 ' + cnt + ' 条');
    if (typeof POINTS === 'undefined' || !POINTS.byNo) return out;
    const nos = Object.keys(map);
    for (let i = 0; i < nos.length; i++) {
      const def = POINTS.byNo[nos[i]];
      if (!def) continue;
      for (let j = 0; j < def.tags.length; j++) {
        const t = def.tags[j];
        if (t.a !== 'alarm') continue;
        if (num(map[nos[i]][t.t]) === 1) out.push(def.name + '·' + t.n);
        if (out.length >= 20) return out;
      }
    }
    return out;
  }

  /* 收到厂家报文（周期上报 PeriodReport / 召测应答 GetRsp DevData） */
  function mqttReport(report) {
    lastReport = report;
    const map = flatReport(report);
    M.tags = map;

    const pcsP  = pick(map, 'EMS', 'PCS_P');
    const bmsP  = pick(map, 'EMS', 'BMS_P');
    const loadP = pickFrom(map, [['EMS', 'LoadPower'], ['EMS', 'TotalActivePower']]);
    const gridP = pickFrom(map, [['EMS', 'GRID_P'], ['GRID_METER', 'ActivePower']]);
    const rated = pick(map, 'EMS', 'CabPower');
    M.soc = pickFrom(map, [['EMS', 'BMS_SOC'], ['BMS', 'SOC']]);

    /* 曲线滚动窗口（每帧一个点） */
    const t = (report && report.time) ? new Date(report.time * 1000) : new Date();
    const w = M.win;
    w.labels.push(fmtT(t));
    w.actual.push(pcsP);
    w.rated.push(rated !== null ? rated : (w.rated.length ? w.rated[w.rated.length - 1] : null));
    w.user.push(loadP);
    w.storage.push(pcsP !== null ? pcsP : bmsP);
    for (let i = 0; i < 5; i++) {
      const k = ['labels', 'actual', 'rated', 'user', 'storage'][i];
      while (w[k].length > WIN) w[k].shift();
    }

    /* 电量：优先厂家日电量点位；无则按功率积分（会话累计） */
    const tNow = Date.now();
    if (!M.acc.tPrev) M.acc.tPrev = tNow;
    let dtH = (tNow - M.acc.tPrev) / 3600000;
    if (!(dtH > 0) || dtH > 0.5) dtH = 0;
    M.acc.tPrev = tNow;
    if (pcsP  !== null) M.acc.storage += Math.abs(pcsP) * dtH;
    if (loadP !== null) M.acc.load    += Math.max(0, loadP) * dtH;
    if (gridP !== null) M.acc.grid    += Math.max(0, gridP) * dtH;

    const chg = pickFrom(map, [['PCS', 'DC6'], ['PCS', 'DC2'], ['PCS', 'DC5'], ['PCS', 'DC1']]);
    const dis = pickFrom(map, [['PCS', 'DC8'], ['PCS', 'DC4'], ['PCS', 'DC7'], ['PCS', 'DC3']]);
    if (chg !== null || dis !== null) {
      M.dailyEnergy = (chg || 0) + (dis || 0);
      M.hints = { storage: '厂家日电量点位 PCS DC6+DC8（今日）', load: 'LoadPower 功率积分（会话累计）', grid: 'GRID_P 功率积分（会话累计）' };
    } else {
      M.dailyEnergy = null;
      M.hints = { storage: 'PCS_P 功率积分（会话累计）', load: 'LoadPower 功率积分（会话累计）', grid: 'GRID_P 功率积分（会话累计）' };
    }

    M.devices = mqttDevices(map);
    M.alarms  = mqttAlarms(map);
    const mag = Math.abs(pcsP === null ? 0 : pcsP);
    M.flow = 0.6 + Math.min(2.2, mag / 3000);

    if (source !== 'mqtt') { stopTimer(); source = 'mqtt'; }
    emit();
    return mqttSnapshot();
  }

  function mqttSnapshot() {
    const chart = chartMode === 'history'
      ? { labels: M.win.labels.slice(), actual: M.win.actual.slice(), rated: M.win.rated.slice(), user: M.win.user.slice(), storage: M.win.storage.slice() }
      : { labels: M.win.labels.slice(), actual: M.win.actual.slice(), rated: M.win.rated.slice(), user: M.win.user.slice(), storage: M.win.storage.slice() };
    return {
      time: new Date(),
      source: 'mqtt',
      mode: chartMode,
      kpis: {
        chargeToday: Math.round(M.dailyEnergy !== null ? M.dailyEnergy : M.acc.storage),
        loadToday:   Math.round(M.acc.load),
        gridToday:   Math.round(M.acc.grid)
      },
      soc: M.soc === null ? 0 : M.soc,
      pcs:   { labels: chart.labels, actual: chart.actual, rated: chart.rated },
      load:  { labels: chart.labels, user: chart.user, storage: chart.storage },
      devices: M.devices || {},
      alarms: M.alarms,
      flowSpeed: M.flow,
      vendor: C.vendor
    };
  }

  function emit() {
    if (!cb) return;
    cb(source === 'mqtt' ? mqttSnapshot() : mockSnapshot());
  }

  function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }

  /* 切换数据来源：'mock' 演示数据 / 'mqtt' 厂家实时数据 */
  function setSource(src) {
    if (src === 'mqtt') {
      if (source === 'mqtt') { emit(); return; }
      stopTimer(); source = 'mqtt'; emit(); return;
    }
    if (source === 'mock') { emit(); return; }
    stopTimer(); source = 'mock'; seedWin(); emit();
    timer = setInterval(function () { tick(); emit(); }, C.tickMs || 3000);
  }

  /* ============================================================
   * 真实数据映射（http / websocket）：把后端 JSON 映射为"标准快照"。
   * 按你的接口字段名修改此函数即可，例如：
   *   function mapReal(j){
   *     return {
   *       kpis:{ chargeToday:j.charge, loadToday:j.used, gridToday:j.gen },
   *       soc:j.soc,
   *       pcs:{ labels:j.t, actual:j.pcsP, rated:j.pcsRated },
   *       load:{ labels:j.t, user:j.loadP, storage:j.essP },
   *       devices: buildDevices(j),   // 参考本文件 devices() 的结构
   *       alarms:j.alarms || []
   *     };
   *   }
   * ============================================================ */
  function mapReal(j) { return j; }

  function start(callback) {
    cb = callback;
    if (source === 'http') {
      const pull = () => fetch(C.http.url)
        .then(r => r.json())
        .then(j => cb && cb(mapReal(j)))
        .catch(() => {});
      pull();
      timer = setInterval(pull, C.http.interval || 5000);
      return;
    }
    if (source === 'websocket') {
      ws = new WebSocket(C.ws.url);
      ws.onmessage = e => { try { cb && cb(mapReal(JSON.parse(e.data))); } catch (_) {} };
      return;
    }
    if (source === 'mqtt') { emit(); return; }   // 等待厂家上报，收到报文后自动刷新
    // mock 模式
    seedWin();
    emit();
    timer = setInterval(() => { tick(); emit(); }, C.tickMs || 3000);
  }

  /* ---- 供 UI（MQTT 面板 / 电芯健康 / 策略表单）读取的接口 ---- */
  function energyInfo() {
    return {
      mode: M.dailyEnergy !== null ? 'daily' : 'session',
      chargeToday: Math.round(M.dailyEnergy !== null ? M.dailyEnergy : M.acc.storage),
      loadToday: Math.round(M.acc.load),
      gridToday: Math.round(M.acc.grid),
      hints: M.hints
    };
  }

  return {
    start,
    setChartMode(m) { chartMode = m; emit(); },
    snapshot() { return source === 'mqtt' ? mqttSnapshot() : mockSnapshot(); },
    setSource,
    getSource() { return source; },
    mqttReport,
    mqttTags() { return M.tags; },
    lastReport() { return lastReport; },
    energyInfo,
    /* 厂家信息（DeviceInfor 上报制造商时回填） */
    setVendorCompany(name) { if (name) C.vendor.company = name; },
    vendor() { return C.vendor; }
  };
})();
