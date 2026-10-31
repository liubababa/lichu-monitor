/* ============================================================
 * 站点目录（进门页） + 设备列表页
 *
 *   打开网站 → 先看到站点目录 → 选一个站/设备 → 才进入监控界面
 *   目录分组：莒南站 / 洙边卫生院站 / 其他电站（自动发现，不在上面的都归这里）
 *
 *   配置：STATIONS 里的 sn 填现场设备号；填了才显示"在线/离线"，
 *         留空表示该站还没接入。kind:'solar' 的是光伏站（阳光电源
 *         iSolarCloud 接入服务，走 HTTP 接口，不连 MQTT）。
 * ============================================================ */
window.PortalUI = (function () {
  'use strict';

  const byId = id => document.getElementById(id);
  const LS_KEY = 'dianzhan.station.sel';

  /* ======== 站点登记表：新站加一行即可 ========
     group 分组名 · name 站点名 · sn 设备号（空=未接入）· psn 产品号 · tag 类型标签 · note 备注 */
  const STATIONS = [
    {
      group: '旭日东明站', name: '旭日东明储能电站', sn: 'R250907J0038', psn: 'kp23bhcpmt91n2v8',
      tag: '储能 · 高特 CCU', note: '储能 250kW / 522kWh', source: '高特 CCU'
    },
    {
      kind: 'solar', group: '洙边卫生院光储电站', name: '洙边卫生院光储电站', sn: '', psn: '',
      tag: '光储 · 阳光云 + 日升云', note: '光伏 110.16kWp；储能 100kW / 215kWh',
      source: '阳光云 + 日升云'
    },
    {
      kind: 'junyong', group: '山东峻涌光储电站', name: '山东峻涌光储电站', sn: '', psn: '',
      tag: '光储 · 阳光云 + 高特 CCU', note: '光伏 972.4kWp；储能 625kW / 1305kWh',
      source: '阳光云 + 高特 CCU'
    }
  ];
  const OTHER_GROUP = '其他电站';
  /* 已登记电站自己的设备：峻涌的三台高特 CCU 归入「山东峻涌光储电站」，
     不在「其他电站（自动发现）」里重复列卡片；这块只留一个空占位框。 */
  const HIDDEN_DSN = ['R260616J0069', 'R250907J0037', 'R260812J0066'];

  /* ---------------- 工具 ---------------- */
  function devList() {
    return (typeof GaoteService !== 'undefined' && GaoteService.devicesList) ? GaoteService.devicesList() : [];
  }
  function findDev(sn) {
    if (!sn) return null;
    return devList().filter(function (d) { return d.dsn === sn; })[0] || null;
  }
  function fmtTime(ts) {
    return ts ? new Date(ts).toTimeString().slice(0, 8) : '--';
  }
  function cfgOf() {
    try { return JSON.parse(localStorage.getItem('dianzhan.mqtt.cfg') || '{}') || {}; } catch (_) { return {}; }
  }
  function savedSel() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (_) { return null; }
  }
  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  /* ---------------- 进入某个站点/设备 ---------------- */
  function enter(opt) {
    /* opt = { sn, psn, name, protocol } */
    if (window.SolarUI) SolarUI.hide();                 /* 从光伏站切回储能站视图 */
    if (window.JunyongUI) JunyongUI.hide();
    const c = cfgOf();
    if (window.MqttUI && MqttUI.selectStation) {
      MqttUI.selectStation({
        sn: opt.sn || '', psn: opt.psn || c.psn || '',
        stationName: opt.name || '', protocol: opt.protocol || c.protocol || 'gaote',
        connect: true
      });
    }
    try { localStorage.setItem(LS_KEY, JSON.stringify({ name: opt.name, sn: opt.sn, at: Date.now() })); } catch (_) {}
    setCurStation(opt.name);
    closePortal();
  }

  /* 光伏站（阳光电源 iSolarCloud）：不连 MQTT，直接进光伏监控页 */
  function enterSolar(st) {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ name: st.name, sn: '', at: Date.now() })); } catch (_) {}
    setCurStation(st.name);
    const p = byId('portal');
    if (p) p.classList.add('hidden');
    if (window.SolarUI) SolarUI.open();
    /* 进站把三维视角归位：上次转过/缩放过，再进来看到的就不是默认那一版构图 */
    if (window.SolarScene && SolarScene.resetView) SolarScene.resetView();
  }

  /* 峻涌站：三群品字 + 中心铁塔的独立整站视图（数据源待接入，页面先上线） */
  function enterJunyong(st) {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ name: st.name, sn: '', at: Date.now() })); } catch (_) {}
    setCurStation(st.name);
    const p = byId('portal');
    if (p) p.classList.add('hidden');
    if (window.JunyongUI) JunyongUI.open();
  }

  /* ---------------- 目录页 ---------------- */
  function card(st) {
    const hosted = st.kind === 'solar' || st.kind === 'junyong';   /* 独立整站视图（不走 MQTT 设备号） */
    const dev = st.sn ? findDev(st.sn) : null;
    const online = !!(dev && dev.online);
    const state = st.kind === 'solar' ? 'on'
      : (st.kind === 'junyong' ? 'on' : (!st.sn ? 'off' : (online ? 'on' : (dev ? 'off' : 'na'))));
    const stateText = st.kind === 'solar' ? '已接入'
      : (st.kind === 'junyong' ? '已接入'
        : (!st.sn ? '未接入' : (online ? '在线' : (dev ? '离线' : '未上报'))));

    const c = el('div', 'pt-card pt-' + state);
    const head = el('div', 'pt-chead');
    head.appendChild(el('b', '', st.name));
    head.appendChild(el('span', 'pt-tag', st.tag || ''));
    c.appendChild(head);
    if (st.note) c.appendChild(el('div', 'pt-crow', '<span>装机容量</span>' + st.note));
    const stat = el('div', 'pt-cstat');
    stat.innerHTML = '<i class="pt-dot ' + state + '"></i>' + stateText
      + (st.source ? '　数据源 ' + st.source : '');
    c.appendChild(stat);
    const btn = el('button', 'mq-btn primary pt-enter', (hosted || st.sn) ? '进入监控' : '未接入');
    btn.disabled = !hosted && !st.sn;
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (st.kind === 'solar') { enterSolar(st); return; }
      if (st.kind === 'junyong') { enterJunyong(st); return; }
      if (!st.sn) return;
      enter({ sn: st.sn, psn: st.psn, name: st.name });
    });
    c.appendChild(btn);
    c.addEventListener('click', function () {
      if (st.kind === 'solar') { enterSolar(st); return; }
      if (st.kind === 'junyong') { enterJunyong(st); return; }
      if (st.sn) enter({ sn: st.sn, psn: st.psn, name: st.name });
    });
    return c;
  }

  function renderPortal() {
    const box = byId('ptBody');
    if (!box) return;
    box.innerHTML = '';

    const groups = [];
    STATIONS.forEach(function (st) {
      let g = groups.filter(function (x) { return x.name === st.group; })[0];
      if (!g) { g = { name: st.group, items: [] }; groups.push(g); }
      g.items.push(st);
    });

    groups.forEach(function (g) {
      const gw = el('div', 'pt-group');
      gw.appendChild(el('div', 'pt-gtitle', '<i></i>' + g.name + '<em>' + g.items.length + ' 个站点</em>'));
      const cards = el('div', 'pt-cards');
      g.items.forEach(function (st) { cards.appendChild(card(st)); });
      gw.appendChild(cards);
      box.appendChild(gw);
    });

    /* 其他电站：自动发现区永远保留一个框。已登记站自己的设备（峻涌三台 CCU）
       不在这里重复列；真发现其它设备时再按旧方案列卡片。 */
    const known = STATIONS.map(function (s) { return s.sn; }).filter(Boolean);
    const others = devList().filter(function (d) {
      return known.indexOf(d.dsn) < 0 && HIDDEN_DSN.indexOf(d.dsn) < 0;
    });
    const gw = el('div', 'pt-group pt-auto');
    gw.appendChild(el('div', 'pt-gtitle', '<i></i>' + OTHER_GROUP
      + '<em>' + (others.length ? '自动发现 ' + others.length + ' 台' : '自动发现') + '</em>'));
    const cards = el('div', 'pt-cards');
    if (!others.length) {
      cards.appendChild(el('div', 'pt-empty',
        '还没有发现其它设备。<br/>连接 MQTT 后，正在上报的设备会自动出现在这里。'));
    } else {
      others.forEach(function (d) {
        const c = el('div', 'pt-card pt-' + (d.online ? 'on' : 'off'));
        const head = el('div', 'pt-chead');
        head.appendChild(el('b', '', d.dsn));
        head.appendChild(el('span', 'pt-tag', '自动发现'));
        c.appendChild(head);
        c.appendChild(el('div', 'pt-crow', '<span>产品号</span>' + (d.psn || '—')));
        const stat = el('div', 'pt-cstat');
        stat.innerHTML = '<i class="pt-dot ' + (d.online ? 'on' : 'off') + '"></i>' + (d.online ? '在线' : '离线')
          + '　报文 ' + d.msgs + ' 条　最后上报 ' + fmtTime(d.lastSeen);
        c.appendChild(stat);
        const btn = el('button', 'mq-btn primary pt-enter', '进入监控');
        btn.addEventListener('click', function (e) { e.stopPropagation(); enter({ sn: d.dsn, psn: d.psn, name: d.dsn }); });
        c.appendChild(btn);
        c.addEventListener('click', function () { enter({ sn: d.dsn, psn: d.psn, name: d.dsn }); });
        cards.appendChild(c);
      });
    }
    gw.appendChild(cards);
    box.appendChild(gw);

    /* 页脚：上次选择 + 当前 MQTT 状态 */
    const sel = savedSel();
    const c = cfgOf();
    const foot = byId('ptFoot');
    if (foot) {
      foot.innerHTML = (sel && sel.name ? '上次进入：<b>' + sel.name + '</b>　' : '')
        + (c.url ? 'MQTT：<b>' + c.url + '</b>（' + (c.username ? '账号 ' + c.username : '未填账号') + '）' : 'MQTT：尚未配置');
    }
    const chip = byId('ptMqtt');
    if (chip) {
      const on = (typeof GaoteService !== 'undefined' && GaoteService.isConnected && GaoteService.isConnected());
      chip.textContent = on ? 'MQTT 已连接' : 'MQTT 未连接';
      chip.className = 'pt-mqtt' + (on ? ' on' : '');
    }
  }

  /* ---------------- 设备列表页（原侧边弹窗改成整页） ---------------- */
  

  /* ---------------- 视图切换 ---------------- */
  function openPortal() {
    const p = byId('portal');
    if (!p) return;
    if (window.JunyongUI) JunyongUI.hide();
    if (window.SolarUI) SolarUI.hide();          /* 光伏站视图收起，别和目录叠在一起 */
    p.classList.remove('hidden');
    setCurStation('');                  /* 目录页不显示「当前电站」，进站才显示 */
    renderPortal();
  }
  function closePortal() {
    const p = byId('portal');
    if (p) p.classList.add('hidden');
    openMonitor();
  }
  function openMonitor() {
    if (window.JunyongUI) JunyongUI.hide();
    if (window.SolarUI) SolarUI.hide();
    if (window.MqttUI && MqttUI.openTab) MqttUI.openTab('monitor');
    /* 进站把三维视角归位：这个场景对象是复用的，上次在这里转过 / 缩放过，
       再进来看到的就不是默认构图（用户："进去的时候相机要再调整一下"） */
    if (window.S3D) {
      const sc = S3D();
      if (sc && sc.resetView) sc.resetView();
    }
  }
  /* ---------------- 顶栏「当前电站」提示 ----------------
     设备总览 / 详细信息 / 电芯健康 / 光伏页都不带站名，看的人不知道在看哪个站。
     这里统一在顶栏挂一个常驻提示：进站时写入，刷新后沿用上次选择。 */
  function setCurStation(name) {
    try { localStorage.setItem('dianzhan.station.cur', name || ''); } catch (_) {}
    paintStation(name);
  }
  function paintStation(name) {
    let n = name;
    if (n === undefined) { try { n = localStorage.getItem('dianzhan.station.cur') || ''; } catch (_) { n = ''; } }
    const b = byId('topStation');
    if (b) {
      b.textContent = n || '未选择电站';
      const chip = b.closest ? b.closest('.top-chip') : null;
      if (chip) chip.style.display = n ? '' : 'none';
    }
  }

  /* ---------------- 初始化 ---------------- */
  function init() {
    if (!byId('portal')) return;
    const b = byId('btnPortal');
    if (b) b.addEventListener('click', openPortal);
    const b4 = byId('ptEnterLast');
    if (b4) b4.addEventListener('click', function () {
      const sel = savedSel();
      if (!sel || !sel.name) return;
      var st = STATIONS.filter(function (s) { return s.name === sel.name && s.kind === 'solar'; })[0];
      if (st) { enterSolar(st); return; }
      st = STATIONS.filter(function (s) { return s.name === sel.name && s.kind === 'junyong'; })[0];
      if (st) { enterJunyong(st); return; }
      if (sel.sn) enter({ sn: sel.sn, name: sel.name });
    });
    openPortal();                       /* 打开网站先看目录 */
    paintStation();                     /* 顶栏电站提示：沿用上次选择 */
    /* ?station=峻涌|junyong 直达某个站（大屏值班 / 截图对图用，不在界面上加任何控件） */
    var deep = (new URLSearchParams(location.search).get('station') || '').trim();
    if (deep) {
      const hit = STATIONS.filter(function (s) {
        return s.name === deep || s.kind === deep || s.name.indexOf(deep) >= 0;
      })[0];
      if (hit && hit.kind === 'junyong') { enterJunyong(hit); return; }
      if (hit && hit.kind === 'solar') { enterSolar(hit); return; }
      if (hit && hit.sn) { enter({ sn: hit.sn, psn: hit.psn, name: hit.name }); return; }
    }
    /* 登录后第一个界面是屏保（优先于电站选择页）：目录先备好，屏保盖在上面，一唤醒就是目录 */
    if (window.ScreenSaver && ScreenSaver.show) ScreenSaver.show();
    setInterval(function () { if (!byId('portal').classList.contains('hidden')) renderPortal(); }, 3000);
  }
  return { init, openPortal, closePortal, openMonitor, stations: STATIONS };
})();
