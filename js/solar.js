/* ============================================================
 * 洙边卫生院站（分布式光伏 · 阳光电源 iSolarCloud ＋ 储能柜 · 东方日升日升云）
 *
 *   光伏数据来自本站的阳光云接入服务（每 5 分钟拉一次）：
 *     GET /solar/summary   电站汇总：功率 W、当日发电 Wh、累计发电 Wh、
 *                          装机容量 kWp、位置、告警数、更新时间
 *     GET /solar/devices   设备列表：SN / 名称 / 类型 / 状态 / 型号
 *     GET /solar/trend     发电曲线：range=today|yesterday|days3
 *                          点：{ t, power_kw, daily_yield_kwh, total_yield_kwh }
 *
 *   储能数据来自日升云接入服务（现场那台柜子自己用 4G 上报到日升云）：
 *     GET /risen/full   一次拿全：EMS 总览（SOC/状态/功率/充放电量/收益）
 *                       + PCS 实时（三相电压电流/频率/功率因数）
 *                       + 电池簇（SOC/SOH/单体电压温度极值）+ 液冷空调
 *                       + 柜内子设备清单（型号/版本/在线状态）
 *
 *   页面字段对齐两家云平台（App / 网页）上的那一套；收益按电价估算，
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

  let chart = null, timer = null, range = 'today', busyUntil = 0;
  let sum = null, devices = [], trend = [], wx = null;
  let stor = null, storDevs = [], storTrend = [], revTrend = [], powTrend = [];
  let storChart = null, revChart = null, powChart = null;
  /* ---------------- 小工具 ---------------- */
  const num = v => (v === null || v === undefined || v === '' || isNaN(Number(v))) ? null : Number(v);
  const kwh = v => num(v) === null ? null : num(v) / 1000;                       // Wh → kWh（度）
  function fmt(v, d) {
    const n = num(v);
    if (n === null) return '--';
    return n.toLocaleString('zh-CN', { minimumFractionDigits: d === undefined ? 1 : d, maximumFractionDigits: d === undefined ? 1 : d });
  }
  /* 功率因数只可能落在 -1..1：日升云实测出现过 654.36 这类坏值，超范围显示 --（不编数） */
  function pfText(v) {
    const n = num(v);
    return (n === null || Math.abs(n) > 1) ? '--' : n.toFixed(2);
  }
  function fmtTime(iso) {
    if (!iso) return '--';
    const d = new Date(iso);
    const p = n => String(n).padStart(2, '0');
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function tariff() {
    const v = Number(localStorage.getItem(LS_TARIFF));
    /* 默认 0.261 元/度：山东 2026 年新能源机制电价竞价结果里的光伏价格（鲁发改价格〔2026〕149 号）。
       注意：0.3949 的燃煤基准价那套从 2025-6-1 起已被机制电价/市场化取代，不再按它算；
       实际按本站拿到的机制电价或结算单为准，页面上点价格即可改（存本地） */
    return (isFinite(v) && v > 0) ? v : 0.261;
  }
  function isDay() { return document.documentElement.getAttribute('data-theme') === 'day'; }

  /* 接口基址：正式域名下走同源 /solar/*、/risen/*（nginx 已分别代理到两个接入服务）；
     本地起静态服务调试时，光伏连 tools/solar-dev-relay.js（8099），储能直连
     本机跑的 tools/risen-cloud-service.js（8097） */
  const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const API = LOCAL ? 'http://127.0.0.1:8099' : '';
  const API_STOR = LOCAL ? 'http://127.0.0.1:8097' : '';

  /* 取接口数据：默认 12 秒超时 + 最多 3 次重试（后台刷新用，现场网络经代理时偶发卡住）；
     交互式请求（切区间那种）传 { tries: 1, timeout: 8000 }，别让人干等 36 秒 */
  async function getJSON(path, root, opt) {
    const o = opt || {};
    const tries = o.tries || 3, timeout = o.timeout || 12000;
    const url = (root === undefined ? API + '/solar/' : root) + path;
    let err = null;
    for (let i = 0; i < tries; i++) {
      const ctl = new AbortController();
      const to = setTimeout(function () { ctl.abort(); }, timeout);
      try {
        const r = await fetch(url, { cache: 'no-store', signal: ctl.signal });
        clearTimeout(to);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return await r.json();
      } catch (e) {
        clearTimeout(to);
        err = e;
        if (i < tries - 1) await new Promise(function (res) { setTimeout(res, 700); });
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
    /* 顶栏换成光伏自己的标签页 */
    const st = byId('solarTabs'), mt = byId('mainTabs');
    if (st) {
      st.style.display = '';
      [].forEach.call(st.querySelectorAll('button'), function (x) {
        x.classList.toggle('active', x.getAttribute('data-stab') === 'monitor');
      });
    }
    if (mt) mt.style.display = 'none';
    mountTab('monitor');
    refresh();
    setTimeout(ensureScene, 80);
    if (!timer) timer = setInterval(refresh, REFRESH_MS);
    setTimeout(function () {
      if (chart) chart.resize();
      if (window.SolarScene) { SolarScene.resize(); SolarScene.setActive(true); }
    }, 220);
  }
  function hide() {
    const v = byId('solarView');
    if (v) v.classList.add('hidden');
    document.body.classList.remove('solar-mode');
    /* 恢复储能站主体视图：进光伏站时被 open() 隐藏了，不恢复的话莒南的三维会"消失" */
    const m = byId('main');
    if (m) m.classList.remove('hidden');
    const st = byId('solarTabs'), mt = byId('mainTabs');
    if (st) st.style.display = 'none';
    if (mt) mt.style.display = '';
    if (window.SolarScene) SolarScene.setActive(false);
    if (timer) { clearInterval(timer); timer = null; }
    /* 储能三维在隐藏期间尺寸变为 0，重新显示后让它按新尺寸重排 */
    setTimeout(function () { try { window.dispatchEvent(new Event('resize')); } catch (_) {} }, 60);
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
      if (s && s.data) sum = s.data;
      const d = await getJSON('devices');
      if (d && d.data) devices = d.data;
      const t = await getJSON('trend?range=' + range);
      if (t && t.points) trend = t.points;
      renderTrend();                          /* 曲线先画出来：后面天气/日升那几路慢，别让图表陪着等 */
      try {                                   /* 天气失败不影响其余数据 */
        const w = await getJSON('weather');
        if (w && w.data) wx = w.data;
      } catch (_) {}
      try {                                   /* 储能服务没起来时，光伏照常显示 */
        const b = await getJSON('full', API_STOR + '/risen/');
        if (b && b.data) {
          stor = b.data;
          if (Array.isArray(b.data.devices)) storDevs = b.data.devices;
        }
        const st = await getJSON('trend?range=today', API_STOR + '/risen/');
        if (st && Array.isArray(st.points)) storTrend = st.points;
        const rt = await getJSON('revenue-trend?days=7', API_STOR + '/risen/');
        if (rt && Array.isArray(rt.points)) revTrend = rt.points;
        const pt = await getJSON('power-trend?days=7', API_STOR + '/risen/');
        if (pt && Array.isArray(pt.points)) powTrend = pt.points;
      } catch (_) {}
      render();
      if (src) src.textContent = sum ? ('阳光云接入 · 更新 ' + fmtTime(sum.updated_at)) : '服务未就绪';
    } catch (e) {
      /* 面向用户的提示用中文口径，原始错误（如 Failed to fetch）只放 title 供排查 */
      if (src) {
        src.textContent = sum ? '刷新失败（图上仍是上一次的数据）' : '读取失败：光伏数据暂时读不到（阳光云接入服务未就绪）';
        src.title = String((e && e.message) || e);
      }
    } finally { busyUntil = 0; }
  }

  /* ---------------- 渲染 ---------------- */
  /* KPI 卡片（沿用莒南站的 .kpi 版式，右栏 2 列、整页 6 列） */
  function card(label, value, unit, sub, cls) {
    return '<div class="kpi ' + (cls || '') + '">'
      + '<div class="kpi-body">'
      + '<div class="kpi-num' + (cls === 'hi' ? '' : ' sm') + '"><b>' + value + '</b>' + (unit ? '<u>' + unit + '</u>' : '') + '</div>'
      + '<div class="kpi-label">' + label + '</div>'
      + (sub ? '<div class="sl-ks">' + sub + '</div>' : '')
      + '</div></div>';
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
    const co2 = tKwh === null ? null : tKwh * CO2_PER_KWH / 1000;          // 吨
    const trees = co2 === null ? null : Math.round(co2 * 1000 * TREE_PER_KG);
    /* 收益分两块，各自标口径、不相加（避免重复计）：
       ① 日升云结算口径的今日收益（含储能 + 光伏，照搬厂家数字）
       ② 关口表今日馈电（卖给电网）按上网电价折算的估算 */
    const revToday = (stor && stor.revenue) ? num(stor.revenue.day) : null;
    const price = tariff();
    const feedToday = (stor && stor.grid) ? num(stor.grid.feed_today_kwh) : null;
    const sellToday = feedToday === null ? null : feedToday * price;

    box.innerHTML =
      card('实时功率', fmt(pKw, 2), 'kW', cap ? ('装机 ' + fmt(cap, 2) + ' kWp') : '', 'hi')
      + card('当日发电', fmt(dKwh, 1), '度', hours !== null ? ('等效 ' + fmt(hours, 2) + ' 小时') : '')
      + card('今日收益', fmt(revToday, 2), '元', '日升云结算 · 储能 + 光伏')
      + card('今日卖电（馈电上网）', fmt(sellToday, 2), '元', '关口表 ' + fmt(feedToday, 1) + ' 度 × <i id="slPrice" title="点击这里改上网电价">' + fmt(price, 2) + '</i> 元/度（点数字可改）· 估算')
      + card('累计发电', fmt(tKwh, 0), '度', sum.plant && sum.plant.install_date ? ('并网 ' + String(sum.plant.install_date).slice(0, 10)) : '')
      + card('装机容量', fmt(cap, 2), 'kWp', sum.plant ? (sum.plant.type || '分布式光伏') : '')
      + card('CO₂减排', fmt(co2, 2), '吨', trees !== null ? ('等效植树 ' + trees + ' 棵') : '');
    const priceEl = byId('slPrice');
    if (priceEl) priceEl.addEventListener('click', editTariff);
  }

  function editTariff() {
    const cur = String(tariff());
    const v = prompt('上网电价（元/度）：\n用于「今日卖电 / 今日买电」按关口表电量折算（估算，仅作参考）；\n储能 + 光伏的结算收益以日升云后台为准，不参与折算。', cur);
    if (v === null) return;
    const n = Number(v);
    if (!isFinite(n) || n <= 0) { alert('请输入大于 0 的数字'); return; }
    localStorage.setItem(LS_TARIFF, String(n));
    renderKpis();
    renderRevenuePage();      /* 详细信息页里那两格钱也按新电价重算 */
  }

  /* 只重拉当前区间的曲线：切「今日 / 昨日 / 近三日…」用。
     原来这里走的是 refresh()，等于把汇总、设备、天气、日升四个接口全串行重拉一遍，
     每个还带 12 秒超时 × 3 次重试；赶上后台刷新在跑还会被 busyUntil 直接吞掉 */
  async function loadTrend() {
    const meta = byId('slTrendMeta');
    if (meta) meta.textContent = '读取中…';
    try {
      const t = await getJSON('trend?range=' + range, undefined, { tries: 1, timeout: 8000 });
      if (t && t.points) trend = t.points;
      renderTrend();
    } catch (e) {
      if (meta) {
        meta.textContent = '读取失败（图上仍是上一次的数据）';
        meta.title = String((e && e.message) || e);
      }
    }
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
          ? (pts.length + ' 点 · 峰值 ' + fmt(max, 2) + ' kW' + (day ? (' · ' + (range === 'today' ? '当日累计 ' : '单日最高 ') + fmt(day, 1) + ' 度') : ''))
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

  /* 储能柜（东方日升「日升云」）：SOC / 状态 / 功率 / 充放电量 + 柜内子设备 */
  const KIND = {
    BCU: '电池簇', PCS: '储能变流器', EMS: '主控', HVAC: '空调',
    IN_METER: '内电表', EX_METER: '防逆流电表', PV_METER: '光伏电表', SIGNAL: '4G 信号',
    INVERTER: '光伏逆变器'
  };
  /* 柜内设备的品牌代号（日升云 ems/list 里的 type 字段） */
  const BRAND = { EJ: '恩玖', SYL: 'SYL', YWK: '英维克' };
  function renderStorage() {
    const box = byId('slBatt'), meta = byId('slBattMeta');
    if (!box) return;
    if (!stor) {
      if (meta) meta.textContent = '--';
      box.innerHTML = '<div class="sl-empty">储能数据暂时读不到（日升云接入服务未启动，或凭据过期需重新登录）。</div>';
      return;
    }
    const r = stor.realtime || {}, td = stor.today || {}, tt = stor.total || {}, dv = stor.device || {};
    const pc = stor.pcs || null, bt = stor.battery || null;
    if (meta) meta.textContent = '日升云 · 更新 ' + String(r.time || '--').slice(11, 16);
    const row = (k, v) => '<div class="sl-wx-row"><span>' + k + '</span><b>' + v + '</b></div>';
    const big = (label, v, u) => '<div class="sl-green-row"><b>' + v + '</b><u>' + u + '</u><span>' + label + '</span></div>';
    const arrRow = (label, arr, unit, d) => row(label, Array.isArray(arr) ? (arr.map(v => fmt(v, d)).join(' / ') + ' ' + unit) : '--');
    box.innerHTML =
      '<div class="sl-wx-top"><b>储能柜 · ' + (r.status_text || '--') + '</b><span>' + fmt(r.soc, 0) + '<u>%</u></span></div>'
      + row('实时功率', fmt(r.power_kw, 1) + ' kW')
      + row('剩余电量', fmt(r.remaining_kwh, 1) + ' / ' + fmt(r.rated_kwh, 0) + ' 度')
      + row('额定功率 / 效率', fmt(dv.rated_power_kw, 0) + ' kW　' + fmt(tt.efficiency, 2) + ' %')
      + row('电芯温度', fmt(r.temp_avg, 1) + ' ℃（高 ' + fmt(r.temp_max, 0) + ' / 低 ' + fmt(r.temp_min, 0) + '）')
      + row('电网 / 负载', fmt(r.grid_kw, 1) + ' / ' + fmt(r.load_kw, 1) + ' kW')
      + (pc ? arrRow('PCS 三相电压', pc.volt_v, 'V', 1) : '')
      + (pc ? arrRow('PCS 三相电流', pc.curr_a, 'A', 1) : '')
      + (pc ? row('PCS 频率 / 功率因数', fmt(pc.freq_hz, 2) + ' Hz　' + pfText(pc.power_factor)) : '')
      + (bt ? row('总压 / 总流', fmt(bt.voltage_v, 1) + ' V　' + fmt(bt.current_a, 1) + ' A') : '')
      + (bt ? row('单体电压 高 / 低', fmt(bt.cell_volt_max_mv, 0) + ' / ' + fmt(bt.cell_volt_min_mv, 0) + ' mV') : '')
      + '<div class="sl-green">'
      + big('今日充电', fmt(td.charge_kwh, 1), '度')
      + big('今日放电', fmt(td.discharge_kwh, 1), '度')
      + big('累计放电', fmt(tt.discharge_kwh, 0), '度')
      + '</div>'
      /* 右栏只给概览：逐台设备状态在「储能」页有完整列表，这里一行汇总，
         否则面板要 1000px 高、在 537px 的栏里得一直滚 */
      + (storDevs.length
        ? row('柜内设备', storDevs.filter(d => d.status === 'HEALTHY').length + ' / ' + storDevs.length + ' 台正常')
        : '');
  }

  /* ================= 整页版式（储能 / 光伏 / 收益） =================
     视觉沿用莒南「设备总览」那套卡片语言（ov-sec / gv3-* / dt-kv），
     数据来自日升云接入服务：/risen/full + /risen/trend + /risen/revenue-trend + /risen/power-trend */
  const kvRow = (k, v) => '<div class="gv3-kvrow"><span>' + k + '</span><b>' + v + '</b></div>';
  const kvGrid = rows => '<div class="gv3-skv">' + rows.map(r => kvRow(r[0], r[1])).join('') + '</div>';
  const gvKpi = (label, val, unit, tag, cls) =>
    '<div class="gv3-kpi' + (cls ? ' ' + cls : '') + '"><span class="gv3-klabel">' + label + '</span>'
    + '<b class="gv3-kval">' + val + '</b><u class="gv3-kunit">' + (unit || '') + '</u>'
    + (tag ? '<em class="gv3-ktag">' + tag + '</em>' : '') + '</div>';
  const gvTile = (label, val, unit, tag) =>
    '<div class="gv3-tile"><span class="gv3-tlabel">' + label + '</span>'
    + '<b class="gv3-tval">' + val + '</b><u>' + (unit || '') + '</u>'
    + (tag ? '<em class="gv3-ttag">' + tag + '</em>' : '') + '</div>';
  function sec(span, title, chip, body) {
    return '<section class="ov-sec gv3-sec ' + span + '"><div class="ov-sec-head"><b>' + title + '</b>'
      + (chip ? '<span class="ov-tagchip">' + chip + '</span>' : '')
      + '<i class="ov-online on"></i></div><div class="ov-sec-body gv3-body">' + body + '</div></section>';
  }
  function socRingHtml(soc) {
    const c = 2 * Math.PI * 40;
    const off = soc === null ? c : c * (1 - Math.max(0, Math.min(100, soc)) / 100);
    return '<div class="gv3-ring"><svg viewBox="0 0 96 96">'
      + '<circle class="rbg" cx="48" cy="48" r="40"/>'
      + '<circle class="rfg" cx="48" cy="48" r="40" style="stroke-dasharray:' + c.toFixed(1)
      + ';stroke-dashoffset:' + off.toFixed(1) + '"/></svg>'
      + '<b><span>' + (soc === null ? '--' : Math.round(soc)) + '</span><i>%</i></b>'
      + '<span class="gv3-ring-label">储能 SOC</span></div>';
  }
  /* 整页里的图表：innerHTML 重建后实例会指向旧的 DOM，这里保证对得上节点 */
  function ensureChart(cur, id) {
    const el = byId(id);
    if (!el || typeof echarts === 'undefined') return cur;
    if (cur && cur.getDom() === el) return cur;
    if (cur) { try { cur.dispose(); } catch (_) {} }
    return echarts.init(el);
  }
  const axisLabel = { fontSize: 10, hideOverlap: true };
  const splitLine = { lineStyle: { color: 'rgba(46,230,200,.08)', type: 'dashed' } };
  const chartTip = {
    trigger: 'axis', backgroundColor: 'rgba(6,18,20,.92)',
    borderColor: 'rgba(46,230,200,.35)', textStyle: { color: '#cfeee8', fontSize: 11 }
  };
  const chartLegend = { top: 0, right: 2, itemWidth: 10, itemHeight: 4, itemGap: 12, textStyle: { fontSize: 10 } };

  function deviceRowsHtml() {
    return '<div class="sl-devs">' + storDevs.map(function (d) {
      const ok = d.status === 'HEALTHY';
      const sub = (KIND[d.kind] || d.kind)
        + (d.brand ? ' · ' + (BRAND[d.brand] || d.brand) : '')
        + (d.version ? ' ' + String(d.version).slice(0, 12) : '');
      return '<div class="sl-dev"><div class="sl-devmain"><b>' + (d.name || d.kind) + '</b><span>' + sub + '</span></div>'
        + '<i class="sl-badge' + (ok ? '' : ' warn') + '">' + (d.status_text || '--') + '</i></div>';
    }).join('') + '</div>';
  }

  /* ---------------- 储能页 ---------------- */
  function renderStoragePage() {
    const view = byId('slStorView'), box = byId('slStorBody');
    if (!view || !box || view.classList.contains('hidden')) return;
    if (!stor) {
      box.innerHTML = '<div class="sl-empty">储能数据暂时读不到（日升云接入服务未启动，或凭据过期需重新登录）。</div>';
      return;
    }
    const r = stor.realtime || {}, td = stor.today || {}, tt = stor.total || {}, dv = stor.device || {};
    const pc = stor.pcs || null, bt = stor.battery || null, cool = bt && bt.cooler ? bt.cooler : null;
    const cls = r.status === 2 ? 'chg' : (r.status === 1 ? 'dischg' : '');

    const hero = sec('sp12', '储能总览',
      dv.bcu_brand || dv.pcs_brand ? ((dv.bcu_brand ? '电池 ' + (BRAND[dv.bcu_brand] || dv.bcu_brand) : '')
        + (dv.pcs_brand ? ' · PCS ' + (BRAND[dv.pcs_brand] || dv.pcs_brand) : '')) : '',
      '<div class="gv3-hero">' + socRingHtml(num(r.soc)) + '<div class="gv3-kpis">'
      + gvKpi('实时功率', fmt(r.power_kw, 1), 'kW', r.status_text || '', cls)
      + gvKpi('今日充电', fmt(td.charge_kwh, 1), '度')
      + gvKpi('今日放电', fmt(td.discharge_kwh, 1), '度')
      + gvKpi('转换效率', fmt(tt.efficiency, 2), '%', '累计')
      + gvKpi('剩余电量', fmt(r.remaining_kwh, 1), 'kWh', '/ ' + fmt(r.rated_kwh, 0) + ' kWh')
      + gvKpi('额定功率', fmt(dv.rated_power_kw, 0), 'kW')
      + gvKpi('累计充电', fmt(tt.charge_kwh, 0), '度')
      + gvKpi('累计放电', fmt(tt.discharge_kwh, 0), '度')
      + '</div></div>');

    const bcu = bt ? kvGrid([
      ['SOC / SOH', fmt(bt.soc, 0) + ' % / ' + fmt(bt.soh, 0) + ' %'],
      ['SOE', fmt(bt.soe, 0) + ' %'],
      ['簇总压', fmt(bt.voltage_v, 1) + ' V'],
      ['簇总流', fmt(bt.current_a, 1) + ' A'],
      ['剩余容量', fmt(bt.remaining_kwh, 1) + ' kWh'],
      ['可充容量', fmt(bt.rechargeable_kwh, 1) + ' kWh'],
      ['单体均压', fmt(bt.cell_volt_avg_mv, 0) + ' mV'],
      ['单体压差', (num(bt.cell_volt_max_mv) !== null && num(bt.cell_volt_min_mv) !== null)
        ? (num(bt.cell_volt_max_mv) - num(bt.cell_volt_min_mv)) + ' mV' : '--'],
      ['最高单体', fmt(bt.cell_volt_max_mv, 0) + ' mV ' + (bt.cell_volt_max_id || '')],
      ['最低单体', fmt(bt.cell_volt_min_mv, 0) + ' mV ' + (bt.cell_volt_min_id || '')],
      ['平均温度', fmt(bt.cell_temp_avg, 0) + ' ℃'],
      ['最高温度', fmt(bt.cell_temp_max, 0) + ' ℃ ' + (bt.cell_temp_max_id || '')],
      ['最低温度', fmt(bt.cell_temp_min, 0) + ' ℃ ' + (bt.cell_temp_min_id || '')],
      ['采样时间', String(bt.time || '--').slice(11, 19)]
    ]) : '<div class="gv3-empty">暂无电池簇数据</div>';

    const pcs = pc ? ('<div class="gv3-flow">'
      + gvTile('有功功率', fmt(pc.power_kw, 1), 'kW', pc.work_status || '')
      + gvTile('无功功率', fmt(pc.reactive_kvar, 1), 'kVar')
      + gvTile('视在功率', fmt(pc.apparent_kva, 1), 'kVA')
      + gvTile('电网频率', fmt(pc.freq_hz, 2), 'Hz')
      + gvTile('功率因数', pfText(pc.power_factor), '')
      + '</div>' + kvGrid([
        ['三相电压', Array.isArray(pc.volt_v) ? pc.volt_v.map(v => fmt(v, 1)).join(' / ') + ' V' : '--'],
        ['三相电流', Array.isArray(pc.curr_a) ? pc.curr_a.map(v => fmt(v, 1)).join(' / ') + ' A' : '--'],
        ['环境温度', fmt(pc.ambient_c, 1) + ' ℃'],
        ['IGBT 温度', fmt(pc.igbt_a_c, 1) + ' ℃'],
        ['采样时间', String(pc.time || '--').slice(11, 19)]
      ])) : '<div class="gv3-empty">暂无 PCS 数据</div>';

    const aux = cool ? ('<div class="gv3-auxcard"><div class="gv3-ahead">液冷机组</div>'
      + '<div class="gv3-atemp"><div><span>进水</span><b>' + fmt(cool.inlet_water_c, 1) + '</b><u>℃</u></div>'
      + '<span class="arrow">→</span>'
      + '<div><span>出水</span><b>' + fmt(cool.outlet_water_c, 1) + '</b><u>℃</u></div></div>'
      + kvGrid([
        ['进水压力', fmt(cool.inlet_pressure, 2) + ' MPa'],
        ['出水压力', fmt(cool.outlet_pressure, 2) + ' MPa'],
        ['制冷 / 加热点', fmt(cool.cooling_point, 0) + ' / ' + fmt(cool.heating_point, 0) + ' ℃'],
        ['环境温度', fmt(cool.ambient_c, 1) + ' ℃'],
        ['机组状态', num(cool.fault_flag) ? '<span class="dt-alarm">有告警</span>' : '<span class="dt-ok">正常</span>'],
        ['采样时间', String(cool.time || '--').slice(11, 19)]
      ]) + '</div>') : '<div class="gv3-empty">暂无液冷数据</div>';

    const comp = Array.isArray(stor.complete) ? stor.complete : null;
    const compHtml = comp ? ('<div class="gv3-ahead" style="margin-top:10px">数据补传（待补条数）</div><div class="gv3-mgrid">'
      + comp.map(c => '<div class="gv3-mitem"><span>' + c.name + '</span><b class="'
        + (c.code ? 'warn' : '') + '">' + (c.code || 0) + '</b></div>').join('') + '</div>') : '';
    const devs = storDevs.length
      ? (deviceRowsHtml() + compHtml)
      : '<div class="gv3-empty">暂无子设备数据</div>';

    box.innerHTML = '<div class="dt-body">' + hero + '<div class="ov-grid">'
      + sec('sp6', '电池堆 / 电池簇', dv.bcu_brand || 'SYL', bcu)
      + sec('sp6', 'PCS 交流侧', dv.pcs_brand ? (BRAND[dv.pcs_brand] || dv.pcs_brand) : 'PCS', pcs)
      + sec('sp12', '功率与 SOC（今日 · 5 分钟）',
        (storTrend && storTrend.length ? storTrend.length + ' 点' : '--'), '<div class="dt-chart" id="slStorChart"></div>')
      + sec('sp6', '液冷空调', 'YWK', aux)
      + sec('sp6', '柜内子设备', storDevs.length + ' 台', devs)
      + '</div></div>';

    storChart = ensureChart(storChart, 'slStorChart');
    if (storChart) {
      const pts = (storTrend || []).filter(p => num(p.power_kw) !== null || num(p.soc) !== null);
      storChart.setOption({
        grid: { left: 52, right: 48, top: 30, bottom: 24 },
        legend: Object.assign({}, chartLegend, { data: ['储能功率', 'SOC'] }),
        tooltip: chartTip,
        xAxis: { type: 'time', axisLabel: axisLabel, axisLine: { lineStyle: { color: 'rgba(46,230,200,.25)' } }, axisTick: { show: false } },
        yAxis: [
          { type: 'value', name: 'kW', nameTextStyle: { fontSize: 10 }, axisLabel: { fontSize: 10 }, splitLine: splitLine },
          { type: 'value', name: 'SOC %', min: 0, max: 100, nameTextStyle: { fontSize: 10 }, axisLabel: { fontSize: 10 }, splitLine: { show: false } }
        ],
        series: [
          { name: '储能功率', type: 'line', smooth: true, symbol: 'none', yAxisIndex: 0, lineStyle: { width: 2, color: '#ffb020' }, data: pts.map(p => [p.t, num(p.power_kw)]) },
          { name: 'SOC', type: 'line', smooth: true, symbol: 'none', yAxisIndex: 1, lineStyle: { width: 1.6, color: '#3df0a0' }, data: pts.map(p => [p.t, num(p.soc)]) }
        ]
      }, false, true);
    }
  }

  /* ---------------- 收益页 ----------------
     两家云平台的账不能混着算，这里分块、各自标注来源：
       · 日升云：结算口径的收益（元）+ 减排（厂家自己的算法）
       · 阳光云：光伏发电量（度）；收益只做"按电价估算"，单独一行标明是估算 */
  function renderRevenuePage() {
    const view = byId('slRevView'), box = byId('slRevBody');
    if (!view || !box || view.classList.contains('hidden')) return;
    const rev = (stor && stor.revenue) || {};
    const td = (stor && stor.today) || {};
    const tt = (stor && stor.total) || {};
    const price = tariff();
    const pvToday = sum ? kwh(sum.daily_yield) : null;      /* 度 */
    const pvTotal = sum ? kwh(sum.total_yield) : null;      /* 度 */
    const cap = sum ? num(sum.capacity) : null;
    const pvPower = sum ? (num(sum.power) === null ? null : num(sum.power) / 1000) : null;
    const hours = (pvToday !== null && cap) ? pvToday / cap : (sum ? num(sum.daily_hours) : null);

    /* 日升云结算口径 */
    const risenTiles = '<div class="gv3-flow">'
      + gvTile('今日收益', fmt(rev.day, 2), '元', '储能 + 光伏')
      + gvTile('累计收益', fmt(rev.total, 2), '元', '日升云')
      + gvTile('储能累计收益', fmt(rev.storage, 2), '元', '累计放电 ' + fmt(tt.discharge_kwh, 0) + ' 度')
      + gvTile('光伏累计收益', fmt(rev.solar, 2), '元', '日升云')
      + gvTile('储能度电收益', fmt(rev.per_kwh, 2), '元/度', '日升云')
      + '</div>';

    /* 上网与购电：本站储能会往电网卖电，这几格才是"卖电"的账。
       电量照搬关口表；"折算成钱"的那两格按上网电价估算，单独标注估算、不与厂家结算相加（避免重复计） */
    const g = (stor && stor.grid) || {};
    const feedToday = num(g.feed_today_kwh), drawToday = num(g.draw_today_kwh);
    const gridTiles = '<div class="gv3-flow">'
      + gvTile('今日馈电（卖电）', fmt(g.feed_today_kwh, 1), '度', '关口表 · 送出')
      + gvTile('今日卖电收入', fmt(feedToday === null ? null : feedToday * price, 2), '元', '馈电 × <i class="sl-price" title="点击修改上网电价">' + fmt(price, 2) + '</i> 元/度 · 估算')
      + gvTile('累计馈电（卖电）', fmt(g.feed_total_kwh, 0), '度', '关口表')
      + gvTile('今日取电（买电）', fmt(g.draw_today_kwh, 1), '度', '关口表 · 受入')
      + gvTile('今日买电支出', fmt(drawToday === null ? null : drawToday * price, 2), '元', '取电 × <i class="sl-price" title="点击修改上网电价">' + fmt(price, 2) + '</i> 元/度 · 估算')
      + gvTile('累计取电（买电）', fmt(g.draw_total_kwh, 0), '度', '关口表')
      + gvTile('今日储能充 / 放', fmt(td.charge_kwh, 1) + ' / ' + fmt(td.discharge_kwh, 1), '度', '日升云')
      + gvTile('今日光伏发电', fmt(pvToday, 1), '度', '阳光云')
      + '</div>';

    /* 阳光云：只报发电量（钱由日升云结算，这里不再自己折算） */
    const pvTiles = '<div class="gv3-flow">'
      + gvTile('实时功率', fmt(pvPower, 2), 'kW', '阳光云')
      + gvTile('今日发电', fmt(pvToday, 1), '度', '阳光云')
      + gvTile('累计发电', fmt(pvTotal, 0), '度', '阳光云')
      + gvTile('今日等效小时', fmt(hours, 2), 'h', '阳光云')
      + '</div>';

    const green = kvGrid([
      ['CO₂ 减排', fmt(rev.reduce_carbon_t, 2) + ' 吨'],
      ['节约标准煤', fmt(rev.coal_t, 2) + ' 吨'],
      ['等效植树', fmt(rev.trees, 0) + ' 棵'],
      ['口径', '日升云累计']
    ]);

    const d0 = new Date(), p2 = n => String(n).padStart(2, '0');
    const todayStr = d0.getFullYear() + '-' + p2(d0.getMonth() + 1) + '-' + p2(d0.getDate());
    const xLabel = dt => (dt === todayStr ? '今天' : String(dt || '').slice(5));

    box.innerHTML = '<div class="dt-body">'
      + sec('sp12', '结算收益', '日升云结算口径', risenTiles)
      + sec('sp12', '上网与购电', '日升云关口表口径', gridTiles)
      + '<div class="ov-grid">'
      + sec('sp8', '近 7 日收益（储能 / 光伏 / 合计）',
        (revTrend && revTrend.length ? revTrend.length + ' 天 + 今天 · 日升云' : '--'), '<div class="dt-chart" id="slRevChart"></div>')
      + sec('sp4', '减排贡献', '日升云', green)
      + sec('sp6', '光伏发电', '阳光云口径', pvTiles)
      + sec('sp6', '近 7 日充放电量与效率',
        (powTrend && powTrend.length ? powTrend.length + ' 天 + 今天 · 日升云' : '--'), '<div class="dt-chart" id="slPowChart"></div>')
      + '</div></div>';

    /* 电价就地可改：点卖电/买电那两格里的价格数字，改完存本地、页面立即重算 */
    [].forEach.call(box.querySelectorAll('.sl-price'), function (el) { el.addEventListener('click', editTariff); });

    revChart = ensureChart(revChart, 'slRevChart');
    if (revChart) {
      const pts = (revTrend || []).slice();
      /* 厂家的日曲线不含当天，这里把今天的合计补上（柱状拆分拿不到，只补折线点） */
      if (num(rev.day) !== null && (!pts.length || pts[pts.length - 1].date !== todayStr)) {
        pts.push({ date: todayStr, storage: null, solar: null, total: num(rev.day) });
      }
      revChart.setOption({
        grid: { left: 56, right: 20, top: 30, bottom: 24 },
        legend: Object.assign({}, chartLegend, { data: ['储能收益', '光伏收益', '合计'] }),
        tooltip: chartTip,
        xAxis: { type: 'category', data: pts.map(p => xLabel(p.date)), axisLabel: axisLabel, axisLine: { lineStyle: { color: 'rgba(46,230,200,.25)' } } },
        yAxis: { type: 'value', name: '元', nameTextStyle: { fontSize: 10 }, axisLabel: { fontSize: 10 }, splitLine: splitLine },
        series: [
          { name: '储能收益', type: 'bar', stack: 'r', barMaxWidth: 22, itemStyle: { color: 'rgba(46,230,200,.75)' }, data: pts.map(p => num(p.storage)) },
          { name: '光伏收益', type: 'bar', stack: 'r', barMaxWidth: 22, itemStyle: { color: 'rgba(255,176,32,.7)' }, data: pts.map(p => num(p.solar)) },
          { name: '合计', type: 'line', smooth: true, symbolSize: 6, lineStyle: { width: 2, color: '#8fd8ff' }, data: pts.map(p => num(p.total)) }
        ]
      }, false, true);
    }

    powChart = ensureChart(powChart, 'slPowChart');
    if (powChart) {
      const pts = (powTrend || []).slice();
      /* 同样补上今天（充放电量取实时口今日累计） */
      if ((num(td.charge_kwh) !== null || num(td.discharge_kwh) !== null) &&
        (!pts.length || pts[pts.length - 1].date !== todayStr)) {
        pts.push({ date: todayStr, charge: num(td.charge_kwh), discharge: num(td.discharge_kwh), efficiency: null });
      }
      powChart.setOption({
        grid: { left: 56, right: 48, top: 30, bottom: 24 },
        legend: Object.assign({}, chartLegend, { data: ['充电量', '放电量', '效率'] }),
        tooltip: chartTip,
        xAxis: { type: 'category', data: pts.map(p => xLabel(p.date)), axisLabel: axisLabel, axisLine: { lineStyle: { color: 'rgba(46,230,200,.25)' } } },
        yAxis: [
          { type: 'value', name: '度', nameTextStyle: { fontSize: 10 }, axisLabel: { fontSize: 10 }, splitLine: splitLine },
          { type: 'value', name: '%', nameTextStyle: { fontSize: 10 }, axisLabel: { fontSize: 10 }, splitLine: { show: false } }
        ],
        series: [
          { name: '充电量', type: 'bar', barMaxWidth: 20, itemStyle: { color: 'rgba(143,216,255,.75)' }, data: pts.map(p => num(p.charge)) },
          { name: '放电量', type: 'bar', barMaxWidth: 20, itemStyle: { color: 'rgba(46,230,200,.8)' }, data: pts.map(p => num(p.discharge)) },
          { name: '效率', type: 'line', yAxisIndex: 1, smooth: true, symbolSize: 6, lineStyle: { width: 2, color: '#ffb020' }, data: pts.map(p => num(p.efficiency)) }
        ]
      }, false, true);
    }
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
    if (!window.SolarScene) return;
    /* 电站数据没拿到时传 null（不是 0）：场景那边要区分"真的 0 kW"和"没上报"——
       供电模式靠这个判，传 0 会被当成"光伏不发电"，直接把模式判成③/④。
       汇总拿到了、但实时功率那一点缺失（power = null）同样算"没上报"：
       原来写成 (num(sum.power) || 0) 会把这一档折成 0，模式跟着判成③/④ */
    const pvRaw = sum ? num(sum.power) : null;
    SolarScene.setPower(pvRaw === null ? null : pvRaw / 1000,
      sum ? num(sum.capacity) : null, sum ? kwh(sum.daily_yield) : null);
    if (stor) SolarScene.setStorage(stor);       /* 储能柜：SOC 光柱、充放电光纹、卖电方向 */
    if (wx) SolarScene.setWeather(wx);
    /* 同一份天气也给旭日东明（两地同源，各打各的场景效果；旭日东明不展示天气数据） */
    if (wx && window.GaoteWeather) { try { GaoteWeather(wx); } catch (_) {} }
  }

  function ensureScene() {
    if (!window.SolarScene || !byId('solar3d')) return;
    SolarScene.init(function () { pushScene(); });
    setTimeout(function () { if (window.SolarScene) SolarScene.resize(); }, 120);
  }

  /* ---------------- 四个标签页：电站监控 / 储能 / 光伏 / 详细信息 ----------------
     电站监控用右侧滑出面板；另外三页是整页；光伏页里的卡片是从 #slBlocks 移过去的 */
  let tab = 'monitor';
  const PAGES = { storage: 'slStorView', solar: 'slSolarView', revenue: 'slRevView' };
  function mountTab(which) {
    tab = which || tab;
    Object.keys(PAGES).forEach(function (k) {
      const v = byId(PAGES[k]);
      if (v) v.classList.toggle('hidden', tab !== k);
    });
    const conf = {
      monitor: ['slPanel', ['slBattBlock']],
      solar: ['slSolarBody', ['slKpisBlock', 'slTrendBlock', 'slWxBlock', 'slDevBlock', 'slGreenBlock', 'slInfoBlock']]
    }[tab];
    if (conf) {
      const host = byId(conf[0]);
      if (host) conf[1].forEach(function (id) { const el = byId(id); if (el) host.appendChild(el); });
    }
    const page = !!PAGES[tab];
    const L = byId('slLeft'); if (L) L.style.display = page ? 'none' : '';
    const R = byId('slRight'); if (R) R.style.display = page ? 'none' : '';
    /* 数据页显示页头条（刷新 / 返回站点目录），三维页隐藏 */
    const sv = byId('solarView'); if (sv) sv.classList.toggle('page-mode', page);
    const pt = byId('slPageTitle');
    if (pt) pt.textContent = ({ storage: '储能 · 电池簇 / PCS / 液冷', solar: '光伏 · 发电与设备', revenue: '详细信息 · 结算与收益' })[tab] || '';
    if (!page) setTimeout(ensureScene, 60);
    if (tab === 'storage') renderStoragePage();
    if (tab === 'revenue') renderRevenuePage();
    setTimeout(function () {
      [chart, storChart, revChart, powChart].forEach(function (c) { if (c) c.resize(); });
      if (window.SolarScene) SolarScene.resize();
    }, 90);
  }

  function render() {
    renderKpis(); renderTrend(); renderDevices(); renderInfo(); renderGreen();
    renderWeather(); renderAlarm(); renderStorage(); pushScene();
    renderStoragePage(); renderRevenuePage();
  }

  function renderAlarm() {
    const bar = byId('slAlarmBar'), txt = byId('slAlarmText');
    /* 电站名称芯片：显示平台站名（阳光云厂家站名只代表数据来源，不覆盖平台命名） */
    const station = byId('slStation');
    if (station) station.textContent = '洙边卫生院光储电站';
    if (!txt) return;
    const parts = [];
    if (wx) {
      parts.push(wx.text + ' ' + fmt(num(wx.temp), 1) + '℃'
        + (num(wx.wind) === null ? '' : '　风速 ' + fmt(num(wx.wind), 1) + ' m/s')
        + (num(wx.radiation) === null ? '' : '　辐照 ' + fmt(num(wx.radiation), 0) + ' W/㎡'));
    } else parts.push('天气读取中…');
    const alarms = sum ? num(sum.alarms) : null;
    parts.push(alarms ? ('告警 ' + alarms + ' 条') : '无告警');
    txt.textContent = parts.join('　·　');
    if (bar) bar.className = 'alarm ' + (alarms ? 'bad' : 'ok');
  }

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
        loadTrend();                 /* 只重拉这条曲线，不走整串刷新 */
      });
    }
    /* 光伏站自己的顶栏标签页 */
    const stabs = byId('solarTabs');
    if (stabs) {
      stabs.addEventListener('click', function (e) {
        const btn = e.target.closest('button[data-stab]');
        if (!btn) return;
        [].forEach.call(stabs.querySelectorAll('button'), function (x) { x.classList.toggle('active', x === btn); });
        mountTab(btn.getAttribute('data-stab'));
      });
    }
    /* 三维视图控制：标签 / 旋转 / 重置视角 */
    const bl = byId('slBtnLabels');
    if (bl) {
      bl.classList.add('active');
      bl.addEventListener('click', function () {
        const on = bl.classList.toggle('active');
        if (window.SolarScene) SolarScene.setLabels(on);
      });
    }
    const br = byId('slBtnRotate');
    if (br) br.addEventListener('click', function () {
      const on = br.classList.toggle('active');
      if (window.SolarScene) SolarScene.setRotate(on);
    });
    const bs = byId('slBtnReset');
    if (bs) bs.addEventListener('click', function () { if (window.SolarScene) SolarScene.resetView(); });
    /* 右栏滑出/收起时重算图表尺寸（否则宽度变了没重画，会和下面的板块叠在一起） */
    const right = byId('slRight');
    if (right) {
      right.addEventListener('mouseenter', function () {
        setTimeout(function () { if (chart) chart.resize(); }, 320);
      });
      right.addEventListener('transitionend', function () { if (chart) chart.resize(); });
    }
    /* 主题切换时重画坐标轴颜色 */
    new MutationObserver(function () {
      setTimeout(function () {
        applyTheme(); if (chart) chart.resize();
      }, 60);
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    window.addEventListener('resize', function () { if (chart) chart.resize(); });
  }

  return { init, open, hide, refresh, isOpen: function () { return byId('solarView') && !byId('solarView').classList.contains('hidden'); } };
})();
