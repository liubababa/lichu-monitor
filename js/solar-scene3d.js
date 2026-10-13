/* ============================================================
 * 洙边卫生院站 · 光储一体三维场景
 *
 *   两层小楼（白主墙 + 灰腰线 + 大窗，夜里窗户发光）+ 屋顶光伏阵列
 *   （8 排 × 10 块组件级建模：玻璃 / 铝边框 / 导轨 / 竖撑 + 检修走道 + 屋面线槽）
 *   + 墙挂逆变器 + 通信模块 + 储能柜（光储一体柜：柜门、顶部空调、侧面 SOC 光柱）
 *   + 并网点（计量箱 / 电杆 / 瓷瓶 / 架空线）。
 *
 *   电流光纹分四条链路，方向跟着真实运行状态走：
 *     · 直流（青）  屋面组串 → 线槽 → 逆变器
 *     · 交流（橙）  逆变器 → 沿墙 → 并网计量箱
 *     · 储能（青绿=放电 / 蓝=充电） 计量箱 ↔ 储能柜
 *     · 关口（橙=馈电上网 / 蓝=从电网取） 计量箱 → 电杆 → 架空线
 *
 *   天气（SolarScene.setWeather）驱动画面：
 *     云量 → 天空/光照亮度、云朵多少；降水 → 雨/雪粒子；
 *     辐照度 → 光照强度、组件反光强度；昼夜（is_day）→ 太阳 / 月亮
 *   光伏功率（SolarScene.setPower）驱动：组件发光、直流/交流光纹流速、浮标
 *   储能数据（SolarScene.setStorage）驱动：柜体 SOC 光柱、指示灯、充放电与买卖电方向
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
  const labelPairs = [];            // { obj, el } 供按相机距离缩放浮标
  const cards = {};                 // 设备明细卡：key -> .card3d 元素
  let activeCard = null;
  const clock = { last: 0 };
  let cur = { power: 0, cap: 110.16, today: null, cloud: 0, precip: 0, isDay: 1, radiation: 0, storPower: null, storSoc: null, loadKw: null };
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

  /* ---------------- 基础工具 ---------------- */
  let groundMat = null, slabYardMat = null;
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
    labelPairs.push({ obj: o, el: el });       /* 供按距离缩放用 */
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
  /* 组件面板：近黑的深蓝电池片 + 细栅线 + 银色铝边框 + 很淡的斜向反光
     （板子要黑/深蓝才像真组件，太亮太蓝反而假） */
  function panelTexture() {
    return tex(function (g, w, h) {
      g.fillStyle = '#07182c'; g.fillRect(0, 0, w, h);
      const bx = 8, by = 8, bw = w - 16, bh = h - 16;
      const cw = bw / 10, ch = bh / 6;
      for (let r = 0; r < 6; r++) {
        for (let c = 0; c < 10; c++) {
          const x = bx + c * cw, y = by + r * ch;
          g.fillStyle = (r + c) % 2 ? '#0a2240' : '#0c2947';
          g.fillRect(x + 1.2, y + 1.2, cw - 2.4, ch - 2.4);
          g.strokeStyle = 'rgba(170,205,235,.20)';
          g.lineWidth = .8;
          g.beginPath(); g.moveTo(x + cw / 3, y + 2); g.lineTo(x + cw / 3, y + ch - 2); g.stroke();
          g.beginPath(); g.moveTo(x + cw * 2 / 3, y + 2); g.lineTo(x + cw * 2 / 3, y + ch - 2); g.stroke();
        }
      }
      const lg = g.createLinearGradient(0, 0, w, h);
      lg.addColorStop(0, 'rgba(190,225,255,.10)');
      lg.addColorStop(.42, 'rgba(190,225,255,.03)');
      lg.addColorStop(.58, 'rgba(255,255,255,0)');
      lg.addColorStop(1, 'rgba(255,255,255,.03)');
      g.fillStyle = lg; g.fillRect(0, 0, w, h);
      g.strokeStyle = '#c3ced4'; g.lineWidth = 9;
      g.strokeRect(4.5, 4.5, w - 9, h - 9);
      g.strokeStyle = 'rgba(20,40,60,.5)'; g.lineWidth = 2;
      g.strokeRect(11, 11, w - 22, h - 22);
    }, 320, 160, 2);
  }

  /* 卫生院外墙：白色墙板 + 分缝（两层小楼沿用莒南厂房的观感：白主墙 + 灰带 + 大窗）。
     窗、门单独做几何体，这样夜里窗户能发光、近景经得起看 */
  function wallTexture() {
    return tex(function (g, w, h) {
      g.fillStyle = '#dfe3e3'; g.fillRect(0, 0, w, h);
      g.strokeStyle = 'rgba(120,138,140,.22)'; g.lineWidth = 2;
      for (let i = 1; i < 12; i++) { const x = i * w / 12; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
      g.fillStyle = 'rgba(120,138,140,.10)'; g.fillRect(0, 0, w, 10);
      g.fillStyle = '#adb2a8'; g.fillRect(0, h - 26, w, 26);          /* 勒脚 */
    }, 512, 256);
  }
  /* 门头院名牌（单独一块板贴在大门上方） */
  function namePlateTexture() {
    return tex(function (g, w, h) {
      g.fillStyle = '#eef4f2'; g.fillRect(0, 0, w, h);
      g.strokeStyle = '#9fb0b4'; g.lineWidth = 4; g.strokeRect(3, 3, w - 6, h - 6);
      g.fillStyle = '#1d6ab0';
      g.font = 'bold 46px "Microsoft YaHei", sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('洙边卫生院', w / 2 - 26, h / 2 + 2);
      g.fillStyle = '#d33a2c';                                       /* 红十字 */
      g.fillRect(w / 2 + 108, h / 2 - 24, 14, 48);
      g.fillRect(w / 2 + 88, h / 2 - 7, 54, 14);
    }, 512, 128, 2);
  }

  /* 水泥地坪（按白天新设计的 Demo 改：原来是发光网格地台，现在铺成真水泥地）
     细砂眼 + 少量小色差 + 抹痕：远看近看都像水泥，不是一块平色板 */
  function concreteTexture() {
    const day = theme === 'day';
    const tx = tex(function (g, w, h) {
      g.fillStyle = day ? '#c2c5bd' : '#30383d'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 9000; i++) {
        const darkk = Math.random() > .5;
        g.fillStyle = darkk
          ? (day ? 'rgba(70,74,70,' + (.02 + Math.random() * .06) + ')' : 'rgba(0,0,0,' + (.03 + Math.random() * .08) + ')')
          : (day ? 'rgba(255,255,255,' + (.02 + Math.random() * .05) + ')' : 'rgba(255,255,255,' + (.015 + Math.random() * .04) + ')');
        const s = Math.random() < .85 ? 1 : 2;
        g.fillRect(Math.random() * w, Math.random() * h, s, s);
      }
      for (let i = 0; i < 26; i++) {
        g.fillStyle = day
          ? (Math.random() > .5 ? 'rgba(90,96,92,.05)' : 'rgba(255,255,255,.05)')
          : (Math.random() > .5 ? 'rgba(0,0,0,.07)' : 'rgba(255,255,255,.03)');
        g.beginPath();
        g.ellipse(Math.random() * w, Math.random() * h, 4 + Math.random() * 12, 3 + Math.random() * 8, Math.random() * 3, 0, 6.3);
        g.fill();
      }
      for (let i = 0; i < 7; i++) {
        g.strokeStyle = day ? 'rgba(255,255,255,.05)' : 'rgba(255,255,255,.025)';
        g.lineWidth = 1;
        const yy = Math.random() * h;
        g.beginPath(); g.moveTo(0, yy); g.lineTo(w, yy + (Math.random() - .5) * 10); g.stroke();
      }
    }, 512, 512);
    tx.wrapS = tx.wrapT = THREE.RepeatWrapping;
    if (renderer && renderer.capabilities) tx.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return tx;
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
  const W2 = 26, H2 = 6.6, D2 = 16;              /* 卫生院：宽 × 高（两层小楼）× 深 */
  const FLOOR_Y = 3.3;                           /* 二层楼面标高（相对勒脚顶） */
  const roofY = H2 + .3;                         /* 屋面标高（含 0.3 勒脚台） */
  /* 储能柜：光储一体柜，摆在楼西侧场坪上，柜门朝东（对着楼与默认机位） */
  const CAB_X = -17.6, CAB_Z = .6, CAB_W = 2.7, CAB_H = 2.6, CAB_D = 1.7;
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
    /* 地坪：整片水泥地，铺到 700 见方，远边交给雾，任何角度都看不到地边 */
    groundMat = new T.MeshStandardMaterial({ map: concreteTexture(), roughness: .96, metalness: .02 });
    groundMat.map.repeat.set(47, 47);
    const ground = new T.Mesh(new T.PlaneGeometry(700, 700), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    root.add(ground);
    /* 场坪：和地面同材质的水泥台（原来是深色小台座 + 发光包边，四周露边像模型底座）；
       放大到 96×58，边缘落在雾外，看不到"台边" */
    slabYardMat = new T.MeshStandardMaterial({ map: concreteTexture(), roughness: .93, metalness: .02 });
    slabYardMat.map.repeat.set(31, 16);
    root.add(box(96, .18, 58, slabYardMat, 0, .09, 0));
  }

  /* ---------------- 卫生院建筑（两层小楼：白主墙 + 灰腰线 + 大窗，沿用莒南厂房那套语言） ---------------- */
  let winMat = null;
  const WIN_GLOW = .5;                 /* 夜里窗内暖光的基准亮度（原来 .8 偏亮、过曝） */
  function buildBuilding() {
    const T = THREE_();
    const wallMat = new T.MeshStandardMaterial({ map: wallTexture(), roughness: .78, metalness: .1, envMapIntensity: .16 });
    const wallTop = std(0xbcc0b7, { roughness: .92, envMapIntensity: .14 });
    const wallBottom = std(0x545c58, { roughness: .95, envMapIntensity: .12 });
    const trimMat = std(0x8d9598, { roughness: .62, metalness: .3 });     /* 灰带 / 窗框 */
    const bandMat = std(0x232a2d, { roughness: .5, metalness: .35 });     /* 窗带底 */
    root.add(box(W2 + .9, .3, D2 + .9, std(0xa9ada3, { roughness: .9, envMapIntensity: .14 }), 0, .15, 0));
    /* 房身（两层一起） */
    const bld = new T.Mesh(new T.BoxGeometry(W2, H2, D2), [wallMat, wallMat, wallTop, wallBottom, wallMat, wallMat]);
    bld.position.set(0, H2 / 2 + .3, 0);
    bld.castShadow = bld.receiveShadow = true;
    root.add(bld);
    root.add(box(W2 + .2, .55, D2 + .2, bandMat, 0, .58, 0));              /* 深色基座带 */
    /* 楼层腰线（一圈） */
    [-1, 1].forEach(function (sz) { root.add(box(W2 + .24, .16, .18, trimMat, 0, FLOOR_Y + .3, sz * (D2 / 2 + .05))); });
    [-1, 1].forEach(function (sx) { root.add(box(.18, .16, D2 + .24, trimMat, sx * (W2 / 2 + .05), FLOOR_Y + .3, 0)); });
    /* 女儿墙 */
    const par = std(0xb3b8ad, { roughness: .85, envMapIntensity: .16 });
    root.add(box(W2 + .6, .5, .3, par, 0, roofY + .25, -D2 / 2));
    root.add(box(W2 + .6, .5, .3, par, 0, roofY + .25, D2 / 2));
    root.add(box(.3, .5, D2, par, -W2 / 2, roofY + .25, 0));
    root.add(box(.3, .5, D2, par, W2 / 2, roofY + .25, 0));

    /* 窗户贴图（改进版）：窗框 + 窗格 + 暖色室内。
       同一张贴图既当 map 也当 emissiveMap —— 发光时透出的是格子里的暖光，
       不再是一整块死白的洞（白天把发光压到 0.16，夜里 0.5） */
    const winPaneTex = tex(function (g, w, h) {
      g.fillStyle = '#3a2f22'; g.fillRect(0, 0, w, h);
      const m = 4, cw = (w - m * 2) / 2, ch = (h - m * 2) / 3;      /* 2 列 × 3 行玻璃格 */
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 2; c++) {
          const x = m + c * cw, y = m + r * ch;
          const grd = g.createLinearGradient(0, y, 0, y + ch);
          grd.addColorStop(0, '#fff2d8');
          grd.addColorStop(.55, '#f6d9a4');
          grd.addColorStop(1, '#c9a271');
          g.fillStyle = grd;
          g.fillRect(x + 1.5, y + 1.5, cw - 3, ch - 3);
        }
      }
      g.fillStyle = 'rgba(30,24,18,.55)';                           /* 中梃 / 横档压深，格子才立得起来 */
      g.fillRect(w / 2 - 2, 0, 4, h);
      for (let r = 1; r < 3; r++) g.fillRect(0, m + r * ch - 2, w, 4);
    }, 64, 96, 2);
    winMat = new T.MeshStandardMaterial({
      map: winPaneTex, emissiveMap: winPaneTex,
      color: 0x20262a, roughness: .35, metalness: .2,
      emissive: new T.Color(0xffe2bd), emissiveIntensity: WIN_GLOW
    });
    /* 一整层的大窗带：深色窗带里嵌 n 扇玻璃，中间用竖挺分开 */
    const bandH = 1.75, bandD = .24, winY = FLOOR_Y + .3 + 1.5;
    function winBand(alongX, len, n, cx, cz, ww) {
      const inner = len - .7, wwv = ww || 1.6;
      if (alongX) root.add(box(len, bandH, bandD, bandMat, cx, winY, cz));
      else root.add(box(bandD, bandH, len, bandMat, cx, winY, cz));
      for (let i = 0; i < n; i++) {
        const off = -inner / 2 + (i + .5) * (inner / n);
        const px = alongX ? cx + off : cx, pz = alongX ? cz : cz + off;
        root.add(box(alongX ? wwv : bandD + .08, bandH - .46, alongX ? bandD + .08 : wwv, winMat, px, winY, pz));
        if (i < n - 1) {
          const mx = alongX ? cx + off + inner / (n * 2) : cx, mz = alongX ? cz : cz + off + inner / (n * 2);
          root.add(box(alongX ? .1 : bandD + .12, bandH, alongX ? bandD + .12 : .1, trimMat, mx, winY, mz));
        }
      }
    }
    [-1, 1].forEach(function (sz) { winBand(true, W2 - .4, 5, 0, sz * (D2 / 2 + .04)); });      /* 南北两面各 5 扇 */
    [-1, 1].forEach(function (sx) { winBand(false, D2 - .4, 3, sx * (W2 / 2 + .04), 0, 2.4); }); /* 东西两面各 3 扇 */
    /* 一层：侧面各两扇窗，正面留给大门 */
    [-1, 1].forEach(function (sx) {
      [-3.2, 3.2].forEach(function (oz) {
        root.add(box(.24, 1.5, 2.0, bandMat, sx * (W2 / 2 + .04), 1.85, oz));
        root.add(box(.2, 1.1, 1.7, winMat, sx * (W2 / 2 + .07), 1.85, oz));
      });
    });
    /* 正面大门：门套 + 双开门 + 雨棚 + 台阶 + 院名牌 */
    const dz = D2 / 2;
    root.add(box(3.4, 2.9, .24, std(0xcfd6d2, { roughness: .7, envMapIntensity: .16 }), 0, 1.75, dz + .04));
    const doorMat = std(0x31505c, { roughness: .45, metalness: .35, envMapIntensity: .4 });
    root.add(box(1.42, 2.5, .1, doorMat, -.74, 1.55, dz + .14));
    root.add(box(1.42, 2.5, .1, doorMat, .74, 1.55, dz + .14));
    root.add(box(.05, 2.5, .12, std(0xbfc9cb, { roughness: .4, metalness: .5 }), 0, 1.55, dz + .16));
    root.add(box(2.2, .22, .1, std(0xbcd6dd, { roughness: .3, metalness: .3 }), 0, 2.62, dz + .16));   /* 门头玻璃 */
    const plate = new T.Mesh(new T.PlaneGeometry(3.6, .9),
      new T.MeshBasicMaterial({ map: namePlateTexture(), transparent: true }));
    plate.position.set(0, 3.9, dz + .16);
    root.add(plate);
    const aw = std(0xc3c8c2, { roughness: .8, envMapIntensity: .16 });
    root.add(box(5.4, .16, 2.0, aw, 0, H2 - .35, dz + 1.0));
    root.add(box(.18, H2 - .5, .18, std(0xadb2ab, { roughness: .8 }), -2.5, (H2 - .5) / 2, dz + 1.85));
    root.add(box(.18, H2 - .5, .18, std(0xadb2ab, { roughness: .8 }), 2.5, (H2 - .5) / 2, dz + 1.85));
    root.add(box(5.0, .16, .5, std(0xaaafa6, { roughness: .9 }), 0, .38, dz + .75));
    root.add(box(4.4, .16, .5, std(0xa4a9a0, { roughness: .9 }), 0, .22, dz + 1.2));
    /* 北墙两台空调外机 */
    [[-8.5, 3.1], [7.5, 3.1]].forEach(function (p) {
      root.add(box(1.05, .78, .42, std(0xdfe4e2, { roughness: .6 }), p[0], p[1] + 2.4, -D2 / 2 - .24));
      root.add(box(.62, .05, .3, std(0x9aa5a6, { roughness: .5, metalness: .4 }), p[0], p[1] + 2.1, -D2 / 2 - .24));
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

  /* ---------------- 储能柜（光储一体柜：柜体 + 顶部空调 + 侧面 SOC 光柱） ---------------- */
  function cabFrontTexture() {
    return tex(function (g, w, h) {
      g.fillStyle = '#e9edee'; g.fillRect(0, 0, w, h);
      g.strokeStyle = 'rgba(96,116,120,.45)'; g.lineWidth = 3; g.strokeRect(8, 8, w - 16, h - 16);
      g.fillStyle = 'rgba(206,216,218,.95)'; g.fillRect(16, 16, w - 32, 54);            /* 顶部空调段 */
      g.strokeStyle = 'rgba(96,116,120,.35)'; g.strokeRect(16, 16, w - 32, 54);
      for (let i = 0; i < 5; i++) { g.fillStyle = 'rgba(96,116,120,.25)'; g.fillRect(26, 25 + i * 9, w - 52, 3); }
      g.strokeStyle = 'rgba(70,96,100,.5)'; g.lineWidth = 4;
      g.beginPath(); g.moveTo(w / 2, 84); g.lineTo(w / 2, h - 20); g.stroke();          /* 门缝 */
      g.lineWidth = 2; g.strokeStyle = 'rgba(96,116,120,.3)';
      g.strokeRect(20, 90, w / 2 - 30, h - 122); g.strokeRect(w / 2 + 10, 90, w / 2 - 30, h - 122);
      g.fillStyle = 'rgba(52,86,88,.55)'; g.fillRect(w / 2 - 20, h / 2 - 12, 6, 36); g.fillRect(w / 2 + 14, h / 2 - 12, 6, 36);
      g.fillStyle = 'rgba(16,160,138,.5)'; g.fillRect(24, h - 36, 74, 11);              /* 铭牌 */
      g.fillStyle = 'rgba(224,148,16,.6)'; g.fillRect(w - 98, h - 36, 74, 11);          /* 警示条 */
    }, 256, 320, 2);
  }
  function cabSideTexture() {
    return tex(function (g, w, h) {
      g.fillStyle = '#e2e7e8'; g.fillRect(0, 0, w, h);
      g.strokeStyle = 'rgba(96,116,120,.22)'; g.lineWidth = 2;
      for (let i = 1; i < 4; i++) { const x = i * w / 4; g.beginPath(); g.moveTo(x, 6); g.lineTo(x, h - 6); g.stroke(); }
      g.strokeStyle = 'rgba(96,116,120,.3)'; g.strokeRect(6, 6, w - 12, h - 12);
      for (let i = 0; i < 9; i++) { g.fillStyle = 'rgba(96,116,120,.28)'; g.fillRect(18, h - 72 + i * 7, w - 36, 3); }
    }, 256, 320, 2);
  }
  let cabLabelEl = null, cabSocBars = [], cabLed = null, cabGlow = null;
  function buildStorageCabinet() {
    const T = THREE_();
    const g = new T.Group();
    g.userData.key = 'storage';
    g.position.set(CAB_X, 0, CAB_Z);
    g.rotation.y = Math.PI / 2;                    /* 柜门朝东，正对楼与默认机位 */
    const W = CAB_W, H = CAB_H, D = CAB_D;
    const steel = std(0xc6ccce, { roughness: .45, metalness: .55, envMapIntensity: .6 });
    const dark = std(0x22333a, { roughness: .5, metalness: .5, envMapIntensity: .5 });
    const front = new T.MeshStandardMaterial({ map: cabFrontTexture(), roughness: .5, metalness: .35, envMapIntensity: .4 });
    const side = new T.MeshStandardMaterial({ map: cabSideTexture(), roughness: .55, metalness: .35, envMapIntensity: .4 });
    const topMat = std(0xd6dbdc, { roughness: .6, metalness: .3 });
    g.add(box(W + .24, .18, D + .24, dark, 0, .09, 0));                                /* 底座 */
    const body = new T.Mesh(new T.BoxGeometry(W, H, D), [side, side, topMat, side, front, side]);
    body.position.y = H / 2 + .18;
    body.castShadow = body.receiveShadow = true;
    g.add(body);
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (c) {                        /* 四角立柱 */
      g.add(box(.1, H + .04, .1, steel, c[0] * (W / 2 - .02), H / 2 + .18, c[1] * (D / 2 - .02)));
    });
    g.add(box(W * .74, .32, D * .78, std(0xdfe4e2, { roughness: .6 }), 0, H + .36, 0));  /* 顶部空调 */
    for (let k = 0; k < 4; k++) g.add(box(W * .6, .04, .07, steel, 0, H + .52, -.22 + k * .15));
    /* 侧面 SOC 光柱：两侧各一条，从下往上长 */
    cabSocBars = [];
    const colH = H * .62, base = .18 + H * .5 - colH / 2;
    [-1, 1].forEach(function (sgn) {
      g.add(box(.06, colH + .1, .32, dark, sgn * (W / 2 + .04), .18 + H * .5, D * .2));
      const geo = new T.BoxGeometry(.05, colH, .26); geo.translate(0, colH / 2, 0);
      const bar = new T.Mesh(geo, new T.MeshBasicMaterial({ color: 0x6f9a94 }));
      bar.position.set(sgn * (W / 2 + .07), base, D * .2);
      g.add(bar);
      cabSocBars.push(bar);
    });
    g.add(box(.22, .13, .04, dark, W / 2 - .5, .18 + H * .86, D / 2 + .03));            /* 指示灯底座 */
    cabLed = new T.Mesh(new T.BoxGeometry(.16, .09, .05), new T.MeshBasicMaterial({ color: 0x6f9a94 }));
    cabLed.position.set(W / 2 - .5, .18 + H * .86, D / 2 + .055);
    g.add(cabLed);
    cabGlow = new T.Mesh(new T.PlaneGeometry(W * 1.7, D * 1.9),
      new T.MeshBasicMaterial({ color: 0x2ee6c8, transparent: true, opacity: .06, blending: T.AdditiveBlending, depthWrite: false }));
    cabGlow.rotation.x = -Math.PI / 2;
    cabGlow.position.y = .22;
    g.add(cabGlow);
    root.add(g);
    cabLabelEl = label('储能柜 · 光储一体<i>-- kW</i><em>--</em>', 'tag3d-gt', CAB_X, CAB_H + 3.9, CAB_Z);
    addCard('storage', CAB_X, CAB_H + 1.2, CAB_Z);
  }

  /* ---------------- 并网铁塔（国网风格格构塔：收腰塔身 + 三层横担 + 绝缘子串 + 架空线）
     本站储能要往电网卖电，线路上立一座塔比排几根电杆更像回事。塔身沿 y 轴，
     横担沿 z，导线沿 x（西向出线），整塔绕 y 转 90° 让导线与本场景的东西向一致。 ---------------- */
  const TWR_X = -31, TWR_Z = 7.0, TWR_H = 10.4;
  let twrLabelEl = null, twrArms = [];
  function buildTower() {
    const T = THREE_();
    const g = new T.Group();
    g.position.set(TWR_X, 0, TWR_Z);
    g.rotation.y = Math.PI / 2;                    /* 导线走向 → 沿 x */
    const hgt = TWR_H;
    const legMat = regThemeMat(std(0x6d8b93, { roughness: .55, metalness: .6 }), { color: 0x6d8b93 }, { color: 0x93a3a8 });
    const braceMat = regThemeMat(std(0x54737b, { roughness: .62, metalness: .55 }), { color: 0x54737b }, { color: 0x7d8f94 });
    const armMat = regThemeMat(std(0x2ee6c8, { emissive: 0x0a5a4a, emissiveIntensity: .35, roughness: .5, metalness: .3 }),
      { color: 0x2ee6c8, emissive: 0x0a5a4a, emissiveIntensity: .35 },
      { color: 0x18b39a, emissive: 0x000000, emissiveIntensity: 0 });
    const insMat = std(0xd8e6e4, { roughness: .35, metalness: .1 });
    const condMat = regThemeMat(new T.LineBasicMaterial({ color: 0x2ee6c8, transparent: true, opacity: .32 }),
      { color: 0x2ee6c8 }, { color: 0x0d8f7a });
    /* 塔身半宽：底部宽 → 腰部收窄 → 上部略开 */
    const halfAt = function (y) {
      const t = Math.max(0, Math.min(1, y / hgt));
      const base = 1.5, waist = .62, top = .84;
      return t < .6 ? base + (waist - base) * (t / .6) : waist + (top - waist) * ((t - .6) / .4);
    };
    const P = function (x, y, z) { return new T.Vector3(x * halfAt(y), y, z * halfAt(y)); };
    const member = function (a, b, mat, r) {
      const len = a.distanceTo(b);
      if (len < .03) return;
      const m = new T.Mesh(new T.CylinderGeometry(r || .04, r || .04, len, 5), mat || legMat);
      m.position.copy(a).lerp(b, .5);
      m.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      m.castShadow = true;
      g.add(m);
    };
    const lv = 11;
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (c) {                        /* 四条主腿 + 基础 */
      for (let i = 0; i < lv; i++) {
        member(P(c[0], hgt * i / lv, c[1]), P(c[0], hgt * (i + 1) / lv, c[1]), legMat, .045);
      }
      const bx = c[0] * halfAt(0), bz = c[1] * halfAt(0);
      g.add(box(.66, .4, .66, std(0x2a3a3d, { roughness: .95, metalness: .05 }), bx, .2, bz));
      g.add(box(.36, .28, .36, std(0x3a4c50, { roughness: .9 }), bx, .54, bz));
    });
    for (let i = 0; i < 19; i++) {                                                     /* 爬梯 */
      const y = .75 + i * .5, w = halfAt(y);
      g.add(box(.26, .03, .03, braceMat, -w + .12, y, -w - .07));
    }
    for (let i = 1; i <= lv; i++) {                                                    /* 横撑 + 交叉斜撑 */
      const y = hgt * i / lv, w = halfAt(y);
      g.add(box(w * 2, .04, .04, braceMat, 0, y, -w));
      g.add(box(w * 2, .04, .04, braceMat, 0, y, w));
      g.add(box(.04, .04, w * 2, braceMat, -w, y, 0));
      g.add(box(.04, .04, w * 2, braceMat, w, y, 0));
      if (i < lv) {
        const yn = hgt * (i + 1) / lv, wn = halfAt(yn);
        [[-1, 0], [1, 0], [0, -1], [0, 1]].forEach(function (f) {
          const ax = f[0] * w, az = f[1] * w, bx2 = f[0] * wn, bz2 = f[1] * wn;
          member(new T.Vector3(ax, y, az), new T.Vector3(bx2, yn, bz2), braceMat, .02);
          member(new T.Vector3(ax, y, az), new T.Vector3(f[0] ? ax : bx2, yn, f[1] ? az : bz2), braceMat, .02);
        });
      }
    }
    /* 三层横担（每层左右各一挑），端部下挂绝缘子串，导线沿线路方向（本塔即 x）穿越 */
    const ARMS = [[6.6, 3.0], [7.8, 2.7], [9.0, 2.4]];
    twrArms = [];
    ARMS.forEach(function (a, ai) {
      const y = a[0], len = a[1], w = halfAt(y);
      [-1, 1].forEach(function (s) {
        const inn = new T.Vector3(s * w, y, 0);
        const tip = new T.Vector3(s * (w + len), y, 0);
        member(inn, tip, armMat, .055);
        member(inn.clone().setY(y - .22), tip.clone().setY(y - .3), braceMat, .022);
        const ins = new T.Group();
        ins.position.copy(tip);
        for (let k = 0; k < 5; k++) {
          const disc = new T.Mesh(new T.CylinderGeometry(.11, .11, .045, 8), insMat);
          disc.position.y = -.12 - k * .08;
          disc.castShadow = true;
          ins.add(disc);
        }
        g.add(ins);
        const wy = tip.y - .55, wx = tip.x;
        const pts = [];
        for (let k = 0; k <= 24; k++) {                                                /* 导线带垂弧，穿过塔位向西出线 */
          const z = -20 + (k / 24) * 40;
          const sag = Math.sin(Math.min(1, Math.abs(z) / 20) * Math.PI / 2) * .95;
          pts.push(new T.Vector3(wx, wy - sag, z));
        }
        g.add(new T.Line(new T.BufferGeometry().setFromPoints(pts), condMat));
        /* 记录挂点（世界坐标）：给"电杆 → 铁塔"那三跨导线用 */
        g.updateMatrixWorld(true);
        twrArms.push({ v: tip.clone().applyMatrix4(g.matrixWorld), s: s, ai: ai });
      });
    });
    /* 塔顶地线支架 + 地线 */
    const tw = halfAt(hgt);
    member(new T.Vector3(-tw, hgt, 0), new T.Vector3(0, hgt + .9, 0), legMat, .04);
    member(new T.Vector3(tw, hgt, 0), new T.Vector3(0, hgt + .9, 0), legMat, .04);
    g.add(box(tw * 2.6, .06, .06, braceMat, 0, hgt + .55, 0));
    const gpts = [];
    for (let k = 0; k <= 24; k++) {
      const z = -20 + (k / 24) * 40;
      gpts.push(new T.Vector3(0, hgt + .9 - Math.sin(Math.min(1, Math.abs(z) / 20) * Math.PI / 2) * .6, z));
    }
    g.add(new T.Line(new T.BufferGeometry().setFromPoints(gpts), condMat));
    /* 杆号牌 */
    const tagTex = tex(function (gg, w2, h2) {
      gg.fillStyle = '#1d2a2e'; gg.fillRect(0, 0, w2, h2);
      gg.strokeStyle = 'rgba(232,255,250,.85)'; gg.lineWidth = 2; gg.strokeRect(3, 3, w2 - 6, h2 - 6);
      gg.fillStyle = '#eafffa'; gg.font = 'bold 15px sans-serif';
      gg.textAlign = 'center'; gg.textBaseline = 'middle';
      gg.fillText('1#', w2 / 2, h2 / 2 + 1);
    }, 32, 24);
    const poleTag = new T.Mesh(new T.PlaneGeometry(.34, .26),
      new T.MeshBasicMaterial({ map: tagTex, side: T.DoubleSide }));
    poleTag.position.set(halfAt(2.6) + .16, 2.6, 0);
    poleTag.rotation.y = Math.PI / 2;
    g.add(poleTag);
    root.add(g);
    twrLabelEl = label('并网铁塔<i>10kV 上网线路</i><em>--</em>', 'tag3d-gt', TWR_X, TWR_H - .6, TWR_Z);
    addCard('tower', TWR_X, TWR_H - 1.8, TWR_Z);
  }
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
    /* 只留近处一根电杆做引下；远段线路改由并网铁塔承担（见 buildTower） */
    const poles = [[px, 4.25, mz, 4.5]];
    poles.forEach(function (p) {
      root.add(cyl(.10, .13, p[3], poleMat, p[0], p[3] / 2, p[2], 10));
      root.add(box(.12, .1, 1.15, poleMat, p[0], p[1] - .12, p[2]));                    /* 横担 */
      [-.42, 0, .42].forEach(function (oz) {                                            /* 瓷瓶 */
        root.add(cyl(.045, .055, .17, std(0xdfe6e8, { roughness: .35, metalness: .1 }), p[0], p[1] + .04, p[2] + oz, 8));
      });
    });
    /* 引下线：电杆 → 计量箱箱顶 */
    const drop = new T.CatmullRomCurve3([
      new T.Vector3(px + .12, 3.6, mz + .1),
      new T.Vector3(mx + .1, 2.4, mz + .3),
      new T.Vector3(mx + .02, 1.5, mz + .02)
    ]);
    root.add(new T.Mesh(new T.TubeGeometry(drop, 12, .02, 5, false), std(0x2c3a40, { roughness: .7 })));
    /* 三跨导线：近杆横担 → 并网铁塔的三层横担（带弧垂）—— 卖电就从这条线送出去 */
    const wireMat = std(0x2c3a40, { roughness: .7, metalness: .2 });
    const towerSide = twrArms.filter(function (a) { return a.s === -1; })
      .sort(function (a, b) { return a.ai - b.ai; });
    [[-.42, 0], [0, 1], [.42, 2]].forEach(function (o) {
      const tip = towerSide[o[1]];
      if (!tip) return;
      const a = new T.Vector3(px, 4.29, mz + o[0]);
      const b = new T.Vector3(tip.v.x, tip.v.y - .55, tip.v.z);
      const mid = new T.Vector3((a.x + b.x) / 2, Math.min(a.y, b.y) - .34, (a.z + b.z) / 2);
      root.add(new T.Mesh(new T.TubeGeometry(new T.CatmullRomCurve3([a, mid, b]), 14, .022, 5, false), wireMat));
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
    flows.push({ map: tubeMat.map, tubeMat: tubeMat, kind: kind, on: false, speed: 0, dir: 1, tint: 0 });
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
    /* 构图：把「并网铁塔 → 储能柜 → 两层小楼（屋顶光伏）」从左到右完整收进画面 */
    camera.position.set(34, 19, 40);

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
      controls.maxPolarAngle = 1.35;
      controls.target.set(-6, 4, 1);
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
    /* 玻璃板面：压掉天空反射（原来 envMapIntensity .9 + 高金属度，整片阵列被反光提亮成浅蓝），
       现在近黑深蓝，只有发电时才透出一点深蓝 */
    const glassMat = new T.MeshStandardMaterial({
      map: panelTexture(), roughness: .3, metalness: .45,
      emissive: new T.Color(0x061528), emissiveIntensity: .14, envMapIntensity: .35
    });
    panelMats.push(glassMat);
    const edgeMat = new T.MeshStandardMaterial({ color: 0x8e9ba1, roughness: .45, metalness: .65, envMapIntensity: .45 });
    buildArray(glassMat, edgeMat);
    buildTower();                 /* 铁塔要先建：设备段的三跨导线要取它的挂点 */
    buildEquipment();
    buildStorageCabinet();

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
    /* 交流支线：计量箱 → 储能柜（充电流进柜、放电流出柜） */
    addFlow([
      new T.Vector3(-14.4, .95, 5.9),
      new T.Vector3(-15.6, .85, 4.2),
      new T.Vector3(-16.7, .72, 2.0)
    ], 'stor', .05);
    /* 交流支线：计量箱 → 电杆 → 沿三跨导线 → 并网铁塔（往电网卖电 / 从电网取电） */
    addFlow([
      new T.Vector3(-15.05, 1.35, 5.95),
      new T.Vector3(-15.2, 2.6, 5.95),
      new T.Vector3(-15.4, 4.1, 6.0),
      new T.Vector3(-22, 5.6, 7.6),
      new T.Vector3(-30, 6.4, 7.0)
    ], 'grid', .045);

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
    /* 水泥地坪跟着主题换色温（夜里深灰 / 白天浅灰），贴图重画一遍 */
    if (groundMat) {
      const old = groundMat.map;
      groundMat.map = concreteTexture();
      groundMat.map.repeat.set(47, 47);
      groundMat.needsUpdate = true;
      if (old) old.dispose();
    }
    if (slabYardMat) {
      const old = slabYardMat.map;
      slabYardMat.map = concreteTexture();
      slabYardMat.map.repeat.set(31, 16);
      slabYardMat.needsUpdate = true;
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
    /* 窗户：白天压到 0.16（浅底上不再是一片白洞），夜里 0.5 的暖光 */
    if (winMat) {
      winMat.emissiveIntensity = theme === 'day' ? .16 : WIN_GLOW;
      winMat.emissive.setHex(theme === 'day' ? 0xfff3e2 : 0xffe2bd);
    }
    refreshSkyLight();
  }

  /* ---------------- 天气 / 功率 ---------------- */
  function refreshSkyLight() {
    const cloud = Math.max(0, Math.min(100, Number(cur.cloud) || 0));
    const rad = Math.max(0, Number(cur.radiation) || 0);
    const day = !!cur.isDay;                      /* 真实昼夜：只决定太阳在不在 */
    const dim = 1 - cloud / 100 * .38;
    const dayT = theme === 'day';
    /* 白天主题的界面底色是浅色，光照总量压低一档，否则墙地会白成一片；
       改水泥地坪后总光量控制在 1.1 附近（再高浅色水泥就过曝成纯白） */
    if (sunLight) sunLight.intensity = ((dayT ? .74 : .88) + (rad > 0 ? Math.min(1, rad / 950) * (dayT ? .28 : .38) : .1)) * dim;
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
    /* 发电时只透一点深蓝（不再是整片发亮的蓝板），待机时基本是黑的 */
    panelMats.forEach(function (m) {
      m.emissiveIntensity = (day ? .04 : .14) + ratio * (day ? .22 : .34);
      m.emissive.setHex(on ? (day ? 0x14507f : 0x0b3c60) : 0x061528);
    });
    flows.forEach(function (fl) {
      if (fl.kind !== 'dc' && fl.kind !== 'ac') return;    /* 储能/关口两支线由 updateEnergyFlows 管 */
      fl.on = on;
      fl.speed = .35 + ratio * 1.9;
      fl.tubeMat.color.setHex(fl.on ? (fl.kind === 'dc' ? p.dc : p.ac) : p.idle);
    });
    updateEnergyFlows();
    if (invLabelEl) invLabelEl.innerHTML = '逆变器 · SG100CX-P2-CN<i>' + cur.power.toFixed(2) + ' kW</i><em>' + (on ? '运行中' : '待机') + '</em>';
    if (arrLabelEl) arrLabelEl.innerHTML = '屋顶光伏阵列<i>' + cur.power.toFixed(2) + ' kW</i><em>今日 '
      + (cur.today === null ? '--' : cur.today.toFixed(1)) + ' 度 · 装机 ' + Number(cur.cap).toFixed(2) + ' kWp</em>';
    /* 并网点标签由 updateEnergyFlows() 统一刷新（它知道储能与负载） */
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

  /* 储能柜实时（日升云）：驱动柜体 SOC 光柱、指示灯、浮标卡片，以及充放电光纹 */
  function f1(v) { return (v === null || v === undefined || isNaN(Number(v))) ? '--' : Number(v).toFixed(1); }
  function setStorage(st) {
    if (!st) return;
    const r = st.realtime || {};
    cur.storPower = r.power_kw;
    cur.loadKw = r.load_kw;
    cur.storSoc = r.soc;
    const soc = Math.max(0, Math.min(100, Number(cur.storSoc) || 0));
    cabSocBars.forEach(function (bar) { bar.scale.y = Math.max(.02, soc / 100); });
    const dis = Number(cur.storPower) > 0, chg = Number(cur.storPower) < 0;
    const col = chg ? 0x8fd8ff : (dis ? 0x3df0a0 : 0x6f9a94);
    if (cabLed) cabLed.material.color.setHex(col);
    if (cabGlow) cabGlow.material.color.setHex(col);
    const td = st.today || {}, dv = st.device || {};
    const brand = (dv.bcu_brand ? dv.bcu_brand : 'SYL') + ' 电池 + ' + (dv.pcs_brand === 'EJ' ? '恩玖' : (dv.pcs_brand || 'PCS'));
    if (cabLabelEl) {
      cabLabelEl.innerHTML = '储能柜 · 光储一体<i>' + f1(cur.storPower) + ' kW</i><em>'
        + (r.status_text || '--') + ' · SOC ' + Math.round(soc) + '%</em>';
    }
    setCard('storage', '储能柜 · 光储一体（' + brand + '）', [
      ['SOC', Math.round(soc) + ' %'],
      ['实时功率', f1(cur.storPower) + ' kW（' + (r.status_text || '--') + '）'],
      ['今日充电', f1(td.charge_kwh) + ' 度'],
      ['今日放电', f1(td.discharge_kwh) + ' 度'],
      ['柜内配置', brand],
      ['采样时间', String(r.time || '--').slice(11, 19)]
    ], Math.abs(Number(cur.storPower) || 0) > .3
      ? (dis ? '放电中（往系统送电）' : '充电中（把电存起来）') : '待机');
    /* 铁塔明细：本站卖电/买电都走这条线 */
    const g = st.grid || {};
    setCard('tower', '并网铁塔 · 10kV 上网线路', [
      ['线路', '1# 杆塔 · 三跨导线'],
      ['今日馈电（卖电）', f1(g.feed_today_kwh) + ' 度'],
      ['累计馈电', f1(g.feed_total_kwh) + ' 度'],
      ['今日取电（买电）', f1(g.draw_today_kwh) + ' 度'],
      ['累计取电', f1(g.draw_total_kwh) + ' 度']
    ], (Number(g.feed_today_kwh) || 0) > 0 ? '今天已往电网送电' : '暂无送出');
    updateEnergyFlows();
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

  /* 浮标按相机距离缩放：HTML 浮标固定像素大小，拉远后模型缩成一点、浮标还是原尺寸，
     就会糊成一片。按"默认机位距离 = 100%"算缩放，远处再略微淡出 */
  const LBL_REF = 48;                // 默认机位附近：浮标 100%
  let _lblV = null;
  function scaleLabels() {
    if (!labelPairs.length || !camera) return;
    if (!_lblV) _lblV = new THREE.Vector3();
    for (let i = 0; i < labelPairs.length; i++) {
      const it = labelPairs[i];
      it.obj.getWorldPosition(_lblV);
      const d = camera.position.distanceTo(_lblV);
      let k = LBL_REF / Math.max(1, d);
      k = Math.min(1.15, Math.max(0.45, k));
      if (Math.abs((it.k || 0) - k) < 0.01) continue;      /* 变化太小就不写样式，免得每帧折腾 DOM */
      it.k = k;
      it.el.style.setProperty('--lbl-scale', k.toFixed(3));
      /* 拉得越远越淡：0.45 时降到 0.35，远景不至于是"一片标签" */
      it.el.style.opacity = (0.35 + 0.65 * Math.min(1, (k - 0.45) / 0.55)).toFixed(2);
    }
  }

  /* 电流光纹沿电缆滚动（速度随功率，方向随充放/买卖电，无输出时静止变暗） */
  function stepFlow(dt) {
    if (!flows.length || !dt) return;
    for (let i = 0; i < flows.length; i++) {
      const fl = flows[i];
      fl.tubeMat.opacity = fl.on ? .95 : .3;
      if (!fl.on) continue;
      fl.map.offset.x -= (fl.dir || 1) * fl.speed * dt * .35;
      if (fl.tint) fl.tubeMat.color.setHex(fl.tint);
    }
  }

  /* 光伏 / 储能 / 负载三者决定两条支线的方向与颜色：
     储能充放：充电流进柜（蓝）、放电流出柜（青绿）
     关口：发得多就往外卖（橙，往电网去）、不够就从电网取（蓝） */
  function updateEnergyFlows() {
    const c = FLOWC[theme] || FLOWC.night;
    const pv = Number(cur.power) || 0;
    const st = Number(cur.storPower) || 0;
    const load = Number(cur.loadKw) || 0;
    const surplus = pv + st - load;
    flows.forEach(function (fl) {
      if (fl.kind === 'stor') {
        fl.on = Math.abs(st) > .3;
        fl.dir = st > 0 ? -1 : 1;
        fl.tint = st > 0 ? 0x3df0a0 : 0x8fd8ff;
        fl.speed = .3 + Math.min(1, Math.abs(st) / 100) * 1.8;
        if (!fl.on) fl.tubeMat.color.setHex(c.idle);
      } else if (fl.kind === 'grid') {
        fl.on = Math.abs(surplus) > .3;
        fl.dir = surplus > 0 ? 1 : -1;
        fl.tint = surplus > 0 ? 0xffb020 : 0x8fd8ff;
        fl.speed = .3 + Math.min(1, Math.abs(surplus) / 100) * 1.8;
        if (!fl.on) fl.tubeMat.color.setHex(c.idle);
      }
    });
    if (gridLabelEl) {
      gridLabelEl.innerHTML = '并网点<i>' + (Math.abs(surplus) > .3
        ? (surplus > 0 ? '馈电上网 ' + surplus.toFixed(1) + ' kW' : '从电网取 ' + Math.abs(surplus).toFixed(1) + ' kW')
        : '无交换') + '</i><em>计量箱 · 关口表</em>';
    }
    if (twrLabelEl) {
      twrLabelEl.innerHTML = '并网铁塔<i>10kV 上网线路</i><em>' + (Math.abs(surplus) > .3
        ? (surplus > 0 ? '送出 ' + surplus.toFixed(1) + ' kW' : '受电 ' + Math.abs(surplus).toFixed(1) + ' kW')
        : '无交换') + '</em>';
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
    scaleLabels();                       /* 浮标跟着相机距离缩放 */
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
    camera.position.set(34, 19, 40);
    controls.target.set(-6, 4, 1);
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

  return { init, resize, setWeather, setPower, setStorage, applyTheme, setActive, setLabels, setRotate, resetView };
})();
