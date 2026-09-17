/* ============================================================
 * 高特 CCU 下发（遥调 / 遥控）
 *
 * 依据协议文档 SJ2025B3781ESCCU-MQTT.xlsx 的「遥调」「遥控」工作表自动生成表单：
 *   主题：/{ProductSN}/{DeviceSN}/cmd/set/emu/{功能}   （V2 功能在 emu 后带 /v2）
 *   报文：JSON，KEY 为点号，值为设定值
 *   设备收到后立即回读 /cmd/get/emu/... ，用于判断下发是否成功
 *
 * 下发前置条件（协议手册 6.1）：
 *   ① 现场把控制源切到「远程」（只能本地操作）
 *   ② 先下发 powerCmd 设置指令模式
 *   ③ 再下发具体指令
 * ============================================================ */
window.GaoteStrategy = (function () {
  'use strict';

  const byId = id => document.getElementById(id);
  const GROUPS = [
    { g: '运行控制', keys: ['powerCmd', 'totalPower', 'dispatchPower'] },
    { g: '计划与套利', keys: ['planPower', 'peakValleyPower'] },
    { g: '防逆流', keys: ['antiRefluxCtrl', 'memsAntiReflux', 'lemsAntiReflux', 'aemsAntiReflux'] },
    { g: '需量控制', keys: ['memsStaticDemand', 'lemsStaticDemand', 'aemsStaticDemand', 'memsDynamicDemand', 'lemsDynamicDemand', 'aemsDynamicDemand'] },
    { g: '安全', keys: ['emsStop'] }
  ];
  const TITLES = {
    powerCmd: '指令模式（必须先下发）', totalPower: '总功率设置', dispatchPower: '功率调度',
    planPower: '24 小时计划', peakValleyPower: '峰谷套利', antiRefluxCtrl: '防逆流参数（V1）',
    memsAntiReflux: 'MEMS 防逆流（V2）', lemsAntiReflux: 'LEMS 防逆流（V2）', aemsAntiReflux: 'AEMS 防逆流（V2）',
    memsStaticDemand: 'MEMS 静态需量（V2）', lemsStaticDemand: 'LEMS 静态需量（V2）', aemsStaticDemand: 'AEMS 静态需量（V2）',
    memsDynamicDemand: 'MEMS 动态需量（V2）', lemsDynamicDemand: 'LEMS 动态需量（V2）', aemsDynamicDemand: 'AEMS 动态需量（V2）',
    emsStop: '远程急停（遥控）'
  };

  /* 由主题定义解析出 set 主题路径 */
  function setTopic(key) {
    if (typeof GAOTE === 'undefined') return null;
    const cfg = GaoteService.getCfg() || {};
    const psn = cfg.productSN || 'kp23bhcpmt91n2v8';
    const dsn = cfg.deviceSN || '{DeviceSN}';
    const list = (GAOTE.topics || []).filter(t => t.down && t.down.indexOf('/emu/') >= 0 && t.down.split('/').pop() === key);
    const tmpl = list.length ? list[0].down : '/${ProductSN}/${DeviceSN}/cmd/set/emu/' + key;
    return tmpl.replace('${ProductSN}', psn).replace('${DeviceSN}', dsn);
  }
  function getTopic(key) {
    return setTopic(key).replace('/cmd/set/', '/cmd/get/');
  }

  /* 协议文档里缺失、但手册正文明确给出的枚举（手册 4.3 / 6.1 节） */
  const ENUM_FIX = {
    powerCmd: {
      0: { 0: '远程子系统', 1: '峰谷套利', 2: '远程总功率', 3: '功率调度-不允许馈网', 4: '功率调度-允许馈网' }
    }
  };
  function enumOf(key, p) {
    return p.e || (ENUM_FIX[key] && ENUM_FIX[key][p.i]) || null;
  }

  function fieldHtml(key, p) {
    const id = 'gs_' + key + '_' + p.i;
    const label = (p.n || p.k || ('点' + p.i)) + (p.u ? ' (' + p.u + ')' : '');
    const en = enumOf(key, p);
    if (en) {
      const opts = Object.keys(en).map(v => '<option value="' + v + '">' + v + ' - ' + en[v] + '</option>').join('');
      return '<label class="gs-field" title="点号 ' + p.i + ' / ' + (p.k || '') + '"><span>' + label + '</span>'
        + '<select data-i="' + p.i + '" data-k="' + (p.k || '') + '" id="' + id + '"><option value="">未设置</option>' + opts + '</select></label>';
    }
    const isArr = /\[0-x\]/.test(p.n || '');
    if (isArr) {
      return '<label class="gs-field wide" title="点号 ' + p.i + ' / ' + (p.k || '') + '"><span>' + label + '<em>逗号分隔</em></span>'
        + '<input data-i="' + p.i + '" data-k="' + (p.k || '') + '" data-arr="1" id="' + id + '" placeholder="如 0,50,-100,0,…"/></label>';
    }
    const t = (p.t || '').toLowerCase();
    const step = /float|double/.test(t) ? '0.1' : '1';
    return '<label class="gs-field" title="点号 ' + p.i + ' / ' + (p.k || '') + '"><span>' + label + '</span>'
      + '<input type="number" step="' + step + '" data-i="' + p.i + '" data-k="' + (p.k || '') + '" id="' + id + '" placeholder="未设置"/></label>';
  }

  function buildForm() {
    const host = byId('strategyView');
    if (!host || typeof GAOTE === 'undefined') return;
    let html = '<div class="st-top"><div class="st-desc">'
      + '按高特协议下发：<b>/cmd/set/emu/{功能}</b>，报文体为 JSON（KEY＝点号）。'
      + '设备收到后会立即回读 <b>/cmd/get/emu/…</b>，下发结果显示在每组下方。</div>'
      + '<div class="st-src" id="gsSrc">—</div></div>';

    /* 前置提示 */
    html += '<div class="gs-warn">⚠️ 下发前请确认：① 现场已把控制源切到「远程」；② 先下发「指令模式」；'
      + '③ 现场有人值守。下发会直接改变储能系统的运行方式。</div>';
    html += '<div class="gs-quick"><span>快捷：</span>'
      + '<button class="mq-btn" data-quick="powerCmd:0">远程子系统</button>'
      + '<button class="mq-btn" data-quick="powerCmd:2">远程总功率</button>'
      + '<button class="mq-btn" data-quick="powerCmd:1">峰谷套利</button>'
      + '<button class="mq-btn" data-quick="powerCmd:3">功率调度(不馈网)</button>'
      + '<button class="mq-btn" data-quick="powerCmd:4">功率调度(允许馈网)</button>'
      + '</div>';

    GROUPS.forEach(function (grp) {
      html += '<div class="st-group gs-group"><div class="st-gtitle">' + grp.g + '</div>';
      grp.keys.forEach(function (key) {
        const pts = (GAOTE.setpoints || {})[key];
        if (!pts || !pts.length) return;
        const usable = pts.filter(p => (p.k || '') !== 'Ts' && !/时间戳/.test(p.n || ''));
        html += '<div class="gs-topic" data-topic="' + key + '">'
          + '<div class="gs-thead"><b>' + (TITLES[key] || key) + '</b>'
          + '<code>' + setTopic(key) + '</code></div>'
          + '<div class="gs-grid">' + usable.map(p => fieldHtml(key, p)).join('') + '</div>'
          + '<div class="gs-actions"><button class="mq-btn primary" data-send="' + key + '">下发</button>'
          + '<button class="mq-btn" data-clear="' + key + '">清空</button>'
          + '<button class="mq-btn" data-read="' + key + '">读取当前值</button>'
          + '<span class="gs-count" data-count="' + key + '">已填 0 项</span></div>'
          + '<div class="gs-rsp" id="gs_rsp_' + key + '">尚未下发</div>'
          + '<div class="gs-cur" id="gs_cur_' + key + '">当前值：—</div>'
          + '</div>';
      });
      html += '</div>';
    });
    host.innerHTML = html;

    host.addEventListener('click', function (e) {
      const q = e.target.closest('[data-quick]');
      if (q) {
        const [k, v] = q.dataset.quick.split(':');
        const el = byId('gs_' + k + '_0');
        if (el) { el.value = v; updateCount(k); toast('已填入「' + (TITLES[k] || k) + '」= ' + v + '，请点下发的按钮'); }
        return;
      }
      const send = e.target.closest('[data-send]');
      if (send) { submit(send.dataset.send); return; }
      const clr = e.target.closest('[data-clear]');
      if (clr) { clearTopic(clr.dataset.clear); return; }
      const rd = e.target.closest('[data-read]');
      if (rd) { readCurrent(rd.dataset.read); return; }
    });
    host.addEventListener('input', function (e) {
      const t = e.target.closest('.gs-topic');
      if (t) updateCount(t.dataset.topic);
    });
  }

  function inputsOf(key) {
    return Array.prototype.slice.call(document.querySelectorAll('.gs-topic[data-topic="' + key + '"] input, .gs-topic[data-topic="' + key + '"] select'))
      .filter(el => String(el.value || '').trim() !== '');
  }
  function updateCount(key) {
    const el = document.querySelector('[data-count="' + key + '"]');
    if (el) el.textContent = '已填 ' + inputsOf(key).length + ' 项';
  }
  function clearTopic(key) {
    document.querySelectorAll('.gs-topic[data-topic="' + key + '"] input, .gs-topic[data-topic="' + key + '"] select')
      .forEach(el => { el.value = ''; });
    updateCount(key);
  }

  function payloadOf(key) {
    const out = {};
    inputsOf(key).forEach(function (el) {
      const i = el.dataset.i;
      let v = String(el.value).trim();
      if (el.dataset.arr) {
        out[i] = v.split(/[,\s]+/).filter(s => s !== '').map(s => isFinite(parseFloat(s)) ? parseFloat(s) : s);
      } else if (isFinite(parseFloat(v)) && /^-?\d+(\.\d+)?$/.test(v)) {
        out[i] = parseFloat(v);
      } else {
        out[i] = v;
      }
    });
    return out;
  }

  function submit(key) {
    if (typeof GaoteService === 'undefined' || !GaoteService.isConnected()) return toast('请先连接 Broker');
    const cfg = GaoteService.getCfg() || {};
    if (!cfg.deviceSN) return toast('未填设备 SN（DeviceSN），无法确定下发主题');
    const payload = payloadOf(key);
    const n = Object.keys(payload).length;
    if (!n) return toast('请至少填写一项');
    /* 时间戳由平台补齐 */
    const pts = (GAOTE.setpoints || {})[key] || [];
    const tsPt = pts.filter(p => (p.k || '') === 'Ts')[0];
    if (tsPt) payload[tsPt.i] = Math.floor(Date.now() / 1000);
    const topic = setTopic(key);
    const ok = GaoteService.publish(topic, payload);
    const box = byId('gs_rsp_' + key);
    if (box) {
      box.className = 'gs-rsp pending';
      box.textContent = (ok ? '已下发 ' : '下发失败：') + n + ' 个点 → ' + topic + '　等待设备回读 cmd/get…';
    }
    if (ok) toast('已下发「' + (TITLES[key] || key) + '」' + n + ' 个点');
  }

  function readCurrent(key) {
    if (typeof GaoteService === 'undefined' || !GaoteService.isConnected()) return toast('请先连接 Broker');
    GaoteService.publish(getTopic(key), {}, '读取当前值');
    toast('已发送读取请求：' + getTopic(key));
  }

  /* 设备回读 → 显示当前值 */
  function onRead(key, obj) {
    const box = byId('gs_cur_' + key);
    if (!box) return;
    const pts = (GAOTE.setpoints || {})[key] || [];
    const parts = Object.keys(obj).map(function (i) {
      const def = pts.filter(p => String(p.i) === String(i))[0];
      const name = def ? (def.n || def.k) : ('点' + i);
      return name + '=' + JSON.stringify(obj[i]);
    });
    box.textContent = '当前值：' + (parts.length ? parts.join('　') : '（空）') + '　@' + new Date().toTimeString().slice(0, 8);
    const rsp = byId('gs_rsp_' + key);
    if (rsp && rsp.classList.contains('pending')) {
      rsp.className = 'gs-rsp ok';
      rsp.textContent = '[' + new Date().toTimeString().slice(0, 8) + '] 设备已回读 ' + getTopic(key) + '，下发生效';
    }
  }

  function init() {
    buildForm();
    if (typeof GaoteService !== 'undefined') {
      GaoteService.on('cmdget', function (d) {
        if (d && d.func) onRead(d.func, d.payload || {});
      });
      GaoteService.on('conn', function () {
        const el = byId('gsSrc');
        if (el) {
          const cfg = GaoteService.getCfg() || {};
          el.textContent = GaoteService.isConnected()
            ? '已连接 · 下发目标 ' + (cfg.deviceSN || '未填 SN')
            : '未连接 Broker';
        }
      });
    }
    const el = byId('gsSrc');
    if (el) {
      const cfg = (typeof GaoteService !== 'undefined' && GaoteService.getCfg()) || {};
      el.textContent = (typeof GaoteService !== 'undefined' && GaoteService.isConnected())
        ? '已连接 · 下发目标 ' + (cfg.deviceSN || '未填 SN') : '未连接 Broker';
    }
  }

  function toast(msg) {
    const old = byId('toast'); if (old) old.remove();
    const d = document.createElement('div');
    d.id = 'toast'; d.textContent = msg;
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 2400);
  }

  return { init, buildForm, submit, setTopic, getTopic };
})();
