/* ============================================================
 * 主控：依赖加载 → 初始化 → 数据循环 → UI 交互
 * 依赖库优先从本地 libs/ 目录加载（离线可用），失败再走 CDN。
 * ============================================================ */
(function () {
  'use strict';

  /* ---------- 依赖库加载（本地优先 → jsdelivr → unpkg） ---------- */
  const LOCAL = 'libs/';
  const CDN3 = ['https://cdn.jsdelivr.net/npm/three@0.128.0/', 'https://unpkg.com/three@0.128.0/'];
  const CDNE = [
    'https://cdn.jsdelivr.net/npm/echarts@5.4.3/dist/',
    'https://unpkg.com/echarts@5.4.3/dist/',
    'https://cdn.bootcdn.net/ajax/libs/echarts/5.4.3/'
  ];
  const LIBS = [
    { local: 'echarts.min.js',               remote: 'echarts.min.js',              bases: CDNE, ok: () => typeof echarts !== 'undefined' },
    { local: 'three.min.js',                 remote: 'build/three.min.js',          bases: CDN3, ok: () => typeof THREE !== 'undefined' },
    { local: 'OrbitControls.js',             remote: 'examples/js/controls/OrbitControls.js',          bases: CDN3, ok: () => typeof THREE.OrbitControls !== 'undefined' },
    { local: 'CSS2DRenderer.js',             remote: 'examples/js/renderers/CSS2DRenderer.js',         bases: CDN3, ok: () => typeof THREE.CSS2DRenderer !== 'undefined' },
    { local: 'CopyShader.js',                remote: 'examples/js/shaders/CopyShader.js',              bases: CDN3, ok: () => typeof THREE.CopyShader !== 'undefined' },
    { local: 'LuminosityHighPassShader.js',  remote: 'examples/js/shaders/LuminosityHighPassShader.js', bases: CDN3, ok: () => typeof THREE.LuminosityHighPassShader !== 'undefined' },
    { local: 'EffectComposer.js',            remote: 'examples/js/postprocessing/EffectComposer.js',   bases: CDN3, ok: () => typeof THREE.EffectComposer !== 'undefined' },
    { local: 'RenderPass.js',                remote: 'examples/js/postprocessing/RenderPass.js',       bases: CDN3, ok: () => typeof THREE.RenderPass !== 'undefined' },
    { local: 'ShaderPass.js',                remote: 'examples/js/postprocessing/ShaderPass.js',       bases: CDN3, ok: () => typeof THREE.ShaderPass !== 'undefined' },
    { local: 'UnrealBloomPass.js',           remote: 'examples/js/postprocessing/UnrealBloomPass.js',  bases: CDN3, ok: () => typeof THREE.UnrealBloomPass !== 'undefined' }
  ];

  function loadScript(url) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = url;
      s.onload = res;
      s.onerror = () => { s.remove(); rej(new Error('load fail: ' + url)); };
      document.head.appendChild(s);
    });
  }
  async function loadAny(local, bases, remote, verify) {
    try { await loadScript(LOCAL + local); if (!verify || verify()) return; } catch (_) {}
    let err;
    for (const b of bases) {
      try { await loadScript(b + remote); if (!verify || verify()) return; } catch (e) { err = e; }
    }
    throw err || new Error('lib verify failed: ' + local);
  }
  async function loadLibs() {
    for (const lib of LIBS) await loadAny(lib.local, lib.bases, lib.remote, lib.ok);
  }

  /* MQTT 客户端库（本地 libs/mqtt.min.js 优先，失败走 CDN；失败不阻塞页面启动） */
  async function loadMqtt() {
    try { await loadScript(LOCAL + 'mqtt.min.js'); if (typeof mqtt !== 'undefined') return true; } catch (_) {}
    for (const b of ['https://unpkg.com/mqtt@4.3.7/dist/', 'https://cdn.jsdelivr.net/npm/mqtt@4.3.7/dist/']) {
      try { await loadScript(b + 'mqtt.min.js'); if (typeof mqtt !== 'undefined') return true; } catch (_) {}
    }
    return false;
  }

  /* ---------- 工具 ---------- */
  const byId = id => document.getElementById(id);
  function tweenNum(el, to, fmt) {
    const from = parseFloat(el.dataset.v || '0') || 0;
    el.dataset.v = to;
    const t0 = performance.now(), dur = 600;
    (function step(now) {
      const p = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      const v = from + (to - from) * e;
      el.textContent = fmt ? fmt(v) : Math.round(v).toLocaleString('en-US');
      if (p < 1) requestAnimationFrame(step);
    })(t0);
  }
  function toast(msg) {
    const old = byId('toast'); if (old) old.remove();
    const d = document.createElement('div');
    d.id = 'toast'; d.textContent = msg;
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 2200);
  }

  /* ---------- 应用状态 ---------- */
  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

  function startClock() {
    const tick = () => {
      const d = new Date();
      byId('clockTime').textContent = d.toTimeString().slice(0, 8);
      byId('clockDate').textContent =
        d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
        + ' 星期' + WEEK[d.getDay()];
    };
    tick(); setInterval(tick, 500);
  }

  /* 场景实现按协议切换：高特协议用 5 个储能堆的模型，晶农协议用原场景 */
  function S3D() {
    const gaote = window.MqttUI && MqttUI.protocol && MqttUI.protocol() === 'gaote';
    return (gaote && window.GaoteScene3D) ? window.GaoteScene3D : window.Scene3D;
  }

  /* ---------- 数据渲染 ---------- */
  function renderKpis(d) {
    tweenNum(byId('kpiStorageVal'), d.kpis.chargeToday);
    tweenNum(byId('kpiLoadVal'), d.kpis.loadToday);
    tweenNum(byId('kpiGridVal'), d.kpis.gridToday);
    tweenNum(byId('socVal'), Math.round(d.soc), v => String(Math.round(v)));
    const c = 2 * Math.PI * 33, ring = byId('socRing');
    ring.style.strokeDasharray = c;
    ring.style.strokeDashoffset = c * (1 - d.soc / 100);
  }
  function renderAlarm(list) {
    const bar = byId('alarmBar'), txt = byId('alarmText');
    if (list && list.length) {
      bar.classList.add('bad');
      txt.textContent = '⚠ ' + list.slice(0, 2).join('　');
    } else {
      bar.classList.remove('bad');
      txt.textContent = '本月无告警信息！';
    }
  }
  function onData(d) {
    renderKpis(d);
    Charts.applyData(d);
    S3D().update(d);
    renderAlarm(d.alarms);
  }

  /* ---------- UI 绑定 ---------- */
  function bindUI() {
    // 顶部导航（三个 Tab：电站监控 / 充放电策略 / 电芯健康）
    byId('mainTabs').addEventListener('click', e => {
      const btn = e.target.closest('.tab'); if (!btn) return;
      byId('mainTabs').querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (window.MqttUI) MqttUI.openTab(btn.dataset.tab);
    });
    // 场景按钮
    byId('btnLabels').addEventListener('click', () => {
      const on = S3D().toggleLabels();
      byId('btnLabels').classList.toggle('active', on);
    });
    byId('btnRotate').addEventListener('click', () => {
      const on = S3D().toggleRotate();
      byId('btnRotate').classList.toggle('active', on);
    });
    S3D().setRotateSync(on => byId('btnRotate').classList.toggle('active', on));
    byId('btnReset').addEventListener('click', () => { S3D().resetView(); toast('视角已重置'); });
    // 全屏
    byId('btnFullscreen').addEventListener('click', () => {
      if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
      else document.exitFullscreen();
    });
    // 窗口尺寸
    window.addEventListener('resize', () => { Charts.resize(); S3D().resize(); });
  }

  /* ---------- 启动 ---------- */
  function boot() {
    const loading = byId('bootLoading');
    if (loading) loading.remove();

    document.title = APP_CONFIG.siteName;
    byId('siteName').textContent = APP_CONFIG.siteName;
    byId('stationName').textContent = APP_CONFIG.stationName;
    byId('sceneTitle').textContent = APP_CONFIG.stationName + '运行监测图';

    try { Charts.init(); } catch (e) { console.error(e); }
    try { S3D().init(byId('scene3d')); } catch (e) {
      console.error(e);
      toast('3D 场景初始化失败（WebGL 不可用？），图表功能不受影响');
    }
    bindUI();
    startClock();
    try { if (window.MqttUI) MqttUI.init(); } catch (e) { console.error(e); }
    try { if (window.OverviewUI) OverviewUI.init(); } catch (e) { console.error(e); }
    DataService.start(onData);
  }

  /* 先加载 3D/图表依赖，再（可选）加载 MQTT 库，最后启动 */
  loadLibs()
    .then(loadMqtt)
    .catch(() => false)
    .then(boot)
    .catch(() => {
      const el = byId('bootLoading');
      if (el) el.innerHTML = '<div class="bl-box"><p class="err">依赖库（Three.js / ECharts）加载失败。<br/>请检查网络，或将库文件放入 libs/ 目录后刷新（详见 README.md）。</p></div>';
    });
})();
