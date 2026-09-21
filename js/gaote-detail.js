/* ============================================================
 * 详细信息页（内容对齐厂家平台站点详情页，视觉用力储未来风格）
 *
 * 版块：
 *   顶部：站点名 · 数据更新时间
 *   KPI：总装机功率 / 总装机容量 / 总充电量 / 总放电量 / 今日充电量 / 今日放电量 / 累计收益
 *   曲线：充放电曲线（SOC + 储能功率）· 功率曲线（关口/储能/负荷）
 *   实时：实时状态 / SOC / 转换效率 / SOH / 实时告警
 *   电量：累计充电量（尖峰平谷深谷）· 累计放电量（尖峰平谷深谷）
 *   收益：累计收益 / 昨日收益 / 放电收入 / 充电总支出（按点击电价折算）
 *   统计：收益趋势 · 充放电量统计（会话内滚动数据，历史曲线需后端存储）
 *
 * 数据：GaoteService（高特协议实时值）+ 本地电价配置（localStorage）
 * ============================================================ */
window.GaoteDetail = (function () {
  'use strict';

  const byId = id => document.getElementById(id);
  const V = (dim, key, opt) => GaoteService.val(dim, key, opt);
  const N = (dim, key, opt) => { const v = V(dim, key, opt); return (v === null || v === undefined) ? null : Number(v); };
  const LS_KEY = 'dianzhan.tariff';

  /* 电价与额定参数（默认值可改，存本地） */
  const DEFAULTS = { cabPower: 250, cabCapacity: 522, tip: 1.20, peak: 0.95, flat: 0.65, valley: 0.35, deep: 0.25 };
  let cfg = Object.assign({}, DEFAULTS, (function () { try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (_) { return {}; } })());
  function saveCfg() { try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch (_) {} }

  const S = { win: { t: [], soc: [], pcs: [], grid: [], load: [] }, lastDay: null, dayBase: null, alarms: [] };
  const WIN = 60;

  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; }
  function f(v, d, u) { return (v === null || v === undefined || isNaN(v)) ? '--' : Number(v).toFixed(d === undefined ? 1 : d) + (u || ''); }
  function sum(dim, key) {
    let s = null;
    Object.keys(GaoteService.state).forEach(function (k) {
      if (k.split('|')[0] !== dim) return;
      const b = GaoteService.state[k];
      const i = Object.keys(b).filter(x => b[x] && b[x].key === key)[0];
      if (i === undefined) return;
      const v = b[i].v;
      if (v !== null && v !== undefined && !isNaN(v)) s = (s || 0) + Number(v);
    });
    return s;
  }
  function avgSoh() {
    const arr = [];
    Object.keys(GaoteService.state).forEach(function (k) {
      if (k.split('|')[0] !== 'array') return;
      const b = GaoteService.state[k];
      const i = Object.keys(b).filter(x => b[x] && b[x].key === 'arrSOH')[0];
      if (i !== undefined && b[i].v != null) arr.push(Number(b[i].v));
    });
    return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  }
  function collectAlarms() {
    /* 统一走 GaoteService.alarms()：只认状态帧里的告警类点（编号/工作状态不算），同名合并计数 */
    if (typeof GaoteService.alarms !== 'function') return [];
    const counts = {};
    GaoteService.alarms().forEach(function (a) { counts[a.name] = (counts[a.name] || 0) + 1; });
    return Object.keys(counts).map(function (n) { return n + (counts[n] > 1 ? ' ×' + counts[n] : ''); });
  }

  /* 分时电量：电表的尖/峰/平/谷/深谷电能点位 */
  function touOf(meter) {
    const g = k => N(meter, k);
    return { tip: g('meter_ver_pos'), peak: g('meter_hig_pos'), flat: g('meter_mid_pos'), valley: g('meter_low_pos'), deep: g('meter_dplow_pos') };
  }
  function sumTou(meter, neg) {
    /* 优先储能计量电表（点位最全），缺失时退到并网逆流电表 */
    const meters = [meter, 'meter-aems-storage', 'meter-lems-antireflux'];
    for (let m = 0; m < meters.length; m++) {
      const pick = k => { const v = N(meters[m], k); return v === null ? null : v; };
      const t = {
        tip: pick(neg ? 'meter_ver_neg' : 'meter_ver_pos'),
        peak: pick(neg ? 'meter_hig_neg' : 'meter_hig_pos'),
        flat: pick(neg ? 'meter_mid_neg' : 'meter_mid_pos'),
        valley: pick(neg ? 'meter_low_neg' : 'meter_low_pos'),
        deep: pick(neg ? 'meter_dplow_neg' : 'meter_dplow_pos')
      };
      if (t.tip !== null || t.peak !== null || t.flat !== null) return t;
    }
    return { tip: 0, peak: 0, flat: 0, valley: 0, deep: 0 };
  }
  function money(t) {                       // 分时电量 × 电价
    return (t.tip || 0) * cfg.tip + (t.peak || 0) * cfg.peak + (t.flat || 0) * cfg.flat + (t.valley || 0) * cfg.valley + (t.deep || 0) * cfg.deep;
  }
  function touTotal(t) { return (t.tip || 0) + (t.peak || 0) + (t.flat || 0) + (t.valley || 0) + (t.deep || 0); }

  /* ---------- 渲染 ---------- */
  let chart1 = null, chart2 = null, chartPay = null, chartCycle = null;

  function render() {
    const host = byId('detailBody');
    if (!host) return;

    /* 采集实时值 */
    const totChg = sum('cluster', 'cluSumsChaElec');
    const totDis = sum('cluster', 'cluSumsDischgElec');
    const dayChg = sum('cluster', 'cludaychg_cap');
    const dayDis = sum('cluster', 'cludaydis_cap');
    const soc = N('emu', 'SumsSOC');
    const soh = avgSoh();
    const pcsP = N('emu', 'PCSSumsActivePower');
    const gridP = N('meter-lems-antireflux', 'meter_tot_p');
    /* 转换效率按累计电量算（与厂家平台口径一致：总放电量 / 总充电量） */
    const eff = (totChg && totDis) ? (totDis / totChg * 100) : ((dayChg && dayDis) ? (dayDis / dayChg * 100) : null);

    /* 分时电量（累计充/放电，取自电表正/反向分时电能） */
    const chgTou = sumTou('meter-lems-antireflux', false);
    const disTou = sumTou('meter-lems-antireflux', true);
    let income = money(disTou), expense = money(chgTou);
    /* 电表没上报分时电量时，用累计电量 × 电价估算（放电按尖/峰均价、充电按谷/深谷均价） */
    let estimatedMoney = false;
    if (touTotal(chgTou) === 0 && touTotal(disTou) === 0 && (totChg || totDis)) {
      income = (totDis || 0) * ((cfg.tip + cfg.peak) / 2);
      expense = (totChg || 0) * ((cfg.valley + cfg.deep) / 2);
      estimatedMoney = true;
    }
    const profit = income - expense;

    /* 会话窗口 */
    const now = new Date();
    const tt = now.toTimeString().slice(0, 8);
    S.win.t.push(tt); S.win.soc.push(soc); S.win.pcs.push(pcsP); S.win.grid.push(gridP);
    S.win.load.push(gridP !== null && pcsP !== null ? +(gridP - pcsP).toFixed(1) : null);
    ['t', 'soc', 'pcs', 'grid', 'load'].forEach(k => { while (S.win[k].length > WIN) S.win[k].shift(); });
    S.alarms = collectAlarms();

    const statLabel = pcsP === null ? '--' : (Math.abs(pcsP) < 3 ? '待机' : (pcsP < 0 ? '充电中' : '放电中'));

    host.innerHTML = '';
    /* 顶部信息 */
    const bar = el('div', 'dt-bar');
    const st = byId('stationName');
    bar.appendChild(el('b', '', (st && st.textContent && st.textContent !== '--') ? st.textContent : '储能电站'));
    bar.appendChild(el('span', 'dt-time', '数据更新时间 ' + tt + '　·　电价：尖' + cfg.tip + ' / 峰' + cfg.peak + ' / 平' + cfg.flat + ' / 谷' + cfg.valley + ' / 深谷' + cfg.deep + ' 元·kWh⁻¹'));
    const btn = el('button', 'mq-btn', '电价与额定参数');
    btn.addEventListener('click', toggleTariff);
    bar.appendChild(btn);
    host.appendChild(bar);

    /* 电价配置（默认折叠） */
    const tf = el('div', 'dt-tariff hidden');
    tf.id = 'dtTariff';
    tf.innerHTML = '<div class="dt-tf-grid"></div>';
    [['cabPower', '装机功率(kW)'], ['cabCapacity', '装机容量(kWh)'], ['tip', '尖电价'], ['peak', '峰电价'], ['flat', '平电价'], ['valley', '谷电价'], ['deep', '深谷电价']]
      .forEach(function ([k, label]) {
        const l = el('label', 'dt-tf');
        l.appendChild(el('span', '', label));
        const inp = el('input');
        inp.type = 'number'; inp.step = '0.01'; inp.value = cfg[k];
        inp.addEventListener('change', function () { cfg[k] = parseFloat(inp.value) || 0; saveCfg(); render(); });
        l.appendChild(inp);
        tf.querySelector('.dt-tf-grid').appendChild(l);
      });
    host.appendChild(tf);

    /* KPI 行 */
    const kpis = el('div', 'dt-kpis');
    [['总装机功率', cfg.cabPower, 'kW'], ['总装机容量', cfg.cabCapacity, 'kWh'],
     ['总充电量', totChg, 'kWh'], ['总放电量', totDis, 'kWh'],
     ['今日充电量', dayChg, 'kWh'], ['今日放电量', dayDis, 'kWh'],
     ['累计收益', profit, '元', 'money']
    ].forEach(function ([label, v, unit, cls]) {
      const c = el('div', 'dt-kpi' + (cls ? ' ' + cls : ''));
      c.appendChild(el('span', '', label));
      c.appendChild(el('b', '', f(v, cls === 'money' ? 2 : (Math.abs(v) >= 1000 ? 1 : (Math.abs(v) >= 100 ? 1 : 2)))));
      c.appendChild(el('u', '', unit));
      kpis.appendChild(c);
    });
    host.appendChild(kpis);

    /* 三列主体 */
    const grid = el('div', 'dt-grid');

    /* 左列：两条曲线 */
    const colL = el('div', 'dt-col');
    colL.appendChild(panel('充放电曲线', 'SOC(%) · 储能功率(kW)', 'dtChart1', '本次会话实时曲线（历史曲线需后端存储）'));
    colL.appendChild(panel('功率曲线', '关口功率 · 储能功率 · 负荷(kW)', 'dtChart2', ''));
    grid.appendChild(colL);

    /* 中列：实时状态 + 分时电量 + 收益 */
    const colM = el('div', 'dt-col');
    const pState = el('section', 'dt-panel');
    pState.appendChild(el('div', 'dt-ptitle', '实时状态数据'));
    const ringBox = el('div', 'dt-rings');
    [['实时状态', statLabel, null], ['SOC', soc, '%'], ['转换效率', eff, '%'], ['SOH', soh, '%']]
      .forEach(function ([label, v, unit]) {
        const r = el('div', 'dt-ring');
        r.innerHTML = '<b>' + (unit ? (v === null ? '--' : Number(v).toFixed(1)) : v) + '</b>'
          + (unit ? '<i>' + unit + '</i>' : '') + '<span>' + label + '</span>';
        if (unit || label === '实时状态') r.classList.add('on');
        ringBox.appendChild(r);
      });
    pState.appendChild(ringBox);
    const al = el('div', 'dt-alarms');
    al.innerHTML = S.alarms.length
      ? S.alarms.slice(0, 8).map(a => '<span class="dt-alarm">' + a + '</span>').join('')
      : '<span class="dt-ok">实时告警：当前无告警</span>';
    pState.appendChild(al);
    colM.appendChild(pState);

    const pTou = el('section', 'dt-panel');
    pTou.appendChild(el('div', 'dt-ptitle', '累计电量（分时）'));
    const touBox = el('div', 'dt-tou');
    [['充电量', chgTou, income * 0 + money(chgTou)], ['放电量', disTou, money(disTou)]].forEach(function ([t, obj, m]) {
      const b = el('div', 'dt-tou-col');
      b.appendChild(el('b', '', t));
      [['尖', 'tip'], ['峰', 'peak'], ['平', 'flat'], ['谷', 'valley'], ['深谷', 'deep']].forEach(function ([n, k]) {
        const r = el('div', 'dt-kv');
        r.appendChild(el('span', '', n));
        r.appendChild(el('b', '', f(obj[k], 1)));
        b.appendChild(r);
      });
      b.appendChild(el('div', 'dt-kv sum', '<span>合计</span><b>' + f(touTotal(obj), 1) + '</b>'));
      b.appendChild(el('div', 'dt-kv money', '<span>折合电费</span><b>' + f(m, 2) + ' 元</b>'));
      touBox.appendChild(b);
    });
    pTou.appendChild(touBox);
    colM.appendChild(pTou);

    const pMoney = el('section', 'dt-panel');
    pMoney.appendChild(el('div', 'dt-ptitle', estimatedMoney
      ? '收益信息（按配置电价与累计电量估算，电表分时电量未上报）'
      : '收益信息（按当前电价折算）'));
    const mg = el('div', 'dt-money');
    [['累计收益', profit], ['放电收入', income], ['充电总支出', expense], ['昨日收益', null]].forEach(function ([k, v]) {
      const r = el('div', 'dt-kv');
      r.appendChild(el('span', '', k));
      r.appendChild(el('b', '', v === null ? '待后端' : f(v, 2) + ' 元'));
      mg.appendChild(r);
    });
    pMoney.appendChild(mg);
    colM.appendChild(pMoney);
    grid.appendChild(colM);

    /* 右列：两个统计图 */
    const colR = el('div', 'dt-col');
    colR.appendChild(panel('收益趋势统计', '本次会话累计收益（元）', 'dtChartPay', '按电价折算，历史趋势需后端'));
    colR.appendChild(panel('充放电量统计', '本次会话充/放电量（kWh）', 'dtChartCycle', ''));
    grid.appendChild(colR);

    host.appendChild(grid);

    /* 图表 */
    setTimeout(function () {
      drawLine('dtChart1', 'chart1', [
        { name: 'SOC(%)', data: S.win.soc, axis: 0, color: '#2ee6c8' },
        { name: '储能功率(kW)', data: S.win.pcs, axis: 1, color: '#ffb020' }
      ]);
      drawLine('dtChart2', 'chart2', [
        { name: '关口功率', data: S.win.grid, axis: 0, color: '#7aa2ff' },
        { name: '储能功率', data: S.win.pcs, axis: 0, color: '#2ee6c8' },
        { name: '负荷', data: S.win.load, axis: 0, color: '#b48cff' }
      ]);
      drawBar('dtChartPay', 'chartPay', '收益(元)', [profit === null ? 0 : +profit.toFixed(2)], ['本次会话'], '#2ee6c8');
      drawBar('dtChartCycle', 'chartCycle', '电量(kWh)', [dayChg || 0, dayDis || 0], ['今日充电', '今日放电'], '#7aa2ff');
    }, 30);
  }

  function panel(title, sub, canvasId, note) {
    const s = el('section', 'dt-panel');
    const h = el('div', 'dt-ptitle');
    h.appendChild(el('b', '', title));
    if (sub) h.appendChild(el('em', '', sub));
    s.appendChild(h);
    const c = el('div', 'dt-chart');
    c.id = canvasId;
    s.appendChild(c);
    if (note) s.appendChild(el('div', 'dt-note', note));
    return s;
  }
  const charts = {};
  function drawLine(id, key, series) {
    const node = byId(id);
    if (!node || typeof echarts === 'undefined') return;
    if (!charts[key]) charts[key] = echarts.init(node);
    charts[key].setOption({
      grid: { left: 46, right: 46, top: 26, bottom: 24 },
      tooltip: { trigger: 'axis', backgroundColor: 'rgba(6,18,20,.92)', borderColor: 'rgba(46,230,200,.35)', textStyle: { color: '#cfeee8', fontSize: 11 } },
      legend: { show: true, right: 6, top: 0, textStyle: { color: '#6f9a94', fontSize: 10 }, itemWidth: 12, itemHeight: 8 },
      xAxis: { type: 'category', data: S.win.t, axisLine: { lineStyle: { color: 'rgba(46,230,200,.25)' } }, axisLabel: { color: '#6b9490', fontSize: 9 } },
      yAxis: [
        { type: 'value', scale: true, axisLabel: { color: '#6b9490', fontSize: 9 }, splitLine: { lineStyle: { color: 'rgba(46,230,200,.08)', type: 'dashed' } } },
        { type: 'value', scale: true, axisLabel: { color: '#6b9490', fontSize: 9 }, splitLine: { show: false } }
      ],
      series: series.map(s => ({
        name: s.name, type: 'line', smooth: true, symbol: 'none', yAxisIndex: s.axis,
        data: s.data, lineStyle: { width: 1.6, color: s.color },
        areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: s.color + '55' }, { offset: 1, color: s.color + '00' }]) }
      }))
    }, true);
  }
  function drawBar(id, key, unit, data, labels, color) {
    const node = byId(id);
    if (!node || typeof echarts === 'undefined') return;
    if (!charts[key]) charts[key] = echarts.init(node);
    charts[key].setOption({
      grid: { left: 48, right: 16, top: 22, bottom: 24 },
      tooltip: { trigger: 'axis', backgroundColor: 'rgba(6,18,20,.92)', borderColor: 'rgba(46,230,200,.35)', textStyle: { color: '#cfeee8', fontSize: 11 } },
      xAxis: { type: 'category', data: labels, axisLine: { lineStyle: { color: 'rgba(46,230,200,.25)' } }, axisLabel: { color: '#6b9490', fontSize: 10 } },
      yAxis: { type: 'value', name: unit, nameTextStyle: { color: '#6f9a94', fontSize: 10 }, scale: true, axisLabel: { color: '#6b9490', fontSize: 9 }, splitLine: { lineStyle: { color: 'rgba(46,230,200,.08)', type: 'dashed' } } },
      series: [{
        type: 'bar', data: data, barWidth: '38%',
        itemStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: color }, { offset: 1, color: 'rgba(46,230,200,.15)' }]) }
      }]
    }, true);
  }

  function toggleTariff() { const t = byId('dtTariff'); if (t) t.classList.toggle('hidden'); }
  function resize() { Object.keys(charts).forEach(k => charts[k].resize()); }

  let timer = null;
  function open() {
    const ov = byId('overviewView'), gv = byId('gaoteView'), dv = byId('detailView');
    if (ov) ov.classList.add('hidden');
    if (gv) gv.classList.add('hidden');
    if (dv) dv.classList.remove('hidden');
    render();
    if (timer) clearInterval(timer);
    timer = setInterval(function () {
      if (dv && !dv.classList.contains('hidden')) { render(); resize(); }
    }, 5000);
  }
  function hide() { const dv = byId('detailView'); if (dv) dv.classList.add('hidden'); if (timer) { clearInterval(timer); timer = null; } }

  return { open, hide, render, resize, cfg: () => cfg };
})();
