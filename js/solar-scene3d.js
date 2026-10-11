/* ============================================================
 * 洙边卫生院站 · 光伏三维场景
 *
 *   屋顶光伏阵列（8 排 × 10 块组件级建模：玻璃 / 铝边框 / 导轨 / 竖撑
 *   + 检修走道 + 屋面线槽）+ 逆变器 + 通信模块 + 并网点。
 *   直流电缆从屋面线槽穿过女儿墙套管沿东墙下到逆变器（青色光纹），
 *   交流电缆从逆变器沿东墙、南墙接到并网计量箱（橙色光纹），
 *   电流光纹随真实发电功率流动。
 *
 *   场地按真实卫生院配置：草地、场坪、道路、围墙大门、绿篱行道树、
 *   邻舍与远山；天空为渐变穹顶（随页面主题换色温），日盘带光晕，
 *   组件玻璃借天空环境贴图带反光高光。
 *
 *   天气（SolarScene.setWeather）驱动画面：
 *     云量 → 天空/光照亮度、云朵多少
 *     降水 → 雨/雪粒子
 *     辐照度 → 光照强度、组件反光强度
 *     昼夜（is_day）→ 太阳 / 月亮
 *   发电功率（SolarScene.setPower）驱动：
 *     组件发光、电流光纹流速、逆变器指示灯、并网点状态与浮标数值
 * ============================================================ */
