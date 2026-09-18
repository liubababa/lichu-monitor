/* ============================================================
 * 厂家平台数据页（内容照搬 ess-ds.com 站点详情页，视觉用力储未来风格）
 *
 * 数据来源：js/vendor-data.js（由厂家平台接口抓取的真实快照）
 *   realTime  实时状态/KPI/收益/分时电量（每项自带单位）
 *   electric  近 14 天充放电量与效率
 *   powerCurve 当日功率曲线（5 分钟粒度）+ SOC 曲线
 *   revenue   近 14 天收益（削峰填谷/需求侧响应/需求/光伏）
 *   station   站点信息（名称/容量）· alarm 实时告警数
 * ============================================================ */
window.VendorView = (function () {
  'use strict';

  const byId = id => document.getElementById(id);
  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; }
  const D = () => window.VENDOR_DATA || {};
  function rt() { const d = D(); return (d.realTime && d.realTime.data) || {}; }

  /* 单位换算：分时电量每项自带单位，统一折算成 kWh */
  function toKwh(v, unit) {
    const u = String(unit || '').toUpperCase();
    const n = Number(v) || 0;
    if (u === 'MWH') return n * 1000;
    if (u === 'GWH') return n * 1000000;
    return n;                                  // kWh
  }
  function num(v, d) { return (v === null || v === undefined || isNaN(Number(v))) ? '--' : Number(v).toFixed(d === undefined ? 1 : d); }
  function wan(v) { return (v === null || v === undefined) ? '--' : Number(v).toFixed(2) + ' 万元'; }

  const TOU = [['尖', 'sharp'], ['峰', 'peak'], ['平', 'flat'], ['谷', 'valley'], ['深谷', 'deepValley'], ['其他1', 'kz6'], ['其他2', 'kz7'], ['其他3', 'kz8']];

  const charts = {};
  let inited = false;

  function render() {
    const host = byId('vendorBody');
    if (!host) return;
    const d = D(), r = rt();
    const st = (d.station && d.station.data && d.station.data.list && d.station.data.list[0]) || {};
    const alarmCnt = (d.alarm && d.alarm.data !== undefined) ? d.alarm.data : null;

    /* 装机容量取自 standardName（形如 力储未来1-2·储能·522kWh·临沂莒南·鲁）；功率无接口字段时用配置值 */
    let cap = null, power = null;
    const m = /([\d.]+)\s*kWh/i.exec(st.standardName || '');
    if (m) cap = parseFloat(m[1]);
    const mp = /([\d.]+)\s*kW(?!h)/i.exec(st.standardName || '');
    if (mp) power = parseFloat(mp[1]);
    if (power === null && r.installedPower != null) power = r.installedPower;
    if (cap === null && r.installedCapacity != null) cap = r.installedCapacity;
    if (power === null) { try { power = JSON.parse(localStorage.getItem('dianzhan.tariff') || '{}').cabPower || 250; } catch (_) { power = 250; } }

    host.innerHTML = '';

    /* 顶部：站点 + 快照时间 */
    const bar = el('div', 'dt-bar');
    bar.appendChild(el('b', '', st.name || '储能电站'));
    const capTime = D()._capturedAt ? new Date(D()._capturedAt).toLocaleString('zh-CN') : '--';
    bar.appendChild(el('span', 'dt-time', '数据来源：中和汇能 集控平台（ess-ds.com）· 抓取时间 ' + capTime));
    const btn = el('button', 'mq-btn', '刷新图表');
    btn.addEventListener('click', function () { Object.keys(charts).forEach(k => charts[k].resize()); });
    bar.appendChild(btn);
    host.appendChild(bar);

    /* KPI 行（照搬：装机功率/容量 + 充放电量 + 收益） */
    const kpis = el('div', 'dt-kpis');
    [
      ['总装机功率', power, 'kW', ''],
      ['总装机容量', cap, 'kWh', ''],
      ['总充电量', r.totalChargeCapacity != null ? r.totalChargeCapacity : null, r.totalChargeCapacityUnit || '', ''],
      ['总放电量', r.totalDisChargeCapacity != null ? r.totalDisChargeCapacity : null, r.totalDisChargeCapacityUnit || '', ''],
      ['今日充电量', r.dayChargeCapacity != null ? r.dayChargeCapacity : (d.electric && d.electric.data && d.electric.data.list ? Number(d.electric.data.list[d.electric.data.list.length - 1].cha) : null), 'kWh', ''],
      ['今日放电量', r.dayDisChargeCapacity != null ? r.dayDisChargeCapacity : (d.electric && d.electric.data && d.electric.data.list ? Number(d.electric.data.list[d.electric.data.list.length - 1].disCha) : null), 'kWh', ''],
      ['累计收益', r.totalEarnings, r.totalEarningsUnit || '万元', 'money']
    ].forEach(function ([label, v, unit, cls]) {
      const c = el('div', 'dt-kpi' + (cls ? ' ' + cls : ''));
      c.appendChild(el('span', '', label));
      c.appendChild(el('b', '', num(v, Math.abs(Number(v)) >= 1000 ? 1 : 2)));
      c.appendChild(el('u', '', unit));
      kpis.appendChild(c);
    });
    host.appendChild(kpis);

    const grid = el('div', 'dt-grid');

    /* 左列：两条曲线（当日，来自 powerCurve） */
    const colL = el('div', 'dt-col');
    colL.appendChild(panel('充放电曲线', '储能功率(kW) · SOC(%)', 'vdChart1', '数据源：厂家平台 power-curve 接口（当日 5 分钟粒度）'));
    colL.appendChild(panel('功率曲线', '储能功率(kW)', 'vdChart2', ''));
    grid.appendChild(colL);

    /* 中列：实时状态 + 分时电量 + 收益 */
    const colM = el('div', 'dt-col');
    const pState = el('section', 'dt-panel');
    pState.appendChild(el('div', 'dt-ptitle', '实时状态数据'));
    const rings = el('div', 'dt-rings');
    [['实时状态', r.statusText || '--', null], ['SOC', r.soc, '%'], ['转换效率', r.conversionEfficiency, '%'], ['SOH', r.soh, '%']]
      .forEach(function ([label, v, unit]) {
        const box = el('div', 'dt-ring' + (unit || label === '实时状态' ? ' on' : ''));
        box.innerHTML = '<b>' + (unit ? num(v, 1) : v) + '</b>' + (unit ? '<i>' + unit + '</i>' : '') + '<span>' + label + '</span>';
        rings.appendChild(box);
      });
    pState.appendChild(rings);
    pState.appendChild(el('div', 'dt-alarms', '<span class="' + (alarmCnt ? 'dt-alarm' : 'dt-ok') + '">'
      + (alarmCnt ? ('实时告警 ' + alarmCnt + ' 条') : '实时告警：无') + '</span>'));
    colM.appendChild(pState);

    const pTou = el('section', 'dt-panel');
    pTou.appendChild(el('div', 'dt-ptitle', '<b>累计电量（分时）</b><em>已统一折算为 kWh</em>'));
    const touBox = el('div', 'dt-tou');
    [['累计充电量', r.cumulativeCharge], ['累计放电量', r.cumulativeDisCharge]].forEach(function ([title, obj]) {
      const b = el('div', 'dt-tou-col');
      b.appendChild(el('b', '', title));
      let sum = 0;
      TOU.forEach(function ([n, k]) {
        if (!obj || obj[k] === undefined) return;
        const v = toKwh(obj[k], obj[k + 'Unit']);
        sum += v;
        const row = el('div', 'dt-kv');
        row.appendChild(el('span', '', n));
        row.appendChild(el('b', '', num(v, v >= 1000 ? 0 : 1)));
        b.appendChild(row);
      });
      b.appendChild(el('div', 'dt-kv sum', '<span>合计</span><b>' + num(sum, 0) + ' kWh</b>'));
      touBox.appendChild(b);
    });
    pTou.appendChild(touBox);
    colM.appendChild(pTou);

    const pMoney = el('section', 'dt-panel');
    pMoney.appendChild(el('div', 'dt-ptitle', '储能收益'));
    const mg = el('div', 'dt-money');
    [['累计收益', wan(r.totalEarnings)], ['昨日收益', num(r.yesterdayEarnings, 2) + ' ' + (r.yesterdayEarningsUnit || '元')],
     ['放电总收入', wan(r.disChargeTotalEarnings)], ['充电总支出', wan(r.chargeTotalExpenditures)]]
      .forEach(function ([k, v]) {
        const row = el('div', 'dt-kv');
        row.appendChild(el('span', '', k));
        row.appendChild(el('b', '', v));
        mg.appendChild(row);
      });
    pMoney.appendChild(mg);
    colM.appendChild(pMoney);
    grid.appendChild(colM);

    /* 右列：收益趋势 + 充放电量统计 */
    const colR = el('div', 'dt-col');
    colR.appendChild(panel('收益趋势统计', '削峰填谷 / 需求侧响应 / 需求（元）', 'vdChart3', '近 14 天'));
    colR.appendChild(panel('充放电量统计', '充电量 / 放电量(kWh) · 效率(%)', 'vdChart4', '近 14 天'));
    grid.appendChild(colR);

    host.appendChild(grid);

    setTimeout(function () { drawCharts(); }, 30);
  }

  function panel(title, sub, id, note) {
    const s = el('section', 'dt-panel');
    const h = el('div', 'dt-ptitle');
    h.appendChild(el('b', '', title));
    if (sub) h.appendChild(el('em', '', sub));
    s.appendChild(h);
    const c = el('div', 'dt-chart');
    c.id = id;
    s.appendChild(c);
    if (note) s.appendChild(el('div', 'dt-note', note));
    return s;
  }

  function drawCharts() {
    if (typeof echarts === 'undefined') return;
    const d = D();
    const pc = (d.powerCurve && d.powerCurve.data) || {};
    const es = pc.energyStorage || [];
    const socList = pc.socList || [];
    const x = es.map(p => (p.time || '').slice(11, 16));

    /* 充放电曲线：储能功率 + SOC */
    line('vdChart1', 'vd1', x, [
      { name: '储能功率(kW)', data: es.map(p => Number(p.value)), color: '#ffb020', area: true },
      { name: 'SOC(%)', data: socList.map(p => Number(p.value)), color: '#2ee6c8', axis: 1 }
    ]);
    /* 功率曲线（当前接口仅返回储能功率，其余为空） */
    line('vdChart2', 'vd2', x, [{ name: '储能功率(kW)', data: es.map(p => Number(p.value)), color: '#7aa2ff', area: true }]);

    /* 收益趋势 */
    const rv = (d.revenue && d.revenue.data) || {};
    const rvx = ((rv.peakShavingValleyFilling || [])[0] ? rv.peakShavingValleyFilling : []).map(p => (p.time || '').slice(5));
    line('vdChart3', 'vd3', rvx, [
      { name: '削峰填谷', data: (rv.peakShavingValleyFilling || []).map(p => Number(p.earnings)), color: '#2ee6c8', area: true },
      { name: '需求侧响应', data: (rv.dsdResponse || []).map(p => Number(p.earnings)), color: '#ffb020' },
      { name: '需求', data: (rv.demand || []).map(p => Number(p.earnings)), color: '#7aa2ff' }
    ]);

    /* 充放电量统计：柱 + 效率线 */
    const el2 = (d.electric && d.electric.data && d.electric.data.list) || [];
    const ex = el2.map(p => (p.time || '').slice(5));
    const chart = initChart('vdChart4', 'vd4');
    if (chart) {
      chart.setOption({
        grid: { left: 48, right: 44, top: 26, bottom: 24 },
        tooltip: { trigger: 'axis', backgroundColor: 'rgba(6,18,20,.92)', borderColor: 'rgba(46,230,200,.35)', textStyle: { color: '#cfeee8', fontSize: 11 } },
        legend: { right: 6, top: 0, textStyle: { color: '#6f9a94', fontSize: 10 }, itemWidth: 12, itemHeight: 8 },
        xAxis: { type: 'category', data: ex, axisLine: { lineStyle: { color: 'rgba(46,230,200,.25)' } }, axisLabel: { color: '#6b9490', fontSize: 9 } },
        yAxis: [
          { type: 'value', name: 'kWh', nameTextStyle: { color: '#6f9a94', fontSize: 9 }, scale: true, axisLabel: { color: '#6b9490', fontSize: 9 }, splitLine: { lineStyle: { color: 'rgba(46,230,200,.08)', type: 'dashed' } } },
          { type: 'value', name: '%', min: 80, max: 100, nameTextStyle: { color: '#6f9a94', fontSize: 9 }, axisLabel: { color: '#6b9490', fontSize: 9 }, splitLine: { show: false } }
        ],
        series: [
          { name: '充电量', type: 'bar', barWidth: 6, data: el2.map(p => Number(p.cha)), itemStyle: { color: 'rgba(122,162,255,.75)' } },
          { name: '放电量', type: 'bar', barWidth: 6, data: el2.map(p => Number(p.disCha)), itemStyle: { color: 'rgba(46,230,200,.75)' } },
          { name: '效率', type: 'line', yAxisIndex: 1, smooth: true, symbol: 'none', data: el2.map(p => Number(p.conversionEfficiency)), lineStyle: { color: '#ffb020', width: 1.6 } }
        ]
      }, true);
    }
  }

  function initChart(id, key) {
    const node = byId(id);
    if (!node) return null;
    if (!charts[key]) charts[key] = echarts.init(node);
    return charts[key];
  }
  function line(id, key, x, series) {
    const chart = initChart(id, key);
    if (!chart) return;
    chart.setOption({
      grid: { left: 48, right: 44, top: 26, bottom: 24 },
      tooltip: { trigger: 'axis', backgroundColor: 'rgba(6,18,20,.92)', borderColor: 'rgba(46,230,200,.35)', textStyle: { color: '#cfeee8', fontSize: 11 } },
      legend: { right: 6, top: 0, textStyle: { color: '#6f9a94', fontSize: 10 }, itemWidth: 12, itemHeight: 8 },
      xAxis: { type: 'category', data: x, boundaryGap: false, axisLine: { lineStyle: { color: 'rgba(46,230,200,.25)' } }, axisLabel: { color: '#6b9490', fontSize: 9, interval: Math.max(0, Math.floor(x.length / 8)) } },
      yAxis: [
        { type: 'value', scale: true, axisLabel: { color: '#6b9490', fontSize: 9 }, splitLine: { lineStyle: { color: 'rgba(46,230,200,.08)', type: 'dashed' } } },
        { type: 'value', scale: true, axisLabel: { color: '#6b9490', fontSize: 9 }, splitLine: { show: false } }
      ],
      series: series.map(s => ({
        name: s.name, type: 'line', smooth: true, symbol: 'none', yAxisIndex: s.axis || 0, data: s.data,
        lineStyle: { width: 1.6, color: s.color },
        areaStyle: s.area ? { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: s.color + '44' }, { offset: 1, color: s.color + '00' }]) } : undefined
      }))
    }, true);
  }

  function open() {
    ['overviewView', 'gaoteView', 'detailView'].forEach(function (id) { const e = byId(id); if (e) e.classList.add('hidden'); });
    const v = byId('vendorView');
    if (v) v.classList.remove('hidden');
    const tab = byId('tabView'); if (tab) tab.classList.add('hidden');
    render();
    inited = true;
  }
  function hide() { const v = byId('vendorView'); if (v) v.classList.add('hidden'); }
  function resize() { Object.keys(charts).forEach(k => { try { charts[k].resize(); } catch (_) {} }); }

  return { open, hide, render, resize, isInited: () => inited };
})();
