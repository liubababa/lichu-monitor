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
 *     储能（已接入 · 2026-10-31）：三台高特 CCU，数据走浏览器 MQTT（解析在 js/gaote.js）——
 *       R260616J0069（6号柜）= 一号、R250907J0037（7号柜）= 二号、R260812J0066（3-5号柜）= 三号；
 *       6/7号柜 ↔ 一号/二号的最终对应待厂家确认（改 STOR_GROUPS 一行即可）。
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
    storApi: '/junyong/storage/',     /* 未使用：储能走浏览器 MQTT（见下方 STOR_GROUPS） */
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
    readStorage();                       /* 先把高特储能读进来再挂载，避免先闪一版“未接入” */
    mount(tab);
    refresh();
    setTimeout(ensureScene, 80);
    if (!timer) timer = setInterval(refresh, CFG.refreshMs);
    if (!storTimer) storTimer = setInterval(storTick, 3000);
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
    if (storTimer) { clearInterval(storTimer); storTimer = null; }
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

  /* ================= 储能（高特 CCU · 三套机组） =================
     2026-10-31 现场三台 CCU 接入：3-5号柜 = 三号（3 柜）、6号柜 / 7号柜 各 1 柜。
     6/7号柜 ↔ 一号 / 二号的对应关系厂家还没最终确认——确认后只改 STOR_GROUPS 一行。
     光伏只有全站合计（阳光云），分机组光伏为空（显示 --，不拆假数）。 */
  var STOR_GROUPS = [
    { name: '一号机组', ccu: 'R260616J0069', cabinets: 1, dev: '6号柜' },
    { name: '二号机组', ccu: 'R250907J0037', cabinets: 1, dev: '7号柜' },
    { name: '三号机组', ccu: 'R260812J0066', cabinets: 3, dev: '3-5号柜' }
  ];
  var stor = null, storSig = '', storTimer = null;

  function Ga() { return (typeof GaoteService !== 'undefined') ? GaoteService : null; }
  function storWired() { var g = Ga(); return !!(g && g.tagsOf && g.stateOf); }
  function storConn() { var g = Ga(); return !!(g && g.isConnected && g.isConnected()); }

  /* 某台 CCU 某维度的全部实例（电池簇 / PCS / 液冷…） */
  function instOf(ccu, dim) {
    var g = Ga();
    if (!g || !g.stateOf) return [];
    var stt = g.stateOf(ccu);
    if (!stt) return [];
    var want = String(dim).toLowerCase(), out = [];
    Object.keys(stt).forEach(function (k) {
      if (k.split('|')[0] !== want) return;
      var b = stt[k], vals = {};
      Object.keys(b).forEach(function (i) {
        var it = b[i];
        if (!it || !it.key || it.key.charAt(0) === '#' || it.v === null || it.v === undefined) return;
        vals[it.key] = it.v;
      });
      var m = b._meta || {};
      out.push({ arr: +m.arr, clu: +m.clu, dev: +m.dev, t: b._t || 0, vals: vals });
    });
    out.sort(function (a, b) { return (a.arr - b.arr) || (a.clu - b.clu) || (a.dev - b.dev); });
    return out;
  }
  function firstVals(list) { return (list && list[0]) ? list[0].vals : null; }

  function readStorage() {
    var g = Ga();
    if (!g || !g.tagsOf) { stor = null; return; }
    var any = false;
    var groups = STOR_GROUPS.map(function (def) {
      var base = { name: def.name, ccu: def.ccu, dev: def.dev, cabinets: def.cabinets };
      var tags = null, seen = {};
      try { tags = g.tagsOf(def.ccu); seen = g.seenOf ? g.seenOf(def.ccu) : {}; } catch (e) { tags = null; }
      var last = 0;
      Object.keys(seen || {}).forEach(function (k) { last = Math.max(last, +seen[k] || 0); });
      base.online = !!last && (Date.now() - last < 150000);
      base.lastSeen = last || null;
      if (!tags) { base.missing = true; return base; }
      var emu = function (k) { return n(g.valOf(def.ccu, 'emu', k)); };
      base.power = n(tags.EMS && tags.EMS.PCS_P);            /* kW，正=放电 / 负=充电 */
      base.soc = n(tags.EMS && tags.EMS.BMS_SOC);
      base.maxChg = emu('EnChgPow');                         /* EMU 限功率后允许充电（负值） */
      base.maxDis = emu('EnDisPow');                         /* EMU 限功率后允许放电（正值） */
      base.enChg = emu('EmuEnChgCap');
      base.enDis = emu('EmuEnDisCap');
      base.avgTemp = emu('BatteryAverageTem');
      base.maxCellV = emu('MaxCellVol');
      base.minCellV = emu('MinCellVol');
      base.cellSums = emu('CellSums');
      base.sysStatus = emu('SysStatus');
      base.ctrl = emu('ControlSrc');
      base.runStatus = emu('RunStatus');
      base.dayChg = n(tags.EMS && tags.EMS.DayCharge);
      base.dayDis = n(tags.EMS && tags.EMS.DayDischarge);
      base.gridP = n(tags.GRID_METER && tags.GRID_METER.ActivePower);
      base.gridE1 = n(tags.GRID_METER && tags.GRID_METER.ActiveEnergy);     /* 正向总有功电量（取电） */
      base.gridE2 = n(tags.GRID_METER && tags.GRID_METER.ReactiveEnergy);   /* 点表这个键实为"反向总有功电量"（馈电） */
      base.storP = n(tags.PCS_METER && tags.PCS_METER.ActivePower);
      base.storE = n(tags.PCS_METER && tags.PCS_METER.ActiveEnergy);
      base.clusters = instOf(def.ccu, 'cluster');
      base.pcss = instOf(def.ccu, 'pcs');
      base.liquid = firstVals(instOf(def.ccu, 'liqcool'));
      base.fire = firstVals(instOf(def.ccu, 'fire'));
      base.drier = firstVals(instOf(def.ccu, 'drier'));
      base.alarms = [];
      try { base.alarms = g.alarmsOf ? (g.alarmsOf(def.ccu) || []) : []; } catch (e) {}
      if (base.power !== null || base.soc !== null || base.gridP !== null) any = true;
      return base;
    });
    stor = { known: any, groups: groups, at: Date.now() };
  }

  /* 三群汇总。注意：负载 = 光伏(阳光云全站) + 储能(高特) + 关口(高特) 的合成值，
     属于跨源算出来的数，界面上要带"合成"口径说明，不和任何厂家结算数字混用。 */
  function storSum() {
    var out = { power: null, soc: null, grid: null, load: null, online: 0, count: 0 };
    var gs2 = (stor && stor.groups) || [];
    var pow = null, grid = null, socW = 0, w = 0;
    gs2.forEach(function (g) {
      out.count++;
      if (g.online) out.online++;
      if (g.power !== null && g.power !== undefined) pow = (pow || 0) + +g.power;
      if (g.gridP !== null && g.gridP !== undefined) grid = (grid || 0) + +g.gridP;
      if (g.soc !== null && g.soc !== undefined) { socW += +g.soc * g.cabinets; w += g.cabinets; }
    });
    out.power = pow;
    out.grid = grid;
    out.soc = w ? socW / w : null;
    if (pow !== null && grid !== null && payload) {
      var pvKw = n(st().power_kw);
      if (pvKw !== null) out.load = pvKw + pow + grid;
    }
    return out;
  }

  function renderStorParts() {
    renderOverview(); renderStoragePage(); renderInfoPage(); renderAlarm(); pushScene();
  }

  /* 3 秒看一眼：数据变了才重画（避免无谓重建导致闪烁） */
  function storTick() {
    readStorage();
    var sig = stor ? (stor.groups.map(function (g) {
      return [g.ccu, g.online ? 1 : 0, g.missing ? 'm' : '',
        g.power == null ? '-' : Math.round(g.power),
        g.soc == null ? '-' : Math.round(g.soc),
        g.gridP == null ? '-' : Math.round(g.gridP)].join(',');
    }).join('|') + '#' + (stor.known ? 1 : 0)) : 'none';
    if (sig !== storSig) { storSig = sig; renderStorParts(); } else { pushScene(); }
  }

  /* ---------------- 渲染 ---------------- */
  /* 右栏「系统概况」+ 机组表 */
  function renderOverview() {
    var p = byId('jyPanel');
    if (!p) return;
    var s = st(), S = storSum();
    var stTxt = S.power == null ? '-- kW'
      : ((S.power > 0 ? '放电 ' : S.power < 0 ? '充电 ' : '待机 ') + Math.abs(S.power).toFixed(1) + ' kW');
    var h = '<div class="panel"><div class="panel-title"><span>系统概况</span><em>' + srcTag() + '</em></div>'
      + '<div class="kpi-grid">'
      + kpi('光伏功率', fmtU(s.power_kw, ' kW'),
          s.device_power_kw == null ? (STATION.pvKwp + ' / ' + STATION.pvInv)
            : ('设备合计 ' + fmt(s.device_power_kw, 1) + ' kW · ' + STATION.pvKwp))
      + kpi('储能功率', stTxt, '高特 CCU · ' + S.online + '/' + (S.count || 3) + ' 台在线')
      + kpi('SOC', S.soc == null ? '-- %' : (S.soc.toFixed(0) + ' %'), '按柜数加权')
      + kpi('负荷', S.load == null ? '-- kW' : (S.load.toFixed(1) + ' kW'), '光伏+储能+关口 合成')
      + kpi('关口表', S.grid == null ? '-- kW' : ((S.grid >= 0 ? '取电 ' : '送电 ') + Math.abs(S.grid).toFixed(1) + ' kW'), '正=取电 / 负=送电')
      + kpi('今日发电', fmtU(s.today_kwh, ' kWh'), s.total_kwh == null ? '' : ('累计 ' + fmt(s.total_kwh, 0) + ' 度'))
      + '</div></div>';
    h += '<div class="panel grow"><div class="panel-title"><span>机组</span><em>'
      + (S.online ? (S.online + ' / ' + (S.count || 3) + ' 台在线') : '高特数据未连接') + '</em></div>'
      + '<table class="mq-table"><thead><tr><th>机组</th><th>光伏</th><th>储能</th><th>SOC</th><th>关口</th></tr></thead><tbody>';
    for (var i = 0; i < 3; i++) {
      var g = (stor && stor.groups && stor.groups[i]) || {};
      h += '<tr><td>' + GN[i] + '（' + (i === 2 ? 3 : 1) + ' 柜）</td>'
        + '<td>-- kW</td>'
        + '<td>' + (g.power == null ? '-- kW' : ((g.power > .5 ? '放 ' : g.power < -.5 ? '充 ' : '待机 ') + Math.abs(g.power).toFixed(1))) + '</td>'
        + '<td>' + (g.soc == null ? '-- %' : (+g.soc).toFixed(0) + ' %') + '</td>'
        + '<td>' + (g.gridP == null ? '--' : ((g.gridP >= 0 ? '取 ' : '送 ') + Math.abs(g.gridP).toFixed(1))) + '</td></tr>';
    }
    h += '</tbody></table>'
      + '<div class="jy-note">光伏为全站合计（阳光云口径 · ps_id ' + (s.ps_id || '--') + '）；'
      + '“设备合计”来自 8 台逆变器，每 5 分钟更新；电站接口约滞后 5 分钟（与阳光云概览一致）。'
      + '储能来自高特 CCU（' + STOR_GROUPS.map(function (x) { return x.dev + ' = ' + x.name; }).join('、') + '），'
      + '分机组光伏暂缺（显示 --）。负荷是"光伏 + 储能 + 关口"的合成值。</div></div>';
    p.innerHTML = h;
  }

  /* ---------------- 储能页（高特 CCU 实时数据） ---------------- */
  function socRing(soc) {
    var c = 2 * Math.PI * 40;
    var off = soc === null ? c : c * (1 - Math.max(0, Math.min(100, soc)) / 100);
    return '<div class="gv3-ring"><svg viewBox="0 0 96 96">'
      + '<circle class="rbg" cx="48" cy="48" r="40"/>'
      + '<circle class="rfg" cx="48" cy="48" r="40" style="stroke-dasharray:' + c.toFixed(1)
      + ';stroke-dashoffset:' + off.toFixed(1) + '"/></svg>'
      + '<b><span>' + (soc === null ? '--' : Math.round(soc)) + '</span><i>%</i></b>'
      + '<span class="gv3-ring-label">SOC</span></div>';
  }
  function gvKpi(label, val, unit, tag, cls) {
    return '<div class="gv3-kpi' + (cls ? ' ' + cls : '') + '"><span class="gv3-klabel">' + label + '</span>'
      + '<b class="gv3-kval">' + val + '</b><u class="gv3-kunit">' + (unit || '') + '</u>'
      + (tag ? '<em class="gv3-ktag">' + tag + '</em>' : '') + '</div>';
  }
  function kvBox(rows) {
    return '<div class="gv3-skv">' + rows.map(function (r) {
      return '<div class="gv3-kvrow"><span>' + r[0] + '</span><b>' + r[1] + '</b></div>';
    }).join('') + '</div>';
  }
  function fnum(v, dec, unit) {
    var x = n(v);
    return x === null ? '--' : (x.toFixed(dec === undefined ? 1 : dec) + (unit || ''));
  }
  var PCS_ST = { 0: '停机', 1: '待机', 2: '故障', 3: '充电', 4: '放电' };
  var UNIT_ST = { 0: '静置', 1: '充电', 2: '放电' };
  var DRIER_ST = { 0: '待机', 1: '正在除湿', 2: '外部温度传感器故障', 3: '冷面温度传感器故障', 4: '热面温度传感器故障', 5: '外部环境温度过高', 6: '温度环境温度过高' };
  function groupTitle(g) { return g.name + ' · ' + g.dev + '（' + g.cabinets + ' 柜）'; }
  function groupChip(g) {
    if (!stor) return '高特数据未连接';
    if (g.missing) return '无数据';
    return g.online ? ('在线 · 更新 ' + fmtTime(g.lastSeen)) : ('离线 · 最后 ' + fmtTime(g.lastSeen));
  }
  function groupHero(g) {
    var cls = g.power == null ? '' : (g.power > .5 ? 'dischg' : (g.power < -.5 ? 'chg' : ''));
    var dTxt = g.power == null ? '' : (g.power > .5 ? '放电' : (g.power < -.5 ? '充电' : '待机'));
    return '<div class="gv3-hero">' + socRing(g.soc == null ? null : +g.soc) + '<div class="gv3-kpis">'
      + gvKpi('实时功率', g.power == null ? '--' : fmt(g.power, 1), 'kW', dTxt, cls)
      + gvKpi('今日充电', fmt(g.dayChg, 1), '度')
      + gvKpi('今日放电', fmt(g.dayDis, 1), '度')
      + gvKpi('允许充 / 放', fnum(g.maxChg, 0) + ' / ' + fnum(g.maxDis, 0), 'kW')
      + gvKpi('可充 / 可放', fnum(g.enChg, 0) + ' / ' + fnum(g.enDis, 0), 'kWh')
      + gvKpi('电池平均温度', fmt(g.avgTemp, 1), '℃')
      + gvKpi('单体电压 高/低', fnum(g.maxCellV, 3) + ' / ' + fnum(g.minCellV, 3), 'V')
      + gvKpi('电池状态', g.runStatus == null ? '--' : (UNIT_ST[g.runStatus] || ('状态码 ' + g.runStatus)), '')
      + '</div></div>';
  }
  function groupBody(g) {
    var cluRows = (g.clusters || []).map(function (c, i) {
      var v = c.vals;
      return '<tr><td>' + (i + 1) + '</td>'
        + '<td>' + fnum(v.cluSoc, 0, '%') + '</td>'
        + '<td>' + fnum(v.clusoh, 0, '%') + '</td>'
        + '<td>' + fnum(v.cluVol, 1, ' V') + '</td>'
        + '<td>' + fnum(v.cluCur, 1, ' A') + '</td>'
        + '<td>' + fnum(v.cluRtPower, 1, ' kW') + '</td>'
        + '<td>' + fnum(v.maxCellTem, 0, '℃') + ' / ' + fnum(v.minCellTem, 0, '℃') + '</td>'
        + '<td>' + fnum(v.maxCellVol, 3, ' V') + ' / ' + fnum(v.minCellVol, 3, ' V') + '</td></tr>';
    }).join('');
    var cluBox = cluRows
      ? '<table class="mq-table"><thead><tr><th>电池簇</th><th>SOC</th><th>SOH</th><th>总电压</th><th>电流</th><th>实时功率</th><th>温度 高/低</th><th>单体 高/低</th></tr></thead><tbody>' + cluRows + '</tbody></table>'
      : '<div class="gv3-empty">暂无电池簇数据</div>';
    var pcsRows = (g.pcss || []).map(function (c, i) {
      var v = c.vals;
      return '<tr><td>' + (i + 1) + '</td>'
        + '<td>' + fnum(v.ac_pow_p, 1, ' kW') + '</td>'
        + '<td>' + fnum(v.ac_pow_q, 1, ' kvar') + '</td>'
        + '<td>' + fnum(v.ac_pow_s, 1, ' kVA') + '</td>'
        + '<td>' + fnum(v.ac_pow_pf, 2, '') + '</td>'
        + '<td>' + [v.ac_uw_vol, v.ac_vw_vol, v.ac_wu_vol].map(function (x) { return fnum(x, 1); }).join(' / ') + ' V</td>'
        + '<td>' + fnum(v.grd_f, 2, ' Hz') + '</td>'
        + '<td>' + fnum(v.igbt_temp, 0, '℃') + '</td>'
        + '<td>' + (v.run_sta == null ? '--' : (PCS_ST[v.run_sta] || ('状态' + v.run_sta))) + '</td></tr>';
    }).join('');
    var pcsBox = pcsRows
      ? '<table class="mq-table"><thead><tr><th>PCS</th><th>有功</th><th>无功</th><th>视在</th><th>功率因数</th><th>三相电压</th><th>频率</th><th>IGBT温度</th><th>状态</th></tr></thead><tbody>' + pcsRows + '</tbody></table>'
      : '<div class="gv3-empty">暂无 PCS 数据</div>';
    var L = g.liquid || {}, F = g.fire || {}, D = g.drier || {};
    var aux = kvBox([
      ['液冷 · 回水 / 出水温度', fnum(L.liqinlet_water_tmp, 1, '') + ' / ' + fnum(L.liqhot_water_tmp, 1, ' ℃')],
      ['液冷 · 环境温度 / 水泵', fnum(L.liq_outtmp, 1, ' ℃') + '　' + (L.liq_pump_status == null ? '--' : (L.liq_pump_status ? '运行' : '停止'))],
      ['消防 · 温度 / CO / H2', fnum(F.fire_temp, 1, ' ℃') + '　' + fnum(F.fire_co, 0, ' ppm') + '　' + fnum(F.fire_h2, 0, ' ppm')],
      ['消防 · VOC / 烟感', fnum(F.voc_con, 0, ' ppm') + '　' + fnum(F.fire_smoke, 0, '')],
      ['除湿 · 温度 / 湿度', fnum(D.time_tem, 1, ' ℃') + '　' + fnum(D.time_wet, 0, ' %RH')],
      ['除湿 · 工作状态', D.drier_wholerun == null ? '--' : (DRIER_ST[D.drier_wholerun] || ('状态' + D.drier_wholerun))]
    ]);
    var meterStat = kvBox([
      ['关口 · 实时功率', g.gridP == null ? '--' : ((g.gridP >= 0 ? '取电 ' : '送电 ') + Math.abs(g.gridP).toFixed(1) + ' kW')],
      ['关口 · 正向 / 反向电量', fnum(g.gridE1, 0, '') + ' / ' + fnum(g.gridE2, 0, ' kWh')],
      ['储能表 · 实时功率', fnum(g.storP, 1, ' kW')],
      ['储能表 · 正向电能', fnum(g.storE, 0, ' kWh')],
      ['系统状态码', g.sysStatus == null ? '--' : ('状态码 ' + g.sysStatus + '（点表未定义枚举，不判正常/异常）')],
      ['控制源 / 电池节数', (g.ctrl == null ? '--' : (g.ctrl === 1 ? '远程' : g.ctrl === 0 ? '本地' : '其他')) + '　' + fnum(g.cellSums, 0, ' 节')]
    ]);
    var alarmList = (g.alarms || []).map(function (a) {
      return '<div class="sl-dev"><div class="sl-devmain"><b>' + (a.name || '告警') + '</b>'
        + '<span>' + (a.dim || '') + (a.inst ? (' · ' + a.inst) : '') + '</span></div><i class="sl-badge warn">告警</i></div>';
    }).join('');
    return '<div class="ov-grid" style="margin-top:12px">'
      + sec('sp6', '电池簇', (g.clusters || []).length + ' 簇', cluBox)
      + sec('sp6', 'PCS', (g.pcss || []).length + ' 台', pcsBox)
      + sec('sp6', '液冷 / 消防 / 除湿', '', aux)
      + sec('sp6', '电表 · 状态', '', meterStat)
      + (alarmList ? sec('sp12', '告警', g.alarms.length + ' 条', '<div class="sl-devs">' + alarmList + '</div>') : '')
      + '</div>';
  }
  function renderStoragePage() {
    var body = byId('jyStorBody');
    if (!body) return;
    var view = byId('jyStorView');
    var keepTop = body.scrollTop, keepView = view ? view.scrollTop : 0;
    var S = storSum();
    var head = sec('sp12', '储能总览', '高特 CCU · 三套机组',
      '<div class="gv3-flow">'
      + gvTile('实时功率', S.power == null ? '--' : fmt(S.power, 1), 'kW', S.power == null ? '' : (S.power > .5 ? '放电' : S.power < -.5 ? '充电' : '待机'))
      + gvTile('SOC', S.soc == null ? '--' : fmt(S.soc, 0), '%', '按柜数加权')
      + gvTile('关口（三群合计）', S.grid == null ? '--' : fmt(S.grid, 1), 'kW', '正=取电 / 负=送电')
      + gvTile('在线', S.online + ' / ' + (S.count || 3), '台', storConn() ? 'MQTT 已连接' : 'MQTT 未连接')
      + gvTile('额定', '625', 'kW', '1305 kWh · 5 柜')
      + '</div>'
      + '<div class="jy-note">数据源：高特 CCU（浏览器 MQTT，30 秒上报）。光伏只有全站合计（阳光云），所以分机组光伏显示 --；'
      + '6/7号柜 ↔ 一号/二号的对应关系待厂家确认（确认后改一行配置即可）。</div>');
    var list = (stor && stor.groups) || [];
    body.innerHTML = '<div class="dt-body">' + head + list.map(function (g) {
      return sec('sp12', groupTitle(g), groupChip(g), groupHero(g) + groupBody(g));
    }).join('')
      + (list.length ? '' : sec('sp12', '储能', '未连接', '<div class="gv3-empty">储能数据源未连接：请在「数据源」面板填入 lichu_web 账号连接 MQTT。</div>'))
      + '</div>';
    if (view) view.scrollTop = keepView;
    body.scrollTop = keepTop;
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
  function storRow(g) {
    if (!stor) return '--（高特数据未连接）';
    if (!g || g.missing) return '无数据';
    var alm = (g.alarms || []).length;
    return g.ccu + '（' + g.dev + '）· '
      + (g.online ? ('在线 · 更新 ' + fmtTime(g.lastSeen)) : ('离线 · 最后 ' + fmtTime(g.lastSeen)))
      + ' · ' + (g.clusters || []).length + ' 簇 / ' + (g.pcss || []).length + ' PCS'
      + (alm ? (' · <span class="dt-alarm">告警 ' + alm + ' 条</span>') : ' · 无告警');
  }
  function renderInfoPage() {
    var box = byId('jyInfoBody');
    if (!box) return;
    var s = st();
    var src = (payload
      ? ('光伏 正常（阳光云 · 更新 ' + fmtTime(s.updated_at) + '，ps_id ' + (s.ps_id || '--') + '）')
      : ('光伏 ' + (lastErr ? ('读不到（' + lastErr + '）') : '未接入')))
      + '｜储能 ' + (storConn() ? '高特 CCU（浏览器 MQTT）' : '未连接');
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
        + row('光伏设备', devices.length ? (devices.length + ' 台（8 台逆变器 + 8 个通信模块）') : '--')
        + row('储能数据源', (storConn() ? '高特 CCU · MQTT 已连接' : '高特 CCU · <span class="dt-alarm">未连接</span>') + '（30 秒上报）')
        + STOR_GROUPS.map(function (x, i) {
          return row('储能 · ' + x.name, storRow((stor && stor.groups && stor.groups[i]) || {}));
        }).join('')
        + row('数据源', src)
        + row('三维场景', '三群品字围合 + 中心铁塔；走线与工况判据同洙边（九条线贴地敷设）')
        + '</tbody></table>'
        + '<div class="jy-note">本页不放任何模拟数据：没接入的数据源一律显示 --。'
        + '光伏为全站合计（阳光云），分机组光伏暂缺（显示 --）；储能按高特 CCU 分机组展示。'
        + '6/7号柜 ↔ 一号/二号的对应关系待厂家确认。</div>')
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
    var S = storSum(), nAlm = 0;
    ((stor && stor.groups) || []).forEach(function (g) { nAlm += (g.alarms ? g.alarms.length : 0); });
    if (!storWired() || !storConn()) parts.push('储能数据源未连接（数据源面板填 lichu_web 连接）');
    else parts.push('储能 ' + S.online + '/' + (S.count || 3) + ' 在线' + (nAlm ? (' · 告警 ' + nAlm + ' 条') : ' · 无告警'));
    txt.textContent = parts.join('　·　');
    var bad = !!alarms || s.online === 0 || (age != null && age > 10) || !!lastErr || nAlm > 0;
    if (bar) bar.className = 'alarm ' + (bad ? 'bad' : 'ok');
  }

  /* 把数据推给三维场景：光伏只有全站合计（阳光云）→ setStationPv 驱动三栋屋面；
     分群光伏保持 --（不编分群数字）；储能 / SOC / 关口来自高特 CCU（正=放电；关口正=取电）。 */
  function pushScene() {
    if (!window.JunyongScene || !JunyongScene.ready()) return;
    for (var i = 0; i < 3; i++) {
      var g = (stor && stor.groups && stor.groups[i]) || {};
      JunyongScene.setGroup(i, {
        pv: null, pvSeen: false,
        st: g.power == null ? null : +g.power,
        soc: g.soc == null ? null : +g.soc,
        grid: g.gridP == null ? null : +g.gridP,
        load: null
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
    if (rf) rf.addEventListener('click', function () {
      busyUntil = 0; refresh(); readStorage(); storSig = ''; renderStorParts();
    });
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
