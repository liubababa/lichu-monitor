/* ============================================================
 * 洙边卫生院站 · 光储一体三维场景
 *
 *   两层小楼（白主墙 + 灰腰线 + 大窗，夜里窗户发光）+ 屋顶光伏阵列
 *   （4 排 × 5 块组件级建模：玻璃 / 铝边框 / 导轨 / 竖撑 + 检修走道 + 屋面线槽）
 *   + 墙挂逆变器（现场口径：不接线、不挂浮标/明细卡，场上只留设备本体）+ 通信模块
 *     （西墙上不挂配电箱/计量箱，线直接进楼）
 *   + 储能柜（光储一体柜：柜门、顶部空调、侧面 SOC 光柱；挂在储能支线上）
 *   + 并网铁塔（格构塔，和旭日东明那座同向，挪到和储能柜同一排；关口线路走地面电缆到塔基终端箱）。
 *
 *   电流光纹按"一条总线 + 一个 T 型支线"画，方向跟着真实运行状态走（和页面的六种供电模式一一对应）：
 *     · 光伏支线（黄） 屋面组串 → 线槽 → 西墙直落 → 总线东头（楼西墙根）
 *     · 负载支线（青绿=储供 / 黄=光供 / 蓝=电网供） 总线东段 → 卫生院（进墙）
 *     · 关口支线（黄=卖 / 蓝=买） 总线西段 → 贴柜子北侧 → 地面电缆 → 铁塔终端箱
 *     · 储能支线（黄=光伏充 / 蓝=电网充 / 青绿=放电） 总线 T 型接口 ↔ 储能柜东面
 *     · 电网直供线（蓝） 铁塔终端箱 → 储柜南侧 → 卫生院（进西墙根 z≈3.88）——单独一条，
 *       走场坪南侧那条走廊，和北侧的总线 / 储能支线不交叉
 *   现场口径：光伏出来的电线要能看到"进储能柜 / 进卫生院 / 去电网"三路——现在总线自己
 *   走到楼里（负载支线），储能是一根 T 支，电网是总线西段，分叉只有一个 T 型接口，
 *   不会看成两线交叉。逆变器不接线（现场口径），不在任何一条线的端点上。
 *   线色按"谁在供电"分：光伏黄、电网蓝、储能放电青绿——储能支线充电时用"电从哪来"的颜色
 *   （光伏黄 / 电网蓝）
 *
 *   天气（SolarScene.setWeather）驱动画面：
 *     云量 → 天空/光照亮度、云朵多少；降水 → 雨/雪粒子；
 *     辐照度 → 光照强度、组件反光强度；昼夜（is_day）→ 太阳 / 月亮
 *   光伏功率（SolarScene.setPower）驱动：组件发光、光伏光纹流速与颜色
 *   储能数据（SolarScene.setStorage）驱动：柜体 SOC 光柱、指示灯、充放电与买卖电方向
 * ============================================================ */
