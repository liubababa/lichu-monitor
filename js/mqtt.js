/* ============================================================
 * MQTT 通信服务（晶农EMS 北向协议）
 *
 * 协议：中和汇能《晶农EMS的MQTT通讯协议》2026-03-04
 * Topic 前缀 zhhn/，按 发布方向/业务/SN 组合：
 *   EMS→平台: zhhn/Post/Login/{SN}, zhhn/Post/PeriodReport/{SN}
 *   平台→EMS: zhhn/Get/DevData/{SN}(召测), zhhn/Set/EmsSet/{SN}(下发),
 *             zhhn/Get/DeviceInfor/{SN}, zhhn/Get/UserInfor/{SN}
 *   应答:     zhhn/PostRsp/…, zhhn/GetRsp/…, zhhn/SetRsp/…
 *
 * 页面职责（broker 连接、账号与登录应答都在后端网关 tools/gateway.js）：
 *   1. 经网关收上行 Topic 报文并渲染（网关地址即"Broker 地址"，由网关转发到厂家 broker）
 *   2. 解析 PeriodReport / GetRsp 数据帧（payload 标识符可能统一为 "PeriodReport"）
 *   3. 下发 EmsSet 并等待 SetRsp（result + errormsg）；登录应答由网关负责，页面不再回
 * ============================================================ */
