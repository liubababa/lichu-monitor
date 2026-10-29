/* ============================================================
 * 山东峻涌光储电站 · 页面与数据层
 *
 *   门户「山东峻涌光储电站」卡片 → JunyongUI.open() → 独立视图 #jyView
 *   页签：电站监控（三维）/ 储能 / 光伏 / 详细信息（与洙边站同一套版式）
 *
 *   数据源（尚未接入，接入后改 CFG 即可）：
 *     pvApi   阳光电源 iSolarCloud 转发服务（洙边那套是 /solar/*，本站另起一路）
 *     storApi 储能数据源（协议待与厂家确认）
 *   期望报文：{ groups: [ {pv_kw, st_kw, soc, load_kw, grid_kw}, ... ], station: {...} }
 *   —— 正=放电 / 负=充电；grid_kw 正=取电 / 负=送电；光伏 null ≠ 0（没上报就别当 0）。
 *
 *   红线：页面上不许出现任何模拟数据。取不到就 --，并在数据源条上写明"未接入"。
 * ============================================================ */
window.JunyongUI = (function () {
  'use strict';

  var byId = function (id) { return document.getElementById(id); };
  var CFG = {
    pvApi: '/junyong/pv/',            /* 待接入：阳光云转发服务地址 */
    storApi: '/junyong/storage/',     /* 待接入：储能数据源地址 */
    refreshMs: 60000
  };
  var STATION = {
    name: '山东峻涌光储电站',
    pvKwp: '972.4kWp', pvInv: '820kW',
    stor: '625kW / 1305kWh',
    inv: '阳光电源逆变器',
    groups: ['一号机组 · 1 台光储一体柜', '二号机组 · 1 台光储一体柜', '三号机组 · 3 台光储一体柜'],
    grid: '三群各自关口，共用一座中心铁塔上网（品字围合）'
  };
  var GN = ['一号机组', '二号机组', '三号机组'];
  var timer = null, busyUntil = 0, tab = 'monitor';
  /* ?jtab=storage|solar|revenue 直达某个数据页（对图 / 值班快捷入口，界面上不加控件）。
     这里在模块加载时就读：门户的 ?station= 深链会比 init() 更早打开本页 */
  try {
    var QTAB = new URLSearchParams(location.search).get('jtab');
    if (QTAB) tab = QTAB;
  } catch (_) {}
  var payload = null;            /* 最近一次成功的数据；null = 从没拿到过 */
  var lastErr = '';

  function num(v, unit, dec) {
    if (v === null || v === undefined || v === '' || isNaN(+v)) return '--' + (unit || '');
    return (+v).toFixed(dec === undefined ? 1 : dec) + (unit || '');
  }
  function kpi(label, value, sub, cls) {
    return '<div class="kpi' + (cls ? ' ' + cls : '') + '"><span>' + label + '</span>'
      + '<b>' + value + '</b>' + (sub ? '<em>' + sub + '</em>' : '') + '</div>';
  }
  function getJSON(path, base) {
    return fetch((base || CFG.pvApi) + path, { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
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
    renderPanels();
    if (window.JunyongScene) JunyongScene.setActive(t === 'monitor');
  }

  /* ---------------- 数据 ---------------- */
  function refresh() {
    if (Date.now() < busyUntil) return;
    busyUntil = Date.now() + 50000;
    /* 两路各自独立取：哪路先接上就先出数，另一路继续 -- */
    getJSON('full').then(function (j) {
      if (j && (j.groups || j.station)) { payload = j; lastErr = ''; }
    }).catch(function (e) {
      lastErr = '数据源未接入（' + (e && e.message ? e.message : '请求失败') + '）';
    }).then(function () {
      renderPanels(); pushScene();
    });
  }
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
    var w = payload && payload.weather;
    if (w) JunyongScene.setWeather(w);
  }
  function groups() { return (payload && payload.groups) || []; }
  function st() { return (payload && payload.station) || {}; }

  /* ---------------- 面板渲染 ---------------- */
  function srcTag() {
    return payload ? '数据源：正常' : ('数据源：' + (lastErr || '未接入'));
  }
  function overviewPanel() {
    var s = st(), gs = groups();
    var sumPv = null, sumSt = null, sumLoad = null, sumGrid = null, soc = null, n = 0;
    gs.forEach(function (g) {
      if (g.pv_kw != null) sumPv = (sumPv || 0) + +g.pv_kw;
      if (g.st_kw != null) sumSt = (sumSt || 0) + +g.st_kw;
      if (g.load_kw != null) sumLoad = (sumLoad || 0) + +g.load_kw;
      if (g.grid_kw != null) sumGrid = (sumGrid || 0) + +g.grid_kw;
      if (g.soc != null) { soc = (soc == null ? 0 : soc) + +g.soc; n++; }
    });
    var h = '<div class="panel"><div class="panel-title"><span>系统概况</span><em>' + srcTag() + '</em></div>'
      + '<div class="kpi-grid">'
      + kpi('光伏功率', num(sumPv, ' kW'), STATION.pvKwp + ' / ' + STATION.pvInv)
      + kpi('储能功率', sumSt == null ? '-- kW' : (sumSt > 0 ? '放电 ' : sumSt < 0 ? '充电 ' : '待机 ') + Math.abs(sumSt).toFixed(1) + ' kW',
        STATION.stor)
      + kpi('SOC', soc == null || !n ? '-- %' : (soc / n).toFixed(0) + ' %', '三群平均')
      + kpi('负荷', num(sumLoad, ' kW'), '三群合计')
      + kpi('关口表', sumGrid == null ? '-- kW' : (sumGrid >= 0 ? '取电 ' : '送电 ') + Math.abs(sumGrid).toFixed(1) + ' kW',
        '正=取电 / 负=送电')
      + kpi('今日发电', num(s.today_kwh, ' kWh'), s.today_rev == null ? '' : '收益 ' + (+s.today_rev).toFixed(2) + ' 元')
      + '</div></div>';
    h += '<div class="panel grow"><div class="panel-title"><span>机组</span><em>' + gs.length + ' / 3 群有数据</em></div>'
      + '<table class="mq-table"><thead><tr><th>机组</th><th>光伏</th><th>储能</th><th>SOC</th><th>关口</th></tr></thead><tbody>';
    for (var i = 0; i < 3; i++) {
      var g = gs[i] || {};
      h += '<tr><td>' + GN[i] + '（' + (i === 2 ? 3 : 1) + ' 柜）</td><td>' + num(g.pv_kw, ' kW')
        + '</td><td>' + (g.st_kw == null ? '-- kW' : (g.st_kw > 0 ? '放 ' : g.st_kw < 0 ? '充 ' : '待机 ') + Math.abs(g.st_kw).toFixed(1))
        + '</td><td>' + num(g.soc, ' %', 0) + '</td><td>'
        + (g.grid_kw == null ? '--' : (g.grid_kw >= 0 ? '取 ' : '送 ') + Math.abs(g.grid_kw).toFixed(1)) + '</td></tr>';
    }
    h += '</tbody></table></div>';
    return h;
  }
  function renderPanels() {
    var p = byId('jyPanel');
    if (p) p.innerHTML = overviewPanel();
    var body = byId('jyStorBody');
    if (body) body.innerHTML = '<div class="panel grow"><div class="panel-title"><span>储能</span><em>'
      + srcTag() + '</em></div>'
      + '<div class="kpi-grid">'
      + kpi('额定功率', '625 kW', STATION.inv)
      + kpi('额定容量', '1305 kWh', '5 台光储一体柜')
      + kpi('实时功率', num((function () { var s = 0, has = false; groups().forEach(function (g) { if (g.st_kw != null) { s += +g.st_kw; has = true; } }); return has ? s : null; })(), ' kW'), '正=放电 / 负=充电')
      + kpi('SOC', '-- %', '三群平均')
      + '</div><div class="jy-note">机组构成：' + STATION.groups.join('、') + '。'
      + '储能数据源尚未接入，接入后本页补电池簇 / PCS / 液冷 / 曲线明细。</div></div>';
    var sb = byId('jySolarBody');
    if (sb) sb.innerHTML = '<div class="panel grow"><div class="panel-title"><span>光伏</span><em>'
      + srcTag() + '</em></div>'
      + '<div class="kpi-grid">'
      + kpi('装机容量', STATION.pvKwp, '逆变器 ' + STATION.pvInv)
      + kpi('实时功率', num(st().power_kw, ' kW'), STATION.inv)
      + kpi('今日发电', num(st().today_kwh, ' kWh'), '')
      + kpi('等效利用小时', '-- h', '')
      + '</div><div class="jy-note">光伏数据源（阳光电源 iSolarCloud）尚未配置本站 ps_id，'
      + '配好后本页出发电趋势 / 天气 / 设备清单。</div></div>';
    var ib = byId('jyInfoBody');
    if (ib) ib.innerHTML = '<div class="panel grow"><div class="panel-title"><span>电站信息</span><em>'
      + srcTag() + '</em></div>'
      + '<table class="mq-table"><tbody>'
      + row('电站名称', STATION.name)
      + row('装机容量 · 光伏', STATION.pvKwp + '（逆变器 ' + STATION.pvInv + '）')
      + row('装机容量 · 储能', STATION.stor)
      + row('逆变器', STATION.inv)
      + row('储能机组', STATION.groups.join('；'))
      + row('并网方式', STATION.grid)
      + row('三维场景', '三群品字围合 + 中心铁塔；走线与工况判据同洙边（九条线贴地敷设）')
      + row('数据源', payload ? '正常（最近刷新 ' + new Date().toTimeString().slice(0, 8) + '）'
        : '未接入 —— 待配置阳光云 ps_id 与储能数据源')
      + '</tbody></table>'
      + '<div class="jy-note">本页不放任何模拟数据：数据源未接入时所有实时值显示 --。</div></div>';
    var src = byId('jySrc');
    if (src) src.textContent = srcTag();
    var ab = byId('jyAlarmBar'), at = byId('jyAlarmText');
    if (ab && at) {
      at.textContent = payload ? ('数据源正常 · ' + STATION.name)
        : ('数据源未接入：' + (lastErr || '等待配置') + ' · 三维走线为待机态');
      ab.className = 'alarm ' + (payload ? 'ok' : 'warn');
    }
  }
  function row(k, v) {
    return '<tr><td style="color:var(--dim)">' + k + '</td><td>' + v + '</td></tr>';
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
    window.addEventListener('resize', function () {
      if (window.JunyongScene && byId('jyView') && !byId('jyView').classList.contains('hidden')) JunyongScene.resize();
    });
  }
  return {
    open: open, hide: hide, refresh: refresh, bind: bind, info: STATION,
    init: function () { bind(); }
  };
})();
