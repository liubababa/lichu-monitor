/* ============================================================
 * 洙边卫生院站 · 光伏三维场景
 *
 *   屋顶光伏阵列 + 逆变器 + 通信模块 + 并网点 + 卫生院建筑，
 *   能量从组件流向逆变器、再流向并网点（晴天亮、夜里停）。
 *
 *   天气（SolarScene.setWeather）驱动画面：
 *     云量 → 天空/光照亮度、云朵多少
 *     降水 → 雨/雪粒子
 *     辐照度 → 组件反光强度
 *     昼夜（is_day）→ 太阳 / 月亮
 *   发电功率（SolarScene.setPower）驱动：
 *     组件发光、能量粒子流速、逆变器指示灯
 * ============================================================ */
window.SolarScene = (function () {
  'use strict';

  let inited = false, root = null, scene, camera, renderer, controls, labelR = null;
  let sun = null, moon = null, sunLight = null, hemi = null, cloudGroup = null, precipGroup = null;
  let flowDots = [], flowCurve = null, panelMats = [], invLeds = [], invLabelEl = null, arrLabelEl = null;
  let raf = null, W = 0, H = 0;
  const mats = [];                 // { m, night:{...}, day:{...} }
  let cur = { power: 0, cap: 110.16, cloud: 0, precip: 0, isDay: 1, radiation: 0 };
  let theme = 'night';

  const THREE_ = () => window.THREE;

  /* ---------------- 基础工具 ---------------- */
  function regMat(m, night, day) { mats.push({ m: m, night: night || {}, day: day || {} }); return m; }
  function std(color, o) {
    const p = Object.assign({ roughness: .7, metalness: .2 }, o || {});
    return new THREE.MeshStandardMaterial({ color: color, roughness: p.roughness, metalness: p.metalness });
  }
  function box(w, h, d, mat, x, y, z) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x || 0, y || 0, z || 0);
    m.castShadow = m.receiveShadow = true;
    return m;
  }
  function label(text, cls, x, y, z, parent) {
    const wrap = document.createElement('div');
    const el = document.createElement('div');
    el.className = 'tag3d ' + (cls || 'tag3d-gt');
    el.innerHTML = text;
    wrap.appendChild(el);
    const o = new THREE.CSS2DObject(wrap);
    o.position.set(x, y, z);
    (parent || root).add(o);
    return el;
  }

  /* 组件面板贴图：深蓝电池片 + 细栅线 */
  function panelTexture() {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 160;
    const g = c.getContext('2d');
    g.fillStyle = '#0d2a45'; g.fillRect(0, 0, 256, 160);
    for (let y = 6; y < 160; y += 25) {
      for (let x = 6; x < 256; x += 32) {
        g.fillStyle = '#123a5e';
        g.fillRect(x, y, 29, 22);
        g.strokeStyle = 'rgba(150,200,255,.18)';
        g.lineWidth = 1;
        g.strokeRect(x + 0.5, y + 0.5, 29, 22);
      }
    }
    g.strokeStyle = 'rgba(200,225,255,.35)';
    g.lineWidth = 2;
    g.strokeRect(1, 1, 254, 158);
    const t = new THREE.CanvasTexture(c);
    t.anisotropy = 4;
    return t;
  }

  /* 卫生院外墙贴图：浅色墙面 + 窗带 */
  function wallTexture() {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = '#dfe3dd'; g.fillRect(0, 0, 512, 256);
    g.fillStyle = 'rgba(0,0,0,.05)';
    for (let x = 0; x < 512; x += 64) g.fillRect(x, 0, 2, 256);
    g.fillStyle = '#2d4a56';
    for (let x = 26; x < 512; x += 96) g.fillRect(x, 60, 62, 46);
    g.fillStyle = 'rgba(255,255,255,.35)';
    for (let x = 26; x < 512; x += 96) g.fillRect(x, 60, 62, 8);
    g.fillStyle = '#5d6f74'; g.fillRect(0, 232, 512, 24);
    const t = new THREE.CanvasTexture(c);
    return t;
  }

  /* ---------------- 场景搭建 ---------------- */
  function build() {
    const T = THREE_();
    scene = new T.Scene();

    /* 天空与雾（随主题/天气调整） */
    scene.background = new T.Color(0x04090c);
    scene.fog = new T.Fog(0x04090c, 60, 220);

    camera = new T.PerspectiveCamera(46, 1, .1, 600);
    camera.position.set(26, 17, 32);

    renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = T.PCFSoftShadowMap;
    const host = document.getElementById('solar3d');
    host.appendChild(renderer.domElement);

    /* 标签渲染器：与 WebGL 渲染同一个场景（HTML 浮标） */
    if (typeof T.CSS2DRenderer === 'function') {
      labelR = new T.CSS2DRenderer();
      labelR.domElement.style.position = 'absolute';
      labelR.domElement.style.top = '0';
      labelR.domElement.style.left = '0';
      labelR.domElement.style.pointerEvents = 'none';
      host.appendChild(labelR.domElement);
      const render0 = renderer.render.bind(renderer);
      renderer.render = function (s, c) { render0(s, c); labelR.render(s, c); };
    }

    if (typeof T.OrbitControls === 'function') {
      controls = new T.OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true; controls.dampingFactor = .08;
      controls.minDistance = 14; controls.maxDistance = 90;
      controls.maxPolarAngle = 1.32;
      controls.target.set(0, 3, 0);
      controls.update();
    }

    root = new T.Group();
    scene.add(root);

    hemi = new T.HemisphereLight(0xbfe9ff, 0x14202a, .8);
    scene.add(hemi);
    sunLight = new T.DirectionalLight(0xfff2d0, 1.1);
    sunLight.position.set(28, 34, 18);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(2048, 2048);
    const sc = sunLight.shadow.camera;
    sc.left = -46; sc.right = 46; sc.top = 46; sc.bottom = -46; sc.far = 160;
    scene.add(sunLight);

    /* ---------- 地面 / 场地 ---------- */
    const ground = new T.Mesh(new T.PlaneGeometry(400, 400),
      regMat(std(0x0a1a20, { roughness: .95 }), { color: 0x0a1a20 }, { color: 0xa9b6a8 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    root.add(ground);

    const pad = box(60, .18, 34, regMat(std(0x11242a, { roughness: .9 }), { color: 0x11242a }, { color: 0xc9cdc4 }), 0, .09, 2);
    root.add(pad);

    /* ---------- 卫生院建筑 ---------- */
    const wallMat = regMat(new T.MeshStandardMaterial({ map: wallTexture(), roughness: .8, metalness: .05 }),
      { map: wallTexture() }, { map: wallTexture() });
    const W2 = 26, H2 = 4.2, D2 = 16;
    root.add(box(W2 + .8, .3, D2 + .8, regMat(std(0x0d1c22, { roughness: .9 }), { color: 0x0d1c22 }, { color: 0xb2b8ad }), 0, .15, 0));
    const bld = new T.Mesh(new T.BoxGeometry(W2, H2, D2), [wallMat, wallMat, wallMat, wallMat, wallMat, wallMat]);
    bld.position.set(0, H2 / 2 + .3, 0);
    bld.castShadow = bld.receiveShadow = true;
    root.add(bld);
    /* 屋顶女儿墙 */
    const par = regMat(std(0x0e2028, { roughness: .85 }), { color: 0x0e2028 }, { color: 0xbfc4b9 });
    [[W2, .3], [D2, .3]].forEach(function () {});
    root.add(box(W2 + .6, .5, .3, par, 0, H2 + .5, -D2 / 2));
    root.add(box(W2 + .6, .5, .3, par, 0, H2 + .5, D2 / 2));
    root.add(box(.3, .5, D2 + .6, par, -W2 / 2, H2 + .5, 0));
    root.add(box(.3, .5, D2 + .6, par, W2 / 2, H2 + .5, 0));
    /* 正门雨棚 + 台阶 + 十字标 */
    root.add(box(4.6, .16, 1.6, regMat(std(0x12262e, { roughness: .7 }), { color: 0x12262e }, { color: 0xc6cbc0 }), 0, H2 - .4, D2 / 2 + .8));
    root.add(box(4.2, .18, 1.1, regMat(std(0x0d1c22, { roughness: .9 }), { color: 0x0d1c22 }, { color: 0xb8beb4 }), 0, .4, D2 / 2 + .7));
    const cross = new T.MeshBasicMaterial({ color: 0x22d3a0 });
    root.add(box(.9, .26, .08, cross, 6.4, H2 - .2, D2 / 2 + .08));
    root.add(box(.26, .9, .08, cross, 6.4, H2 - .2, D2 / 2 + .08));

    /* ---------- 屋顶光伏阵列：4 排 × 8 列 ---------- */
    const pTex = panelTexture();
    const frameMat = regMat(std(0x8fa3a8, { roughness: .45, metalness: .65 }), { color: 0x8fa3a8 }, { color: 0xcfd6d8 });
    const backMat = regMat(std(0x1a2a30, { roughness: .8 }), { color: 0x1a2a30 }, { color: 0x9fa8a4 });
    const rows = 4, cols = 8, tw = 2.9, td = 2.2, tilt = -.42;
    const roofY = H2 + .3;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const g = new T.Group();
        const mat = regMat(new T.MeshStandardMaterial({
          map: pTex, roughness: .32, metalness: .5,
          emissive: new T.Color(0x0a2b4a), emissiveIntensity: .25
        }), { emissiveIntensity: .25, emissive: new T.Color(0x0a2b4a) }, { emissiveIntensity: .06, emissive: new T.Color(0x08172a) });
        panelMats.push(mat);
        const pan = new T.Mesh(new T.BoxGeometry(tw, .07, td), mat);
        pan.castShadow = pan.receiveShadow = true;
        g.add(pan);
        g.add(box(tw + .06, .05, .1, frameMat, 0, -.045, td / 2));
        g.add(box(tw + .06, .05, .1, frameMat, 0, -.045, -td / 2));
        const leg = box(.09, .7, .09, frameMat, 0, -.38, td / 2 - .2);
        const leg2 = box(.09, 1.15, .09, frameMat, 0, -.6, -td / 2 + .2);
        g.add(leg); g.add(leg2);
        const back = box(tw - .4, .8, .06, backMat, 0, -.5, 0);
        g.add(back);
        g.position.set(-((cols - 1) * 3.15) / 2 + c * 3.15, roofY + 1.0, -((rows - 1) * 3.4) / 2 + r * 3.4);
        g.rotation.x = tilt;
        root.add(g);
      }
    }
    /* 阵列两侧的检修通道 */
    root.add(box(cols * 3.15, .04, 1.6, regMat(std(0x16323a, { roughness: .8 }), { color: 0x16323a }, { color: 0xc2c7bc }), 0, roofY + .04, ((rows - 1) * 3.4) / 2 + 1.6));

    /* ---------- 逆变器（挂在建筑东侧墙外） ---------- */
    const invG = new T.Group();
    invG.position.set(W2 / 2 + .5, 1.9, 1.2);
    const invBody = regMat(std(0x22333a, { roughness: .5, metalness: .5 }), { color: 0x22333a }, { color: 0xc6ccce });
    invG.add(box(.42, 1.5, 1.1, invBody, 0, 0, 0));
    invG.add(box(.06, .6, .8, regMat(std(0x0a1418, { roughness: .35 }), { color: 0x0a1418 }, { color: 0x2e3d40 }), .24, .28, 0));
    invG.add(box(.42, .1, 1.14, regMat(std(0x0f2126, { roughness: .8 }), { color: 0x0f2126 }, { color: 0xb6bcbe }), 0, .78, 0));
    root.add(invG);
    /* 指示灯（发电时亮绿） */
    for (let i = 0; i < 3; i++) {
      const m = new T.MeshBasicMaterial({ color: 0x1f8a6a });
      const led = new T.Mesh(new T.SphereGeometry(.045, 8, 8), m);
      led.position.set(.25, .5 - i * .16, -.34 + i * .34);
      invG.add(led);
      invLeds.push(m);
    }
    invLabelEl = label('逆变器 · SG100CX-P2-CN<br><b>--</b>', 'tag3d tag3d-gt', W2 / 2 + .5, 3.1, 1.2);

    /* ---------- 通信模块（立杆） ---------- */
    const poleMat = regMat(std(0x9fb0b4, { roughness: .5, metalness: .6 }), { color: 0x9fb0b4 }, { color: 0xc8d0d2 });
    root.add(box(.12, 3.0, .12, poleMat, W2 / 2 + 2.2, 1.5 + .3, -2.6));
    const eye = box(.5, .5, .34, regMat(std(0xe8eef0, { roughness: .5 }), { color: 0xe8eef0 }, { color: 0xeef2f2 }), W2 / 2 + 2.2, 2.7, -2.6);
    root.add(eye);
    root.add(box(.04, .5, .04, poleMat, W2 / 2 + 2.2, 3.2, -2.6));
    label('通信模块 · EyeS4', 'tag3d tag3d-gt', W2 / 2 + 2.2, 3.7, -2.6);

    /* ---------- 并网点（计量箱） ---------- */
    root.add(box(.5, 1.2, .9, regMat(std(0x3a4a4e, { roughness: .55, metalness: .4 }), { color: 0x3a4a4e }, { color: 0xbfc6c8 }), -W2 / 2 - 1.6, 1.0, D2 / 2 - 2.0));
    root.add(box(.12, 2.2, .12, poleMat, -W2 / 2 - 1.6, 2.6, D2 / 2 - 2.0));
    label('并网点', 'tag3d tag3d-gt', -W2 / 2 - 1.6, 3.0, D2 / 2 - 2.0);

    /* ---------- 能量流：组件 → 逆变器 → 并网点 ---------- */
    const pts = [
      new T.Vector3(-6, roofY + 1.6, 2),
      new T.Vector3(6, roofY + 1.5, 2.2),
      new T.Vector3(W2 / 2 + .9, 2.2, 1.2),
      new T.Vector3(W2 / 2 + 1.2, 1.0, -1.0),
      new T.Vector3(-W2 / 2 - 1.6, 1.8, D2 / 2 - 2.0)
    ];
    flowCurve = new T.CatmullRomCurve3(pts, false, 'catmullrom', .25);
    const tubeMat = new T.MeshBasicMaterial({ color: 0x2ee6c8, transparent: true, opacity: .18 });
    const tube = new T.Mesh(new T.TubeGeometry(flowCurve, 120, .05, 6, false), tubeMat);
    root.add(tube);
    for (let i = 0; i < 26; i++) {
      const m = new T.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: .95 });
      const d = new T.Mesh(new T.SphereGeometry(.12, 8, 8), m);
      d.userData.t = i / 26;
      root.add(d);
      flowDots.push(d);
    }

    /* ---------- 天气：太阳 / 月亮 / 云 / 降水 ---------- */
    sun = new T.Mesh(new T.SphereGeometry(2.6, 18, 18), new T.MeshBasicMaterial({ color: 0xffd66b }));
    sun.position.set(46, 40, 24);
    root.add(sun);
    moon = new T.Mesh(new T.SphereGeometry(1.9, 18, 18), new T.MeshBasicMaterial({ color: 0xdfe9f5 }));
    moon.position.set(-40, 38, 18);
    moon.visible = false;
    root.add(moon);

    cloudGroup = new T.Group();
    const cloudMat = new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: .0 });
    for (let i = 0; i < 9; i++) {
      const cg = new T.Group();
      for (let k = 0; k < 4; k++) {
        const s = new T.Mesh(new T.SphereGeometry(2.6 + Math.random() * 2.2, 10, 10), cloudMat.clone());
        s.position.set(k * 3.1 - 4.4, Math.random() * 1.2, Math.random() * 2.4 - 1.2);
        s.material.opacity = .7 + Math.random() * .25;
        cg.add(s);
      }
      cg.position.set((Math.random() - .5) * 120, 30 + Math.random() * 14, (Math.random() - .5) * 100);
      cg.userData.speed = .35 + Math.random() * .5;
      cloudGroup.add(cg);
    }
    root.add(cloudGroup);

    precipGroup = new T.Group();
    const rainMat = new T.MeshBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: .55 });
    for (let i = 0; i < 420; i++) {
      const p = new T.Mesh(new T.CylinderGeometry(.022, .022, .9, 4), rainMat);
      p.position.set((Math.random() - .5) * 70, Math.random() * 26 + 2, (Math.random() - .5) * 60);
      precipGroup.add(p);
    }
    root.add(precipGroup);

    /* 场景标签 */
    arrLabelEl = label('屋顶光伏阵列<br><b>110.16 kWp</b>', 'tag3d tag3d-gt', 0, roofY + 5.2, 0);
    label('洙边卫生院', 'tag3d tag3d-gt', 0, H2 + 1.2, -D2 / 2 - .8);

    applyTheme();
    resize();
    inited = true;
    loop();
  }

  /* ---------------- 主题（页面白天/夜晚） ---------------- */
  function applyTheme() {
    theme = document.documentElement.getAttribute('data-theme') === 'day' ? 'day' : 'night';
    mats.forEach(function (r) {
      const v = r[theme] || {};
      if (v.color !== undefined && r.m.color) r.m.color.setHex(v.color);
      if (v.map !== undefined) r.m.map = v.map;
      if (v.emissiveIntensity !== undefined) r.m.emissiveIntensity = v.emissiveIntensity;
      if (v.emissive !== undefined && r.m.emissive) r.m.emissive.copy(v.emissive);
      r.m.needsUpdate = true;
    });
    refreshSkyLight();
  }

  /* ---------------- 天气 / 功率 ---------------- */
  function refreshSkyLight() {
    const T = THREE_();
    const cloud = Math.max(0, Math.min(100, Number(cur.cloud) || 0));
    const rad = Math.max(0, Number(cur.radiation) || 0);
    const day = !!cur.isDay;
    const dayTheme = theme === 'day';

    const sky = dayTheme
      ? (day ? 0x9fc7e8 : 0x1a2733)
      : (day ? 0x123048 : 0x04090c);
    const bg = new T.Color(sky);
    const dim = 1 - cloud / 100 * .55;
    scene.background = bg;
    scene.fog.color = bg;
    scene.fog.near = dayTheme ? 90 : 60;
    scene.fog.far = dayTheme ? 260 : 200;

    const sunI = day ? (0.35 + (rad > 0 ? Math.min(1, rad / 900) : .35)) * dim * (dayTheme ? 1.15 : .9) : .05;
    sunLight.intensity = sunI;
    hemi.intensity = (day ? .75 : .22) * (dayTheme ? 1.1 : 1) * dim;
    sun.visible = day;
    moon.visible = !day;
    const cf = cloud / 100;
    cloudGroup.children.forEach(function (cg) {
      cg.visible = cf > .08;
      cg.children.forEach(function (s) { s.material.opacity = (0.35 + cf * 0.6) * (dayTheme ? 1 : .5); });
    });
    precipGroup.visible = Number(cur.precip) > 0;
    precipGroup.children.forEach(function (p) { p.material.opacity = cf > .5 ? .6 : .45; });
  }

  function setWeather(w) {
    if (!w) return;
    cur.cloud = w.cloud;
    cur.precip = w.precip;
    cur.isDay = w.is_day === 0 || w.is_day === '0' ? 0 : 1;
    cur.radiation = w.radiation;
    refreshSkyLight();
  }

  /* 发电功率：驱动组件发光、粒子流速、指示灯 */
  function setPower(kw, capKw) {
    cur.power = Number(kw) || 0;
    if (capKw) cur.cap = Number(capKw) || cur.cap;
    const ratio = Math.max(0, Math.min(1, cur.power / (cur.cap || 1)));
    const day = theme === 'day';
    panelMats.forEach(function (m) {
      m.emissiveIntensity = (day ? .06 : .25) + ratio * (day ? .55 : .85);
      m.emissive.setHex(ratio > .02 ? (day ? 0x1c5f96 : 0x0f4f7a) : 0x0a2b4a);
    });
    invLeds.forEach(function (m, i) {
      m.color.setHex(ratio > .02 ? 0x2ee6c8 : (i === 0 ? 0x8a7a2a : 0x2a3a3a));
    });
    flowDots.forEach(function (d) { d.visible = ratio > .01; });
    if (invLabelEl) invLabelEl.innerHTML = '逆变器 · SG100CX-P2-CN<br><b>' + cur.power.toFixed(2) + ' kW</b>';
  }

  /* ---------------- 主循环 ---------------- */
  function loop() {
    raf = requestAnimationFrame(loop);
    const T = THREE_();
    const t = performance.now() / 1000;
    const ratio = Math.max(0, Math.min(1, cur.power / (cur.cap || 1)));
    /* 能量粒子沿曲线流动，速度随功率 */
    if (flowCurve) {
      const sp = .02 + ratio * .5;
      flowDots.forEach(function (d) {
        d.userData.t = (d.userData.t + sp * .016) % 1;
        const p = flowCurve.getPointAt(d.userData.t);
        d.position.copy(p);
        d.material.opacity = .25 + ratio * .75;
      });
    }
    /* 云飘 */
    if (cloudGroup) {
      cloudGroup.children.forEach(function (cg) {
        cg.position.x += cg.userData.speed * .016;
        if (cg.position.x > 70) cg.position.x = -70;
      });
    }
    /* 雨雪下落 */
    if (precipGroup && precipGroup.visible) {
      precipGroup.children.forEach(function (p) {
        p.position.y -= (2.4 + (p.position.y % 2)) * .06;
        if (p.position.y < 0) p.position.y = 26;
      });
    }
    if (controls) controls.update();
    renderer.render(scene, camera);
  }

  function resize() {
    if (!renderer) return;
    const host = document.getElementById('solar3d');
    if (!host) return;
    const w = host.clientWidth || 800, h = host.clientHeight || 480;
    if (w === W && h === H) return;
    W = w; H = h;
    renderer.setSize(w, h, true);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (labelR) labelR.setSize(w, h);
  }

  /* ---------------- 对外 ---------------- */
  function init(onReady) {
    if (inited) { resize(); return; }
    if (typeof THREE === 'undefined') { setTimeout(function () { init(onReady); }, 300); return; }
    try { build(); } catch (e) { console.error('光伏 3D 场景初始化失败', e); return; }
    window.addEventListener('resize', resize);
    new MutationObserver(function () { applyTheme(); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    if (onReady) onReady();
  }

  return { init, resize, setWeather, setPower, applyTheme };
})();