window.MqttService = (function () {
  'use strict';

  let client = null;
  let cfg = null;
  const handlers = { conn: [], login: [], data: [], devdata: [], setrsp: [], devinfor: [], userinfor: [], log: [] };

  function on(type, fn) { if (handlers[type]) handlers[type].push(fn); }
  function emit(type, a, b) {
    (handlers[type] || []).forEach(fn => { try { fn(a, b); } catch (e) { console.error('[mqtt]', e); } });
  }
  function now() { return Math.floor(Date.now() / 1000); }
  function log(dir, topic, text, note) { emit('log', { dir, topic, text, note, time: new Date() }); }
  function sys(text) { log('•', '-', text); }

  /* 允许只填主机名（自动补 ws://）；url 已含端口时忽略 port */
  function normUrl(url, port) {
    let u = String(url || '').trim();
    if (!u) return '';
    if (!/^wss?:\/\//i.test(u)) u = (/^(https?):\/\//i.test(u) ? 'wss://' + u.replace(/^https?:\/\//i, '') : 'ws://' + u);
    const p = String(port || '').trim();
    if (p && !/:\d+\s*(\/|$)/.test(u)) {
      const cut = u.indexOf('/', u.indexOf('://') + 3);
      u = (cut === -1) ? u + ':' + p : u.slice(0, cut) + ':' + p + u.slice(cut);
    }
    return u;
  }

  /* 协议文档 payload 里混有全角冒号/逗号、尾逗号，做容错解析 */
  function safeParse(text) {
    try { return JSON.parse(text); } catch (_) {}
    try {
      return JSON.parse(text
        .replace(/：/g, ':').replace(/，/g, ',').replace(/｛/g, '{').replace(/｝/g, '}')
        .replace(/,\s*([}\]])/g, '$1'));
    } catch (_) { return null; }
  }

  const T = {
    login:         sn => 'zhhn/Post/Login/' + sn,
    period:        sn => 'zhhn/Post/PeriodReport/' + sn,
    devdata:       sn => 'zhhn/Get/DevData/' + sn,
    devdataRsp:    sn => 'zhhn/GetRsp/DevData/' + sn,
    emsSet:        sn => 'zhhn/Set/EmsSet/' + sn,
    emsSetRsp:     sn => 'zhhn/SetRsp/EmsSet/' + sn,
    devInfor:      sn => 'zhhn/Get/DeviceInfor/' + sn,
    devInforRsp:   sn => 'zhhn/GetRsp/DeviceInfor/' + sn,
    userInfor:     sn => 'zhhn/Get/UserInfor/' + sn,
    userInforRsp:  () => 'zhhn/GetRsp/UserInfor'   /* 协议示例应答 Topic 不带 SN */
  };
  /* 按报文 payload 里的 identifier 兜底识别业务（防 Topic 写法差异） */
  function bizOf(identifier) {
    return {
      Login: 'login', PeriodReport: 'period', DevData: 'devdata', EmsSet: 'emsset',
      DeviceInfor: 'devinfor', UserInfor: 'userinfor'
    }[identifier] || '';
  }

  function pub(topic, obj, note) {
    if (!client) return false;
    const text = JSON.stringify(obj);
    try { client.publish(topic, text, { qos: 1 }); } catch (e) { return false; }
    log('↑', topic, text, note);
    return true;
  }

  function onMessage(topic, message) {
    const text = new TextDecoder ? new TextDecoder('utf-8').decode(message) : String(message);
    log('↓', topic, text);
    /* PostRsp 是平台下行应答，若回声到自己只记日志，避免把 Login 应答再当新登录处理 */
    if (topic.indexOf('zhhn/PostRsp/') === 0) return;
    const p = safeParse(text);
    if (!p) { console.warn('[mqtt] 非法 JSON:', topic); return; }
    const seg = topic.split('/');
    const sn = seg[3] || '';
    const biz = bizOf(p.identifier) || seg[2] || '';

    switch (biz) {
      case 'login':
        /* 登录应答由后端网关统一回复（页面关着也不掉线），这里只做展示 */
        emit('login', { sn: sn || p.SN || '', payload: p });
        break;
      case 'period':  emit('data', { sn: sn || p.SN || '', report: p }); break;
      case 'devdata': emit('devdata', { sn: sn || p.SN || '', report: p }); break;
      case 'emsset':  emit('setrsp', { sn, payload: p }); break;
      case 'devinfor': emit('devinfor', { sn, payload: p }); break;
      case 'userinfor': emit('userinfor', { payload: p }); break;
      default: break; /* 其他 PostRsp/未知报文仅记录日志 */
    }
  }

  function connect(c) {
    cfg = c || {};
    if (client) { try { client.end(true); } catch (_) {} client = null; }
    if (typeof mqtt === 'undefined') {
      sys('mqtt.js 未加载（请确认 libs/mqtt.min.js 与 index.html 引入正常）');
      emit('conn', { state: 'error', error: 'mqtt.js 未加载' });
      return;
    }
    const url = normUrl(cfg.url, cfg.port);
    if (!url) { sys('Broker 地址为空，无法连接'); emit('conn', { state: 'error', error: 'Broker 地址为空' }); return; }
    cfg.url = url;
    emit('conn', { state: 'connecting', url: url });
    sys('开始连接 Broker：' + url);
    const opts = {
      reconnectPeriod: 5000, connectTimeout: 10000, keepalive: 120, clean: true,
      clientId: 'zhhn-web-' + Math.random().toString(16).slice(2, 10)
    };
    if (c.username) opts.username = c.username;
    if (c.password) opts.password = c.password;
    try { client = mqtt.connect(url, opts); }
    catch (e) { sys('连接异常：' + e.message); emit('conn', { state: 'error', error: e.message }); return; }

    client.on('connect', function () {
      sys('Broker 连接成功，订阅上行 Topic');
      /* 订阅说明：
         · PostRsp 是平台发给 EMS 的应答，平台不订阅（否则收到自己的回声会造成循环）
         · 应答 Topic 段数不一致：GetRsp/UserInfor 是 3 段（无 SN），
           GetRsp/DevData/SN、GetRsp/DeviceInfor/SN、SetRsp/EmsSet/SN 是 4 段，
           必须用 # 才能收全（单个 + 只匹配一段，会漏掉 4 段式的应答）
         · EMQX Cloud Serverless 单客户端最多 10 个订阅，这里收敛为 4 个 */
      [
        'zhhn/Post/Login/+',
        'zhhn/Post/PeriodReport/+',
        'zhhn/GetRsp/#',
        'zhhn/SetRsp/#'
      ].forEach(t => client.subscribe(t, { qos: 0 }, function (err) {
        if (err) sys('订阅失败 ' + t + '：' + (err.message || err));
      }));
      emit('conn', { state: 'connected', url: url });
    });
    client.on('reconnect', function () { emit('conn', { state: 'reconnecting' }); });
    client.on('close', function () { emit('conn', { state: 'disconnected' }); });
    client.on('offline', function () { emit('conn', { state: 'disconnected' }); });
    client.on('error', function (e) {
      sys('连接错误：' + ((e && e.message) || '未知错误'));
      emit('conn', { state: 'error', error: (e && e.message) || '连接错误' });
    });
    client.on('message', onMessage);
  }

  function disconnect() {
    if (client) { try { client.end(true); } catch (_) {} client = null; }
    sys('连接已断开');
    emit('conn', { state: 'disconnected' });
  }
  function isConnected() { return !!(client && client.connected); }

  /* ---- 平台 → EMS ---- */

  /* 实时召测：EMS 按协议每 5s 回 1 帧、连发 60 次 */
  function startDevData(sn) {
    return pub(T.devdata(sn), { identifier: 'DevData', sn: sn, time: now() }, '发起召测');
  }

  /* 通道下发：tagArr = [{deviceTag, wayName, varValue}]（wayName 由调用方按配置映射） */
  function setChannels(sn, tagArr) {
    return pub(T.emsSet(sn), { identifier: 'EmsSet', Tag: tagArr, time: now() }, '下发 ' + tagArr.length + ' 个通道');
  }

  /* 柜内设备清单 */
  function requestDeviceInfor(sn) {
    return pub(T.devInfor(sn), {
      identifier: 'DeviceInfor', sn: sn, msgId: 'web' + Date.now(), time: now()
    }, '查询设备清单');
  }

  /* 用户/电站信息 */
  function requestUserInfor(sn, username, password) {
    return pub(T.userInfor(sn), {
      identifier: 'UserInfor', username: username || '', password: password || '',
      msgId: 'web' + Date.now(), time: now()
    }, '查询用户/电站信息');
  }

  return {
    on, connect, disconnect, isConnected,
    startDevData, setChannels, requestDeviceInfor, requestUserInfor,
    topics: T,
    normUrl, getCfg: function () { return cfg; }
  };
})();