window.SolarScene = (function () {
  'use strict';

  let inited = false, root = null, scene, camera, renderer, composer = null, bloomPass = null, vigPass = null, controls, labelR = null;
  let sun = null, moon = null, sunGlow = null, sunLight = null, hemi = null, fillLight = null, skyDome = null;
  let cloudGroup = null, envRT = null;
  let sweepMesh = null, slabEdge = null, siteGlow = null, beacon = null, beaconGlow = null;
  let rainInst = null, rainMat = null;               /* 雨滴合批成一个 InstancedMesh（1 个 draw call） */
  const RAIN_N = 420, rainX = [], rainY = [], rainZ = [], rainV = [];
  let _rainM = null;                                 /* 雨滴矩阵复用的临时对象 */
  const cloudMats = [];                              /* 云朵材质（跟主题换色） */
  let panelMats = [], arrLabelEl = null;
  /* 当前供电模式（updateEnergyFlows 判定，储能柜浮标 / 明细卡要用；两个函数之间用模块级变量传）。
     三个量缺一个就全为空串，显示 --（不编数据） */
  let pModeNow = '', pModeTxtNow = '', pModeNoteNow = '';
  let raf = null, W = 0, H = 0;
  let camHome = null;                                /* 默认机位（按画布宽高比算好后存下来，重置视角复用） */
  const flows = [];                 // 电流光纹：{ map, tubeMat, kind, on, speed }
  const labelObjs = [];             // 浮标对象（点开明细卡时统一藏起来）
  const labelPairs = [];            // { obj, el } 供按相机距离缩放浮标
  const cards = {};                 // 设备明细卡：key -> .card3d 元素
  let activeCard = null;
  const clock = { last: 0 };
  /* pvSeen：光伏这一路这次到底有没有上报。供电模式要靠 pv 判，而 0 kW（夜里 / 真的没出力）
     和"没数据"必须分开——所以 setPower 传 null 表示"没上报"，别当成 0 */
  let cur = { power: 0, pvSeen: false, cap: 110.16, today: null, cloud: 0, precip: 0, isDay: 1, radiation: 0, storPower: null, storSoc: null, loadKw: null };
  let theme = 'night';

  const THREE_ = () => window.THREE;

  /* 双主题参数表。
     夜（站点默认主题）= 暗色数字孪生：深底穹顶 + 青调地平线 + 网格场坪 + 发光强调；
     昼 = 浅色可读优先，只做协调（暖色强调、压低泛光防洗白）。
     与主题相关的数值都收在这里，applyTheme() 一处套用 */
  const THEMES = {
    night: {
      sky: [[0, '#04080c'], [.42, '#071219'], [.66, '#0d2530'], [.84, '#123743'], [1, '#17505f']],
      fog: { color: 0x0b1c24, near: 105, far: 300 },
      bloom: { strength: .55, radius: .7, threshold: .78 },
      vignette: { strength: .3, tint: .06 },
      lights: {
        key: { color: 0xcfe8ff, base: .88, rad: .42 },
        hemi: { sky: 0xbfe9ff, ground: 0x0a1518, base: .95 },
        fill: { color: 0x2ee6c8, intensity: .38 }
      },
      edge: { color: 0x2ee6c8, opacity: .5 },
      glow: { color: 0x2ee6c8, opacity: .08 },
      sweep: .05,
      cloud: 0x22343c,
      particle: { color: 0x2ee6c8, opacity: .34 }
    },
    day: {
      sky: [[0, '#2f74b8'], [.45, '#5fa6d8'], [.62, '#9ccbe4'], [.78, '#cfe2ec'], [1, '#dbe9f0']],
      fog: { color: 0xd3e3ec, near: 120, far: 340 },
      bloom: { strength: .12, radius: .6, threshold: .96 },
      vignette: { strength: .12, tint: 0 },
      lights: {
        key: { color: 0xfff2d0, base: .62, rad: .22 },
        hemi: { sky: 0xdff0ff, ground: 0x76815f, base: .3 },
        fill: { color: 0xbfe0ff, intensity: .1 }
      },
      edge: { color: 0x0f9682, opacity: .35 },
      glow: { color: 0x0f9682, opacity: .05 },
      sweep: 0,
      cloud: 0xffffff,
      particle: { color: 0x0f9e86, opacity: .16 }
    }
  };
  /* 电流光纹配色（全站统一口径，按"谁在供电"上色）：光伏=黄（ac / sell 同色）、电网=蓝（buy）、
     储能放电=青绿（dis），没出力一律 idle。chg 只给柜体指示灯 / 光晕用（充电中蓝），线路不再拿它上色——
     充电是从哪来的电就用哪个源的颜色（光伏充就黄、电网充就蓝，看关口那条线）。
     白天浅底整体用深一档，否则浅色底上只剩一片白。下面几条线的颜色都从这里取，别再各写各的 */
  const FLOWC = {
    night: { ac: 0xffb020, idle: 0x24444a, chg: 0x8fd8ff, dis: 0x3df0a0, sell: 0xffb020, buy: 0x8fd8ff },
    day: { ac: 0xd97700, idle: 0x6f8a86, chg: 0x1f7fd0, dis: 0x159a63, sell: 0xd97700, buy: 0x1f7fd0 }
  };

  /* ---------------- 基础工具 ---------------- */
  let groundMat = null, slabYardMat = null;
  const themeMats = [];             // 跟主题换色 / 换自发光 / 换透明度 / 换贴图的材质
  function regThemeMat(mat, night, day) { themeMats.push({ mat: mat, night: night || {}, day: day || {} }); return mat; }
  /* 套用一条主题材质；map 传函数时按主题重生成贴图（旧贴图释放） */
  function applyThemeMat(r) {
    const v = r[theme] || {}, m = r.mat;
    if (v.color !== undefined && m.color) m.color.setHex(v.color);
    if (v.emissive !== undefined && m.emissive) m.emissive.setHex(v.emissive);
    if (v.emissiveIntensity !== undefined) m.emissiveIntensity = v.emissiveIntensity;
    if (v.opacity !== undefined) m.opacity = v.opacity;
    if (v.envMapIntensity !== undefined) m.envMapIntensity = v.envMapIntensity;
    if (typeof v.map === 'function') {
      const old = m.map;
      m.map = v.map(theme);
      if (old && old.dispose) old.dispose();
      m.needsUpdate = true;
    }
  }
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
    const hide = !labelsOn || !!activeCard;
    for (let i = 0; i < labelPairs.length; i++) {
      const it = labelPairs[i];
      const vis = !hide && !it.blocked;
      if (it.obj.visible !== vis) it.obj.visible = vis;
    }
    for (const k in cards) cards[k].style.display = (k === activeCard) ? '' : 'none';
  }

  /* 浮标遮挡：浮标是 HTML 图层，天生盖在三维模型之上（楼后面的浮标也会透出来）。
     这里从相机朝浮标锚点打一条射线，被大体积模型挡住的浮标就藏起来。
     省开销：每 6 帧算一次（约 12 次/秒），而且只对登记的"大块头"做检测，
     不把铁塔杆件这类细碎构件算进去——否则浮标会被自己的支架误挡 */
  const occluders = [];
  let _occRay = null, _occV = null, _occDir = null, _occN = 0;
  function updateLabelOcclusion() {
    if (!labelPairs.length || !camera || !occluders.length) return;
    if (++_occN % 6) return;
    if (!_occRay) {
      _occRay = new THREE.Raycaster();
      _occV = new THREE.Vector3();
      _occDir = new THREE.Vector3();
    }
    let dirty = false;
    for (let i = 0; i < labelPairs.length; i++) {
      const it = labelPairs[i];
      it.obj.getWorldPosition(_occV);
      const dist = _occV.distanceTo(camera.position);
      _occDir.copy(_occV).sub(camera.position).normalize();
      _occRay.set(camera.position, _occDir);
      _occRay.near = 0;
      _occRay.far = Math.max(.5, dist - .6);      /* 留一点余量：浮标贴着的构件不算遮挡 */
      const blocked = _occRay.intersectObjects(occluders, true).length > 0;
      if (blocked !== !!it.blocked) { it.blocked = blocked; dirty = true; }
    }
    if (dirty) applyLabelVisibility();
  }

  /* ---------------- 院内走动的人 ----------------
     人来人往的氛围：胶囊身子 + 球脑袋的抽象小人，沿设定路线匀速走、带一点上下起伏。
     刻意不做五官/手脚这类具象细节；也刻意不投影（阴影贴图是冻结的，动的东西会留下鬼影） */
  const walkers = [];
  function makeWalker(pts, opt) {
    const T = THREE_();
    const g = new T.Group();
    const body = new T.Mesh(new T.CylinderGeometry(.15, .185, .82, 8),
      regThemeMat(std(0x8fa6ab, { roughness: .85 }), { color: 0x9fb3b8 }, { color: 0x8e9ea3 }));
    body.position.y = .55;
    const head = new T.Mesh(new T.SphereGeometry(.135, 10, 8),
      regThemeMat(std(0xb9c8cb, { roughness: .8 }), { color: 0xc8d4d6 }, { color: 0xb2c2c6 }));
    head.position.y = 1.06;
    g.add(body, head);
    root.add(g);
    const seg = [];
    let total = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const dx = pts[i + 1][0] - pts[i][0], dzz = pts[i + 1][1] - pts[i][1];
      const L = Math.sqrt(dx * dx + dzz * dzz);
      seg.push(L); total += L;
    }
    walkers.push({
      g: g, pts: pts, seg: seg, total: total,
      dist: ((opt && opt.phase) || 0) * total,
      speed: (opt && opt.speed) || .85,
      loop: !!(opt && opt.loop)
    });
  }
  function pointOnPath(w, d) {
    let rem = w.loop ? (((d % w.total) + w.total) % w.total) : d;
    for (let i = 0; i < w.seg.length; i++) {
      if (rem <= w.seg[i] || i === w.seg.length - 1) {
        const k = w.seg[i] > 0 ? Math.min(1, Math.max(0, rem / w.seg[i])) : 0;
        const a = w.pts[i], b = w.pts[i + 1];
        return { x: a[0] + (b[0] - a[0]) * k, z: a[1] + (b[1] - a[1]) * k };
      }
      rem -= w.seg[i];
    }
    return { x: w.pts[0][0], z: w.pts[0][1] };
  }
  function buildWalkers() {
    /* 门前广场绕一圈（三个人错开相位）+ 门口往西侧设备区往返一个。
       院子跟着小楼一起收：原来这圈在 z≈10~16（原南墙在 8），新南墙在 4，
       再摆那么远就成"院外荒地"了；同时避开台阶/雨棚柱（z≤5.85）、
       电缆（配电箱下来的储能支线与关口地面线） */
    const plaza = [[-3.8, 6.5], [4.6, 6.7], [7.2, 8.8], [1.0, 10.6], [-5.8, 10.0], [-6.8, 7.6]];
    makeWalker(plaza, { phase: 0, speed: .72, loop: true });
    makeWalker(plaza, { phase: .34, speed: .88, loop: true });
    makeWalker(plaza, { phase: .68, speed: .8, loop: true });
    makeWalker([[-1.6, 6.2], [-4.6, 6.6], [-8.0, 7.6], [-11.0, 8.6]], { phase: .1, speed: .68 });
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

  /* 卫生院外墙：昼=白色墙板 + 灰色分缝；夜=深灰蓝金属板 + 青缝线。
     窗、门单独做几何体，这样夜里窗户能发光、近景经得起看 */
  function wallTexture(t) {
    const night = (t || theme) === 'night';
    return tex(function (g, w, h) {
      g.fillStyle = night ? '#1e2f38' : '#dfe3e3'; g.fillRect(0, 0, w, h);
      /* 平墙不留分缝、也不留勒脚：贴图会横向平铺，画在贴图里的勒脚带每平铺一次
         就多出一道竖缝（视觉模型两次都读成"分格挂板"）。勒脚改由基座几何体承担 */
      g.fillStyle = night ? 'rgba(46,230,200,.05)' : 'rgba(120,138,140,.10)'; g.fillRect(0, 0, w, 10);
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
  function concreteTexture(t) {
    const day = (t || theme) === 'day';
    const tx = tex(function (g, w, h) {
      g.fillStyle = day ? '#c2c5bd' : '#1d2a31'; g.fillRect(0, 0, w, h);
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

  /* 场坪（数字孪生底座）：昼=浅色水泥 + 淡格线；夜=深色底盘 + 青色细格网。
     贴图按 8×8 格画，铺到 96×58 的场坪上（repeat 后每格约 3m） */
  function slabTexture(t) {
    const night = (t || theme) === 'night';
    const tx = tex(function (g, w, h) {
      g.fillStyle = night ? '#1b2b33' : '#c4c7bf'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 2600; i++) {
        const darkk = Math.random() > .5;
        g.fillStyle = darkk
          ? (night ? 'rgba(0,0,0,' + (.03 + Math.random() * .07) + ')' : 'rgba(70,74,70,' + (.02 + Math.random() * .05) + ')')
          : (night ? 'rgba(255,255,255,' + (.012 + Math.random() * .03) + ')' : 'rgba(255,255,255,' + (.02 + Math.random() * .05) + ')');
        const s = Math.random() < .85 ? 1 : 2;
        g.fillRect(Math.random() * w, Math.random() * h, s, s);
      }
      const cells = 8, cw = w / cells;
      g.strokeStyle = night ? 'rgba(46,230,200,.13)' : 'rgba(30,90,95,.09)';
      g.lineWidth = 1.2;
      for (let i = 0; i <= cells; i++) {
        const p = Math.round(i * cw) + .5;
        g.beginPath(); g.moveTo(p, 0); g.lineTo(p, h); g.stroke();
        g.beginPath(); g.moveTo(0, p); g.lineTo(w, p); g.stroke();
      }
      g.strokeStyle = night ? 'rgba(46,230,200,.22)' : 'rgba(30,90,95,.14)';
      g.lineWidth = 2;
      for (let i = 0; i <= cells; i += 4) {                        /* 每 4 格一条主格线 */
        const p = Math.round(i * cw) + .5;
        g.beginPath(); g.moveTo(p, 0); g.lineTo(p, h); g.stroke();
        g.beginPath(); g.moveTo(0, p); g.lineTo(w, p); g.stroke();
      }
    }, 512, 512);
    tx.wrapS = tx.wrapT = THREE.RepeatWrapping;
    if (renderer && renderer.capabilities) tx.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return tx;
  }

  /* 径向光晕（加色用）：场坪上的光池、塔顶航标共用一张 */
  function radialGlowTexture() {
    return tex(function (g, w, h) {
      const grd = g.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, w / 2);
      grd.addColorStop(0, 'rgba(255,255,255,.9)');
      grd.addColorStop(.35, 'rgba(255,255,255,.32)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd; g.fillRect(0, 0, w, h);
    }, 128, 128);
  }

  /* 扫光带：横向一条柔和亮带（加色混合，淡到只当呼吸用） */
  function sweepTexture() {
    return tex(function (g, w, h) {
      const grd = g.createLinearGradient(0, 0, w, 0);
      grd.addColorStop(0, 'rgba(255,255,255,0)');
      grd.addColorStop(.42, 'rgba(255,255,255,.05)');
      grd.addColorStop(.5, 'rgba(255,255,255,.5)');
      grd.addColorStop(.58, 'rgba(255,255,255,.05)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd; g.fillRect(0, 0, w, h);
    }, 128, 8);
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
          lg.addColorStop(.22, 'rgba(255,255,255,.34)');
          lg.addColorStop(.44, 'rgba(255,255,255,.9)');
          lg.addColorStop(.55, 'rgba(255,255,255,1)');
          lg.addColorStop(.72, 'rgba(255,255,255,.42)');
          lg.addColorStop(1, 'rgba(255,255,255,0)');
          g.fillStyle = lg; g.fillRect(x, 0, w / 2, h);
        }
      }, 128, 8);
      flowTexProto.wrapS = flowTexProto.wrapT = THREE.RepeatWrapping;
    }
    const t = flowTexProto.clone();
    t.needsUpdate = true;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(Math.max(2, Math.round((repeat || 8) / 3)), 1);
    return t;
  }

  /* ---------------- 场景尺寸常量 ---------------- */
  /* 体量按旭日东明那栋紧凑厂房块（约 13 × 8 × 6.2）对齐：原来是 26 × 16 × 6.6 的
     宽扁厂房比例，一整片平屋顶把阵列摊得很散，跟现场那栋小楼对不上 */
  const W2 = 13, H2 = 6.2, D2 = 8;               /* 卫生院：宽 × 高（两层小楼）× 深 */
  const FLOOR_Y = H2 / 2;                        /* 二层楼面标高（相对勒脚顶） */
  const roofY = H2 + .3;                         /* 屋面标高（含 0.3 勒脚台） */
  /* 储能柜：光储一体柜。原来按"贴着建筑"立在西墙外，但体量收小后它挤在楼左前角，
     跟原来单摆的计量箱挤在同一处、画面里也看不出是独立设备；现在往西挪进场坪，
     站在楼与铁塔之间的空地上（墙外 6m，柜身 x -13.85~-11.15、z 1.85~3.55），
     柜门朝南（正对院子和默认机位）。柜子现在只挂一条储能支线（北面进线，见能量流） */
  const CAB_X = -(W2 / 2 + 6), CAB_Z = 2.7, CAB_W = 2.7, CAB_H = 2.6, CAB_D = 1.7;
  /* 关口地面电缆的墩线：从总线绕到塔基那一段用这条弧线算。
     起点取柜子西侧那一点（x -16.2 / z 1.95），终点是塔基终端箱（TWR_WIRE_X / TWR_Z 2.7）；
     中间向南弓 0.30m——实铺的电缆不会拉得像尺子一样直，带一点自然弧线；
     墩子和电缆点都用同一条弧线算，线才不会离开墩子 */
  const GRD_X0 = -16.2, GRD_Z0 = 1.95, GRD_BOW = .3;
  function grdPoint(t) {
    return [GRD_X0 + (TWR_WIRE_X - GRD_X0) * t, GRD_Z0 + (TWR_Z - GRD_Z0) * t + Math.sin(Math.PI * t) * GRD_BOW];
  }
  /* 场坪上的那条"总线"：从楼西墙根一路往西到铁塔终端箱（柜子北侧绕过去）。
     光伏从屋面下来的那条线就落在总线的东头上，储能支线在 TAP_X 处从总线上分出去——
     分叉只有一个 T 型接口，不再是四条线交在一个点（那样屏幕上会看成"两线交叉"）。
     BUS_Z 取 0.55~0.9 这一带：在柜子基础台北沿（1.64）以北，不压柜子 */
  const BUS_Z = .78;                           /* 总线中段（柜子北侧）的 z */
  const TAP_X = -11.0;                         /* 储能支线在总线上分出去的位置（柜子东沿以外） */
  /* 屋顶阵列按新屋面重算：一排 5 块 = 11.64 宽（女儿墙内侧 ±6.35，两侧各余 0.53）；
     4 排、行距 1.5（外排组件外沿 ±3.05，离女儿墙内侧 0.8），中间留检修走道 */
  const COLS = 5;
  const MW = 2.28, MD = 1.13, MT = .045;         /* 组件：宽 × 深 × 厚 */
  const TILT = .49;                              /* 组件倾角 28°（+z 为南，朝太阳低下来） */
  const ROW_Y = .62;                             /* 组件面中心相对屋面的高度 */
  const rowW = COLS * MW + (COLS - 1) * .06;     /* 一排的总宽 */
  const rowZs = [-2.55, -1.05, 1.05, 2.55];      /* 4 排，中间留检修走道 */
  /* 排内局部坐标 → 组件面高度（相对屋面；南低北高） */
  function rowPlaneY(zl) { return roofY + ROW_Y - Math.tan(TILT) * zl; }
  const RAIL_Z = .40;                            /* 导轨在排内的前后位置 */
  const RAIL_DROP = .0525;                       /* 导轨中心比组件面低多少（导轨顶面贴组件底面） */

  function skyTexture(stops) {
    return tex(function (g, w, h) {
      const grd = g.createLinearGradient(0, 0, 0, h);
      stops.forEach(function (s) { grd.addColorStop(s[0], s[1]); });
      g.fillStyle = grd; g.fillRect(0, 0, w, h);
    }, 16, 256);
  }

  /* ---------------- 场地 ---------------- */
  function buildSite() {
    const T = THREE_();
    /* 地坪：整片地面铺到 700 见方，远边交给雾，任何角度都看不到地边 */
    groundMat = regThemeMat(new T.MeshStandardMaterial({ map: concreteTexture(), roughness: .96, metalness: .02 }),
      { envMapIntensity: .5 }, { envMapIntensity: .3 });
    groundMat.map.repeat.set(47, 47);
    const ground = new T.Mesh(new T.PlaneGeometry(700, 700), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    root.add(ground);
    /* 场坪：数字孪生底座 —— 深色底盘 + 细格网（每格约 3m），四周一圈发光描边 */
    slabYardMat = regThemeMat(new T.MeshStandardMaterial({ map: slabTexture(theme), roughness: .93, metalness: .02 }),
      { envMapIntensity: .5 }, { envMapIntensity: .35 });
    /* 场坪面往深度里推一点：四周那圈发光描边（EdgesGeometry 正好落在场坪棱上）
       和柜体底座顶面都跟坪面共面，不推开会远看闪烁 */
    slabYardMat.polygonOffset = true;
    slabYardMat.polygonOffsetFactor = 1;
    slabYardMat.polygonOffsetUnits = 1;
    slabYardMat.map.repeat.set(4, 58 / 24);
    root.add(box(96, .18, 58, slabYardMat, 0, .09, 0));
    /* 场坪描边：EdgesGeometry 细线，就是画面里"场地边界"的那圈光 */
    slabEdge = new T.LineSegments(
      new T.EdgesGeometry(new T.BoxGeometry(96, .18, 58)),
      regThemeMat(new T.LineBasicMaterial({ color: 0x2ee6c8, transparent: true, opacity: .5, depthWrite: false }),
        {}, { color: 0x0f9682, opacity: .35 }));
    slabEdge.position.y = .09;
    root.add(slabEdge);
    /* 坪面光池：加色径向渐变，场坪中心亮、四周暗 */
    siteGlow = new T.Mesh(new T.PlaneGeometry(150, 100),
      regThemeMat(new T.MeshBasicMaterial({
        map: radialGlowTexture(), color: 0x2ee6c8, transparent: true, opacity: .08,
        blending: T.AdditiveBlending, depthWrite: false
      }), {}, { color: 0x0f9682, opacity: .05 }));
    siteGlow.rotation.x = -Math.PI / 2;
    siteGlow.position.y = .2;
    siteGlow.renderOrder = 2;
    root.add(siteGlow);
    /* 扫光带：一条极淡的加色光带缓慢横移（18s 一轮），给静态画面一点"数据在跑"的呼吸 */
    sweepMesh = new T.Mesh(new T.PlaneGeometry(26, 74),
      new T.MeshBasicMaterial({
        map: sweepTexture(), color: 0x2ee6c8, transparent: true, opacity: 0,
        blending: T.AdditiveBlending, depthWrite: false
      }));
    sweepMesh.rotation.x = -Math.PI / 2;
    sweepMesh.position.y = .21;
    sweepMesh.renderOrder = 3;
    root.add(sweepMesh);
  }

  /* ---------------- 卫生院建筑（两层小楼：昼=白主墙 + 灰腰线；夜=深灰蓝墙板 + 青缝线 + 暖白窗光） ---------------- */
  let winMat = null;
  function buildBuilding() {
    const T = THREE_();
    /* 外立面统一按旭日东明那套（现场实况：白色厂房、夜里也是白墙 + 暖窗光）：
       原来夜里换"深灰蓝墙板 + 青缝线"的科幻皮肤，现在两个主题都用白天那套白墙 */
    const wallMat = regThemeMat(new T.MeshStandardMaterial({ map: wallTexture('day'), roughness: .78, metalness: .1, envMapIntensity: .16 }),
      { map: wallTexture('day'), envMapIntensity: .3 });
    const wallTop = regThemeMat(std(0xbcc0b7, { roughness: .92, envMapIntensity: .14 }), { color: 0x22333c, envMapIntensity: .26 });
    const wallBottom = regThemeMat(std(0x545c58, { roughness: .95, envMapIntensity: .12 }), { color: 0x0d1519 });
    const trimMat = regThemeMat(std(0x8d9598, { roughness: .62, metalness: .3 }), { color: 0x2c4048 });     /* 灰带 / 窗框 */
    const bandMat = std(0x232a2d, { roughness: .5, metalness: .35 });     /* 窗带底 */
    root.add(box(W2 + .9, .3, D2 + .9, regThemeMat(std(0x515b5e, { roughness: .9, envMapIntensity: .14 }), { color: 0x1b2830, envMapIntensity: .26 }), 0, .15, 0));
    /* 房身（两层一起） */
    const bld = new T.Mesh(new T.BoxGeometry(W2, H2, D2), [wallMat, wallMat, wallTop, wallBottom, wallMat, wallMat]);
    bld.position.set(0, H2 / 2 + .3, 0);
    bld.castShadow = bld.receiveShadow = true;
    root.add(bld);
    occluders.push(bld);                       /* 楼体：挡住它后面的浮标 */
    root.add(box(W2 + .2, .55, D2 + .2, bandMat, 0, .58, 0));              /* 深色基座带 */
    /* 楼层腰线（一圈） */
    [-1, 1].forEach(function (sz) { root.add(box(W2 + .24, .16, .18, trimMat, 0, FLOOR_Y + .3, sz * (D2 / 2 + .05))); });
    [-1, 1].forEach(function (sx) { root.add(box(.18, .16, D2 + .24, trimMat, sx * (W2 / 2 + .05), FLOOR_Y + .3, 0)); });
    /* 女儿墙 */
    const par = regThemeMat(std(0xb3b8ad, { roughness: .85, envMapIntensity: .16 }), { color: 0x1f2f38, envMapIntensity: .26 });
    root.add(box(W2 + .6, .5, .3, par, 0, roofY + .25, -D2 / 2));
    root.add(box(W2 + .6, .5, .3, par, 0, roofY + .25, D2 / 2));
    root.add(box(.3, .5, D2, par, -W2 / 2, roofY + .25, 0));
    root.add(box(.3, .5, D2, par, W2 / 2, roofY + .25, 0));
    /* 屋面发光轮廓线：沿女儿墙顶走一圈。比墙顶抬高 1cm、纵横两组再错开 2cm——
       原来正好坐在墙顶面上，远看线条会跟墙顶深度打架（一闪一闪） */
    const roofLineMat = regThemeMat(new T.MeshBasicMaterial({ color: 0x2ee6c8, transparent: true, opacity: .72 }),
      {}, { color: 0x0f9682, opacity: .4 });
    root.add(box(W2 + .66, .05, .05, roofLineMat, 0, roofY + .535, D2 / 2));
    root.add(box(W2 + .66, .05, .05, roofLineMat, 0, roofY + .535, -D2 / 2));
    root.add(box(.05, .05, D2 + .06, roofLineMat, W2 / 2, roofY + .555, 0));
    root.add(box(.05, .05, D2 + .06, roofLineMat, -W2 / 2, roofY + .555, 0));

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
    winMat = regThemeMat(new T.MeshStandardMaterial({
      map: winPaneTex, emissiveMap: winPaneTex,
      color: 0x20262a, roughness: .35, metalness: .2,
      emissive: new T.Color(0xfff3e2), emissiveIntensity: .16
    }), { color: 0x0e1a1f, emissive: 0xeef4f2, emissiveIntensity: .58 });
    /* 一整层的大窗带：深色窗带里嵌 n 扇玻璃，中间用竖挺分开。
       体量压到 13×8×6.2 后窗带往上提 20cm（下沿 4.225），门楣（顶 3.2）与院名牌
       （3.27~4.17）之间那点空档才够用，窗带下沿不会压到名牌 */
    const bandH = 1.75, bandD = .24, winY = FLOOR_Y + .3 + 1.7;
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
    /* 南北两面各 4 扇 2.0m 大窗（旭日东明厂房就是这一排 4 扇的排法）；
       东西两面各 2 扇——13m 宽变 8m 深后，原来 5 扇/3 扇会挤成一片 */
    [-1, 1].forEach(function (sz) { winBand(true, W2 - .4, 4, 0, sz * (D2 / 2 + .04), 2.0); });
    [-1, 1].forEach(function (sx) { winBand(false, D2 - .4, 2, sx * (W2 / 2 + .04), 0, 2.0); });
    /* 一层：侧面各两扇窗，正面留给大门 */
    [-1, 1].forEach(function (sx) {
      [-2.0, 2.0].forEach(function (oz) {
        root.add(box(.24, 1.5, 2.0, bandMat, sx * (W2 / 2 + .04), 1.85, oz));
        root.add(box(.2, 1.1, 1.7, winMat, sx * (W2 / 2 + .07), 1.85, oz));
      });
    });
    /* 正面大门：门套 + 双开门 + 雨棚 + 台阶 + 院名牌 */
    const dz = D2 / 2;
    root.add(box(3.4, 2.9, .24, regThemeMat(std(0xcfd6d2, { roughness: .7, envMapIntensity: .16 }), { color: 0x22333c, envMapIntensity: .3 }), 0, 1.75, dz + .04));
    const doorMat = regThemeMat(std(0x31505c, { roughness: .45, metalness: .35, envMapIntensity: .4 }), { color: 0x14262e, envMapIntensity: .7 });
    /* 大门开着：合页在门洞两侧外沿（±1.45），门扇往门洞里伸，自由边向外摆约 66°；
       门洞里压暗、透出大厅的暖光 */
    [1, -1].forEach(function (s) {
      const pv = new T.Group();
      pv.position.set(s * 1.45, 1.55, dz + .14);
      pv.add(box(1.42, 2.5, .1, doorMat, -s * .71, 0, 0));
      pv.rotation.y = s * 1.15;
      root.add(pv);
    });
    root.add(box(2.92, 2.56, .04, std(0x060d11, { roughness: 1 }), 0, 1.55, dz + .175));      /* 门洞（压暗，衬出开着的门） */
    root.add(box(2.6, 2.28, .03, regThemeMat(new T.MeshBasicMaterial({ color: 0x4e4b40 }),
      { color: 0x4e4b40 }, { color: 0x8e8a7e }), 0, 1.5, dz + .2));                          /* 门里透出的光 */
    root.add(box(2.2, .22, .1, regThemeMat(std(0xbcd6dd, { roughness: .3, metalness: .3 }), { color: 0x16333c, envMapIntensity: .8 }), 0, 2.62, dz + .16));   /* 门头玻璃 */
    const plate = new T.Mesh(new T.PlaneGeometry(3.6, .9),
      new T.MeshBasicMaterial({ map: namePlateTexture(), transparent: true }));
    /* 院名牌往外挪 10cm、并卡在门楣（顶 3.2）与二层窗带（底 4.225）之间的空档：
       原来贴在 z=8.16 与窗带前脸完全共面，远看会深度闪烁 */
    plate.position.set(0, 3.72, dz + .26);
    root.add(plate);
    const aw = regThemeMat(std(0xc3c8c2, { roughness: .8, envMapIntensity: .16 }), { color: 0x1c2a31, envMapIntensity: .26 });
    const awPost = regThemeMat(std(0xadb2ab, { roughness: .8 }), { color: 0x18242a });
    root.add(box(5.4, .16, 2.0, aw, 0, H2 - .35, dz + 1.0));
    root.add(box(.18, H2 - .5, .18, awPost, -2.5, (H2 - .5) / 2, dz + 1.85));
    root.add(box(.18, H2 - .5, .18, awPost, 2.5, (H2 - .5) / 2, dz + 1.85));
    /* 台阶：从场地台面（0.18）升到门槛（0.30）——原来两级做到 0.46 高过门槛，
       开着的门扇外摆时会插进台阶里（穿模），按真实标高做成一级 */
    root.add(box(5.0, .12, .5, regThemeMat(std(0xaaafa6, { roughness: .9 }), { color: 0x1a252b }), 0, .24, dz + .75));
    /* 北墙两台空调外机：原来挂在二层窗带上（新体量下会正好压住窗玻璃），
       改挂一层墙面（1.96~2.74），在腰线（3.4）以下、窗带（4.225）以上都不碰 */
    [[-4.2, 2.35], [4.2, 2.35]].forEach(function (p) {
      root.add(box(1.05, .78, .42, regThemeMat(std(0xdfe4e2, { roughness: .6 }), { color: 0x26343b }), p[0], p[1], -D2 / 2 - .24));
      root.add(box(.62, .05, .3, regThemeMat(std(0x9aa5a6, { roughness: .5, metalness: .4 }), { color: 0x3d4d55 }), p[0], p[1] - .42, -D2 / 2 - .24));
    });
  }

  /* ---------------- 屋顶光伏阵列 ---------------- */
  function buildArray(glassMat) {
    const T = THREE_();
    const arrGroup = new T.Group();
    arrGroup.userData.key = 'array';              /* 点阵列可弹明细卡 */
    root.add(arrGroup);
    const railMat = regThemeMat(new T.MeshStandardMaterial({ color: 0x9fb0b6, roughness: .42, metalness: .72, envMapIntensity: .6 }),
      { color: 0x55666e, envMapIntensity: .8 });
    const legMat = regThemeMat(std(0x8b9aa0, { roughness: .5, metalness: .6, envMapIntensity: .5 }),
      { color: 0x46565d, envMapIntensity: .7 });
    const legXs = [-(rowW / 2 - .5), -rowW / 6, rowW / 6, rowW / 2 - .5];
    const yMod = rowPlaneY(0);
    const yRailF = rowPlaneY(RAIL_Z) - RAIL_DROP, yRailR = rowPlaneY(-RAIL_Z) - RAIL_DROP;
    const hLegF = yRailF - .03 - roofY, hLegR = yRailR - .03 - roofY;
    const legGeoF = new T.BoxGeometry(.09, hLegF, .09), legGeoR = new T.BoxGeometry(.09, hLegR, .09);
    /* 组件 / 导轨 / 竖撑全部合批成 InstancedMesh：
       原来是 176 个 Mesh，组件还按 6 个材质分组（480 次绘制），阴影再画一遍——
       光阵列就要上千次 draw call，弱一点的机器直接卡成幻灯片 */
    const modInst = new T.InstancedMesh(new T.BoxGeometry(MW, MT, MD), glassMat, rowZs.length * COLS);
    const railInst = new T.InstancedMesh(new T.BoxGeometry(rowW + .5, .06, .12), railMat, rowZs.length * 2);
    const legInstF = new T.InstancedMesh(legGeoF, legMat, rowZs.length * legXs.length);
    const legInstR = new T.InstancedMesh(legGeoR, legMat, rowZs.length * legXs.length);
    modInst.castShadow = modInst.receiveShadow = true;
    railInst.castShadow = railInst.receiveShadow = true;
    legInstF.castShadow = legInstR.castShadow = true;
    const mtx = new T.Matrix4();
    let mi = 0, ri = 0, li = 0;
    rowZs.forEach(function (rz) {
      for (let c = 0; c < COLS; c++) {
        mtx.makeRotationX(TILT);
        mtx.setPosition(-rowW / 2 + MW / 2 + c * (MW + .06), yMod, rz);
        modInst.setMatrixAt(mi++, mtx);
      }
      /* 两根通长导轨（顶面贴组件底面） */
      [[RAIL_Z, yRailF], [-RAIL_Z, yRailR]].forEach(function (r) {
        mtx.makeRotationX(TILT);
        mtx.setPosition(0, r[1], rz + r[0]);
        railInst.setMatrixAt(ri++, mtx);
      });
      /* 竖撑：前后各 4 根，顶到导轨底面 */
      legXs.forEach(function (x) {
        mtx.makeTranslation(x, roofY + hLegF / 2, rz + RAIL_Z);
        legInstF.setMatrixAt(li, mtx);
        mtx.makeTranslation(x, roofY + hLegR / 2, rz - RAIL_Z);
        legInstR.setMatrixAt(li, mtx);
        li++;
      });
    });
    modInst.instanceMatrix.needsUpdate = true;
    railInst.instanceMatrix.needsUpdate = true;
    legInstF.instanceMatrix.needsUpdate = true;
    legInstR.instanceMatrix.needsUpdate = true;
    arrGroup.add(modInst, railInst, legInstF, legInstR);
    /* 检修走道（中间两排之间）+ 屋面线槽。走道/线槽比阵列略长一截，
       长出量收到女儿墙内侧（±6.35）以内：原来 +1.2/+1.6 在窄屋面上会穿进女儿墙 */
    arrGroup.add(box(rowW + .8, .04, 1.5, regThemeMat(std(0xadb2a9, { roughness: .9, envMapIntensity: .14 }), { color: 0x26343b, envMapIntensity: .3 }), 0, roofY + .02, 0));
    const trayMat = regThemeMat(std(0x9aa5a6, { roughness: .45, metalness: .6, envMapIntensity: .5 }), { color: 0x3d4d55, envMapIntensity: .7 });
    arrGroup.add(box(rowW + .6, .05, .34, trayMat, 0, roofY + .30, 0));
    arrGroup.add(box(rowW + .6, .09, .05, trayMat, 0, roofY + .345, -.17));
    arrGroup.add(box(rowW + .6, .09, .05, trayMat, 0, roofY + .345, .17));
    /* 组串电缆：沿屋面从走道引到 4 排阵列的前导轨底面（走板下方，不碰组件） */
    const cableMat = std(0x22343c, { roughness: .6, metalness: .3 });
    [[-4.2, -2.55], [-1.4, -1.05], [1.4, 1.05], [4.2, 2.55]].forEach(function (d) {
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
  function cabFrontTexture(t) {
    const night = (t || theme) === 'night';
    return tex(function (g, w, h) {
      g.fillStyle = night ? '#dfe5e6' : '#e9edee'; g.fillRect(0, 0, w, h);
      g.strokeStyle = night ? 'rgba(46,230,200,.34)' : 'rgba(96,116,120,.45)'; g.lineWidth = 3; g.strokeRect(8, 8, w - 16, h - 16);
      g.fillStyle = night ? 'rgba(198,208,210,.95)' : 'rgba(206,216,218,.95)'; g.fillRect(16, 16, w - 32, 54);            /* 顶部空调段 */
      g.strokeStyle = night ? 'rgba(46,230,200,.24)' : 'rgba(96,116,120,.35)'; g.strokeRect(16, 16, w - 32, 54);
      for (let i = 0; i < 5; i++) { g.fillStyle = night ? 'rgba(46,230,200,.13)' : 'rgba(96,116,120,.25)'; g.fillRect(26, 25 + i * 9, w - 52, 3); }
      g.strokeStyle = night ? 'rgba(46,230,200,.45)' : 'rgba(70,96,100,.5)'; g.lineWidth = 4;
      g.beginPath(); g.moveTo(w / 2, 84); g.lineTo(w / 2, h - 20); g.stroke();          /* 门缝 */
      g.lineWidth = 2; g.strokeStyle = night ? 'rgba(46,230,200,.2)' : 'rgba(96,116,120,.3)';
      g.strokeRect(20, 90, w / 2 - 30, h - 122); g.strokeRect(w / 2 + 10, 90, w / 2 - 30, h - 122);
      g.fillStyle = night ? 'rgba(46,230,200,.5)' : 'rgba(52,86,88,.55)'; g.fillRect(w / 2 - 20, h / 2 - 12, 6, 36); g.fillRect(w / 2 + 14, h / 2 - 12, 6, 36);
      g.fillStyle = night ? 'rgba(46,230,200,.42)' : 'rgba(16,160,138,.5)'; g.fillRect(24, h - 36, 74, 11);              /* 铭牌 */
      g.fillStyle = night ? 'rgba(255,176,32,.6)' : 'rgba(224,148,16,.6)'; g.fillRect(w - 98, h - 36, 74, 11);          /* 警示条 */
    }, 256, 320, 2);
  }
  function cabSideTexture(t) {
    const night = (t || theme) === 'night';
    return tex(function (g, w, h) {
      g.fillStyle = night ? '#dfe5e6' : '#e2e7e8'; g.fillRect(0, 0, w, h);
      g.strokeStyle = night ? 'rgba(46,230,200,.18)' : 'rgba(96,116,120,.22)'; g.lineWidth = 2;
      for (let i = 1; i < 4; i++) { const x = i * w / 4; g.beginPath(); g.moveTo(x, 6); g.lineTo(x, h - 6); g.stroke(); }
      g.strokeStyle = night ? 'rgba(46,230,200,.26)' : 'rgba(96,116,120,.3)'; g.strokeRect(6, 6, w - 12, h - 12);
      for (let i = 0; i < 9; i++) { g.fillStyle = night ? 'rgba(46,230,200,.14)' : 'rgba(96,116,120,.28)'; g.fillRect(18, h - 72 + i * 7, w - 36, 3); }
    }, 256, 320, 2);
  }
  let cabLabelEl = null, cabSocBars = [], cabLed = null, cabGlow = null;
  function buildStorageCabinet() {
    const T = THREE_();
    const g = new T.Group();
    g.userData.key = 'storage';
    g.position.set(CAB_X, 0, CAB_Z);
    /* 柜门朝南（+z）：柜子独立站在场坪上、不再靠墙，门正对院子和默认机位 */
    g.rotation.y = 0;
    const W = CAB_W, H = CAB_H, D = CAB_D;
    /* 混凝土基础台：柜体直接落在网格上看着"没生根" */
    g.add(box(W + .42, .16, D + .42, regThemeMat(std(0x9aa3a6, { roughness: .92 }), { color: 0x2a3a40 }, { color: 0x3b4a4f }), 0, .08, 0));
    const steel = regThemeMat(std(0xc6ccce, { roughness: .45, metalness: .55, envMapIntensity: .6 }), { color: 0x46565d, envMapIntensity: .8 });
    const dark = std(0x22333a, { roughness: .5, metalness: .5, envMapIntensity: .5 });
    const front = regThemeMat(new T.MeshStandardMaterial({ map: cabFrontTexture(theme), roughness: .5, metalness: .35, envMapIntensity: .4 }),
      { map: function (t) { return cabFrontTexture(t); }, envMapIntensity: .6 });
    const side = regThemeMat(new T.MeshStandardMaterial({ map: cabSideTexture(theme), roughness: .55, metalness: .35, envMapIntensity: .4 }),
      { map: function (t) { return cabSideTexture(t); }, envMapIntensity: .6 });
    const topMat = regThemeMat(std(0xd6dbdc, { roughness: .6, metalness: .3 }), { color: 0x2b3a42 });
    g.add(box(W + .24, .18, D + .24, dark, 0, .09, 0));                                /* 底座 */
    const body = new T.Mesh(new T.BoxGeometry(W, H, D), [side, side, topMat, side, front, side]);
    body.position.y = H / 2 + .18;
    body.castShadow = body.receiveShadow = true;
    g.add(body);
    occluders.push(body);                              /* 储能柜体：挡住它后面的浮标 */
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (c) {                        /* 四角立柱 */
      g.add(box(.1, H + .04, .1, steel, c[0] * (W / 2 - .02), H / 2 + .18, c[1] * (D / 2 - .02)));
    });
    g.add(box(W * .74, .32, D * .78, regThemeMat(std(0xdfe4e2, { roughness: .6 }), { color: 0x26343b }), 0, H + .36, 0));  /* 顶部空调 */
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
      regThemeMat(new T.MeshBasicMaterial({ color: 0x2ee6c8, transparent: true, opacity: .06, blending: T.AdditiveBlending, depthWrite: false }),
        { opacity: .11 }));
    cabGlow.rotation.x = -Math.PI / 2;
    cabGlow.position.y = .22;
    g.add(cabGlow);
    root.add(g);
    cabLabelEl = label('储能柜 · 光储一体<i>-- kW</i><em>--</em>', 'tag3d-gt', CAB_X, CAB_H + 3.9, CAB_Z);
    addCard('storage', CAB_X, CAB_H + 1.2, CAB_Z);
  }

  /* ---------------- 并网铁塔（国网风格格构塔：收腰塔身 + 三层横担 + 绝缘子串）
     本站储能要往电网卖电，线路上立一座塔比排几根电杆更像回事。
     方向和旭日东明那座塔一致：不旋转，横担沿 ±x（东西向挑出）、线路沿 ±z 穿塔。
     进线走地面电缆（从总线绕到塔基终端箱），塔上不架空中导线——按现场观感，天上不留电线。
     位置：按现场要求往北挪到和储能柜同一排（z 2.7）、并往储能柜靠（x -22，原来 -31 太靠左）——
     挪完塔基离储能柜基础台约 6.4m，和"柜子→楼"那段间距大致相当，场上设备连成一条线。
     塔基终端箱和落到塔基的电缆都跟着 TWR_X 走。 ---------------- */
  const TWR_X = -22, TWR_Z = 2.7, TWR_H = 10.4;
  const TBOX_X = TWR_X + 2.25;                 /* 塔基旁的电缆终端箱（关口线、总线都接在这里） */
  const TWR_WIRE_X = TWR_X + 2.4;              /* 地面电缆落到终端箱的那一点 */
  let twrLabelEl = null;
  function buildTower() {
    const T = THREE_();
    const g = new T.Group();
    g.position.set(TWR_X, 0, TWR_Z);
    /* 不加 rotation：与旭日东明电站的塔同向（横担沿 x，线路沿 z） */
    const hgt = TWR_H;
    const legMat = regThemeMat(std(0x6d8b93, { roughness: .55, metalness: .6 }), { color: 0x6d8b93 }, { color: 0x93a3a8 });
    const braceMat = regThemeMat(std(0x54737b, { roughness: .62, metalness: .55 }), { color: 0x54737b }, { color: 0x7d8f94 });
    const armMat = regThemeMat(std(0x2ee6c8, { emissive: 0x0a5a4a, emissiveIntensity: .35, roughness: .5, metalness: .3 }),
      { color: 0x2ee6c8, emissive: 0x0a5a4a, emissiveIntensity: .35 },
      { color: 0x18b39a, emissive: 0x000000, emissiveIntensity: 0 });
    const insMat = std(0xd8e6e4, { roughness: .35, metalness: .1 });
    /* 塔身半宽：底部宽 → 腰部收窄 → 上部略开 */
    const halfAt = function (y) {
      const t = Math.max(0, Math.min(1, y / hgt));
      const base = 1.5, waist = .62, top = .84;
      return t < .6 ? base + (waist - base) * (t / .6) : waist + (top - waist) * ((t - .6) / .4);
    };
    const P = function (x, y, z) { return new T.Vector3(x * halfAt(y), y, z * halfAt(y)); };
    /* 四个混凝土塔脚基础：原来四条腿直接落在场坪上，看着"没生根" */
    const footMat = regThemeMat(std(0x9aa3a6, { roughness: .92 }), { color: 0x2a3a40 }, { color: 0x3b4a4f });
    [[1.5, 1.5], [1.5, -1.5], [-1.5, 1.5], [-1.5, -1.5]].forEach(function (p) {
      const ft = box(.72, .5, .72, footMat, p[0], .25, p[1]);
      g.add(ft);
    });
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
    /* 三层横担（每层左右各一挑）+ 端部下挂绝缘子串。
       本站进线走地面电缆（见 buildEquipment 的电缆敷设），塔上不再架空中导线 */
    const ARMS = [[6.6, 3.0], [7.8, 2.7], [9.0, 2.4]];
    ARMS.forEach(function (a) {
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
      });
    });
    /* 塔顶地线支架（结构件，保留塔顶轮廓） */
    const tw = halfAt(hgt);
    member(new T.Vector3(-tw, hgt, 0), new T.Vector3(0, hgt + .9, 0), legMat, .04);
    member(new T.Vector3(tw, hgt, 0), new T.Vector3(0, hgt + .9, 0), legMat, .04);
    g.add(box(tw * 2.6, .06, .06, braceMat, 0, hgt + .55, 0));
    /* 塔顶航空障碍灯：红点 + 加色光晕，呼吸闪烁（给暗色画面一个活点） */
    beacon = new T.Mesh(new T.SphereGeometry(.13, 10, 10),
      new T.MeshBasicMaterial({ color: 0xff5a3c, transparent: true, opacity: .9, fog: false }));
    beacon.position.set(0, hgt + 1.06, 0);
    g.add(beacon);
    beaconGlow = new T.Sprite(new T.SpriteMaterial({
      map: radialGlowTexture(), color: 0xff5a3c, transparent: true, opacity: .5,
      blending: T.AdditiveBlending, depthWrite: false, fog: false
    }));
    beaconGlow.position.copy(beacon.position);
    beaconGlow.scale.set(2.6, 2.6, 1);
    g.add(beaconGlow);
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
    const steel = regThemeMat(std(0xc6ccce, { roughness: .45, metalness: .55, envMapIntensity: .6 }), { color: 0x46565d, envMapIntensity: .8 });
    const dark = std(0x22333a, { roughness: .5, metalness: .5, envMapIntensity: .5 });
    const finMat = regThemeMat(std(0xa7b1b3, { roughness: .4, metalness: .6, envMapIntensity: .5 }), { color: 0x4a5b63, envMapIntensity: .7 });
    /* ---------- 逆变器（挂北墙，正面朝北） ----------
       现场口径：逆变器不走电线（光伏那一路从屋面下来直接进场坪），也不挂浮标 / 明细卡——
       跟通信模块一样只留设备本体。
       位置从西墙挪到北墙（楼背面）：西墙现在被光伏支线整条占着（那条线从女儿墙套管直落到
       地面），机位是西南方向平视，同一面墙上的箱体和竖线在屏幕上必然叠在一起（这台机位下
       沿墙方向的位移只有 ~5px/m），挂上去看着就像"线又接回逆变器"——挪到背面两个问题一起没了；
       默认视角看不到它，转视角才看得到。北墙没有一层窗（只有两台空调外机，在 x ±4.2），
       所以放在西头 x -5.7，避开空调 */
    const invG = new T.Group();
    invG.position.set(-5.7, 0, -D2 / 2);
    invG.rotation.y = Math.PI / 2;                /* 柜体整体转向：门面朝北（墙外） */
    invG.add(box(.07, 1.66, 1.28, regThemeMat(std(0x8f9a9c, { roughness: .5, metalness: .5 }), { color: 0x2c3d45 }), .035, 2.18, 0));
    invG.add(box(.36, 1.5, 1.1, dark, .26, 2.18, 0));
    invG.add(box(.04, 1.56, 1.16, regThemeMat(std(0xb9c2c4, { roughness: .4, metalness: .5 }), { color: 0x33454d, envMapIntensity: .7 }), .44, 2.18, 0));
    for (let i = 0; i < 5; i++) invG.add(box(.03, 1.24, .1, finMat, .12 + i * .09, 2.18, -.575));   /* 背面散热齿 */
    invG.add(box(.03, .52, .62, std(0x0a1418, { roughness: .3, metalness: .4 }), .465, 2.46, 0));  /* 显示屏 */
    invG.add(box(.03, .16, .22, std(0xd9b23a, { roughness: .5 }), .465, 1.95, -.34));             /* 隔离开关 */
    invG.add(box(.02, .1, .4, regThemeMat(std(0xd8dee0, { roughness: .6 }), { color: 0x8f9aa0 }), .465, 1.8, .22));                 /* 铭牌 */
    root.add(invG);
    /* 不加浮标、不给明细卡（现场要求，与通信模块一致）：场上只留本体 */

    /* ---------- 通信模块（立杆）——同样按现场要求移到左侧 ---------- */
    root.add(cyl(.07, .09, 3.4, steel, -W2 / 2 - 2.2, 1.7, -2.6, 10));
    root.add(box(.5, .56, .36, regThemeMat(std(0xe8eef0, { roughness: .5, envMapIntensity: .5 }), { color: 0x2b3a42, envMapIntensity: .6 }), -W2 / 2 - 2.2, 3.05, -2.6));
    root.add(box(.52, .05, .38, regThemeMat(std(0xc2ccce, { roughness: .5, metalness: .5 }), { color: 0x3a4b53 }), -W2 / 2 - 2.2, 3.34, -2.6));
    root.add(cyl(.022, .022, .8, steel, -W2 / 2 - 2.2, 3.76, -2.6, 6));
    /* 通信模块不加浮标（现场要求）：杆子本身留着，不再挂文字 */

    /* 关口电缆走地面：从总线绕到塔基终端箱，沿弧线敷设（混凝土电缆墩托着）。
       原来这里是「电杆 + 三跨空中导线」，按现场观感改成地面敷设，空中不再有电线 */
    const G_CY = .36;                                             /* 电缆中心离场坪的高度 */
    const saddleMat = std(0x5a6a70, { roughness: .85, envMapIntensity: .2 });
    for (let i = 1; i <= 4; i++) {                                /* 电缆墩：沿弧线每 ~1.5m 一个 */
      const p = grdPoint(i / 5);
      root.add(box(.16, .12, .16, saddleMat, p[0], .24, p[1]));
    }
    /* 总线沿线（负载支线东段 + 关口支线西段）托四个墩（墩顶 0.22，电缆中心 0.29） */
    [[-8.1, .66], [-9.4, .70], [-12.9, .84], [-14.8, 1.06]].forEach(function (p) {
      root.add(box(.14, .1, .14, saddleMat, p[0], .17, p[1]));
    });
    /* 储能支线从总线往南进柜，托一个墩 */
    root.add(box(.14, .1, .14, saddleMat, TAP_X - .15, .17, 1.35));
    /* 电网直供线（塔基 → 卫生院）沿院子前沿（南侧走廊）那段，托五个墩 */
    [[-19.4, 3.28], [-17.3, 3.62], [-14.6, 3.87], [-11.8, 3.87], [-9.4, 3.81]].forEach(function (p) {
      root.add(box(.14, .1, .14, saddleMat, p[0], .17, p[1]));
    });
    /* T 型接口那一点放一个稍大的墩当"落点"（不摆任何箱子） */
    root.add(box(.22, .1, .22, saddleMat, TAP_X, .17, BUS_Z));
    /* 铁塔基座旁的电缆终端箱（地面电缆从这里进塔） */
    const tbox = new T.Group();
    tbox.position.set(TBOX_X, 0, TWR_Z);
    tbox.add(box(.72, .1, .62, std(0x2b3a42, { roughness: .9 }), 0, .23, 0));
    tbox.add(box(.6, .72, .5, regThemeMat(std(0xb9c2c4, { roughness: .5, metalness: .35 }), { color: 0x33454d }), 0, .64, 0));
    tbox.add(box(.66, .06, .56, std(0x2b3a42, { roughness: .6, metalness: .4 }), 0, 1.03, 0));
    root.add(tbox);
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
    root.add(new THREE.Mesh(new THREE.TubeGeometry(curve, seg, (radius || .05) * 2.4, 8, false), tubeMat));
    flows.push({ map: tubeMat.map, tubeMat: tubeMat, kind: kind, on: false, speed: 0, dir: 1, tint: 0 });
  }

  /* ---------------- 默认机位（构图） ----------------
     机位只固定"目标点 + 视线方向"（正南偏西 10°、抬高约 25° 俯视），距离用二分法算：
     把「铁塔 → 储能柜 → 小楼（屋顶阵列 + 浮标）」这些关键点全部收进画面
     （落在中心 ±70% / ±68% 以内）。体量收成 13×8 的紧凑厂房块之后，原来 34/19/40
     那个定死的机位离得太远、留白一大片；而宽高比一变，同样的机位又会裁掉铁塔——
     距离必须跟着画布算（旭日东明那套用的就是这个办法，这里照搬）。
     方位取"南偏西 10°"而不是原来的南偏东：站东南方向看，楼的西墙整面被自己压住，
     西墙外的逆变器 / 通信模块和场坪上的储能柜也都在楼盘后侧；偏西 10° 之后
     西墙露出一截、场坪上的柜体整个落在楼前侧，同时楼立面在屏幕上的宽高比 1.99，
     跟旭日东明厂房（2.06）基本一致 */
  const FIT_X = .70, FIT_Y = .68;
  let fitCam = null;
  function fitDistance(tgt, dir, pts, aspect) {
    if (!fitCam) {
      if (typeof THREE === 'undefined' || !THREE.PerspectiveCamera) return 46;
      fitCam = new THREE.PerspectiveCamera(46, 1, .1, 900);
    }
    let lo = 14, hi = 120, best = hi;
    for (let i = 0; i < 26; i++) {
      const mid = (lo + hi) / 2;
      fitCam.position.copy(tgt).add(dir.clone().multiplyScalar(mid));
      fitCam.lookAt(tgt);
      fitCam.aspect = aspect;
      fitCam.updateMatrixWorld(true);
      fitCam.updateProjectionMatrix();
      let ok = true;
      for (let k = 0; k < pts.length; k++) {
        const v = pts[k].clone().project(fitCam);
        if (Math.abs(v.x) > FIT_X || Math.abs(v.y) > FIT_Y) { ok = false; break; }
      }
      if (ok) { best = mid; hi = mid; } else { lo = mid; }
    }
    return best;
  }
  /* 关键点取全场最外沿：小楼四角与女儿墙顶、屋上两个浮标、场坪上的储能柜（含浮标）、
     铁塔塔脚到塔尖。这样"光伏 → 储能 → 电网"这条线无论画布什么比例都不会被裁头去尾。
     逆变器不挂浮标、且本体缩在楼体轮廓内（西墙上），所以不再单列关键点 */
  function fitStory() {
    const T = THREE_();
    const tgt = new T.Vector3(-11.5, 2.6, 1.0);
    const dir = new T.Vector3(-7, 19, 40).normalize();   /* 南偏西 10°、俯角 25° */
    const pts = [
      new T.Vector3(W2 / 2 + .3, 0, D2 / 2 + .3), new T.Vector3(W2 / 2 + .3, roofY + .5, D2 / 2 + .3),
      new T.Vector3(-W2 / 2 - .3, roofY + .5, D2 / 2 + .3), new T.Vector3(-W2 / 2 - .3, 0, -D2 / 2 - .3),
      new T.Vector3(W2 / 2 + .3, 0, -D2 / 2 - .3),
      new T.Vector3(0, roofY + 3.6, 0),                       /* 屋顶阵列浮标 */
      new T.Vector3(CAB_X - 1, 0, CAB_Z + CAB_W / 2),
      new T.Vector3(CAB_X, CAB_H + 3.9, CAB_Z),               /* 储能柜浮标 */
      new T.Vector3(TWR_X, 0, TWR_Z), new T.Vector3(TWR_X, TWR_H + 1.1, TWR_Z),
      new T.Vector3(TWR_X, TWR_H - .6, TWR_Z)                 /* 铁塔浮标 */
    ];
    const host = document.getElementById('solar3d');
    const aspect = (host && host.clientHeight) ? host.clientWidth / host.clientHeight : 1.9;
    const len = fitDistance(tgt, dir, pts, aspect);
    return { pos: tgt.clone().add(dir.clone().multiplyScalar(len)), tgt: tgt };
  }

  /* ---------------- 主搭建 ---------------- */
  function build() {
    const T = THREE_();
    scene = new T.Scene();
    theme = document.documentElement.getAttribute('data-theme') === 'day' ? 'day' : 'night';

    /* 天空：渐变穹顶（背景交给穹顶，雾色取地平线色） */
    const tp = THEMES[theme] || THEMES.night;
    skyDome = new T.Mesh(new T.SphereGeometry(210, 28, 18),
      new T.MeshBasicMaterial({ map: skyTexture(tp.sky), side: T.BackSide, depthWrite: false, fog: false }));
    skyDome.renderOrder = -1;
    scene.add(skyDome);
    scene.fog = new T.Fog(tp.fog.color, tp.fog.near, tp.fog.far);

    camera = new T.PerspectiveCamera(46, 1, .1, 900);
    /* 构图：机位按当前画布算（见 fitStory），把「并网铁塔 → 储能柜 →
       两层小楼（屋顶光伏阵列）」从左到右完整收进画面，重置视角也回这个位 */
    camHome = fitStory();
    camera.position.copy(camHome.pos);

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
      controls.target.copy(camHome.tgt);       /* 必须和机位用同一个目标点，否则 update() 会把镜头重新瞄偏 */
      controls.update();
    }
    bindPick();

    root = new T.Group();
    scene.add(root);

    hemi = new T.HemisphereLight(tp.lights.hemi.sky, tp.lights.hemi.ground, tp.lights.hemi.base);
    scene.add(hemi);
    sunLight = new T.DirectionalLight(tp.lights.key.color, tp.lights.key.base);
    sunLight.position.set(34, 40, 22);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(2048, 2048);
    const sc = sunLight.shadow.camera;
    sc.left = -58; sc.right = 58; sc.top = 58; sc.bottom = -58; sc.near = 1; sc.far = 220;
    sunLight.shadow.bias = -0.0009;
    scene.add(sunLight);
    fillLight = new T.DirectionalLight(tp.lights.fill.color, tp.lights.fill.intensity);
    fillLight.position.set(-24, 14, -18);
    scene.add(fillLight);
    /* 阴影贴图只渲一次：太阳位置和设备都不动，没必要每帧把全场景再画一遍进阴影图
       （这是整帧里最贵的一趟，冻结之后相机怎么转都不影响阴影） */
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;

    /* 场地 / 建筑 / 组件 / 设备 */
    buildSite();
    buildBuilding();
    /* 玻璃板面：压掉天空反射（原来 envMapIntensity .9 + 高金属度，整片阵列被反光提亮成浅蓝），
       现在近黑深蓝，只有发电时才透出一点深蓝 */
    /* 现场是黑色组件：底色压到近黑，靠纹理里的栅格高光表现玻璃面 */
    const glassMat = new T.MeshStandardMaterial({
      map: panelTexture(), color: 0x33383c, roughness: .32, metalness: .5,
      emissive: new T.Color(0x0a0d10), emissiveIntensity: .1, envMapIntensity: .38
    });
    panelMats.push(glassMat);
    buildArray(glassMat);
    buildTower();
    buildEquipment();
    buildStorageCabinet();
    buildWalkers();               /* 院内走动的人（抽象小人） */

    /* ---------- 能量流 ----------
       画法：场坪上先有一条"总线"——从楼西墙根往西、贴柜子北侧、到铁塔终端箱；
       光伏从屋面下来的那条线落在总线东头，储能支线在 TAP_X 处从总线上以 T 型分出去。
       这样只有一个分叉点、且是"横线 + 竖支"的 T 型，不会看成两线交叉：
         · 光伏支线（东头）  屋面组串 → 西墙直落 → 总线东头
         · 负载支线（东段）  总线东头 → 卫生院（进西墙，谁供院上谁的颜色）
         · 关口支线（西段）  总线 → 贴柜子北侧 → 电缆墩弧线 → 铁塔终端箱（卖电黄 / 取电蓝）
         · 储能支线（T 支）  TAP_X ↔ 储能柜东面（充电进柜、放电出柜）
       逆变器不接线，所以它不在任何一条线的端点上 */
    /* 光伏支线（屋面组串 → 总线东头）：屋面线槽 → 女儿墙套管 → 沿西墙**直着**下来 → 落到墙根。
       中间不再往南绕：原来为了躲二层窗带（z -3.8~3.8）先走到窗带东头 z≈3.9 再折回来，
       墙上就打出一个 S 弯。现在贴着墙外的电缆通道（x 墙外 0.36）直落，正好从二层窗带
       两条窗（z ±0.725 起）中间的竖挺位置过——线在玻璃面以外 0.19m，不压窗也不打弯 */
    addFlow([
      new T.Vector3(rowW / 2 + .2, roofY + .40, 0),            /* 起点落在屋面线槽里（原来出槽口 0.1m，悬空） */
      new T.Vector3(3.2, roofY + .42, 0),
      new T.Vector3(-3.2, roofY + .42, .1),
      new T.Vector3(-W2 / 2 - .08, roofY + .42, .55),          /* 穿女儿墙套管 */
      new T.Vector3(-W2 / 2 - .36, 6.95, .55),                 /* 出了套管挪到墙外（女儿墙外侧 0.36） */
      new T.Vector3(-W2 / 2 - .36, 6.6, .55),                  /* 直着往下（檐口高度以下） */
      new T.Vector3(-W2 / 2 - .36, 4.6, .55),                  /* 贴着二层窗带的竖挺位置过（玻璃面 -6.67 以外） */
      new T.Vector3(-W2 / 2 - .4, 2.6, .55),                   /* 越过腰线（墙外 0.4） */
      new T.Vector3(-W2 / 2 - .42, 1.05, .55),                 /* 下到勒脚上沿 */
      new T.Vector3(-7.05, .40, .58)                           /* 翻过勒脚下沿、落到总线东头 */
    ], 'pv', .07);
    /* 过墙套管（电缆从套管中间穿出女儿墙，避免穿模） */
    root.add(box(.7, .2, .2, regThemeMat(std(0x9aa5a6, { roughness: .5, metalness: .5 }), { color: 0x3d4d55 }), -W2 / 2 - .06, roofY + .42, .55));
    /* 负载支线（总线东段：总线 → 卫生院）：从墙根抬起来进楼，谁在供院就上谁的颜色：
       储能放电=青绿 / 光伏出力=黄 / 纯电网=蓝。这条就是"卫生院那根"——总线东头进墙 */
    addFlow([
      new T.Vector3(TAP_X, .29, BUS_Z),                          /* 总线上 T 型接口以东 */
      new T.Vector3(-9.3, .29, .70),                             /* 沿柜子北侧往东（墩上） */
      new T.Vector3(-7.9, .32, .62),
      new T.Vector3(-W2 / 2 - .45, .40, .58),                    /* 越过勒脚 */
      new T.Vector3(-W2 / 2 - .25, 1.02, .55),                   /* 贴墙根抬起来（越过深色基座带上沿） */
      new T.Vector3(-W2 / 2 + .08, 1.05, .55)                    /* 进楼（端点藏在墙里）＝卫生院进线点 */
    ], 'load', .063);
    /* 储能支线（T 型接口 → 储能柜东面）：TAP_X 处从总线上分出去、往南进柜；
       充电时电流从总线流进柜子，放电时反过来（方向与颜色见 updateEnergyFlows） */
    addFlow([
      new T.Vector3(TAP_X, .29, BUS_Z),
      new T.Vector3(TAP_X - .1, .32, 1.25),                       /* 往南（骑过柜子基础台北沿） */
      new T.Vector3(TAP_X - .2, .40, 1.70),
      new T.Vector3(TAP_X - .3, .50, 2.05)                        /* 进柜体东面 */
    ], 'stor', .07);
    /* 关口支线（总线西段 → 铁塔）：从 T 型接口往西贴柜子北侧、拐上电缆墩那条弧线到塔基终端箱；
       卖电时方向 → 塔、从电网取电时塔 → 总线，由 updateEnergyFlows 按关口净额定 */
    addFlow([
      new T.Vector3(TAP_X, .29, BUS_Z),
      new T.Vector3(-12.9, .30, .82),                            /* 贴柜子北侧过（基础台北沿 1.64） */
      new T.Vector3(-14.8, .32, 1.05),
      new T.Vector3(GRD_X0, .36, GRD_Z0),                        /* 落到墩线上 */
      new T.Vector3(grdPoint(.25)[0], .36, grdPoint(.25)[1]),    /* 沿弧线（和电缆墩同一条线） */
      new T.Vector3(grdPoint(.5)[0], .36, grdPoint(.5)[1]),
      new T.Vector3(grdPoint(.75)[0], .36, grdPoint(.75)[1]),
      new T.Vector3(TWR_WIRE_X, .38, TWR_Z)                      /* 铁塔基座终端箱 */
    ], 'grid', .068);
    /* 电网直供线（铁塔 → 卫生院）：现场口径"电塔要有一根直通卫生院供电的"。
       总线和储能都走场坪北侧，这条就走南侧那条空走廊：出塔基终端箱 → 从储能柜南侧过去
       （基础台南沿 3.76）→ 沿院子前沿 → 楼西南角西墙根 z≈3.88 进楼。
       两条走廊一北一南，跟总线、储能支线都不交叉；只有从电网取电时才亮（蓝） */
    addFlow([
      new T.Vector3(TBOX_X - .15, .38, 3.00),                    /* 塔基终端箱南侧出线 */
      new T.Vector3(-18.6, .36, 3.35),
      new T.Vector3(-16.8, .34, 3.68),
      new T.Vector3(-14.6, .32, 3.88),                           /* 从柜子南侧过（出基础台外沿 0.12） */
      new T.Vector3(-11.0, .30, 3.86),
      new T.Vector3(-8.5, .29, 3.82),
      new T.Vector3(-W2 / 2 - .45, .38, 3.84),                   /* 越过勒脚（贴着楼西南角走） */
      new T.Vector3(-W2 / 2 - .25, 1.00, 3.86),                  /* 贴墙根抬起来 */
      new T.Vector3(-W2 / 2 + .08, 1.03, 3.88)                   /* 进楼（端点藏在墙里）＝电网直供进线点 */
    ], 'gl', .065);

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
    const cloudMat = new T.MeshBasicMaterial({ color: tp.cloud, transparent: true, opacity: .0 });
    for (let i = 0; i < 9; i++) {
      const cg = new T.Group();
      for (let k = 0; k < 4; k++) {
        const s = new T.Mesh(new T.SphereGeometry(2.6 + Math.random() * 2.2, 10, 10), cloudMat.clone());
        s.position.set(k * 3.1 - 4.4, Math.random() * 1.2, Math.random() * 2.4 - 1.2);
        s.material.opacity = .7 + Math.random() * .25;
        cloudMats.push(s.material);
        cg.add(s);
      }
      cg.position.set((Math.random() - .5) * 140, 42 + Math.random() * 16, (Math.random() - .5) * 120);
      cg.userData.speed = .35 + Math.random() * .5;
      cloudGroup.add(cg);
    }
    root.add(cloudGroup);

    /* 降水：420 滴合批成一个 InstancedMesh（原来是 420 个独立 Mesh） */
    rainMat = new T.MeshBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: .5 });
    rainInst = new T.InstancedMesh(new T.CylinderGeometry(.022, .022, .9, 4), rainMat, RAIN_N);
    rainInst.visible = false;
    rainInst.frustumCulled = false;                /* 位置每帧改，包围盒不跟着走 */
    const rm = new T.Matrix4();
    for (let i = 0; i < RAIN_N; i++) {
      rainX[i] = (Math.random() - .5) * 80;
      rainY[i] = Math.random() * 30 + 2;
      rainZ[i] = (Math.random() - .5) * 70;
      rainV[i] = 2.4 + Math.random() * 2;          /* 与原来每滴的落速区间一致 */
      rm.makeTranslation(rainX[i], rainY[i], rainZ[i]);
      rainInst.setMatrixAt(i, rm);
    }
    rainInst.instanceMatrix.setUsage(T.DynamicDrawUsage);
    root.add(rainInst);

    /* ---------- 场景浮标 ---------- */
    arrLabelEl = label('屋顶光伏阵列<i>-- kW</i><em>装机 110.16 kWp</em>', 'tag3d-gt', 0, roofY + 3.6, 0);
    /* 站名牌（"洙边卫生院"）不挂了：楼在那、阵列浮标已经点出这是哪一站 */

    /* 后期处理：MSAA + 泛光（只让日光、电流光纹这类高亮点发光）+ 暗角冷调
       暗角 pass 是"高级感"的关键一步：压住四角、让画面中心聚焦到设备上 */
    if (typeof T.EffectComposer === 'function' && T.RenderPass && T.UnrealBloomPass) {
      try {
        const w = host.clientWidth || 800, h = host.clientHeight || 480;
        const msaa = (typeof T.WebGLMultisampleRenderTarget === 'function')
          ? new T.WebGLMultisampleRenderTarget(w, h, { format: T.RGBAFormat })
          : null;
        composer = new T.EffectComposer(renderer, msaa || undefined);
        if (msaa) composer.setPixelRatio(renderer.getPixelRatio());
        composer.addPass(new T.RenderPass(scene, camera));
        /* 泛光按半分辨率跑：模糊效果肉眼看不出差别，但填充率省 4 倍——
           高 DPI 屏（DPR 2）上这是拖动卡顿的大头 */
        bloomPass = new T.UnrealBloomPass(new T.Vector2(w * .5, h * .5),
          tp.bloom.strength, tp.bloom.radius, tp.bloom.threshold);
        composer.addPass(bloomPass);
        if (typeof T.ShaderPass === 'function') {
          vigPass = new T.ShaderPass({
            uniforms: {
              tDiffuse: { value: null },
              strength: { value: tp.vignette.strength },
              tint: { value: tp.vignette.tint }
            },
            vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
            fragmentShader: [
              'uniform sampler2D tDiffuse; uniform float strength; uniform float tint; varying vec2 vUv;',
              'void main(){',
              '  vec4 c = texture2D(tDiffuse, vUv);',
              '  vec2 d = vUv - .5;',
              '  float r = length(d) * 1.42;',
              '  c.rgb *= clamp(1.0 - strength * pow(max(r - .26, 0.0), 2.1), 0.0, 1.0);',
              '  c.b *= 1.0 + tint; c.r *= 1.0 - tint * .5;',
              '  gl_FragColor = c;',
              '}'
            ].join('\n')
          });
          composer.addPass(vigPass);
        }
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

  /* ---------------- 主题（页面白天 / 夜晚） ----------------
     场景跟着页面主题走：夜=暗色数字孪生（深底 + 青调 + 发光强调），昼=浅色可读 */
  function applyTheme() {
    theme = document.documentElement.getAttribute('data-theme') === 'day' ? 'day' : 'night';
    const p = THEMES[theme] || THEMES.night;
    if (skyDome) {
      const old = skyDome.material.map;
      skyDome.material.map = skyTexture(p.sky);
      skyDome.material.needsUpdate = true;
      if (old) old.dispose();
      refreshEnv();
    }
    /* 地面 / 场坪贴图重画（夜：深底 + 青格网；昼：浅色水泥 + 淡格线） */
    if (groundMat) {
      const old = groundMat.map;
      groundMat.map = concreteTexture();
      groundMat.map.repeat.set(47, 47);
      groundMat.needsUpdate = true;
      if (old) old.dispose();
    }
    if (slabYardMat) {
      const old = slabYardMat.map;
      slabYardMat.map = slabTexture(theme);
      slabYardMat.map.repeat.set(4, 58 / 24);
      slabYardMat.needsUpdate = true;
      if (old) old.dispose();
    }
    themeMats.forEach(applyThemeMat);
    if (sweepMesh) sweepMesh.material.opacity = p.sweep;
    cloudMats.forEach(function (m) { m.color.setHex(p.cloud); });
    if (scene && scene.fog) {
      scene.fog.color.setHex(p.fog.color);
      scene.fog.near = p.fog.near;
      scene.fog.far = p.fog.far;
    }
    if (bloomPass) {
      bloomPass.strength = p.bloom.strength;
      bloomPass.radius = p.bloom.radius;
      bloomPass.threshold = p.bloom.threshold;
    }
    if (vigPass) {
      vigPass.uniforms.strength.value = p.vignette.strength;
      vigPass.uniforms.tint.value = p.vignette.tint;
    }
    refreshSkyLight();
  }

  /* ---------------- 天气 / 功率 ---------------- */
  function refreshSkyLight() {
    const p = THEMES[theme] || THEMES.night;
    const cloud = Math.max(0, Math.min(100, Number(cur.cloud) || 0));
    const rad = Math.max(0, Number(cur.radiation) || 0);
    const day = !!cur.isDay;                      /* 真实昼夜：只决定太阳 / 月亮在不在 */
    const dim = 1 - cloud / 100 * .38;
    if (sunLight) {
      sunLight.color.setHex(p.lights.key.color);
      sunLight.intensity = (p.lights.key.base + (rad > 0 ? Math.min(1, rad / 950) * p.lights.key.rad : .1)) * dim;
    }
    if (hemi) {
      hemi.color.setHex(p.lights.hemi.sky);
      hemi.groundColor.setHex(p.lights.hemi.ground);
      hemi.intensity = p.lights.hemi.base * dim;
    }
    if (fillLight) {
      fillLight.color.setHex(p.lights.fill.color);
      fillLight.intensity = p.lights.fill.intensity;
    }
    if (sun) sun.visible = day;
    if (sunGlow) {
      sunGlow.visible = day;
      sunGlow.material.opacity = (theme === 'day' ? .55 : .4) * (1 - cloud / 160);
    }
    if (moon) moon.visible = !day;
    const cf = cloud / 100;
    if (cloudGroup) {
      cloudGroup.children.forEach(function (cg) {
        cg.visible = cf > .08;
        cg.children.forEach(function (s) { s.material.opacity = (theme === 'day' ? .35 : .22) + cf * (theme === 'day' ? .6 : .45); });
      });
    }
    if (rainInst) {
      rainInst.visible = Number(cur.precip) > 0;
      rainMat.opacity = cf > .5 ? .6 : .45;
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

  /* 发电功率：驱动组件发光、电流光纹流速、指示灯与浮标。
     kw 传 null / undefined = 这一路没上报（solar.js 在电站数据缺失时传 null）——
     和"真的 0 kW"分开记，供电模式才不会把"没数据"当成"光伏不发电" */
  function setPower(kw, capKw, todayKwh) {
    cur.pvSeen = kw !== null && kw !== undefined && !isNaN(Number(kw));
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
      if (fl.kind !== 'pv') return;                        /* 储能/关口/负载支线由 updateEnergyFlows 管 */
      fl.on = on;
      fl.speed = .35 + ratio * 1.9;
      /* 颜色（光伏出力=黄）由 updateEnergyFlows 定；这里只负责没出力时压回 idle 色。
         光伏线只被光伏自己驱动：不发（夜里 / 没太阳）就不动、不上色——电网往里送电时它不亮 */
      if (!fl.on) fl.tubeMat.color.setHex(p.idle);
    });
    updateEnergyFlows();
    if (arrLabelEl) arrLabelEl.innerHTML = '屋顶光伏阵列<i>' + cur.power.toFixed(2) + ' kW</i><em>今日 '
      + (cur.today === null ? '--' : cur.today.toFixed(1)) + ' 度</em>';
    /* 关口功率 / 供电模式由 updateEnergyFlows() 统一刷新（它知道储能与负载） */
    /* 明细卡内容同样跟着实时值走 */
    const todayTxt = cur.today === null ? '--' : cur.today.toFixed(1) + ' 度';
    const hoursTxt = (cur.today === null || !cur.cap) ? '--' : (cur.today / cur.cap).toFixed(2) + ' h';
    setCard('array', '屋顶光伏阵列', [
      ['当前功率', cur.power.toFixed(2) + ' kW'],
      ['今日发电', todayTxt],
      ['装机容量', Number(cur.cap).toFixed(2) + ' kWp'],
      ['等效利用小时', hoursTxt],
      ['组件排布', rowZs.length + ' 排 × ' + COLS + ' 块 · 倾角 28°']
    ], on ? ('发电中 · 出力 ' + (ratio * 100).toFixed(0) + '%') : '当前无出力');
    /* 逆变器按现场口径只留本体：不挂浮标、不给明细卡（原来那张卡上的功率就是本卡"当前功率"） */
    /* 并网点（计量箱）已去掉：关口功率 / 方向在铁塔浮标上看，供电模式看储能柜浮标和明细卡 */
  }

  /* 储能柜实时（日升云）：驱动柜体 SOC 光柱、指示灯、浮标卡片，以及充放电光纹 */
  function f1(v) { return (v === null || v === undefined || isNaN(Number(v))) ? '--' : Number(v).toFixed(1); }
  function setStorage(st) {
    if (!st) return;
    const r = st.realtime || {};
    cur.storPower = r.power_kw;
    cur.loadKw = r.load_kw;
    cur.storSoc = r.soc;
    /* 先算供电模式再渲染：模式依赖刚写进来的储能 / 负载，而下面浮标和明细卡都要用它。
       原来放在函数末尾，卡片模式行和柜顶浮标就永远慢一拍（同一张卡里功率是新的、
       模式还是上一轮的），第一轮还会空着 */
    updateEnergyFlows();
    const soc = Math.max(0, Math.min(100, Number(cur.storSoc) || 0));
    cabSocBars.forEach(function (bar) { bar.scale.y = Math.max(.02, soc / 100); });
    const dis = Number(cur.storPower) > 0, chg = Number(cur.storPower) < 0;
    const fc = FLOWC[theme] || FLOWC.night;
    const col = chg ? fc.chg : (dis ? fc.dis : 0x6f9a94);   /* 充=蓝 / 放=青绿（跟光纹同一套色） */
    if (cabLed) cabLed.material.color.setHex(col);
    if (cabGlow) cabGlow.material.color.setHex(col);
    const td = st.today || {}, dv = st.device || {};
    const brand = (dv.bcu_brand ? dv.bcu_brand : 'SYL') + ' 电池 + ' + (dv.pcs_brand === 'EJ' ? '恩玖' : (dv.pcs_brand || 'PCS'));
    if (cabLabelEl) {
      cabLabelEl.innerHTML = '储能柜 · 光储一体<i>' + f1(cur.storPower) + ' kW</i><em>'
        + (pModeNow ? (pModeNow + ' ' + pModeTxtNow) : (r.status_text || '--')) + ' · SOC ' + Math.round(soc) + '%</em>';
    }
    setCard('storage', '储能柜 · 光储一体（' + brand + '）', [
      ['当前供电模式', pModeNow ? (pModeNow + ' ' + pModeTxtNow) : '--'],
      ['SOC', Math.round(soc) + ' %'],
      ['实时功率', f1(cur.storPower) + ' kW（' + (r.status_text || '--') + '）'],
      ['卫生院负载', f1(cur.loadKw) + ' kW'],
      ['今日充电', f1(td.charge_kwh) + ' 度'],
      ['今日放电', f1(td.discharge_kwh) + ' 度'],
      ['柜内配置', brand],
      ['采样时间', String(r.time || '--').slice(11, 19)]
    ], pModeNoteNow ? pModeNoteNow                              /* 模式备注：谁给谁供电、关口在送还是在取 */
      : (Math.abs(Number(cur.storPower) || 0) > .3
        ? (dis ? '放电中（往系统送电）' : '充电中（把电存起来）') : '待机'));
    /* 铁塔明细：本站卖电/买电都走这条线 */
    const g = st.grid || {};
    setCard('tower', '并网铁塔 · 10kV 上网线路', [
      ['线路', '1# 杆塔 · 三跨导线'],
      ['今日馈电（卖电）', f1(g.feed_today_kwh) + ' 度'],
      ['累计馈电', f1(g.feed_total_kwh) + ' 度'],
      ['今日取电（买电）', f1(g.draw_today_kwh) + ' 度'],
      ['累计取电', f1(g.draw_total_kwh) + ' 度']
    ], (Number(g.feed_today_kwh) || 0) > 0 ? '今天已往电网送电' : '暂无送出');
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
     就会糊成一片。按"默认机位距离 = 72%"算缩放（站点默认机位约 58m），远处再淡出 */
  const LBL_REF = 42;                // 默认机位附近：浮标 72%（原来 48 → 100%，太大挡视线）
  let _lblV = null;
  function scaleLabels() {
    if (!labelPairs.length || !camera) return;
    if (!_lblV) _lblV = new THREE.Vector3();
    for (let i = 0; i < labelPairs.length; i++) {
      const it = labelPairs[i];
      it.obj.getWorldPosition(_lblV);
      const d = camera.position.distanceTo(_lblV);
      let k = LBL_REF / Math.max(1, d);
      k = Math.min(1, Math.max(0.36, k));
      if (Math.abs((it.k || 0) - k) < 0.04) continue;      /* 变化小于 4% 就不写样式：拖动时每帧改 CSS 也要重排，是顿挫的来源 */
      it.k = k;
      it.el.style.setProperty('--lbl-scale', k.toFixed(3));
      /* 拉得越远越淡：0.36 时降到 0.3，远景不至于是"一片标签" */
      it.el.style.opacity = (0.3 + 0.7 * Math.min(1, (k - 0.36) / 0.64)).toFixed(2);
    }
  }

  /* 电流光纹沿电缆滚动（速度随功率，方向随充放/买卖电，无输出时静止变暗） */
  function stepFlow(dt) {
    if (!flows.length || !dt) return;
    for (let i = 0; i < flows.length; i++) {
      const fl = flows[i];
      fl.tubeMat.opacity = fl.on ? .95 : .22;
      if (!fl.on) continue;
      fl.map.offset.x -= (fl.dir || 1) * fl.speed * dt * .35;
      if (fl.tint) fl.tubeMat.color.setHex(fl.tint);
    }
  }

  /* 光伏 / 储能 / 负载三者决定三条支线的方向与颜色。线色一律按"谁在供电"（现场口径）：
     光伏出力=黄 / 从电网取电=蓝 / 储能放电=青绿 / 卖电=黄（卖的就是光伏余电）
     口径核对（2026-10 用日升云实时数据验过）：日升云的 power_kw 正=放电、负=充电；
     现场数字也对得上——负载 10.2 = 电池放 9.2 + 电网来 0.7，只有"正=放电"成立 */
  function updateEnergyFlows() {
    const c = FLOWC[theme] || FLOWC.night;
    const pv = Number(cur.power) || 0;
    const st = Number(cur.storPower) || 0;
    const load = Number(cur.loadKw) || 0;
    /* 光伏 / 储能 / 负载三路齐了才算关口（缺一项就显示 --：不然会把"没数据"当成 0，
       既会误报"馈电上网"，也会把供电模式判错） */
    const known = cur.pvSeen
      && cur.storPower !== null && cur.storPower !== undefined
      && cur.loadKw !== null && cur.loadKw !== undefined;
    const surplus = known ? (pv + st - load) : null;
    /* 三个状态位：供电模式分档和负载线配色都用同一组阈值，别各判各的 */
    const pvOn = pv > .5, chg = st < -.5, dis = st > .5;
    flows.forEach(function (fl) {
      if (fl.kind === 'load') {
        /* 负载支线（总线 → 卫生院）：有负载就流，永远往楼里去；
           颜色=谁在供院（储能放电=青绿 / 光伏出力=黄 / 都没有则从电网取=蓝） */
        fl.on = known && load > .3;
        fl.dir = 1;
        fl.tint = dis ? c.dis : (pvOn ? c.ac : c.buy);
        fl.speed = .3 + Math.min(1, load / 40) * 1.8;
        if (!fl.on) fl.tubeMat.color.setHex(c.idle);
      } else if (fl.kind === 'grid') {
        /* 关口支线（总线 ↔ 铁塔）：卖电=黄 / 从电网取=蓝（取电口同时也是"电网给储能充电"那一路） */
        fl.on = surplus !== null && Math.abs(surplus) > .3;
        fl.dir = (surplus !== null && surplus > 0) ? 1 : -1;
        fl.tint = (surplus !== null && surplus > 0) ? c.sell : c.buy;
        fl.speed = .3 + Math.min(1, Math.abs(surplus || 0) / 100) * 1.8;
        if (!fl.on) fl.tubeMat.color.setHex(c.idle);
      } else if (fl.kind === 'gl') {
        /* 电网直供线（铁塔 → 卫生院）：从电网取电就亮蓝（塔 → 楼），余电上网时不亮
           （往外送走的是关口那条；这条只表示"电网在给楼里供电"） */
        fl.on = known && surplus < -.3;
        fl.dir = 1;
        fl.tint = c.buy;
        fl.speed = .3 + Math.min(1, Math.abs(surplus || 0) / 100) * 1.8;
        if (!fl.on) fl.tubeMat.color.setHex(c.idle);
      } else if (fl.kind === 'stor') {
        /* 储能支线（总线 ↔ 储能柜）：充放电走同一根线，方向相反。
           颜色按"电从哪来"：光伏充=黄、电网充=蓝、放电=储能青绿；不充不放就熄灭 */
        fl.on = known && (chg || dis);
        fl.dir = chg ? 1 : -1;                       /* 1 = 总线 → 柜（充电）/ -1 = 柜 → 总线（放电） */
        fl.tint = chg ? (pvOn ? c.ac : c.buy) : c.dis;
        fl.speed = .3 + Math.min(1, Math.abs(st) / 40) * 1.8;
        if (!fl.on) fl.tubeMat.color.setHex(c.idle);
      } else if (fl.kind === 'pv') {
        /* 光伏支线（屋面 → 总线）：光伏出力就上光伏黄——给储能充、供卫生院、卖电网都是这一路电，
           不再按"在充电"换成蓝色；没太阳就不上色（熄火由 setPower 压回 idle） */
        fl.tint = pvOn ? c.ac : 0;
      }
    });
    /* 洙边的六种供电模式（现场口径：原来 ①~⑤ 之外的"储能满 + 光伏卖电"单列成 ⑥）。
       判据只有四个量：pv 光伏功率、st 储能功率
       （正=放电 / 负=充电）、load 卫生院负载，以及推出来的关口净额 surplus = pv + st - load
       （正=往电网卖、负=从电网买）：
         ① 光伏→储能→卫生院→卖电网    储能充 + 光伏出力 + 关口在卖电
         ② 光伏→储能→卫生院           储能充 + 光伏出力 + 不卖电（不够的部分电网补）
         ③ 电网给储能充电（并供医院）   储能充 + 光伏没出力
         ④ 全部由电网供电             储能不动 + 光伏没出力
         ⑤ 储能直供卫生院             储能在放电（放不够时电网补、放多了余电上网）
         ⑥ 光伏直供卫生院             储能不动（充满 / 待机）+ 光伏在出力：
                                      光伏自己带卫生院，多余的上不上网写在备注里
       线色跟着"谁在供电"走，六档共用一套：光伏支线出力就黄（①②⑥）；负载线按供院的那一路
       上色——储放=青绿（⑤）、有光=黄（①②⑥）、纯电网=蓝（③④）；关口线卖=黄、取=蓝；
       储能支线充电时用"电从哪来"的颜色（光伏充=黄①② / 电网充=蓝③）、放电=青绿（⑤）；
       电网直供线（塔 → 楼，走南侧走廊）只要关口在取电就亮蓝（③④，以及②⑤里电网补缺口那几档）。
       储能这一路的状态（充 / 放 / 不动）先分家：不动时再看光伏出不出力——
       出力就是 ⑥，不出力才是 ④。⑥ 和 ⑤ 一样只报"电从哪来"，
       关口三个区间（余电上网 / 缺口由电网补 / 基本不交换）都写在备注里
       另外两个容易判错的地方：储能充放而关口在反方向时，备注也按 surplus 分区间写，
       不再一律"不往电网送 / 关口基本不交换"；三个量有一个没上报就整段留空，
       浮标和明细卡显示 --（不编数据） */
    let pMode = '', pModeTxt = '', pModeNote = '';
    if (known) {
      if (chg && pvOn && surplus > .3) {
        pMode = '①'; pModeTxt = '光伏→储能→卫生院→卖电网';
        pModeNote = '光伏先给储能充，余量供卫生院，再多的卖到电网';
      } else if (chg && pvOn) {
        pMode = '②'; pModeTxt = '光伏→储能→卫生院';
        pModeNote = surplus < -.3 ? '光伏先给储能充，缺口由电网补'
          : '光伏先给储能充，再供卫生院，不往电网送';
      } else if (chg) {
        pMode = '③'; pModeTxt = '电网给储能充电（并供医院）';
        pModeNote = '光伏没出力，储能由电网充，卫生院也由电网供';
      } else if (dis) {
        pMode = '⑤'; pModeTxt = '储能直供卫生院';
        pModeNote = surplus > .3 ? '储能放电供卫生院，富余的往电网送'
          : surplus < -.3 ? '储能放电供卫生院，缺口由电网补'
            : '储能放电直供卫生院，关口基本不交换';
      } else if (pvOn) {
        pMode = '⑥'; pModeTxt = '光伏直供卫生院';
        pModeNote = surplus > .3 ? '储能未充放（已满 / 待机），光伏先供卫生院，余电上网'
          : surplus < -.3 ? '储能未充放（已满 / 待机），光伏出力不够，缺口由电网补'
            : '储能未充放（已满 / 待机），光伏直供卫生院，关口基本不交换';
      } else {
        pMode = '④'; pModeTxt = '全部由电网供电';
        pModeNote = '储能无充放、光伏没出力，全站由电网供';
      }
    }
    /* 传给储能柜浮标 / 明细卡（空串表示没数据，显示 --） */
    pModeNow = pMode; pModeTxtNow = pModeTxt; pModeNoteNow = pModeNote;
    if (twrLabelEl) {
      twrLabelEl.innerHTML = '并网铁塔<i>10kV 上网线路</i><em>' + (surplus === null ? '--' : (Math.abs(surplus) > .3
        ? (surplus > 0 ? '送出 ' + surplus.toFixed(1) + ' kW' : '受电 ' + Math.abs(surplus).toFixed(1) + ' kW')
        : '无交换')) + '</em>';
    }
  }

  /* ---------------- 主循环 ---------------- */
  function loop(t) {
    raf = requestAnimationFrame(loop);
    const dt = clock.last ? Math.min(.08, (t - clock.last) / 1000) : 0;
    clock.last = t;
    if (!active) return;
    /* 画布被隐藏（切到储能/光伏/详细信息页、或回到站点目录）时不渲染，别在后台空烧 GPU */
    if (!renderer.domElement.offsetWidth || !renderer.domElement.offsetHeight) return;
    if (cloudGroup) {
      cloudGroup.children.forEach(function (cg) {
        cg.position.x += cg.userData.speed * dt * 6;
        if (cg.position.x > 78) cg.position.x = -78;
      });
    }
    if (rainInst && rainInst.visible) {
      if (!_rainM) _rainM = new THREE.Matrix4();
      for (let i = 0; i < RAIN_N; i++) {
        rainY[i] -= rainV[i] * dt * 3.6;
        if (rainY[i] < 0) rainY[i] = 30;
        _rainM.makeTranslation(rainX[i], rainY[i], rainZ[i]);
        rainInst.setMatrixAt(i, _rainM);
      }
      rainInst.instanceMatrix.needsUpdate = true;
    }
    /* 扫光带横移（18s 一轮）+ 塔顶航标呼吸 + 氛围粒子缓慢上升 */
    if (sweepMesh && sweepMesh.material.opacity > 0) {
      sweepMesh.position.x = -58 + ((t / 1000) % 18) / 18 * 116;
    }
    if (beacon) {
      const bk = .35 + .65 * Math.abs(Math.sin(t * .0016));
      beacon.material.opacity = bk;
      if (beaconGlow) beaconGlow.material.opacity = .16 + .44 * bk;
    }
    /* 院内走动的人：沿路线匀速走 + 一点上下起伏（不投影，阴影是冻结的） */
    for (let i = 0; i < walkers.length; i++) {
      const w = walkers[i];
      w.dist += dt * w.speed;
      let d = w.dist;
      if (!w.loop) {                                  /* 往返路线：走到头再折回来 */
        const m = w.dist % (w.total * 2);
        d = m <= w.total ? m : w.total * 2 - m;
      }
      const wp = pointOnPath(w, d);
      w.g.position.set(wp.x, .18 + Math.abs(Math.sin(w.dist * 3.6)) * .05, wp.z);
    }
    stepFlow(dt);
    scaleLabels();                       /* 浮标跟着相机距离缩放 */
    updateLabelOcclusion();              /* 被模型挡住的浮标藏起来（每 6 帧算一次） */
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
    if (bloomPass) bloomPass.setSize(w * .5, h * .5);
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
    if (!camera || !controls || !camHome) return;
    camera.position.copy(camHome.pos);
    controls.target.copy(camHome.tgt);
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
