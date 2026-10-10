/* ============================================================
 * 洙边卫生院站（分布式光伏 · 阳光电源 iSolarCloud）
 *
 *   数据来自本站的阳光云接入服务（每 5 分钟拉一次）：
 *     GET /solar/summary   电站汇总：功率 W、当日发电 Wh、累计发电 Wh、
 *                          装机容量 kWp、位置、告警数、更新时间
 *     GET /solar/devices   设备列表：SN / 名称 / 类型 / 状态 / 型号
 *     GET /solar/trend     发电曲线：range=today|yesterday|days3
 *                          点：{ t, power_kw, daily_yield_kwh, total_yield_kwh }
 *
 *   页面字段对齐阳光云（App / 网页）上的那一套；收益按电价估算，
 *   电价存在浏览器本地，点「电价」即可改。
 * ============================================================ */
window.SolarUI = (function () {
  'use strict';

  const byId = id => document.getElementById(id);
  const LS_TARIFF = 'dianzhan.solar.tariff';
  const CO2_PER_KWH = 0.997;          // kg CO₂ / kWh（与阳光云页面口径一致）
  const COAL_PER_KWH = 0.404;         // kg 标准煤 / kWh
  const TREE_PER_KG = 1 / 18.3;       // 每棵树每年约吸收 18.3 kg CO₂
  const REFRESH_MS = 60000;           // 汇总与设备 1 分钟刷一次（服务端 5 分钟一拉）

  let chart = null, timer = null, range = 'today', busyUntil = 0, last = null;
  let sum = null, devices = [], trend = [], wx = null, sceneOn = true;

  /* ---------------- 小工具 ---------------- */
  const num = v => (v === null || v === undefined || v === '' || isNaN(Number(v))) ? null : Number(v);
  const kwh = v => num(v) === null ? null : num(v) / 1000;                       // Wh → kWh（度）
  function fmt(v, d) {
    const n = num(v);
    if (n === null) return '--';
    return n.toLocaleString('zh-CN', { minimumFractionDigits: d === undefined ? 1 : d, maximumFractionDigits: d === undefined ? 1 : d });
  }
  function fmtTime(iso) {
    if (!iso) return '--';
    const d = new Date(iso);
    const p = n => String(n).padStart(2, '0');
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function tariff() {
    const v = Number(localStorage.getItem(LS_TARIFF));
    return (isFinite(v) && v > 0) ? v : 1.0;      // 默认 1.0 元/度（与阳光云页面上的净收益口径一致）
  }
  function isDay() { return document.documentElement.getAttribute('data-theme') === 'day'; }

  /* 接口基址：正式域名下走同源 /solar/*（nginx 已代理到接入服务）；
     本地起静态服务调试时连 tools/solar-dev-relay.js（把 /solar 转发到线上） */
  const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const API = LOCAL ? 'http://127.0.0.1:8099' : '';

  /* 取接口数据：带 12 秒超时 + 最多 3 次重试（现场网络经代理时偶发卡住） */
  async function getJSON(path) {
    let err = null;
    for (let i = 0; i < 3; i++) {
      const ctl = new AbortController();
      const to = setTimeout(function () { ctl.abort(); }, 12000);
      try {
        const r = await fetch(API + '/solar/' + path, { cache: 'no-store', signal: ctl.signal });
        clearTimeout(to);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return await r.json();
      } catch (e) {
        clearTimeout(to);
        err = e;
        await new Promise(function (res) { setTimeout(res, 700); });
      }
    }
    throw err || new Error('请求失败');
  }

  /* ---------------- 视图切换 ---------------- */
  function hideOthers() {
    ['main', 'overviewView', 'gaoteView', 'detailView', 'deviceView', 'tabView'].forEach(function (id) {
      const e = byId(id); if (e) e.classList.add('hidden');
    });
    if (window.GaoteView) GaoteView.hide();
    if (window.GaoteDetail) GaoteDetail.hide();
  }
  function open() {
    hideOthers();
    const v = byId('solarView');
    if (v) v.classList.remove('hidden');
    document.body.classList.add('solar-mode');
    refresh();
    if (sceneOn) setTimeout(ensureScene, 80);
    if (!timer) timer = setInterval(refresh, REFRESH_MS);
    setTimeout(function () { if (chart) chart.resize(); if (window.SolarScene) SolarScene.resize(); }, 220);
  }
  function hide() {
    const v = byId('solarView');
    if (v) v.classList.add('hidden');
    document.body.classList.remove('solar-mode');
    if (timer) { clearInterval(timer); timer = null; }
  }

  /* ---------------- 数据 ---------------- */
  async function refresh() {
    /* 90 秒自愈锁：请求被网络挂住时，不会把后续刷新永久挡住 */
    if (Date.now() < busyUntil) return;
    busyUntil = Date.now() + 90000;
    const src = byId('slSrc');
    if (src) src.textContent = '正在读取…';
    try {
      /* 三个接口串行拉：现场网络经代理时并发连接容易被挂住，串行稳得多 */
      const s = await getJSON('summary');
      if (s && s.data) { sum = s.data; last = new Date(); }
      const d = await getJSON('devices');
      if (d && d.data) devices = d.data;
      const t = await getJSON('trend?range=' + range);
      if (t && t.points) trend = t.points;
      try {                                   /* 天气失败不影响其余数据 */
        const w = await getJSON('weather');
        if (w && w.data) wx = w.data;
      } catch (_) {}
      render();
      if (src) src.textContent = sum ? ('阳光云接入 · 更新 ' + fmtTime(sum.updated_at)) : '服务未就绪';
    } catch (e) {
      if (src) src.textContent = '读取失败：' + (e.message || e);
    } finally { busyUntil = 0; }
  }

  /* ---------------- 渲染 ---------------- */
  function card(label, value, unit, sub, cls) {
    return '<div class="sl-kpi ' + (cls || '') + '">'
      + '<div class="sl-kv"><b>' + value + '</b>' + (unit ? '<u>' + unit + '</u>' : '') + '</div>'
      + '<div class="sl-kl">' + label + '</div>'
      + (sub ? '<div class="sl-ks">' + sub + '</div>' : '')
      + '</div>';
  }

  function renderKpis() {
    const box = byId('slKpis');
    if (!box) return;
    if (!sum) { box.innerHTML = '<div class="sl-empty">还没有读到数据</div>'; return; }
    const pKw = num(sum.power) === null ? null : num(sum.power) / 1000;
    const dKwh = kwh(sum.daily_yield);
    const tKwh = kwh(sum.total_yield);
    const cap = num(sum.capacity);
    const hours = (dKwh !== null && cap) ? dKwh / cap : num(sum.daily_hours);
    const price = tariff();
    const income = dKwh === null ? null : dKwh * price;
    const co2 = tKwh === null ? null : tKwh * CO2_PER_KWH / 1000;          // 吨
    const coal = tKwh === null ? null : tKwh * COAL_PER_KWH / 1000;       // 吨
    const trees = co2 === null ? null : Math.round(co2 * 1000 * TREE_PER_KG);

    box.innerHTML =
      card('实时功率', fmt(pKw, 2), 'kW', cap ? ('装机 ' + fmt(cap, 2) + ' kWp') : '', 'hi')
      + card('当日发电', fmt(dKwh, 1), '度', hours !== null ? ('等效 ' + fmt(hours, 2) + ' 小时') : '')
      + card('当日收益', fmt(income, 2), '元', '电价 <i id="slPrice" title="点击修改电价">' + fmt(price, 2) + '</i> 元/度')
      + card('累计发电', fmt(tKwh, 0), '度', sum.plant && sum.plant.install_date ? ('并网 ' + String(sum.plant.install_date).slice(0, 10)) : '')
      + card('装机容量', fmt(cap, 2), 'kWp', sum.plant ? (sum.plant.type || '分布式光伏') : '')
      + card('CO₂减排', fmt(co2, 2), '吨', trees !== null ? ('等效植树 ' + trees + ' 棵') : '');
    const priceEl = byId('slPrice');
    if (priceEl) priceEl.addEventListener('click', editTariff);
  }

  function editTariff() {
    const cur = String(tariff());
    const v = prompt('每度电收益（元/度）：\n用于「当日收益」估算，与阳光云页面上的净收益口径一致。', cur);
    if (v === null) return;
    const n = Number(v);
    if (!isFinite(n) || n <= 0) { alert('请输入大于 0 的数字'); return; }
    localStorage.setItem(LS_TARIFF, String(n));
    renderKpis();
  }

  function renderTrend() {
    const meta = byId('slTrendMeta');
    if (!chart && typeof echarts !== 'undefined') initChart();   /* echarts 是延迟加载的，第一次渲染时再初始化 */
    if (chart && Array.isArray(trend)) {
      const pts = trend.filter(p => num(p.power_kw) !== null);
      const max = pts.reduce((m, p) => Math.max(m, num(p.power_kw)), 0);
      const day = pts.filter(p => num(p.daily_yield_kwh) !== null).reduce((m, p) => Math.max(m, num(p.daily_yield_kwh)), 0);
      if (meta) {
        meta.textContent = pts.length
          ? (pts.length + ' 点 · 峰值 ' + fmt(max, 2) + ' kW' + (day ? ' · 当日累计 ' + fmt(day, 1) + ' 度' : ''))
          : '暂无数据（接入后每 5 分钟累积一个点）';
      }
      chart.setOption({
        xAxis: { type: 'time' },
        series: [
          { name: '发电功率', data: pts.map(p => [p.t, num(p.power_kw)]) },
          { name: '当日累计', data: pts.filter(p => num(p.daily_yield_kwh) !== null).map(p => [p.t, num(p.daily_yield_kwh)]) }
        ]
      }, false, true);
    }
  }

  function renderDevices() {
    const box = byId('slDevs'), meta = byId('slDevMeta');
    if (!box) return;
    if (meta) meta.textContent = devices.length ? (devices.length + ' 台') : '--';
    if (!devices.length) { box.innerHTML = '<div class="sl-empty">暂无设备</div>'; return; }
    const TYPE = { 1: '逆变器', 22: '通信模块' };
    box.innerHTML = devices.map(function (d) {
      const ok = !(sum && sum.alarms > 0);
      return '<div class="sl-dev">'
        + '<div class="sl-devmain"><b>' + (d.name || d.sn) + '</b>'
        + '<span>' + (TYPE[d.type] || ('类型 ' + d.type)) + '　' + (d.model || '') + '　SN ' + (d.sn || '') + '</span></div>'
        + '<i class="sl-badge ' + (ok ? 'on' : 'warn') + '">' + (ok ? '正常' : '有告警') + '</i>'
        + '</div>';
    }).join('');
  }

  function renderInfo() {
    const box = byId('slInfo');
    if (!box) return;
    const rows = [
      ['电站名称', sum ? ((sum.plant && sum.plant.name) || '洙边卫生院') : '--'],
      ['电站类型', sum && sum.plant ? (sum.plant.type || '分布式光伏') : '--'],
      ['装机容量', sum && sum.capacity ? fmt(sum.capacity, 2) + ' kWp' : '--'],
      ['电站地址', (sum && sum.location) || '--'],
      ['并网日期', sum && sum.plant && sum.plant.install_date ? String(sum.plant.install_date).slice(0, 10) : '--'],
      ['电站编号', sum ? ('ps_id ' + sum.ps_id) : '--'],
      ['告警 / 故障', sum ? ((sum.alarms === null || sum.alarms === undefined ? '--' : sum.alarms) + ' / 0') : '--'],
      ['数据更新', sum ? fmtTime(sum.updated_at) : '--']
    ];
    box.innerHTML = rows.map(r => '<div class="sl-row"><span>' + r[0] + '</span><b>' + r[1] + '</b></div>').join('');
  }

  function renderGreen() {
    const box = byId('slGreen');
    if (!box) return;
    const tKwh = sum ? kwh(sum.total_yield) : null;
    const co2 = tKwh === null ? null : tKwh * CO2_PER_KWH;            // kg
    const coal = tKwh === null ? null : tKwh * COAL_PER_KWH;          // kg
    const trees = co2 === null ? null : Math.round(co2 * TREE_PER_KG);
    box.innerHTML =
      '<div class="sl-green-row"><b>' + fmt(co2 === null ? null : co2 / 1000, 2) + '</b><u>吨</u><span>CO₂ 减排量</span></div>'
      + '<div class="sl-green-row"><b>' + fmt(coal === null ? null : coal / 1000, 2) + '</b><u>吨</u><span>节约标准煤</span></div>'
      + '<div class="sl-green-row"><b>' + (trees === null ? '--' : trees) + '</b><u>棵</u><span>等效植树</span></div>';
  }

  function renderWeather() {
    const box = byId('slWx'), meta = byId('slWxMeta');
    if (!box) return;
    if (!wx) { box.innerHTML = '<div class="sl-empty">天气暂不可用</div>'; return; }
    if (meta) meta.textContent = 'Open-Meteo · ' + String(wx.time || '').slice(11, 16);
    const row = (k, v) => '<div class="sl-wx-row"><span>' + k + '</span><b>' + v + '</b></div>';
    box.innerHTML =
      '<div class="sl-wx-top"><b>' + (wx.text || '--') + '</b><span>' + fmt(num(wx.temp), 1) + '<u>℃</u></span></div>'
      + row('体感温度', fmt(num(wx.feels), 1) + ' ℃')
      + row('湿度', fmt(num(wx.humidity), 0) + ' %')
      + row('风速', fmt(num(wx.wind), 1) + ' m/s')
      + row('云量', fmt(num(wx.cloud), 0) + ' %')
      + row('辐照度', fmt(num(wx.radiation), 0) + ' W/㎡')
      + row('日出 / 日落', (wx.sunrise || '--') + ' / ' + (wx.sunset || '--'));
  }

  /* 把实时功率与天气推给三维场景 */
  function pushScene() {
    const meta = byId('slSceneMeta');
    if (meta) {
      meta.textContent = wx
        ? (wx.text + ' · 云量 ' + Math.round(num(wx.cloud) || 0) + '% · 辐照 ' + Math.round(num(wx.radiation) || 0) + ' W/㎡')
        : '--';
    }
    if (!window.SolarScene || !sceneOn) return;
    const pKw = sum ? (num(sum.power) || 0) / 1000 : 0;
    SolarScene.setPower(pKw, sum ? num(sum.capacity) : null);
    if (wx) SolarScene.setWeather(wx);
  }

  function ensureScene() {
    if (!sceneOn || !window.SolarScene || !byId('solar3d')) return;
    SolarScene.init(function () { pushScene(); });
    setTimeout(function () { if (window.SolarScene) SolarScene.resize(); }, 120);
  }

  function render() { renderKpis(); renderTrend(); renderDevices(); renderInfo(); renderGreen(); renderWeather(); pushScene(); }

  /* ---------------- 图表：与站内其它曲线同一套配色 ---------------- */
  function initChart() {
    const el = byId('slTrendChart');
    if (!el || typeof echarts === 'undefined') return;
    chart = echarts.init(el);
    applyTheme();
    chart.setOption({
      grid: { left: 52, right: 54, top: 34, bottom: 26 },
      legend: { top: 0, right: 2, itemWidth: 10, itemHeight: 4, itemGap: 14, textStyle: { fontSize: 10 } },
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(6,18,20,.92)',
        borderColor: 'rgba(46,230,200,.35)',
        textStyle: { color: '#cfeee8', fontSize: 11 },
        valueFormatter: v => (v === null || v === undefined) ? '-' : v
      },
      xAxis: {
        type: 'time',
        axisLine: { lineStyle: { color: 'rgba(46,230,200,.25)' } },
        axisTick: { show: false },
        axisLabel: { hideOverlap: true }
      },
      yAxis: [
        { type: 'value', name: 'kW', nameTextStyle: { fontSize: 10 }, axisLabel: { fontSize: 10 }, splitLine: { lineStyle: { color: 'rgba(46,230,200,.08)', type: 'dashed' } } },
        { type: 'value', name: '度', nameTextStyle: { fontSize: 10 }, axisLabel: { fontSize: 10 }, splitLine: { show: false } }
      ],
      series: [
        {
          name: '发电功率', type: 'line', smooth: true, symbol: 'none', yAxisIndex: 0,
          lineStyle: { width: 2, color: '#ffb020' },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: 'rgba(255,176,32,.35)' },
              { offset: 1, color: 'rgba(255,176,32,0)' }
            ])
          },
          data: []
        },
        {
          name: '当日累计', type: 'line', smooth: true, symbol: 'none', yAxisIndex: 1,
          lineStyle: { width: 1.4, color: 'rgba(46,230,200,.85)', type: 'dashed' },
          data: []
        }
      ]
    });
  }

  function applyTheme() {
    if (!chart) return;
    const day = isDay();
    const ax = day ? '#3d5c5a' : '#6b9490';
    chart.setOption({
      xAxis: { axisLabel: { color: ax } },
      yAxis: [{ axisLabel: { color: ax } }, { axisLabel: { color: ax } }],
      legend: { textStyle: { color: ax } }
    });
  }

  /* ---------------- 初始化 ---------------- */
  function init() {
    if (!byId('solarView')) return;
    initChart();
    const r = byId('slRefresh'); if (r) r.addEventListener('click', refresh);
    const b = byId('slBack'); if (b) b.addEventListener('click', function () {
      hide();
      if (window.PortalUI) PortalUI.openPortal();
    });
    const ranges = byId('slRanges');
    if (ranges) {
      ranges.addEventListener('click', function (e) {
        const btn = e.target.closest('button[data-range]');
        if (!btn) return;
        range = btn.getAttribute('data-range');
        [].forEach.call(ranges.querySelectorAll('button'), function (x) { x.classList.toggle('on', x === btn); });
        refresh();
      });
    }
    const sceneBtns = byId('slSceneBtns');
    if (sceneBtns) {
      sceneBtns.addEventListener('click', function (e) {
        const btn = e.target.closest('button[data-scene]');
        if (!btn) return;
        sceneOn = btn.getAttribute('data-scene') === '3d';
        [].forEach.call(sceneBtns.querySelectorAll('button'), function (x) { x.classList.toggle('on', x === btn); });
        const host = byId('solar3d');
        const tip = document.querySelector('.sl-scene-tip');
        if (host) host.style.display = sceneOn ? '' : 'none';
        if (tip) tip.style.display = sceneOn ? '' : 'none';
        if (sceneOn) setTimeout(ensureScene, 60);
      });
    }
    /* 主题切换时重画坐标轴颜色 */
    new MutationObserver(function () { setTimeout(function () { applyTheme(); if (chart) chart.resize(); }, 60); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    window.addEventListener('resize', function () { if (chart) chart.resize(); });
  }

  return { init, open, hide, refresh, isOpen: function () { return byId('solarView') && !byId('solarView').classList.contains('hidden'); } };
})();
