/* ============================================================
 * 高特电站三维场景
 *
 * 与场景对齐真实拓扑：储能柜（数量按上报自动排布）+ 汇流/PCS 柜 + 并网杆塔，
 * 数据全部来自 GaoteService（高特协议实时值）：
 *   柜顶色条   —— 充电(蓝) / 放电(青) / 待机(灰)
 *   柜侧光柱   —— 该柜 SOC：高度从下往上按 SOC 生长，颜色随充放电状态
 *   电缆能量流 —— 每根柜线按该柜电流方向流动，并网线按全站功率方向流动；
 *                电流光纹沿电缆滚动，速度随数值大小，待机时停下（不挂光球）
 *   厂房       —— 工厂用电负荷：放电时进线电流流入厂房，待机/充电时停止
 *   标签 / 卡片 —— 堆号 · SOC · 状态 · 温度；点击展开明细（厂房、汇流柜同样可点）
 *
 * 接口与 js/scene3d.js 一致：init / update / toggleLabels / toggleRotate / resetView / setRotateSync / resize
 * ============================================================ */
window.GaoteScene3D = (function () {
  'use strict';

  let scene, camera, renderer, labelRenderer, controls, composer;
  let host = null, raf = null;
  /* 默认不自动旋转（用户要求），要用时点右上角「旋转」按钮 */
  let rot = { auto: false, speed: 0.05 }, labelsOn = true, activeCardKey = null;
  const groups = {};        // key -> THREE.Group
  const labelEls = {};      // key -> .tag3d element
  const cardEls = {};       // key -> .card3d element
  const strips = {};        // key -> 柜顶色条
  const gauges = {};        // key -> 柜侧 SOC 光柱
  let inited = false;
  const clock = { last: 0 };

  /* 白天 / 夜晚双主题：默认夜晚（深色科技感），白天为浅色天空 + 浅色地坪。
     场景里用到的可换色对象（地面、台面、灯光、辉光强度）建好后记录在这里 */
  let theme = 'night';
  let groundMat = null, platformMat = null;
  let hemiLight = null, sunLight = null, fillLight = null, bloomPass = null;
  const THEMES = {
    night: {
      bg: 0x04090c, fog: 0x04090c, fogNear: 34, fogFar: 95,
      gridBg: '#04090c', gridLine: 'rgba(46,230,200,.14)',
      ground: 0xffffff, platform: 0x0b1a1e,
      hemiSky: 0xbfe9ff, hemiGround: 0x0a1a1e, hemiInt: 1.05,
      sunColor: 0xffffff, sunInt: .85, fillColor: 0x2ee6c8, fillInt: .35, bloom: .62, bloomTh: .82,
      /* 状态色：充电(蓝) / 放电(青) / 待机(灰) */
      stateChg: 0x8fd8ff, stateDis: 0x2ee6c8, stateIdle: 0x6f9a94,
      /* 电流光纹：放电(青) / 充电(蓝) / 待机(暗)；夜里用加色混合发光 */
      flowDis: 0x2ee6c8, flowChg: 0x8fd8ff, flowIdle: 0x16303a, flowBlend: 1,
      sky: null
    },
    day: {
      bg: 0xcfe4f0, fog: 0xe9f1f4, fogNear: 58, fogFar: 165,
      /* 阳光下的水泥地：暖灰而不是冷灰蓝，网格线深一点才看得见 */
      gridBg: '#e4e6e2', gridLine: 'rgba(102,116,112,.42)', patches: true,
      ground: 0xffffff, platform: 0xd2d6d0,
      /* 光照总量压在 1.0 附近：再高浅色地面就过曝成纯白，网格和阴影全丢。
         环境光给足（阴面才不会发黑成剪影），直射光适度 */
      hemiSky: 0xdfefff, hemiGround: 0xb9bdb6, hemiInt: .6,
      sunColor: 0xfff0da, sunInt: .55, fillColor: 0xbfe6ff, fillInt: .15, bloom: .1, bloomTh: .97,
      /* 白天：充电橙 / 放电黄（浅底上暖色最醒目，与电流光纹同色系），待机灰 */
      stateChg: 0xd97700, stateDis: 0xd7a400, stateIdle: 0x9aa9a9,
      /* 电流光纹：白天浅底用饱和暖色 + 普通混合，否则会被浅底冲淡 */
      flowDis: 0xe8b000, flowChg: 0xe08600, flowIdle: 0x9aa9a9, flowBlend: 0,
      /* 天空穹顶的竖直渐变：天顶蓝 → 地平线白雾（相机基本平视，
         所以蓝色要压到接近地平线才看得见，否则整片都是白的） */
      sky: { stops: [[0, '#4f9fd4'], [.36, '#7dbde3'], [.47, '#b6d9ee'], [.52, '#e6eff4'], [1, '#e6eff4']] }
    }
  };

  /* 主题化材质登记：建场景时把每个材质"白天 / 夜里"两套配置登记进来，
     切主题时统一替换（颜色 / 贴图 / 自发光），设备就不会白天还是一团黑 */
  const themeMats = [];
  function regMat(mat, night, day) { themeMats.push({ mat: mat, night: night, day: day }); return mat; }
  let skyDome = null;
  function makeSkyDome(sky) {
    const t = tex(function (g, w, h) {
      const grd = g.createLinearGradient(0, 0, 0, h);
      sky.stops.forEach(function (s) { grd.addColorStop(s[0], s[1]); });
      g.fillStyle = grd; g.fillRect(0, 0, w, h);
    }, 16, 256);
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(180, 24, 16),
      new THREE.MeshBasicMaterial({ map: t, side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: false })
    );
    mesh.renderOrder = -1;
    return mesh;
  }

  /* 能量流：每条电缆一根发光管，电流光纹沿线滚动，方向/速度各自按数据 */
  const flows = [];
  const conductorMats = [];                // 铁塔导线材质（颜色随主题）
  const flow = { dir: 0, units: 0 };       // 全站口径（并网线用）

  /* 柜体数量按实际上报自动排布；间距放大后设备之间不挤（柜宽 2.5，间距 5.2 → 净空 2.7） */
  const MAXN = 8, GAP = 5.2, STACK_W = 2.5, STACK_H = 2.8, STACK_D = 1.5;
  /* 汇流/PCS 柜位置（放在并网铁塔下面，与储能柜排成横向一列）与半宽 */
  const PCS_X = -8.6, PCS_Z = 3.0, PCS_HW = 2.3;
  /* 厂房（含办公附房）位置与尺寸：整体放大，走线、接入点都从这里取，改一处即可 */
  const FAC_X = 13.6, FAC_Z = .8, FAC_W = 9.0, FAC_H = 4.6, FAC_D = 6.4, FAC_RH = 1.7;
  /* 办公附房（厂房的左侧小楼）：正面墙上挂电缆进线箱 */
  const OFF_X = -(FAC_W / 2 + 1.0), OFF_Z = FAC_D / 2 - 1.4, OFF_W = 3.2, OFF_H = 3.2, OFF_D = 2.6;
  /* 铁塔位置 */
  const TWR_X = -13.2, TWR_Z = -2.8;
  let stackN = 2;   // 默认按本站实际（2 堆）；连上后按上报的簇数自动排布
  const stackCables = [];   // { flow } 每柜到 PCS 的电缆

  /* 厂房（工厂用电负荷）：放电时电送进厂房，进线光点流动 */
  let facGroup = null, facLabelEl = null, facOn = false;

  /* ---------------- 基础工具 ---------------- */
  function std(c, o) { return new THREE.MeshStandardMaterial(Object.assign({ color: c, roughness: .6, metalness: .35 }, o || {})); }
  function box(w, h, d, m, x, y, z) {
    const M = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    M.position.set(x, y, z);
    M.castShadow = M.receiveShadow = true;
    return M;
  }
  /* 画布贴图。sc = 超采样倍数：绘制坐标仍按 w×h 写，输出放大 sc 倍，
     近景贴近看柜体/墙面时不会糊成一片（设备贴图都用 2 倍画） */
  function tex(fn, w, h, sc) {
    const s = sc || 1;
    const c = document.createElement('canvas');
    c.width = (w || 256) * s; c.height = (h || 256) * s;
    const g = c.getContext('2d');
    if (s > 1) g.scale(s, s);
    fn(g, w || 256, h || 256);
    return new THREE.CanvasTexture(c);
  }

  /* 地坪网格：底色 / 网格线颜色随主题（白天为浅色水泥地，夜晚为深色发光网格）。
     线画粗一点 + 各向异性过滤：地坪铺得很大，细线在远处会被 mipmap 抹掉 */
  function gridTexture(t) {
    const p = THEMES[t || theme] || THEMES.night;
    const tx = tex(function (g, w, h) {
      g.fillStyle = p.gridBg; g.fillRect(0, 0, w, h);
      g.strokeStyle = p.gridLine; g.lineWidth = 3;
      for (let i = 0; i <= 8; i++) {
        const q = i * w / 8;
        g.beginPath(); g.moveTo(q, 0); g.lineTo(q, h); g.stroke();
        g.beginPath(); g.moveTo(0, q); g.lineTo(w, q); g.stroke();
      }
      /* 白天：水泥地加些深浅斑驳 + 轮迹，避免一大片死平 */
      if (p.patches) {
        for (let i = 0; i < 26; i++) {
          const x = Math.random() * w, y = Math.random() * h, r = 18 + Math.random() * 70;
          const rg = g.createRadialGradient(x, y, 0, x, y, r);
          rg.addColorStop(0, 'rgba(118,124,118,.055)');
          rg.addColorStop(1, 'rgba(118,124,118,0)');
          g.fillStyle = rg; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
        }
      }
    }, 512, 512);
    tx.wrapS = tx.wrapT = THREE.RepeatWrapping;
    if (renderer && renderer.capabilities) tx.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return tx;
  }
  /* 设备贴图配色：白天 / 夜晚两套。
     夜里是深色柜体 + 青色发光线；白天换成浅色柜体 + 深灰缝线，
     否则深色设备在亮背景里就是一团剪影 */
  const TEXPAL = {
    night: {
      cabBg: '#0f2731', cabPanel: 'rgba(7,22,28,.95)', seam: 'rgba(46,230,200,.18)',
      seam2: 'rgba(46,230,200,.25)', slot: 'rgba(46,230,200,.20)', door: 'rgba(46,230,200,.34)',
      doorIn: 'rgba(46,230,200,.13)', hinge: 'rgba(46,230,200,.55)', plate: 'rgba(46,230,200,.30)',
      warn: 'rgba(255,176,32,.42)', sideBg: '#0c1f27', sideSeam: 'rgba(46,230,200,.12)',
      sideEdge: 'rgba(46,230,200,.16)', sideVent: 'rgba(46,230,200,.14)', pcsBg: '#10262e',
      pcsPanel: 'rgba(7,22,28,.95)', pcsVent: 'rgba(46,230,200,.16)', pcsFoot: 'rgba(46,230,200,.09)',
      pcsWarn: 'rgba(255,176,32,.35)', facBg: '#122831', facSeam: 'rgba(46,230,200,.10)',
      winFill: 'rgba(120,225,255,.16)', winLine: 'rgba(46,230,200,.22)', facDoor: 'rgba(8,20,26,.95)',
      facDoorLine: 'rgba(46,230,200,.3)', facSlat: 'rgba(46,230,200,.14)', facWarn: 'rgba(255,176,32,.22)'
    },
    day: {
      cabBg: '#eef1f0', cabPanel: 'rgba(206,216,218,.95)', seam: 'rgba(104,128,130,.30)',
      seam2: 'rgba(104,128,130,.40)', slot: 'rgba(104,128,130,.26)', door: 'rgba(70,100,102,.45)',
      doorIn: 'rgba(104,128,130,.18)', hinge: 'rgba(52,86,88,.55)', plate: 'rgba(16,160,138,.45)',
      warn: 'rgba(224,148,16,.55)', sideBg: '#e4e9e9', sideSeam: 'rgba(104,128,130,.26)',
      sideEdge: 'rgba(104,128,130,.34)', sideVent: 'rgba(104,128,130,.30)', pcsBg: '#eaeef0',
      pcsPanel: 'rgba(202,212,214,.95)', pcsVent: 'rgba(104,128,130,.30)', pcsFoot: 'rgba(104,128,130,.16)',
      pcsWarn: 'rgba(224,148,16,.50)', facBg: '#eaeeee', facSeam: 'rgba(104,128,130,.22)',
      winFill: 'rgba(126,196,226,.50)', winLine: 'rgba(80,116,124,.45)', facDoor: 'rgba(184,193,195,.95)',
      facDoorLine: 'rgba(104,128,130,.50)', facSlat: 'rgba(104,128,130,.25)', facWarn: 'rgba(224,148,16,.35)'
    }
  };

  /* 柜体正面：顶部空调、双开门、门缝把手、铭牌与警示条 */
  function cabFrontTexture(P) {
    return tex(function (g, w, h) {
      g.fillStyle = P.cabBg; g.fillRect(0, 0, w, h);
      g.strokeStyle = P.seam; g.lineWidth = 2; g.strokeRect(7, 7, w - 14, h - 14);
      g.fillStyle = P.cabPanel; g.fillRect(14, 14, w - 28, 46);
      g.strokeStyle = P.seam2; g.strokeRect(14, 14, w - 28, 46);
      for (let i = 0; i < 5; i++) { g.fillStyle = P.slot; g.fillRect(24, 21 + i * 8, w - 48, 3); }
      g.strokeStyle = P.door; g.lineWidth = 3;
      g.beginPath(); g.moveTo(w / 2, 72); g.lineTo(w / 2, h - 18); g.stroke();
      g.strokeStyle = P.doorIn; g.lineWidth = 2;
      g.strokeRect(18, 76, w / 2 - 28, h - 104);
      g.strokeRect(w / 2 + 10, 76, w / 2 - 28, h - 104);
      g.fillStyle = P.hinge;
      g.fillRect(w / 2 - 18, h / 2 - 8, 5, 30); g.fillRect(w / 2 + 13, h / 2 - 8, 5, 30);
      g.fillStyle = P.plate; g.fillRect(22, h - 30, 66, 9);
      g.fillStyle = P.warn; g.fillRect(w - 88, h - 30, 66, 9);
    }, 256, 256, 2);
  }
  /* 柜体侧面/顶面：钢板分块、竖向筋、底部散热百叶 */
  function cabSideTexture(P) {
    return tex(function (g, w, h) {
      g.fillStyle = P.sideBg; g.fillRect(0, 0, w, h);
      g.strokeStyle = P.sideSeam; g.lineWidth = 2;
      for (let i = 1; i < 4; i++) { const x = i * w / 4; g.beginPath(); g.moveTo(x, 6); g.lineTo(x, h - 6); g.stroke(); }
      g.strokeStyle = P.sideEdge; g.strokeRect(6, 6, w - 12, h - 12);
      for (let i = 0; i < 6; i++) { g.fillStyle = P.sideVent; g.fillRect(16, h - 54 + i * 8, w - 32, 3); }
    }, 256, 256, 2);
  }
  /* PCS 柜正面：大百叶、门缝、警示条 */
  function pcsFrontTexture(P) {
    return tex(function (g, w, h) {
      g.fillStyle = P.pcsBg; g.fillRect(0, 0, w, h);
      g.strokeStyle = P.seam; g.lineWidth = 2; g.strokeRect(8, 8, w - 16, h - 16);
      g.fillStyle = P.pcsPanel; g.fillRect(16, 22, w - 32, h - 92);
      for (let i = 0; i < 9; i++) { g.fillStyle = P.pcsVent; g.fillRect(24, 32 + i * 12, w - 48, 4); }
      g.fillStyle = P.pcsFoot; g.fillRect(16, h - 58, w - 32, 40);
      g.fillStyle = P.pcsWarn; g.fillRect(16, h - 22, w - 32, 8);
    }, 256, 256, 2);
  }
  /* 电缆流动光纹（沿管滚动；每条电缆用独立副本以便各自滚动）
     一段光纹 = 宽亮头 + 短拖尾：头部饱满、边界干脆，转起来一眼就能看出在流动 */
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
          lg.addColorStop(.5, 'rgba(255,255,255,1)');
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
    /* 光纹密度跟着线长走：每 4 个单位左右一段，短线上也看得到"流动" */
    t.repeat.set(Math.max(2, Math.round((repeat || 8) / 4.2)), 1);
    return t;
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
    /* 明细卡片打开时把所有浮标藏起来：浮标按 3D 位置投影，会压在卡片上（重叠很难看） */
    const cardOpen = !!activeCardKey;
    for (const k in labelEls) {
      const isStack = k.indexOf('stack') === 0;
      const idx = isStack ? parseInt(k.slice(5), 10) : -1;
      /* 没内容的浮标不显示（否则会剩个空心框，看不出是什么） */
      const empty = !labelEls[k].textContent.trim();
      const hide = cardOpen || !labelsOn || empty || (isStack && idx >= stackN);
      labelEls[k].style.display = hide ? 'none' : '';
    }
    if (facLabelEl) facLabelEl.style.display = (labelsOn && !cardOpen) ? '' : 'none';
  }

  /* ---------------- 能量流 ---------------- */
  /* 只做"电流在电线上流动"：一根深色线芯（电缆本体）+ 一根带流动光纹的发光管，不挂沿线光球 */
  function addFlow(pts, parent, stack) {
    let curve;
    try { curve = new THREE.CatmullRomCurve3(pts); } catch (_) { return null; }
    const len = Math.max(1, curve.getLength());
    const seg = Math.max(14, Math.round(len * 4));

    const core = new THREE.Mesh(new THREE.TubeGeometry(curve, seg, .052, 6, false),
      new THREE.MeshBasicMaterial({ color: 0x122a2f, transparent: true, opacity: .95 }));
    (parent || scene).add(core);

    const tubeMat = new THREE.MeshBasicMaterial({
      map: flowTexture(len), color: 0x16303a, transparent: true, opacity: .3,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, seg, .105, 8, false), tubeMat);
    (parent || scene).add(tube);

    const fl = {
      curve: curve, len: len, map: tubeMat.map, tubeMat: tubeMat, tube: tube, core: core,
      stack: (stack === undefined ? -1 : stack), dir: 0, speed: 0
    };
    flows.push(fl);
    return fl;
  }
  function stepFlow(dt) {
    if (!flows.length || !dt) return;
    const p = THEMES[theme];
    for (let i = 0; i < flows.length; i++) {
      const fl = flows[i];
      const on = fl.dir !== 0;
      /* flip：几何方向与"充/放"语义相反（如"汇流柜 → 堆"的充电电缆），取色时翻一下 */
      const sd = fl.flip ? -fl.dir : fl.dir;
      fl.tubeMat.color.setHex(sd > 0 ? p.flowDis : (sd < 0 ? p.flowChg : p.flowIdle));
      /* 有电流时全亮（夜里再加一层加色发光），待机时暗下来但管线还在 */
      fl.tubeMat.opacity = on ? 1 : (p.flowBlend ? .26 : .42);
      if (on) fl.map.offset.x -= fl.dir * fl.speed * dt * .35;     // 光纹沿电缆滚动
    }
  }

  /* ---------------- 储能柜（精细柜体） ---------------- */
  const texCache = {};
  function buildStack(key) {
    const g = new THREE.Group();
    const W = STACK_W, H = STACK_H, D = STACK_D;
    const M = texCache.mats;
    const post = M.post;

    g.add(box(W + .22, .16, D + .22, M.dark, 0, .08, 0));                                 // 底座
    const body = new THREE.Mesh(new THREE.BoxGeometry(W, H, D), [M.cabSide, M.cabSide, M.cabTop, M.cabSide, M.cabFront, M.cabSide]);
    body.position.y = H / 2 + .16;
    body.castShadow = body.receiveShadow = true;
    g.add(body);
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (c) {                            // 四角立柱
      g.add(box(.1, H + .04, .1, post, c[0] * (W / 2 - .02), H / 2 + .16, c[1] * (D / 2 - .02)));
    });
    g.add(box(W * .72, .3, D * .78, M.ac, 0, H + .33, 0));   // 顶部空调
    for (let k = 0; k < 4; k++) {
      g.add(box(W * .6, .03, .06, M.acVent, 0, H + .47, -.2 + k * .13));
    }

    const strip = box(W * .92, .12, D * .92, std(0x6f9a94, { emissive: 0x000000 }), 0, H + .2, 0);        // 柜顶色条
    g.add(strip);
    strips[key] = strip;

    /* 柜侧 SOC 光柱：柜体左、右两侧各一条竖直光柱，高度按该柜 SOC 从下往上长。
       两侧都装是因为场景会自动旋转，单侧只有半圈能看见（底槽让"空/满"看得清） */
    const colH = H * .68, colZ = D * .2;
    const colBase = .16 + H * .5 - colH / 2;
    gauges[key] = [];
    [-1, 1].forEach(function (sgn) {
      g.add(box(.05, colH + .08, .3, M.slot, sgn * (W / 2 + .035), .16 + H * .5, colZ));
      const socGeo = new THREE.BoxGeometry(.045, colH, .24);
      socGeo.translate(0, colH / 2, 0);                     // 原点移到底部 → scale.y 即"从下往上长"
      const socBar = new THREE.Mesh(socGeo, new THREE.MeshBasicMaterial({ color: 0x6f9a94 }));
      socBar.position.set(sgn * (W / 2 + .062), colBase, colZ);
      g.add(socBar);
      gauges[key].push(socBar);
    });

    /* 柜门细节：铰链、把手、铭牌、底部进线箱（让柜子在近景下经得起看） */
    [-1, 1].forEach(function (s) {
      [.3, .7].forEach(function (t) {
        g.add(box(.09, .16, .05, post, s * (W / 2 - .05), .16 + H * t, D / 2 + .03));
      });
    });
    g.add(box(.07, .4, .06, post, W / 2 - .28, .16 + H * .5, D / 2 + .04));                                  // 门把手
    g.add(box(.34, .18, .02, M.plate, -W / 2 + .34, .16 + H * .76, D / 2 + .022));                           // 铭牌底
    g.add(box(.3, .14, .03, new THREE.MeshBasicMaterial({ color: 0xd9a02a }), -W / 2 + .34, .16 + H * .76, D / 2 + .036));
    g.add(box(W * .46, .2, .28, M.ac, 0, .2, D / 2 + .12));                                                  // 底部进线箱
    g.add(box(W * .2, .06, .18, M.fan, -W * .3, H + .5, D * .1));                                            // 顶部风机

    /* 门锁、状态指示灯、接地排、柜号牌：近景里经得起看的细节 */
    g.add(box(.05, .13, .05, post, W / 2 - .6, .16 + H * .32, D / 2 + .045));                                // 门锁
    g.add(box(.17, .11, .03, M.slot, -W / 2 + .3, .16 + H * .9, D / 2 + .02));                               // 指示灯底座
    const led = new THREE.Mesh(new THREE.BoxGeometry(.12, .07, .04), new THREE.MeshBasicMaterial({ color: 0x6f9a94 }));
    led.position.set(-W / 2 + .3, .16 + H * .9, D / 2 + .045);
    g.add(led);
    g.userData.led = led;                                                                                    // update() 按充放电状态点亮
    g.add(box(.42, .05, .07, M.copper, W * .26, .26, D / 2 + .09));                                          // 接地排
    g.add(box(.05, .16, .05, M.copper, W * .26, .21, D / 2 + .09));                                          // 接地引下线
    const numTex = tex(function (gg, w2, h2) {                                                               // 柜号牌 1# / 2# …
      gg.fillStyle = '#d9a02a'; gg.fillRect(0, 0, w2, h2);
      gg.fillStyle = '#241806'; gg.font = 'bold 22px sans-serif';
      gg.textAlign = 'center'; gg.textBaseline = 'middle';
      gg.fillText((parseInt(String(key).replace('stack', ''), 10) + 1) + '#', w2 / 2, h2 / 2 + 1);
    }, 32, 16);
    const numPlane = new THREE.Mesh(new THREE.PlaneGeometry(.25, .11),
      new THREE.MeshBasicMaterial({ map: numTex, transparent: true }));
    numPlane.position.set(-W / 2 + .34, .16 + H * .76, D / 2 + .058);   // 贴在铭牌前面，留 7mm 余量避免贴面打架
    g.add(numPlane);

    const glow = new THREE.Mesh(new THREE.PlaneGeometry(W * 1.45, D * 1.7),
      new THREE.MeshBasicMaterial({ color: 0x2ee6c8, transparent: true, opacity: .06, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.rotation.x = -Math.PI / 2;
    glow.position.set(0, .2, 0);
    g.add(glow);
    g.userData.glow = glow;

    g.userData.key = key;
    groups[key] = g;
    /* 相邻柜子的浮标错开高度，避免排成一列时相互压住（浮标约 1.3 个世界单位高） */
    addLabel(key, new THREE.Vector3(0, H + .95 + (parseInt(String(key).replace('stack', ''), 10) % 2) * 1.3, 0), 'tag3d tag3d-gt');
    addCard(key, new THREE.Vector3(0, H + .1, 0));
    return g;
  }

  /* ---------------- 汇流 / PCS 柜（放在铁塔下面，与储能柜排成横向一列） ---------------- */
  function buildPCS(root) {
    const g = new THREE.Group();
    g.position.set(PCS_X, 0, PCS_Z);
    const W = 4.6, H = 2.2, D = 1.4;
    const M = texCache.mats;
    g.add(box(W + .3, .18, D + .3, M.dark, 0, .09, 0));
    const body = new THREE.Mesh(new THREE.BoxGeometry(W, H, D), [M.cabSide, M.cabSide, M.pcsTop, M.cabSide, M.pcsFront, M.cabSide]);
    body.position.y = H / 2 + .18;
    body.castShadow = body.receiveShadow = true;
    body.userData.key = 'pcs';
    g.add(body);
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (c) {
      g.add(box(.1, H, .1, M.post, c[0] * (W / 2 - .02), H / 2 + .18, c[1] * (D / 2 - .02)));
    });
    g.add(box(W * .8, .16, .5, M.bridge, 0, H + .26, -.5));                    // 顶部桥架
    g.add(box(.5, .16, D + .4, M.bridge, -W * .3, H + .26, 0));
    g.add(box(.76, .4, .03, M.plate, -W * .18, H * .68, D / 2 + .005));        // 显示屏
    g.add(box(.7, .34, .04, new THREE.MeshBasicMaterial({ color: 0x14e0c0 }), -W * .18, H * .68, D / 2 + .03));
    g.add(box(.08, .3, .08, M.gap, W * .32, H * .6, D / 2 + .06));             // 隔离开关
    /* 顶部出线套管（三相，带 A/B/C 相色环）+ 底部进线箱，近景下更像真设备 */
    [0, 1, 2].forEach(function (i) {
      const x = (i - 1) * 1.2;
      const bush = new THREE.Mesh(new THREE.CylinderGeometry(.11, .15, .52, 8), M.bush);
      bush.position.set(x, H + .5, 0);
      bush.castShadow = true;
      g.add(bush);
      g.add(box(.3, .07, .3, M.gap, x, H + .22, 0));
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(.17, .17, .07, 12),       // 相色环（黄/绿/红）
        new THREE.MeshBasicMaterial({ color: [0xe8c11a, 0x1fae4a, 0xd63a2a][i] }));
      ring.position.set(x, H + .38, 0);
      g.add(ring);
      g.add(box(.07, .22, .07, M.galv, x, H + .8, 0));                                   // 出线线夹
    });
    /* 急停按钮 + 第二块仪表：近景里看得出是电气柜而不是个方块 */
    g.add(box(.2, .2, .03, M.plate, W * .42, H * .82, D / 2 + .005));
    const estop = new THREE.Mesh(new THREE.CylinderGeometry(.07, .07, .05, 10), new THREE.MeshBasicMaterial({ color: 0xd8342a }));
    estop.rotation.x = Math.PI / 2;
    estop.position.set(W * .42, H * .82, D / 2 + .035);
    g.add(estop);
    g.add(box(.4, .3, .03, M.plate, W * .1, H * .62, D / 2 + .005));
    g.add(box(.34, .24, .04, M.gap, W * .1, H * .62, D / 2 + .03));
    g.add(box(W * .5, .22, .3, M.bridge, 0, .21, D / 2 + .26));                // 进线箱
    g.add(box(.36, .2, .02, M.plate, W * .3, H * .5, D / 2 + .012));           // 铭牌
    g.add(box(.32, .16, .03, new THREE.MeshBasicMaterial({ color: 0xd9a02a }), W * .3, H * .5, D / 2 + .026));
    for (let k = 0; k < 8; k++) {                                              // 散热鳍片
      g.add(box(.06, H * .5, .06, M.acVent, -W / 2 - .05, H * .55, -.5 + k * .16));
    }
    root.add(g);
    groups.pcs = g;
    /* 这个柜子原来只挂卡片不挂浮标，场景里就成了唯一没名字的设备
       （用户问"前面那个像变压器的是啥"）——补上名称 + 实时功率 + 状态 */
    addLabel('pcs', new THREE.Vector3(0, H + 1.05, 0), 'tag3d tag3d-gt');
    addCard('pcs', new THREE.Vector3(0, H + .1, 0));
  }

  /* ---------------- 并网铁塔（国网风格格构塔：收腰塔身 + 三层双侧横担 + 绝缘子串 + 架空线） ---------------- */
  function buildTower(root) {
    const g = new THREE.Group();
    g.position.set(TWR_X, 0, TWR_Z);
    const hgt = 9.2;
    const legMat = regMat(std(0x6d8b93, { roughness: .55, metalness: .6 }), { color: 0x6d8b93 }, { color: 0x93a3a8 });
    const braceMat = regMat(std(0x54737b, { roughness: .62, metalness: .55 }), { color: 0x54737b }, { color: 0x7d8f94 });
    const armMat = regMat(std(0x2ee6c8, { emissive: 0x0a5a4a, emissiveIntensity: .35, roughness: .5, metalness: .3 }),
      { color: 0x2ee6c8, emissive: 0x0a5a4a, emissiveIntensity: .35 },
      { color: 0x18b39a, emissive: 0x000000, emissiveIntensity: 0 });
    const insMat = std(0xd8e6e4, { roughness: .35, metalness: .1 });
    const condMat = new THREE.LineBasicMaterial({ color: 0x2ee6c8, transparent: true, opacity: .32 });
    conductorMats.push(condMat);

    /* 塔身半宽：底部宽 → 腰部收窄 → 上部略开（国网塔的收腰轮廓） */
    const halfAt = function (y) {
      const t = Math.max(0, Math.min(1, y / hgt));
      const base = 1.5, waist = .62, top = .84;
      return t < .6 ? base + (waist - base) * (t / .6) : waist + (top - waist) * ((t - .6) / .4);
    };
    const P = function (x, y, z) { return new THREE.Vector3(x * halfAt(y), y, z * halfAt(y)); };
    const member = function (a, b, mat, r) {
      const len = a.distanceTo(b);
      if (len < .03) return;
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r || .04, r || .04, len, 5), mat || legMat);
      m.position.copy(a).lerp(b, .5);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      m.castShadow = true;
      g.add(m);
    };

    const lv = 10;
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (c) {                       // 四条主腿（跟随收腰轮廓）
      for (let i = 0; i < lv; i++) {
        member(P(c[0], hgt * i / lv, c[1]), P(c[0], hgt * (i + 1) / lv, c[1]), legMat, .045);
      }
      /* 每个塔脚一块独立基础（混凝土墩） */
      const bx = c[0] * halfAt(0), bz = c[1] * halfAt(0);
      g.add(box(.66, .4, .66, std(0x2a3a3d, { roughness: .95, metalness: .05 }), bx, .2, bz));
      g.add(box(.36, .28, .36, std(0x3a4c50, { roughness: .9 }), bx, .54, bz));
    });
    /* 塔身爬梯（沿一根主腿的横档 + 两根立杆） */
    for (let i = 0; i < 17; i++) {
      const y = .75 + i * .5, w = halfAt(y);
      g.add(box(.26, .03, .03, braceMat, -w + .12, y, -w - .07));
    }
    g.add(box(.03, hgt - .8, .03, braceMat, -halfAt(.8) + .0, (hgt - .8) / 2 + .8, -halfAt(.8) - .1));
    g.add(box(.03, hgt - .8, .03, braceMat, -halfAt(.8) + .26, (hgt - .8) / 2 + .8, -halfAt(.8) - .1));
    for (let i = 1; i <= lv; i++) {                                                   // 横撑 + 交叉斜撑
      const y = hgt * i / lv, w = halfAt(y);
      g.add(box(w * 2, .04, .04, braceMat, 0, y, -w));
      g.add(box(w * 2, .04, .04, braceMat, 0, y, w));
      g.add(box(.04, .04, w * 2, braceMat, -w, y, 0));
      g.add(box(.04, .04, w * 2, braceMat, w, y, 0));
      if (i < lv) {
        const yn = hgt * (i + 1) / lv, wn = halfAt(yn);
        [[-1, 0], [1, 0], [0, -1], [0, 1]].forEach(function (f) {
          const ax = f[0] * w, az = f[1] * w, bx = f[0] * wn, bz = f[1] * wn;
          member(new THREE.Vector3(ax, y, az), new THREE.Vector3(bx, yn, bz), braceMat, .02);
          member(new THREE.Vector3(ax, y, az), new THREE.Vector3(f[0] ? ax : bx, yn, f[1] ? az : bz), braceMat, .02);
        });
      }
    }

    /* 三层横担（双回路：每层左右各一挑），端部下挂绝缘子串，导线沿线路方向穿越 */
    const ARMS = [[5.9, 2.7], [6.9, 2.4], [7.9, 2.1]];
    ARMS.forEach(function (a, ai) {
      const y = a[0], len = a[1], w = halfAt(y);
      [-1, 1].forEach(function (s) {
        const inn = new THREE.Vector3(s * w, y, 0);
        const tip = new THREE.Vector3(s * (w + len), y, 0);
        member(inn, tip, armMat, .055);
        member(inn.clone().setY(y - .22), tip.clone().setY(y - .3), braceMat, .022);
        const ins = new THREE.Group();                                                // 绝缘子串
        ins.position.copy(tip);
        for (let k = 0; k < 5; k++) {
          const disc = new THREE.Mesh(new THREE.CylinderGeometry(.11, .11, .045, 8), insMat);
          disc.position.y = -.12 - k * .08;
          disc.castShadow = true;
          ins.add(disc);
        }
        g.add(ins);
        const wy = tip.y - .55, wx = tip.x;                                           // 导线（带垂弧，穿过塔位）
        const pts = [];
        for (let k = 0; k <= 24; k++) {
          const z = -17 + (k / 24) * 34;
          const sag = Math.sin(Math.min(1, Math.abs(z) / 17) * Math.PI / 2) * .85;
          pts.push(new THREE.Vector3(wx, wy - sag, z));
        }
        g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), condMat));
        /* 防振锤只在中层横担两侧各挂一个示意（挂满一排反而假） */
        if (ai === 1) {
          const zz = 6.5;
          const sag = Math.sin(Math.min(1, Math.abs(zz) / 17) * Math.PI / 2) * .85;
          const dm = new THREE.Group();
          dm.position.set(wx, wy - sag, zz);
          dm.add(box(.04, .2, .04, braceMat, 0, -.1, 0));
          [-1, 1].forEach(function (sd) {
            const wgt = new THREE.Mesh(new THREE.CylinderGeometry(.05, .05, .18, 8), insMat);
            wgt.rotation.x = Math.PI / 2;                                             // 圆柱沿导线方向
            wgt.position.set(sd * .1, -.22, 0);
            dm.add(wgt);
          });
          g.add(dm);
        }
      });
    });
    /* 塔顶地线支架 + 地线 */
    const tw = halfAt(hgt);
    member(new THREE.Vector3(-tw, hgt, 0), new THREE.Vector3(0, hgt + .9, 0), legMat, .04);
    member(new THREE.Vector3(tw, hgt, 0), new THREE.Vector3(0, hgt + .9, 0), legMat, .04);
    g.add(box(tw * 2.6, .06, .06, braceMat, 0, hgt + .55, 0));
    const gpts = [];
    for (let k = 0; k <= 24; k++) {
      const z = -17 + (k / 24) * 34;
      gpts.push(new THREE.Vector3(0, hgt + .9 - Math.sin(Math.min(1, Math.abs(z) / 17) * Math.PI / 2) * .55, z));
    }
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(gpts), condMat));

    root.add(g);
    groups.grid = g;
    /* 杆号牌：贴在塔身下部正面，近景能看清线路编号 */
    const tagTex = tex(function (gg, w2, h2) {
      gg.fillStyle = '#1d2a2e'; gg.fillRect(0, 0, w2, h2);
      gg.strokeStyle = 'rgba(232,255,250,.85)'; gg.lineWidth = 2; gg.strokeRect(3, 3, w2 - 6, h2 - 6);
      gg.fillStyle = '#eafffa'; gg.font = 'bold 15px sans-serif';
      gg.textAlign = 'center'; gg.textBaseline = 'middle';
      gg.fillText('1#', w2 / 2, h2 / 2 + 1);
    }, 32, 24);
    const poleTag = new THREE.Mesh(new THREE.PlaneGeometry(.34, .26),
      new THREE.MeshBasicMaterial({ map: tagTex, side: THREE.DoubleSide }));
    poleTag.position.set(halfAt(2.4) + .14, 2.4, 0);
    poleTag.rotation.y = Math.PI / 2;
    g.add(poleTag);
    /* 浮标钉在塔顶上方一点：相机拉近后（模型放大那次）浮标放太高会被场景顶部裁掉，
       下移后各窗口尺寸下都可见，塔顶就是它的指认位置 */
    addLabel('grid', new THREE.Vector3(0, hgt - .85, 0), 'tag3d tag3d-gt');
  }

  /* ---------------- 厂房（工厂用电负荷：放电时给厂房供电） ---------------- */
  function factoryWallTexture(P) {
    return tex(function (g, w, h) {
      g.fillStyle = P.facBg; g.fillRect(0, 0, w, h);
      g.strokeStyle = P.facSeam; g.lineWidth = 2;
      for (let i = 1; i < 10; i++) { const x = i * w / 10; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
      for (let i = 0; i < 6; i++) {                      // 高窗带
        g.fillStyle = P.winFill; g.fillRect(14 + i * 40, 34, 30, 22);
        g.strokeStyle = P.winLine; g.strokeRect(14 + i * 40, 34, 30, 22);
      }
      g.fillStyle = P.facDoor; g.fillRect(w / 2 - 46, h - 80, 92, 76);   // 卷帘门
      g.strokeStyle = P.facDoorLine; g.strokeRect(w / 2 - 46, h - 80, 92, 76);
      for (let i = 0; i < 8; i++) { g.fillStyle = P.facSlat; g.fillRect(w / 2 - 42, h - 76 + i * 9, 84, 3); }
      g.fillStyle = P.facWarn; g.fillRect(0, h - 8, w, 6);
    }, 256, 256, 2);
  }

  function buildFactory(root) {
    const g = new THREE.Group();
    const fx = FAC_X, fz = FAC_Z;
    const W = FAC_W, H = FAC_H, D = FAC_D, RH = FAC_RH;
    const M = texCache.mats;
    const wall = M.facWall;
    const top = .24;                                                                        // 基座顶面

    g.add(box(W + .7, top, D + .7, M.dark, 0, top / 2, 0));                                  // 基座
    const hall = new THREE.Mesh(new THREE.BoxGeometry(W, H, D), [wall, wall, M.cabTop, wall, wall, wall]);
    hall.position.set(0, H / 2 + top, 0);
    hall.castShadow = hall.receiveShadow = true;
    g.add(hall);

    /* 双坡屋顶：两块坡板 + 屋脊盖板 + 前后山墙三角（深色收边，比平顶方盒像真厂房） */
    const run = D / 2 + .4, slope = Math.sqrt(run * run + RH * RH), ang = Math.atan2(RH, run);
    [-1, 1].forEach(function (sz) {
      const p = box(W + .9, .14, slope, M.bridge, 0, top + H + RH / 2, sz * run / 2);
      p.rotation.x = sz > 0 ? ang : -ang;
      p.castShadow = true;
      g.add(p);
    });
    g.add(box(W + 1.0, .18, .36, M.bridge, 0, top + H + RH + .06, 0));                        // 屋脊
    const tri = new THREE.Shape();
    tri.moveTo(-D / 2, 0); tri.lineTo(D / 2, 0); tri.lineTo(0, RH); tri.closePath();
    const triGeo = new THREE.ExtrudeGeometry(tri, { depth: .14, bevelEnabled: false });
    [-1, 1].forEach(function (sx) {
      const m = new THREE.Mesh(triGeo, M.bridge);
      m.rotation.y = sx > 0 ? -Math.PI / 2 : Math.PI / 2;
      m.position.set(sx * (W / 2 - .07), top + H, 0);
      m.castShadow = true;
      g.add(m);
    });

    /* 外墙竖向壁柱 + 檐口线条：光板墙变成有竖向分格的工业立面 */
    for (let k = -3; k <= 3; k++) {
      const px = k * (W / 7);
      [-1, 1].forEach(function (sz) {
        g.add(box(.22, H * .94, .16, M.bridge, px, top + H * .5, sz * (D / 2 + .05)));
      });
    }
    [-1, 1].forEach(function (sz) {
      g.add(box(W + .5, .2, .24, M.bridge, 0, top + H - .1, sz * (D / 2 + .05)));
    });

    /* 屋顶通风器（两侧坡面各一） */
    [-2.8, 2.8].forEach(function (px) {
      const wh = new THREE.Mesh(new THREE.CylinderGeometry(.3, .34, .38, 10), M.galv);
      wh.position.set(px, top + H + RH * .52 + .3, 1.0);
      wh.castShadow = true;
      g.add(wh);
      g.add(box(.72, .06, .72, M.bridge, px, top + H + RH * .52 + .52, 1.0));
    });

    /* 排风筒（后侧穿出屋面，加高） */
    const duct = new THREE.Mesh(new THREE.CylinderGeometry(.42, .5, 6.8, 12), M.duct);
    duct.position.set(-W / 2 + 1.3, top + 3.4, -D / 2 + 1.1);
    duct.castShadow = true;
    g.add(duct);
    g.add(box(1.2, .12, 1.2, M.bridge, -W / 2 + 1.3, top + 6.9, -D / 2 + 1.1));

    /* 水塔（右侧后方，四腿落地） */
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(.95, .95, 1.6, 12), M.galv);
    tank.position.set(W / 2 + 1.7, top + 5.4, -D / 2 + .9);
    tank.castShadow = true;
    g.add(tank);
    [[-.6, -.6], [.6, -.6], [-.6, .6], [.6, .6]].forEach(function (l) {
      g.add(box(.11, 4.6, .11, M.galv, W / 2 + 1.7 + l[0], top + 2.3, -D / 2 + .9 + l[1]));
    });

    /* 大门雨棚 + 装卸平台 + 台阶（贴图上卷帘门在正面底部中间） */
    const canopy = box(4.8, .12, 1.5, M.bridge, 0, 2.6, D / 2 + .75);
    canopy.rotation.x = -.12;
    canopy.castShadow = true;
    g.add(canopy);
    [-2.1, 2.1].forEach(function (sx) {
      g.add(box(.08, .6, .08, M.galv, sx, 2.3, D / 2 + 1.35));
    });
    g.add(box(5.4, .3, 1.2, M.dark, 0, top + .15, D / 2 + .9));                               // 装卸平台
    g.add(box(1.8, .12, 1.1, M.galv, 3.6, top + .06, D / 2 + 1.85));                          // 台阶

    /* 落水管（正面两根，从檐口顺墙到基座） */
    [-1, 1].forEach(function (sx) {
      const dp = new THREE.Mesh(new THREE.CylinderGeometry(.08, .08, H + .2, 8), M.galv);
      dp.position.set(sx * (W / 2 + .3), top + (H + .2) / 2, D / 2 + .12);
      dp.castShadow = true;
      g.add(dp);
      const elbow = new THREE.Mesh(new THREE.CylinderGeometry(.08, .08, .34, 8), M.galv);
      elbow.rotation.x = Math.PI / 2;
      elbow.position.set(sx * (W / 2 + .3), top + .3, D / 2 + .28);
      g.add(elbow);
    });

    /* 厂牌 + 铭牌 */
    g.add(box(3.4, .5, .08, new THREE.MeshBasicMaterial({ color: 0x14e0c0 }), 0, top + H * .8, D / 2 + .12));
    g.add(box(3.7, .64, .06, M.plate, 0, top + H * .8, D / 2 + .07));
    g.add(box(1.7, .36, .05, M.plate, W / 2 - 1.5, top + H * .45, D / 2 + .07));

    /* 办公附房（左侧小楼）：平屋顶 + 屋顶机组 + 墙上电缆进线箱 */
    const off = new THREE.Mesh(new THREE.BoxGeometry(OFF_W, OFF_H, OFF_D), [wall, wall, M.cabTop, wall, wall, wall]);
    off.position.set(OFF_X, OFF_H / 2 + top, OFF_Z);
    off.castShadow = off.receiveShadow = true;
    g.add(off);
    g.add(box(OFF_W + .35, .18, OFF_D + .35, M.bridge, OFF_X, top + OFF_H + .09, OFF_Z));      // 女儿墙
    const ac = new THREE.Mesh(new THREE.CylinderGeometry(.36, .4, .7, 10), M.roofUnit);
    ac.position.set(OFF_X - .7, top + OFF_H + .55, OFF_Z - .3);
    ac.castShadow = true;
    g.add(ac);
    g.add(box(.95, .1, .95, M.bridge, OFF_X - .7, top + OFF_H + .95, OFF_Z - .3));

    const jbMat = std(0x4a5a5c, { roughness: .55, metalness: .45 });
    const jbInner = std(0x27312f, { roughness: .7, metalness: .3 });
    g.add(box(2.8, .82, .2, jbMat, OFF_X + .2, 1.3, OFF_Z + OFF_D / 2 + .1));                 // 电缆进线箱
    g.add(box(2.6, .66, .06, jbInner, OFF_X + .2, 1.3, OFF_Z + OFF_D / 2 + .22));

    /* 厂房进线不单独画了：两堆电池的电缆各自从柜前走电缆沟到附房进线箱（见 layoutStacks） */

    const wrap = document.createElement('div');
    const el = document.createElement('div');
    el.className = 'tag3d tag3d-gt';
    wrap.appendChild(el);
    const o = new THREE.CSS2DObject(wrap);
    o.position.set(0, top + H + RH + 1.5, 0);
    g.add(o);
    facLabelEl = el;

    g.position.set(fx, 0, fz);
    g.userData.key = 'factory';          // 点厂房可展开明细卡
    root.add(g);
    facGroup = g;
    groups.factory = g;
    addCard('factory', new THREE.Vector3(0, top + H * .6, D / 2 + 1.6));
  }

  /* ---------------- 构建场景 ---------------- */
  function buildStation() {
    const root = new THREE.Group();

    /* 地坪：铺得比场地大得多（远处交给雾效淡出），旋转 / 压低视角时看不到地边，也看不到"台下" */
    groundMat = new THREE.MeshStandardMaterial({
      map: gridTexture(), roughness: .95, metalness: .05, transparent: true, opacity: .96
    });
    groundMat.map.repeat.set(10, 10);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(320, 320), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    root.add(ground);
    /* 场地（混凝土平台）：要盖住储能柜、汇流柜、杆塔与厂房（含右侧水塔），别让模型跑到台面外 */
    platformMat = std(0x0b1a1e, { roughness: .9 });
    root.add(box(46, .18, 22, platformMat, 1.6, .09, 1.0));  // 台面（顶面 0.18，设备坐在上面）

    /* 电缆沟盖板：储能柜前 → 汇流柜 → 厂房，放电/充电两组电缆都在沟里走，地面干净 */
    const gutterMat = regMat(std(0x1a2a2f, { roughness: .85 }), { color: 0x1a2a2f }, { color: 0xb4bcbd });
    const gutterSeam = regMat(std(0x0f1c21, { roughness: .9 }), { color: 0x0f1c21 }, { color: 0x9ba5a6 });
    const gutterW = 1.4, gutterZ = 4.5;    // 沟加宽：充电电缆走柜前走廊，厂房电缆在沟里一列列排开
    root.add(box(21.5, .07, gutterW, gutterMat, -1.5, .215, gutterZ));
    root.add(box(21.5, .075, .05, gutterSeam, -1.5, .22, gutterZ - gutterW / 2 + .02));
    root.add(box(21.5, .075, .05, gutterSeam, -1.5, .22, gutterZ + gutterW / 2 - .02));
    for (let x = -12.0; x < 9.0; x += 1.2) {
      root.add(box(.05, .08, gutterW - .12, gutterSeam, x, .22, gutterZ));   // 盖板接缝
    }

    /* 设备贴图：白天 / 夜里各生成一套，切主题时换 map（浅色柜体 vs 深色柜体） */
    texCache.cabFront = { night: cabFrontTexture(TEXPAL.night), day: cabFrontTexture(TEXPAL.day) };
    texCache.cabSide = { night: cabSideTexture(TEXPAL.night), day: cabSideTexture(TEXPAL.day) };
    texCache.pcsFront = { night: pcsFrontTexture(TEXPAL.night), day: pcsFrontTexture(TEXPAL.day) };
    texCache.facWall = { night: factoryWallTexture(TEXPAL.night), day: factoryWallTexture(TEXPAL.day) };

    /* 共用材质（柜体 / 汇流柜 / 厂房都从这里取，登记后跟着主题切换） */
    texCache.mats = {
      cabFront: regMat(new THREE.MeshStandardMaterial({ map: texCache.cabFront[theme], roughness: .55, metalness: .35 }),
        { map: texCache.cabFront.night }, { map: texCache.cabFront.day }),
      cabSide: regMat(new THREE.MeshStandardMaterial({ map: texCache.cabSide[theme], roughness: .6, metalness: .3 }),
        { map: texCache.cabSide.night }, { map: texCache.cabSide.day }),
      pcsFront: regMat(new THREE.MeshStandardMaterial({ map: texCache.pcsFront[theme], roughness: .5, metalness: .45 }),
        { map: texCache.pcsFront.night }, { map: texCache.pcsFront.day }),
      facWall: regMat(new THREE.MeshStandardMaterial({ map: texCache.facWall[theme], roughness: .78, metalness: .18 }),
        { map: texCache.facWall.night }, { map: texCache.facWall.day }),
      cabTop: regMat(std(0x0a1c23, { roughness: .8, metalness: .25 }), { color: 0x0a1c23 }, { color: 0xc3cacb }),
      pcsTop: regMat(std(0x0b1f26, { roughness: .8, metalness: .25 }), { color: 0x0b1f26 }, { color: 0xbcc4c5 }),
      dark: regMat(std(0x08171c, { roughness: .9, metalness: .2 }), { color: 0x08171c }, { color: 0x9aa5a6 }),
      post: regMat(std(0x123642, { roughness: .5, metalness: .5 }), { color: 0x123642 }, { color: 0x93a3a5 }),
      ac: regMat(std(0x0d222a, { roughness: .7, metalness: .35 }), { color: 0x0d222a }, { color: 0xb4bdbf }),
      acVent: regMat(std(0x0a1a20, { roughness: .9 }), { color: 0x0a1a20 }, { color: 0x8d9a9c }),
      slot: regMat(std(0x061418, { roughness: .5 }), { color: 0x061418 }, { color: 0x8a9598 }),
      plate: regMat(std(0x0a1a20, { roughness: .6 }), { color: 0x0a1a20 }, { color: 0xa9b3b4 }),
      fan: regMat(std(0x16404b, { roughness: .5, metalness: .4 }), { color: 0x16404b }, { color: 0x8fa0a2 }),
      bridge: regMat(std(0x0d222a, { roughness: .8 }), { color: 0x0d222a }, { color: 0xaab4b6 }),
      gap: regMat(std(0x1b4a56, { roughness: .45, metalness: .55 }), { color: 0x1b4a56 }, { color: 0x8ea0a3 }),
      bush: regMat(std(0xd8e6e4, { roughness: .35, metalness: .1 }), { color: 0xd8e6e4 }, { color: 0xe6e9e6 }),
      roofUnit: regMat(std(0x123039, { roughness: .6, metalness: .35 }), { color: 0x123039 }, { color: 0x9fadb0 }),
      duct: regMat(std(0x16323a, { roughness: .7, metalness: .35 }), { color: 0x16323a }, { color: 0xa9b6b8 }),
      copper: regMat(std(0xb8783a, { roughness: .45, metalness: .7 }), { color: 0xb8783a }, { color: 0xc98a4a }),
      galv: regMat(std(0x9fb0b4, { roughness: .5, metalness: .6 }), { color: 0x9fb0b4 }, { color: 0xc2ccce })
    };

    for (let i = 0; i < MAXN; i++) {
      const key = 'stack' + i;
      const g = buildStack(key);
      root.add(g);
      /* 每个柜两条电缆（本地坐标，实际走向在 layoutStacks 里按柜位重算）：
         ① 堆 → 厂房：放电回路，柜台右侧引出走电缆沟进厂房
         ② 汇流柜 → 堆：充电回路，从汇流柜右侧接线点过来进柜子左下进线箱 */
      const fpts = [new THREE.Vector3(.55, .3, .95), new THREE.Vector3(.55, .3, 2.4),
        new THREE.Vector3(2.4, .34, 3.7), new THREE.Vector3(4.2, .46, 3.75)];
      const ppts = [new THREE.Vector3(-.55, .3, .95), new THREE.Vector3(-1.2, .34, 1.5),
        new THREE.Vector3(-3.0, .5, 1.8), new THREE.Vector3(-2.4, .85, 2.4)];
      const pcsFlow = addFlow(ppts, g, i);
      pcsFlow.pcs = true;                       // 标记：这条是"汇流柜 → 堆"的充电电缆
      stackCables.push({ flow: addFlow(fpts, g, i), pcs: pcsFlow });
    }

    buildPCS(root);
    buildTower(root);

    /* PCS → 铁塔 出线（全站口径，流向按总功率） */
    const toTower = [new THREE.Vector3(PCS_X - PCS_HW + .2, 1.0, PCS_Z),
      new THREE.Vector3(-11.6, 2.6, 1.6), new THREE.Vector3(-12.6, 4.2, -.8),
      new THREE.Vector3(TWR_X, 5.9, TWR_Z)];
    addFlow(toTower, root, -1);

    buildFactory(root);

    scene.add(root);
    layoutStacks(stackN);
  }

  /* ---------- 按实际堆数排布储能柜 ---------- */
  function layoutStacks(n) {
    stackN = Math.max(1, Math.min(MAXN, n || 2));
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
      if (!sc) continue;
      /* 两条电缆都按本柜位置重算曲线（local 坐标 = 世界坐标 - 本柜 x） */
      const rebuild = function (fl, pts) {
        if (!fl) return;
        const curve = new THREE.CatmullRomCurve3(pts);
        const len = Math.max(1, curve.getLength());
        const seg = Math.max(14, Math.round(len * 4));
        fl.curve = curve;
        fl.len = len;
        fl.tube.geometry.dispose();
        fl.tube.geometry = new THREE.TubeGeometry(curve, seg, .105, 8, false);
        if (fl.core) {
          fl.core.geometry.dispose();
          fl.core.geometry = new THREE.TubeGeometry(curve, seg, .052, 6, false);
        }
        fl.map.repeat.set(Math.max(2, Math.round(len / 4.2)), 1);   // 光纹密度跟着线长走
      };
      /* ① 堆 → 厂房（放电）：柜正面右下引出，起步抬一下从柜前充电电缆上方跨过去；
         西边的柜子先贴着汇流柜前面往东走（不穿汇流柜），到它东侧再转南进电缆沟，
         沿沟向东后接进厂房左侧的办公附房（墙上带进线箱） */
      const gz = 4.2 + i * .3;                         // 电缆沟里一列列排开（间距也放大）
      const annexX = FAC_X + OFF_X + .2 + (i % 2 ? .7 : -.7);   // 附房进线箱上的左/右接入点
      const wallZ = FAC_Z + OFF_Z + OFF_D / 2;         // 附房正面墙
      const turnX = Math.max(x + .45, PCS_X + PCS_HW + .6);
      rebuild(sc.flow, [new THREE.Vector3(.45, .24, .9), new THREE.Vector3(.45, .78, 2.2),
        new THREE.Vector3(turnX - x, .5, 2.25 + i * .06), new THREE.Vector3(turnX - x + .7, .34, 3.9),
        new THREE.Vector3(turnX - x + 2.2, .32, gz), new THREE.Vector3(annexX - x - 2.6, .44, gz),
        new THREE.Vector3(annexX - x + .5, .8, wallZ + 1.4), new THREE.Vector3(annexX - x, 1.1, wallZ - .05)]);
      /* ② 汇流柜 → 堆（充电）：从汇流柜右下出线，向北折进柜前走廊（贴地、两堆一前一后），
         走到本柜左前方进柜子进线箱；厂房电缆从它上方跨过，两条线不相交 */
      const pz = 1.2 + i * .22;                        // 柜前走廊（内侧一列）
      const cx = Math.min(-2.4, x - 1.2);              // 走廊往东走到本柜左前方为止，不走回头路
      rebuild(sc.pcs, [new THREE.Vector3(PCS_X + PCS_HW + .3 - x, .3, 3.4),
        new THREE.Vector3(PCS_X + PCS_HW + .4 - x, .28, 2.7),
        new THREE.Vector3(PCS_X + PCS_HW + .45 - x, .28, 1.75),   // 先绕到汇流柜正前方，再往西/东走
        new THREE.Vector3(cx - x, .28, pz), new THREE.Vector3(-.45, .28, pz), new THREE.Vector3(-.45, .24, .9)]);
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
    /* 没数据时按本站实际 2 个显示（以前兜底 5，未连接时看着像有 5 个堆） */
    return (n >= 1 && n <= MAXN) ? n : 2;
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
      /* 充电 / 放电 / 待机的状态色：夜里是蓝/青，白天充电换成橙色（浅底上更醒目） */
      const chg = d.cur !== null && d.cur < -0.5, dis = d.cur !== null && d.cur > 0.5;
      const p = THEMES[theme];
      const col = chg ? p.stateChg : (dis ? p.stateDis : p.stateIdle);
      if (strip) {
        strip.material.color.setHex(col);
        strip.material.emissive.setHex(col);
        strip.material.emissiveIntensity = (chg || dis) ? .85 : .12;
      }
      /* 柜侧 SOC 光柱：高度按 SOC 从下往上长，颜色随充放电状态（左右各一条） */
      const gg = gauges[key];
      if (gg) {
        const soc = (d.soc === null || d.soc === undefined) ? 0 : Math.max(0, Math.min(100, Number(d.soc)));
        gg.forEach(function (b) {
          b.scale.y = Math.max(.02, soc / 100);
          b.material.color.setHex(col);
        });
      }
      /* 柜底光晕随充放电强弱 */
      const gl = groups[key] && groups[key].userData.glow;
      if (gl) {
        const mag = Math.abs(d.cur === null ? 0 : d.cur);
        gl.material.opacity = (chg || dis) ? Math.min(.26, .1 + mag / 900) : .05;
        gl.material.color.setHex(col);
      }
      /* 柜门状态指示灯：跟着同一套状态色走 */
      const led = groups[key] && groups[key].userData.led;
      if (led) led.material.color.setHex(col);
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

    /* 各柜电缆按"该柜自己"的电流定方向与速度；并网线按并网点电表 */
    for (let i = 0; i < flows.length; i++) {
      const fl = flows[i];
      if (fl.stack >= 0 && fl.stack < MAXN) {
        const d = (fl.stack < stackN) ? stackData(fl.stack) : null;
        const cur = (d && d.cur !== null) ? Number(d.cur) : 0;
        /* 堆 → 厂房：按本堆电流方向；汇流柜 → 堆：充电（电流为负）时由汇流柜流向电池 */
        fl.dir = fl.pcs
          ? (cur < -0.5 ? 1 : (cur > 0.5 ? -1 : 0))
          : (cur > 0.5 ? 1 : (cur < -0.5 ? -1 : 0));
        fl.flip = !!fl.pcs;
        fl.speed = Math.min(4, Math.abs(cur) / 80);
      } else if (fl.stack === -1) {
        /* 并网线：按并网点电表的功率走（正 = 从电网取电，负 = 反向送电）。
           原来用 PCS 功率，放电时会看着像往电网倒送，跟"放电送厂房"对不上 */
        const gp = GaoteService.val('meter-lems-antireflux', 'meter_tot_p');
        const gv = (gp === null || gp === undefined) ? 0 : Number(gp);
        fl.dir = gv > 0.5 ? -1 : (gv < -0.5 ? 1 : 0);
        fl.speed = Math.min(4, Math.abs(gv) / 80);
      }
    }

    setCard('pcs', '汇流 / PCS', [
      ['PCS 总有功', f(emuP, 1, ' kW')], ['PCS 总无功', f(GaoteService.val('emu', 'PCSSumsReactivePower'), 1, ' kVar')],
      ['母线电压', f(GaoteService.val('emu', 'DCBusVol'), 1, ' V')],
      ['允许充电功率', f(GaoteService.val('emu', 'MaxAllowChargPower'), 0, ' kW')],
      ['允许放电功率', f(GaoteService.val('emu', 'MinAllowChargPower'), 0, ' kW')],
      ['系统 SOC', f(emuSoc, 1, '%')]
    ], emuP === null ? '' : (emuP < 0 ? '充电中' : (emuP > 0 ? '放电中' : '待机')));
    const pl = labelEls.pcs;
    if (pl) {
      pl.innerHTML = '<b>汇流 / PCS</b><i>' + f(emuP, 1, ' kW') + '</i><em>'
        + (emuP === null ? '--' : (emuP < 0 ? '充电中' : (emuP > 0 ? '放电中' : '待机'))) + '</em>';
    }
    const gl = labelEls.grid;
    if (gl) gl.innerHTML = '<b>并网点</b><i>' + f(GaoteService.val('meter-lems-antireflux', 'meter_tot_p'), 1, ' kW') + '</i>';

    /* 厂房负荷：放电时电从 PCS 送进厂房（光点流动），待机/充电时进线不流动 */
    facOn = flow.dir > 0;
    if (facLabelEl) {
      facLabelEl.innerHTML = '<b>厂房（工厂用电）</b><i>'
        + (facOn ? ('受电 ' + f(emuP, 1, ' kW')) : '待机') + '</i>';
    }
    setCard('factory', '厂房（工厂用电）', [
      ['进线（受电）', facOn ? f(emuP, 1, ' kW') : '待机'],
      ['并网点功率', f(GaoteService.val('meter-lems-antireflux', 'meter_tot_p'), 1, ' kW')],
      ['储能 SOC', f(emuSoc, 1, '%')],
      ['工作站', '储能放电直供厂房负荷']
    ], facOn ? '放电供电中' : '待机');
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
    if (composer) composer.render(); else renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
  }

  /* ---------------- 白天 / 夜晚主题 ---------------- */
  function applyTheme(t) {
    theme = THEMES[t] ? t : 'night';
    const p = THEMES[theme];
    if (!scene) return;
    scene.background = new THREE.Color(p.bg);
    if (scene.fog) { scene.fog.color.setHex(p.fog); scene.fog.near = p.fogNear; scene.fog.far = p.fogFar; }
    if (groundMat) {
      const old = groundMat.map;
      const map = gridTexture();
      map.repeat.set(10, 10);
      groundMat.map = map;
      groundMat.color.setHex(p.ground);
      groundMat.needsUpdate = true;
      if (old) old.dispose();
    }
    if (platformMat) platformMat.color.setHex(p.platform);
    /* 光纹混合方式跟着主题：夜里加色发光，白天普通混合（否则浅底上看不见） */
    flows.forEach(function (fl) {
      fl.tubeMat.blending = p.flowBlend ? THREE.AdditiveBlending : THREE.NormalBlending;
      fl.tubeMat.needsUpdate = true;
    });
    /* 铁塔导线：白天要把青色压深，否则浅天空下看不见 */
    conductorMats.forEach(function (m) {
      m.color.setHex(p.flowBlend ? 0x2ee6c8 : 0x2e6f7c);
      m.opacity = p.flowBlend ? .32 : .6;
    });
    if (hemiLight) { hemiLight.color.setHex(p.hemiSky); hemiLight.groundColor.setHex(p.hemiGround); hemiLight.intensity = p.hemiInt; }
    if (sunLight) { sunLight.color.setHex(p.sunColor); sunLight.intensity = p.sunInt; }
    if (fillLight) { fillLight.color.setHex(p.fillColor); fillLight.intensity = p.fillInt; }
    if (bloomPass) {
      /* 白天整体本来就亮：泛光阈值拉到 0.95 以上，否则地坪/天空会被泛光"洗白" */
      bloomPass.strength = p.bloom;
      bloomPass.threshold = p.bloomTh;
    }

    /* 天空：白天用渐变穹顶（顶部蓝 → 地平线雾白），夜里收回深色背景 */
    if (p.sky) {
      if (!skyDome) { skyDome = makeSkyDome(p.sky); scene.add(skyDome); }
      skyDome.visible = true;
      scene.background = null;
    } else if (skyDome) {
      skyDome.visible = false;
      scene.background = new THREE.Color(p.bg);
    } else {
      scene.background = new THREE.Color(p.bg);
    }

    /* 设备材质：浅色柜体 / 深色柜体两套配置，一次切完 */
    themeMats.forEach(function (e) {
      const cfg = e[theme] || e.night;
      if (cfg.color !== undefined) e.mat.color.setHex(cfg.color);
      if (cfg.map) e.mat.map = cfg.map;
      if (cfg.emissive !== undefined) e.mat.emissive.setHex(cfg.emissive);
      if (cfg.emissiveIntensity !== undefined) e.mat.emissiveIntensity = cfg.emissiveIntensity;
      e.mat.needsUpdate = true;
    });
  }

  function init(el) {
    if (inited) return;
    host = el;
    const w = el.clientWidth || 900, h = el.clientHeight || 600;
    scene = new THREE.Scene();
    scene.fog = new THREE.Fog(THEMES.night.fog, THEMES.night.fogNear, THEMES.night.fogFar);
    camera = new THREE.PerspectiveCamera(46, w / h, .1, 300);
    camera.position.set(15.2, 9.8, 21.5);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(w, h);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;      // 柔和阴影，硬边阴影显廉价
    el.appendChild(renderer.domElement);

    labelRenderer = new THREE.CSS2DRenderer();
    labelRenderer.setSize(w, h);
    labelRenderer.domElement.style.position = 'absolute';
    labelRenderer.domElement.style.top = '0';
    labelRenderer.domElement.style.pointerEvents = 'none';
    el.appendChild(labelRenderer.domElement);

    hemiLight = new THREE.HemisphereLight(0xbfe9ff, 0x0a1a1e, 1.05);
    scene.add(hemiLight);
    sunLight = new THREE.DirectionalLight(0xffffff, .85);
    sunLight.position.set(9, 14, 7); sunLight.castShadow = true;
    /* 阴影相机覆盖整个场地：设备在地坪上留下接触阴影，白天也不会显得"飘" */
    sunLight.shadow.mapSize.set(2048, 2048);
    sunLight.shadow.camera.left = -24; sunLight.shadow.camera.right = 24;
    sunLight.shadow.camera.top = 20; sunLight.shadow.camera.bottom = -20;
    sunLight.shadow.camera.near = 1; sunLight.shadow.camera.far = 60;
    sunLight.shadow.bias = -0.0012;
    scene.add(sunLight);
    fillLight = new THREE.DirectionalLight(0x2ee6c8, .35);
    fillLight.position.set(-8, 6, -6);
    scene.add(fillLight);

    if (typeof THREE.OrbitControls === 'function') {
      controls = new THREE.OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true; controls.dampingFactor = .08;
      controls.minDistance = 12; controls.maxDistance = 70;
      /* 视角限制在水平线以上：压低到最低也看不到台面下方与地坪边缘 */
      controls.maxPolarAngle = 1.35;
      controls.target.set(1.6, 2.0, 1.0);
      controls.autoRotate = rot.auto; controls.autoRotateSpeed = rot.speed * 6;
    }
    if (typeof THREE.EffectComposer === 'function' && THREE.RenderPass && THREE.UnrealBloomPass) {
      try {
        /* 走了 bloom 离屏渲染后 renderer 自带的抗锯齿就失效了（只作用于默认帧缓冲），
           细杆 / 电缆这些窄物体会出现锯齿和抖动——给 composer 配多重采样渲染目标把 MSAA 找回来 */
        const msaa = (typeof THREE.WebGLMultisampleRenderTarget === 'function')
          ? new THREE.WebGLMultisampleRenderTarget(w, h, { format: THREE.RGBAFormat })
          : null;
        composer = new THREE.EffectComposer(renderer, msaa || undefined);
        if (msaa) composer.setPixelRatio(renderer.getPixelRatio());
        composer.addPass(new THREE.RenderPass(scene, camera));
        bloomPass = new THREE.UnrealBloomPass(new THREE.Vector2(w, h), THEMES.night.bloom, .85, .82);
        composer.addPass(bloomPass);
      } catch (_) { composer = null; }
    }
    buildStation();
    applyTheme(theme);
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
      camera.position.set(15.2, 9.8, 21.5);
      if (controls) { controls.target.set(0.2, 1.7, 0.6); controls.update(); }
    },
    setTheme: function (t) { applyTheme(t); },
    getTheme: function () { return theme; },
    setRotateSync: function (cb) { rot.sync = cb; }
  };
})();
