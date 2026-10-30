/* ============================================================
 * 山东峻涌光储电站 · 页面与数据层
 *
 *   门户「山东峻涌光储电站」卡片 → JunyongUI.open() → 独立视图 #jyView
 *   页签：电站监控（三维）/ 储能 / 光伏 / 详细信息（与洙边站同一套版式）
 *
 *   数据源：
 *     光伏（已接入 · 2026-10-29）：阳光云 iSolarCloud「第二路」——
 *       本站的逆变器在**另一个阳光云账号**里（力储峻涌光伏电站 · ps_id 2377236），
 *       走的是同一个应用的独立授权 + 独立 HTTP 服务：
 *       nginx /junyong/pv/ → 127.0.0.1:8098（见 tools/deploy-solar-junyong.js）。
 *       接口与洙边那路同形：GET summary / devices / trend?range=… / weather
 *     储能（未接入）：协议待与厂家确认；未接入时相关字段一律显示 --，不编数。
 *
 *   口径：阳光云只报**全站**发电（972.4 kWp / 8 台逆变器 820 kW）；
 *   分「机组」的逆变器分组待现场确认，确认前机组表里的光伏列显示 --。
 *   光伏 null ≠ 0（没上报 ≠ 0 kW）。
 *
 *   红线：页面上不许出现任何模拟数据。取不到就 --，并在数据源条上写明。
 * ============================================================ */
