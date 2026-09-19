/* ============================================================
 * 设备总览（主页）—— 晶农EMS 点表九大板块，每板块独立样式
 *
 * 数据源：
 *   · 只来自设备 MQTT 上报：MqttUI.ingest() → OverviewUI.update(tagsMap, 'mqtt')
 *     tagsMap = { EMS:{TAG:值}, PCS:{...}, BMS:{...}, BMS_CELLS:{...},
 *                 PCS_METER:{...}, GRID_METER:{...}, TMS:{...},
 *                 DIDO:{...}, FIRE:{...}, CSJ:{...}, systemSet:{...} }
 *   · 没有数据时各板块显示「--」，不含任何本地模拟/演示数据
 *
 * 板块与定制样式：
 *   1 系统参数  横向状态条（CPU/内存/磁盘进度条 + 4G 信号格）
 *   2 EMS       功率流五 tiles（市电/光伏/储能/负载/充电桩）+ SOC 环 + 运行徽章
 *   3 变流器    大状态徽章 + 交流/直流电气量 + 日充放电量 + 告警 chips
 *   4 主控      SOC/SOH/SOE 三环 + 簇信息 + 极值定位 + 绝缘 + 分级告警
 *   5 液冷机    冷却回路（出水→柜→回水）+ 压力 + 泵/压缩机状态
 *   6 电芯      电压/温度 CSS 热力图（224 + 112 格）
 *   7 储能表    电表卡（大功率数 + 三相表 + 电能）
 *   8 关口表    同电表卡，独立配色
 *   9 其他      干接点灯板 + 消防灯牌 + 除湿机
 * ============================================================ */
