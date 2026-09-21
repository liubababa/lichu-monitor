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
  /* 多设备：stateByDev[ProductSN/DeviceSN][实例键] = 点位；页面只渲染"当前设备" */
  const stateByDev = {};
  const lastSeenByDev = {};    // 各设备各维度最后更新时间
  const devices = {};          // key = ProductSN/DeviceSN → { psn, dsn, firstSeen, lastSeen, msgs }
  let activeKey = '';          // 当前查看的设备
  let reportTimer = null;

  function devKey(psn, dsn) { return psn + '/' + dsn; }
  function activeState() { return stateByDev[activeKey] || {}; }
  function activeLastSeen() { return lastSeenByDev[activeKey] || {}; }

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

  /* 收报文 → 落到"该设备"的 state（多台设备各存一份，页面只显示当前设备） */
  function ingest(t, payload) {
    const info = parseTopic(t);
    if (!info || !info.dim) return null;
    const isStatus = info.cls === 'status';
    const instKey = normDim(info.dim) + '|' + (info.arr || '') + '|' + (info.clu || '') + '|' + (info.dev || '') + '|' + (info.model || '');
    const dk = devKey(info.psn, info.dsn);
    const reg = devices[dk] || (devices[dk] = { psn: info.psn, dsn: info.dsn, firstSeen: Date.now(), lastSeen: 0, msgs: 0 });
    reg.lastSeen = Date.now();
    reg.msgs++;
    if (!activeKey) activeKey = dk;                       // 第一个上报的设备作为默认查看对象
    const st = stateByDev[dk] || (stateByDev[dk] = {});
    const bucket = st[instKey] || (st[instKey] = { _meta: info, _t: Date.now() });
    bucket._t = Date.now();
    let n = 0;
    Object.keys(payload).forEach(function (k) {
      const i = parseInt(k, 10);
      if (!isFinite(i)) return;
      const def = pointDef(info.dim, i, isStatus);
      const key = def ? def.k : ('#' + i);
      /* 数据帧与状态帧的点位索引会撞号（如同一维度的 3 号点两边含义不同），
         状态点统一加 'S' 前缀分开存，避免后到的帧把先到的一类覆盖掉 */
      const slot = isStatus ? ('S' + i) : String(i);
      bucket[slot] = { v: num(payload[k]), def: def, key: key };
      n++;
    });
    const ls = lastSeenByDev[dk] || (lastSeenByDev[dk] = {});
    ls[normDim(info.dim)] = Date.now();
    if (n) log('↓', t, JSON.stringify(payload).slice(0, 400), info.dim + (isStatus ? '/状态' : '') + ' ' + n + ' 点');
    return { info, instKey, bucket, devKey: dk, isActive: dk === activeKey };
  }

  function capFirst(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  /* 取某维度下某点位值（大小写不敏感；opt.arr 可指定堆号） */
  function val(dim, key, opt) {
    opt = opt || {};
    const want = normDim(dim);
    const st = activeState();
    const keys = Object.keys(st).filter(k => k.split('|')[0] === want);
    for (let i = 0; i < keys.length; i++) {
      const b = st[keys[i]];
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
    const st = activeState();
    const cells = Object.keys(st).filter(k => k.split('|')[0] === 'cell').map(function (k) {
      const b = st[k];
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
  /* 同一维度所有实例求和（站点级电量用；单实例取 val() 只拿第一台） */
  function sumInst(dim, key) {
    const st = activeState();
    let s = null;
    Object.keys(st).forEach(function (k) {
      if (k.split('|')[0] !== normDim(dim)) return;
      const b = st[k];
      const idx = Object.keys(b).filter(function (x) { return b[x] && b[x].key === key; })[0];
      if (idx === undefined) return;
      const v = b[idx].v;
      if (v !== null && v !== undefined && isFinite(Number(v))) s = (s === null ? 0 : s) + Number(v);
    });
    return s;
  }

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
    /* 全站日电量（今日）：各簇日充/放电之和；没有簇数据时退回各 PCS 交流日电量之和 */
    const dayChg = (sumInst('cluster', 'cludaychg_cap') !== null) ? sumInst('cluster', 'cludaychg_cap')
      : ((sumInst('pcs', 'comchgday_cap') !== null) ? sumInst('pcs', 'comchgday_cap') : sumInst('pcs', 'chgday_cap'));
    const dayDis = (sumInst('cluster', 'cludaydis_cap') !== null) ? sumInst('cluster', 'cludaydis_cap')
      : ((sumInst('pcs', 'comdisday_cap') !== null) ? sumInst('pcs', 'comdisday_cap') : sumInst('pcs', 'disday_cap'));
    if (dayChg !== null || dayDis !== null) {
      out.EMS = out.EMS || {};
      if (dayChg !== null) out.EMS.DayCharge = String(dayChg);
      if (dayDis !== null) out.EMS.DayDischarge = String(dayDis);
    }
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
    /* 再次连到已知设备时，直接把它设为当前查看对象 */
    if (cfg.deviceSN && devices[devKey(cfg.productSN, cfg.deviceSN)]) activeKey = devKey(cfg.productSN, cfg.deviceSN);
    emit('conn', { state: 'connecting', url: url });
    sys('连接 Broker：' + url + '　ProductSN=' + cfg.productSN);
    const opts = { reconnectPeriod: 5000, connectTimeout: 10000, keepalive: 120, clean: true, clientId: 'gaote-web-' + Math.random().toString(16).slice(2, 10) };
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
      const res = ingest(topic, json);
      /* 只有"当前设备"的报文才刷新界面；其它设备的数据各自留着，切换时立即显示 */
      if (res && res.isActive && !reportTimer) {
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

  /* ---------------- 告警（遥信） ----------------
     只认状态帧里"告警类"的点：
       · 等级类（…WarnLevel / 预警等级 / 告警汇总等级 Err）：值 > 0 才算
       · 标志类（…Fault / CommErr / alarm / 故障 / 报警…）：值 = 1 才算
     编号（堆号/簇号/设备号）、工作状态、时间戳一律不算告警 */
  const ALARM_NAME = /告警|报警|故障|异常|预警|警告|过压|欠压|过温|欠温|过流|缺液/;
  const SKIP_KEY = /^(ccuno|arrno|arrnum|cluno|clunum|devno|ts)$/i;
  function alarms() {
    const st = activeState();
    const out = [];
    Object.keys(st).forEach(function (k) {
      const b = st[k];
      if (!b || !b._meta || b._meta.cls !== 'status') return;
      const dim = k.split('|')[0];
      const inst = [b._meta.arr, b._meta.clu, b._meta.dev].filter(function (x) { return x !== undefined && x !== '' && x !== '-1'; }).join('/');
      Object.keys(b).forEach(function (i) {
        const it = b[i];
        if (!it || !it.def) return;
        const key = String(it.key || ''), name = String(it.def.n || '');
        if (SKIP_KEY.test(key)) return;
        const v = Number(it.v);
        const isLevel = /warnlevel$/i.test(key) || /预警等级$/.test(name);
        const isFlag = /(fault|commerr|alarm|abn|trouble|detect)/i.test(key) || ALARM_NAME.test(name);
        if (isLevel && v > 0) out.push({ dim: dim, name: name.replace(/等级$/, '') + '（等级 ' + v + '）', inst: inst });
        else if (key === 'Err' && v > 0) out.push({ dim: dim, name: '告警汇总等级 ' + v, inst: inst });
        else if (!isLevel && isFlag && v === 1) out.push({ dim: dim, name: name, inst: inst });
      });
    });
    return out;
  }

  /* ---------------- 设备列表 / 切换 ---------------- */

  /* 发现到的设备（含在线判定：2 分钟内有报文） */
  function devicesList() {
    const now = Date.now();
    return Object.keys(devices).map(function (k) {
      const d = devices[k];
      return {
        psn: d.psn, dsn: d.dsn, lastSeen: d.lastSeen, msgs: d.msgs,
        online: (now - d.lastSeen) < 120000,
        active: k === activeKey
      };
    }).sort(function (a, b) { return b.lastSeen - a.lastSeen; });
  }

  function activeDevice() {
    const d = devices[activeKey];
    return d ? { psn: d.psn, dsn: d.dsn } : null;
  }

  /* 切换当前查看的设备：用该设备已收到的数据立即刷新界面 */
  function setActive(dsn) {
    const hit = Object.keys(devices).filter(function (k) { return devices[k].dsn === dsn; })[0];
    if (!hit) return false;
    activeKey = hit;
    if (!cfg) cfg = {};
    cfg.productSN = devices[hit].psn;
    cfg.deviceSN = devices[hit].dsn;
    pushToUI();
    return true;
  }

  return {
    on, connect, disconnect, publish,
    isConnected: () => !!(client && client.connected),
    /* state 始终指向"当前设备"的一份点位表（getter 保证切换后引用仍有效） */
    get state() { return activeState(); },
    val, buildTags, buildPseudoReport,
    lastSeen: () => activeLastSeen(),
    alarms,
    devicesList, activeDevice, setActive,
    getCfg: () => cfg,
    normUrl
  };
})();