window.JunyongUI = (function () {
  'use strict';

  var byId = function (id) { return document.getElementById(id); };
  var CFG = {
    pvApi: '/junyong/pv/',            /* 阳光云第二路（峻涌账号） */
    storApi: '/junyong/storage/',     /* 待接入：储能数据源地址 */
    refreshMs: 60000
  };
  var STATION = {
    name: '山东峻涌光储电站',
    pvKwp: '972.4kWp', pvInv: '820kW',
    pvNote: '8 台阳光电源逆变器（2×110kW + 6×100kW）',
    stor: '625kW / 1305kWh',
    inv: '阳光电源逆变器',
    groups: ['一号机组 · 1 台光储一体柜', '二号机组 · 1 台光储一体柜', '三号机组 · 3 台光储一体柜'],
    grid: '三群各自关口，共用一座中心铁塔并网；自发自用、余电上网'
  };
  var GN = ['一号机组', '二号机组', '三号机组'];
  /* 减排折算（与阳光云页面同一口径）：kg CO₂/kWh、kg 标准煤/kWh、每棵树年吸收 kg CO₂ */
  var CO2_PER_KWH = 0.997, COAL_PER_KWH = 0.404, TREE_PER_KG = 1 / 18.3;
  var timer = null, busyUntil = 0, tab = 'monitor';
  /* ?jtab=storage|solar|revenue 直达某个数据页（对图 / 值班快捷入口，界面上不加控件）。
     这里在模块加载时就读：门户的 ?station= 深链会比 init() 更早打开本页 */
  try {
    var QTAB = new URLSearchParams(location.search).get('jtab');
    if (QTAB) tab = QTAB;
  } catch (_) {}
  var payload = null;            /* 整理后的最近一次成功数据：{ station: {...} }；null = 从没拿到过 */
  var lastErr = '';
  var wx = null, devices = [], trend = [], trendRange = 'today';
  var chart = null;

  function n(v) { return (v === null || v === undefined || v === '' || isNaN(+v)) ? null : +v; }
  function fmt(v, dec) {
    var x = n(v);
    if (x === null) return '--';
    return x.toLocaleString('zh-CN', { minimumFractionDigits: dec === undefined ? 1 : dec, maximumFractionDigits: dec === undefined ? 1 : dec });
  }
  function fmtU(v, unit, dec) { return n(v) === null ? ('--' + (unit || '')) : (fmt(v, dec) + (unit || '')); }
  function kwh(v) { var x = n(v); return x === null ? null : x / 1000; }
  function fmtTime(iso) {
    if (!iso) return '--';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '--';
    var p = function (x) { return String(x).padStart(2, '0'); };
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  /* 阳光云设备数据时间：14 位 YYYYMMDDhhmmss */
  function fmtDevTime(s) {
    s = String(s || '');
    if (!/^\d{14}$/.test(s)) return fmtTime(s);
    return s.slice(4, 6) + '-' + s.slice(6, 8) + ' ' + s.slice(8, 10) + ':' + s.slice(10, 12) + ':' + s.slice(12, 14);
  }
  function isDay() { return document.documentElement.getAttribute('data-theme') === 'day'; }
  function kpi(label, value, sub, cls) {
    return '<div class="kpi' + (cls ? ' ' + cls : '') + '"><span>' + label + '</span>'
      + '<b>' + value + '</b>' + (sub ? '<em>' + sub + '</em>' : '') + '</div>';
  }
  var kvRow = function (k, v) { return '<div class="gv3-kvrow"><span>' + k + '</span><b>' + v + '</b></div>'; };
  var gvTile = function (label, val, unit, tag) {
    return '<div class="gv3-tile"><span class="gv3-tlabel">' + label + '</span>'
      + '<b class="gv3-tval">' + val + '</b><u>' + (unit || '') + '</u>'
      + (tag ? '<em class="gv3-ttag">' + tag + '</em>' : '') + '</div>';
  };
  function sec(span, title, chip, body) {
    return '<section class="ov-sec gv3-sec ' + span + '"><div class="ov-sec-head"><b>' + title + '</b>'
      + (chip ? '<span class="ov-tagchip">' + chip + '</span>' : '')
      + '<i class="ov-online on"></i></div><div class="ov-sec-body gv3-body">' + body + '</div></section>';
  }
  function row(k, v) {
    return '<tr><td style="color:var(--dim)">' + k + '</td><td>' + v + '</td></tr>';
  }

  /* 取接口数据：12 秒超时 + 最多 3 次重试（现场网络经代理时偶发卡住）；
     交互式请求（切区间那种）传 { tries: 1, timeout: 8000 } */
  function getJSON(path, opt) {
    var o = opt || {};
    var tries = o.tries || 3, timeout = o.timeout || 12000;
    var url = CFG.pvApi + path;
    function attempt(i) {
      return new Promise(function (resolve, reject) {
        var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var to = ctl ? setTimeout(function () { ctl.abort(); }, timeout) : null;
        fetch(url, { cache: 'no-store', signal: ctl ? ctl.signal : undefined })
          .then(function (r) { if (to) clearTimeout(to); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
          .then(resolve)
          .catch(function (e) {
            if (to) clearTimeout(to);
            if (i < tries - 1) setTimeout(function () { attempt(i + 1).then(resolve, reject); }, 700);
            else reject(e);
          });
      });
    }
    return attempt(0);
  }

  /* ---------------- 视图切换 ---------------- */
  function hideOthers() {
    ['main', 'overviewView', 'gaoteView', 'detailView', 'tabView'].forEach(function (id) {
      var e = byId(id); if (e) e.classList.add('hidden');
    });
    var sv = byId('solarView'); if (sv) sv.classList.add('hidden');
    document.body.classList.remove('solar-mode');
    if (window.SolarScene) SolarScene.setActive(false);
    if (window.GaoteView) GaoteView.hide();
    if (window.GaoteDetail) GaoteDetail.hide();
  }
  function open() {
    hideOthers();
    var v = byId('jyView');
    if (v) v.classList.remove('hidden');
    document.body.classList.add('jy-mode');
    var jt = byId('jyTabs'), mt = byId('mainTabs'), st = byId('solarTabs');
    if (jt) {
      jt.style.display = '';
      [].forEach.call(jt.querySelectorAll('button'), function (x) {
        x.classList.toggle('active', x.getAttribute('data-jtab') === tab);
      });
    }
    if (mt) mt.style.display = 'none';
    if (st) st.style.display = 'none';
    mount(tab);
    refresh();
    setTimeout(ensureScene, 80);
    if (!timer) timer = setInterval(refresh, CFG.refreshMs);
    setTimeout(function () { if (window.JunyongScene) { JunyongScene.resize(); JunyongScene.setActive(true); } }, 220);
  }
  function hide() {
    var v = byId('jyView');
    if (v) v.classList.add('hidden');
    document.body.classList.remove('jy-mode');
    var m = byId('main'); if (m) m.classList.remove('hidden');
    var jt = byId('jyTabs'); if (jt) jt.style.display = 'none';
    var mt = byId('mainTabs'); if (mt) mt.style.display = '';
    if (window.JunyongScene) JunyongScene.setActive(false);
    if (timer) { clearInterval(timer); timer = null; }
    setTimeout(function () { try { window.dispatchEvent(new Event('resize')); } catch (_) {} }, 60);
  }
  function ensureScene() {
    if (!window.JunyongScene) return;
    if (!JunyongScene.ready()) {
      JunyongScene.init(function () { pushScene(); });
    } else {
      JunyongScene.setActive(true); JunyongScene.resize(); pushScene();
    }
  }
  function mount(t) {
    tab = t;
    ['jyStorView', 'jySolarView', 'jyInfoView'].forEach(function (id) {
      var e = byId(id); if (e) e.classList.add('hidden');
    });
    var left = byId('jyLeft');
    var map = { monitor: null, storage: 'jyStorView', solar: 'jySolarView', revenue: 'jyInfoView' };
    var which = map[t];
    if (left) left.classList.toggle('hidden', !!which);
    var side = byId('jyRight');
    if (side) side.classList.toggle('hidden', !!which);
    if (which) { var e2 = byId(which); if (e2) e2.classList.remove('hidden'); }
    var view = byId('jyView');
    if (view) view.classList.toggle('page-mode', !!which);
    var title = byId('jyPageTitle');
    if (title) title.textContent = t === 'monitor' ? '' :
      (t === 'storage' ? '储能' : t === 'solar' ? '光伏' : '详细信息');
    render();
    if (window.JunyongScene) JunyongScene.setActive(t === 'monitor');
    /* 曲线在隐藏容器里初始化时尺寸是 0，切过来后要重算一次 */
    setTimeout(function () { if (chart && t === 'solar') chart.resize(); }, 80);
  }

  /* ---------------- 数据 ---------------- */
  function build(d) {
    var cap = n(d.capacity);
    var today = kwh(d.daily_yield), total = kwh(d.total_yield);
    var pl = d.plant || {};
    var hours = (today !== null && cap) ? Math.round(today / cap * 100) / 100 : n(d.daily_hours);
    return {
      station: {
        ps_id: d.ps_id,
        cloud_name: pl.name || '',
        type: pl.type || '分布式光伏',
        capacity: cap,
        location: d.location || pl.location || '',
        install_date: pl.install_date,
        online: d.online,
        alarms: n(d.alarms),
        power_kw: n(d.power) === null ? null : n(d.power) / 1000,
        today_kwh: today,
        total_kwh: total,
        hours: hours,
        ambient_temp: n(d.ambient_temp),
        module_temp: n(d.module_temp),
        radiation: n(d.radiation),
        daily_irradiation: n(d.daily_irradiation),
        device_power_kw: n(d.device_power_kw),
        device_today_kwh: n(d.device_today_kwh),
        data_time: d.data_time || null,
        updated_at: d.updated_at
      }
    };
  }
  function refresh() {
    if (Date.now() < busyUntil) return;
    busyUntil = Date.now() + 60000;
    var src = byId('jySrc');
    if (src) src.textContent = '正在读取…';
    /* 串行拉：现场网络经代理时并发连接容易被挂住（与洙边同一套做法）；
       光伏拿不到时保留上一次成功的数据，只在数据源条上提示 */
    getJSON('summary').then(function (s) {
      if (!s || !s.data) throw new Error('summary 为空');
      payload = build(s.data);
      lastErr = s.last_error ? String(s.last_error) : '';
      return getJSON('trend?range=' + trendRange, { tries: 1, timeout: 8000 })
        .then(function (t) { if (t && t.points) trend = t.points; }).catch(function () {});
    }).then(function () {
      return getJSON('weather', { tries: 1, timeout: 8000 })
        .then(function (w) { if (w && w.data) wx = w.data; }).catch(function () {});
    }).then(function () {
      return getJSON('devices', { tries: 1, timeout: 8000 })
        .then(function (d) { if (d && d.data) devices = d.data; }).catch(function () {});
    }).catch(function (e) {
      lastErr = String((e && e.message) || e || '读取失败');
    }).then(function () {
      busyUntil = 0;
      render();
    });
  }
  /* 只重拉曲线（切区间用） */
  function loadTrend() {
    var meta = byId('jyTrendMeta');
    if (meta) meta.textContent = '读取中…';
    getJSON('trend?range=' + trendRange, { tries: 1, timeout: 8000 }).then(function (t) {
      if (t && t.points) trend = t.points;
      renderTrendChart();
    }).catch(function (e) {
      if (meta) { meta.textContent = '读取失败（图上仍是上一次的数据）'; meta.title = String((e && e.message) || e); }
    });
  }

  function st() { return (payload && payload.station) || {}; }
  function srcTag() {
    if (payload) {
      var t = st().data_time ? fmtDevTime(st().data_time) : fmtTime(st().updated_at);
      return '光伏 · 阳光云 更新 ' + t + (lastErr ? '（读取失败，显示上次数据）' : '');
    }
    return '数据源：' + (lastErr ? ('光伏读不到（' + lastErr + '）') : '未接入');
  }

  /* ---------------- 渲染 ---------------- */
  /* 右栏「系统概况」+ 机组表（储能未接入：相关格显示 --） */
  function renderOverview() {
    var p = byId('jyPanel');
    if (!p) return;
    var s = st();
    var h = '<div class="panel"><div class="panel-title"><span>系统概况</span><em>' + srcTag() + '</em></div>'
      + '<div class="kpi-grid">'
      + kpi('光伏功率', fmtU(s.power_kw, ' kW'),
          s.device_power_kw == null ? (STATION.pvKwp + ' / ' + STATION.pvInv)
            : ('设备合计 ' + fmt(s.device_power_kw, 1) + ' kW · ' + STATION.pvKwp))
      + kpi('储能功率', '-- kW', STATION.stor)
      + kpi('SOC', '-- %', '待储能接入')
      + kpi('负荷', '-- kW', '待储能接入')
      + kpi('关口表', '-- kW', '待储能接入')
      + kpi('今日发电', fmtU(s.today_kwh, ' kWh'), s.total_kwh == null ? '' : ('累计 ' + fmt(s.total_kwh, 0) + ' 度'))
      + '</div></div>';
    h += '<div class="panel grow"><div class="panel-title"><span>机组</span><em>储能 / 分组数据待接入</em></div>'
      + '<table class="mq-table"><thead><tr><th>机组</th><th>光伏</th><th>储能</th><th>SOC</th><th>关口</th></tr></thead><tbody>';
    for (var i = 0; i < 3; i++) {
      h += '<tr><td>' + GN[i] + '（' + (i === 2 ? 3 : 1) + ' 柜）</td>'
        + '<td>-- kW</td><td>-- kW</td><td>-- %</td><td>--</td></tr>';
    }
    h += '</tbody></table>'
      + '<div class="jy-note">光伏为全站合计（阳光云口径 · ps_id ' + (s.ps_id || '--') + '）；'
      + '“设备合计”来自 8 台逆变器，每 5 分钟更新；电站接口约滞后 5 分钟（与阳光云概览一致）。'
      + '分机组的逆变器分组待现场确认后拆列。储能数据源未接入。</div></div>';
    p.innerHTML = h;
  }

  /* 储能页：数据源未接入，只展示机组构成 */
  function renderStoragePage() {
    var body = byId('jyStorBody');
    if (!body) return;
    body.innerHTML = '<div class="dt-body">'
      + sec('sp12', '储能', srcTag(),
        '<div class="gv3-flow">'
        + gvTile('额定功率', '625', 'kW', '5 台光储一体柜')
        + gvTile('额定容量', '1305', 'kWh', '')
        + gvTile('实时功率', '--', 'kW', '正=放电 / 负=充电')
        + gvTile('SOC', '--', '%', '')
        + '</div>'
        + '<div class="jy-note">储能数据源尚未接入（协议待与厂家确认）；接入后本页补电池簇 / PCS / 液冷 / 曲线明细。</div>'
        + '<div class="jy-note">机组构成：' + STATION.groups.join('、') + '。</div>')
      + '</div>';
  }

  /* 光伏页：真实数据（阳光云第二路） */
  function rangeBtns() {
    var opts = [['today', '今日'], ['yesterday', '昨日'], ['days7', '近七日']];
    return '<span class="sl-ranges" id="jyRanges">' + opts.map(function (o) {
      return '<button data-jrange="' + o[0] + '"' + (trendRange === o[0] ? ' class="on"' : '') + '>' + o[1] + '</button>';
    }).join('') + '</span>';
  }
  function weatherHtml() {
    if (!wx) return '<div class="gv3-empty">天气暂不可用</div>';
    var r = function (k, v) { return '<div class="sl-wx-row"><span>' + k + '</span><b>' + v + '</b></div>'; };
    return '<div class="sl-wx">'
      + '<div class="sl-wx-top"><b>' + (wx.text || '--') + '</b><span>' + fmt(wx.temp, 1) + '<u>℃</u></span></div>'
      + r('体感温度', fmt(wx.feels, 1) + ' ℃')
      + r('湿度', fmt(wx.humidity, 0) + ' %')
      + r('风速', fmt(wx.wind, 1) + ' m/s')
      + r('云量', fmt(wx.cloud, 0) + ' %')
      + r('辐照度', fmt(wx.radiation, 0) + ' W/㎡')
      + r('日出 / 日落', (wx.sunrise || '--') + ' / ' + (wx.sunset || '--'))
      + '</div>';
  }
  function devStatus(d) {
    if (d.online === false) return '离线';
    if (d.fault_status === 1) return '故障';
    if (d.fault_status === 2) return '告警';
    if (d.online === true || d.fault_status === 4) return '正常';
    return '--';
  }
  function devicesHtml() {
    if (!devices.length) return '<div class="gv3-empty">暂无设备</div>';
    var TYPE = { 1: '逆变器', 22: '通信模块' };
    var list = devices.slice().sort(function (a, b) {
      var ta = Number(a.type) === 1 ? 0 : 1, tb = Number(b.type) === 1 ? 0 : 1;
      if (ta !== tb) return ta - tb;
      return String(a.name || a.sn || '').localeCompare(String(b.name || b.sn || ''), 'zh-CN', { numeric: true });
    });
    return '<div class="sl-devs">' + list.map(function (d) {
      var isInv = Number(d.type) === 1;
      var ds = devStatus(d);
      var extra = isInv
        ? ('总有功 ' + (d.power_kw == null ? '--' : fmt(d.power_kw, 2) + ' kW')
          + '　当日 ' + (d.today_kwh == null ? '--' : fmt(d.today_kwh, 1) + ' 度')
          + '　' + ds + '　数据 ' + (d.device_time ? fmtDevTime(d.device_time).slice(6) : '--'))
        : (ds + (d.device_time ? ('　数据 ' + fmtDevTime(d.device_time).slice(6)) : ''));
      return '<div class="sl-dev"><div class="sl-devmain"><b>' + (d.name || d.sn) + '</b>'
        + '<span>' + (TYPE[d.type] || ('类型 ' + d.type)) + '　' + (d.model || '') + '　SN ' + (d.sn || '') + '</span>'
        + '<span style="display:block;margin-top:2px">' + extra + '</span></div></div>';
    }).join('') + '</div>';
  }
  function renderSolarPage() {
    var box = byId('jySolarBody');
    if (!box) return;
    var s = st();
    var cap = s.capacity;
    var co2 = s.total_kwh == null ? null : s.total_kwh * CO2_PER_KWH;         /* kg */
    var coal = s.total_kwh == null ? null : s.total_kwh * COAL_PER_KWH;       /* kg */
    var trees = co2 === null ? null : Math.round(co2 * TREE_PER_KG);
    box.innerHTML = '<div class="dt-body">'
      + sec('sp12', '光伏总览', '力储峻涌光伏电站 · 阳光云',
        '<div class="gv3-flow">'
        + gvTile('实时功率', fmt(s.power_kw, 2), 'kW', '阳光云')
        + gvTile('设备合计', fmt(s.device_power_kw, 2), 'kW', '8 台逆变器 · 快约 5 分钟')
        + gvTile('今日发电', fmt(s.today_kwh, 1), '度', '阳光云')
        + gvTile('累计发电', fmt(s.total_kwh, 0), '度', s.install_date ? ('并网 ' + String(s.install_date).slice(0, 10)) : '')
        + gvTile('装机容量', fmt(cap, 2), 'kWp', s.type || '分布式光伏')
        + gvTile('等效利用小时', fmt(s.hours, 2), 'h', '今日')
        + gvTile('CO₂ 减排', fmt(co2 === null ? null : co2 / 1000, 2), '吨', '累计 · 折算')
        + gvTile('节约标准煤', fmt(coal === null ? null : coal / 1000, 2), '吨', '累计 · 折算')
        + gvTile('等效植树', trees === null ? '--' : trees, '棵', '累计 · 折算')
        + '</div>'
        + '<div class="jy-note">“实时功率/今日发电”为电站口径（与阳光云概览一致）；'
        + '“设备合计”来自 8 台逆变器，更新快约 5 分钟。分机组归属待现场确认。</div>')
      + '<div class="ov-grid">'
      + sec('sp12', '发电趋势', rangeBtns() + '<em id="jyTrendMeta" style="margin-left:8px;font-style:normal;font-size:11px;color:var(--dim)">--</em>',
        '<div class="dt-chart" id="jyTrendChart"></div>')
      + sec('sp6', '天气', 'Open-Meteo', weatherHtml())
      + sec('sp6', '逆变器 / 通信模块', devices.length ? (devices.length + ' 台 · 设备级') : '--', devicesHtml())
      + '</div></div>';
    renderTrendChart();
  }
  function renderTrendChart() {
    var el = byId('jyTrendChart');
    var meta = byId('jyTrendMeta');
    if (!el) return;
    if (typeof echarts === 'undefined') { if (meta) meta.textContent = '图表库加载中…'; return; }
    if (chart && chart.getDom() !== el) { try { chart.dispose(); } catch (_) {} chart = null; }
    if (!chart) {
      chart = echarts.init(el);
      chart.setOption({
        grid: { left: 52, right: 54, top: 14, bottom: 26 },
        tooltip: {
          trigger: 'axis', backgroundColor: 'rgba(6,18,20,.92)',
          borderColor: 'rgba(46,230,200,.35)', textStyle: { color: '#cfeee8', fontSize: 11 }
        },
        xAxis: { type: 'time', axisLine: { lineStyle: { color: 'rgba(46,230,200,.25)' } }, axisTick: { show: false }, axisLabel: { hideOverlap: true } },
        yAxis: [
          { type: 'value', name: 'kW', nameTextStyle: { fontSize: 10 }, axisLabel: { fontSize: 10 }, splitLine: { lineStyle: { color: 'rgba(46,230,200,.08)', type: 'dashed' } } },
          { type: 'value', name: '度', nameTextStyle: { fontSize: 10 }, axisLabel: { fontSize: 10 }, splitLine: { show: false } }
        ],
        series: [
          { name: '发电功率', type: 'line', smooth: true, symbol: 'none', yAxisIndex: 0, lineStyle: { width: 2, color: '#ffb020' }, data: [] },
          { name: '当日累计', type: 'line', smooth: true, symbol: 'none', yAxisIndex: 1, lineStyle: { width: 1.4, color: 'rgba(46,230,200,.85)', type: 'dashed' }, data: [] }
        ]
      });
      applyChartTheme();
    }
    var pts = (trend || []).filter(function (p) { return n(p.power_kw) !== null || n(p.daily_yield_kwh) !== null; });
    var peak = pts.reduce(function (m, p) { return Math.max(m, n(p.power_kw) || 0); }, 0);
    var day = pts.reduce(function (m, p) { return Math.max(m, n(p.daily_yield_kwh) || 0); }, 0);
    if (meta) {
      meta.textContent = pts.length
        ? (pts.length + ' 点 · 峰值 ' + fmt(peak, 2) + ' kW' + (day ? (' · 单日最高 ' + fmt(day, 1) + ' 度') : ''))
        : '暂无数据（接入后每 5 分钟累积一个点）';
    }
    chart.setOption({
      series: [
        { data: pts.map(function (p) { return [p.t, n(p.power_kw)]; }) },
        { data: pts.filter(function (p) { return n(p.daily_yield_kwh) !== null; }).map(function (p) { return [p.t, n(p.daily_yield_kwh)]; }) }
      ]
    }, false, true);
  }
  function applyChartTheme() {
    if (!chart) return;
    var ax = isDay() ? '#3d5c5a' : '#6b9490';
    chart.setOption({
      xAxis: { axisLabel: { color: ax } },
      yAxis: [{ axisLabel: { color: ax } }, { axisLabel: { color: ax } }]
    });
  }

  /* 详细信息页 */
  function renderInfoPage() {
    var box = byId('jyInfoBody');
    if (!box) return;
    var s = st();
    var src = payload
      ? ('光伏 正常（阳光云 · 更新 ' + fmtTime(s.updated_at) + '，ps_id ' + (s.ps_id || '--') + '）｜储能 未接入')
      : ('光伏 ' + (lastErr ? ('读不到（' + lastErr + '）') : '未接入') + '｜储能 未接入');
    box.innerHTML = '<div class="dt-body">'
      + sec('sp12', '电站信息', srcTag(),
        '<table class="mq-table"><tbody>'
        + row('电站名称', STATION.name)
        + row('装机容量 · 光伏', STATION.pvKwp + '（逆变器 ' + STATION.pvInv + ' · ' + STATION.pvNote + '）')
        + row('装机容量 · 储能', STATION.stor)
        + row('储能机组', STATION.groups.join('；') + '（共 5 台光储一体柜）')
        + row('并网方式', STATION.grid)
        + row('光伏电站编号', s.ps_id ? (s.ps_id + '（' + (s.cloud_name || '阳光云厂家站名') + '）') : '--')
        + row('并网日期', s.install_date ? String(s.install_date).slice(0, 10) : '--')
        + row('电站地址', s.location || '--')
        + row('设备', devices.length ? (devices.length + ' 台（8 台逆变器 + 8 个通信模块）') : '--')
        + row('数据源', src)
        + row('三维场景', '三群品字围合 + 中心铁塔；走线与工况判据同洙边（九条线贴地敷设）')
        + '</tbody></table>'
        + '<div class="jy-note">本页不放任何模拟数据：没接入的数据源一律显示 --。'
        + '光伏为全站合计；分机组数据待储能与分组确认后补充。</div>')
      + '</div>';
  }

  function renderAlarm() {
    var bar = byId('jyAlarmBar'), txt = byId('jyAlarmText');
    if (!txt) return;
    if (!payload) {
      txt.textContent = '数据源未接入：' + (lastErr || '等待配置') + ' · 三维走线为待机态';
      if (bar) bar.className = 'alarm warn';
      return;
    }
    var parts = [];
    if (wx) {
      parts.push(wx.text + ' ' + fmt(wx.temp, 1) + '℃'
        + (n(wx.radiation) === null ? '' : '　辐照 ' + fmt(wx.radiation, 0) + ' W/㎡（Open-Meteo）'));
    } else parts.push('天气读取中…');
    var s = st();
    if (s.power_kw != null) parts.push('全站光伏 ' + fmt(s.power_kw, 1) + ' kW');
    var alarms = n(s.alarms);
    parts.push(alarms ? ('告警 ' + alarms + ' 条') : '无告警');
    if (s.online === 0) parts.push('电站离线');
    var age = null;
    if (s.updated_at) { var t0 = Date.parse(s.updated_at); if (isFinite(t0)) age = (Date.now() - t0) / 60000; }
    if (age != null && age > 10) parts.push('数据延迟 ' + Math.round(age) + ' 分钟');
    if (lastErr) parts.push('读取失败：' + lastErr);
    parts.push('储能数据源未接入');
    txt.textContent = parts.join('　·　');
    var bad = !!alarms || s.online === 0 || (age != null && age > 10) || !!lastErr;
    if (bar) bar.className = 'alarm ' + (bad ? 'bad' : 'ok');
  }

  /* 把数据推给三维场景：有分组按分组；没有分组就用全站光伏驱动三栋的光纹，
     分群标签保持 --，不编分群数字 */
  function pushScene() {
    if (!window.JunyongScene || !JunyongScene.ready()) return;
    var gs = (payload && payload.groups) || [];
    for (var i = 0; i < 3; i++) {
      var g = gs[i] || {};
      JunyongScene.setGroup(i, {
        pv: g.pv_kw == null ? null : +g.pv_kw,
        pvSeen: g.pv_kw != null,
        st: g.st_kw == null ? null : +g.st_kw,
        soc: g.soc == null ? null : +g.soc,
        load: g.load_kw == null ? null : +g.load_kw,
        grid: g.grid_kw == null ? null : +g.grid_kw
      });
    }
    if (JunyongScene.setStationPv) {
      var s = st();
      JunyongScene.setStationPv(s.power_kw, s.power_kw != null);
    }
    if (wx) JunyongScene.setWeather(wx);
  }

  function render() {
    renderOverview(); renderStoragePage(); renderSolarPage(); renderInfoPage(); renderAlarm(); pushScene();
  }

  /* ---------------- 绑定 ---------------- */
  function bind() {
    var jt = byId('jyTabs');
    if (jt) jt.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button[data-jtab]') : null;
      if (!b) return;
      [].forEach.call(jt.querySelectorAll('button'), function (x) { x.classList.toggle('active', x === b); });
      mount(b.getAttribute('data-jtab'));
    });
    var bk = byId('jyBack');
    if (bk) bk.addEventListener('click', function () {
      hide(); if (window.PortalUI) PortalUI.openPortal();
    });
    var rf = byId('jyRefresh');
    if (rf) rf.addEventListener('click', function () { busyUntil = 0; refresh(); });
    var bl = byId('jyBtnLabels');
    if (bl) bl.addEventListener('click', function () {
      var on = !bl.classList.contains('active');
      bl.classList.toggle('active', on);
      if (window.JunyongScene) JunyongScene.setLabels(on);
    });
    var br = byId('jyBtnRotate');
    if (br) br.addEventListener('click', function () {
      var on = !br.classList.contains('active');
      br.classList.toggle('active', on);
      if (window.JunyongScene) JunyongScene.setRotate(on);
    });
    var bz = byId('jyBtnReset');
    if (bz) bz.addEventListener('click', function () { if (window.JunyongScene) JunyongScene.resetView(); });
    /* 光伏页的曲线区间（内容每次重建，用事件委托） */
    var sb = byId('jySolarBody');
    if (sb) sb.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button[data-jrange]') : null;
      if (!b) return;
      trendRange = b.getAttribute('data-jrange');
      [].forEach.call(sb.querySelectorAll('button[data-jrange]'), function (x) { x.classList.toggle('on', x === b); });
      loadTrend();
    });
    window.addEventListener('resize', function () {
      if (window.JunyongScene && byId('jyView') && !byId('jyView').classList.contains('hidden')) JunyongScene.resize();
      if (chart && tab === 'solar') chart.resize();
    });
    new MutationObserver(function () {
      setTimeout(function () { applyChartTheme(); if (chart && tab === 'solar') chart.resize(); }, 60);
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }
  return {
    open: open, hide: hide, refresh: refresh, bind: bind, info: STATION,
    init: function () { bind(); }
  };
})();
