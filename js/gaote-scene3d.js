/* ============================================================
 * 高特电站三维场景
 *
 * 与场景对齐真实拓扑：储能柜（数量按上报自动排布）+ 汇流/PCS 柜 + 并网杆塔，
 * 数据全部来自 GaoteService（高特协议实时值）：
 *   柜门小电表 —— 该柜 SOC（横向亮条）
 *   柜顶色条   —— 充电(蓝) / 放电(青) / 待机(灰)
 *   电缆能量流 —— 每根柜线按该柜电流方向流动，并网线按全站功率方向流动；
 *                光纹沿电缆滚动 + 沿线发光粒子，速度随数值大小，待机时停下
 *   电动车     —— 全站放电时出现在汇流柜旁充电，电量条按系统 SOC
 *   标签 / 卡片 —— 堆号 · SOC · 状态 · 温度；点击展开明细
 *
 * 接口与 js/scene3d.js 一致：init / update / toggleLabels / toggleRotate / resetView / setRotateSync / resize
 * ============================================================ */
window.GaoteScene3D = (function () {
  'use strict';

  let scene, camera, renderer, labelRenderer, controls, composer;
  let host = null, raf = null;
  let rot = { auto: true, speed: 0.05 }, labelsOn = true, activeCardKey = null;
  const groups = {};        // key -> THREE.Group
  const labelEls = {};      // key -> .tag3d element
  const cardEls = {};       // key -> .card3d element
  const strips = {};        // key -> 柜顶色条
  const gauges = {};        // key -> 柜门 SOC 亮条
  let inited = false;
  const clock = { last: 0 };

  /* 能量流：每条电缆一根发光管 + 沿线发光粒子，方向/速度各自按数据 */
  const flows = [];
  const flow = { dir: 0, units: 0 };       // 全站口径（并网线用）

  /* 柜体数量按实际上报自动排布 */
  const MAXN = 8, GAP = 3.3, STACK_W = 2.5, STACK_H = 2.8, STACK_D = 1.5;
  let stackN = 5;
  const stackCables = [];   // { flow } 每柜到 PCS 的电缆

  /* 电动车（仅放电时出现） */
  let carGroup = null, carBar = null, carPort = null, carLabelEl = null, carOn = false;

  /* ---------------- 基础工具 ---------------- */
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
  /* 柜体正面：顶部空调、双开门、门缝把手、铭牌与警示条 */
  function cabFrontTexture() {
    return tex(function (g, w, h) {
      g.fillStyle = '#0f2731'; g.fillRect(0, 0, w, h);
      g.strokeStyle = 'rgba(46,230,200,.18)'; g.lineWidth = 2; g.strokeRect(7, 7, w - 14, h - 14);
      g.fillStyle = 'rgba(7,22,28,.95)'; g.fillRect(14, 14, w - 28, 46);
      g.strokeStyle = 'rgba(46,230,200,.25)'; g.strokeRect(14, 14, w - 28, 46);
      for (let i = 0; i < 5; i++) { g.fillStyle = 'rgba(46,230,200,.20)'; g.fillRect(24, 21 + i * 8, w - 48, 3); }
      g.strokeStyle = 'rgba(46,230,200,.34)'; g.lineWidth = 3;
      g.beginPath(); g.moveTo(w / 2, 72); g.lineTo(w / 2, h - 18); g.stroke();
      g.strokeStyle = 'rgba(46,230,200,.13)'; g.lineWidth = 2;
      g.strokeRect(18, 76, w / 2 - 28, h - 104);
      g.strokeRect(w / 2 + 10, 76, w / 2 - 28, h - 104);
      g.fillStyle = 'rgba(46,230,200,.55)';
      g.fillRect(w / 2 - 18, h / 2 - 8, 5, 30); g.fillRect(w / 2 + 13, h / 2 - 8, 5, 30);
      g.fillStyle = 'rgba(46,230,200,.30)'; g.fillRect(22, h - 30, 66, 9);
      g.fillStyle = 'rgba(255,176,32,.42)'; g.fillRect(w - 88, h - 30, 66, 9);
    }, 256, 256);
  }
  /* 柜体侧面/顶面：钢板分块、竖向筋、底部散热百叶 */
  function cabSideTexture() {
    return tex(function (g, w, h) {
      g.fillStyle = '#0c1f27'; g.fillRect(0, 0, w, h);
      g.strokeStyle = 'rgba(46,230,200,.12)'; g.lineWidth = 2;
      for (let i = 1; i < 4; i++) { const x = i * w / 4; g.beginPath(); g.moveTo(x, 6); g.lineTo(x, h - 6); g.stroke(); }
      g.strokeStyle = 'rgba(46,230,200,.16)'; g.strokeRect(6, 6, w - 12, h - 12);
      for (let i = 0; i < 6; i++) { g.fillStyle = 'rgba(46,230,200,.14)'; g.fillRect(16, h - 54 + i * 8, w - 32, 3); }
    }, 256, 256);
  }
  /* PCS 柜正面：大百叶、门缝、警示条 */
  function pcsFrontTexture() {
    return tex(function (g, w, h) {
      g.fillStyle = '#10262e'; g.fillRect(0, 0, w, h);
      g.strokeStyle = 'rgba(46,230,200,.18)'; g.lineWidth = 2; g.strokeRect(8, 8, w - 16, h - 16);
      g.fillStyle = 'rgba(7,22,28,.95)'; g.fillRect(16, 22, w - 32, h - 92);
      for (let i = 0; i < 9; i++) { g.fillStyle = 'rgba(46,230,200,.16)'; g.fillRect(24, 32 + i * 12, w - 48, 4); }
      g.fillStyle = 'rgba(46,230,200,.09)'; g.fillRect(16, h - 58, w - 32, 40);
      g.fillStyle = 'rgba(255,176,32,.35)'; g.fillRect(16, h - 22, w - 32, 8);
    }, 256, 256);
  }
  /* 电缆流动光纹（沿管滚动；每条电缆用独立副本以便各自滚动） */
  let flowTexProto = null;
  function flowTexture() {
    if (!flowTexProto) {
      flowTexProto = tex(function (g, w, h) {
        g.clearRect(0, 0, w, h);
        for (let k = 0; k < 2; k++) {
          const x = k * (w / 2);
          const lg = g.createLinearGradient(x, 0, x + w / 2, 0);
          lg.addColorStop(0, 'rgba(255,255,255,0)');
          lg.addColorStop(.55, 'rgba(255,255,255,.95)');
          lg.addColorStop(1, 'rgba(255,255,255,0)');
          g.fillStyle = lg; g.fillRect(x, 2, w / 2, h - 4);
        }
      }, 128, 8);
      flowTexProto.wrapS = flowTexProto.wrapT = THREE.RepeatWrapping;
    }
    const t = flowTexProto.clone();
    t.needsUpdate = true;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  }
  /* 粒子贴图 */
  let glowTex = null;
  function glowTexture() {
    if (!glowTex) {
      glowTex = tex(function (g, w, h) {
        const grd = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
        grd.addColorStop(0, 'rgba(255,255,255,1)');
        grd.addColorStop(.35, 'rgba(255,255,255,.5)');
        grd.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grd; g.fillRect(0, 0, w, h);
      }, 64, 64);
    }
    return glowTex;
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
      const isStack = k.indexOf('stack') === 0;
      const idx = isStack ? parseInt(k.slice(5), 10) : -1;
      const hide = (!labelsOn && k !== activeCardKey) || (isStack && idx >= stackN);
      labelEls[k].style.display = hide ? 'none' : '';
    }
    if (carLabelEl) carLabelEl.style.display = (carOn && labelsOn) ? '' : 'none';
  }

  /* ---------------- 能量流 ---------------- */
  function addFlow(pts, n, parent, stack) {
    let curve;
    try { curve = new THREE.CatmullRomCurve3(pts); } catch (_) { return null; }
    const len = Math.max(1, curve.getLength());
    const tubeMat = new THREE.MeshBasicMaterial({
      map: flowTexture(), color: 0x16303a, transparent: true, opacity: .3,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(14, Math.round(len * 4)), .058, 6, false), tubeMat);
    (parent || scene).add(tube);

    const items = [];
    for (let i = 0; i < n; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTexture(), color: 0x6f9a94, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false
      }));
      sp.scale.setScalar(.001);
      sp.position.copy(curve.getPointAt(i / n));
      (parent || scene).add(sp);
      items.push({ mesh: sp, t: i / n });
    }
    const fl = {
      curve: curve, len: len, items: items, map: tubeMat.map, tubeMat: tubeMat, tube: tube,
      stack: (stack === undefined ? -1 : stack), dir: 0, speed: 0
    };
    flows.push(fl);
    return fl;
  }
  function stepFlow(dt) {
    if (!flows.length || !dt) return;
    for (let i = 0; i < flows.length; i++) {
      const fl = flows[i];
      const on = fl.dir !== 0;
      fl.tubeMat.color.setHex(fl.dir > 0 ? 0x2ee6c8 : (fl.dir < 0 ? 0x8fd8ff : 0x16303a));
      fl.tubeMat.opacity = on ? .85 : .3;
      if (on) fl.map.offset.x -= fl.dir * fl.speed * dt * .35;     // 光纹沿电缆滚动
      for (let j = 0; j < fl.items.length; j++) {
        const it = fl.items[j];
        if (on) {
          it.t += (fl.dir * fl.speed * dt) / fl.len;
          if (it.t >= 1) it.t -= Math.floor(it.t);
          else if (it.t < 0) it.t += 1;
        }
        it.mesh.position.copy(fl.curve.getPointAt(Math.min(1, Math.max(0, it.t))));
        it.mesh.material.color.setHex(fl.dir > 0 ? 0x2ee6c8 : (fl.dir < 0 ? 0x8fd8ff : 0x6f9a94));
        it.mesh.material.opacity = on ? .95 : 0;
        it.mesh.scale.setScalar(on ? .62 : .001);
      }
    }
  }

  /* ---------------- 储能柜（精细柜体） ---------------- */
  const texCache = {};
  function buildStack(key) {
    const g = new THREE.Group();
    const W = STACK_W, H = STACK_H, D = STACK_D;
    const frontMat = new THREE.MeshStandardMaterial({ map: texCache.cabFront, roughness: .55, metalness: .35 });
    const sideMat = new THREE.MeshStandardMaterial({ map: texCache.cabSide, roughness: .6, metalness: .3 });
    const topMat = std(0x0a1c23, { roughness: .8, metalness: .25 });
    const dark = std(0x08171c, { roughness: .9, metalness: .2 });
    const post = std(0x123642, { roughness: .5, metalness: .5 });

    g.add(box(W + .22, .16, D + .22, dark, 0, .08, 0));                                   // 底座
    const body = new THREE.Mesh(new THREE.BoxGeometry(W, H, D), [sideMat, sideMat, topMat, sideMat, frontMat, sideMat]);
    body.position.y = H / 2 + .16;
    body.castShadow = body.receiveShadow = true;
    g.add(body);
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (c) {                            // 四角立柱
      g.add(box(.1, H + .04, .1, post, c[0] * (W / 2 - .02), H / 2 + .16, c[1] * (D / 2 - .02)));
    });
    g.add(box(W * .72, .3, D * .78, std(0x0d222a, { roughness: .7, metalness: .35 }), 0, H + .33, 0));   // 顶部空调
    for (let k = 0; k < 4; k++) {
      g.add(box(W * .6, .03, .06, std(0x0a1a20, { roughness: .9 }), 0, H + .47, -.2 + k * .13));
    }
    /* 柜门小电表：底槽 + 随 SOC 生长的亮条 */
    g.add(box(.42, .18, .03, std(0x061418, { roughness: .5 }), -W * .18, H * .62, D / 2 + .02));
    const barGeo = new THREE.BoxGeometry(.34, .1, .02);
    barGeo.translate(.17, 0, 0);
    const gauge = new THREE.Mesh(barGeo, new THREE.MeshBasicMaterial({ color: 0x2ee6c8 }));
    gauge.position.set(-W * .18 - .17, H * .62, D / 2 + .045);
    g.add(gauge);
    gauges[key] = gauge;

    const strip = box(W * .92, .12, D * .92, std(0x6f9a94, { emissive: 0x000000 }), 0, H + .2, 0);        // 柜顶色条
    g.add(strip);
    strips[key] = strip;

    const glow = new THREE.Mesh(new THREE.PlaneGeometry(W * 1.45, D * 1.7),
      new THREE.MeshBasicMaterial({ color: 0x2ee6c8, transparent: true, opacity: .06, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.rotation.x = -Math.PI / 2;
    glow.position.set(0, .2, 0);
    g.add(glow);
    g.userData.glow = glow;

    g.userData.key = key;
    groups[key] = g;
    addLabel(key, new THREE.Vector3(0, H + .95, 0));
    addCard(key, new THREE.Vector3(0, H + .1, 0));
    return g;
  }

  /* ---------------- 汇流 / PCS 柜 ---------------- */
  function buildPCS(root) {
    const g = new THREE.Group();
    g.position.set(0, 0, 4.2);
    const W = 4.6, H = 2.2, D = 1.4;
    const frontMat = new THREE.MeshStandardMaterial({ map: texCache.pcsFront, roughness: .5, metalness: .45 });
    const sideMat = new THREE.MeshStandardMaterial({ map: texCache.cabSide, roughness: .6, metalness: .35 });
    g.add(box(W + .3, .18, D + .3, std(0x08171c, { roughness: .9 }), 0, .09, 0));
    const body = new THREE.Mesh(new THREE.BoxGeometry(W, H, D), [sideMat, sideMat, std(0x0b1f26), sideMat, frontMat, sideMat]);
    body.position.y = H / 2 + .18;
    body.castShadow = body.receiveShadow = true;
    body.userData.key = 'pcs';
    g.add(body);
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (c) {
      g.add(box(.1, H, .1, std(0x143a46, { roughness: .5, metalness: .5 }), c[0] * (W / 2 - .02), H / 2 + .18, c[1] * (D / 2 - .02)));
    });
    g.add(box(W * .8, .16, .5, std(0x0d222a, { roughness: .8 }), 0, H + .26, -.5));                    // 顶部桥架
    g.add(box(.5, .16, D + .4, std(0x0d222a, { roughness: .8 }), -W * .3, H + .26, 0));
    g.add(box(.76, .4, .03, std(0x061418, { roughness: .5 }), -W * .18, H * .68, D / 2 + .005));        // 显示屏
    g.add(box(.7, .34, .04, new THREE.MeshBasicMaterial({ color: 0x14e0c0 }), -W * .18, H * .68, D / 2 + .03));
    g.add(box(.08, .3, .08, std(0x1b4a56, { roughness: .4, metalness: .6 }), W * .32, H * .6, D / 2 + .06));  // 隔离开关
    for (let k = 0; k < 8; k++) {                                                                       // 散热鳍片
      g.add(box(.06, H * .5, .06, std(0x0a1a20, { roughness: .9 }), -W / 2 - .05, H * .55, -.5 + k * .16));
    }
    root.add(g);
    groups.pcs = g;
    addLabel('pcs', new THREE.Vector3(0, H + .9, 0));
    addCard('pcs', new THREE.Vector3(0, H + .1, 0));
  }

  /* ---------------- 并网杆塔（格构式 + 绝缘子 + 进线弧垂） ---------------- */
  function buildTower(root) {
    const g = new THREE.Group();
    g.position.set(-10.5, 0, -2.5);
    const hgt = 7.0, baseW = 1.6, topW = .5;
    const legMat = std(0x1c4450, { roughness: .55, metalness: .55 });
    const leg = function (a, b) {
      const len = a.distanceTo(b);
      const m = new THREE.Mesh(new THREE.CylinderGeometry(.05, .07, len, 6), legMat);
      m.position.copy(a).lerp(b, .5);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      m.castShadow = true;
      g.add(m);
    };
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (c) {
      leg(new THREE.Vector3(c[0] * baseW / 2, 0, c[1] * baseW / 2), new THREE.Vector3(c[0] * topW / 2, hgt, c[1] * topW / 2));
    });
    for (let i = 1; i <= 4; i++) {                                    // 横撑
      const y = i * hgt / 4.6;
      const w = baseW + (topW - baseW) * (y / hgt);
      g.add(box(w, .05, .05, legMat, 0, y, -w / 2));
      g.add(box(w, .05, .05, legMat, 0, y, w / 2));
      g.add(box(.05, .05, w, legMat, -w / 2, y, 0));
      g.add(box(.05, .05, w, legMat, w / 2, y, 0));
    }
    /* 三层横担 + 绝缘子 + 进线（带弧垂） */
    const armMat = std(0x2ee6c8, { emissive: 0x0b6, emissiveIntensity: .3, roughness: .5 });
    const insMat = std(0xd8e6e4, { roughness: .35, metalness: .1 });
    const condMat = new THREE.LineBasicMaterial({ color: 0x2ee6c8, transparent: true, opacity: .35 });
    for (let i = 0; i < 3; i++) {
      const y = 5.2 + i * .75, w = 3.3 - i * .35;
      g.add(box(w, .08, .08, armMat, 0, y, 0));
      [-1, 1].forEach(function (s, si) {
        const x = s * w / 2;
        const ins = new THREE.Mesh(new THREE.CylinderGeometry(.06, .06, .3, 6), insMat);
        ins.position.set(x, y - .19, 0);
        ins.castShadow = true;
        g.add(ins);
        const tip = new THREE.Vector3(x, y - .34, 0);
        const from = new THREE.Vector3(-7.5, tip.y + .5, -1.2 + i * .6 + si * 0.4);
        const pts = [];
        for (let k = 0; k <= 6; k++) {
          const t = k / 6;
          const p = from.clone().lerp(tip, t);
          p.y -= Math.sin(t * Math.PI) * .7;               // 弧垂
          pts.push(p);
        }
        g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), condMat));
      });
    }
    root.add(g);
    groups.grid = g;
    addLabel('grid', new THREE.Vector3(0, hgt + .9, 0));
  }

  /* ---------------- 电动车（车身轮廓挤出 + 细节） ---------------- */
  function buildCar(root) {
    const g = new THREE.Group();
    const cx = 6.3, cz = 6.6;               // 停在平台外的停车位，避免和柜体挤在一起
    g.visible = false;

    const chassisShape = new THREE.Shape();
    chassisShape.moveTo(-2.2, .18);
    chassisShape.lineTo(-2.28, .5);
    chassisShape.lineTo(-2.16, .95);
    chassisShape.lineTo(1.98, .95);
    chassisShape.lineTo(2.3, .6);
    chassisShape.lineTo(2.22, .18);
    chassisShape.lineTo(-2.2, .18);
    const chassisGeo = new THREE.ExtrudeGeometry(chassisShape, { depth: 1.8, bevelEnabled: true, bevelSize: .07, bevelThickness: .07, bevelSegments: 2, steps: 1 });
    chassisGeo.translate(0, 0, -.9);
    const chassis = new THREE.Mesh(chassisGeo, std(0x2a5265, { roughness: .3, metalness: .6 }));
    chassis.castShadow = true;
    chassis.position.set(cx, 0, cz);
    g.add(chassis);

    const cabinShape = new THREE.Shape();
    cabinShape.moveTo(-1.66, .93);
    cabinShape.lineTo(-1.3, 1.56);
    cabinShape.lineTo(.5, 1.6);
    cabinShape.lineTo(1.14, .93);
    cabinShape.lineTo(-1.66, .93);
    const cabinGeo = new THREE.ExtrudeGeometry(cabinShape, { depth: 1.6, bevelEnabled: true, bevelSize: .05, bevelThickness: .05, bevelSegments: 2, steps: 1 });
    cabinGeo.translate(0, 0, -.8);
    const cabin = new THREE.Mesh(cabinGeo, new THREE.MeshStandardMaterial({ color: 0x0a1b21, roughness: .12, metalness: .8 }));
    cabin.castShadow = true;
    cabin.position.set(cx, 0, cz);
    g.add(cabin);

    /* 车轮（轮胎 + 轮毂） */
    [-1.42, 1.42].forEach(function (dx) {
      [-.82, .82].forEach(function (dz) {
        const tire = new THREE.Mesh(new THREE.CylinderGeometry(.36, .36, .26, 16), std(0x081114, { roughness: .95 }));
        tire.rotation.x = Math.PI / 2; tire.position.set(cx + dx, .36, cz + dz); tire.castShadow = true;
        g.add(tire);
        const rim = new THREE.Mesh(new THREE.CylinderGeometry(.2, .2, .28, 12), std(0x4a6d75, { roughness: .35, metalness: .7 }));
        rim.rotation.x = Math.PI / 2; rim.position.set(cx + dx, .36, cz + dz);
        g.add(rim);
      });
    });
    /* 前灯 / 尾灯 / 后视镜 */
    const head = new THREE.MeshBasicMaterial({ color: 0xbff7ea });
    const tail = new THREE.MeshBasicMaterial({ color: 0xff6e50 });
    [-.55, .55].forEach(function (dz) {
      g.add(box(.06, .1, .3, head, cx + 2.26, .72, cz + dz));
      g.add(box(.05, .1, .28, tail, cx - 2.28, .72, cz + dz));
    });
    [-1, 1].forEach(function (s) { g.add(box(.12, .06, .22, std(0x0d222a), cx + .7, 1.16, cz + s * .92)); });

    /* 电量条：底槽 + 亮条（长度随 SOC） */
    g.add(box(3.3, .26, .04, std(0x061418, { roughness: .8 }), cx, 1.06, cz + .95));
    const barGeo = new THREE.BoxGeometry(3.0, .16, .05);
    barGeo.translate(1.5, 0, 0);
    carBar = new THREE.Mesh(barGeo, new THREE.MeshBasicMaterial({ color: 0x2ee6c8 }));
    carBar.position.set(cx - 1.5, 1.06, cz + .97);
    g.add(carBar);

    /* 充电口 + 充电枪电缆（PCS → 车，带能量流） */
    carPort = new THREE.Mesh(new THREE.SphereGeometry(.12, 10, 10), new THREE.MeshBasicMaterial({ color: 0x2ee6c8 }));
    carPort.position.set(cx - 2.16, .74, cz - .78);
    g.add(carPort);
    const cable = [new THREE.Vector3(2.3, .62, 4.5), new THREE.Vector3(3.9, .5, 5.4), new THREE.Vector3(cx - 2.16, .74, cz - .78)];
    addFlow(cable, 3, g, -2);

    /* 标签跟随车辆显隐 */
    const wrap = document.createElement('div');
    const el = document.createElement('div');
    el.className = 'tag3d';
    wrap.appendChild(el);
    const o = new THREE.CSS2DObject(wrap);
    o.position.set(cx, 2.05, cz);
    g.add(o);
    carLabelEl = el;

    root.add(g);
    carGroup = g;
  }

  /* ---------------- 构建场景 ---------------- */
  function buildStation() {
    const root = new THREE.Group();

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(34, 22), new THREE.MeshStandardMaterial({
      map: gridTexture(), roughness: .95, metalness: .05, transparent: true, opacity: .96
    }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    root.add(ground);
    root.add(box(20, .18, 10, std(0x0b1a1e, { roughness: .9 }), 0, .09, 0));

    texCache.cabFront = cabFrontTexture();
    texCache.cabSide = cabSideTexture();
    texCache.pcsFront = pcsFrontTexture();

    for (let i = 0; i < MAXN; i++) {
      const key = 'stack' + i;
      const g = buildStack(key);
      root.add(g);
      /* 柜 → PCS 电缆（本地坐标，终点在 layoutStacks 里对齐 PCS） */
      const cpts = [new THREE.Vector3(0, .3, .9), new THREE.Vector3(0, .3, 2.6), new THREE.Vector3(-1, .32, 3.5), new THREE.Vector3(-2, .6, 3.6)];
      stackCables.push({ flow: addFlow(cpts, 3, g, i) });
    }

    buildPCS(root);
    buildTower(root);

    /* PCS → 杆塔 出线（全站口径，流向按总功率） */
    const toTower = [new THREE.Vector3(0, .7, 3.6), new THREE.Vector3(-3.4, .8, 2.2), new THREE.Vector3(-7.2, 1.4, -.4), new THREE.Vector3(-10.5, 3.4, -2.5)];
    addFlow(toTower, 3, root, -1);

    buildCar(root);

    scene.add(root);
    layoutStacks(stackN);
  }

  /* ---------- 按实际堆数排布储能柜 ---------- */
  function layoutStacks(n) {
    stackN = Math.max(1, Math.min(MAXN, n || 5));
    const startX = -(stackN - 1) * GAP / 2;
    for (let i = 0; i < MAXN; i++) {
      const g = groups['stack' + i];
      if (!g) continue;
      const on = i < stackN;
      g.visible = on;
      if (!on) continue;
      const x = startX + i * GAP;
      g.position.x = x;
      const sc = stackCables[i];
      if (sc && sc.flow) {
        const pts = [new THREE.Vector3(0, .3, .9), new THREE.Vector3(0, .3, 2.6),
          new THREE.Vector3(-x * .5, .32, 3.5), new THREE.Vector3(-x, .6, 3.6)];
        const curve = new THREE.CatmullRomCurve3(pts);
        const len = Math.max(1, curve.getLength());
        sc.flow.curve = curve;
        sc.flow.len = len;
        sc.flow.tube.geometry.dispose();
        sc.flow.tube.geometry = new THREE.TubeGeometry(curve, Math.max(14, Math.round(len * 4)), .058, 6, false);
        sc.flow.items.forEach(function (it) { it.mesh.position.copy(curve.getPointAt(it.t)); });
      }
    }
    applyLabelVisibility();
  }

  /* 现场实际有几个储能单元：优先 array 的堆号，退化到设备序号；判不出来按 5 */
  function stackCount() {
    const s = GaoteService.state || {};
    const seen = {};
    Object.keys(s).forEach(function (k) {
      if (k.split('|')[0] !== 'array') return;
      const meta = s[k] && s[k]._meta;
      if (!meta) return;
      const a = String(meta.arr === undefined ? '' : meta.arr);
      const v = (a && a !== '-1') ? a : String(meta.dev === undefined ? '' : meta.dev);
      if (!v || v === '-1') return;
      seen[v] = 1;
    });
    const n = Object.keys(seen).length;
    return (n >= 1 && n <= MAXN) ? n : 5;
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
    /* 有的设备只报汇总的堆数据（arr=-1），分堆值退回用该簇 cluster 的值 */
    const pv = function (a, ka, kb) { const v = bval(a, ka); return v !== null ? v : bval(clu, kb); };
    return {
      soc: pv(arr, 'arrSOC', 'cluSoc'), soh: bval(arr, 'arrSOH'),
      vol: pv(arr, 'arrVol', 'cluVol'), cur: pv(arr, 'arrCur', 'cluCur'),
      maxT: pv(arr, 'maxCellTem', 'maxCellTem'), minT: pv(arr, 'minCellTem', 'minCellTem'),
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
    box.innerHTML = rows.map(function (r) { return '<div class="c-row"><span>' + r[0] + '</span><b>' + r[1] + '</b></div>'; }).join('');
    const st = el.querySelector('.c-status');
    if (status) { st.style.display = ''; st.textContent = status; } else { st.style.display = 'none'; }
  }

  /* 全站有功功率：优先 EMS 汇总点，缺失时用各 PCS 有功相加 */
  function stationPower() {
    const p = GaoteService.val('emu', 'PCSSumsActivePower');
    if (p !== null && p !== undefined && isFinite(Number(p))) return Number(p);
    const s = GaoteService.state || {};
    let sum = null;
    Object.keys(s).forEach(function (k) {
      if (k.split('|')[0] !== 'pcs') return;
      const b = s[k];
      const idx = Object.keys(b).filter(function (x) { return b[x] && b[x].key === 'ac_pow_p'; })[0];
      if (idx === undefined) return;
      const v = b[idx].v;
      if (v !== null && v !== undefined && isFinite(Number(v))) sum = (sum === null ? 0 : sum) + Number(v);
    });
    return sum;
  }

  function update() {
    if (!inited) return;
    const emuP = stationPower();
    const emuSoc = GaoteService.val('emu', 'SumsSOC');

    /* 并网线：放电(正功率)=柜→PCS→电网，充电(负功率)=反向；速度随功率大小 */
    const pNum = (emuP === null || emuP === undefined) ? 0 : Number(emuP);
    flow.dir = pNum > 0.5 ? 1 : (pNum < -0.5 ? -1 : 0);
    flow.units = Math.min(4, Math.abs(pNum) / 80);

    /* 储能柜数量按实际上报自动排布（真机可能只有 2 个储能单元，模拟器是 5 个） */
    const n = stackCount();
    if (n !== stackN) layoutStacks(n);

    for (let i = 0; i < stackN; i++) {
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
      /* 柜门小电表：长度按 SOC */
      const gg = gauges[key];
      if (gg) {
        const soc = (d.soc === null || d.soc === undefined) ? 0 : Math.max(0, Math.min(100, Number(d.soc)));
        gg.scale.x = Math.max(.02, soc / 100);
        gg.material.color.setHex(col);
      }
      /* 柜底光晕随充放电强弱 */
      const gl = groups[key] && groups[key].userData.glow;
      if (gl) {
        const mag = Math.abs(d.cur === null ? 0 : d.cur);
        gl.material.opacity = (chg || dis) ? Math.min(.26, .1 + mag / 900) : .05;
        gl.material.color.setHex(col);
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

    /* 各柜电缆按"该柜自己"的电流定方向与速度；并网线用全站功率 */
    for (let i = 0; i < flows.length; i++) {
      const fl = flows[i];
      if (fl.stack >= 0 && fl.stack < MAXN) {
        const d = (fl.stack < stackN) ? stackData(fl.stack) : null;
        const cur = (d && d.cur !== null) ? Number(d.cur) : 0;
        fl.dir = cur > 0.5 ? 1 : (cur < -0.5 ? -1 : 0);
        fl.speed = Math.min(4, Math.abs(cur) / 80);
      } else if (fl.stack === -1) {
        fl.dir = flow.dir;
        fl.speed = flow.units;
      }
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

    /* 电动车：全站放电（功率为正）时才出现，电量条长度按系统 SOC */
    carOn = flow.dir > 0;
    if (carGroup) carGroup.visible = carOn;
    if (carLabelEl) {
      carLabelEl.innerHTML = '<b>电动车充电中</b><i>' + f(emuP, 1, ' kW') + ' · 电量 ' + f(emuSoc, 0, '%') + '</i>';
    }
    if (carBar) {
      const soc = (emuSoc === null || emuSoc === undefined) ? 0 : Math.max(0, Math.min(100, Number(emuSoc)));
      carBar.scale.x = Math.max(.03, soc / 100);
    }
    applyLabelVisibility();
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
    stepFlow(dt);
    /* 充电口指示灯呼吸 */
    if (carPort && carGroup && carGroup.visible) {
      carPort.scale.setScalar(0.85 + 0.35 * (0.5 + 0.5 * Math.sin(t / 320)));
    }
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