window.OverviewUI = (function () {
  'use strict';

  const byId = id => document.getElementById(id);
  const C = { teal: '#2ee6c8', amber: '#ffb020', red: '#ff6e50', dim: '#6f9a94' };

  /* ---------------- 工具 ---------------- */
  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }
  function num(v) {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    if (!s || /^bad$/i.test(s) || s === '--') return null;
    const n = parseFloat(s);
    return isFinite(n) ? n : null;
  }
  function fmt(v, unit, digits) {
    if (v === null || v === undefined) return '--';
    const dig = (digits === undefined || digits === null)
      ? (Math.abs(v) >= 1000 ? 0 : (Math.abs(v) >= 100 ? 1 : 2)) : digits;
    return Number(v).toFixed(dig) + (unit || '');
  }
  function gv(map, no, tag) { const d = map && map[no]; return d ? d[tag] : undefined; }
  function gn(map, no, tag) { return num(gv(map, no, tag)); }
  const ENUM = {
    RunStatu: { 0: '停机', 1: '开机中', 5: '待机', 9: '恒压运行', 32: '故障', 257: '恒流运行' },
    RackRunState: { 1: '初始化', 2: '自检', 3: '上电', 4: '上电完成', 5: '禁充', 6: '禁放', 7: '待机', 8: '故障下电', 9: '故障已清除', 10: '测试模式', 11: '单簇维护', 12: '下电中', 13: '下电完成', 14: 'P+/P-检测中' },
    TmsMode: { 0: '停止', 1: '内循环', 2: '制冷', 3: '加热' },
    ControlMode: { 0: '手动', 1: '自动策略', 2: '远程', 3: '子系统' },
    GridOnOff: { 0: '并网', 1: '离网' },
    RackCagDsgState: { 0: '静置', 1: '放电', 2: '充电' },
    DehumStatus: { 0: '待机', 1: '正在除湿' }
  };
  function enumText(mapName, v) {
    const n = num(v);
    if (n === null) return '--';
    return (ENUM[mapName] || {})[n] || ('未知(' + n + ')');
  }
  function onlineDot(map, no) {
    const v = gn(map, no, 'Online');
    return v === null ? 'na' : (v === 1 ? 'on' : 'off');
  }
  /* 点表定义里的 alarm 位扫描（=1 视为告警） */
  function scanAlarms(map, no, max) {
    const out = [];
    try {
      const def = POINTS.byNo[no];
      const d = map && map[no];
      if (!def || !d) return out;
      for (const t of def.tags) {
        if (t.a !== 'alarm') continue;
        if (num(d[t.t]) === 1) out.push(t.n);
        if (out.length >= (max || 6)) break;
      }
    } catch (_) {}
    return out;
  }
  function alarmChips(map, no) {
    const list = scanAlarms(map, no, 6);
    const box = el('div', 'alarm-chips');
    const cnt = list.length;
    const head = el('span', 'chip ' + (cnt ? 'bad' : 'ok'), cnt ? ('告警 ' + cnt) : '无告警');
    box.appendChild(head);
    list.forEach(n => box.appendChild(el('span', 'chip bad', n)));
    return box;
  }

  /* ---------------- 板块骨架 ---------------- */
  const R = {};   // 元素引用表
  function sec(key, clsName, title, tagNo, span) {
    const s = el('section', 'ov-sec ' + clsName + (span ? ' ' + span : ''));
    const head = el('div', 'ov-sec-head');
    head.appendChild(el('b', '', title));
    head.appendChild(el('span', 'ov-tagchip', tagNo));
    const dot = el('i', 'ov-online na'); head.appendChild(dot);
    R[key + ':dot'] = dot;
    s.appendChild(head);
    const body = el('div', 'ov-sec-body');
    s.appendChild(body);
    return { s, body };
  }
  function kvGrid(body, key, defs) {
    const g = el('div', 'kv-grid');
    R[key] = {};
    defs.forEach(d => {
      const row = el('div', 'kv');
      row.appendChild(el('span', 'k', d[1]));
      const v = el('b', 'v', '--');
      row.appendChild(v);
      g.appendChild(row);
      R[key][d[0]] = v;
    });
    body.appendChild(g);
    return g;
  }
  function setKV(key, defs, map) {
    const store = R[key] || {};
    defs.forEach(d => {
      const v = gn(map, d[2], d[0]);
      const node = store[d[0]];
      if (node) node.textContent = fmt(v, d[3] || '', d[4]);
    });
  }

  /* ---------------- 1 系统参数 ---------------- */
  function buildSys() {
    const { s, body } = sec('sys', 'ov-sys', '系统参数 · 网关运行', 'systemSet', 'sp12');
    const strip = el('div', 'sys-strip');
    R.sys = {};
    function chipItem(key, label) {
      const c = el('div', 'sys-chip');
      c.appendChild(el('span', 'sc-label', label));
      const v = el('b', 'sc-val', '--');
      c.appendChild(v);
      strip.appendChild(c);
      R.sys[key] = v;
      return v;
    }
    chipItem('SN', 'SN');
    chipItem('version', '版本');
    chipItem('netIp', 'IP');
    chipItem('Ccid', 'SIM 卡号');
    /* 进度条组 */
    function bar(key, label) {
      const b = el('div', 'sys-bar');
      b.innerHTML = '<span class="sc-label">' + label + '</span>'
        + '<span class="bar-track"><i class="bar-fill"></i></span><b class="sc-val">--</b>';
      strip.appendChild(b);
      R.sys[key] = { fill: b.querySelector('.bar-fill'), val: b.querySelector('.sc-val') };
    }
    bar('CpuUsage', 'CPU');
    bar('Rss', '内存');
    bar('DiskSpace', '磁盘');
    /* 4G 信号格 */
    const sig = el('div', 'sys-signal');
    sig.innerHTML = '<span class="sc-label">4G 信号</span><span class="sig-bars">'
      + '<i></i><i></i><i></i><i></i><i></i></span><b class="sc-val">--</b>';
    strip.appendChild(sig);
    R.sys.SignalStrength = { bars: sig.querySelectorAll('.sig-bars i'), val: sig.querySelector('.sc-val') };
    body.appendChild(strip);
    R.sysSec = s;
    return s;
  }
  function updSys(map) {
    const d = (map && map.systemSet) || {};
    ['SN', 'version', 'netIp', 'Ccid'].forEach(k => {
      R.sys[k].textContent = (d[k] === undefined || d[k] === null || d[k] === '') ? '--' : String(d[k]);
    });
    [['CpuUsage', '%'], ['Rss', 'MB'], ['DiskSpace', 'MB']].forEach(([k, u]) => {
      const n = num(d[k]);
      const o = R.sys[k];
      if (n === null) { o.fill.style.width = '0%'; o.val.textContent = '--'; return; }
      const pct = k === 'CpuUsage' ? Math.min(100, n)
        : k === 'DiskSpace' ? Math.min(100, n / 8192)
        : Math.min(100, n / 2048);
      o.fill.style.width = pct.toFixed(1) + '%';
      o.fill.className = 'bar-fill' + (pct > 85 ? ' hot' : '');
      o.val.textContent = fmt(n, u, 0);
    });
    const sigN = num(d.SignalStrength);
    const lv = sigN === null ? 0 : Math.max(0, Math.min(5, Math.ceil(sigN / 6)));
    R.sys.SignalStrength.bars.forEach((b, i) => b.className = i < lv ? 'on' : '');
    R.sys.SignalStrength.val.textContent = sigN === null ? '--' : String(sigN);
  }

  /* ---------------- 2 EMS 功率流 ---------------- */
  function buildEms() {
    const { s, body } = sec('ems', 'ov-ems', 'EMS · 电站能量流', 'EMS', 'sp12');
    const wrap = el('div', 'ems-wrap');
    /* 左：SOC 环 */
    const socBox = el('div', 'ems-soc');
    socBox.innerHTML = '<svg viewBox="0 0 80 80"><circle class="rbg" cx="40" cy="40" r="33"/>'
      + '<circle class="rfg" cx="40" cy="40" r="33"/></svg><b><span id="ovSoc">--</span><i>%</i></b>'
      + '<span class="ems-soc-label">储能 SOC</span>';
    wrap.appendChild(socBox);
    R.emsSocRing = socBox.querySelector('.rfg');
    R.emsSocVal = socBox.querySelector('#ovSoc');
    /* 中：功率流 tiles */
    const flow = el('div', 'pf-row');
    R.ems = {};
    [['GRID_P', '市电', 'grid'], ['PV_P', '光伏', 'pv'], ['PCS_P', '储能', 'ess'], ['LoadPower', '负载', 'load'], ['PCU_P', '充电桩', 'pcu']]
      .forEach(([tag, label, cls]) => {
        const t = el('div', 'pf-tile pf-' + cls);
        t.innerHTML = '<span class="pf-label">' + label + '</span><b class="pf-num">--</b><u class="pf-unit">kW</u>';
        flow.appendChild(t);
        R.ems[tag] = t.querySelector('.pf-num');
      });
    wrap.appendChild(flow);
    /* 右：状态徽章列 */
    const badges = el('div', 'ems-badges');
    R.emsBadges = {};
    [['mode', '运行模式'], ['sys', '系统状态'], ['prot', '保护状态'], ['rated', '额定'], ['alarm', '告警']]
      .forEach(([k, label]) => {
        const b = el('div', 'ems-badge');
        b.appendChild(el('span', 'eb-label', label));
        const v = el('b', 'eb-val', '--');
        b.appendChild(v);
        badges.appendChild(b);
        R.emsBadges[k] = v;
      });
    wrap.appendChild(badges);
    body.appendChild(wrap);
    R.emsSec = s;
    return s;
  }
  function updEms(map) {
    const P = t => gn(map, 'EMS', t);
    const set = (tag, v) => { R.ems[tag].textContent = fmt(v, '', 1); R.ems[tag].classList.toggle('neg', v !== null && v < 0); };
    set('GRID_P', P('GRID_P')); set('PV_P', P('PV_P')); set('PCS_P', P('PCS_P'));
    set('LoadPower', P('LoadPower')); set('PCU_P', P('PCU_P'));
    const soc = P('BMS_SOC') !== null ? P('BMS_SOC') : gn(map, 'BMS', 'SOC');
    R.emsSocVal.textContent = soc === null ? '--' : soc.toFixed(1);
    const cc = 2 * Math.PI * 33;
    R.emsSocRing.style.strokeDasharray = cc;
    R.emsSocRing.style.strokeDashoffset = soc === null ? cc : cc * (1 - Math.max(0, Math.min(100, soc)) / 100);
    const modeV = gn(map, 'EMS', 'ControlMode');
    R.emsBadges.mode.textContent = modeV === null ? '--' : enumText('ControlMode', modeV);
    const sysV = gn(map, 'EMS', 'SysStatus');
    R.emsBadges.sys.textContent = sysV === null ? '--' : (sysV === 0 ? '正常' : '异常');
    R.emsBadges.sys.className = 'eb-val ' + (sysV === null ? '' : sysV === 0 ? 'ok' : 'bad');
    const jc = (gn(map, 'EMS', 'ProhibiteCha') === 1 ? '禁充' : '') + (gn(map, 'EMS', 'ProhibiteDisc') === 1 ? '禁放' : '');
    R.emsBadges.prot.textContent = jc || '正常';
    R.emsBadges.prot.className = 'eb-val ' + (jc ? 'warn' : 'ok');
    R.emsBadges.rated.textContent = fmt(P('CabPower'), 'kW / ', 0) + fmt(P('CabCapacity'), 'kWh', 0);
    const ac = gn(map, 'EMS', 'AlarmCnt');
    R.emsBadges.alarm.textContent = ac === null ? '--' : (ac > 0 ? ac + ' 条' : '无');
    R.emsBadges.alarm.className = 'eb-val ' + (ac > 0 ? 'bad' : 'ok');
  }

  /* ---------------- 3 变流器 PCS ---------------- */
  function buildPcs() {
    const { s, body } = sec('pcs', 'ov-pcs', '变流器 PCS', 'PCS', 'sp5');
    /* 状态英雄区 */
    const hero = el('div', 'pcs-hero');
    R.pcs = {};
    const st = el('div', 'pcs-state');
    st.innerHTML = '<span class="pcs-state-label">工作状态</span><b class="pcs-state-val">--</b>'
      + '<span class="pcs-gridmode">并离网：--</span>';
    hero.appendChild(st);
    R.pcs.state = st.querySelector('.pcs-state-val');
    R.pcs.grid = st.querySelector('.pcs-gridmode');
    /* 日充放电量四宫格 */
    const dc = el('div', 'dc-grid');
    [['DC6', '今日充电', 'in'], ['DC8', '今日放电', 'out'], ['DC2', '直流充电', 'in'], ['DC4', '直流放电', 'out']]
      .forEach(([tag, label, cls]) => {
        const t = el('div', 'dc-tile ' + cls);
        t.innerHTML = '<span>' + label + '</span><b>--</b><u>kWh</u>';
        dc.appendChild(t);
        R.pcs[tag] = t.querySelector('b');
      });
    hero.appendChild(dc);
    body.appendChild(hero);
    kvGrid(body, 'pcsKV', [
      ['AphaseVoltage', 'A相电压', 'PCS', 'V', 1], ['BphaseVoltage', 'B相电压', 'PCS', 'V', 1], ['CphaseVoltage', 'C相电压', 'PCS', 'V', 1],
      ['Frequency', '电网频率', 'PCS', 'Hz', 2],
      ['ActivePower', '总有功功率', 'PCS', 'kW', 1], ['ReactivePower', '总无功功率', 'PCS', 'kVar', 1],
      ['ApparentPower', '总视在功率', 'PCS', 'kVA', 1], ['ACFactor', '功率因数', 'PCS', '', 3],
      ['BatVolt', '电池电压', 'PCS', 'V', 1], ['BatCurr', '电池电流', 'PCS', 'A', 1],
      ['BatPower', '直流功率', 'PCS', 'kW', 1], ['IGBTTemp', 'IGBT 温度', 'PCS', '℃', 1]
    ]);
    body.appendChild(el('div', 'alarm-chips'));   // 占位，update 时重建
    R.pcsAlarms = body.lastChild;
    R.pcsSec = s;
    return s;
  }
  function updPcs(map) {
    setKV('pcsKV', [
      ['AphaseVoltage'], ['BphaseVoltage'], ['CphaseVoltage'], ['Frequency'],
      ['ActivePower'], ['ReactivePower'], ['ApparentPower'], ['ACFactor'],
      ['BatVolt'], ['BatCurr'], ['BatPower'], ['IGBTTemp']
    ].map(d => [d[0], d[0], 'PCS'].concat(d.slice(1))), map);
    const rs = gn(map, 'PCS', 'RunStatu');
    R.pcs.state.textContent = rs === null ? '--' : enumText('RunStatu', rs);
    R.pcs.state.className = 'pcs-state-val ' + (rs === null ? '' : rs === 32 ? 'bad' : (rs === 0 || rs === 5) ? 'idle' : 'run');
    const go = gn(map, 'PCS', 'GridOnOff');
    R.pcs.grid.textContent = '并离网：' + (go === null ? '--' : enumText('GridOnOff', go));
    [['DC6'], ['DC8'], ['DC2'], ['DC4']].forEach(([t]) => {
      const v = gn(map, 'PCS', t);
      R.pcs[t].textContent = v === null ? '--' : v.toFixed(1);
    });
    const fresh = alarmChips(map, 'PCS');
    R.pcsAlarms.parentNode.replaceChild(fresh, R.pcsAlarms);
    R.pcsAlarms = fresh;
  }

  /* ---------------- 4 主控 BMS ---------------- */
  function buildBms() {
    const { s, body } = sec('bms', 'ov-bms', '电池主控 BMS', 'BMS', 'sp4');
    /* 三环 */
    const rings = el('div', 'bms-rings');
    R.bms = {};
    [['SOC', 'SOC', '%'], ['SOH', 'SOH', '%'], ['SOE', 'SOE', '%']].forEach(([k, label]) => {
      const r = el('div', 'bms-ring');
      r.innerHTML = '<svg viewBox="0 0 64 64"><circle class="rbg" cx="32" cy="32" r="26"/>'
        + '<circle class="rfg" cx="32" cy="32" r="26"/></svg><b><span>--</span><i>%</i></b>'
        + '<span class="br-label">' + label + '</span>';
      rings.appendChild(r);
      R.bms[k] = { ring: r.querySelector('.rfg'), val: r.querySelector('span') };
    });
    body.appendChild(rings);
    /* 状态徽章 */
    const st = el('div', 'bms-state');
    st.innerHTML = '<span>电池状态</span><b>--</b>';
    body.appendChild(st);
    R.bmsState = st.querySelector('b');
    kvGrid(body, 'bmsKV', [
      ['RackVoltage', '簇电压', 'BMS', 'V', 1], ['RackCurrent', '簇电流', 'BMS', 'A', 1],
      ['RackMaxTemp', '最高温度', 'BMS', '℃', 0], ['RackMinTemp', '最低温度', 'BMS', '℃', 0],
      ['RackMaxVoltage', '最高单体', 'BMS', 'mV', 0], ['RackMinVoltage', '最低单体', 'BMS', 'mV', 0],
      ['RackPosInsulatVal', '绝缘 R+', 'BMS', 'Ω', 0], ['RackNegInsulatVal', '绝缘 R-', 'BMS', 'Ω', 0]
    ]);
    const loc = el('div', 'bms-loc', '极值位置：--');
    body.appendChild(loc);
    R.bmsLoc = loc;
    R.bmsSec = s;
    return s;
  }
  function updBms(map) {
    ['SOC', 'SOH', 'SOE'].forEach(k => {
      const v = gn(map, 'BMS', k);
      const o = R.bms[k];
      o.val.textContent = v === null ? '--' : Math.round(v);
      const cc = 2 * Math.PI * 26;
      o.ring.style.strokeDasharray = cc;
      o.ring.style.strokeDashoffset = v === null ? cc : cc * (1 - Math.max(0, Math.min(100, v)) / 100);
    });
    const rs = gn(map, 'BMS', 'RackRunState');
    R.bmsState.textContent = rs === null ? '--' : enumText('RackRunState', rs);
    R.bmsState.className = (rs === null ? '' : [8].includes(rs) ? 'bad' : [5, 6].includes(rs) ? 'warn' : 'ok');
    setKV('bmsKV', [
      ['RackVoltage', 'V', 1], ['RackCurrent', 'A', 1],
      ['RackMaxTemp', '℃', 0], ['RackMinTemp', '℃', 0],
      ['RackMaxVoltage', 'mV', 0], ['RackMinVoltage', 'mV', 0],
      ['RackPosInsulatVal', 'Ω', 0], ['RackNegInsulatVal', 'Ω', 0]
    ].map(([t, u, d]) => [t, t, 'BMS', u, d]), map);
    const parts = [];
    const mt = gn(map, 'BMS', 'RackMaxTemp');
    if (mt !== null) parts.push('温峰 M' + gn(map, 'BMS', 'RackMaxTempModuleId') + '-C' + gn(map, 'BMS', 'RackMaxTempCellId'));
    const mv = gn(map, 'BMS', 'RackMaxVoltage');
    if (mv !== null) parts.push('压峰 M' + gn(map, 'BMS', 'RackMaxVoltageModuleId') + '-C' + gn(map, 'BMS', 'RackMaxVolCellId'));
    R.bmsLoc.textContent = '极值位置：' + (parts.length ? parts.join('　') : '--');
  }

  /* ---------------- 5 液冷机 TMS ---------------- */
  function buildTms() {
    const { s, body } = sec('tms', 'ov-tms', '液冷机 TMS', 'TMS', 'sp3');
    const mode = el('div', 'tms-mode');
    mode.innerHTML = '<span>系统模式</span><b>--</b>';
    body.appendChild(mode);
    R.tms = { mode: mode.querySelector('b') };
    /* 回路示意：出水 → 柜 → 回水 */
    const loop = el('div', 'tms-loop');
    loop.innerHTML = '<div class="tl-node cold"><span>出水</span><b>--</b><u>℃</u></div>'
      + '<div class="tl-arrow">→</div>'
      + '<div class="tl-node cab"><span>环境</span><b>--</b><u>℃</u></div>'
      + '<div class="tl-arrow">→</div>'
      + '<div class="tl-node hot"><span>回水</span><b>--</b><u>℃</u></div>';
    body.appendChild(loop);
    R.tms.in = loop.querySelector('.cold b');
    R.tms.amb = loop.querySelector('.cab b');
    R.tms.out = loop.querySelector('.hot b');
    kvGrid(body, 'tmsKV', [
      ['WaterInPreVal', '进水压力', 'TMS', 'Bar', 2], ['WaterOutPreVal', '出水压力', 'TMS', 'Bar', 2],
      ['PressSpeed', '水泵转速', 'TMS', '', 0], ['Read_4', '心跳', 'TMS', '', 0]
    ]);
    const pumps = el('div', 'tms-pumps');
    pumps.innerHTML = '<span class="pl" id="ovPump"><i></i>水泵</span><span class="pl" id="ovComp"><i></i>压缩机</span>';
    body.appendChild(pumps);
    R.tms.pump = byIdDefer(pumps, '#ovPump');
    R.tms.comp = byIdDefer(pumps, '#ovComp');
    R.tmsSec = s;
    return s;
  }
  function byIdDefer(host, sel) { return host.querySelector(sel); }
  function updTms(map) {
    const T = t => gn(map, 'TMS', t);
    R.tms.in.textContent = fmt(T('InflowTemp'), '', 1);
    R.tms.out.textContent = fmt(T('EffluentTemp'), '', 1);
    R.tms.amb.textContent = fmt(T('AmbientTemp'), '', 1);
    const m = T('Read_15');
    R.tms.mode.textContent = m === null ? '--' : enumText('TmsMode', m);
    R.tms.mode.className = m === null ? '' : m === 2 ? 'cold' : m === 3 ? 'hot' : '';
    setKV('tmsKV', [
      ['WaterInPreVal', 'Bar', 2], ['WaterOutPreVal', 'Bar', 2], ['PressSpeed', '', 0], ['Read_4', '', 0]
    ].map(([t, u, d]) => [t, t, 'TMS', u, d]), map);
    const p = T('PumpStatus'), c = T('CompressorStatus');
    R.tms.pump.className = 'pl' + (p === 1 ? ' on' : '');
    R.tms.comp.className = 'pl' + (c === 1 ? ' on' : '');
  }

  /* ---------------- 6 电芯热力图 ---------------- */
  function heatColor(v, min, max, stops) {
    let t = (v - min) / ((max - min) || 1);
    t = Math.max(0, Math.min(1, t));
    const seg = t * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(seg));
    const f = seg - i;
    const mix = (a, b) => Math.round(a + (b - a) * f);
    return 'rgb(' + mix(stops[i][0], stops[i + 1][0]) + ',' + mix(stops[i][1], stops[i + 1][1]) + ',' + mix(stops[i][2], stops[i + 1][2]) + ')';
  }
  const VOLT_STOPS = [[14, 61, 58], [20, 120, 110], [46, 230, 200], [186, 255, 240]];
  const TEMP_STOPS = [[28, 95, 138], [46, 230, 200], [255, 176, 32], [255, 110, 80]];
  function buildCells() {
    const { s, body } = sec('cells', 'ov-cells', '电芯单体分布 · BMS_CELLS', 'BMS_CELLS', 'sp12');
    const wrap = el('div', 'heat-wrap');
    [['volt', '单体电压 (mV)', 'RkCeVolt', VOLT_STOPS, 224], ['temp', '单体温度 (℃)', 'RkCeTemp', TEMP_STOPS, 112]]
      .forEach(([key, label, prefix, stops, count]) => {
        const box = el('div', 'heat-box');
        const meta = el('div', 'heat-meta');
        meta.innerHTML = '<b>' + label + '</b><span class="hm-stat" id="hm' + key + 'Stat">--</span>';
        const grid = el('div', 'heat-grid hg' + count);
        const cells = [];
        for (let i = 0; i < count; i++) {
          const c = el('i', 'hc');
          grid.appendChild(c);
          cells.push(c);
        }
        box.appendChild(meta);
        box.appendChild(grid);
        const legend = el('div', 'heat-legend');
        legend.innerHTML = '<span class="hl-grad" style="background:linear-gradient(90deg,'
          + stops.map((st, i) => 'rgb(' + st.join(',') + ') ' + (i / (stops.length - 1) * 100) + '%').join(',') + ')"></span>'
          + '<em id="hm' + key + 'Min">--</em><em id="hm' + key + 'Max">--</em>';
        box.appendChild(legend);
        wrap.appendChild(box);
        R['hm' + key] = { cells, grid, stat: box.querySelector('#hm' + key + 'Stat'), min: box.querySelector('#hm' + key + 'Min'), max: box.querySelector('#hm' + key + 'Max'), prefix, stops };
      });
    body.appendChild(wrap);
    R.cellsSec = s;
    return s;
  }
  function updCells(map) {
    const d = (map && map.BMS_CELLS) || {};
    [['volt', 224], ['temp', 112]].forEach(([key, count]) => {
      const o = R['hm' + key];
      const vals = [];
      for (let i = 1; i <= count; i++) {
        const v = num(d[o.prefix + String(i).padStart(3, '0')]);
        vals.push(v);
      }
      const valid = vals.filter(v => v !== null);
      const min = valid.length ? Math.min.apply(null, valid) : 0;
      const max = valid.length ? Math.max.apply(null, valid) : 1;
      const avg = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
      const pad = (max - min) * 0.15 || (key === 'volt' ? 30 : 2);
      for (let i = 0; i < count; i++) {
        const c = o.cells[i], v = vals[i];
        if (v === null) { c.className = 'hc na'; c.style.background = ''; c.title = o.prefix + (i + 1) + '：无数据'; continue; }
        c.className = 'hc';
        c.style.background = heatColor(v, min - pad, max + pad, o.stops);
        c.title = o.prefix + String(i + 1).padStart(3, '0') + '：' + v;
      }
      o.stat.textContent = valid.length
        ? ('有效 ' + valid.length + ' · 均 ' + avg.toFixed(key === 'volt' ? 0 : 1) + ' · 差 ' + (max - min).toFixed(key === 'volt' ? 0 : 1))
        : '暂无数据';
      o.min.textContent = valid.length ? fmt(min, '', key === 'volt' ? 0 : 1) : '--';
      o.max.textContent = valid.length ? fmt(max, '', key === 'volt' ? 0 : 1) : '--';
    });
  }

  /* ---------------- 7/8 储能表 · 关口表 ---------------- */
  function buildMeter(key, clsName, title, tagNo, span, accent) {
    const { s, body } = sec(key, clsName, title, tagNo, span);
    const big = el('div', 'm-big' + (accent ? ' accent' : ''));
    big.innerHTML = '<span>总有功功率</span><b>--</b><u>kW</u>';
    body.appendChild(big);
    R[key] = { big: big.querySelector('b') };
    const pq = el('div', 'm-pqsf');
    [['ReactivePower', '无功', 'kVar'], ['ApparentPower', '视在', 'kVA'], ['PowerFactor', '功率因数', '']]
      .forEach(([tag, label, unit]) => {
        const t = el('div', 'm-pq');
        t.innerHTML = '<span>' + label + '</span><b>--</b><u>' + unit + '</u>';
        pq.appendChild(t);
        R[key][tag] = t.querySelector('b');
      });
    body.appendChild(pq);
    /* 三相 V/I 表 */
    const tb = el('table', 'phase-table');
    tb.innerHTML = '<thead><tr><th></th><th>A相</th><th>B相</th><th>C相</th></tr></thead>'
      + '<tbody><tr><th>电压 V</th><td>--</td><td>--</td><td>--</td></tr>'
      + '<tr><th>电流 A</th><td>--</td><td>--</td><td>--</td></tr></tbody>';
    body.appendChild(tb);
    const tds = tb.querySelectorAll('tbody td');
    R[key].V = [tds[0], tds[1], tds[2]];
    R[key].I = [tds[3], tds[4], tds[5]];
    /* 电能 */
    const ep = el('div', 'm-energy');
    ep.innerHTML = '<span>正向有功总电能 <b>--</b> kWh</span><span>反向有功总电能 <b>--</b> kWh</span>';
    body.appendChild(ep);
    R[key].eF = ep.querySelectorAll('b')[0];
    R[key].eR = ep.querySelectorAll('b')[1];
    R[key + 'Sec'] = s;
    return s;
  }
  function updMeter(key, no, map) {
    const M = t => gn(map, no, t);
    R[key].big.textContent = fmt(M('ActivePower'), '', 1);
    R[key].big.classList.toggle('neg', M('ActivePower') !== null && M('ActivePower') < 0);
    R[key].ReactivePower.textContent = fmt(M('ReactivePower'), '', 1);
    R[key].ApparentPower.textContent = fmt(M('ApparentPower'), '', 1);
    R[key].PowerFactor.textContent = fmt(M('PowerFactor'), '', 3);
    ['Aphase', 'Bphase', 'Cphase'].forEach((p, i) => {
      R[key].V[i].textContent = fmt(M(p + 'Voltage'), '', 1);
      R[key].I[i].textContent = fmt(M(p + 'Current'), '', 2);
    });
    R[key].eF.textContent = fmt(M('ActiveEnergy'), '', 1);
    R[key].eR.textContent = fmt(M('ReactiveEnergy'), '', 1);
  }

  /* ---------------- 9 其他：干接点/消防/除湿机 ---------------- */
  function buildAux() {
    const { s, body } = sec('aux', 'ov-aux', '其他 · 干接点 / 消防 / 除湿机', 'DIDO·FIRE·CSJ', 'sp12');
    const wrap = el('div', 'aux-wrap');
    R.aux = {};
    /* DIDO 灯板 */
    const dido = el('div', 'aux-block');
    dido.appendChild(el('b', 'aux-title', '干接点 DIDO'));
    const lamps = el('div', 'lamp-board');
    R.aux.dido = {};
    [['DI1', '急停'], ['DI2', '浪涌'], ['DI3', '水浸'], ['DI4', '消防'], ['DI5', '温感'], ['DI6', '可燃气体'], ['DI7', '烟感'], ['DI8', '门禁']]
      .forEach(([tag, label]) => {
        const l = el('div', 'lamp');
        l.innerHTML = '<i></i><span>' + label + '</span>';
        lamps.appendChild(l);
        R.aux.dido[tag] = l;
      });
    dido.appendChild(lamps);
    wrap.appendChild(dido);
    /* 消防 */
    const fire = el('div', 'aux-block');
    fire.appendChild(el('b', 'aux-title', '消防 FIRE'));
    const fl = el('div', 'fire-row');
    R.aux.fire = {};
    [['Status', '状态'], ['Alarm', '报警'], ['Fault', '故障'], ['ValveOpen', '阀开启']].forEach(([tag, label]) => {
      const l = el('div', 'lamp');
      l.innerHTML = '<i></i><span>' + label + '</span>';
      fl.appendChild(l);
      R.aux.fire[tag] = l;
    });
    fire.appendChild(fl);
    const conc = el('div', 'fire-conc');
    conc.innerHTML = '<span>CO <b>--</b> ppm</span><span>H₂ <b>--</b> ppm</span><span>VOC <b>--</b> ppm</span><span>烟雾减光 <b>--</b> %</span>';
    fire.appendChild(conc);
    R.aux.conc = conc.querySelectorAll('b');
    wrap.appendChild(fire);
    /* 除湿机 */
    const csj = el('div', 'aux-block');
    csj.appendChild(el('b', 'aux-title', '除湿机 CSJ'));
    const cj = el('div', 'csj-row');
    cj.innerHTML = '<div class="csj-item"><span>温度</span><b>--</b><u>℃</u></div>'
      + '<div class="csj-item"><span>湿度</span><b>--</b><u>g/m³</u></div>'
      + '<div class="csj-item"><span>工作状态</span><b>--</b></div>'
      + '<div class="csj-item"><span>加热</span><b>--</b></div>';
    csj.appendChild(cj);
    R.aux.csj = { t: cj.querySelectorAll('b')[0], h: cj.querySelectorAll('b')[1], st: cj.querySelectorAll('b')[2], heat: cj.querySelectorAll('b')[3] };
    wrap.appendChild(csj);
    body.appendChild(wrap);
    R.auxSec = s;
    return s;
  }
  function updAux(map) {
    /* alarmType=true：1=触发（红灯）；否则 1=正常点亮（绿灯） */
    function lampSet(node, v, alarmType) {
      const n = num(v);
      if (n === null) { node.className = 'lamp na'; return; }
      node.className = 'lamp' + (n === 1 ? (alarmType ? ' on-bad' : ' on-ok') : '');
    }
    Object.keys(R.aux.dido).forEach(tag => lampSet(R.aux.dido[tag], gv(map, 'DIDO', tag), true));
    Object.keys(R.aux.fire).forEach(tag =>
      lampSet(R.aux.fire[tag], gv(map, 'FIRE', tag), tag === 'Alarm' || tag === 'Fault'));
    const ct = gn(map, 'CSJ', 'CurTemp'), ch = gn(map, 'CSJ', 'CurHum');
    R.aux.csj.t.textContent = fmt(ct, '', 0);
    R.aux.csj.h.textContent = fmt(ch, '', 0);
    const ds = gn(map, 'CSJ', 'DehumStatus');
    R.aux.csj.st.textContent = ds === null ? '--' : (ENUM.DehumStatus[ds] || (ds >= 2 ? '故障' : '未知'));
    R.aux.csj.st.className = ds !== null && ds >= 2 ? 'bad' : '';
    R.aux.csj.heat.textContent = gn(map, 'CSJ', 'HeatState') === 1 ? '加热中' : '未加热';
    const concMap = [['COConcentration'], ['H2Concentration'], ['VOCConcentration'], ['SmokeAttenuation']];
    concMap.forEach(([t], i) => { R.aux.conc[i].textContent = fmt(gn(map, 'FIRE', t), '', 0); });
  }

  /* ---------------- 渲染调度 ---------------- */
  let inited = false, lastRender = 0;
  function render(map, src) {
    updSys(map); updEms(map); updPcs(map); updBms(map); updTms(map);
    updCells(map);
    updMeter('meterA', 'PCS_METER', map); updMeter('meterB', 'GRID_METER', map);
    updAux(map);
    /* 在线状态点 */
    [['sys', 'systemSet'], ['ems', 'EMS'], ['pcs', 'PCS'], ['bms', 'BMS'], ['tms', 'TMS'],
     ['cells', 'BMS_CELLS'], ['meterA', 'PCS_METER'], ['meterB', 'GRID_METER'], ['aux', 'DIDO']]
      .forEach(([k, no]) => { R[k + ':dot'].className = 'ov-online ' + onlineDot(map, no); });
    /* 数据源角标 */
    const srcEl = byId('ovSrc');
    if (srcEl) {
      srcEl.textContent = '厂家实时数据';
      srcEl.className = 'ov-src live';
    }
  }
  function update(tags, src) {
    if (!inited) return;
    const now = Date.now();
    const visible = !byId('overviewView').classList.contains('hidden');
    if (!visible && src !== 'force') return;
    if (now - lastRender < 1200 && src !== 'force') return;
    lastRender = now;
    render(tags || {}, src);
  }
  function init() {
    if (inited) return;
    const grid = byId('overviewGrid');
    if (!grid) return;
    grid.appendChild(buildSys());
    grid.appendChild(buildEms());
    grid.appendChild(buildPcs());
    grid.appendChild(buildBms());
    grid.appendChild(buildTms());
    grid.appendChild(buildCells());
    grid.appendChild(buildMeter('meterA', 'ov-meter', '储能表 · PCS 侧计量', 'PCS_METER', 'sp6', false));
    grid.appendChild(buildMeter('meterB', 'ov-meter', '关口表 · 并网计量', 'GRID_METER', 'sp6', true));
    grid.appendChild(buildAux());
    const btn = byId('ovRefresh');
    if (btn) btn.addEventListener('click', () => update(window.DataService ? DataService.mqttTags() : null, 'force'));
    inited = true;
    update(null, 'force');
  }
  return { init, update };
})();
