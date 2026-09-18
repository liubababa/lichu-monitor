/* ============================================================
 * 厂家 MQTT 接入 UI 层（晶农EMS 北向协议）
 *   · 顶栏数据源状态指示（演示数据 / 连接中 / 已连接 / 断开 / 错误）
 *   · MQTT 接入配置面板（Broker ws|wss、端口、用户名、密码、SN、电站名称）
 *   · 收发报文日志面板（时间 / 方向 / Topic / payload 原文）
 *   · 设备清单弹窗（Get/DeviceInfor → GetRsp/DeviceInfor）
 *   · 「充放电策略」Tab：EMS 读写控制点下发表单（EmsSet → SetRsp）
 *   · 「电芯健康」Tab：BMS 主控实时量 + 电芯单体电压/温度分布
 *   · 厂家信息展示（设备制造商取自 DeviceInfor 上报）
 *
 * 依赖：js/data.js（DataService）、js/points.js（POINTS）、js/mqtt.js（MqttService）
 * 本文件只做 UI 与报文编排，所有第三方库均来自 libs/，不做改动。
 * ============================================================ */
window.MqttUI = (function () {
  'use strict';

  const byId = id => document.getElementById(id);
  const LS_KEY = 'dianzhan.mqtt.cfg';

  /* 轻量提示（与页面既有 toast 样式共用） */
  function toast(msg) {
    const old = byId('toast'); if (old) old.remove();
    const d = document.createElement('div');
    d.id = 'toast'; d.textContent = msg;
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 2400);
  }

  /* ============================ 配置持久化 ============================ */
  function loadCfg() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch (_) { saved = {}; }
    return Object.assign({ url: '', port: '', username: '', password: '', sn: '', stationName: '', deviceTag: 'EMS', protocol: 'gaote', psn: '' },
      (window.APP_CONFIG && APP_CONFIG.mqtt) || {}, saved);
  }
  let CFG = loadCfg();
  let LS_OK = true;
  try { localStorage.setItem('dianzhan.probe', '1'); localStorage.removeItem('dianzhan.probe'); } catch (_) { LS_OK = false; }

  const STATE = {
    conn: 'mock', gotData: false, lastTags: null, lastReportAt: 0,
    pollTimer: null, pollLeft: 0, paused: false, logCount: 0, buffered: 0, devRows: []
  };

  /* ============================ 数据源状态指示 ============================ */
  const CONN_TEXT = {
    mock: '演示数据',
    connecting: 'MQTT 连接中…',
    connected: 'MQTT 已连接',
    reconnecting: 'MQTT 重连中…',
    disconnected: 'MQTT 已断开',
    error: 'MQTT 错误'
  };
  function setConn(state, extra) {
    STATE.conn = state;
    const chip = byId('dsChip');
    if (chip) {
      chip.className = 'ds-chip ' + state;
      const txt = CONN_TEXT[state] || state;
      chip.querySelector('span').textContent = extra ? txt + ' · ' + extra : txt;
      chip.title = '数据源：' + (CONN_TEXT[state] || state) + '（点击打开 MQTT 接入配置）';
    }
    const tag = byId('dataModeTag');
    if (tag) tag.textContent = state === 'mock' ? '演示数据' : (CONN_TEXT[state] || state);
    const st = byId('mqState');
    if (st) {
      const src = (typeof DataService !== 'undefined') ? DataService.getSource() : '-';
      st.textContent = (CONN_TEXT[state] || state)
        + '　|　页面数据源：' + (src === 'mqtt' ? '厂家 MQTT' : '本地演示')
        + (STATE.gotData ? '　|　最近上报：' + new Date(STATE.lastReportAt).toTimeString().slice(0, 8) : '');
    }
  }

  /* ============================ 报文日志 ============================ */
  const LOG_MAX = 400;
  function logRow(dir, topic, text, note) {
    if (!byId('logBody')) return;
    STATE.logCount++;
    const cnt = byId('logCount');
    if (cnt) cnt.textContent = String(STATE.logCount);
    if (STATE.paused) { STATE.buffered++; if (cnt) cnt.textContent = STATE.logCount + '（暂停中 +' + STATE.buffered + '）'; return; }

    const t = new Date();
    const row = document.createElement('div');
    row.className = 'lg-row ' + (dir === '↑' ? 'up' : dir === '↓' ? 'down' : 'sys');
    const head = document.createElement('div');
    head.className = 'lg-head';
    head.textContent = t.toTimeString().slice(0, 8) + '　' + dir + '　' + (topic || '-') + (note ? '　· ' + note : '');
    const body = document.createElement('pre');
    body.className = 'lg-text';
    let txt = String(text == null ? '' : text);
    try { txt = JSON.stringify(JSON.parse(txt), null, 2); } catch (_) {}
    body.textContent = txt;
    row.appendChild(head); row.appendChild(body);
    const box = byId('logBody');
    box.appendChild(row);
    while (box.childElementCount > LOG_MAX) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }
  function clearLog() {
    const box = byId('logBody');
    if (box) box.innerHTML = '';
    STATE.logCount = 0; STATE.buffered = 0;
    const cnt = byId('logCount'); if (cnt) cnt.textContent = '0';
    logRow('•', '-', '日志已清空');
  }

  /* ============================ MQTT 事件 ============================ */
  function bindMqtt() {
    if (typeof MqttService === 'undefined') { logRow('•', '-', 'MqttService 未加载：请确认 index.html 已引入 js/mqtt.js'); return; }
    MqttService.on('conn', function (s) {
      if (s.state === 'connected') {
        setConn('connected', STATE.gotData ? '' : '等待上报');
        toast('MQTT 已连接：' + (s.url || ''));
        const sn = CFG.sn;
        if (sn) MqttService.requestUserInfor(sn, CFG.username, CFG.password);
      } else if (s.state === 'error') {
        setConn('error', s.error || '');
        toast('MQTT 错误：' + (s.error || ''));
      } else if (s.state === 'connecting') {
        setConn('connecting');
      } else {
        setConn(s.state);
        if (s.state === 'disconnected' && !STATE.gotData) DataService.setSource('mock');
      }
    });
    MqttService.on('log', function (d) { logRow(d.dir, d.topic, d.text, d.note); });
    MqttService.on('data', ingest);
    MqttService.on('devdata', ingest);
    MqttService.on('login', function (d) { logRow('•', '-', '收到设备登录：SN=' + (d.sn || '-')); });
    MqttService.on('setrsp', onSetRsp);
    MqttService.on('devinfor', onDevInfor);
    MqttService.on('userinfor', onUserInfor);

    /* 高特 CCU 协议：连接状态与报文日志接入同一套面板 */
    if (typeof GaoteService !== 'undefined') {
      GaoteService.on('conn', function (s) {
        if (s.state === 'connected') { setConn('connected', STATE.gotData ? '' : '等待上报'); toast('MQTT 已连接：' + (s.url || '')); }
        else if (s.state === 'error') { setConn('error', s.error || ''); toast('MQTT 错误：' + (s.error || '')); }
        else if (s.state === 'connecting') setConn('connecting');
        else setConn(s.state);
      });
      GaoteService.on('log', function (d) { logRow(d.dir, d.topic, d.text, d.note); });
      GaoteService.on('data', function () {
        STATE.gotData = true;
        STATE.lastReportAt = Date.now();
        if (STATE.conn === 'connected') setConn('connected');
      });
    }
  }

  /* 周期上报 / 召测应答 → 标准快照 */
  function ingest(d) {
    if (!d || !d.report) return;
    STATE.gotData = true;
    STATE.lastReportAt = Date.now();
    const snap = DataService.mqttReport(d.report);
    STATE.lastTags = DataService.mqttTags();
    if (window.OverviewUI) OverviewUI.update(STATE.lastTags, 'mqtt');
    if (STATE.conn === 'connected') setConn('connected');
    prefetchStrategy();
    updateHealth(STATE.lastTags);
    return snap;
  }

  /* ============================ 配置面板 ============================ */
  function fillInputs() {
    const map = { mqUrl: CFG.url, mqPort: CFG.port, mqUser: CFG.username, mqPass: CFG.password, mqSn: CFG.sn, mqStation: CFG.stationName, mqPsn: CFG.psn };
    Object.keys(map).forEach(function (id) { const el = byId(id); if (el) el.value = map[id] == null ? '' : map[id]; });
    const tag = byId('mqDeviceTag'); if (tag) tag.value = CFG.deviceTag || 'EMS';
    const proto = byId('mqProtocol'); if (proto) proto.value = CFG.protocol || 'gaote';
  }
  function readInputs() {
    const v = id => { const el = byId(id); return el ? el.value.trim() : ''; };
    return {
      url: v('mqUrl'), port: v('mqPort'), username: v('mqUser'), password: v('mqPass'),
      sn: v('mqSn'), stationName: v('mqStation'), deviceTag: v('mqDeviceTag') || 'EMS',
      protocol: v('mqProtocol') || 'gaote', psn: v('mqPsn')
    };
  }
  function persist(showToast) {
    CFG = Object.assign({}, CFG, readInputs());
    if (LS_OK) { try { localStorage.setItem(LS_KEY, JSON.stringify(CFG)); } catch (_) {} }
    if (CFG.stationName) { APP_CONFIG.stationName = CFG.stationName; }
    else if (CFG.sn) { APP_CONFIG.stationName = '晶农EMS · ' + CFG.sn; }
    byId('stationName').textContent = APP_CONFIG.stationName;
    byId('sceneTitle').textContent = APP_CONFIG.stationName + '运行监测图';
    if (showToast) toast(LS_OK ? '配置已保存到浏览器（localStorage）' : '配置已生效（当前环境不允许 localStorage 持久化）');
  }

  /* 按协议显示/隐藏对应功能：高特协议下晶农专用按钮无意义，直接隐藏 */
  const ZHHN_ONLY = ['mqPoll', 'mqDevList', 'mqUserInfo'];
  const HINT = {
    gaote: '高特协议：主题 /{ProductSN}/{DeviceSN}/rtg/data|status/{维度}/…，30 秒周期上报，点位按项目协议文档解析。配置自动保存到浏览器 localStorage。',
    zhhn: '晶农协议：Topic 规则 zhhn/{动作}/{功能}/{SN}；EMS 上报 Login / PeriodReport，平台需回 PostRsp(Login)。'
  };
  function syncProtocolUI() {
    const gaote = CFG.protocol !== 'zhhn';
    ZHHN_ONLY.forEach(function (id) { const b = byId(id); if (b) b.classList.toggle('hidden', gaote); });
    const hint = byId('mqHint');
    if (hint) hint.textContent = gaote ? HINT.gaote : HINT.zhhn;
    /* 电芯健康页签是为晶农点位设计的，高特协议下用设备总览里的单体电芯面板，隐藏该页签 */
    const healthTab = document.querySelector('#mainTabs .tab[data-tab="health"]');
    if (healthTab) healthTab.classList.toggle('hidden', gaote);
    const stBox = byId('strategyView');
    if (stBox) stBox.classList.toggle('hidden', false);
  }

  function bindPanel() {
    byId('dsChip').addEventListener('click', () => togglePanel(true));
    byId('mqClose').addEventListener('click', () => togglePanel(false));
    byId('mqSave').addEventListener('click', () => { persist(true); syncProtocolUI(); });
    const proto = byId('mqProtocol');
    if (proto) proto.addEventListener('change', function () { CFG.protocol = proto.value; persist(false); syncProtocolUI(); });

    byId('mqConnect').addEventListener('click', function () {
      persist(false);
      if (!CFG.url) { toast('请填写 Broker 地址（ws:// 或 wss://）'); return; }
      setConn('connecting');
      if (CFG.protocol === 'gaote') {
        if (typeof GaoteService === 'undefined') { toast('GaoteService 未加载'); setConn('error', '模块未加载'); return; }
        GaoteService.connect({
          url: GaoteService.normUrl(CFG.url, CFG.port),
          username: CFG.username, password: CFG.password,
          productSN: CFG.psn || 'kp23bhcpmt91n2v8', deviceSN: CFG.sn
        });
        if (window.GaoteView) GaoteView.open();
        toast('正在连接 Broker（高特协议）…');
        return;
      }
      if (typeof MqttService === 'undefined') { toast('MqttService 未加载'); return; }
      if (!CFG.sn) toast('提示：未填写设备 SN，上报/下发 Topic 将不完整');
      MqttService.connect({
        url: MqttService.normUrl(CFG.url, CFG.port),
        username: CFG.username, password: CFG.password, sn: CFG.sn
      });
      toast('正在连接 Broker…');
    });

    byId('mqDisconnect').addEventListener('click', function () {
      if (typeof GaoteService !== 'undefined' && GaoteService.isConnected()) GaoteService.disconnect();
      if (typeof MqttService !== 'undefined') MqttService.disconnect();
      toast('已断开 MQTT');
    });

    byId('mqPoll').addEventListener('click', startPoll);

    byId('mqDevList').addEventListener('click', function () {
      if (!ensureReady()) return;
      toggleModal(true);
      byId('devFoot').textContent = '已发送 Get/DeviceInfor，等待 GetRsp 应答…';
      MqttService.requestDeviceInfor(CFG.sn);
    });

    byId('mqMock').addEventListener('click', function () {
      stopPoll('');
      DataService.setSource('mock');
      setConn('mock');
      toast('已切回本地演示数据');
    });

    byId('mqUserInfo').addEventListener('click', function () {
      if (!ensureReady()) return;
      MqttService.requestUserInfor(CFG.sn, CFG.username, CFG.password);
      toast('已发送 Get/UserInfor（应答 Topic 无 SN 后缀）');
    });
  }
  function togglePanel(open) {
    const p = byId('mqttPanel');
    if (open === undefined) p.classList.toggle('hidden');
    else p.classList.toggle('hidden', !open);
  }
  function ensureReady() {
    if (typeof MqttService === 'undefined') { toast('MqttService 未加载'); return false; }
    if (!MqttService.isConnected()) { toast('请先连接 Broker（点击顶栏数据源 → 连接）'); togglePanel(true); return false; }
    if (!CFG.sn) { toast('请先填写设备 SN'); togglePanel(true); return false; }
    return true;
  }

  /* ============================ 实时召测（5s × 60 次） ============================ */
  function startPoll() {
    if (STATE.pollTimer) { stopPoll('已停止召测'); return; }
    if (!ensureReady()) return;
    STATE.pollLeft = 60;
    const send = function () {
      if (STATE.pollLeft <= 0) { stopPoll('实时召测完成：已连发 60 次 Get/DevData'); return; }
      MqttService.startDevData(CFG.sn);
      STATE.pollLeft--;
      byId('mqPoll').textContent = '召测中 · 剩余 ' + STATE.pollLeft + ' 次';
    };
    send();
    STATE.pollTimer = setInterval(send, 5000);
    byId('mqPoll').classList.add('on');
  }
  function stopPoll(msg) {
    if (STATE.pollTimer) { clearInterval(STATE.pollTimer); STATE.pollTimer = null; }
    const b = byId('mqPoll');
    if (b) { b.textContent = '实时召测（60 帧）'; b.classList.remove('on'); }
    if (msg) toast(msg);
  }

  /* ============================ 设备清单弹窗 ============================ */
  function toggleModal(open) {
    const m = byId('devModal');
    if (open === undefined) m.classList.toggle('hidden');
    else m.classList.toggle('hidden', !open);
  }
  function bindModal() { byId('devClose').addEventListener('click', () => toggleModal(false)); }

  function onDevInfor(d) {
    const p = (d && d.payload) || {};
    const list = Array.isArray(p.data) ? p.data : (Array.isArray(p.devices) ? p.devices : []);
    const tb = byId('devTbody');
    tb.innerHTML = '';
    STATE.devRows = [];
    let vendor = '';
    list.forEach(function (it) {
      const name = it.DeviceName || it.deviceName || it.name || '';
      const tag = it.DeviceTag || it.deviceTag || it.tag || '';
      const man = it.DeviceManufacturer || it.deviceManufacturer || it.manufacturer || '';
      const code = it.DeviceCode || it.deviceCode || it.code || '';
      if (man && !vendor) vendor = man;
      const tr = document.createElement('tr');
      [name, tag, man, code].forEach(function (v) {
        const td = document.createElement('td');
        td.textContent = v === '' ? '--' : v;
        tr.appendChild(td);
      });
      tb.appendChild(tr);
      STATE.devRows.push({ name: name, tag: tag, man: man, code: code });
    });
    byId('devFoot').textContent = list.length
      ? '共 ' + list.length + ' 台设备（数据来源：GetRsp/DeviceInfor 应答）'
      : '应答中没有设备条目（payload 结构：' + JSON.stringify(p).slice(0, 120) + '）';
    if (!list.length) toggleModal(true);
    /* 厂家信息取自厂家上报数据 */
    if (vendor) {
      DataService.setVendorCompany(vendor);
      applyVendor();
      toast('已读取设备制造商：' + vendor);
    }
  }

  function onUserInfor(d) {
    const p = (d && d.payload) || {};
    const box = byId('mqUserInfoBox');
    const cand = ['StationName', 'stationName', 'PlantName', 'plantName', 'SiteName', 'name', 'Name'];
    let station = '';
    for (let i = 0; i < cand.length; i++) { if (p[cand[i]]) { station = String(p[cand[i]]); break; } }
    if (box) box.textContent = '用户/电站信息应答：' + JSON.stringify(p).slice(0, 200);
    if (station) {
      APP_CONFIG.stationName = station;
      byId('stationName').textContent = station;
      byId('sceneTitle').textContent = station + '运行监测图';
      toast('电站名称已更新：' + station);
    }
  }

  /* ============================ 充放电策略（EMS 读写控制点下发） ============================ */
  const STRAT_GROUPS = [
    {
      g: '运行模式', items: [
        { t: 'ControlMode', n: '工作模式', ty: 'I32', hint: '设置工作模式，取值按厂家协议约定' },
        { t: 'StratagyType', n: '策略模式', ty: 'I32', hint: '设置策略模式，取值按厂家协议约定' },
        { t: 'OnOff', n: '开关机', ty: 'I32' },
        { t: 'SetConnect', n: '并离网模式', ty: 'I32' }
      ]
    },
    {
      g: 'SOC 与需量', items: [
        { t: 'SOCmax', n: 'SOC 充电上限 (%)', ty: 'F32' },
        { t: 'SOCmin', n: 'SOC 放电下限 (%)', ty: 'F32' },
        { t: 'EnProtectTransf', n: '需量控制（0 退 / 1 投）', ty: 'I32' },
        { t: 'K1', n: '需量控制系数 K1 (%)', ty: 'I32' },
        { t: 'Pmlmax', n: '变压器容量 (kVA)', ty: 'I32' },
        { t: 'EnTraceLoad', n: '使能负荷跟踪（0 退 / 1 投）', ty: 'I32' }
      ]
    },
    {
      g: '功率设定', items: [
        { t: 'SetPower', n: '有功功率设定 (kW)', ty: 'F32' },
        { t: 'SetRePower', n: '无功功率设定 (kVar)', ty: 'F32' }
      ]
    }
  ];

  /* 取点表里 EMS 设备的点位中文名，作为表单占位提示（无点表时退化为 TAG 名） */
  function emsName(tag) {
    try { return (POINTS.byNo.EMS.tags.filter(x => x.t === tag)[0] || {}).n || ''; } catch (_) { return ''; }
  }

  function buildStrategyForm() {
    const host = byId('strategyView');
    if (!host) return;
    let html = '<div class="st-top">'
      + '<div class="st-desc">按《晶农EMS MQTT 北向通讯协议》通过 <b>zhhn/Set/EmsSet/{SN}</b> 下发读写控制点，报文 Tag 项为 { deviceTag, wayName, varValue }；应答 <b>zhhn/SetRsp/EmsSet/{SN}</b> 返回 result 与 errormsg。</div>'
      + '<div class="st-src"><span id="stSrcInfo">当前为本地演示数据，下发前请先接入厂家 MQTT</span></div></div>';

    STRAT_GROUPS.forEach(function (grp) {
      html += '<div class="st-group"><div class="st-gtitle">' + grp.g + '</div><div class="st-grid">';
      grp.items.forEach(function (it) {
        html += '<label class="st-field" title="' + (it.hint || emsName(it.t)) + '">'
          + '<span>' + it.n + '<em>' + (it.ty || '') + '</em></span>'
          + '<input type="number" step="any" data-tag="' + it.t + '" placeholder="' + (emsName(it.t) || 'TAG: ' + it.t) + '"/></label>';
      });
      html += '</div></div>';
    });

    html += '<div class="st-group"><div class="st-gtitle">S1~S10 分段策略'
      + '<em>起始/结束时间与执行功率均对应点表 SnStHour/SnStMin/SnEnHour/SnEnMin/SnPower</em></div>';
    html += '<div class="st-seg-wrap"><table class="st-seg"><thead><tr>'
      + '<th>段</th><th>起始时</th><th>起始分</th><th>结束时</th><th>结束分</th><th>执行功率 kW（-充 +放）</th></tr></thead><tbody>';
    for (let i = 1; i <= 10; i++) {
      html += '<tr><td class="st-segno">S' + i + '</td>'
        + '<td><input type="number" min="0" max="23" data-tag="S' + i + 'StHour"/></td>'
        + '<td><input type="number" min="0" max="59" data-tag="S' + i + 'StMin"/></td>'
        + '<td><input type="number" min="0" max="23" data-tag="S' + i + 'EnHour"/></td>'
        + '<td><input type="number" min="0" max="59" data-tag="S' + i + 'EnMin"/></td>'
        + '<td><input type="number" step="any" data-tag="S' + i + 'Power" placeholder="-充 +放"/></td></tr>';
    }
    html += '</tbody></table></div></div>';

    html += '<div class="st-sub">'
      + '<label class="st-field small"><span>目标设备 deviceTag</span><input id="mqDeviceTag" value="' + (CFG.deviceTag || 'EMS') + '"/></label>'
      + '<button class="mq-btn primary" id="stSubmit">下发 EmsSet</button>'
      + '<button class="mq-btn" id="stClear">清空表单</button>'
      + '<span class="st-count" id="stCount">已填 0 项</span></div>';
    html += '<div class="st-rsp" id="stRsp">尚未下发。下发后将在此显示 SetRsp 返回的 result 与 errormsg。</div>';

    host.innerHTML = html;

    /* 输入变化统计 */
    host.addEventListener('input', function (e) {
      if (e.target.tagName === 'INPUT') {
        e.target.dataset.dirty = '1';
        const list = readStrategyTags();
        byId('stCount').textContent = '已填 ' + list.length + ' 项';
      }
    });
    byId('stSubmit').addEventListener('click', submitStrategy);
    byId('stClear').addEventListener('click', function () {
      host.querySelectorAll('input[data-tag]').forEach(function (i) { i.value = ''; delete i.dataset.dirty; });
      byId('stCount').textContent = '已填 0 项';
      toast('表单已清空');
    });
    const tagEl = byId('mqDeviceTag');
    if (tagEl) tagEl.addEventListener('change', function () { CFG.deviceTag = tagEl.value.trim() || 'EMS'; persist(false); });
  }

  function readStrategyTags() {
    const out = [];
    document.querySelectorAll('#strategyView input[data-tag]').forEach(function (inp) {
      const v = String(inp.value || '').trim();
      if (v === '') return;
      out.push({ deviceTag: (byId('mqDeviceTag') && byId('mqDeviceTag').value.trim()) || 'EMS', wayName: inp.dataset.tag, varValue: v });
    });
    return out;
  }

  /* 用厂家当前上报值预填未编辑的字段 */
  function prefetchStrategy() {
    const map = STATE.lastTags;
    if (!map || !map.EMS || !document.querySelector('#strategyView input[data-tag]')) return;
    document.querySelectorAll('#strategyView input[data-tag]').forEach(function (inp) {
      if (inp.dataset.dirty === '1') return;
      const v = map.EMS[inp.dataset.tag];
      if (v === undefined || v === null || v === '') { if (inp.value && inp.placeholder === '') inp.value = ''; return; }
      const n = parseFloat(String(v));
      inp.value = isFinite(n) ? n : inp.value;
      inp.classList.add('from-dev');
    });
  }

  function submitStrategy() {
    if (typeof MqttService === 'undefined') { toast('MqttService 未加载'); return; }
    if (!MqttService.isConnected()) { toast('未连接 Broker，无法下发'); togglePanel(true); return; }
    if (!CFG.sn) { toast('未填写设备 SN'); togglePanel(true); return; }
    const tags = readStrategyTags();
    if (!tags.length) { toast('请至少填写一项控制参数'); return; }
    const ok = MqttService.setChannels(CFG.sn, tags);
    const box = byId('stRsp');
    box.className = 'st-rsp pending';
    box.textContent = (ok ? '已下发 ' : '下发失败，') + tags.length + ' 个通道，报文标识：' + tags.map(t => t.wayName + '=' + t.varValue).join('、')
      + '　等待 SetRsp 应答…';
    if (ok) toast('已下发 ' + tags.length + ' 个控制点，等待 SetRsp');
  }

  function onSetRsp(d) {
    const p = (d && d.payload) || {};
    const box = byId('stRsp');
    if (!box) return;
    const ok = String(p.result) === '1' || p.result === 1;
    box.className = 'st-rsp ' + (ok ? 'ok' : 'fail');
    box.textContent = '[' + new Date().toTimeString().slice(0, 8) + '] SetRsp：'
      + 'identifier=' + (p.identifier || 'EmsSet')
      + '　SN=' + ((d && d.sn) || '-')
      + '　result=' + (p.result === undefined ? '-' : p.result)
      + '　errormsg=' + (p.errormsg || p.errorMsg || p.ErrorMsg || p.msg || '（无）');
    toast(ok ? '策略下发成功（result=1）' : '策略下发返回：result=' + p.result);
  }

  /* ============================ 电芯健康 ============================ */
  const HEALTH_FIELDS = [
    { k: 'RackVoltage', n: '电池簇电压', u: 'V', d: 2 },
    { k: 'RackCurrent', n: '电池簇电流', u: 'A', d: 2 },
    { k: 'SOC', n: 'RackSOC', u: '%', d: 1 },
    { k: 'SOH', n: 'RackSOH', u: '%', d: 0 },
    { k: 'RackMaxVoltage', n: '最高单体电压', u: 'mV', d: 0, loc: ['RackMaxVoltageModuleId', 'RackMaxVolCellId'] },
    { k: 'RackMinVoltage', n: '最低单体电压', u: 'mV', d: 0, loc: ['RackMinVoltageModuleId', 'RackMinVolCellId'] },
    { k: 'RackMaxTemp', n: '最高温度', u: '℃', d: 0, loc: ['RackMaxTempModuleId', 'RackMaxTempCellId'] },
    { k: 'RackMinTemp', n: '最低温度', u: '℃', d: 0, loc: ['RackMinTempModuleId', 'RackMinTempCellId'] },
    { k: 'RackAverageVolt', n: '单体平均电压', u: 'mV', d: 0 },
    { k: 'RackAverageTemp', n: '电池平均温度', u: '℃', d: 1 }
  ];
  function buildHealthSkeleton() {
    const host = byId('healthCards');
    if (!host) return;
    host.innerHTML = HEALTH_FIELDS.map(function (f) {
      return '<div class="hc-card"><div class="hc-name">' + f.n + '</div>'
        + '<div class="hc-val"><b id="hv_' + f.k + '" data-v="0">--</b><u>' + f.u + '</u></div>'
        + (f.loc ? '<div class="hc-loc" id="hl_' + f.k + '">位置：--</div>' : '')
        + '<div class="hc-tag">' + f.k + '</div></div>';
    }).join('') + '<div class="hc-note" id="hcNote">数据来源：BMS 主控（设备类型 BMS）实时上报点位。</div>';
  }
  function fe(v, d) { if (v === null || v === undefined || v === '') return '--'; const n = parseFloat(v); return isFinite(n) ? n.toFixed(d) : String(v); }
  function updateHealth(map) {
    if (!byId('healthCards')) return;
    const bms = (map && map.BMS) || {};
    HEALTH_FIELDS.forEach(function (f) {
      const el = byId('hv_' + f.k);
      if (el) el.textContent = fe(bms[f.k], f.d);
      if (f.loc) {
        const loc = byId('hl_' + f.k);
        if (loc) {
          const m = bms[f.loc[0]], c = bms[f.loc[1]];
          loc.textContent = '位置：' + ((m === undefined || m === '') ? '--' : '模块 ' + m) + ' · ' + ((c === undefined || c === '') ? '--' : '序号 ' + c);
        }
      }
    });
    const note = byId('hcNote');
    if (note) {
      const n = Object.keys(bms).length;
      note.textContent = n
        ? '数据来源：BMS 主控实时上报（本次共 ' + n + ' 个 TAG）'
        : '尚未收到 BMS 主控数据：请接入厂家 MQTT 或发起实时召测。';
    }
    if (!byId('healthView').classList.contains('hidden')) drawCellCharts(map);
  }

  function cellSeries(map, prefix) {
    const pairs = [];
    Object.keys(map || {}).forEach(function (no) {
      const d = map[no] || {};
      Object.keys(d).forEach(function (k) {
        const m = /^([A-Za-z]+)(\d+)$/.exec(k);
        if (!m || m[1] !== prefix) return;
        const v = parseFloat(String(d[k]));
        if (isFinite(v)) pairs.push([parseInt(m[2], 10), v]);
      });
    });
    pairs.sort((a, b) => a[0] - b[0]);
    return { labels: pairs.map(p => String(p[0])), data: pairs.map(p => p[1]) };
  }

  let voltChart = null, tempChart = null;
  function drawCellCharts(map) {
    if (typeof echarts === 'undefined') return;
    const t = map || STATE.lastTags || {};
    const v = cellSeries(t, 'RkCeVolt'), c = cellSeries(t, 'RkCeTemp');

    const meta = byId('cellVoltMeta');
    if (meta) meta.textContent = v.data.length ? ('共 ' + v.data.length + ' 个测点 · mV') : '暂无单体电压数据';
    const meta2 = byId('cellTempMeta');
    if (meta2) meta2.textContent = c.data.length ? ('共 ' + c.data.length + ' 个测点 · ℃') : '暂无单体温度数据';

    if (!voltChart && byId('cellVoltChart') && v.data.length) voltChart = echarts.init(byId('cellVoltChart'));
    if (!tempChart && byId('cellTempChart') && c.data.length) tempChart = echarts.init(byId('cellTempChart'));
    const base = {
      grid: { left: 52, right: 16, top: 26, bottom: 26 },
      tooltip: { trigger: 'axis', backgroundColor: 'rgba(6,18,20,.92)', borderColor: 'rgba(46,230,200,.35)', textStyle: { color: '#cfeee8', fontSize: 11 } },
      xAxis: {
        type: 'category', data: (v.data.length ? v : c).labels,
        axisLine: { lineStyle: { color: 'rgba(46,230,200,.25)' } }, axisTick: { show: false },
        axisLabel: { color: '#6b9490', fontSize: 9, interval: Math.max(0, Math.floor(((v.data.length ? v : c).labels.length) / 24)) }
      },
      yAxis: {
        type: 'value', scale: true,
        axisLabel: { color: '#6b9490', fontSize: 10 },
        splitLine: { lineStyle: { color: 'rgba(46,230,200,.08)', type: 'dashed' } }
      }
    };
    function mark(data) {
      if (!data.length) return {};
      const mx = Math.max.apply(null, data), mn = Math.min.apply(null, data);
      return {
        markPoint: {
          symbolSize: 34, label: { fontSize: 9, color: '#04231d' },
          data: [{ type: 'max', name: '最高' }, { type: 'min', name: '最低' }]
        },
        markLine: {
          silent: true, symbol: 'none',
          lineStyle: { color: 'rgba(46,230,200,.35)', type: 'dashed' },
          data: [{ yAxis: mx, name: 'Max' }, { yAxis: mn, name: 'Min' }],
          label: { color: '#6b9490', fontSize: 9, formatter: p => p.name }
        }
      };
    }
    if (voltChart) {
      voltChart.setOption(Object.assign({}, base, {
        series: [Object.assign({
          name: '单体电压', type: 'bar', data: v.data,
          itemStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: '#35f0cf' }, { offset: 1, color: 'rgba(53,240,207,.18)' }]) }
        }, mark(v.data))]
      }), true);
    }
    if (tempChart) {
      tempChart.setOption(Object.assign({}, base, {
        series: [Object.assign({
          name: '单体温度', type: 'line', smooth: true, symbol: 'none', data: c.data,
          lineStyle: { width: 1.6, color: '#ffb020' },
          areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: 'rgba(255,176,32,.35)' }, { offset: 1, color: 'rgba(255,176,32,0)' }]) }
        }, mark(c.data))]
      }), true);
    }
  }
  function resizeHealth() { voltChart && voltChart.resize(); tempChart && tempChart.resize(); }

  /* ============================ Tab 视图切换 ============================ */
  function openTab(name) {
    const view = byId('tabView');
    const ov = byId('overviewView');
    if (!view || !ov) return;
    /* 高特协议用独立监控视图（按协议文档的维度组织） */
    const gaote = CFG.protocol === 'gaote' && window.GaoteView;
    if (name !== 'overview') { if (gaote) GaoteView.hide(); ov.classList.toggle('hidden', true); }
    if (name !== 'detail' && window.GaoteDetail) GaoteDetail.hide();
    if (name === 'detail') {
      view.classList.add('hidden');
      if (window.GaoteDetail) GaoteDetail.open();
      return;
    }
    if (name === 'overview') {
      view.classList.add('hidden');
      if (gaote) GaoteView.open();
      else { if (window.OverviewUI) OverviewUI.update(STATE.lastTags, 'force'); ov.classList.remove('hidden'); }
      return;
    }
    if (name === 'monitor') { view.classList.add('hidden'); return; }
    ov.classList.add('hidden');
    view.classList.remove('hidden');
    byId('tvTitle').textContent = name === 'strategy' ? '充放电策略 · EMS 读写控制点下发' : '电芯健康 · BMS 主控与电芯分布';
    byId('strategyView').classList.toggle('hidden', name !== 'strategy');
    byId('healthView').classList.toggle('hidden', name !== 'health');
    if (name === 'health') { drawCellCharts(STATE.lastTags); setTimeout(resizeHealth, 60); }
    if (name === 'strategy') {
      const src = byId('stSrcInfo');
      if (src) src.textContent = (DataService.getSource() === 'mqtt')
        ? '当前数据源：厂家 MQTT（' + (CFG.sn || '未填 SN') + '）'
        : '当前为本地演示数据，下发前请先接入厂家 MQTT';
      /* 高特协议：用协议文档自动生成的下发表单 */
      if (CFG.protocol === 'gaote' && typeof GaoteStrategy !== 'undefined') {
        byId('tvTitle').textContent = '充放电策略 · 高特 CCU 下发（cmd/set）';
        GaoteStrategy.init();
      }
    }
  }
  function bindTabs() {
    byId('tvClose').addEventListener('click', function () {
      document.querySelectorAll('#mainTabs .tab').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === 'monitor'); });
      openTab('monitor');
    });
  }

  /* ============================ 厂家信息 / KPI 文案 ============================ */
  function applyVendor() {
    const v = (typeof DataService !== 'undefined' && DataService.vendor) ? DataService.vendor() : (APP_CONFIG.vendor || {});
    const line = (v.company || '') + (v.product ? ' · ' + v.product : '');
    const el = byId('vendorName'); if (el) el.textContent = v.company || '--';
    const el2 = byId('vendorProduct'); if (el2) el2.textContent = v.product || '--';
    const el3 = byId('vendorLine'); if (el3) el3.textContent = line;
    const el4 = byId('mqVendor'); if (el4) el4.textContent = line + '（' + (v.protocol || '') + '）';
  }
  function kpiLabels() {
    const src = (typeof DataService !== 'undefined') ? DataService.getSource() : 'mock';
    const info = (typeof DataService !== 'undefined') ? DataService.energyInfo() : { hints: {} };
    const set = function (id, text, title) {
      const el = byId(id); if (!el) return;
      el.textContent = text;
      el.title = title || '';
    };
    if (src !== 'mqtt') {
      set('kpiStorageLabel', '储能电站 · 今日充放电量', '本地演示数据');
      set('kpiLoadLabel', '用户负载 · 今日用电量', '本地演示数据');
      set('kpiGridLabel', '变压器 · 今日发电量', '本地演示数据');
      return;
    }
    const tail = info.mode === 'daily' ? '' : '（会话累计）';
    set('kpiStorageLabel', '储能电站 · 今日充放电量' + tail, info.hints.storage || '');
    set('kpiLoadLabel', '用户负载 · 今日用电量' + tail, info.hints.load || '');
    set('kpiGridLabel', '变压器 · 今日发电量' + tail, info.hints.grid || '');
  }

  /* ============================ 初始化 ============================ */
  function init() {
    if (!byId('dsChip')) return;
    buildStrategyForm();
    buildHealthSkeleton();
    bindPanel();
    bindTabs();
    bindModal();
    fillInputs();
    applyVendor();
    syncProtocolUI();
    /* 高特协议：默认以三维电站为主视图（页面打开即见 3D + 右侧数据面板） */
    if (CFG.protocol === 'gaote') {
      if (window.GaoteView) GaoteView.hide();
      const ov = byId('overviewView'); if (ov) ov.classList.add('hidden');
      document.querySelectorAll('#mainTabs .tab').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === 'monitor'); });
    }
    setConn('mock');

    byId('logClear').addEventListener('click', clearLog);
    byId('logPause').addEventListener('click', function () {
      STATE.paused = !STATE.paused;
      byId('logPause').textContent = STATE.paused ? '继续' : '暂停';
      byId('logPause').classList.toggle('on', STATE.paused);
      if (!STATE.paused) {
        if (STATE.buffered) logRow('•', '-', '暂停期间新增 ' + STATE.buffered + ' 条报文（已跳过逐条展示）');
        STATE.buffered = 0;
        const cnt = byId('logCount'); if (cnt) cnt.textContent = String(STATE.logCount);
      }
    });
    byId('logFold').addEventListener('click', function () {
      const p = byId('logPanel');
      p.classList.toggle('fold');
      byId('logFold').textContent = p.classList.contains('fold') ? '展开' : '折叠';
    });
    byId('btnMqttLog').addEventListener('click', function () {
      byId('logPanel').classList.toggle('hidden');
    });

    bindMqtt();
    kpiLabels();
    setInterval(kpiLabels, 2000);
    window.addEventListener('resize', function () {
      resizeHealth();
      if (typeof Charts !== 'undefined' && byId('tabView') && !byId('tabView').classList.contains('hidden')) Charts.resize();
    });
    logRow('•', '-', '晶农EMS 北向协议接入就绪：' + (APP_CONFIG.vendor ? APP_CONFIG.vendor.company + ' · ' + APP_CONFIG.vendor.product : ''));
  }

  return { init, openTab, setConn, logRow, panel: togglePanel, modal: toggleModal, protocol: () => CFG.protocol };
})();
