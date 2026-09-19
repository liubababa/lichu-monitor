/* ============================================================
 * 高特 CCU MQTT 协议接入层
 *
 * 协议依据：《高特MQTT使用手册V1.2》+ 项目协议文档 SJ2025B3781ESCCU-MQTT.xlsx
 *   主题：/{ProductSN}/{DeviceSN}/rtg/data/{维度}/{堆}/{簇}/{设备号}
 *         /{ProductSN}/{DeviceSN}/rtg/status/{维度}/...
 *         /{ProductSN}/{DeviceSN}/cmd/get/emu/{功能}   （遥调/遥控回读）
 *         /{ProductSN}/{DeviceSN}/history/...          （断网补传）
 *   报文：JSON，KEY 为数字索引，值按点表解释；65535 表示无效
 *   周期：30 秒
 *
 * 本模块把高特点位翻译成平台既有界面认识的字段（见 MAP），
 * 再交给 DataService.mqttReport() 渲染，从而复用现有全部页面。
 *
 * 点表：js/gaote-points.js（由 tools/gen-gaote-points.py 自动生成）
 * ============================================================ */
window.GaoteService = (function () {
  'use strict';

  let client = null, cfg = null;
  const handlers = { conn: [], log: [], data: [] };
  const state = {};            // state[维度][实例键] = { 索引: 值 }
  const lastSeen = {};         // 各维度最后更新时间
  let reportTimer = null;

  const DEFAULT_PSN = 'kp23bhcpmt91n2v8';
  const INVALID = [65535, 65534, -1, -2];

  function on(t, fn) { (handlers[t] = handlers[t] || []).push(fn); }
  function emit(t, a) { (handlers[t] || []).forEach(f => { try { f(a); } catch (e) { console.error('[gaote]', e); } }); }
  function log(dir, topic, text, note) { emit('log', { dir, topic, text, note, time: new Date() }); }
  function sys(t) { log('•', '-', t); }

  /* ---------------- 主题解析 ----------------
     /{PSN}/{DSN}/rtg/data/{维度}[/{堆}/{簇}/{设备号}][/extend/{厂商型号}]
     电表维度是两段：meter/{aems|mems|lems}/{storage|antireflux|demand}
     /{PSN}/{DSN}/rtg/status/{维度}/...
     /{PSN}/{DSN}/cmd/get/emu/{功能}
  */
  function parseTopic(topic) {
    const seg = (topic.startsWith('/') ? topic.slice(1) : topic).split('/');
    if (seg.length < 4) return null;
    const r = { psn: seg[0], dsn: seg[1], kind: seg[2], raw: topic };
    if (r.kind === 'rtg' || r.kind === 'history') {
      r.cls = seg[3];                                   // data | status
      let i = 4;
      if (seg[i] === 'meter') {                          // 电表：两段维度 meter/{aems|mems|lems}/{storage|...}
        if (['aems', 'mems', 'lems'].indexOf(seg[i + 1]) >= 0) {
          r.dim = 'meter-' + seg[i + 1] + '-' + seg[i + 2];
          i += 3;
        } else {                                          // 手册示例的简写形式 /meter/{arr}/{clu}/{dev}
          r.dim = 'meter';
          r.legacyMeter = true;
          i += 1;
        }
      } else if (seg[i] === 'arr' || seg[i] === 'clu') {  // 手册示例里的简写：arr / clu
        r.dim = seg[i] === 'arr' ? 'array' : 'cluster';
        i += 1;
      } else {
        r.dim = seg[i];
        i += 1;
      }
      const rest = seg.slice(i);
      const ext = rest.indexOf('extend');
      r.arr = rest[0] !== undefined ? rest[0] : '';
      r.clu = rest[1] !== undefined ? rest[1] : '';
      r.dev = rest[2] !== undefined ? rest[2] : '';
      r.model = ext >= 0 ? rest[ext + 1] : '';
      return r;
    }
    if (r.kind === 'cmd') {
      r.cls = seg[3];                                    // get | set
      r.func = seg.length > 5 ? seg[5] : seg[4];         // powerCmd / totalPower ...
      r.dim = 'emu';
      return r;
    }
    return r;
  }

  /* 维度名大小写归一（协议文档里 t4GInfo 与 t4ginfo 混用） */
  function normDim(d) { return String(d || '').toLowerCase(); }
  const indexCache = {};
  function pointDef(dim, i, isStatus) {
    const key = (isStatus ? 'S:' : 'P:') + normDim(dim);
    let m = indexCache[key];
    if (!m) {
      const table = isStatus ? (window.GAOTE && GAOTE.status) : (window.GAOTE && GAOTE.points);
      m = {};
      if (table) {
        Object.keys(table).forEach(function (d) {
          if (normDim(d) !== normDim(dim)) return;
          table[d].forEach(function (p) { if (!(p.i in m)) m[p.i] = p; });
        });
      }
      indexCache[key] = m;
    }
    return m[i] || null;
  }

  function num(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') {
      const s = v.trim();
      if (!s) return null;
      const n = parseFloat(s);
      return isFinite(n) ? n : s;                       // 字符串点位（SN/IP 等）原样返回
    }
    const n = Number(v);
    if (!isFinite(n)) return null;
    if (INVALID.indexOf(n) >= 0) return null;           // 65535 等按无效处理
    return n;
  }

  /* 收报文 → 落到 state */
  function ingest(t, payload) {
    const info = parseTopic(t);
    if (!info || !info.dim) return null;
    const isStatus = info.cls === 'status';
    const instKey = normDim(info.dim) + '|' + (info.arr || '') + '|' + (info.clu || '') + '|' + (info.dev || '') + '|' + (info.model || '');
    const bucket = state[instKey] || (state[instKey] = { _meta: info, _t: Date.now() });
    bucket._t = Date.now();
    let n = 0;
    Object.keys(payload).forEach(function (k) {
      const i = parseInt(k, 10);
      if (!isFinite(i)) return;
      const def = pointDef(info.dim, i, isStatus);
      const key = def ? def.k : ('#' + i);
      bucket[i] = { v: num(payload[k]), def: def, key: key };
      n++;
    });
    lastSeen[normDim(info.dim)] = Date.now();
    if (n) log('↓', t, JSON.stringify(payload).slice(0, 400), info.dim + (isStatus ? '/状态' : '') + ' ' + n + ' 点');
    return { info, instKey, bucket };
  }

  function capFirst(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  /* 取某维度下某点位值（大小写不敏感；opt.arr 可指定堆号） */
  function val(dim, key, opt) {
    opt = opt || {};
    const want = normDim(dim);
    const keys = Object.keys(state).filter(k => k.split('|')[0] === want);
    for (let i = 0; i < keys.length; i++) {
      const b = state[keys[i]];
      if (opt.arr !== undefined && b._meta && String(b._meta.arr) !== String(opt.arr)) continue;
      const ks = Object.keys(b);
      for (let j = 0; j < ks.length; j++) {
        const it = b[ks[j]];
        if (it && it.key === key && it.v !== null && it.v !== undefined) return it.v;
      }
    }
    return null;
  }

  /* ---------------- 高特 → 平台界面字段映射 ---------------- */
  /* [高特维度, 高特点位key, 换算系数(可选)] */
  const MAP = {
    systemSet: {
      SN: ['EMS', 'Devsid'],
      version: ['EMS', 'EMSversion'],
      netIp: ['t4ginfo', 'Ip'],
      SignalStrength: ['t4ginfo', 'CSQ_PER'],
      Ccid: ['t4ginfo', 'ICCID'],
      Online: ['EMS', 'Devsid']
    },
    EMS: {
      PCS_P: ['emu', 'PCSSumsActivePower'],
      PCS_Q: ['emu', 'PCSSumsReactivePower'],
      BMS_SOC: ['emu', 'SumsSOC'],
      DCBusVol: ['emu', 'DCBusVol'],
      MaxChargePower: ['emu', 'MaxAllowChargPower'],
      MaxDischaPower: ['emu', 'MinAllowChargPower'],
      SysStatus: ['emu', 'SysStatus'],
      ControlMode: ['emu', 'ControlSrc'],
      GRID_P: ['meter-lems-antireflux', 'meter_tot_p'],
      GRID_Q: ['meter-lems-antireflux', 'meter_tot_q'],
      Online: ['emu', 'PCSSumsActivePower']
    },
    PCS: {
      ActivePower: ['pcs', 'ac_pow_p'],
      ReactivePower: ['pcs', 'ac_pow_q'],
      ApparentPower: ['pcs', 'ac_pow_s'],
      ACFactor: ['pcs', 'ac_pow_pf'],
      AphaseVoltage: ['pcs', 'ac_uw_vol'],
      BphaseVoltage: ['pcs', 'ac_vw_vol'],
      CphaseVoltage: ['pcs', 'ac_wu_vol'],
      Frequency: ['pcs', 'grd_f'],
      BatVolt: ['pcs', 'battery_voltage'],
      BatCurr: ['pcs', 'battery_current'],
      BatPower: ['pcs', 'dc_pow'],
      IGBTTemp: ['pcs', 'igbt_temp'],
      RunStatu: ['pcs', 'run_sta'],
      GridOnOff: ['pcs', 'offgrd_sta'],
      DC2: ['pcs', 'chgday_cap'],
      DC4: ['pcs', 'disday_cap'],
      DC6: ['pcs', 'comchgday_cap'],
      DC8: ['pcs', 'comdisday_cap'],
      Online: ['pcs', 'ac_pow_p']
    },
    BMS: {
      SOC: ['array', 'arrSOC'],
      SOH: ['array', 'arrSOH'],
      RackVoltage: ['cluster', 'cluVol'],
      RackCurrent: ['cluster', 'cluCur'],
      RackRunState: ['cluster', 'cluStatus'],
      RackMaxTemp: ['cluster', 'maxCellTem'],
      RackMinTemp: ['cluster', 'minCellTem'],
      RackMaxTempModuleId: ['cluster', 'maxCellTemCellNum'],
      RackMinTempModuleId: ['cluster', 'minCellTemCellNum'],
      RackMaxTempCellId: ['cluster', 'maxCellTemCellNum'],
      RackMinTempCellId: ['cluster', 'minCellTemCellNum'],
      RackMaxVoltage: ['cluster', 'maxCellVol', 1000],
      RackMinVoltage: ['cluster', 'minCellVol', 1000],
      RackMaxVoltageModuleId: ['cluster', 'maxCellVolCellNum'],
      RackMinVoltageModuleId: ['cluster', 'minCellVolCellNum'],
      RackMaxVolCellId: ['cluster', 'maxCellVolCellNum'],
      RackMinVolCellId: ['cluster', 'minCellVolCellNum'],
      RackPosInsulatVal: ['cluster', 'cluPosres'],
      RackNegInsulatVal: ['cluster', 'cluNegres'],
      CellVolDif: ['array', 'CellVolDif', 1000],
      RackAverageVolt: ['array', 'arrVol'],
      Online: ['array', 'arrSOC']
    },
    TMS: {
      InflowTemp: ['liqcool', 'liqhot_water_tmp'],
      EffluentTemp: ['liqcool', 'liqinlet_water_tmp'],
      AmbientTemp: ['liqcool', 'liq_outtmp'],
      WaterInPreVal: ['liqcool', 'liqinlet_water_pre'],
      WaterOutPreVal: ['liqcool', 'liqhydraulic_pressure'],
      PressSpeed: ['liqcool', 'pump_target_speed'],
      PumpStatus: ['liqcool', 'liq_pump_status'],
      CompressorStatus: ['liqcool', 'liq_coldsta'],
      Read_15: ['liqcool', 'current_mod'],
      AlarmLevel: ['liqcool', 'alarm_sta'],
      Online: ['liqcool', 'liqinlet_water_tmp']
    },
    FIRE: {
      TempValue: ['fire', 'fire_temp'],
      COConcentration: ['fire', 'fire_co'],
      H2Concentration: ['fire', 'fire_h2'],
      VOCConcentration: ['fire', 'voc_con'],
      SmokeAttenuation: ['fire', 'fire_smoke'],
      Online: ['fire', 'fire_co']
    },
    CSJ: {
      CurTemp: ['drier', 'time_tem'],
      CurHum: ['drier', 'time_wet'],
      DehumStatus: ['drier', 'drier_wholerun'],
      HeatState: ['drier', 'drier_hotsta'],
      Online: ['drier', 'time_tem']
    },
    PCS_METER: {
      ActivePower: ['meter-aems-storage', 'meter_tot_p'],
      ReactivePower: ['meter-aems-storage', 'meter_tot_q'],
      ApparentPower: ['meter-aems-storage', 'meter_tot_s'],
      PowerFactor: ['meter-aems-storage', 'meter_tot_pf'],
      AphaseVoltage: ['meter-aems-storage', 'meter_a_vol'],
      BphaseVoltage: ['meter-aems-storage', 'meter_b_vol'],
      CphaseVoltage: ['meter-aems-storage', 'meter_c_vol'],
      AphaseCurrent: ['meter-aems-storage', 'meter_a_cur'],
      BphaseCurrent: ['meter-aems-storage', 'meter_b_cur'],
      CphaseCurrent: ['meter-aems-storage', 'meter_c_cur'],
      ActiveEnergy: ['meter-aems-storage', 'meter_add_pos'],
      ReactiveEnergy: ['meter-aems-storage', 'meter_add_neg'],
      Frequency: ['meter-aems-storage', 'meter_f'],
      Online: ['meter-aems-storage', 'meter_tot_p']
    },
    GRID_METER: {
      ActivePower: ['meter-lems-antireflux', 'meter_tot_p'],
      ReactivePower: ['meter-lems-antireflux', 'meter_tot_q'],
      ApparentPower: ['meter-lems-antireflux', 'meter_tot_s'],
      PowerFactor: ['meter-lems-antireflux', 'meter_tot_pf'],
      AphaseVoltage: ['meter-lems-antireflux', 'meter_a_vol'],
      BphaseVoltage: ['meter-lems-antireflux', 'meter_b_vol'],
      CphaseVoltage: ['meter-lems-antireflux', 'meter_c_vol'],
      AphaseCurrent: ['meter-lems-antireflux', 'meter_a_cur'],
      BphaseCurrent: ['meter-lems-antireflux', 'meter_b_cur'],
      CphaseCurrent: ['meter-lems-antireflux', 'meter_c_cur'],
      ActiveEnergy: ['meter-lems-antireflux', 'meter_add_pos'],
      ReactiveEnergy: ['meter-lems-antireflux', 'meter_add_neg'],
      Frequency: ['meter-lems-antireflux', 'meter_f'],
      Online: ['meter-lems-antireflux', 'meter_tot_p']
    }
  };

  /* 电芯：/rtg/data/cell/{arr}/{clu}/{电芯号} → RkCeVolt{序号}(mV) / RkCeTemp{序号}(℃)
     多堆时按 (堆号, 电芯号) 排序统一编号，避免不同堆的同号电芯互相覆盖 */
  function buildCells() {
    const out = {};
    const cells = Object.keys(state).filter(k => k.split('|')[0] === 'cell').map(function (k) {
      const b = state[k];
      const arr = b._meta && b._meta.arr !== '' ? parseInt(b._meta.arr, 10) : 0;
      const no = b._meta && b._meta.dev !== '' ? parseInt(b._meta.dev, 10) : NaN;
      return { b: b, arr: isFinite(arr) ? arr : 0, no: no };
    }).filter(c => isFinite(c.no));
    cells.sort(function (a, b) { return a.arr - b.arr || a.no - b.no; });
    cells.forEach(function (c, idx) {
      const n = String(idx + 1).padStart(3, '0');
      Object.keys(c.b).forEach(function (i) {
        const it = c.b[i];
        if (!it || !it.key) return;
        if (it.key === 'CelVol' && it.v !== null) out['RkCeVolt' + n] = +(it.v * 1000).toFixed(0);
        else if (it.key === 'CelTem' && it.v !== null) out['RkCeTemp' + n] = +Number(it.v).toFixed(1);
      });
    });
    return out;
  }

  /* 按 MAP 生成平台界面用的点位表 */
  function buildTags() {
    const out = {};
    Object.keys(MAP).forEach(function (dev) {
      const t = {};
      const defs = MAP[dev];
      Object.keys(defs).forEach(function (tag) {
        const [dim, key, factor] = defs[tag];
        let v = val(dim, key);
        if (v !== null && v !== undefined && factor) v = +(v * factor).toFixed(2);
        if (v !== null && v !== undefined) t[tag] = (typeof v === 'number') ? String(v) : v;
      });
      if (Object.keys(t).length) out[dev] = t;
    });
    /* 系统参数里的 Online 归一化 */
    if (out.systemSet) out.systemSet.Online = out.systemSet.SN ? '1' : '0';
    ['EMS', 'PCS', 'BMS', 'TMS', 'FIRE', 'CSJ', 'PCS_METER', 'GRID_METER'].forEach(function (dev) {
      if (out[dev]) out[dev].Online = '1';
    });
    /* 电芯 */
    const cells = buildCells();
    if (Object.keys(cells).length) out.BMS_CELLS = cells;
    return out;
  }

  /* 生成"晶农格式"的报文，交给既有渲染链路复用 */
  function buildPseudoReport() {
    const tags = buildTags();
    if (!Object.keys(tags).length) return null;
    const data = Object.keys(tags).map(function (deviceType) {
      return { deviceType: deviceType, tags: tags[deviceType] };
    });
    return { identifier: 'PeriodReport', SN: (cfg && cfg.deviceSN) || '', data: data, time: Math.floor(Date.now() / 1000), _gaote: true };
  }

  function pushToUI() {
    if (typeof DataService === 'undefined' || !DataService.mqttReport) return;
    const rep = buildPseudoReport();
    if (!rep) return;
    DataService.mqttReport(rep);
    if (window.OverviewUI) OverviewUI.update(DataService.mqttTags(), 'mqtt');
    if (window.GaoteView) GaoteView.update();
    if (window.GaoteScene3D) GaoteScene3D.update();
    emit('data', rep);
  }

  /* ---------------- MQTT ---------------- */
  function normUrl(url, port) {
    let u = String(url || '').trim();
    if (!u) return '';
    if (!/^wss?:\/\//i.test(u)) u = (/^https?:\/\//i.test(u) ? 'wss://' + u.replace(/^https?:\/\//i, '') : 'ws://' + u);
    const p = String(port || '').trim();
    if (p && !/:\d+\s*(\/|$)/.test(u)) {
      const cut = u.indexOf('/', u.indexOf('://') + 3);
      u = (cut === -1) ? u + ':' + p : u.slice(0, cut) + ':' + p + u.slice(cut);
    }
    return u;
  }

  function connect(c) {
    cfg = c || {};
    if (client) { try { client.end(true); } catch (_) {} client = null; }
    if (typeof mqtt === 'undefined') { sys('mqtt.js 未加载'); emit('conn', { state: 'error', error: 'mqtt.js 未加载' }); return; }
    const url = normUrl(cfg.url, cfg.port);
    if (!url) { sys('Broker 地址为空'); emit('conn', { state: 'error', error: 'Broker 地址为空' }); return; }
    cfg.url = url;
    cfg.productSN = cfg.productSN || DEFAULT_PSN;
    emit('conn', { state: 'connecting', url: url });
    sys('连接 Broker：' + url + '　ProductSN=' + cfg.productSN);
    const opts = { reconnectPeriod: 5000, connectTimeout: 10000, keepalive: 30, clean: true, clientId: 'gaote-web-' + Math.random().toString(16).slice(2, 10) };
    if (cfg.username) opts.username = cfg.username;
    if (cfg.password) opts.password = cfg.password;
    try { client = mqtt.connect(url, opts); } catch (e) { sys('连接异常：' + e.message); emit('conn', { state: 'error', error: e.message }); return; }

    client.on('connect', function () {
      sys('Broker 连接成功，订阅高特主题');
      const subs = [];
      if (cfg.productSN && cfg.deviceSN) subs.push('/' + cfg.productSN + '/' + cfg.deviceSN + '/#');
      subs.push('/' + cfg.productSN + '/+/#');          // 设备序列号未知时兜底
      subs.push('+/+/#');                               // 极端兜底：ProductSN/DeviceSN 填错也能收到
      subs.forEach(t => client.subscribe(t, { qos: 1 }, function (err) {
        if (err) sys('订阅失败 ' + t + '：' + (err.message || err));
        else sys('已订阅 ' + t);
      }));
      emit('conn', { state: 'connected', url: url });
    });
    client.on('reconnect', () => emit('conn', { state: 'reconnecting' }));
    client.on('close', () => emit('conn', { state: 'disconnected' }));
    client.on('error', e => { sys('连接错误：' + (e.message || e)); emit('conn', { state: 'error', error: e.message || String(e) }); });
    client.on('message', function (topic, buf) {
      let json = null;
      const text = buf.toString();
      try { json = JSON.parse(text); } catch (_) { log('↓', topic, text.slice(0, 120), '非 JSON（可能是压缩报文）'); return; }
      if (!json || typeof json !== 'object') return;
      /* 遥调/遥控回读：/cmd/get/emu/{功能} */
      const info = parseTopic(topic);
      if (info && info.kind === 'cmd' && info.cls === 'get') {
        log('↓', topic, text.slice(0, 300), '下发回读 ' + (info.func || ''));
        emit('cmdget', { func: info.func, payload: json, topic: topic });
        return;
      }
      if (info && info.kind === 'cmd') return;   /* 自己下发的 cmd/set 回声，不入数据 */
      ingest(topic, json);
      if (!reportTimer) {
        reportTimer = setTimeout(function () { reportTimer = null; pushToUI(); }, 800);
      }
    });
  }

  /* 下发：/{ProductSN}/{DeviceSN}/cmd/set/emu/{功能} */
  function publish(topic, obj, note) {
    if (!client || !client.connected) return false;
    const text = JSON.stringify(obj);
    try { client.publish(topic, text, { qos: 1 }); } catch (e) { return false; }
    log('↑', topic, text, note || '平台下发');
    return true;
  }

  function disconnect() {
    if (client) { try { client.end(true); } catch (_) {} client = null; }
    sys('连接已断开');
    emit('conn', { state: 'disconnected' });
  }

  return {
    on, connect, disconnect, publish,
    isConnected: () => !!(client && client.connected),
    state, val, buildTags, buildPseudoReport,
    lastSeen: () => lastSeen,
    getCfg: () => cfg,
    normUrl
  };
})();
