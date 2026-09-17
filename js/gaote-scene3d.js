/* ============================================================
 * 高特电站三维场景（5 个储能堆）
 *
 * 与场景对齐真实拓扑：5 个储能柜（堆）+ 汇流/PCS 柜 + 并网杆塔，
 * 数据全部来自 GaoteService（高特协议实时值）：
 *   柜顶色条 —— 充电(蓝) / 放电(青) / 待机(灰)
 *   标签   —— 堆号 · SOC · 温度
 *   点击   —— 展开该堆明细卡（堆 + 簇 + 极值）
 * 接口与 js/scene3d.js 一致：init / update / toggleLabels / toggleRotate / resetView / setRotateSync / resize
 * ============================================================ */
window.GaoteScene3D = (function () {
  'use strict';

  let scene, camera, renderer, labelRenderer, controls, composer;
  let host = null, raf = null;
  let rot = { auto: true, speed: 0.12 }, labelsOn = true, activeCardKey = null;
  const groups = {};        // key -> THREE.Group
  const labelEls = {};      // key -> .tag3d element
  const cardEls = {};       // key -> .card3d element
  const strips = {};        // key -> 顶部色条 mesh
  let inited = false;
  const clock = { last: 0 };

  function std(c, o) { return new THREE.MeshStandardMaterial(Object.assign({ color: c, roughness: .6, metalness: .35 }, o || {})); }
  function box(w, h, d, m, x, y, z) {
    const M = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    M.position.set(x, y, z);
    M.castShadow = M.receiveShadow = true;
    return M;
  }
  function tex(fn, w, h) {
    const c = document.createElement('canvas'); c.width = w || 256; c.height = h || 256;
    fn(c.getContext('2d'), c.width, c.height);
    return new THREE.CanvasTexture(c);
  }
  function gridTexture() {
    return tex(function (g, w, h) {
      g.fillStyle = '#04090c'; g.fillRect(0, 0, w, h);
      g.strokeStyle = 'rgba(46,230,200,.14)'; g.lineWidth = 1;
      for (let i = 0; i <= 8; i++) {
        const p = i * w / 8;
        g.beginPath(); g.moveTo(p, 0); g.lineTo(p, h); g.stroke();
        g.beginPath(); g.moveTo(0, p); g.lineTo(w, p); g.stroke();
      }
    }, 512, 512);
  }
  function rackTexture() {
    return tex(function (g, w, h) {
      g.fillStyle = '#0d2027'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 7; i++) {
        const y = 14 + i * 34;
        g.fillStyle = 'rgba(46,230,200,.10)'; g.fillRect(10, y, w - 20, 24);
        g.strokeStyle = 'rgba(46,230,200,.28)'; g.strokeRect(10, y, w - 20, 24);
        g.fillStyle = 'rgba(46,230,200,.35)';
        for (let k = 0; k < 5; k++) g.fillRect(18 + k * 14, y + 9, 7, 5);
      }
    }, 256, 256);
  }

  function addLabel(key, pos, cls) {
    const wrap = document.createElement('div');
    const el = document.createElement('div');
    el.className = cls || 'tag3d';
    wrap.appendChild(el);
    const o = new THREE.CSS2DObject(wrap);
    o.position.copy(pos);
    (groups[key] || scene).add(o);
    labelEls[key] = el;
  }
  function addCard(key, pos) {
    const wrap = document.createElement('div');
    const el = document.createElement('div');
    el.className = 'card3d'; el.style.display = 'none';
    el.innerHTML = '<div class="c-head"><span></span><i class="c-x">✕</i></div><div class="c-rows"></div><div class="c-status" style="display:none"></div>';
    el.querySelector('.c-x').addEventListener('click', function (e) { e.stopPropagation(); showCard(null); });
    wrap.appendChild(el);
    const o = new THREE.CSS2DObject(wrap);
    o.position.copy(pos);
    (groups[key] || scene).add(o);
    cardEls[key] = el;
  }
  function showCard(key) {
    for (const k in cardEls) cardEls[k].style.display = 'none';
    activeCardKey = key;
    if (key && cardEls[key]) cardEls[key].style.display = '';
    applyLabelVisibility();
  }
  function applyLabelVisibility() {
    for (const k in labelEls) {
      const hide = !labelsOn && k !== activeCardKey;
      labelEls[k].style.display = hide ? 'none' : '';
    }
  }

  /* ---------- 构建场景 ---------- */
  function buildStation() {
    const root = new THREE.Group();

    /* 地面 */
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(34, 22), new THREE.MeshStandardMaterial({
      map: gridTexture(), roughness: .95, metalness: .05, transparent: true, opacity: .96
    }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    root.add(ground);

    /* 平台底座 */
    const pad = box(20, .18, 10, std(0x0b1a1e, { roughness: .9 }), 0, .09, 0);
    root.add(pad);

    /* 5 个储能柜（堆） */
    const rackTex = rackTexture();
    const N = 5, gap = 3.3, startX = -(N - 1) * gap / 2;
    for (let i = 0; i < N; i++) {
      const key = 'stack' + i;
      const g = new THREE.Group();
      g.position.set(startX + i * gap, 0, 0);
      const W = 2.5, H = 2.8, D = 1.5;

      const body = box(W, H, D, new THREE.MeshStandardMaterial({ map: rackTex, color: 0xffffff, roughness: .62, metalness: .3 }), 0, H / 2 + .18, 0);
      body.userData.key = key;
      g.add(body);

      const frame = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(W, H, D)),
        new THREE.LineBasicMaterial({ color: 0x2ee6c8, transparent: true, opacity: .55 }));
      frame.position.set(0, H / 2 + .18, 0);
      g.add(frame);

      /* 柜顶色条：随充放电状态变色 */
      const strip = box(W * .92, .12, D * .92, std(0x6f9a94, { emissive: 0x000000 }), 0, H + .2, 0);
      strip.userData.key = key;
      g.add(strip);
      strips[key] = strip;

      /* 柜底光晕 */
      const glow = new THREE.Mesh(new THREE.PlaneGeometry(W * 1.4, D * 1.6),
        new THREE.MeshBasicMaterial({ color: 0x2ee6c8, transparent: true, opacity: .16 }));
      glow.rotation.x = -Math.PI / 2;
      glow.position.set(0, .2, 0);
      g.add(glow);

      root.add(g);
      groups[key] = g;
      addLabel(key, new THREE.Vector3(0, H + .95, 0));
      addCard(key, new THREE.Vector3(0, H + .1, 0));
    }

    /* 汇流 / PCS 柜 */
    const pcsG = new THREE.Group();
    pcsG.position.set(0, 0, 4.2);
    const pcs = box(4.6, 2.2, 1.4, std(0x122a31, { roughness: .55, metalness: .45 }), 0, 1.28, 0);
    pcs.userData.key = 'pcs';
    pcsG.add(pcs);
    const fins = new THREE.Mesh(new THREE.BoxGeometry(4.2, .9, .12), std(0x0a1f24));
    fins.position.set(0, 1.3, .78);
    pcsG.add(fins);
    root.add(pcsG);
    groups.pcs = pcsG;
    addLabel('pcs', new THREE.Vector3(0, 2.9, 0));
    addCard('pcs', new THREE.Vector3(0, 2.1, 0));

    /* 并网杆塔 */
    const tower = new THREE.Group();
    tower.position.set(-10.5, 0, -2.5);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(.18, .42, 7.2, 6, 3, true), std(0x16323a, { roughness: .7 }));
    mast.position.y = 3.6;
    tower.add(mast);
    for (let i = 0; i < 3; i++) {
      const arm = box(3.2, .1, .1, std(0x2ee6c8, { emissive: 0x0b6, emissiveIntensity: .35 }), 0, 5.4 + i * .8, 0);
      tower.add(arm);
    }
    root.add(tower);
    groups.grid = tower;
    addLabel('grid', new THREE.Vector3(0, 7.9, 0));

    /* 电缆：柜 → PCS → 杆塔 */
    const cableMat = new THREE.LineBasicMaterial({ color: 0x2ee6c8, transparent: true, opacity: .42 });
    for (let i = 0; i < N; i++) {
      const x = startX + i * gap;
      const pts = [new THREE.Vector3(x, .25, .8), new THREE.Vector3(x, .25, 2.6), new THREE.Vector3(x * .5, .25, 3.5), new THREE.Vector3(0, .6, 3.5)];
      root.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), cableMat));
    }
    const toTower = [new THREE.Vector3(0, .6, 4.2), new THREE.Vector3(-5.5, .8, 4.2), new THREE.Vector3(-9.4, 1.2, -1.2), new THREE.Vector3(-10.5, 3.0, -2.3)];
    root.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(toTower), cableMat));

    scene.add(root);
  }

  /* ---------- 数据刷新 ---------- */
  function stackData(i) {
    const s = GaoteService.state || {};
    const find = function (dim, arr) {
      const key = Object.keys(s).filter(k => k.split('|')[0] === dim && String(s[k]._meta.arr) === String(arr))[0];
      return key ? s[key] : null;
    };
    const bval = function (b, k) {
      if (!b) return null;
      const idx = Object.keys(b).filter(x => b[x] && b[x].key === k)[0];
      if (idx === undefined) return null;
      const v = b[idx].v;
      return (v === null || v === undefined) ? null : Number(v);
    };
    const arr = find('array', i), clu = find('cluster', i);
    return {
      soc: bval(arr, 'arrSOC'), soh: bval(arr, 'arrSOH'),
      vol: bval(arr, 'arrVol'), cur: bval(arr, 'arrCur'),
      maxT: bval(arr, 'maxCellTem'), minT: bval(arr, 'minCellTem'),
      difV: bval(arr, 'CellVolDif'), difT: bval(arr, 'CellTemDif'),
      chgP: bval(arr, 'arrMaxReChaPower'), disP: bval(arr, 'arrMaxReDischgPower'),
      cluSoc: bval(clu, 'cluSoc'), cluVol: bval(clu, 'cluVol'), cluCur: bval(clu, 'cluCur'),
      rp: bval(clu, 'cluPosres'), rn: bval(clu, 'cluNegres'),
      dayChg: bval(clu, 'cludaychg_cap'), dayDis: bval(clu, 'cludisday_cap')
    };
  }
  const f = function (v, d, u) { return (v === null || v === undefined) ? '--' : Number(v).toFixed(d === undefined ? 1 : d) + (u || ''); };

  function setCard(key, title, rows, status) {
    const el = cardEls[key];
    if (!el) return;
    el.querySelector('.c-head span').textContent = title;
    const box = el.querySelector('.c-rows');
    box.innerHTML = rows.map(function ([k, v]) { return '<div class="c-row"><span>' + k + '</span><b>' + v + '</b></div>'; }).join('');
    const st = el.querySelector('.c-status');
    if (status) { st.style.display = ''; st.textContent = status; } else { st.style.display = 'none'; }
  }

  function update() {
    if (!inited) return;
    const emuP = GaoteService.val('emu', 'PCSSumsActivePower');
    const emuSoc = GaoteService.val('emu', 'SumsSOC');
    for (let i = 0; i < 5; i++) {
      const d = stackData(i);
      const key = 'stack' + i;
      const strip = strips[key];
      /* 充电=蓝 放电=青 待机=灰 */
      const chg = d.cur !== null && d.cur < -0.5, dis = d.cur !== null && d.cur > 0.5;
      const col = chg ? 0x8fd8ff : (dis ? 0x2ee6c8 : 0x6f9a94);
      if (strip) {
        strip.material.color.setHex(col);
        strip.material.emissive.setHex(col);
        strip.material.emissiveIntensity = (chg || dis) ? .85 : .12;
      }
      const el = labelEls[key];
      if (el) {
        el.innerHTML = '<b>堆 ' + (i + 1) + '</b><i>' + (d.soc === null ? 'SOC --' : 'SOC ' + d.soc.toFixed(1) + '%')
          + '</i><em>' + (chg ? '充电中' : (dis ? '放电中' : '待机')) + (d.maxT === null ? '' : ' · ' + d.maxT.toFixed(0) + '℃') + '</em>';
      }
      setCard(key, '堆 ' + (i + 1) + ' 明细', [
        ['电池堆电压', f(d.vol, 1, ' V')], ['电池堆电流', f(d.cur, 1, ' A')],
        ['SOC / SOH', f(d.soc, 1, '%') + ' / ' + f(d.soh, 0, '%')],
        ['最高 / 最低温度', f(d.maxT, 0, '℃') + ' / ' + f(d.minT, 0, '℃')],
        ['单体压差 / 温差', f(d.difV, 3, ' V') + ' / ' + f(d.difT, 1, '℃')],
        ['允许充 / 放功率', f(d.chgP, 0, ' kW') + ' / ' + f(d.disP, 0, ' kW')],
        ['簇电压 / 电流', f(d.cluVol, 1, ' V') + ' / ' + f(d.cluCur, 1, ' A')],
        ['绝缘 R+ / R-', f(d.rp, 0, 'Ω') + ' / ' + f(d.rn, 0, 'Ω')],
        ['今日充 / 放电量', f(d.dayChg, 1, ' kWh') + ' / ' + f(d.dayDis, 1, ' kWh')]
      ], chg ? '充电中' : (dis ? '放电中' : '待机'));
    }
    setCard('pcs', '汇流 / PCS', [
      ['PCS 总有功', f(emuP, 1, ' kW')], ['PCS 总无功', f(GaoteService.val('emu', 'PCSSumsReactivePower'), 1, ' kVar')],
      ['母线电压', f(GaoteService.val('emu', 'DCBusVol'), 1, ' V')],
      ['允许充电功率', f(GaoteService.val('emu', 'MaxAllowChargPower'), 0, ' kW')],
      ['允许放电功率', f(GaoteService.val('emu', 'MinAllowChargPower'), 0, ' kW')],
      ['系统 SOC', f(emuSoc, 1, '%')]
    ], emuP === null ? '' : (emuP < 0 ? '充电中' : (emuP > 0 ? '放电中' : '待机')));
    const gl = labelEls.grid;
    if (gl) gl.innerHTML = '<b>并网点</b><i>' + f(GaoteService.val('meter-lems-antireflux', 'meter_tot_p'), 1, ' kW') + '</i>';
  }

  /* ---------- 交互 ---------- */
  let ray = null, ndc = null;
  function pick(ev) {
    if (!ray) { ray = new THREE.Raycaster(); ndc = new THREE.Vector2(); }
    const r = renderer.domElement.getBoundingClientRect();
    ndc.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
    ndc.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects(scene.children, true);
    for (let i = 0; i < hits.length; i++) {
      let o = hits[i].object;
      while (o && !o.userData.key) o = o.parent;
      if (o && o.userData.key) return o.userData.key;
    }
    return null;
  }
  function bind() {
    let downX = 0, downY = 0;
    renderer.domElement.addEventListener('pointerdown', function (e) { downX = e.clientX; downY = e.clientY; });
    renderer.domElement.addEventListener('pointerup', function (e) {
      if (Math.abs(e.clientX - downX) > 4 || Math.abs(e.clientY - downY) > 4) return;
      showCard(pick(e));
    });
    window.addEventListener('resize', onResize);
  }
  function onResize() {
    if (!host || !renderer) return;
    const w = host.clientWidth, h = host.clientHeight;
    camera.aspect = w / h; camera.updateProjectionMatrix();
    renderer.setSize(w, h); labelRenderer.setSize(w, h);
    if (composer) composer.setSize(w, h);
  }

  function loop(t) {
    raf = requestAnimationFrame(loop);
    const dt = clock.last ? (t - clock.last) / 1000 : 0;
    clock.last = t;
    if (rot.auto && controls) controls.autoRotate && (controls.autoRotateSpeed = rot.speed * 6);
    if (controls) controls.update();
    if (composer) composer.render(); else renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
  }

  function init(el) {
    if (inited) return;
    host = el;
    const w = el.clientWidth || 900, h = el.clientHeight || 600;
    scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x04090c, 26, 60);
    camera = new THREE.PerspectiveCamera(46, w / h, .1, 300);
    camera.position.set(13, 11, 18);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(w, h);
    renderer.shadowMap.enabled = true;
    el.appendChild(renderer.domElement);

    labelRenderer = new THREE.CSS2DRenderer();
    labelRenderer.setSize(w, h);
    labelRenderer.domElement.style.position = 'absolute';
    labelRenderer.domElement.style.top = '0';
    labelRenderer.domElement.style.pointerEvents = 'none';
    el.appendChild(labelRenderer.domElement);

    scene.add(new THREE.HemisphereLight(0xbfe9ff, 0x0a1a1e, 1.05));
    const dir = new THREE.DirectionalLight(0xffffff, .85);
    dir.position.set(9, 14, 7); dir.castShadow = true;
    scene.add(dir);
    const fill = new THREE.DirectionalLight(0x2ee6c8, .35);
    fill.position.set(-8, 6, -6);
    scene.add(fill);

    if (typeof THREE.OrbitControls === 'function') {
      controls = new THREE.OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true; controls.dampingFactor = .08;
      controls.minDistance = 8; controls.maxDistance = 46;
      controls.maxPolarAngle = Math.PI / 2.15;
      controls.target.set(0, 1.4, 0);
      controls.autoRotate = true; controls.autoRotateSpeed = rot.speed * 6;
    }
    if (typeof THREE.EffectComposer === 'function' && THREE.RenderPass && THREE.UnrealBloomPass) {
      try {
        composer = new THREE.EffectComposer(renderer);
        composer.addPass(new THREE.RenderPass(scene, camera));
        const bloom = new THREE.UnrealBloomPass(new THREE.Vector2(w, h), .62, .85, .82);
        composer.addPass(bloom);
      } catch (_) { composer = null; }
    }
    buildStation();
    bind();
    inited = true;
    loop(0);
    update();
  }

  function todayEmpty() { }

  return {
    init,
    update: function () { update(); },
    resize: onResize,
    toggleLabels: function () { labelsOn = !labelsOn; applyLabelVisibility(); return labelsOn; },
    toggleRotate: function () {
      rot.auto = !rot.auto;
      if (controls) controls.autoRotate = rot.auto;
      return rot.auto;
    },
    resetView: function () {
      camera.position.set(13, 11, 18);
      if (controls) { controls.target.set(0, 1.4, 0); controls.update(); }
    },
    setRotateSync: function (cb) { rot.sync = cb; }
  };
})();
