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
 *   口径：阳光云报全站合计（972.4 kWp / 8 台逆变器 820 kW）；分群光伏按
 *   逆变器名称前缀归组（01NB… = 一号 4 台、02NB… = 二号 2 台、03NB… = 三号 2 台，
 *   2026-10-31 用户确认）。光伏 null ≠ 0（没上报 ≠ 0 kW）。
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
  var chart = null;              /* 光伏页曲线 */
  var revChart = null, revTrend = null;   /* 详细信息页 近 3 日光伏曲线（独立实例 / 独立数据） */
  var hist = { t: [], p: [], soc: [] };   /* 本次会话的储能功率 / SOC（右栏火花线，最多 60 点） */

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
  /* 右栏 KPI：与洙边右栏同一套结构（kpi-icon + kpi-body/kpi-num/kpi-label），
     原来把 label/value 直接塞进 .kpi 里，窄栏里中文标签会一个字一行 */
  var KICON = {
    pv: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"/></svg>',
    bat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="8" width="17" height="9" rx="1.5"/><path d="M22 11v3M6 11.5v2M9.5 11.5v2M13 11.5v2"/></svg>',
    soc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M8.5 14.5 12 9l3.5 5.5M9.4 12.8h5.2"/></svg>',
    load: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21V9l6 3V7l6 3V3h6v18z"/><path d="M7 17h2M12 17h2M17 17h2"/></svg>',
    grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3 8 21M12 3l4 18M9 9h6M8 14h8M6 21l4-7M18 21l-4-7"/></svg>',
    day: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2 5 14h6l-1 8 8-12h-6z"/></svg>'
  };
  function kpi(label, value, unit, sub, cls, icon) {
    return '<div class="kpi' + (cls ? ' ' + cls : '') + '">'
      + (icon ? '<div class="kpi-icon">' + icon + '</div>' : '')
      + '<div class="kpi-body">'
      + '<div class="kpi-num"><b>' + value + '</b>' + (unit ? '<u>' + unit + '</u>' : '') + '</div>'
      + '<div class="kpi-label">' + label + '</div>'
      + (sub ? '<div class="sl-ks">' + sub + '</div>' : '')
      + '</div></div>';
  }
  var kvRow = function (k, v) { return '<div class="gv3-kvrow"><span>' + k + '</span><b>' + v + '</b></div>'; };
  var gvTile = function (label, val, unit, tag, cls) {
    return '<div class="gv3-tile' + (cls ? ' ' + cls : '') + '"><span class="gv3-tlabel">' + label + '</span>'
      + '<b class="gv3-tval">' + val + '</b><u>' + (unit || '') + '</u>'
      + (tag ? '<em class="gv3-ttag">' + tag + '</em>' : '') + '</div>';
  };
  function sec(span, title, chip, body) {
    return '<section class="ov-sec gv3-sec ' + span + '"><div class="ov-sec-head"><b>' + title + '</b>'
      + (chip ? '<span class="ov-tagchip">' + chip + '</span>' : '')
      + '<i class="ov-online on"></i></div><div class="ov-sec-body gv3-body">' + body + '</div></section>';
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
    setTimeout(function () {
      if (!window.JunyongScene) return;
      JunyongScene.resize();
      JunyongScene.setActive(tab === 'monitor');   /* 深链直接进数据页时别让隐藏的 3D 一直跑 */
    }, 220);
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
    if (t === 'revenue') loadRevTrend();
    if (window.JunyongScene) JunyongScene.setActive(t === 'monitor');
    /* 曲线在隐藏容器里初始化时尺寸是 0，切过来后要重算一次 */
    setTimeout(function () {
      if (chart && t === 'solar') chart.resize();
      if (revChart && t === 'revenue') revChart.resize();
    }, 80);
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

  /* 二号机组需量电表（meter-lems-demand）通信故障：只影响需量控制，不影响光伏 / 储能 / 关口读数，
     也不属于电池 / PCS 安全告警。用户要求先不在界面显示；原始告警保留在 alarmsAll 与 MQTT 报文里。 */
  function uiAlarms(list) {
    return (list || []).filter(function (a) {
      return !(a && a.dim === 'meter-lems-demand' && /通信故障|告警汇总等级/.test(String(a.name || '')));
    });
  }

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

  /* 分群光伏：逆变器名称前缀 01NB/02NB/03NB → 一/二/三号机组（用户 2026-10-31 确认）。
     只有能被前缀明确归组的逆变器才计数；一台都认不出就整体返回 null（显示 --，不编数）。 */
  function pvGroups() {
    var out = [{ kw: 0, today: 0, n: 0, kwSeen: false, todaySeen: false },
      { kw: 0, today: 0, n: 0, kwSeen: false, todaySeen: false },
      { kw: 0, today: 0, n: 0, kwSeen: false, todaySeen: false }];
    var hit = 0, invTotal = 0;
    (devices || []).forEach(function (d) {
      if (Number(d.type) !== 1) return;
      invTotal++;
      var m = /^(\d{2})NB/i.exec(String(d.name || ''));
      var gi = m ? (+m[1] - 1) : -1;
      if (gi < 0 || gi > 2) return;
      hit++;
      var g = out[gi];
      g.n++;
      var p = n(d.power_kw), t = n(d.today_kwh);
      if (p !== null) { g.kw += p; g.kwSeen = true; }
      if (t !== null) { g.today += t; g.todaySeen = true; }
    });
    /* 有一台逆变器认不出前缀就整体不展示（宁可 --，不拿残缺分组合计当真） */
    if (!hit || hit !== invTotal) return null;
    return out.map(function (g) {
      return { kw: g.kwSeen ? g.kw : null, today: g.todaySeen ? g.today : null, n: g.n };
    });
  }

  /* 本次会话的储能功率火花线：不引图表库，直接画 SVG。
     刚打开 6 秒一采，之后 18 秒一采（设备 30 秒一帧，3 秒轮询不会把点堆成直线）。 */
  function pushHist(S) {
    if (S.power == null && S.soc == null) return;
    var t = Date.now();
    var nPt = hist.t.length;
    if (nPt) {
      var dt = t - hist.t[nPt - 1];
      var warm = nPt < 6;                              /* 刚打开先快采几个点，别一直显示"采集中" */
      if (dt < (warm ? 6000 : 18000)) return;
      var last = hist.p[nPt - 1];
      var changed = Math.abs((last == null ? 0 : last) - (S.power == null ? 0 : S.power)) > .05;
      if (!warm && !changed && dt < 55000) return;
    }
    hist.t.push(t); hist.p.push(S.power); hist.soc.push(S.soc);
    if (hist.t.length > 60) { hist.t.shift(); hist.p.shift(); hist.soc.shift(); }
  }
  function sparkSvg() {
    if (!hist.t.length) return '<div class="jy-spark-empty">正在采集本次会话曲线…</div>';
    var W = 360, H = 92, pad = 6;
    var ps = hist.p.map(function (v) { return v == null ? null : +v; });
    var ss = hist.soc.map(function (v) { return v == null ? null : +v; });
    var lim = 1;
    ps.forEach(function (v) { if (v !== null) lim = Math.max(lim, Math.abs(v)); });
    var step = Math.max(1, hist.t.length - 1);
    var sx = function (i) { return pad + i * (W - pad * 2) / step; };
    var yOf = function (v, scale) { return H / 2 - (v / scale) * (H / 2 - pad); };
    function poly(vals, scale) {
      var d = '', open = false;
      vals.forEach(function (v, i) {
        if (v === null) { open = false; return; }
        var y = yOf(v, scale);
        d += (open ? 'L' : 'M') + sx(i).toFixed(1) + ' ' + y.toFixed(1) + ' ';
        open = true;
      });
      return d.trim();
    }
    var cur = ps.length ? ps[ps.length - 1] : null;
    var lastI = ps.length - 1;
    var dot = (lastI >= 0 && ps[lastI] !== null)
      ? '<circle cx="' + sx(lastI).toFixed(1) + '" cy="' + yOf(ps[lastI], lim).toFixed(1) + '" r="2.6" class="sp-dot"/>' : '';
    return '<span class="jy-spark-cur ' + (cur > .5 ? 'dis' : cur < -.5 ? 'chg' : '') + '">'
      + (cur == null ? '--' : (cur > .5 ? '放电 ' : cur < -.5 ? '充电 ' : '待机 ') + Math.abs(cur).toFixed(1) + ' kW')
      + '</span>'
      + '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">'
      + '<line x1="0" y1="' + (H / 2) + '" x2="' + W + '" y2="' + (H / 2) + '" class="sp-zero"/>'
      + '<path d="' + poly(ps, lim) + '" class="sp-p"/>'
      + '<path d="' + poly(ss, 100) + '" class="sp-soc"/>' + dot
      + '</svg>'
      + '<div class="jy-spark-legend"><span><i class="pv"></i>储能功率</span><span><i class="soc"></i>SOC</span><em>' + hist.t.length + ' 点 · 本次会话</em></div>';
  }

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
      base.modCod = emu('EmuModCod');
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
      base.alarmsAll = [];
      try { base.alarmsAll = g.alarmsOf ? (g.alarmsOf(def.ccu) || []) : []; } catch (e) {}
      base.alarms = uiAlarms(base.alarmsAll);
      if (base.power !== null || base.soc !== null || base.gridP !== null) any = true;
      return base;
    });
    stor = { known: any, groups: groups, at: Date.now() };
  }

  /* 三群汇总。注意：负载 = 光伏(阳光云全站) + 储能(高特) + 关口(高特) 的合成值，
     属于跨源算出来的数，界面上要带"合成"口径说明，不和任何厂家结算数字混用。 */
  function storSum() {
    var out = {
      power: null, soc: null, grid: null, load: null, online: 0, count: 0,
      cellSums: null, enChg: null, enDis: null, maxChg: null, maxDis: null,
      avgTemp: null, maxCellV: null, dayChg: null, dayDis: null, gridE1: null, gridE2: null,
      gridE1Known: 0, gridE2Known: 0, dayKnown: 0,
      sysStatus: null, ctrl: null, modCod: null, runStatus: null
    };
    var gs2 = (stor && stor.groups) || [];
    var pow = null, grid = null, socW = 0, w = 0, tempW = 0, tempN = 0;
    var acc = {};
    var add = function (k, v) { if (v !== null && v !== undefined && isFinite(+v)) acc[k] = (acc[k] || 0) + +v; };
    var syss = [], ctrls = [], modes = [], runs = [];
    gs2.forEach(function (g) {
      out.count++;
      if (g.online) out.online++;
      if (g.power !== null && g.power !== undefined) pow = (pow || 0) + +g.power;
      if (g.gridP !== null && g.gridP !== undefined) grid = (grid || 0) + +g.gridP;
      if (g.soc !== null && g.soc !== undefined) { socW += +g.soc * g.cabinets; w += g.cabinets; }
      add('cellSums', g.cellSums); add('enChg', g.enChg); add('enDis', g.enDis);
      add('maxChg', g.maxChg == null ? null : Math.abs(g.maxChg)); add('maxDis', g.maxDis);
      add('dayChg', g.dayChg); add('dayDis', g.dayDis);
      if (g.gridE1 !== null && g.gridE1 !== undefined) out.gridE1Known++;
      if (g.gridE2 !== null && g.gridE2 !== undefined) out.gridE2Known++;
      if (g.dayChg !== null && g.dayChg !== undefined && g.dayDis !== null && g.dayDis !== undefined) out.dayKnown++;
      add('gridE1', g.gridE1); add('gridE2', g.gridE2);
      if (g.avgTemp !== null && g.avgTemp !== undefined) { tempW += +g.avgTemp * g.cabinets; tempN += g.cabinets; }
      if (g.maxCellV !== null && g.maxCellV !== undefined && (out.maxCellV === null || +g.maxCellV > out.maxCellV)) out.maxCellV = +g.maxCellV;
      if (g.sysStatus != null) syss.push('状态码 ' + g.sysStatus);
      if (g.ctrl != null) ctrls.push(g.ctrl === 1 ? '远程' : g.ctrl === 0 ? '本地' : '其他');
      if (g.modCod != null) modes.push(MODE_ST[g.modCod] || g.modCod);
      if (g.runStatus != null) runs.push({ 0: '静置', 1: '充电', 2: '放电' }[g.runStatus] || g.runStatus);
    });
    var uniq = function (a) { var s = {}, o = []; a.forEach(function (v) { if (!s[v]) { s[v] = 1; o.push(v); } }); return o.length ? o.join(' / ') : null; };
    out.power = pow;
    out.grid = grid;
    out.soc = w ? socW / w : null;
    out.avgTemp = tempN ? tempW / tempN : null;
    out.cellSums = acc.cellSums; out.enChg = acc.enChg; out.enDis = acc.enDis;
    out.maxChg = acc.maxChg; out.maxDis = acc.maxDis;
    out.dayChg = acc.dayChg; out.dayDis = acc.dayDis;
    out.gridE1 = acc.gridE1; out.gridE2 = acc.gridE2;
    out.sysStatus = uniq(syss); out.ctrl = uniq(ctrls); out.modCod = uniq(modes); out.runStatus = uniq(runs);
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
    pushHist(storSum());
    var spEl = document.querySelector('#jyPanel .jy-spark');
    if (spEl) spEl.innerHTML = sparkSvg();     /* 数据签名不变时也推进会话曲线 */
    var sig = stor ? (stor.groups.map(function (g) {
      return [g.ccu, g.online ? 1 : 0, g.missing ? 'm' : '',
        g.power == null ? '-' : Math.round(g.power),
        g.soc == null ? '-' : Math.round(g.soc),
        g.gridP == null ? '-' : Math.round(g.gridP),
        (g.alarms || []).map(function (a) { return a.name; }).join('+')].join(',');
    }).join('|') + '#' + (stor.known ? 1 : 0)) : 'none';
    if (sig !== storSig) { storSig = sig; renderStorParts(); } else { pushScene(); }
  }

  /* ---------------- 渲染 ---------------- */
  /* 功率平衡：以 0 为轴的横向条，储能充电朝左、放电朝右，关口送电朝左、取电朝右。
     比"负荷构成堆叠条"准确：充电时不会把光伏出力误当成负荷。 */
  function powerBalanceHtml(s, S, pvG) {
    var pv = n(s.power_kw);
    if (pv === null && pvG) {
      var any = false, sum = 0;
      pvG.forEach(function (x) { if (x && x.kw !== null) { any = true; sum += x.kw; } });
      if (any) pv = sum;
    }
    var vals = [pv, S.power, S.grid, S.load];
    var max = 1;
    vals.forEach(function (v) { if (v != null) max = Math.max(max, Math.abs(v)); });
    function row(label, v, cls, name) {
      var half = v == null ? 0 : Math.min(50, Math.abs(v) / max * 50);
      var pos = v != null && v >= 0;
      var style = v == null ? 'display:none'
        : (pos ? 'left:50%;width:' + half.toFixed(1) + '%' : 'left:' + (50 - half).toFixed(1) + '%;width:' + half.toFixed(1) + '%');
      var txt = v == null ? '--' : Math.abs(v).toFixed(1);
      var tag = name === '储能' ? (v == null ? '' : (Math.abs(v) < .5 ? '待' : v < 0 ? '充' : '放'))
        : name === '关口' ? (v == null ? '' : (Math.abs(v) < .3 ? '待' : v >= 0 ? '取' : '送')) : '';
      return '<div class="jy-bal-row"><span class="jl">' + label + '</span>'
        + '<div class="jy-bal-track"><i class="zero"></i><i class="fill ' + cls + (pos ? '' : ' neg') + '" style="' + style + '"></i></div>'
        + '<b class="' + cls + '">' + txt + '<u>kW</u></b>'
        + (tag ? '<em>' + tag + '</em>' : '') + '</div>';
    }
    return '<div class="jy-balance">'
      + '<div class="jy-bal-title"><span>功率平衡</span><em>0 轴 · 充放 / 取送方向</em></div>'
      + row('光伏', pv, 'pv', '光伏')
      + row('储能', S.power, S.power != null && S.power < -.5 ? 'chg' : 'sto', '储能')
      + row('关口', S.grid, S.grid != null && S.grid < 0 ? 'sell' : 'grid', '关口')
      + row('负荷', S.load, 'load', '负荷')
      + '</div>';
  }

  /* 机组卡：每群一张（光伏 / 储能 / SOC 条 / 关口），替代原来的纯文字表 */
  function groupCardsHtml(S) {
    var pvG = pvGroups();
    var h = '<div class="jy-grps">';
    for (var i = 0; i < 3; i++) {
      var g = (stor && stor.groups && stor.groups[i]) || {};
      var pv = pvG ? pvG[i] : null;
      var soc = g.soc == null ? null : +g.soc;
      var run = g.power == null ? '' : (g.power < -.5 ? 'chg' : (g.power > .5 ? 'dis' : ''));
      var alm = (g.alarms || []).length;
      var nCab = STOR_GROUPS[i] ? STOR_GROUPS[i].cabinets : 1;
      h += '<div class="jy-grp' + (g.online ? '' : ' off') + (alm ? ' bad' : '') + '">'
        + '<div class="jy-grp-head"><i class="jy-dot' + (g.online ? ' on' : '') + '"></i>'
        + '<b>' + GN[i] + '</b><span>' + (g.dev || '--') + ' · ' + nCab + ' 柜</span>'
        + (alm ? '<em class="jy-alarm">告警 ' + alm + '</em>' : '')
        + '</div>'
        + '<div class="jy-soc"><span>SOC</span><b>' + (soc == null ? '--' : Math.round(soc) + '%') + '</b>'
        + '<div class="jy-soc-bar"><i class="' + run + '" style="width:' + (soc == null ? 0 : Math.max(0, Math.min(100, soc))) + '%"></i></div></div>'
        + '<div class="jy-grp-metrics">'
        + '<span>光伏 <b>' + (pv && pv.kw != null ? fmt(pv.kw, 1) : '--') + '<u>kW</u></b>'
        + (pv && pv.today != null ? '<em>今 ' + fmt(pv.today, 0) + ' 度</em>' : '') + '</span>'
        + '<span>储能 <b class="' + run + '">' + (g.power == null ? '--' : (g.power > .5 ? '放 ' : g.power < -.5 ? '充 ' : '待机 ') + Math.abs(g.power).toFixed(1)) + '<u>kW</u></b></span>'
        + '<span>关口 <b>' + (g.gridP == null ? '--' : (g.gridP >= 0 ? '取 ' : '送 ') + Math.abs(g.gridP).toFixed(1)) + '<u>kW</u></b></span>'
        + '</div></div>';
    }
    return h + '</div>';
  }

  function renderOverview() {
    var p = byId('jyPanel');
    if (!p) return;
    var s = st(), S = storSum();
    pushHist(S);
    var pvG = pvGroups();
    var stVal = S.power == null ? '--' : Math.abs(S.power).toFixed(1);
    var stSub = S.power == null ? ('高特 CCU · ' + S.online + '/' + (S.count || 3) + ' 台在线')
      : ((S.power > 0 ? '放电中' : S.power < 0 ? '充电中' : '待机') + ' · ' + S.online + '/' + (S.count || 3) + ' 台在线');
    var h = '<div class="panel"><div class="panel-title"><span>系统概况</span><em>' + srcTag() + '</em></div>'
      + '<div class="kpi-grid">'
      + kpi('光伏功率', fmt(s.power_kw, 1), 'kW',
        s.device_power_kw == null ? (STATION.pvKwp + ' / ' + STATION.pvInv)
          : ('设备合计 ' + fmt(s.device_power_kw, 1) + ' kW · ' + STATION.pvKwp), '', KICON.pv)
      + kpi('储能功率', stVal, 'kW', stSub,
        S.power == null ? '' : (S.power < -.5 ? 'chg' : S.power > .5 ? 'dischg' : ''), KICON.bat)
      + kpi('SOC', S.soc == null ? '--' : S.soc.toFixed(0), '%', '按柜数加权', '', KICON.soc)
      + kpi('负荷', S.load == null ? '--' : S.load.toFixed(1), 'kW', '光伏+储能+关口 合成', '', KICON.load)
      + kpi('关口表', S.grid == null ? '--' : Math.abs(S.grid).toFixed(1), 'kW',
        S.grid == null ? '正=取电 / 负=送电' : (S.grid >= 0 ? '取电中' : '送电中') + ' · 正=取 / 负=送', '', KICON.grid)
      + kpi('今日发电', fmt(s.today_kwh, 1), 'kWh',
        s.total_kwh == null ? '' : ('累计 ' + fmt(s.total_kwh, 0) + ' 度'), '', KICON.day)
      + '</div>'
      + powerBalanceHtml(s, S, pvG)
      + '</div>';
    h += '<div class="panel"><div class="panel-title"><span>机组</span><em>'
      + (S.online ? (S.online + ' / ' + (S.count || 3) + ' 台在线 · 光伏按 01/02/03 归组') : '高特数据未连接') + '</em></div>'
      + groupCardsHtml(S) + '</div>';
    h += '<div class="panel"><div class="panel-title"><span>储能功率趋势</span><em>本次会话 · kW / SOC%</em></div>'
      + '<div class="jy-spark">' + sparkSvg() + '</div></div>';
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
      + '<span class="gv3-ring-label">储能 SOC</span></div>';
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
  var CLU_ST = { 0: '停机', 1: '充电', 2: '放电', 3: '待机', 4: '故障' };
  var MODE_ST = { 0: '子系统', 1: '计划', 2: '总指令' };
  var DRIER_ST = { 0: '待机', 1: '正在除湿', 2: '外部温度传感器故障', 3: '冷面温度传感器故障', 4: '热面温度传感器故障', 5: '外部环境温度过高', 6: '温度环境温度过高' };
  /* 东明同款 8 个储能指标（每群 / 全站汇总共用同一套标签） */
  function heroKpis(g) {
    var p = g.power;
    var chg = g.maxChg == null ? null : Math.abs(g.maxChg);
    return gvKpi('储能功率', p == null ? '--' : fmt(p, 1), 'kW',
        p == null ? '' : (p < 0 ? '充电中' : (p > 0 ? '放电中' : '待机')),
        p == null ? '' : (p < 0 ? 'chg' : (p > 0 ? 'dischg' : '')))
      + gvKpi('允许充电功率', fmt(chg, 0), 'kW', '')
      + gvKpi('允许放电功率', fmt(g.maxDis, 0), 'kW', '')
      + gvKpi('电池总节数', fmt(g.cellSums, 0), '节', '')
      + gvKpi('可充电量', fmt(g.enChg, 1), 'kWh', '')
      + gvKpi('可放电量', fmt(g.enDis, 1), 'kWh', '')
      + gvKpi('平均温度', fmt(g.avgTemp, 1), '℃', '')
      + gvKpi('最高单体', fnum(g.maxCellV, 3), 'V', '');
  }
  function badgeHtml(k, v, cls, title) {
    return '<div class="gv3-badge"' + (title ? ' title="' + title + '"' : '') + '><span>' + k + '</span>'
      + '<b class="v ' + (cls || '') + '">' + v + '</b></div>';
  }
  /* 东明同款 4 个状态徽章；全站汇总时把各群不同的值并列显示。
     充电 / 放电用颜色区分（蓝 / 青），不再是清一色白字。 */
  function heroBadges(g) {
    var sys = g.sysStatus == null ? '--' : ('状态码 ' + g.sysStatus);
    var ctrl = g.ctrl == null ? '--' : (g.ctrl === 1 ? '远程' : (g.ctrl === 0 ? '本地' : '其他'));
    var mode = g.modCod == null ? '--' : (MODE_ST[g.modCod] || g.modCod);
    var run = g.runStatus == null ? '--' : ({ 0: '静置', 1: '充电', 2: '放电' }[g.runStatus] || ('状态码 ' + g.runStatus));
    var runCls = g.runStatus === 1 ? 'chg' : (g.runStatus === 2 ? 'dis' : '');
    return '<div class="gv3-badges">'
      + badgeHtml('系统状态', sys, '', '协议点表未定义该点枚举，暂不判定正常/异常')
      + badgeHtml('控制源', ctrl, g.ctrl === 1 ? 'ok' : 'warn')
      + badgeHtml('指令模式', mode, '')
      + badgeHtml('电池状态', run, runCls)
      + '</div>';
  }
  function groupTitle(g) { return g.name + ' · ' + g.dev + '（' + g.cabinets + ' 柜）'; }
  function groupChip(g) {
    if (!stor) return '高特数据未连接';
    if (g.missing) return '无数据';
    var nAlm = (g.alarms || []).length;
    return (g.online ? ('在线 · 更新 ' + fmtTime(g.lastSeen)) : ('离线 · 最后 ' + fmtTime(g.lastSeen)))
      + (nAlm ? ' <i class="jy-chip-alarm">告警 ' + nAlm + '</i>' : '');
  }

  /* 电池簇卡（东明同款颜色语言）：状态点 + SOC 进度条 + 关键值 */
  function clusterCards(g) {
    var list = g.clusters || [];
    if (!list.length) return '<div class="gv3-empty">暂无电池簇数据</div>';
    return '<div class="gv3-stack-row">' + list.map(function (c, i) {
      var v = c.vals || {};
      var st = n(v.cluStatus);
      var cls = st === 1 ? 'chg' : (st === 2 ? 'dis' : (st === 4 ? 'fault' : ''));
      var dot = st === 4 ? 'warn' : (st === 1 ? 'chg' : (st === 2 ? 'dis' : ''));
      var soc = n(v.cluSoc);
      return '<div class="gv3-stack' + (st === 4 ? ' fault' : '') + '">'
        + '<div class="gv3-shead"><b>电池簇 ' + (i + 1) + '</b>'
        + '<span class="gv3-dot ' + dot + '">' + (st == null ? '--' : (CLU_ST[st] || ('状态' + st))) + '</span></div>'
        + '<div class="jy-clu">'
        + '<div class="jy-batt"><div class="jy-batt-shell"><i class="' + cls + (st === 1 || st === 2 ? ' on' : '')
        + '" style="height:' + (soc == null ? 0 : Math.max(0, Math.min(100, +soc))).toFixed(1) + '%"></i></div>'
        + '<b>' + (soc == null ? '--' : Math.round(soc)) + '<u>%</u></b><span>SOC</span></div>'
        + '<div class="jy-clu-body">'
        + '<div class="gv3-socnum"><span>SOC ' + fnum(soc, 1, '%') + '</span><em>SOH ' + fnum(v.clusoh, 0, '%') + '</em></div>'
        + '<div class="gv3-skv">'
        + kvRow('总电压', fnum(v.cluVol, 1, ' V'))
        + kvRow('电流', fnum(v.cluCur, 1, ' A'))
        + kvRow('实时功率', fnum(v.cluRtPower, 1, ' kW'))
        + kvRow('温度 高/低', fnum(v.maxCellTem, 0, '') + ' / ' + fnum(v.minCellTem, 0, ' ℃'))
        + kvRow('单体 高/低', fnum(v.maxCellVol, 3, '') + ' / ' + fnum(v.minCellVol, 3, ' V'))
        + kvRow('今日充 / 放', fnum(v.cludaychg_cap, 1, '') + ' / ' + fnum(v.cludaydis_cap, 1, ' 度'))
        + kvRow('累计充 / 放', fnum(v.cluSumsChaElec, 0, '') + ' / ' + fnum(v.cluSumsDischgElec, 0, ' 度'))
        + kvRow('可充 / 可放', fnum(v.cluRechaElec, 1, '') + ' / ' + fnum(v.cluRedischgElec, 1, ' 度'))
        + '</div></div></div></div>';
    }).join('') + '</div>';
  }

  /* 单体电芯色带：同东明的取样条（一簇 60 段、多簇并排 30 段），电压高处偏绿、低处偏蓝。
     温度 / 电压数组里的 65535 是未接传感器占位，必须当"无数据"。 */
  function cellStrips(g, list) {
    list = list || instOf(g.ccu, 'cell');
    if (!list.length) return '';
    var ok = function (v) { return typeof v === 'number' && isFinite(v) && v >= 0 && v < 1000; };
    var nums = function (a) { return (a || []).filter(ok); };
    var boxes = list.map(function (c, idx) {
      var v = c.vals || {};
      var vol = Array.isArray(v.CelVol) ? v.CelVol : [];
      var tem = Array.isArray(v.CelTem) ? v.CelTem : [];
      var celSoc = Array.isArray(v.CelSOC) ? v.CelSOC : [];
      var cnt = Math.max(vol.length, tem.length);
      if (!cnt) return '';
      var vv = nums(vol), tt = nums(tem), ss = nums(celSoc);
      var vMin = vv.length ? Math.min.apply(null, vv) : null;
      var vMax = vv.length ? Math.max.apply(null, vv) : null;
      /* 一簇占满整行时用 60 段，不然每段宽得像色块；多簇并排仍用 30 段 */
      var SEG = (list.length <= 1 ? 60 : 30), strip = '';
      for (var s = 0; s < SEG; s++) {
        var from = Math.floor(s * cnt / SEG), to = Math.max(from + 1, Math.floor((s + 1) * cnt / SEG));
        var vs = nums((vol || []).slice(from, to));
        var ts = nums((tem || []).slice(from, to));
        var style = 'class="cs' + (vs.length ? '' : ' na') + '"';
        if (vs.length) {
          var avg = vs.reduce(function (a, b) { return a + b; }, 0) / vs.length;
          var k = (avg - (vMin === null ? avg : vMin)) / (((vMax - vMin) || 1));
          var hue = 205 - 165 * Math.max(0, Math.min(1, k));
          style += ' style="background:hsl(' + hue.toFixed(0) + ',70%,58%)"';
        }
        strip += '<i ' + style + ' title="第 ' + (from + 1) + '~' + to + ' 节　电压 '
          + (vs.length ? (Math.min.apply(null, vs) * 1000).toFixed(0) + '~' + (Math.max.apply(null, vs) * 1000).toFixed(0) + ' mV' : '--')
          + (ts.length ? '　温度 ' + Math.min.apply(null, ts).toFixed(1) + '~' + Math.max.apply(null, ts).toFixed(1) + ' ℃' : '') + '"></i>';
      }
      return '<div class="heat-box">'
        + '<div class="heat-meta"><b>簇 ' + (idx + 1) + ' · ' + cnt + ' 节</b><span class="hm-stat">'
        + (vv.length ? ('电压 ' + (vMin * 1000).toFixed(0) + '~' + (vMax * 1000).toFixed(0) + ' mV') : '电压 --')
        + '　' + (tt.length ? ('温度 ' + Math.min.apply(null, tt).toFixed(1) + '~' + Math.max.apply(null, tt).toFixed(1) + ' ℃') : '温度 --')
        + (tt.length && tt.length < cnt ? '（' + (cnt - tt.length) + ' 节未接）' : '')
        + (ss.length ? '　单体SOC ' + Math.min.apply(null, ss).toFixed(0) + '~' + Math.max.apply(null, ss).toFixed(0) + ' %' : '')
        + '</span></div><div class="cell-strip">' + strip + '</div></div>';
    }).filter(Boolean).join('');
    if (!boxes) return '';
    return '<div class="heat-wrap" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr))">' + boxes + '</div>';
  }
  /* 机组头部：与旭日东明同版式（SOC 环 + 8 指标 + 4 徽章） */
  function groupHero(g) {
    return '<div class="gv3-hero">' + socRing(g.soc == null ? null : +g.soc)
      + '<div class="gv3-kpis">' + heroKpis(g) + '</div>' + heroBadges(g) + '</div>';
  }
  function groupBody(g) {
    var cluBox = clusterCards(g);
    var cellList = instOf(g.ccu, 'cell');
    var cellBox = cellStrips(g, cellList);
    var cellCnt = cellList.length;
    var cellN = (cellList[0] && Array.isArray(cellList[0].vals.CelVol)) ? cellList[0].vals.CelVol.length : null;
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
    /* 储能表（AEMS）现场只发了状态帧、没有数据帧，两行 -- 长期占位，按规矩撤掉；
       储能功率本来就用 EMS 的 PCS 汇总，不影响读数 */
    var meterStat = kvBox([
      ['今日充 / 放', fnum(g.dayChg, 1, '') + ' / ' + fnum(g.dayDis, 1, ' 度')],
      ['关口 · 实时功率', g.gridP == null ? '--' : ((g.gridP >= 0 ? '取电 ' : '送电 ') + Math.abs(g.gridP).toFixed(1) + ' kW')],
      ['关口 · 正向 / 反向电量', fnum(g.gridE1, 0, '') + ' / ' + fnum(g.gridE2, 0, ' kWh')],
      ['系统状态码', g.sysStatus == null ? '--' : ('状态码 ' + g.sysStatus + '（点表未定义枚举，不判正常/异常）')],
      ['控制源 / 电池节数', (g.ctrl == null ? '--' : (g.ctrl === 1 ? '远程' : g.ctrl === 0 ? '本地' : '其他')) + '　' + fnum(g.cellSums, 0, ' 节')]
    ]);
    var alarmList = (g.alarms || []).map(function (a) {
      return '<div class="sl-dev"><div class="sl-devmain"><b>' + (a.name || '告警') + '</b>'
        + '<span>' + (a.dim || '') + (a.inst ? (' · ' + a.inst) : '') + '</span></div><i class="sl-badge warn">告警</i></div>';
    }).join('');
    return '<div class="ov-grid" style="margin-top:12px">'
      + sec('sp12', '电池簇', (g.clusters || []).length + ' 簇 · SOC 色带', cluBox)
      + (cellBox ? sec('sp12', '单体电芯', cellCnt + ' 簇' + (cellN ? ' · 每簇 ' + cellN + ' 节' : '') + ' · 电压色带', cellBox) : '')
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
    /* 顶部储能总览：标签口径与旭日东明一致（8 指标 + 4 徽章），全站为三群汇总 */
    var head = sec('sp12', '储能总览', '高特 CCU · 三套机组',
      '<div class="gv3-hero">' + socRing(S.soc == null ? null : +S.soc)
      + '<div class="gv3-kpis">' + heroKpis(S) + '</div>'
      + '<div class="gv3-badges">'
      + badgeHtml('系统状态', S.sysStatus || '--', '', '协议点表未定义该点枚举，暂不判定正常/异常')
      + badgeHtml('控制源', S.ctrl || '--', S.ctrl === '远程' ? 'ok' : 'warn')
      + badgeHtml('指令模式', S.modCod || '--', '')
      + badgeHtml('电池状态', S.runStatus || '--',
        String(S.runStatus || '').indexOf('充电') >= 0 ? 'chg' : (String(S.runStatus || '').indexOf('放电') >= 0 ? 'dis' : ''))
      + '</div></div>'
      + '<div class="jy-note">全站三群汇总：功率 / 电量 / 节数相加，SOC 与温度按柜数加权，单体取最高；'
      + '各群状态值不同时并列显示。数据源：高特 CCU（浏览器 MQTT，30 秒上报）。'
      + '分群光伏按逆变器 01/02/03 前缀归组（2026-10-31 确认）；6/7号柜 ↔ 一号/二号的对应关系待厂家确认。</div>');
    var list = (stor && stor.groups) || [];
    body.innerHTML = '<div class="dt-body">' + head + list.map(function (g) {
      return sec('sp12', groupTitle(g), groupChip(g), groupHero(g) + groupBody(g));
    }).join('')
      + (list.length ? '' : sec('sp12', '储能', '未连接', '<div class="gv3-empty">储能数据源未连接：请在「数据源」面板填入 lichu_web 账号连接 MQTT。</div>'))
      + '</div>';
    if (view) view.scrollTop = keepView;
    body.scrollTop = keepTop;
  }

  /* 光伏页：版式与洙边一致（实时概览 / 发电趋势 / 天气 / 设备 / 减排贡献 / 电站信息），数据用峻涌的 */
  function rangeBtns() {
    var opts = [['today', '今日'], ['yesterday', '昨日'], ['days3', '近三日']];
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
          + '　数据 ' + (d.device_time ? fmtDevTime(d.device_time).slice(6) : '--'))
        : ('数据 ' + (d.device_time ? fmtDevTime(d.device_time).slice(6) : '--'));
      return '<div class="sl-dev"><div class="sl-devmain"><b>' + (d.name || d.sn) + '</b>'
        + '<span>' + (TYPE[d.type] || ('类型 ' + d.type)) + '　' + (d.model || '') + '　SN ' + (d.sn || '') + '</span>'
        + '<span style="display:block;margin-top:2px">' + extra + '</span></div>'
        + '<i class="sl-badge' + (ds === '正常' ? '' : ' warn') + '">' + ds + '</i></div>';
    }).join('') + '</div>';
  }
  /* 洙边同款 KPI 卡（.kpi-grid 用） */
  function card(label, value, unit, sub, cls) {
    return '<div class="kpi ' + (cls || '') + '">'
      + '<div class="kpi-body">'
      + '<div class="kpi-num' + (cls === 'hi' ? '' : ' sm') + '"><b>' + value + '</b>' + (unit ? '<u>' + unit + '</u>' : '') + '</div>'
      + '<div class="kpi-label">' + label + '</div>'
      + (sub ? '<div class="sl-ks">' + sub + '</div>' : '')
      + '</div></div>';
  }
  /* 洙边同款减排三行（按光伏累计电量折算） */
  function greenHtml() {
    var s = st();
    var tKwh = s.total_kwh;
    var co2 = tKwh == null ? null : tKwh * CO2_PER_KWH;
    var coal = tKwh == null ? null : tKwh * COAL_PER_KWH;
    var trees = co2 === null ? null : Math.round(co2 * TREE_PER_KG);
    return '<div class="sl-green-row"><b>' + fmt(co2 === null ? null : co2 / 1000, 2) + '</b><u>吨</u><span>CO₂ 减排量</span></div>'
      + '<div class="sl-green-row"><b>' + fmt(coal === null ? null : coal / 1000, 2) + '</b><u>吨</u><span>节约标准煤</span></div>'
      + '<div class="sl-green-row"><b>' + (trees === null ? '--' : trees) + '</b><u>棵</u><span>等效植树</span></div>';
  }
  /* 洙边同款电站信息行（字段名一致，值为峻涌的） */
  function pvInfoHtml() {
    var s = st();
    var rows = [
      ['电站名称', STATION.name],
      ['电站类型', s.type || '分布式光伏'],
      ['装机容量', s.capacity ? fmt(s.capacity, 2) + ' kWp' : '--'],
      ['电站地址', s.location || '--'],
      ['并网日期', s.install_date ? String(s.install_date).slice(0, 10) : '--'],
      ['电站编号', s.ps_id ? ('ps_id ' + s.ps_id) : '--'],
      ['告警 / 故障', (n(s.alarms) === null ? '--' : String(s.alarms)) + ' / 0'],
      ['数据更新', s.updated_at ? fmtTime(s.updated_at) : '--']
    ];
    return rows.map(function (r) { return '<div class="sl-row"><span>' + r[0] + '</span><b>' + r[1] + '</b></div>'; }).join('');
  }
  function renderSolarPage() {
    var box = byId('jySolarBody');
    if (!box) return;
    var s = st();
    var cap = s.capacity;
    var co2 = s.total_kwh == null ? null : s.total_kwh * CO2_PER_KWH;         /* kg */
    var trees = co2 === null ? null : Math.round(co2 * TREE_PER_KG);
    var invs = (devices || []).filter(function (d) { return Number(d.type) === 1; });
    var comms = (devices || []).filter(function (d) { return Number(d.type) !== 1; });
    var invOn = invs.filter(function (d) { return d.online !== false && d.fault_status !== 1; }).length;
    var kpis = '<div class="kpi-grid">'
      + card('实时功率', fmt(s.power_kw, 2), 'kW', cap ? ('装机 ' + fmt(cap, 2) + ' kWp') : '', 'hi')
      + card('当日发电', fmt(s.today_kwh, 1), '度', n(s.hours) === null ? '' : ('等效 ' + fmt(s.hours, 2) + ' 小时'))
      + card('今日等效小时', fmt(s.hours, 2), 'h', cap ? ('按 ' + fmt(cap, 2) + ' kWp 折算') : '')
      + card('累计发电', fmt(s.total_kwh, 0), '度', s.install_date ? ('并网 ' + String(s.install_date).slice(0, 10)) : '')
      + card('装机容量', fmt(cap, 2), 'kWp', s.type || '分布式光伏')
      + card('CO₂减排', fmt(co2 === null ? null : co2 / 1000, 2), '吨', trees === null ? '' : ('等效植树 ' + trees + ' 棵'))
      + card('设备在线', invs.length ? (invOn + ' / ' + invs.length) : '--', '台',
        invs.length ? (invs.length + ' 台逆变器 · ' + comms.length + ' 台通信模块') : '设备清单读取中')
      + card('告警', n(s.alarms) === null ? '--' : String(n(s.alarms)), '条', '阳光云实时')
      + '</div>';
    box.innerHTML = '<div class="dt-body">'
      + '<div class="panel"><div class="panel-title"><span>实时概览</span><em>' + srcTag() + '</em></div>'
      + kpis
      + '<div class="jy-note">“实时功率 / 当日发电”为电站口径（与阳光云概览一致）；设备级明细见「设备」。'
      + '机组表与三维的分群光伏按逆变器 01/02/03 前缀归组；结算收益 / 卖电收入本站没有数据源，不摆占位卡。</div></div>'
      + '<div class="panel grow"><div class="panel-title"><span>发电趋势</span><em id="jyTrendMeta">--</em>' + rangeBtns() + '</div>'
      + '<div class="dt-chart" id="jyTrendChart"></div></div>'
      + '<div class="ov-grid">'
      + sec('sp6', '天气', 'Open-Meteo', weatherHtml())
      + sec('sp6', '设备', devices.length ? (devices.length + ' 台 · 设备级') : '--', devicesHtml())
      + sec('sp6', '减排贡献', '累计 · 折算', greenHtml())
      + sec('sp6', '电站信息', '', pvInfoHtml())
      + '</div></div>';
    renderTrendChart();
  }
  function trendPts(data) {
    return (data || []).filter(function (p) { return n(p.power_kw) !== null || n(p.daily_yield_kwh) !== null; });
  }
  /* 光伏曲线：光伏页与「详细信息」页各一份实例，同款式同主题 */
  function paintTrend(inst, el, pts) {
    if (!el || typeof echarts === 'undefined') return inst;
    if (inst && inst.getDom() !== el) { try { inst.dispose(); } catch (_) {} inst = null; }
    if (!inst) {
      inst = echarts.init(el);
      inst.setOption({
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
    }
    var ax = isDay() ? '#3d5c5a' : '#6b9490';
    inst.setOption({
      xAxis: { axisLabel: { color: ax } },
      yAxis: [{ axisLabel: { color: ax } }, { axisLabel: { color: ax } }],
      series: [
        { data: pts.map(function (p) { return [p.t, n(p.power_kw)]; }) },
        { data: pts.filter(function (p) { return n(p.daily_yield_kwh) !== null; }).map(function (p) { return [p.t, n(p.daily_yield_kwh)]; }) }
      ]
    }, false, true);
    return inst;
  }
  function renderTrendChart() {
    var el = byId('jyTrendChart');
    var meta = byId('jyTrendMeta');
    if (!el) return;
    if (typeof echarts === 'undefined') { if (meta) meta.textContent = '图表库加载中…'; return; }
    var pts = trendPts(trend);
    chart = paintTrend(chart, el, pts);
    if (meta) {
      var peak = pts.reduce(function (m, p) { return Math.max(m, n(p.power_kw) || 0); }, 0);
      var day = pts.reduce(function (m, p) { return Math.max(m, n(p.daily_yield_kwh) || 0); }, 0);
      meta.textContent = pts.length
        ? (pts.length + ' 点 · 峰值 ' + fmt(peak, 2) + ' kW' + (day ? (' · 单日最高 ' + fmt(day, 1) + ' 度') : ''))
        : '暂无数据（接入后每 5 分钟累积一个点）';
    }
  }
  function renderRevChart() {
    var el = byId('jyRevChart');
    if (!el || typeof echarts === 'undefined') return;
    revChart = paintTrend(revChart, el, trendPts(revTrend));
  }
  function loadRevTrend() {
    getJSON('trend?range=days3', { tries: 1, timeout: 8000 }).then(function (t) {
      revTrend = (t && t.points) || null;
    }).catch(function () { revTrend = null; }).then(function () {
      renderInfoPage();
    });
  }
  function applyChartTheme() {
    var ax = isDay() ? '#3d5c5a' : '#6b9490';
    [chart, revChart].forEach(function (c) {
      if (!c) return;
      c.setOption({
        xAxis: { axisLabel: { color: ax } },
        yAxis: [{ axisLabel: { color: ax } }, { axisLabel: { color: ax } }]
      });
    });
  }

  /* 详细信息页：只放真实有源的数据。结算收益 / 关口日电量 / 卖电收入本站没有数据源，
     不再摆一排"--"占位卡；光伏 = 阳光云，关口与储能 = 高特 CCU。 */
  function renderInfoPage() {
    var box = byId('jyInfoBody');
    if (!box) return;
    var s = st(), S = storSum();
    var co2 = s.total_kwh == null ? null : s.total_kwh * CO2_PER_KWH;
    var coal = s.total_kwh == null ? null : s.total_kwh * COAL_PER_KWH;
    var trees = co2 === null ? null : Math.round(co2 * TREE_PER_KG);

    var totalGroups = S.count || 3;
    var e1Part = S.gridE1Known < totalGroups, e2Part = S.gridE2Known < totalGroups;
    var missingE = [];
    ((stor && stor.groups) || []).forEach(function (g, gi) {
      if (g.gridE1 == null || g.gridE2 == null) missingE.push(GN[gi]);
    });
    var gridTiles = '<div class="gv3-flow">'
      + gvTile('关口 · 实时功率', fmt(S.grid, 1), 'kW',
        S.grid == null ? '' : (S.grid >= 0 ? '取电' : '送电') + ' · 三群合计', 'grid')
      + gvTile('累计取电', fmt(S.gridE1, 0), '度',
        e1Part ? (S.gridE1Known + '/' + totalGroups + ' 群有读数 · 正向') : '三群关口 · 正向',
        e1Part ? 'grid partial' : 'grid')
      + gvTile('累计馈电', fmt(S.gridE2, 0), '度',
        e2Part ? (S.gridE2Known + '/' + totalGroups + ' 群有读数 · 反向') : '三群关口 · 反向',
        e2Part ? 'pcs partial' : 'pcs')
      + gvTile('今日储能充电', fmt(S.dayChg, 1), '度', '高特 CCU · ' + S.dayKnown + '/3 群', 'ess')
      + gvTile('今日储能放电', fmt(S.dayDis, 1), '度', '高特 CCU · ' + S.dayKnown + '/3 群', 'ess')
      + gvTile('实时储能功率', fmt(S.power, 1), 'kW',
        S.power == null ? '' : (S.power > .5 ? '放电中' : S.power < -.5 ? '充电中' : '待机'), 'ess')
      + gvTile('今日光伏发电', fmt(s.today_kwh, 1), '度', '阳光云', 'pv')
      + gvTile('实时光伏功率', fmt(s.power_kw, 2), 'kW', '阳光云', 'pv')
      + '</div>';

    var pvTiles = '<div class="gv3-flow" style="grid-template-columns:repeat(2,minmax(0,1fr))">'
      + gvTile('实时功率', fmt(s.power_kw, 2), 'kW', '阳光云', 'pv')
      + gvTile('今日发电', fmt(s.today_kwh, 1), '度', '阳光云', 'pv')
      + gvTile('累计发电', fmt(s.total_kwh, 0), '度', '阳光云', 'pv')
      + gvTile('今日等效小时', fmt(s.hours, 2), 'h', '阳光云', 'pv')
      + '</div>';

    var storTiles = '<div class="gv3-flow">'
      + gvTile('实时功率', fmt(S.power, 1), 'kW', S.power == null ? '' : (S.power > .5 ? '放电' : S.power < -.5 ? '充电' : '待机'), 'ess')
      + gvTile('SOC', fmt(S.soc, 0), '%', '按柜数加权', 'ess')
      + gvTile('可充 / 可放', fnum(S.enChg, 0) + ' / ' + fnum(S.enDis, 0), 'kWh', '高特 CCU', 'ess')
      + gvTile('允许充 / 放', fnum(S.maxChg, 0) + ' / ' + fnum(S.maxDis, 0), 'kW', '高特 CCU', 'ess')
      + gvTile('在线', S.online + ' / ' + (S.count || 3), '台', storConn() ? 'MQTT 已连接' : 'MQTT 未连接', 'ess')
      + '</div>';

    var green = '<div class="sl-green">'
      + '<div class="sl-green-row"><b>' + fmt(co2 === null ? null : co2 / 1000, 2) + '</b><u>吨</u><span>CO₂ 减排量</span></div>'
      + '<div class="sl-green-row"><b>' + fmt(coal === null ? null : coal / 1000, 2) + '</b><u>吨</u><span>节约标准煤</span></div>'
      + '<div class="sl-green-row"><b>' + (trees === null ? '--' : trees) + '</b><u>棵</u><span>等效植树</span></div>'
      + '</div><div class="jy-note" style="margin-top:8px">按阳光云累计发电折算（0.997 kg CO₂ / 度、0.404 kg 标准煤 / 度）。</div>';

    box.innerHTML = '<div class="dt-body">'
      + sec('sp12', '发用电汇总', '高特关口表 + 高特 CCU + 阳光云', gridTiles)
      + sec('sp12', '近 3 日光伏发电', (revTrend && revTrend.length ? revTrend.length + ' 点 · 阳光云' : '--'),
        '<div class="dt-chart" id="jyRevChart"></div>')
      + '<div class="ov-grid">'
      + sec('sp4', '减排贡献', '阳光云累计', green)
      + sec('sp4', '光伏发电', '阳光云口径', pvTiles)
      + sec('sp4', '储能', '高特 CCU 口径', storTiles)
      + '</div>'
      + '<div class="jy-note">光伏 = 阳光云（全站口径，机组表与三维按逆变器 01/02/03 前缀归组）；'
      + '关口 / 储能 = 高特 CCU 实时数据。本站没有结算数据源，收益类数字不展示、不估算。'
      + (missingE.length ? (missingE.join('、') + '关口电表未上报累计电量，累计取 / 馈电只按有读数机组合计。') : '')
      + '</div>'
      + '</div>';
    renderRevChart();
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
    var S = storSum(), nAlm = 0, almNames = [];
    ((stor && stor.groups) || []).forEach(function (g, gi) {
      (g.alarms || []).forEach(function (a) {
        nAlm++;
        var key = GN[gi] + ' · ' + (a.name || '告警');
        if (almNames.indexOf(key) < 0) almNames.push(key);
      });
    });
    if (!storWired() || !storConn()) parts.push('储能数据源未连接（数据源面板填 lichu_web 连接）');
    else parts.push('储能 ' + S.online + '/' + (S.count || 3) + ' 在线'
      + (nAlm ? (' · 告警 ' + nAlm + ' 条（' + almNames.slice(0, 2).join('、') + (almNames.length > 2 ? '…' : '') + '）') : ' · 无告警'));
    txt.textContent = parts.join('　·　');
    var bad = !!alarms || s.online === 0 || (age != null && age > 10) || !!lastErr || nAlm > 0;
    if (bar) bar.className = 'alarm ' + (bad ? 'bad' : 'ok');
  }

  /* 把数据推给三维场景：光伏只有全站合计（阳光云）→ setStationPv 驱动三栋屋面；
     分群光伏保持 --（不编分群数字）；储能 / SOC / 关口来自高特 CCU（正=放电；关口正=取电）。 */
  function pushScene() {
    if (!window.JunyongScene || !JunyongScene.ready()) return;
    var pvG = pvGroups();
    for (var i = 0; i < 3; i++) {
      var g = (stor && stor.groups && stor.groups[i]) || {};
      var pv = pvG ? pvG[i] : null;
      JunyongScene.setGroup(i, {
        pv: pv && pv.kw != null ? pv.kw : null,
        pvSeen: !!(pv && pv.kw != null),
        pvToday: pv && pv.today != null ? pv.today : null,
        pvCount: pv ? pv.n : null,
        st: g.power == null ? null : +g.power,
        soc: g.soc == null ? null : +g.soc,
        grid: g.gridP == null ? null : +g.gridP,
        load: null,
        chg: g.dayChg == null ? null : +g.dayChg,
        dis: g.dayDis == null ? null : +g.dayDis,
        enChg: g.enChg, enDis: g.enDis,
        avgTemp: g.avgTemp, maxCellV: g.maxCellV, cellSums: g.cellSums,
        online: !!g.online, cabinets: STOR_GROUPS[i] ? STOR_GROUPS[i].cabinets : 1,
        dev: STOR_GROUPS[i] ? STOR_GROUPS[i].dev : ''
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
  /* 右栏展开时让三维画面左移半个面板宽，避免覆盖最右侧的三号厂房 */
  function syncSceneInset() {
    var jr = byId('jyRight');
    if (!jr) return;
    var on = jr.classList.contains('pinned');
    var vw = window.innerWidth || 1920;
    var pw = Math.min(460, Math.max(340, vw * .24));
    var strip = parseFloat(getComputedStyle(jr).getPropertyValue('--strip')) || 46;
    if (window.JunyongScene && JunyongScene.setViewInset) JunyongScene.setViewInset(on ? Math.round(pw + strip) : 0);
  }
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
      syncSceneInset();
      if (chart && tab === 'solar') chart.resize();
      if (revChart && tab === 'revenue') revChart.resize();
    });
    var jr = byId('jyRight');
    if (jr && window.MutationObserver) {
      new MutationObserver(syncSceneInset).observe(jr, { attributes: true, attributeFilter: ['class'] });
    }
    syncSceneInset();
    new MutationObserver(function () {
      setTimeout(function () {
        applyChartTheme();
        if (chart && tab === 'solar') chart.resize();
        if (revChart && tab === 'revenue') revChart.resize();
      }, 60);
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }
  return {
    open: open, hide: hide, refresh: refresh, bind: bind, info: STATION,
    init: function () { bind(); }
  };
})();
