/* ============================================================
 * 高特 CCU 监控视图（直观大屏版）
 *
 * 设计目标：一眼看懂 —— 大数字 + 进度条 + 热力图 + 状态灯，
 *          不堆点位表；细节（全部 708 遥测 / 343 遥信）按需在下方展开。
 *
 * 数据来源：GaoteService.state（按协议文档解析后的实时值）
 * 数据维度：emu / array / cluster / cell / pcs / meter-* / liqcool / drier / fire / io
 * ============================================================ */
window.GaoteView = (function () {
  'use strict';

  const byId = id => document.getElementById(id);
  const V = (dim, key, opt) => GaoteService.val(dim, key, opt);
  const N = (dim, key, opt) => { const v = V(dim, key, opt); return (v === null || v === undefined) ? null : Number(v); };

  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; }
  function num(v, unit, d) {
    if (v === null || v === undefined || v === '' || isNaN(v)) return '--';
    let dig = d;
    if (dig === undefined) dig = Number.isInteger(v) ? 0 : (Math.abs(v) >= 100 ? 1 : (Math.abs(v) >= 10 ? 2 : 3));
    return Number(v).toFixed(dig) + (unit || '');
  }
  function insts(dim) {
    const want = dim.toLowerCase();
    return Object.keys(GaoteService.state)
      .filter(k => k.split('|')[0] === want)
      .map(k => ({ key: k, meta: GaoteService.state[k]._meta, b: GaoteService.state[k] }))
      .sort((a, b) => (parseInt(a.meta.arr, 10) || 0) - (parseInt(b.meta.arr, 10) || 0));
  }
  function bval(b, key) {
    const i = Object.keys(b).filter(k => b[k] && b[k].key === key)[0];
    if (i === undefined) return null;
    const v = b[i].v;
    return (v === null || v === undefined) ? null : Number(v);
  }
  function sec(span, title, chip) {
    const s = el('section', 'ov-sec gv3-sec ' + span);
    const h = el('div', 'ov-sec-head');
    h.appendChild(el('b', '', title));
    if (chip) h.appendChild(el('span', 'ov-tagchip', chip));
    h.appendChild(el('i', 'ov-online on'));
    s.appendChild(h);
    const body = el('div', 'ov-sec-body gv3-body');
    s.appendChild(body);
    return { s, body };
  }

  /* ---------- 1. 总览：SOC 大环 + 关键指标 ---------- */
  function heroSec() {
    const { s, body } = sec('sp12', '系统总览', 'EMU / EMS');
    const soc = N('emu', 'SumsSOC');
    const p = N('emu', 'PCSSumsActivePower');
    const wrap = el('div', 'gv3-hero');

    const ring = el('div', 'gv3-ring');
    ring.innerHTML = '<svg viewBox="0 0 96 96"><circle class="rbg" cx="48" cy="48" r="40"/><circle class="rfg" cx="48" cy="48" r="40"/></svg>'
      + '<b><span>' + (soc === null ? '--' : Math.round(soc)) + '</span><i>%</i></b><span class="gv3-ring-label">储能 SOC</span>';
    const c = 2 * Math.PI * 40;
    const rf = ring.querySelector('.rfg');
    rf.style.strokeDasharray = c;
    rf.style.strokeDashoffset = soc === null ? c : c * (1 - Math.max(0, Math.min(100, soc)) / 100);
    wrap.appendChild(ring);

    /* 四个大指标 */
    const kpis = el('div', 'gv3-kpis');
    [['储能功率', p, 'kW', p === null ? '' : (p < 0 ? '充电中' : (p > 0 ? '放电中' : '待机'))],
     ['允许充电功率', N('emu', 'MaxAllowChargPower'), 'kW', ''],
     ['允许放电功率', N('emu', 'MinAllowChargPower'), 'kW', ''],
     ['电池总节数', N('emu', 'CellSums'), '节', ''],
     ['可充电量', N('emu', 'EmuEnChgCap'), 'kWh', ''],
     ['可放电量', N('emu', 'EmuEnDisCap'), 'kWh', ''],
     ['平均温度', N('emu', 'BatteryAverageTem'), '℃', ''],
     ['最高单体', N('emu', 'MaxCellVol'), 'V', '']
    ].forEach(function ([label, v, unit, tag]) {
      const box = el('div', 'gv3-kpi' + (label === '储能功率' ? (p !== null && p < 0 ? ' chg' : ' dischg') : ''));
      box.appendChild(el('span', 'gv3-klabel', label));
      box.appendChild(el('b', 'gv3-kval', num(v, '', unit === 'V' ? 3 : 1) + ''));
      box.appendChild(el('u', 'gv3-kunit', unit));
      if (tag) box.appendChild(el('em', 'gv3-ktag', tag));
      kpis.appendChild(box);
    });
    wrap.appendChild(kpis);

    /* 状态徽章 */
    const badges = el('div', 'gv3-badges');
    const sysV = N('emu', 'SysStatus');
    const ctrl = N('emu', 'ControlSrc');
    const mode = N('emu', 'EmuModCod');
    const run = N('emu', 'RunStatus');
    const MODE = { 0: '子系统', 1: '计划', 2: '总指令' };
    [['系统状态', sysV === null ? '--' : (sysV === 0 ? '正常' : '异常'), sysV === 0 ? 'ok' : 'bad'],
     ['控制源', ctrl === null ? '--' : (ctrl === 1 ? '远程' : (ctrl === 0 ? '本地' : '其他')), ctrl === 1 ? 'ok' : 'warn'],
     ['指令模式', mode === null ? '--' : (MODE[mode] || mode), ''],
     ['电池状态', run === null ? '--' : ({ 0: '静置', 1: '充电', 2: '放电' }[run] || run), '']
    ].forEach(function ([k, v, cls]) {
      const b = el('div', 'gv3-badge');
      b.appendChild(el('span', '', k));
      b.appendChild(el('b', 'v ' + cls, String(v)));
      badges.appendChild(b);
    });
    wrap.appendChild(badges);
    body.appendChild(wrap);
    return s;
  }

  /* ---------- 2. 功率流 ---------- */
  function flowSec() {
    const { s, body } = el2();
    function el2() { return sec('sp12', '功率分布', 'PCS / 电表'); }
    const pcs = N('emu', 'PCSSumsActivePower');
    const grid = N('meter-lems-antireflux', 'meter_tot_p');
    const ess = N('meter-aems-storage', 'meter_tot_p');
    const meterIn = N('meter-mems-storage', 'meter_tot_p');
    const row = el('div', 'gv3-flow');
    [['市电（并网点）', grid, 'grid'], ['储能（AEMS）', ess !== null ? ess : pcs, 'ess'],
     ['计量柜（MEMS）', meterIn, 'load'], ['PCS 汇总', pcs, 'pcs']].forEach(function ([label, v, cls]) {
      const t = el('div', 'gv3-tile ' + cls);
      t.appendChild(el('span', 'gv3-tlabel', label));
      t.appendChild(el('b', 'gv3-tval', num(v, '', 1)));
      t.appendChild(el('u', '', 'kW'));
      if (label === '储能（AEMS）' && v !== null) t.appendChild(el('em', 'gv3-ttag', v < 0 ? '充电' : (v > 0 ? '放电' : '待机')));
      row.appendChild(t);
    });
    body.appendChild(row);
    return s;
  }

  /* ---------- 3. 电池堆卡片（带 SOC 进度条） ---------- */
  function stackSec() {
    const { s, body } = sec('sp12', '电池堆', 'rtg/data/array');
    const list = insts('array');
    if (!list.length) { body.appendChild(el('div', 'gv3-empty', '尚未收到堆数据')); return s; }
    const row = el('div', 'gv3-stack-row');
    list.forEach(function (it) {
      const soc = bval(it.b, 'arrSOC');
      const card = el('div', 'gv3-stack');
      const head = el('div', 'gv3-shead');
      head.appendChild(el('b', '', '堆 ' + (it.meta.arr || '0')));
      const st = bval(it.b, 'arrStatus');
      head.appendChild(el('span', 'gv3-dot' + (st === 0 ? ' ok' : ' warn'), st === 0 ? '正常' : (st === null ? '--' : '异常')));
      card.appendChild(head);

      const bar = el('div', 'gv3-socbar');
      bar.innerHTML = '<i style="width:' + (soc === null ? 0 : Math.max(0, Math.min(100, soc))) + '%"></i>';
      card.appendChild(bar);
      card.appendChild(el('div', 'gv3-socnum', 'SOC ' + num(soc, '%', 1)));

      const kv = el('div', 'gv3-skv');
      [['电压', num(bval(it.b, 'arrVol'), 'V', 1)], ['电流', num(bval(it.b, 'arrCur'), 'A', 1)],
       ['SOH', num(bval(it.b, 'arrSOH'), '%', 0)], ['压差', num(bval(it.b, 'CellVolDif'), 'V', 3)],
       ['温差', num(bval(it.b, 'CellTemDif'), '℃', 1)], ['允许充放', num(bval(it.b, 'arrMaxReChaPower'), '', 0) + '/' + num(bval(it.b, 'arrMaxReDischgPower'), '', 0)]]
        .forEach(function ([k, v]) {
          const r = el('div', 'gv3-kvrow');
          r.appendChild(el('span', '', k));
          r.appendChild(el('b', '', String(v)));
          kv.appendChild(r);
        });
      card.appendChild(kv);
      row.appendChild(card);
    });
    body.appendChild(row);
    return s;
  }

  /* ---------- 4. 电芯热力图 ---------- */
  function cellSec() {
    const { s, body } = sec('sp12', '单体电芯', 'rtg/data/cell');
    const keys = Object.keys(GaoteService.state).filter(k => k.split('|')[0] === 'cell');
    if (!keys.length) { body.appendChild(el('div', 'gv3-empty', '尚未收到单体数据')); return s; }
    const groups = {};
    keys.forEach(function (k) {
      const b = GaoteService.state[k];
      const g = '堆' + (b._meta.arr || 0) + ' · 簇' + (b._meta.clu || 0);
      (groups[g] = groups[g] || []).push(b);
    });
    const wrap = el('div', 'heat-wrap');
    Object.keys(groups).forEach(function (g) {
      const list = groups[g].sort((a, b) => (parseInt(a._meta.dev, 10) || 0) - (parseInt(b._meta.dev, 10) || 0));
      const box = el('div', 'heat-box');
      const vals = k => list.map(b => bval(b, k)).filter(v => v !== null);
      const vv = vals('CelVol'), tt = vals('CelTem');
      const meta = el('div', 'heat-meta');
      meta.innerHTML = '<b>' + g + '　' + list.length + ' 节</b><span class="hm-stat">电压 '
        + (vv.length ? (Math.min.apply(null, vv) * 1000).toFixed(0) + '~' + (Math.max.apply(null, vv) * 1000).toFixed(0) + ' mV' : '--')
        + '　温度 ' + (tt.length ? Math.min.apply(null, tt).toFixed(1) + '~' + Math.max.apply(null, tt).toFixed(1) + ' ℃' : '--') + '</span>';
      box.appendChild(meta);
      [['CelVol', 'mV', 1000], ['CelTem', '℃', 1]].forEach(function ([k, u, f]) {
        const arr = list.map(b => bval(b, k));
        const valid = arr.filter(v => v !== null);
        if (!valid.length) return;
        const min = Math.min.apply(null, valid), max = Math.max.apply(null, valid);
        const grid = el('div', 'heat-grid');
        grid.style.gridTemplateColumns = 'repeat(' + Math.min(list.length, 24) + ',1fr)';
        arr.forEach(function (v, idx) {
          const c = el('i', 'hc');
          if (v === null) { c.className = 'hc na'; c.title = '第 ' + (idx + 1) + ' 节：无数据'; }
          else {
            const t = (v - min) / ((max - min) || 1);
            const hue = k === 'CelVol' ? (168 + 34 * t) : (205 - 165 * t);
            c.style.background = 'hsl(' + hue + ',72%,' + (26 + 30 * (1 - Math.abs(t - 0.5) * 2)) + '%)';
            c.title = '第 ' + (idx + 1) + ' 节：' + (v * f).toFixed(f === 1000 ? 0 : 1) + ' ' + u;
          }
          grid.appendChild(c);
        });
        const line = el('div', 'gv3-heatline');
        line.appendChild(el('span', 'gv3-hlabel', k === 'CelVol' ? '电压(mV)' : '温度(℃)'));
        line.appendChild(grid);
        box.appendChild(line);
      });
      wrap.appendChild(box);
    });
    body.appendChild(wrap);
    return s;
  }

  /* ---------- 5. 电表（简洁） ---------- */
  function meterSec(dim, title, span) {
    const { s, body } = sec(span, title, 'rtg/data/' + dim);
    const m = k => N(dim, k);
    if (m('meter_tot_p') === null && m('meter_a_vol') === null) { body.appendChild(el('div', 'gv3-empty', '该电表暂无数据')); return s; }
    const big = el('div', 'gv3-mbig');
    big.appendChild(el('span', '', '总有功功率'));
    big.appendChild(el('b', '', num(m('meter_tot_p'), '', 1)));
    big.appendChild(el('u', '', 'kW'));
    body.appendChild(big);
    const grid = el('div', 'gv3-mgrid');
    [['A相电压', m('meter_a_vol'), 'V', 1], ['B相电压', m('meter_b_vol'), 'V', 1], ['C相电压', m('meter_c_vol'), 'V', 1],
     ['A相电流', m('meter_a_cur'), 'A', 2], ['B相电流', m('meter_b_cur'), 'A', 2], ['C相电流', m('meter_c_cur'), 'A', 2],
     ['总无功', m('meter_tot_q'), 'kVar', 1], ['总视在', m('meter_tot_s'), 'kVA', 1], ['功率因数', m('meter_tot_pf'), '', 3],
     ['频率', m('meter_f'), 'Hz', 2], ['正向电能', m('meter_add_pos'), 'kWh', 1], ['反向电能', m('meter_add_neg'), 'kWh', 1]
    ].forEach(function ([k, v, u, d]) {
      const it = el('div', 'gv3-mitem');
      it.appendChild(el('span', '', k));
      it.appendChild(el('b', '', num(v, '', d)));
      it.appendChild(el('u', '', u));
      grid.appendChild(it);
    });
    body.appendChild(grid);
    return s;
  }

  /* ---------- 6. 辅助设备灯板 ---------- */
  function auxSec() {
    const { s, body } = sec('sp12', '辅助设备', '液冷 / 除湿 / 消防 / 干接点');
    const row = el('div', 'gv3-aux');

    /* 液冷 */
    const liq = el('div', 'gv3-auxcard');
    liq.appendChild(el('div', 'gv3-ahead', '液冷机'));
    const mode = N('liqcool', 'current_mod');
    liq.appendChild(el('div', 'gv3-amode', ({ 0: '停止', 1: '内循环', 2: '制冷', 3: '加热' }[mode] || '--')));
    const temps = el('div', 'gv3-atemp');
    temps.innerHTML = '<div><span>出水</span><b>' + num(N('liqcool', 'liqhot_water_tmp'), '', 1) + '</b><u>℃</u></div>'
      + '<div class="arrow">→</div>'
      + '<div><span>回水</span><b>' + num(N('liqcool', 'liqinlet_water_tmp'), '', 1) + '</b><u>℃</u></div>';
    liq.appendChild(temps);
    const lamps1 = el('div', 'gv3-lamps');
    [['水泵', N('liqcool', 'liq_pump_status')], ['压缩机', N('liqcool', 'liq_coldsta')], ['电加热', N('liqcool', 'liq_hotsta')]]
      .forEach(function ([n, v]) { lamps1.appendChild(el('span', 'gv3-lamp' + (v === 1 ? ' on' : ''), n)); });
    liq.appendChild(lamps1);
    liq.appendChild(el('div', 'gv3-anote', '出水压力 ' + num(N('liqcool', 'liqhydraulic_pressure'), 'Bar', 2) + ' · 水泵转速 ' + num(N('liqcool', 'pump_target_speed'), '%', 0)));
    row.appendChild(liq);

    /* 除湿机 */
    const dry = el('div', 'gv3-auxcard');
    dry.appendChild(el('div', 'gv3-ahead', '除湿机'));
    dry.appendChild(el('div', 'gv3-amode', N('drier', 'drier_wholerun') === 1 ? '运行中' : '待机'));
    const dg = el('div', 'gv3-mgrid tight');
    [['温度', N('drier', 'time_tem'), '℃'], ['湿度', N('drier', 'time_wet'), '%RH'], ['加热', N('drier', 'drier_hotsta') === 1 ? '开' : '关', '']]
      .forEach(function ([k, v, u]) {
        const it = el('div', 'gv3-mitem');
        it.appendChild(el('span', '', k));
        it.appendChild(el('b', '', typeof v === 'string' ? v : num(v, '', 0)));
        it.appendChild(el('u', '', u));
        dg.appendChild(it);
      });
    dry.appendChild(dg);
    row.appendChild(dry);

    /* 消防 */
    const fire = el('div', 'gv3-auxcard');
    fire.appendChild(el('div', 'gv3-ahead', '消防'));
    const fg = el('div', 'gv3-mgrid tight');
    [['CO', N('fire', 'fire_co'), 'ppm'], ['H2', N('fire', 'fire_h2'), 'ppm'],
     ['VOC', N('fire', 'voc_con'), 'ppm'], ['烟雾', N('fire', 'fire_smoke'), '%'],
     ['温度', N('fire', 'fire_temp'), '℃']].forEach(function ([k, v, u]) {
      const it = el('div', 'gv3-mitem');
      it.appendChild(el('span', '', k));
      it.appendChild(el('b', '', num(v, '', 0)));
      it.appendChild(el('u', '', u));
      fg.appendChild(it);
    });
    fire.appendChild(fg);
    row.appendChild(fire);

    /* 4G 网关 */
    const net = el('div', 'gv3-auxcard');
    net.appendChild(el('div', 'gv3-ahead', '网关 / 4G'));
    const sig = N('t4ginfo', 'CSQ_PER');
    const bars = el('div', 'gv3-sig');
    const lv = sig === null ? 0 : Math.max(1, Math.min(5, Math.ceil(sig / 20)));
    for (let i = 1; i <= 5; i++) bars.appendChild(el('i', i <= lv ? 'on' : '', ''));
    net.appendChild(bars);
    const ng = el('div', 'gv3-mgrid tight');
    [['信号', sig, '%'], ['网络', V('t4ginfo', 'NETWORK_TYPE'), ''], ['IP', V('t4ginfo', 'Ip'), ''],
     ['ICCID', V('t4ginfo', 'ICCID'), ''], ['版本', V('ems', 'EMSversion'), ''], ['SN', V('ems', 'Devsid'), '']]
      .forEach(function ([k, v, u]) {
        const it = el('div', 'gv3-mitem wide');
        it.appendChild(el('span', '', k));
        it.appendChild(el('b', '', v === null || v === undefined ? '--' : (typeof v === 'number' ? num(v, '', 0) : String(v))));
        it.appendChild(el('u', '', u));
        ng.appendChild(it);
      });
    net.appendChild(ng);
    row.appendChild(net);

    body.appendChild(row);
    return s;
  }

  /* ---------- 7. 告警 ---------- */
  function alarmSec() {
    const list = collectAlarms();
    if (!list.length) return null;
    const { s, body } = sec('sp12', '告警（遥信）', 'rtg/status');
    const wrap = el('div', 'gv3-alarms');
    list.forEach(function (a) {
      wrap.appendChild(el('span', 'gv3-alarm', (a.label || a.dim) + ' · ' + (a.inst || '') + ' · ' + a.name));
    });
    body.appendChild(wrap);
    return s;
  }
  function collectAlarms() {
    const out = [];
    Object.keys(GaoteService.state).forEach(function (k) {
      const parts = k.split('|');
      if (parts[0].indexOf('/status') < 0) return;
      const dim = parts[0].replace('/status', '');
      const b = GaoteService.state[k];
      Object.keys(b).forEach(function (i) {
        if (i === '_meta' || i === '_t') return;
        const it = b[i];
        if (it && it.def && it.v === 1 && it.key !== 'Ts') {
          out.push({ dim: dim, label: TITLE[dim] || dim, name: it.def.n || it.key,
            inst: [b._meta.arr, b._meta.clu, b._meta.dev].filter(x => x !== undefined && x !== '' && x !== '-1').join('/') });
        }
      });
    });
    return out;
  }
  const TITLE = { pcs: '变流器', cluster: '电池簇', array: '电池堆', emu: 'EMU', liqcool: '液冷机', drier: '除湿机', fire: '消防', io: '硬件IO', 'meter-aems-storage': '储能电表', 'meter-lems-antireflux': '逆流电表', 'meter-lems-demand': '需量电表', 'meter-mems-storage': '计量电表' };

  /* ---------- 渲染 ---------- */
  let inited = false, openState = false;
  function render() {
    const body = byId('gaoteBody');
    if (!body) return;
    const stats = byId('gaoteStats');
    if (stats) {
      const instCount = Object.keys(GaoteService.state).length;
      const last = Math.max.apply(null, Object.keys(GaoteService.state).map(k => GaoteService.state[k]._t || 0).concat([0]));
      stats.textContent = '实例 ' + instCount + ' · 最近更新 ' + (last ? new Date(last).toTimeString().slice(0, 8) : '—');
    }
    const bar = byId('gaoteAlarmBar');
    const alarms = collectAlarms();
    if (bar) {
      bar.className = 'gv-alarm alarm ' + (alarms.length ? 'bad' : 'ok');
      bar.textContent = alarms.length
        ? ('⚠ ' + alarms.slice(0, 6).map(a => (a.label || a.dim) + ' · ' + a.name).join('　') + (alarms.length > 6 ? '　…共 ' + alarms.length + ' 条' : ''))
        : '当前无告警';
    }
    body.innerHTML = '';
    body.appendChild(heroSec());
    body.appendChild(flowSec());
    body.appendChild(stackSec());
    body.appendChild(cellSec());
    body.appendChild(meterSec('meter-aems-storage', '储能计量电表（AEMS）', 'sp6'));
    body.appendChild(meterSec('meter-lems-antireflux', '并网逆流电表（LEMS）', 'sp6'));
    body.appendChild(auxSec());
    const al = alarmSec();
    if (al) body.appendChild(al);
  }

  function init() {
    inited = true;
    const btn = byId('gaoteRefresh');
    if (btn && !btn.__bound) { btn.__bound = true; btn.addEventListener('click', function () { render(); }); }
    render();
  }
  function update() { if (inited && openState) render(); }
  function open() {
    const ov = byId('overviewView'), gv = byId('gaoteView');
    if (gv) gv.classList.remove('hidden');
    if (ov) ov.classList.add('hidden');
    openState = true;
    init();
  }
  function hide() { const gv = byId('gaoteView'); if (gv) gv.classList.add('hidden'); openState = false; }

  setInterval(update, 2000);
  return { init, update, render, open, hide, isOpen: () => openState };
})();
