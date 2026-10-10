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
      group: '莒南站', name: '莒南储能站', sn: 'R250907J0038', psn: 'kp23bhcpmt91n2v8',
      tag: '储能 · 高特 CCU', note: '液冷储能 125kW / 261kWh'
    },
    {
      kind: 'solar', group: '洙边卫生院站', name: '洙边卫生院站', sn: '', psn: '',
      tag: '光伏 · 阳光电源', note: '分布式光伏 110.16 kWp · iSolarCloud 已接入'
    }
  ];
  const OTHER_GROUP = '其他电站';

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
    const c = cfgOf();
    if (window.MqttUI && MqttUI.selectStation) {
      MqttUI.selectStation({
        sn: opt.sn || '', psn: opt.psn || c.psn || '',
        stationName: opt.name || '', protocol: opt.protocol || c.protocol || 'gaote',
        connect: true
      });
    }
    try { localStorage.setItem(LS_KEY, JSON.stringify({ name: opt.name, sn: opt.sn, at: Date.now() })); } catch (_) {}
    closePortal();
  }

  /* 光伏站（阳光电源 iSolarCloud）：不连 MQTT，直接进光伏监控页 */
  function enterSolar(st) {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ name: st.name, sn: '', at: Date.now() })); } catch (_) {}
    const p = byId('portal');
    if (p) p.classList.add('hidden');
    if (window.SolarUI) SolarUI.open();
  }

  /* ---------------- 目录页 ---------------- */
  function card(st) {
    const solar = st.kind === 'solar';
    const dev = st.sn ? findDev(st.sn) : null;
    const online = !!(dev && dev.online);
    const state = solar ? 'on' : (!st.sn ? 'off' : (online ? 'on' : (dev ? 'off' : 'na')));
    const stateText = solar ? '已接入' : (!st.sn ? '未接入' : (online ? '在线' : (dev ? '离线' : '未上报')));

    const c = el('div', 'pt-card pt-' + state);
    const head = el('div', 'pt-chead');
    head.appendChild(el('b', '', st.name));
    head.appendChild(el('span', 'pt-tag', st.tag || ''));
    c.appendChild(head);
    c.appendChild(el('div', 'pt-crow', '<span>' + (solar ? '电站' : '设备号') + '</span>' + (solar ? '洙边卫生院 · ps_id 2355743' : (st.sn || '—'))));
    if (st.note) c.appendChild(el('div', 'pt-crow', '<span>说明</span>' + st.note));
    const stat = el('div', 'pt-cstat');
    stat.innerHTML = '<i class="pt-dot ' + state + '"></i>' + stateText
      + (solar ? '　数据源 阳光云接入服务（5 分钟一更）'
        : (dev ? '　报文 ' + dev.msgs + ' 条　最后上报 ' + fmtTime(dev.lastSeen) : ''));
    c.appendChild(stat);
    const btn = el('button', 'mq-btn primary pt-enter', (solar || st.sn) ? '进入监控' : '未接入');
    btn.disabled = !solar && !st.sn;
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (solar) { enterSolar(st); return; }
      if (!st.sn) return;
      enter({ sn: st.sn, psn: st.psn, name: st.name });
    });
    c.appendChild(btn);
    c.addEventListener('click', function () {
      if (solar) { enterSolar(st); return; }
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

    /* 其他电站：自动发现、且不在上面登记表里的设备 */
    const known = STATIONS.map(function (s) { return s.sn; }).filter(Boolean);
    const others = devList().filter(function (d) { return known.indexOf(d.dsn) < 0; });
    const gw = el('div', 'pt-group');
    gw.appendChild(el('div', 'pt-gtitle', '<i></i>' + OTHER_GROUP + '<em>自动发现 ' + others.length + ' 台</em>'));
    const cards = el('div', 'pt-cards');
    if (!others.length) {
      cards.appendChild(el('div', 'pt-empty', '还没有发现其它设备。<br/>连接 MQTT 后，正在上报的设备会自动出现在这里。'));
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
  function renderDevicePage() {
    const box = byId('dvBody');
    if (!box) return;
    const list = devList();
    const stats = byId('dvStats');
    if (stats) stats.textContent = list.length ? ('发现 ' + list.length + ' 台设备') : '尚未发现设备';
    box.innerHTML = '';
    if (!list.length) {
      box.appendChild(el('div', 'pt-empty', '还没有发现设备。<br/>连接 MQTT 并等设备上报后，这里会自动列出（2 分钟内有报文算在线）。'));
      return;
    }
    list.forEach(function (d) {
      const row = el('div', 'pt-devrow' + (d.active ? ' on' : '') + (d.online ? ' online' : ''));
      const main = el('div', 'pt-dmain');
      main.appendChild(el('b', '', d.dsn));
      main.appendChild(el('span', '', '报文 ' + d.msgs + ' 条　最后上报 ' + fmtTime(d.lastSeen) + '　产品号 ' + (d.psn || '—')));
      row.appendChild(main);
      row.appendChild(el('span', 'pt-dbadge' + (d.online ? '' : ' off'), d.online ? '在线' : '离线'));
      const btn = el('button', 'mq-btn' + (d.active ? '' : ' primary'), d.active ? '当前查看' : '查看');
      btn.disabled = !!d.active;
      btn.addEventListener('click', function () {
        if (window.MqttUI && MqttUI.selectStation) {
          MqttUI.selectStation({ sn: d.dsn, psn: d.psn, stationName: d.dsn, protocol: 'gaote', connect: false });
        }
        openMonitor();
      });
      row.appendChild(btn);
      box.appendChild(row);
    });
  }

  /* ---------------- 视图切换 ---------------- */
  function openPortal() {
    const p = byId('portal');
    if (!p) return;
    if (window.SolarUI) SolarUI.hide();          /* 光伏站视图收起，别和目录叠在一起 */
    p.classList.remove('hidden');
    renderPortal();
  }
  function closePortal() {
    const p = byId('portal');
    if (p) p.classList.add('hidden');
    openMonitor();
  }
  function openMonitor() {
    if (window.SolarUI) SolarUI.hide();
    const dev = byId('deviceView');
    if (dev) dev.classList.add('hidden');
    if (window.MqttUI && MqttUI.openTab) MqttUI.openTab('monitor');
  }
  function openDevices() {
    const p = byId('portal'); if (p) p.classList.add('hidden');
    const dv = byId('deviceView');
    if (dv) dv.classList.remove('hidden');
    if (window.GaoteView) GaoteView.hide();
    if (window.GaoteDetail) GaoteDetail.hide();
    const ov = byId('overviewView'); if (ov) ov.classList.add('hidden');
    const tv = byId('tabView'); if (tv) tv.classList.add('hidden');
    renderDevicePage();
  }

  /* ---------------- 初始化 ---------------- */
  function init() {
    if (!byId('portal')) return;
    const b = byId('btnPortal');
    if (b) b.addEventListener('click', openPortal);
    const b2 = byId('dvBack');
    if (b2) b2.addEventListener('click', openMonitor);
    const b3 = byId('dvRefresh');
    if (b3) b3.addEventListener('click', renderDevicePage);
    const b4 = byId('ptEnterLast');
    if (b4) b4.addEventListener('click', function () {
      const sel = savedSel();
      if (!sel || !sel.name) return;
      const st = STATIONS.filter(function (s) { return s.name === sel.name && s.kind === 'solar'; })[0];
      if (st) { enterSolar(st); return; }
      if (sel.sn) enter({ sn: sel.sn, name: sel.name });
    });
    openPortal();                       /* 打开网站先看目录 */
    setInterval(function () { if (!byId('portal').classList.contains('hidden')) renderPortal(); }, 3000);
    setInterval(function () { if (!byId('deviceView').classList.contains('hidden')) renderDevicePage(); }, 2000);
  }
  return { init, openPortal, closePortal, openDevices, openMonitor, renderDevicePage, stations: STATIONS };
})();
