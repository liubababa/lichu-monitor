/* ============================================================
 * 三维场景（Three.js r128，全部模型由代码程序化生成，无需外部模型文件）
 * 场景：电网铁塔 → 变压器 → 计量点 → 储能集装箱(电池架+PCS) → 计量点 → 用户负载
 * 特性：能流动画、扫描光环、辉光(Bloom)、悬浮标签、点击查看详情、
 *       拖拽旋转/缩放(OrbitControls)、自动旋转、自动适配窗口
 * ============================================================ */
window.Scene3D = (function () {
  'use strict';

  let renderer, labelRenderer, scene, camera, controls, composer, bloomPass, clock;
  let container, W = 1, H = 1;
  let flowTex, particles, hoverRing;
  let flowSpeed = 1, intro = 0;
  let labelsVisible = true, activeCardKey = null, hoveredKey = null;

  const deviceGroups = {};      // key -> Group
  const labelEls = {};          // key -> .tag3d 元素
  const labelWraps = {};        // key -> CSS2D wrapper
  const cardEls = {};           // key -> .card3d 元素
  const picking = [];           // 可点选的设备组
  const pulses = [];            // 能流脉冲光点
  const scanRings = [];         // 扫描光环
  const blinkers = [];          // 闪烁灯材质 {mat, phase}
  const pulseLamps = [];        // 呼吸灯材质 {mat, phase}
  const ledMats = [];           // LED 灯带材质
  let coreSprite = null;        // 储能舱能量核心光晕
  let syncRotateBtn = null;     // 由 main.js 注入，同步按钮状态

  const TEAL = 0x2ee6c8;

  /* ---------------- 基础工具 ---------------- */
  function tex(fn, w, h) {
    const c = document.createElement('canvas');
    c.width = w || 256; c.height = h || 256;
    fn(c.getContext('2d'), c.width, c.height);
    return new THREE.CanvasTexture(c);
  }
  function std(c, o) { return new THREE.MeshStandardMaterial(Object.assign({ color: c, roughness: .62, metalness: .35 }, o || {})); }
  function basic(c, o) { return new THREE.MeshBasicMaterial(Object.assign({ color: c }, o || {})); }
  function box(w, h, d, m, x, y, z) {
    const M = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    M.position.set(x || 0, y || 0, z || 0);
    return M;
  }
  let _radial = null;
  function radialTex() {
    if (_radial) return _radial;
    _radial = tex((g, w, h) => {
      const r = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      r.addColorStop(0, 'rgba(255,255,255,.9)');
      r.addColorStop(.5, 'rgba(255,255,255,.22)');
      r.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = r; g.fillRect(0, 0, w, h);
    }, 256, 256);
    return _radial;
  }
  function glowSprite(color, scale, opacity) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({
      map: radialTex(), color: color, transparent: true,
      opacity: opacity == null ? .9 : opacity,
      blending: THREE.AdditiveBlending, depthWrite: false
    }));
    s.scale.setScalar(scale);
    return s;
  }

  /* ---------------- 纹理 ---------------- */
  function groundTexture() {
    return tex((g, w, h) => {
      g.fillStyle = '#050d10'; g.fillRect(0, 0, w, h);
      const s = 34, dx = Math.sqrt(3) * s, dy = 1.5 * s;
      function hex(cx, cy, r) {
        g.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = Math.PI / 180 * (60 * i - 30);
          const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
          i ? g.lineTo(x, y) : g.moveTo(x, y);
        }
        g.closePath();
      }
      g.strokeStyle = 'rgba(46,230,200,0.075)'; g.lineWidth = 1;
      for (let row = 0; row * dy < h + s; row++) {
        for (let col = 0; col * dx < w + dx; col++) {
          hex(col * dx + (row % 2 ? dx / 2 : 0), row * dy, s - 1.5);
          g.stroke();
        }
      }
      for (let i = 0; i < 46; i++) {
        hex(Math.random() * w, Math.random() * h, s - 2);
        g.fillStyle = 'rgba(46,230,200,' + (0.02 + Math.random() * 0.05).toFixed(3) + ')';
        g.fill();
      }
      const v = g.createRadialGradient(w / 2, h / 2, w * .18, w / 2, h / 2, w * .55);
      v.addColorStop(0, 'rgba(4,9,12,0)');
      v.addColorStop(1, 'rgba(4,9,12,.97)');
      g.fillStyle = v; g.fillRect(0, 0, w, h);
    }, 1024, 1024);
  }
  function makeFlowTexture() {
    const t = tex((g, w, h) => {
      const r = g.createLinearGradient(0, 0, w, 0);
      r.addColorStop(0, 'rgba(46,230,200,0)');
      r.addColorStop(.5, 'rgba(150,255,236,1)');
      r.addColorStop(1, 'rgba(46,230,200,0)');
      g.fillStyle = r; g.fillRect(0, 0, w, h);
    }, 128, 8);
    t.wrapS = THREE.RepeatWrapping;
    t.repeat.set(5, 1);
    return t;
  }
  function rackTexture() {
    return tex((g, w, h) => {
      g.fillStyle = '#0c1417'; g.fillRect(0, 0, w, h);
      const cols = 2, rows = 6, mw = 86, mh = 52, gx = (w - cols * mw) / (cols + 1);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x = gx + c * (mw + gx), y = 12 + r * (mh + 14);
          g.fillStyle = '#152225'; g.fillRect(x, y, mw, mh);
          g.strokeStyle = 'rgba(46,230,200,.35)'; g.strokeRect(x + .5, y + .5, mw - 1, mh - 1);
          g.fillStyle = 'rgba(46,230,200,.16)'; g.fillRect(x + 8, y + mh - 12, mw - 16, 4);
          g.fillStyle = Math.random() < .8 ? '#37f2c8' : '#0b3a30';
          g.beginPath(); g.arc(x + mw - 14, y + 12, 4, 0, 7); g.fill();
        }
      }
    }, 256, 460);
  }
  function windowTexture() {
    return tex((g, w, h) => {
      g.fillStyle = '#0a1114'; g.fillRect(0, 0, w, h);
      const cw = 10, ch = 7, gx = 6, gy = 8;
      for (let y = gy; y < h - 12; y += ch + gy)
        for (let x = gx; x < w - 12; x += cw + gx) {
          const r = Math.random();
          if (r < .42) {
            g.fillStyle = r < .34
              ? 'rgba(72,235,205,' + (0.35 + Math.random() * 0.5).toFixed(2) + ')'
              : 'rgba(255,190,110,' + (0.3 + Math.random() * 0.4).toFixed(2) + ')';
            g.fillRect(x, y, cw, ch);
          }
        }
    }, 128, 256);
  }
  function screenTexture() {
    return tex((g, w, h) => {
      g.fillStyle = '#061312'; g.fillRect(0, 0, w, h);
      g.strokeStyle = 'rgba(46,230,200,.8)'; g.strokeRect(1, 1, w - 2, h - 2);
      for (let i = 0; i < 5; i++) {
        const bh = 6 + Math.random() * (h - 22);
        g.fillStyle = 'rgba(46,230,200,' + (0.35 + i * .1).toFixed(2) + ')';
        g.fillRect(10 + i * ((w - 20) / 5), h - 8 - bh, (w - 20) / 5 - 6, bh);
      }
    }, 128, 64);
  }

  /* ---------------- 通用构件 ---------------- */
  function platformMesh(w, d) {
    const g = new THREE.Group();
    const m = box(w, 0.7, d, std(0x0d1719, { roughness: .9, metalness: .1 }), 0, 0.35, 0);
    g.add(m);
    const e = new THREE.LineSegments(
      new THREE.EdgesGeometry(m.geometry),
      new THREE.LineBasicMaterial({ color: TEAL, transparent: true, opacity: .4 })
    );
    e.position.copy(m.position); g.add(e);
    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(w + 7, d + 7),
      new THREE.MeshBasicMaterial({
        map: radialTex(), transparent: true, opacity: .13,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
      })
    );
    glow.rotation.x = -Math.PI / 2; glow.position.y = 0.03; g.add(glow);
    g.userData.ringR = Math.max(w, d) * 0.52;
    return g;
  }

  /* ---------------- 设备建模 ---------------- */
  function tower(x, z, h) {
    const t = new THREE.Group(); t.position.set(x, 0, z);
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.55, 1.25, h, 4, 3, true),
      new THREE.MeshBasicMaterial({ color: 0x86b5b0, wireframe: true, transparent: true, opacity: .8, toneMapped: false })
    );
    body.position.y = h / 2; t.add(body);
    const core = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.7, h - 0.2, 4), std(0x101b1e, { roughness: .9 }));
    core.position.y = h / 2; t.add(core);
    t.add(box(5.2, 0.18, 0.18, std(0x9fb9b6), 0, h * .72, 0));
    t.add(box(3.6, 0.16, 0.16, std(0x9fb9b6), 0, h * .88, 0));
    for (let i = -1; i <= 1; i++) {
      const ins = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.7, 6), std(0xc8d4d6, { roughness: .4 }));
      ins.position.set(i * 2.1, h * .72 - 0.45, 0); t.add(ins);
    }
    const bMat = new THREE.MeshBasicMaterial({ color: 0xff5a3c, transparent: true, toneMapped: false });
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 8), bMat);
    beacon.position.y = h + 0.15; t.add(beacon);
    blinkers.push({ mat: bMat, phase: Math.random() * 3 });
    return t;
  }
  function buildTowers() {
    const g = new THREE.Group();
    g.add(tower(-4, -3, 10));
    g.add(tower(2.5, 2, 11.6));
    const a1 = new THREE.Vector3(-1.4, 7.9, -3), b1 = new THREE.Vector3(-0.1, 9.05, 2);
    const a2 = new THREE.Vector3(-2.2, 9.5, -3), b2 = new THREE.Vector3(0.7, 10.9, 2);
    [[a1, b1], [a2, b2]].forEach(pair => {
      const mid = pair[0].clone().lerp(pair[1], .5); mid.y -= 1.6;
      const curve = new THREE.CatmullRomCurve3([pair[0], mid, pair[1]]);
      g.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 0.05, 5), basic(0x3a5c60)));
    });
    return g;
  }
  function buildTransformer() {
    const g = new THREE.Group();
    g.add(box(3.6, 0.35, 2.9, std(0x182226), 0, 0.17, 0));
    g.add(box(3.1, 2.1, 2.3, std(0x8d9ba0, { metalness: .6, roughness: .42 }), 0, 1.5, 0));
    for (let s = -1; s <= 1; s += 2)
      for (let i = 0; i < 6; i++)
        g.add(box(0.09, 1.75, 1.7, std(0x74848a, { metalness: .65, roughness: .5 }), -1.25 + i * 0.5, 1.45, s * 1.32));
    for (let i = -1; i <= 1; i++) {
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.13, 1.05, 8), std(0xc4ced0, { roughness: .35 }));
      b.position.set(i * 0.95, 3.05, 0.3); g.add(b);
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 8), basic(0x9cffec, { toneMapped: false }));
      tip.position.set(i * 0.95, 3.62, 0.3); g.add(tip);
    }
    const cons = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 1.7, 10), std(0x9aa8ac));
    cons.rotation.z = Math.PI / 2; cons.position.set(0.2, 2.95, -0.75); g.add(cons);
    const lMat = new THREE.MeshStandardMaterial({ color: 0x0a2019, emissive: TEAL, emissiveIntensity: 1.2, toneMapped: false });
    g.add(box(0.18, 0.18, 0.18, lMat, 1.3, 2.35, 1.0));
    pulseLamps.push({ mat: lMat, phase: 0 });
    return g;
  }
  function buildMeter() {
    const g = new THREE.Group();
    g.add(box(1.7, 0.25, 1.2, std(0x182226), 0, 0.12, 0));
    g.add(box(1.15, 1.65, 0.85, std(0xb6c2c5, { metalness: .45, roughness: .5 }), 0, 1.07, 0));
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.78, 0.5), new THREE.MeshBasicMaterial({ map: screenTexture(), toneMapped: false }));
    scr.position.set(0, 1.25, 0.44); g.add(scr);
    const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.9, 6), std(0x9fb0b3));
    ant.position.set(0.42, 2.35, 0); g.add(ant);
    const tMat = new THREE.MeshStandardMaterial({ color: 0x0a2019, emissive: TEAL, emissiveIntensity: 1.4, toneMapped: false });
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 8), tMat);
    tip.position.set(0.42, 2.82, 0); g.add(tip);
    pulseLamps.push({ mat: tMat, phase: 1.5 });
    return g;
  }
  function buildStorage() {
    const g = new THREE.Group();
    const wallMat = std(0xb4bfc3, { metalness: .3, roughness: .6 });
    const innerMat = std(0x111b1f, { roughness: .9, metalness: .1 });
    const L = 18, Wd = 8, Hh = 5.0, baseY = 0.7;

    g.add(box(L, 0.3, Wd, innerMat, 0, baseY + 0.15, 0));                                   // 地板
    g.add(box(L, Hh, 0.25, wallMat, 0, baseY + Hh / 2 + 0.3, -Wd / 2 + 0.12));              // 后墙
    g.add(box(0.25, Hh, Wd, wallMat, -L / 2 + 0.12, baseY + Hh / 2 + 0.3, 0));              // 左墙
    g.add(box(0.25, Hh, Wd, wallMat, L / 2 - 0.12, baseY + Hh / 2 + 0.3, 0));               // 右墙
    g.add(box(L + 0.5, 0.28, Wd + 0.5, wallMat, 0, baseY + Hh + 0.44, 0));                  // 顶
    g.add(box(4, 0.5, 3, std(0x9aa8ac), -4, baseY + Hh + 0.8, -1));                         // 屋顶空调
    g.add(box(2.4, 0.4, 2.4, std(0x8a989c), 4.5, baseY + Hh + 0.72, 1));                    // 屋顶设备

    const ledMat = new THREE.MeshStandardMaterial({ color: 0x0a2019, emissive: TEAL, emissiveIntensity: 1.6, toneMapped: false });
    const led = box(L, 0.09, 0.09, ledMat, 0, baseY + 0.12, Wd / 2 - 0.06);
    g.add(led); ledMats.push(ledMat);
    const led2 = box(L, 0.07, 0.07, ledMat, 0, baseY + Hh + 0.2, Wd / 2 - 0.2);
    g.add(led2);

    // 电池架 x3（前脸为发光电池模块纹理）
    [-6, -1, 4].forEach(x => {
      g.add(box(4.1, 4.3, 2.7, std(0x141e22, { roughness: .8, metalness: .15 }), x, baseY + 0.3 + 2.15, -0.9));
      const face = new THREE.Mesh(
        new THREE.PlaneGeometry(4.0, 4.2),
        new THREE.MeshBasicMaterial({ map: rackTexture(), toneMapped: false })
      );
      face.position.set(x, baseY + 0.3 + 2.15, -0.9 + 1.36);
      g.add(face);
    });

    // PCS 功率柜
    g.add(box(2.3, 4.9, 2.6, std(0x93a1a5, { metalness: .5, roughness: .5 }), 7.2, baseY + 0.3 + 2.45, -0.9));
    const pcsPanel = new THREE.Mesh(new THREE.PlaneGeometry(2.1, 4.6), basic(0x27343a));
    pcsPanel.position.set(7.2, baseY + 0.3 + 2.45, 0.41); g.add(pcsPanel);
    const pcsScr = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.5), new THREE.MeshBasicMaterial({ map: screenTexture(), toneMapped: false }));
    pcsScr.position.set(7.2, baseY + 3.6, 0.42); g.add(pcsScr);

    // 舱内点光 + 能量核心光晕
    const pl = new THREE.PointLight(TEAL, 1.15, 18, 2);
    pl.position.set(0, 3.4, 1.5); g.add(pl);
    coreSprite = glowSprite(0x46ffd9, 3.2, .55);
    coreSprite.position.set(-1, 3.4, 0.6);
    g.add(coreSprite);
    return g;
  }
  function buildBuildings() {
    const g = new THREE.Group();
    const winTex = windowTexture();
    const wm = new THREE.MeshStandardMaterial({
      color: 0x141d21, roughness: .75, metalness: .2,
      map: winTex, emissive: 0xffffff, emissiveMap: winTex, emissiveIntensity: .8
    });
    const top = std(0x0d1417, { roughness: .9 });
    g.add(box(11, 0.8, 7.5, std(0x0f1a1d), 0, 0.4, 0));
    function bld(w, h, d, x, z) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), [wm, wm, top, top, wm, wm]);
      m.position.set(x, h / 2 + 0.8, z); g.add(m);
    }
    bld(2.9, 8.5, 2.9, -3, 0.8);
    bld(2.6, 11.5, 2.6, 0.6, -1.8);
    bld(2.4, 6.4, 2.4, 3.4, 1.2);
    return g;
  }

  /* ---------------- 能流线缆 ---------------- */
  function addCable(pts) {
    const curve = new THREE.CatmullRomCurve3(pts.map(p => new THREE.Vector3(p[0], p[1], p[2])));
    scene.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 40, 0.09, 6), basic(0x123236)));
    const flow = new THREE.Mesh(
      new THREE.TubeGeometry(curve, 40, 0.13, 6),
      new THREE.MeshBasicMaterial({
        map: flowTex, transparent: true, opacity: .95,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
      })
    );
    scene.add(flow);
    for (let i = 0; i < 2; i++) {
      const s = glowSprite(0x8cffef, 0.9);
      s.userData = { curve: curve, off: i / 2 };
      pulses.push(s); scene.add(s);
    }
    [pts[0], pts[pts.length - 1]].forEach(p => {
      const s = glowSprite(0x55ffd8, 0.55);
      s.position.set(p[0], p[1] + 0.05, p[2]);
      scene.add(s);
    });
  }

  /* ---------------- 标签 / 详情卡 ---------------- */
  function addLabel(key, pos) {
    const wrap = document.createElement('div');
    const el = document.createElement('div');
    el.className = 'tag3d';
    wrap.appendChild(el);
    const o = new THREE.CSS2DObject(wrap);
    o.position.copy(pos);
    deviceGroups[key].add(o);
    labelEls[key] = el; labelWraps[key] = wrap;
  }
  function addCard(key, pos) {
    const wrap = document.createElement('div');
    const el = document.createElement('div');
    el.className = 'card3d'; el.style.display = 'none';
    el.innerHTML = '<div class="c-head"><span></span><i class="c-x">✕</i></div><div class="c-rows"></div><div class="c-status" style="display:none"></div>';
    el.querySelector('.c-x').addEventListener('click', e => { e.stopPropagation(); showCard(null); });
    wrap.appendChild(el);
    const o = new THREE.CSS2DObject(wrap);
    o.position.copy(pos);
    deviceGroups[key].add(o);
    cardEls[key] = el;
  }
  function showCard(key) {
    for (const k in cardEls) cardEls[k].style.display = 'none';
    activeCardKey = key;
    if (key) cardEls[key].style.display = '';
    applyLabelVisibility();
  }
  function applyLabelVisibility() {
    for (const k in labelEls)
      labelEls[k].style.visibility = (labelsVisible && activeCardKey !== k) ? 'visible' : 'hidden';
  }

  /* ---------------- 设备注册 ---------------- */
  function registerDevice(key, group, labelPos, cardPos) {
    group.userData.key = key;
    deviceGroups[key] = group;
    picking.push(group);
    addLabel(key, labelPos);
    addCard(key, cardPos);
    scene.add(group);
  }
  function buildAll() {
    // 地面
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(300, 300),
      new THREE.MeshBasicMaterial({ map: groundTexture(), toneMapped: false })
    );
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);

    // 电网（铁塔）
    const gT = new THREE.Group(); gT.position.set(-25, 0, -2);
    gT.add(platformMesh(15, 12));
    const tw = buildTowers(); tw.position.y = 0.7; gT.add(tw);
    registerDevice('grid', gT, new THREE.Vector3(-1, 13.2, 0), new THREE.Vector3(-1, 12.8, 1));

    // 变压器
    const gTr = new THREE.Group(); gTr.position.set(-15, 0, 5.5);
    gTr.add(platformMesh(9, 7));
    const tr = buildTransformer(); tr.position.y = 0.7; gTr.add(tr);
    registerDevice('transformer', gTr, new THREE.Vector3(0, 6.2, 0), new THREE.Vector3(0, 5.8, 0.5));

    // 计量点 A（储能侧）
    const gMA = new THREE.Group(); gMA.position.set(-7, 0, 8.5);
    gMA.add(platformMesh(5.5, 4.5));
    const mA = buildMeter(); mA.position.y = 0.7; gMA.add(mA);
    registerDevice('meterA', gMA, new THREE.Vector3(0, 4.8, 0), new THREE.Vector3(0, 4.4, 0.4));

    // 储能电站（主角）
    const gSt = new THREE.Group(); gSt.position.set(5.5, 0, -0.5);
    gSt.add(platformMesh(22, 13));
    gSt.add(buildStorage());
    registerDevice('storage', gSt, new THREE.Vector3(0, 9.6, 0), new THREE.Vector3(0, 9.2, 2));

    // 计量点 B（并网侧）
    const gMB = new THREE.Group(); gMB.position.set(19.5, 0, 6.5);
    gMB.add(platformMesh(5.5, 4.5));
    const mB = buildMeter(); mB.position.y = 0.7; gMB.add(mB);
    registerDevice('meterB', gMB, new THREE.Vector3(0, 4.8, 0), new THREE.Vector3(0, 4.4, 0.4));

    // 用户负载（楼宇）
    const gL = new THREE.Group(); gL.position.set(27, 0, -1.5);
    gL.add(platformMesh(12, 9));
    gL.add(buildBuildings());
    registerDevice('load', gL, new THREE.Vector3(0, 14.4, 0), new THREE.Vector3(0, 14, 0.5));

    // 能流线缆
    addCable([[-21.5, 0.35, 0.8], [-18, 0.5, 3.2], [-15.2, 0.4, 4.3]]);
    addCable([[-13, 0.4, 6.6], [-10, 0.35, 7.9], [-7.6, 0.35, 8.4]]);
    addCable([[-6.2, 0.35, 7.6], [-5.9, 0.35, 4], [-5.1, 0.4, 1.6]]);
    addCable([[15.2, 0.4, 3.4], [17.2, 0.35, 5.6], [18.9, 0.35, 6.4]]);
    addCable([[20.6, 0.35, 6], [24, 0.35, 3], [26.4, 0.4, 0.2]]);

    // 储能平台扫描光环
    for (let i = 0; i < 2; i++) {
      const r = new THREE.Mesh(
        new THREE.RingGeometry(0.92, 1.0, 64),
        new THREE.MeshBasicMaterial({
          color: TEAL, transparent: true, opacity: .4, side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
        })
      );
      r.rotation.x = -Math.PI / 2;
      r.position.set(5.5, 0.76, -0.5);
      r.userData.phase = i * 0.5;
      scanRings.push(r); scene.add(r);
    }

    // 悬停高亮光环
    hoverRing = new THREE.Mesh(
      new THREE.RingGeometry(0.82, 1.0, 48),
      new THREE.MeshBasicMaterial({
        color: TEAL, transparent: true, opacity: 0, side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
      })
    );
    hoverRing.rotation.x = -Math.PI / 2; hoverRing.position.y = 0.78;
    scene.add(hoverRing);

    // 氛围粒子
    const n = 260, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() - .5) * 95;
      pos[i * 3 + 1] = Math.random() * 26;
      pos[i * 3 + 2] = (Math.random() - .5) * 60;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    particles = new THREE.Points(geo, new THREE.PointsMaterial({
      color: 0x2ee6c8, size: 0.28, transparent: true, opacity: .38,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
    }));
    scene.add(particles);
  }

  /* ---------------- 交互拾取 ---------------- */
  let ray = null, mouse = null; // THREE 加载完成后在 init 中创建
  let downX = 0, downY = 0;
  function pickKey(ev) {
    const r = renderer.domElement.getBoundingClientRect();
    mouse.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
    mouse.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
    ray.setFromCamera(mouse, camera);
    const hits = ray.intersectObjects(picking, true);
    if (hits.length) {
      let o = hits[0].object;
      while (o && !o.userData.key) o = o.parent;
      return o && o.userData.key ? o.userData.key : null;
    }
    return null;
  }
  function bindEvents() {
    const el = renderer.domElement;
    el.addEventListener('pointermove', ev => {
      const k = pickKey(ev);
      if (k !== hoveredKey) {
        hoveredKey = k;
        el.style.cursor = k ? 'pointer' : '';
        for (const key in labelEls) labelEls[key].classList.toggle('hot', key === hoveredKey);
        if (k) {
          const g = deviceGroups[k];
          hoverRing.position.set(g.position.x, 0.78, g.position.z);
          const s = (g.children[0] && g.children[0].userData.ringR) || 6;
          hoverRing.userData.targetScale = s;
        }
      }
    });
    el.addEventListener('pointerdown', ev => { downX = ev.clientX; downY = ev.clientY; });
    el.addEventListener('pointerup', ev => {
      if (Math.abs(ev.clientX - downX) > 5 || Math.abs(ev.clientY - downY) > 5) return;
      const k = pickKey(ev);
      showCard(k === activeCardKey ? null : k);
    });
  }

  /* ---------------- 初始化 ---------------- */
  function init(el) {
    container = el;
    W = el.clientWidth || 1; H = el.clientHeight || 1;
    clock = new THREE.Clock();
    ray = new THREE.Raycaster();
    mouse = new THREE.Vector2();

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x04090c);

    camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 700);
    const dir = new THREE.Vector3(1, 0.85, 1).normalize();
    camera.position.copy(new THREE.Vector3(0, 2.5, 0).add(dir.multiplyScalar(220)));
    camera.lookAt(0, 2.5, 0);

    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(W, H);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    el.appendChild(renderer.domElement);

    labelRenderer = new THREE.CSS2DRenderer();
    labelRenderer.setSize(W, H);
    labelRenderer.domElement.style.position = 'absolute';
    labelRenderer.domElement.style.inset = '0';
    labelRenderer.domElement.style.pointerEvents = 'none';
    el.appendChild(labelRenderer.domElement);

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 2.5, 0);
    controls.enableDamping = true;
    controls.dampingFactor = .08;
    controls.minZoom = .5; controls.maxZoom = 3.2;
    controls.minPolarAngle = .55; controls.maxPolarAngle = 1.32;
    controls.autoRotate = false; controls.autoRotateSpeed = .45;
    controls.addEventListener('start', () => {
      if (controls.autoRotate) { controls.autoRotate = false; syncRotateBtn && syncRotateBtn(false); }
    });

    // 灯光
    scene.add(new THREE.HemisphereLight(0xbfe8e0, 0x0a1013, .85));
    const dl = new THREE.DirectionalLight(0xffffff, .75);
    dl.position.set(40, 70, 30); scene.add(dl);
    const pt = new THREE.PointLight(TEAL, .5, 130, 2);
    pt.position.set(0, 18, 0); scene.add(pt);

    flowTex = makeFlowTexture();
    buildAll();
    bindEvents();

    // 辉光后期
    composer = new THREE.EffectComposer(renderer);
    composer.addPass(new THREE.RenderPass(scene, camera));
    bloomPass = new THREE.UnrealBloomPass(new THREE.Vector2(W, H), 0.5, 0.55, 0.85);
    composer.addPass(bloomPass);

    setFrustum();
    controls.saveState();
    showCard('storage');
    animate();
  }

  function setFrustum() {
    const a = W / H;
    const vh = Math.min(96, Math.max(46, 64 / a));
    camera.left = -vh * a / 2; camera.right = vh * a / 2;
    camera.top = vh / 2; camera.bottom = -vh / 2;
    camera.updateProjectionMatrix();
  }

  /* ---------------- 帧循环 ---------------- */
  function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.05);
    const t = clock.getElapsedTime();

    if (intro < 1) {
      intro = Math.min(1, intro + dt / 1.6);
      const e = 1 - Math.pow(1 - intro, 3);
      camera.zoom = 0.62 + 0.38 * e;
      camera.updateProjectionMatrix();
    }
    controls.update();

    flowTex.offset.x = -(t * 0.35 * flowSpeed) % 1;
    pulses.forEach(s => {
      const u = s.userData;
      const k = (t * 0.14 * flowSpeed + u.off) % 1;
      s.position.copy(u.curve.getPointAt(k));
    });
    scanRings.forEach(r => {
      const k = (t * 0.42 + r.userData.phase) % 1;
      r.scale.setScalar(1 + k * 9.5);
      r.material.opacity = (1 - k) * 0.38;
    });
    blinkers.forEach(b => { b.mat.opacity = 0.3 + 0.7 * Math.abs(Math.sin(t * 2.4 + b.phase)); });
    pulseLamps.forEach(b => { b.mat.emissiveIntensity = 0.7 + 0.9 * (0.5 + 0.5 * Math.sin(t * 3 + b.phase)); });
    ledMats.forEach(m => { m.emissiveIntensity = 1.2 + 0.7 * (0.5 + 0.5 * Math.sin(t * 2.2)); });
    if (coreSprite) {
      coreSprite.material.opacity = 0.4 + 0.25 * Math.sin(t * 2.6);
      coreSprite.scale.setScalar(3 + 0.5 * Math.sin(t * 2.6));
    }
    if (particles) {
      const arr = particles.geometry.attributes.position.array;
      for (let i = 1; i < arr.length; i += 3) {
        arr[i] += dt * 0.55;
        if (arr[i] > 26) arr[i] = 0;
      }
      particles.geometry.attributes.position.needsUpdate = true;
    }
    if (hoverRing) {
      const target = hoveredKey ? 0.5 : 0;
      hoverRing.material.opacity += (target - hoverRing.material.opacity) * Math.min(1, dt * 10);
      const ts = hoverRing.userData.targetScale || 6;
      hoverRing.scale.setScalar(ts);
    }

    composer.render();
    labelRenderer.render(scene, camera);
  }

  /* ---------------- 数据更新（由 main.js 每个数据周期调用） ---------------- */
  function update(data) {
    if (!scene) return;
    if (typeof data.flowSpeed === 'number') flowSpeed = Math.max(.2, Math.min(3, data.flowSpeed));
    const dv = data.devices || {};
    for (const k in dv) {
      const d = dv[k];
      const el = labelEls[k];
      if (el) {
        el.innerHTML = '<b>' + d.name + '</b>' +
          (d.stats || []).map(s => '<span>' + s[0] + ' <i>' + s[1] + '</i></span>').join('');
      }
      const card = cardEls[k];
      if (card && activeCardKey === k && d.card) {
        card.querySelector('.c-head span').textContent = d.card.title;
        card.querySelector('.c-rows').innerHTML =
          (d.card.rows || []).map(r => '<div class="c-row"><span>' + r[0] + '</span><i>' + r[1] + '</i></div>').join('');
        const st = card.querySelector('.c-status');
        if (d.card.status) { st.style.display = ''; st.textContent = '● ' + d.card.status; }
        else st.style.display = 'none';
      }
    }
  }

  /* ---------------- 对外 API ---------------- */
  function resize() {
    W = container.clientWidth || 1; H = container.clientHeight || 1;
    renderer.setSize(W, H);
    composer.setSize(W, H);
    labelRenderer.setSize(W, H);
    setFrustum();
  }
  function toggleLabels() { labelsVisible = !labelsVisible; applyLabelVisibility(); return labelsVisible; }
  function toggleRotate(force) {
    const v = typeof force === 'boolean' ? force : !controls.autoRotate;
    controls.autoRotate = v;
    return v;
  }
  function resetView() { controls.reset(); controls.autoRotate = false; syncRotateBtn && syncRotateBtn(false); }

  return {
    init, update, resize, toggleLabels, toggleRotate, resetView,
    setRotateSync(fn) { syncRotateBtn = fn; }
  };
})();