window.SolarScene = (function () {
  'use strict';

  let inited = false, root = null, scene, camera, renderer, composer = null, bloomPass = null, controls, labelR = null;
  let sun = null, moon = null, sunGlow = null, sunLight = null, hemi = null, fillLight = null, skyDome = null;
  let cloudGroup = null, precipGroup = null, envRT = null;
  let panelMats = [], invLabelEl = null, arrLabelEl = null, gridLabelEl = null;
  let raf = null, W = 0, H = 0;
  const flows = [];                 // 电流光纹：{ map, tubeMat, kind, on, speed }
  const labelObjs = [];             // 浮标对象（点开明细卡时统一藏起来）
  const cards = {};                 // 设备明细卡：key -> .card3d 元素
  let activeCard = null;
  const clock = { last: 0 };
  let cur = { power: 0, cap: 110.16, today: null, cloud: 0, precip: 0, isDay: 1, radiation: 0 };
  let theme = 'night';

  const THREE_ = () => window.THREE;

  /* 天空穹顶配色：夜里（深色界面）偏靛蓝，白天（浅色界面）明亮，
     地平线都是雾白色，远景靠雾融进天空 */
  const SKY = {
    night: { stops: [[0, '#12385f'], [.40, '#2f6b9e'], [.58, '#77a9c9'], [.74, '#bcd6e2'], [1, '#d2e2e8']], fog: 0xd2e2e8 },
    day: { stops: [[0, '#2f74b8'], [.45, '#5fa6d8'], [.62, '#9ccbe4'], [.78, '#cfe2ec'], [1, '#dbe9f0']], fog: 0xd3e3ec }
  };
  /* 电流光纹配色：直流（光伏侧）青 / 交流（并网侧）橙；白天浅底用深一档 */
  const FLOWC = {
    night: { dc: 0x2ee6c8, ac: 0xffb020, idle: 0x24444a },
    day: { dc: 0x0f9e86, ac: 0xd97700, idle: 0x6f8a86 }
  };
  /* 场地配色：夜里是深色网格地台（跟莒南/高特场景一个观感），白天换浅色 */
  const SITE = {
    night: { groundBg: '#04090c', gridLine: 'rgba(46,230,200,.16)', platform: 0x0b1a1e },
    day: { groundBg: '#d8dcd7', gridLine: 'rgba(102,116,112,.35)', platform: 0xd6dad5 }
  };

  /* ---------------- 基础工具 ---------------- */
  let groundMat = null, platformMat = null;
  const themeMats = [];             // 跟主题换色/换贴图的材质
  function regThemeMat(mat, night, day) { themeMats.push({ mat: mat, night: night || {}, day: day || {} }); return mat; }
  function std(color, o) {
    const p = Object.assign({ roughness: .7, metalness: .2 }, o || {});
    return new THREE.MeshStandardMaterial({
      color: color, roughness: p.roughness, metalness: p.metalness,
      envMapIntensity: p.envMapIntensity === undefined ? .2 : p.envMapIntensity
    });
  }
  function box(w, h, d, mat, x, y, z) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x || 0, y || 0, z || 0);
    m.castShadow = m.receiveShadow = true;
    return m;
  }
  function cyl(r1, r2, h, mat, x, y, z, seg) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, h, seg || 10), mat);
    m.position.set(x || 0, y || 0, z || 0);
    m.castShadow = m.receiveShadow = true;
    return m;
  }
  /* 画布贴图（sc 为超采样倍数：按 w×h 坐标绘制，输出放大 sc 倍，近看不糊） */
  function tex(fn, w, h, sc) {
    const s = sc || 1;
    const c = document.createElement('canvas');
    c.width = (w || 256) * s; c.height = (h || 256) * s;
    const g = c.getContext('2d');
    if (s > 1) g.scale(s, s);
    fn(g, w || 256, h || 256);
    const t = new THREE.CanvasTexture(c);
    t.anisotropy = 4;
    return t;
  }
  function label(text, cls, x, y, z) {
    const wrap = document.createElement('div');
    const el = document.createElement('div');
    el.className = 'tag3d ' + (cls || 'tag3d-gt');
    el.innerHTML = text;
    wrap.appendChild(el);
    const o = new THREE.CSS2DObject(wrap);
    o.position.set(x, y, z);
    root.add(o);
    labelObjs.push(o);
    return el;
  }
  /* 设备明细卡（沿用高特/莒南场景的 .card3d 版式）：点设备弹出，内容取实时值 */
  function addCard(key, x, y, z) {
    const wrap = document.createElement('div');
    const el = document.createElement('div');
    el.className = 'card3d';
    el.style.display = 'none';
    el.innerHTML = '<div class="c-head"><span></span><i class="c-x">✕</i></div><div class="c-rows"></div><div class="c-status" style="display:none"></div>';
    el.querySelector('.c-x').addEventListener('click', function (e) { e.stopPropagation(); showCard(null); });
    wrap.appendChild(el);
    const o = new THREE.CSS2DObject(wrap);
    o.position.set(x, y, z);
    root.add(o);
    cards[key] = el;
  }
  function setCard(key, title, rows, status) {
    const el = cards[key];
    if (!el) return;
    el.querySelector('.c-head span').textContent = title;
    el.querySelector('.c-rows').innerHTML = rows.map(function (r) {
      return '<div class="c-row"><span>' + r[0] + '</span><i>' + r[1] + '</i></div>';
    }).join('');
    const st = el.querySelector('.c-status');
    if (status) { st.style.display = ''; st.textContent = status; } else { st.style.display = 'none'; }
  }
  function showCard(key) {
    activeCard = (key && cards[key]) ? key : null;
    applyLabelVisibility();
  }
  /* 卡片打开时把所有浮标藏起来：浮标按 3D 位置投影，会压在卡片上 */
  function applyLabelVisibility() {
    const hide = !!activeCard;
    labelObjs.forEach(function (o) { o.visible = labelsOn && !hide; });
    for (const k in cards) cards[k].style.display = (k === activeCard) ? '' : 'none';
  }

  /* ---------------- 贴图 ---------------- */
  /* 组件面板：深蓝电池片 + 细栅线 + 银色铝边框 + 斜向天空反光 */
  function panelTexture() {
    return tex(function (g, w, h) {
      g.fillStyle = '#0a2140'; g.fillRect(0, 0, w, h);
      const bx = 8, by = 8, bw = w - 16, bh = h - 16;
      const cw = bw / 10, ch = bh / 6;
      for (let r = 0; r < 6; r++) {
        for (let c = 0; c < 10; c++) {
          const x = bx + c * cw, y = by + r * ch;
          g.fillStyle = (r + c) % 2 ? '#0e2f57' : '#10365e';
          g.fillRect(x + 1.2, y + 1.2, cw - 2.4, ch - 2.4);
          g.strokeStyle = 'rgba(150,200,255,.16)';
          g.lineWidth = .8;
          g.beginPath(); g.moveTo(x + cw / 3, y + 2); g.lineTo(x + cw / 3, y + ch - 2); g.stroke();
          g.beginPath(); g.moveTo(x + cw * 2 / 3, y + 2); g.lineTo(x + cw * 2 / 3, y + ch - 2); g.stroke();
        }
      }
      const lg = g.createLinearGradient(0, 0, w, h);
      lg.addColorStop(0, 'rgba(190,225,255,.20)');
      lg.addColorStop(.42, 'rgba(190,225,255,.05)');
      lg.addColorStop(.58, 'rgba(255,255,255,0)');
      lg.addColorStop(1, 'rgba(255,255,255,.06)');
      g.fillStyle = lg; g.fillRect(0, 0, w, h);
      g.strokeStyle = '#c3ced4'; g.lineWidth = 9;
      g.strokeRect(4.5, 4.5, w - 9, h - 9);
      g.strokeStyle = 'rgba(20,40,60,.5)'; g.lineWidth = 2;
      g.strokeRect(11, 11, w - 22, h - 22);
    }, 320, 160, 2);
  }

  /* 卫生院外墙：浅色墙面 + 窗带（侧面）；正面一张带门头院名的贴图 */
  function wallTexture(front) {
    return tex(function (g, w, h) {
      g.fillStyle = '#d3d8d1'; g.fillRect(0, 0, w, h);
      g.fillStyle = 'rgba(0,0,0,.05)';
      for (let x = 0; x < w; x += 64) g.fillRect(x, 0, 2, h - 26);
      g.fillStyle = '#adb2a8'; g.fillRect(0, h - 26, w, 26);          /* 勒脚 */
      const n = front ? 7 : 6, sw = w / n;
      for (let i = 0; i < n; i++) {
        const cx = i * sw + sw / 2;
        if (front && i === Math.floor(n / 2)) continue;                /* 正面中间留给大门 */
        g.fillStyle = '#2d4a56';
        g.fillRect(cx - sw * .30, h * .30, sw * .60, h * .34);
        g.fillStyle = 'rgba(255,255,255,.35)';
        g.fillRect(cx - sw * .30, h * .30, sw * .60, 6);
        g.fillStyle = 'rgba(255,255,255,.5)';
        g.fillRect(cx - sw * .30 + 2, h * .30 + 6, 3, h * .34 - 6);
      }
      if (front) {
        const cx = w / 2;
        g.fillStyle = '#cfd6d2';                                       /* 门套 */
        g.fillRect(cx - 62, h * .30 - 8, 124, h - h * .30 + 8);
        g.fillStyle = '#31505c';                                       /* 双开门 */
        g.fillRect(cx - 54, h * .38, 108, h - h * .38);
        g.fillStyle = 'rgba(255,255,255,.55)';
        g.fillRect(cx - 3, h * .38, 6, h - h * .38);
        g.fillStyle = 'rgba(210,235,245,.85)';
        g.fillRect(cx - 54, h * .38, 108, 22);
        g.fillStyle = '#eef4f2';                                       /* 院名牌 */
        g.fillRect(cx - 100, 26, 200, 48);
        g.strokeStyle = '#9fb0b4'; g.lineWidth = 2;
        g.strokeRect(cx - 100, 26, 200, 48);
        g.fillStyle = '#1d6ab0';
        g.font = 'bold 30px "Microsoft YaHei", sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText('洙边卫生院', cx, 51);
        g.fillStyle = '#d33a2c';                                       /* 红十字 */
        g.fillRect(cx + 104, 34, 12, 30);
        g.fillRect(cx + 95, 43, 30, 12);
      }
    }, 1024, 256, front ? 2 : 1);
  }

  /* 网格地坪：科技感地台（夜里深底 + 青线，白天浅底 + 灰线） */
  function gridTexture() {
    const p = SITE[theme] || SITE.night;
    return tex(function (g, w, h) {
      g.fillStyle = p.groundBg; g.fillRect(0, 0, w, h);
      g.strokeStyle = p.gridLine; g.lineWidth = 3;
      for (let i = 0; i <= 8; i++) {
        const q = i * w / 8;
        g.beginPath(); g.moveTo(q, 0); g.lineTo(q, h); g.stroke();
        g.beginPath(); g.moveTo(0, q); g.lineTo(w, q); g.stroke();
      }
    }, 256, 256);
  }

  /* 电流光纹：一段"宽亮头 + 短拖尾"，沿线滚动时一眼看出在流动 */
  let flowTexProto = null;
  function flowTexture(repeat) {
    if (!flowTexProto) {
      flowTexProto = tex(function (g, w, h) {
        g.clearRect(0, 0, w, h);
        for (let k = 0; k < 2; k++) {
          const x = k * (w / 2);
          const lg = g.createLinearGradient(x, 0, x + w / 2, 0);
          lg.addColorStop(0, 'rgba(255,255,255,0)');
          lg.addColorStop(.34, 'rgba(255,255,255,.30)');
          lg.addColorStop(.56, 'rgba(255,255,255,.95)');
          lg.addColorStop(.62, 'rgba(255,255,255,1)');
          lg.addColorStop(.74, 'rgba(255,255,255,.26)');
          lg.addColorStop(1, 'rgba(255,255,255,0)');
          g.fillStyle = lg; g.fillRect(x, 0, w / 2, h);
        }
      }, 128, 8);
      flowTexProto.wrapS = flowTexProto.wrapT = THREE.RepeatWrapping;
    }
    const t = flowTexProto.clone();
    t.needsUpdate = true;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(Math.max(2, Math.round((repeat || 8) / 4.2)), 1);
    return t;
  }

  /* ---------------- 场景尺寸常量 ---------------- */
  const W2 = 26, H2 = 4.2, D2 = 16;              /* 卫生院：宽 × 高 × 深 */
  const roofY = H2 + .3;                         /* 屋面标高（含 0.3 勒脚台） */
  const COLS = 10;
  const MW = 2.28, MD = 1.13, MT = .045;         /* 组件：宽 × 深 × 厚 */
  const TILT = .49;                              /* 组件倾角 28°（+z 为南，朝太阳低下来） */
  const ROW_Y = .62;                             /* 组件面中心相对屋面的高度 */
  const rowW = COLS * MW + (COLS - 1) * .06;     /* 一排的总宽 */
  const rowZs = [-5.55, -4.05, -2.55, -1.05, 1.05, 2.55, 4.05, 5.55];   /* 8 排，中间留检修走道 */
  /* 排内局部坐标 → 组件面高度（相对屋面；南低北高） */
  function rowPlaneY(zl) { return roofY + ROW_Y - Math.tan(TILT) * zl; }
  const RAIL_Z = .40;                            /* 导轨在排内的前后位置 */
  const RAIL_DROP = .0525;                       /* 导轨中心比组件面低多少（导轨顶面贴组件底面） */
  const LEG_DROP = RAIL_DROP + .03;              /* 竖撑顶面贴导轨底面 */

  function skyTexture(p) {
    return tex(function (g, w, h) {
      const grd = g.createLinearGradient(0, 0, 0, h);
      p.stops.forEach(function (s) { grd.addColorStop(s[0], s[1]); });
      g.fillStyle = grd; g.fillRect(0, 0, w, h);
    }, 16, 256);
  }

  /* ---------------- 场地 ---------------- */
  function buildSite() {
    const T = THREE_();
    /* 网格地坪：科技感地台（铺得很大，远处交给雾淡出） */
    groundMat = regThemeMat(new T.MeshStandardMaterial({ map: gridTexture(), roughness: .95, metalness: .05, envMapIntensity: .18 }));
    groundMat.map.wrapS = groundMat.map.wrapT = T.RepeatWrapping;
    groundMat.map.repeat.set(10, 10);
    const ground = new T.Mesh(new T.PlaneGeometry(400, 400), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    root.add(ground);
    /* 场坪：建筑与设备坐落的台面 */
    platformMat = regThemeMat(std(SITE.night.platform, { roughness: .9 }),
      { color: SITE.night.platform }, { color: SITE.day.platform });
    root.add(box(46, .16, 28, platformMat, 0, .08, 0));
    /* 台面四边的发光包边（科技感光带；夜里青色、白天暖色） */
    const edgeMat = regThemeMat(new T.MeshBasicMaterial({ color: 0x2ee6c8, transparent: true, opacity: .8 }),
      { color: 0x2ee6c8 }, { color: 0xd7a400 });
    [[46, .16, 0, 14], [46, .16, 0, -14], [.16, 28, 23, 0], [.16, 28, -23, 0]].forEach(function (e) {
      root.add(box(e[0], .05, e[1], edgeMat, e[2], .175, e[3]));
    });
  }

  /* ---------------- 卫生院建筑 ---------------- */
  function buildBuilding() {
    const T = THREE_();
    const wallSide = new T.MeshStandardMaterial({ map: wallTexture(false), roughness: .82, metalness: .04, envMapIntensity: .16 });
    const wallFront = new T.MeshStandardMaterial({ map: wallTexture(true), roughness: .82, metalness: .04, envMapIntensity: .16 });
    const wallTop = std(0xbcc0b7, { roughness: .92, envMapIntensity: .14 });
    const wallBottom = std(0x545c58, { roughness: .95, envMapIntensity: .12 });
    root.add(box(W2 + .9, .3, D2 + .9, std(0xa9ada3, { roughness: .9, envMapIntensity: .14 }), 0, .15, 0));
    /* 房身：正面（+z）单独一张带门头院名的贴图 */
    const bld = new T.Mesh(new T.BoxGeometry(W2, H2, D2),
      [wallSide, wallSide, wallTop, wallBottom, wallFront, wallSide]);
    bld.position.set(0, H2 / 2 + .3, 0);
    bld.castShadow = bld.receiveShadow = true;
    root.add(bld);
    /* 女儿墙 */
    const par = std(0xb3b8ad, { roughness: .85, envMapIntensity: .16 });
    root.add(box(W2 + .6, .5, .3, par, 0, roofY + .25, -D2 / 2));
    root.add(box(W2 + .6, .5, .3, par, 0, roofY + .25, D2 / 2));
    root.add(box(.3, .5, D2, par, -W2 / 2, roofY + .25, 0));
    root.add(box(.3, .5, D2, par, W2 / 2, roofY + .25, 0));
    /* 入口雨棚 + 雨棚立柱 + 台阶 */
    const aw = std(0xc3c8c2, { roughness: .8, envMapIntensity: .16 });
    root.add(box(5.4, .16, 2.0, aw, 0, H2 - .35, D2 / 2 + 1.0));
    root.add(box(.18, H2 - .5, .18, std(0xadb2ab, { roughness: .8 }), -2.5, (H2 - .5) / 2, D2 / 2 + 1.85));
    root.add(box(.18, H2 - .5, .18, std(0xadb2ab, { roughness: .8 }), 2.5, (H2 - .5) / 2, D2 / 2 + 1.85));
    root.add(box(5.0, .16, .5, std(0xaaafa6, { roughness: .9 }), 0, .38, D2 / 2 + .75));
    root.add(box(4.4, .16, .5, std(0xa4a9a0, { roughness: .9 }), 0, .22, D2 / 2 + 1.2));
    /* 北墙两台空调外机 */
    [[-8.5, 3.1], [7.5, 3.1]].forEach(function (p) {
      root.add(box(1.05, .78, .42, std(0xdfe4e2, { roughness: .6 }), p[0], p[1], -D2 / 2 - .24));
      root.add(box(.62, .05, .3, std(0x9aa5a6, { roughness: .5, metalness: .4 }), p[0], p[1] - .3, -D2 / 2 - .24));
    });
  }

  /* ---------------- 屋顶光伏阵列 ---------------- */
  function buildArray(glassMat, edgeMat) {
    const T = THREE_();
    const arrGroup = new T.Group();
    arrGroup.userData.key = 'array';              /* 点阵列可弹明细卡 */
    root.add(arrGroup);
    const railMat = new T.MeshStandardMaterial({ color: 0x9fb0b6, roughness: .42, metalness: .72, envMapIntensity: .6 });
    const legMat = std(0x8b9aa0, { roughness: .5, metalness: .6, envMapIntensity: .5 });
    const modGeo = new T.BoxGeometry(MW, MT, MD);
    const modMats = [edgeMat, edgeMat, glassMat, edgeMat, edgeMat, edgeMat];
    const railGeo = new T.BoxGeometry(rowW + .5, .06, .12);
    const legXs = [-(rowW / 2 - .5), -rowW / 6, rowW / 6, rowW / 2 - .5];
    const yMod = rowPlaneY(0);
    const yRailF = rowPlaneY(RAIL_Z) - RAIL_DROP, yRailR = rowPlaneY(-RAIL_Z) - RAIL_DROP;
    const hLegF = yRailF - .03 - roofY, hLegR = yRailR - .03 - roofY;
    const legGeoF = new T.BoxGeometry(.09, hLegF, .09), legGeoR = new T.BoxGeometry(.09, hLegR, .09);
    rowZs.forEach(function (rz) {
      const row = new T.Group();
      row.position.z = rz;
      for (let c = 0; c < COLS; c++) {
        const m = new T.Mesh(modGeo, modMats);
        m.position.set(-rowW / 2 + MW / 2 + c * (MW + .06), yMod, 0);
        m.rotation.x = TILT;
        m.castShadow = m.receiveShadow = true;
        row.add(m);
      }
      /* 两根通长导轨（顶面贴组件底面） */
      [[RAIL_Z, yRailF], [-RAIL_Z, yRailR]].forEach(function (r) {
        const rail = new T.Mesh(railGeo, railMat);
        rail.position.set(0, r[1], r[0]);
        rail.rotation.x = TILT;
        rail.castShadow = rail.receiveShadow = true;
        row.add(rail);
      });
      /* 竖撑：前后各 4 根，顶到导轨底面 */
      legXs.forEach(function (x) {
        const lf = new T.Mesh(legGeoF, legMat);
        lf.position.set(x, roofY + hLegF / 2, RAIL_Z);
        lf.castShadow = true;
        row.add(lf);
        const lr = new T.Mesh(legGeoR, legMat);
        lr.position.set(x, roofY + hLegR / 2, -RAIL_Z);
        lr.castShadow = true;
        row.add(lr);
      });
      arrGroup.add(row);
    });
    /* 检修走道（中间两排之间）+ 屋面线槽 */
    arrGroup.add(box(rowW + 1.2, .04, 1.5, std(0xadb2a9, { roughness: .9, envMapIntensity: .14 }), 0, roofY + .02, 0));
    const trayMat = std(0x9aa5a6, { roughness: .45, metalness: .6, envMapIntensity: .5 });
    arrGroup.add(box(rowW + 1.6, .05, .34, trayMat, 0, roofY + .30, 0));
    arrGroup.add(box(rowW + 1.6, .09, .05, trayMat, 0, roofY + .345, -.17));
    arrGroup.add(box(rowW + 1.6, .09, .05, trayMat, 0, roofY + .345, .17));
    /* 组串电缆：沿屋面从走道引到 4 排阵列的前导轨底面（走板下方，不碰组件） */
    const cableMat = std(0x22343c, { roughness: .6, metalness: .3 });
    [[-7, -2.55], [-2, -1.05], [3, 1.05], [8, 2.55]].forEach(function (d) {
      const zEnd = d[1] + RAIL_Z;
      const a = new T.Vector3(d[0], roofY + .16, 0);
      const b = new T.Vector3(d[0], rowPlaneY(RAIL_Z) - .085, zEnd);
      const mid = new T.Vector3(d[0], (a.y + b.y) / 2 + .04, zEnd / 2);
      const t = new T.Mesh(new T.TubeGeometry(new T.CatmullRomCurve3([a, mid, b]), 12, .022, 5, false), cableMat);
      t.castShadow = true;
      arrGroup.add(t);
    });
    addCard('array', 0, roofY + 5.6, 0);
  }

  /* ---------------- 设备：逆变器 / 通信模块 / 并网点 ---------------- */
  function buildEquipment() {
    const T = THREE_();
    const steel = std(0xc6ccce, { roughness: .45, metalness: .55, envMapIntensity: .6 });
    const dark = std(0x22333a, { roughness: .5, metalness: .5, envMapIntensity: .5 });
    const finMat = std(0xa7b1b3, { roughness: .4, metalness: .6, envMapIntensity: .5 });
    /* ---------- 逆变器（挂东墙，正面朝东） ---------- */
    const invG = new T.Group();
    invG.userData.key = 'inverter';               /* 点逆变器可弹明细卡 */
    invG.position.set(W2 / 2, 0, 1.2);
    invG.add(box(.07, 1.66, 1.28, std(0x8f9a9c, { roughness: .5, metalness: .5 }), .035, 2.18, 0));
    invG.add(box(.36, 1.5, 1.1, dark, .26, 2.18, 0));
    invG.add(box(.04, 1.56, 1.16, std(0xb9c2c4, { roughness: .4, metalness: .5 }), .44, 2.18, 0));
    for (let i = 0; i < 5; i++) invG.add(box(.03, 1.24, .1, finMat, .12 + i * .09, 2.18, -.575));   /* 背面散热齿 */
    invG.add(box(.03, .52, .62, std(0x0a1418, { roughness: .3, metalness: .4 }), .465, 2.46, 0));  /* 显示屏 */
    invG.add(box(.03, .16, .22, std(0xd9b23a, { roughness: .5 }), .465, 1.95, -.34));             /* 隔离开关 */
    invG.add(box(.02, .1, .4, std(0xd8dee0, { roughness: .6 }), .465, 1.8, .22));                 /* 铭牌 */
    root.add(invG);
    invLabelEl = label('逆变器 · SG100CX-P2-CN<i>-- kW</i><em>待机</em>', 'tag3d-gt', W2 / 2 + 1.7, 3.85, 1.2);
    addCard('inverter', W2 / 2 + 1.7, 2.9, 1.2);

    /* ---------- 通信模块（立杆） ---------- */
    root.add(cyl(.07, .09, 3.4, steel, W2 / 2 + 2.2, 1.7, -2.6, 10));
    root.add(box(.5, .56, .36, std(0xe8eef0, { roughness: .5, envMapIntensity: .5 }), W2 / 2 + 2.2, 3.05, -2.6));
    root.add(box(.52, .05, .38, std(0xc2ccce, { roughness: .5, metalness: .5 }), W2 / 2 + 2.2, 3.34, -2.6));
    root.add(cyl(.022, .022, .8, steel, W2 / 2 + 2.2, 3.76, -2.6, 6));
    label('通信模块 · EyeS4<em>数据回传阳光云</em>', 'tag3d-gt', W2 / 2 + 2.2, 4.45, -2.6);

    /* ---------- 并网点：计量箱 + 电杆 + 架空线 ---------- */
    const mx = -W2 / 2 - 1.6, mz = D2 / 2 - 2.0;
    const mg = new T.Group();
    mg.userData.key = 'grid';                     /* 点计量箱可弹明细卡 */
    mg.position.set(mx, 0, mz);
    mg.add(box(1.3, .22, 1.6, std(0x9a9f96, { roughness: .9 }), 0, .11, 0));
    mg.add(box(.5, 1.2, .9, std(0xd4d9d4, { roughness: .5, metalness: .3, envMapIntensity: .4 }), 0, .82, 0));
    mg.add(box(.52, .1, .94, std(0xb2b8b4, { roughness: .5, metalness: .4 }), 0, 1.44, 0));
    mg.add(box(.56, .86, .02, std(0xcfd6d2, { roughness: .45, metalness: .3 }), 0, .82, .46));           /* 箱门（朝南） */
    mg.add(box(.16, .1, .03, std(0x8f9a9c, { roughness: .5, metalness: .5 }), -.12, 1.0, .48));
    root.add(mg);
    const poleMat = std(0xb9c2c4, { roughness: .6, metalness: .3 });
    const px = mx - .6;
    const poles = [[px, 4.25, mz, 4.5], [-34, 4.05, mz + 1.2, 4.4], [-52, 3.85, mz + 2.4, 4.2]];
    poles.forEach(function (p) {
      root.add(cyl(.10, .13, p[3], poleMat, p[0], p[3] / 2, p[2], 10));
      root.add(box(.12, .1, 1.15, poleMat, p[0], p[1] - .12, p[2]));                    /* 横担 */
    });
    /* 引下线：电杆 → 计量箱箱顶 */
    const drop = new T.CatmullRomCurve3([
      new T.Vector3(px + .12, 3.6, mz + .1),
      new T.Vector3(mx + .1, 2.4, mz + .3),
      new T.Vector3(mx + .02, 1.5, mz + .02)
    ]);
    root.add(new T.Mesh(new T.TubeGeometry(drop, 12, .02, 5, false), std(0x2c3a40, { roughness: .7 })));
    /* 架空线：两跨三线（带弧垂），末端落在远端电杆横担上 */
    const wireMat = std(0x2c3a40, { roughness: .7, metalness: .2 });
    [[-.15, -.42], [-.15, 0], [-.15, .42]].forEach(function (o) {
      for (let i = 0; i < poles.length - 1; i++) {
        const a = new T.Vector3(poles[i][0], poles[i][1] + o[0], poles[i][2] + o[1]);
        const b = new T.Vector3(poles[i + 1][0], poles[i + 1][1] + o[0], poles[i + 1][2] + o[1]);
        const mid = new T.Vector3((a.x + b.x) / 2, (a.y + b.y) / 2 - .5, (a.z + b.z) / 2);
        root.add(new T.Mesh(new T.TubeGeometry(new T.CatmullRomCurve3([a, mid, b]), 14, .022, 5, false), wireMat));
      }
    });
    gridLabelEl = label('并网点<i>无输出</i><em>计量箱 · 关口表</em>', 'tag3d-gt', px - .2, 5.05, mz);
    addCard('grid', px - .2, 4.1, mz);
  }

  /* ---------------- 电流光纹 ---------------- */
  function addFlow(pts, kind, radius) {
    const curve = new THREE.CatmullRomCurve3(pts);
    const len = Math.max(1, curve.getLength());
    const seg = Math.max(16, Math.round(len * 3));
    const core = new THREE.Mesh(new THREE.TubeGeometry(curve, seg, radius || .05, 6, false),
      new THREE.MeshStandardMaterial({ color: 0x1b2b31, roughness: .55, metalness: .35 }));
    core.castShadow = true;
    root.add(core);
    const tubeMat = new THREE.MeshBasicMaterial({
      map: flowTexture(len), color: FLOWC.night.idle, transparent: true, opacity: .3,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    root.add(new THREE.Mesh(new THREE.TubeGeometry(curve, seg, (radius || .05) * 2.2, 8, false), tubeMat));
    flows.push({ map: tubeMat.map, tubeMat: tubeMat, kind: kind, on: false, speed: 0 });
  }

  /* ---------------- 主搭建 ---------------- */
  function build() {
    const T = THREE_();
    scene = new T.Scene();
    theme = document.documentElement.getAttribute('data-theme') === 'day' ? 'day' : 'night';

    /* 天空：渐变穹顶（背景交给穹顶，雾色取地平线色） */
    const skyP = SKY[theme] || SKY.night;
    skyDome = new T.Mesh(new T.SphereGeometry(210, 28, 18),
      new T.MeshBasicMaterial({ map: skyTexture(skyP), side: T.BackSide, depthWrite: false, fog: false }));
    skyDome.renderOrder = -1;
    scene.add(skyDome);
    scene.fog = new T.Fog(skyP.fog, 120, 340);

    camera = new T.PerspectiveCamera(46, 1, .1, 900);
    camera.position.set(28, 19, 36);

    renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = T.PCFSoftShadowMap;
    const host = document.getElementById('solar3d');
    host.appendChild(renderer.domElement);

    /* 标签渲染器：与 WebGL 共用同一台相机（HTML 浮标） */
    if (typeof T.CSS2DRenderer === 'function') {
      labelR = new T.CSS2DRenderer();
      labelR.domElement.style.position = 'absolute';
      labelR.domElement.style.top = '0';
      labelR.domElement.style.left = '0';
      labelR.domElement.style.pointerEvents = 'none';
      host.appendChild(labelR.domElement);
    }

    if (typeof T.OrbitControls === 'function') {
      controls = new T.OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true; controls.dampingFactor = .08;
      controls.minDistance = 14; controls.maxDistance = 110;
      controls.maxPolarAngle = 1.32;
      controls.target.set(0, 3, 0);
      controls.update();
    }
    bindPick();

    root = new T.Group();
    scene.add(root);

    hemi = new T.HemisphereLight(0xdff0ff, 0x76815f, .62);
    scene.add(hemi);
    sunLight = new T.DirectionalLight(0xfff2d0, 1.15);
    sunLight.position.set(34, 40, 22);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(2048, 2048);
    const sc = sunLight.shadow.camera;
    sc.left = -58; sc.right = 58; sc.top = 58; sc.bottom = -58; sc.near = 1; sc.far = 220;
    sunLight.shadow.bias = -0.0009;
    scene.add(sunLight);
    fillLight = new T.DirectionalLight(0xbfe0ff, .22);
    fillLight.position.set(-24, 14, -18);
    scene.add(fillLight);

    /* 场地 / 建筑 / 组件 / 设备 */
    buildSite();
    buildBuilding();
    const glassMat = new T.MeshStandardMaterial({
      map: panelTexture(), roughness: .16, metalness: .55,
      emissive: new T.Color(0x0a2b4a), emissiveIntensity: .22, envMapIntensity: .9
    });
    panelMats.push(glassMat);
    const edgeMat = new T.MeshStandardMaterial({ color: 0xa9b6ba, roughness: .42, metalness: .68, envMapIntensity: .6 });
    buildArray(glassMat, edgeMat);
    buildEquipment();

    /* ---------- 能量流 ---------- */
    /* 直流侧：屋面线槽 → 女儿墙套管 → 沿东墙下到逆变器顶 */
    addFlow([
      new T.Vector3(-rowW / 2 - .4, roofY + .40, 0),
      new T.Vector3(-4, roofY + .42, 0),
      new T.Vector3(9.5, roofY + .42, .1),
      new T.Vector3(W2 / 2 + .28, roofY + .42, .55),
      new T.Vector3(W2 / 2 + .34, roofY - .55, .9),
      new T.Vector3(W2 / 2 + .42, 3.35, 1.1),
      new T.Vector3(W2 / 2 + .42, 2.98, 1.2)
    ], 'dc', .055);
    /* 过墙套管（电缆从套管中间穿出女儿墙，避免穿模） */
    root.add(box(.7, .2, .2, std(0x9aa5a6, { roughness: .5, metalness: .5 }), W2 / 2 + .28, roofY + .42, .55));
    /* 交流侧：逆变器底部 → 沿东墙 / 南墙 → 并网计量箱 */
    addFlow([
      new T.Vector3(W2 / 2 + .42, 1.4, 1.2),
      new T.Vector3(W2 / 2 + .22, 1.05, 1.9),
      new T.Vector3(W2 / 2 + .2, 1.05, 7.0),
      new T.Vector3(W2 / 2 + .2, 1.05, D2 / 2 + .2),
      new T.Vector3(-13.6, 1.05, D2 / 2 + .2),
      new T.Vector3(-14.6, 1.05, 7.0),
      new T.Vector3(-14.6, 1.1, 6.0)
    ], 'ac', .06);

    /* ---------- 天气：太阳 / 月亮 / 云 / 降水 ---------- */
    sun = new T.Mesh(new T.SphereGeometry(3.2, 20, 20), new T.MeshBasicMaterial({ color: 0xffe9a8, fog: false }));
    sun.position.set(52, 46, 30);
    root.add(sun);
    const glowTex = tex(function (g, w, h) {
      const grd = g.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, w / 2);
      grd.addColorStop(0, 'rgba(255,246,214,.95)');
      grd.addColorStop(.32, 'rgba(255,228,150,.42)');
      grd.addColorStop(1, 'rgba(255,224,140,0)');
      g.fillStyle = grd; g.fillRect(0, 0, w, h);
    }, 128, 128);
    sunGlow = new T.Sprite(new T.SpriteMaterial({ map: glowTex, transparent: true, blending: T.AdditiveBlending, depthWrite: false, fog: false, opacity: .6 }));
    sunGlow.position.copy(sun.position);
    sunGlow.scale.set(26, 26, 1);
    root.add(sunGlow);
    moon = new T.Mesh(new T.SphereGeometry(1.9, 18, 18), new T.MeshBasicMaterial({ color: 0xdfe9f5, fog: false }));
    moon.position.set(-48, 42, 22);
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
      cg.position.set((Math.random() - .5) * 140, 42 + Math.random() * 16, (Math.random() - .5) * 120);
      cg.userData.speed = .35 + Math.random() * .5;
      cloudGroup.add(cg);
    }
    root.add(cloudGroup);

    precipGroup = new T.Group();
    const rainMat = new T.MeshBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: .55 });
    for (let i = 0; i < 420; i++) {
      const p = new T.Mesh(new T.CylinderGeometry(.022, .022, .9, 4), rainMat);
      p.position.set((Math.random() - .5) * 80, Math.random() * 30 + 2, (Math.random() - .5) * 70);
      precipGroup.add(p);
    }
    root.add(precipGroup);

    /* ---------- 场景浮标 ---------- */
    arrLabelEl = label('屋顶光伏阵列<i>-- kW</i><em>装机 110.16 kWp</em>', 'tag3d-gt', 0, roofY + 3.6, 0);
    label('洙边卫生院<i>屋顶分布式光伏</i>', 'tag3d-gt', 0, H2 + 1.8, D2 / 2 + 6.2);

    /* 后期处理：MSAA + 轻微泛光（只让日光、电流光纹这类高亮点发光） */
    if (typeof T.EffectComposer === 'function' && T.RenderPass && T.UnrealBloomPass) {
      try {
        const w = host.clientWidth || 800, h = host.clientHeight || 480;
        const msaa = (typeof T.WebGLMultisampleRenderTarget === 'function')
          ? new T.WebGLMultisampleRenderTarget(w, h, { format: T.RGBAFormat })
          : null;
        composer = new T.EffectComposer(renderer, msaa || undefined);
        if (msaa) composer.setPixelRatio(renderer.getPixelRatio());
        composer.addPass(new T.RenderPass(scene, camera));
        bloomPass = new T.UnrealBloomPass(new T.Vector2(w, h), .3, .8, .95);
        composer.addPass(bloomPass);
      } catch (e) { composer = null; }
    }

    refreshEnv();
    applyTheme();
    resize();
    inited = true;
    loop(0);
  }

  /* 天空反射：拿穹顶渐变当环境贴图，组件玻璃 / 金属件带天空高光 */
  function refreshEnv() {
    const T = THREE_();
    if (!renderer || typeof T.PMREMGenerator !== 'function' || !skyDome) return;
    try {
      const pmrem = new T.PMREMGenerator(renderer);
      const envTex = skyDome.material.map;
      envTex.mapping = T.EquirectangularReflectionMapping;
      const rt = pmrem.fromEquirectangular(envTex);
      if (envRT) envRT.dispose();
      envRT = rt;
      scene.environment = envRT.texture;
      pmrem.dispose();
    } catch (e) { scene.environment = null; }
  }

  /* ---------------- 主题（页面白天 / 夜晚） ---------------- */
  /* 光伏场景恒用"白天"观感：监控画面要看得清设备；
     页面主题只换天空色温 / 光照强度 / 电流光纹配色 */
  function applyTheme() {
    theme = document.documentElement.getAttribute('data-theme') === 'day' ? 'day' : 'night';
    const p = SKY[theme] || SKY.night;
    if (skyDome) {
      const old = skyDome.material.map;
      skyDome.material.map = skyTexture(p);
      skyDome.material.needsUpdate = true;
      if (old) old.dispose();
      refreshEnv();
    }
    /* 地坪网格跟着主题换色（夜里深底青线 / 白天浅底灰线） */
    const T = THREE_();
    if (groundMat) {
      const old = groundMat.map;
      const map = gridTexture();
      map.wrapS = map.wrapT = T.RepeatWrapping;
      map.repeat.set(10, 10);
      groundMat.map = map;
      groundMat.needsUpdate = true;
      if (old) old.dispose();
    }
    themeMats.forEach(function (r) {
      const v = r[theme] || {};
      if (v.color !== undefined && r.mat.color) r.mat.color.setHex(v.color);
      if (v.emissive !== undefined && r.mat.emissive) r.mat.emissive.setHex(v.emissive);
      if (v.emissiveIntensity !== undefined) r.mat.emissiveIntensity = v.emissiveIntensity;
      r.mat.needsUpdate = true;
    });
    if (scene && scene.fog) scene.fog.color.setHex(p.fog);
    refreshSkyLight();
  }

  /* ---------------- 天气 / 功率 ---------------- */
  function refreshSkyLight() {
    const cloud = Math.max(0, Math.min(100, Number(cur.cloud) || 0));
    const rad = Math.max(0, Number(cur.radiation) || 0);
    const day = !!cur.isDay;                      /* 真实昼夜：只决定太阳在不在 */
    const dim = 1 - cloud / 100 * .38;
    const dayT = theme === 'day';
    /* 白天主题的界面底色是浅色，光照总量压低一档，否则墙地会白成一片 */
    if (sunLight) sunLight.intensity = ((dayT ? .78 : .98) + (rad > 0 ? Math.min(1, rad / 950) * (dayT ? .3 : .45) : .1)) * dim;
    if (hemi) hemi.intensity = (dayT ? .38 : .5) * dim;
    if (fillLight) fillLight.intensity = dayT ? .12 : .18;
    if (sun) sun.visible = day;
    if (sunGlow) {
      sunGlow.visible = day;
      sunGlow.material.opacity = .55 * (1 - cloud / 160);
    }
    if (moon) moon.visible = false;
    const cf = cloud / 100;
    if (cloudGroup) {
      cloudGroup.children.forEach(function (cg) {
        cg.visible = cf > .08;
        cg.children.forEach(function (s) { s.material.opacity = 0.35 + cf * 0.6; });
      });
    }
    if (precipGroup) {
      precipGroup.visible = Number(cur.precip) > 0;
      precipGroup.children.forEach(function (p) { p.material.opacity = cf > .5 ? .6 : .45; });
    }
  }

  function setWeather(w) {
    if (!w) return;
    cur.cloud = w.cloud;
    cur.precip = w.precip;
    cur.isDay = w.is_day === 0 || w.is_day === '0' ? 0 : 1;
    cur.radiation = w.radiation;
    refreshSkyLight();
  }

  /* 发电功率：驱动组件发光、电流光纹流速、指示灯与浮标 */
  function setPower(kw, capKw, todayKwh) {
    cur.power = Number(kw) || 0;
    if (capKw) cur.cap = Number(capKw) || cur.cap;
    if (todayKwh !== undefined && todayKwh !== null) cur.today = Number(todayKwh);
    const ratio = Math.max(0, Math.min(1, cur.power / (cur.cap || 1)));
    const on = ratio > .005;
    const p = FLOWC[theme] || FLOWC.night;
    const day = theme === 'day';
    panelMats.forEach(function (m) {
      m.emissiveIntensity = (day ? .06 : .22) + ratio * (day ? .5 : .8);
      m.emissive.setHex(on ? (day ? 0x1c5f96 : 0x0f4f7a) : 0x0a2b4a);
    });
    flows.forEach(function (fl) {
      fl.on = on;
      fl.speed = .35 + ratio * 1.9;
      fl.tubeMat.color.setHex(fl.on ? (fl.kind === 'dc' ? p.dc : p.ac) : p.idle);
    });
    if (invLabelEl) invLabelEl.innerHTML = '逆变器 · SG100CX-P2-CN<i>' + cur.power.toFixed(2) + ' kW</i><em>' + (on ? '运行中' : '待机') + '</em>';
    if (arrLabelEl) arrLabelEl.innerHTML = '屋顶光伏阵列<i>' + cur.power.toFixed(2) + ' kW</i><em>今日 '
      + (cur.today === null ? '--' : cur.today.toFixed(1)) + ' 度 · 装机 ' + Number(cur.cap).toFixed(2) + ' kWp</em>';
    if (gridLabelEl) gridLabelEl.innerHTML = '并网点<i>' + (on ? '并网运行中' : '无输出') + '</i><em>计量箱 · 关口表</em>';
    /* 明细卡内容同样跟着实时值走 */
    const todayTxt = cur.today === null ? '--' : cur.today.toFixed(1) + ' 度';
    const hoursTxt = (cur.today === null || !cur.cap) ? '--' : (cur.today / cur.cap).toFixed(2) + ' h';
    setCard('array', '屋顶光伏阵列', [
      ['当前功率', cur.power.toFixed(2) + ' kW'],
      ['今日发电', todayTxt],
      ['装机容量', Number(cur.cap).toFixed(2) + ' kWp'],
      ['等效利用小时', hoursTxt],
      ['组件排布', '8 排 × 10 块 · 倾角 28°']
    ], on ? ('发电中 · 出力 ' + (ratio * 100).toFixed(0) + '%') : '当前无出力');
    setCard('inverter', '逆变器 · SG100CX-P2-CN', [
      ['有功功率', cur.power.toFixed(2) + ' kW'],
      ['运行状态', on ? '运行中（并网）' : '待机'],
      ['今日发电', todayTxt],
      ['安装位置', '卫生院东墙外侧'],
      ['接线', '屋顶组串 → 屋面线槽 → 逆变器']
    ], on ? '并网发电中' : '无输出');
    setCard('grid', '并网点 · 计量箱', [
      ['状态', on ? '并网运行中' : '无输出'],
      ['电站出力', cur.power.toFixed(2) + ' kW'],
      ['今日发电', todayTxt],
      ['并网方式', '低压并网 · 关口计量'],
      ['计量', '计量箱 · 关口表']
    ], on ? '实时并网' : '待机');
  }

  /* 点击设备 → 弹明细卡（拖拽旋转时不触发） */
  let ray = null, ndc = null;
  function pick(ev) {
    if (!ray) { ray = new THREE.Raycaster(); ndc = new THREE.Vector2(); }
    const r = renderer.domElement.getBoundingClientRect();
    ndc.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
    ndc.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects(root.children, true);
    for (let i = 0; i < hits.length; i++) {
      let o = hits[i].object;
      while (o && !o.userData.key) o = o.parent;
      if (o && o.userData.key) return o.userData.key;
    }
    return null;
  }
  function bindPick() {
    let dx = 0, dy = 0;
    renderer.domElement.addEventListener('pointerdown', function (e) { dx = e.clientX; dy = e.clientY; });
    renderer.domElement.addEventListener('pointerup', function (e) {
      if (Math.abs(e.clientX - dx) > 4 || Math.abs(e.clientY - dy) > 4) return;   /* 拖拽不算点击 */
      showCard(pick(e));
    });
  }

  /* 电流光纹沿电缆滚动（速度随发电功率，无输出时静止变暗） */
  function stepFlow(dt) {
    if (!flows.length || !dt) return;
    for (let i = 0; i < flows.length; i++) {
      const fl = flows[i];
      fl.tubeMat.opacity = fl.on ? .95 : .3;
      if (fl.on) fl.map.offset.x -= fl.speed * dt * .35;
    }
  }

  /* ---------------- 主循环 ---------------- */
  function loop(t) {
    raf = requestAnimationFrame(loop);
    const dt = clock.last ? Math.min(.08, (t - clock.last) / 1000) : 0;
    clock.last = t;
    if (!active) return;
    if (cloudGroup) {
      cloudGroup.children.forEach(function (cg) {
        cg.position.x += cg.userData.speed * dt * 6;
        if (cg.position.x > 78) cg.position.x = -78;
      });
    }
    if (precipGroup && precipGroup.visible) {
      precipGroup.children.forEach(function (p) {
        p.position.y -= (2.4 + (p.position.y % 2)) * dt * 3.6;
        if (p.position.y < 0) p.position.y = 30;
      });
    }
    stepFlow(dt);
    if (controls) controls.update();
    if (composer) composer.render(); else renderer.render(scene, camera);
    if (labelR) labelR.render(scene, camera);
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
    if (composer) composer.setSize(w, h);
    if (bloomPass) bloomPass.setSize(w, h);
  }

  /* ---------------- 对外 ---------------- */
  let active = true, labelsOn = true, autoRot = false;

  function setActive(on) { active = !!on; }
  function setLabels(on) {
    labelsOn = !!on;
    applyLabelVisibility();
  }
  function setRotate(on) {
    autoRot = !!on;
    if (controls) { controls.autoRotate = autoRot; controls.autoRotateSpeed = .8; }
  }
  function resetView() {
    if (!camera || !controls) return;
    camera.position.set(28, 19, 36);
    controls.target.set(0, 3, 0);
    controls.update();
  }

  function init(onReady) {
    if (inited) { resize(); return; }
    if (typeof THREE === 'undefined') { setTimeout(function () { init(onReady); }, 300); return; }
    try { build(); } catch (e) { console.error('光伏 3D 场景初始化失败', e); return; }
    window.addEventListener('resize', resize);
    new MutationObserver(function () { applyTheme(); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    if (onReady) onReady();
  }

  return { init, resize, setWeather, setPower, applyTheme, setActive, setLabels, setRotate, resetView };
})();
