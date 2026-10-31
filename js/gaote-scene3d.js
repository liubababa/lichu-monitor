/* ============================================================
 * 高特电站三维场景
 *
 * 与场景对齐真实拓扑：储能柜（数量按上报自动排布）+ 汇流/PCS 柜 + 并网杆塔，
 * 数据全部来自 GaoteService（高特协议实时值）：
 *   柜顶色条   —— 充电(蓝) / 放电(青) / 待机(灰)
 *   柜侧光柱   —— 该柜 SOC：高度从下往上按 SOC 生长，颜色随充放电状态
 *   电缆能量流 —— 每根柜线按该柜电流方向流动；并网线（站内 → 铁塔）只画余电上网（橙、上塔），
 *                储能供电期间不亮（现场口径 2026-10-27：储能供电时电网不供电，
 *                关口在取电也不画——那是表读数，只看并网点浮标）；充电 / 待机时按关口表方向画
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
  const contacts = [];      // 接触阴影片，浓度随主题调
  const labelEls = {};      // key -> .tag3d element
  const cardEls = {};       // key -> .card3d element
  const strips = {};        // key -> 柜顶色条
  const gauges = {};        // key -> 柜侧 SOC 光柱
  let inited = false;
  const clock = { last: 0 };

  /* 白天 / 夜晚双主题：默认夜晚（深色科技感），白天为浅色天空 + 浅色地坪。
     场景里用到的可换色对象（地面、台面、灯光、辉光强度）建好后记录在这里 */
  let theme = 'night';
  let groundMat = null, slabYardMat = null, slabEdge = null, siteGlow = null, sweepMesh = null;
  let hemiLight = null, sunLight = null, fillLight = null, bloomPass = null, vigPass = null;
  let envRT = null;                // 天空环境贴图（IBL）的渲染目标
  let camHome = null;              // 默认机位（按画布宽高比算好后存下来，重置视角复用）
  /* 白天 / 夜晚双主题：默认夜晚（深色科技感），白天为浅色天空 + 浅色地坪。
     这里只放本站的"颜色"；灯光量 / 泛光 / 暗角 / 曝光 / 接触阴影这些观感数值
     三站共用，在 js/scene-preset.js 的 ENV 里，别再各写各的 */
  const THEMES = {
    night: {
      bg: 0x04090c, fog: 0x0b1c24, fogNear: 105, fogFar: 300,
      hemiSky: 0xbfe9ff, hemiGround: 0x0a1518,
      sunColor: 0xcfe8ff, fillColor: 0x2ee6c8,
      /* 状态色：充电(蓝) / 放电(青) / 待机(暗绿——原来用近灰的 0x6f9a94，
         待机时整台柜子像断电，电量柱和灯带都"不亮") */
      stateChg: 0x8fd8ff, stateDis: 0x3df0a0, stateIdle: 0x2f8f7d,
      /* 电流光纹：放电(青) / 充电(蓝) / 馈电卖电(橙) / 待机(暗)；夜里用加色混合发光 */
      flowDis: 0x3df0a0, flowChg: 0x8fd8ff, flowSell: 0xffb020, flowIdle: 0x16303a, flowBlend: 1,
      sky: [[0, '#04080c'], [.42, '#071219'], [.66, '#0d2530'], [.84, '#123743'], [1, '#17505f']]
    },
    day: {
      bg: 0xdbe9f0, fog: 0xd3e3ec, fogNear: 120, fogFar: 340,
      hemiSky: 0xdff0ff, hemiGround: 0x76815f,
      sunColor: 0xfff2d0, fillColor: 0xbfe0ff,
      /* 白天：充电(蓝) / 放电(绿) / 待机(青绿，浅底上要能看出柱子和灯边还在) */
      stateChg: 0x1f7fd0, stateDis: 0x159a63, stateIdle: 0x4f9c8c,
      /* 电流光纹：白天浅底用饱和暖色 + 普通混合，否则会被浅底冲淡 */
      flowDis: 0x159a63, flowChg: 0x1f7fd0, flowSell: 0xd97700, flowIdle: 0x9aa9a9, flowBlend: 0,
      /* 天空穹顶的竖直渐变：天顶蓝 → 地平线白雾（相机基本平视，
         所以蓝色要压到接近地平线才看得见，否则整片都是白的） */
      sky: [[0, '#2f74b8'], [.45, '#5fa6d8'], [.62, '#9ccbe4'], [.78, '#cfe2ec'], [1, '#dbe9f0']]
    }
  };

  /* 主题化材质登记：建场景时把每个材质"白天 / 夜里"两套配置登记进来，
     切主题时统一替换（颜色 / 贴图 / 自发光），设备就不会白天还是一团黑 */
  const themeMats = [];
  function regMat(mat, night, day) { themeMats.push({ mat: mat, night: night, day: day }); return mat; }
  let skyDome = null;
  function skyTexture(sky) {
    const stops = sky.stops || sky;
    return tex(function (g, w, h) {
      const grd = g.createLinearGradient(0, 0, 0, h);
      stops.forEach(function (s) { grd.addColorStop(s[0], s[1]); });
      g.fillStyle = grd; g.fillRect(0, 0, w, h);
    }, 16, 256);
  }
  function makeSkyDome(sky) {
    const t = skyTexture(sky);
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(180, 24, 16),
      new THREE.MeshBasicMaterial({ map: t, side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: false })
    );
    mesh.renderOrder = -1;
    return mesh;
  }

  /* 浮标按相机距离缩放：规则三站共用（ScenePreset.scaleLabelTo），这里只给本站的基准距离 */
  const labelPairs = [];             // { obj, el, k }
  const LBL_REF = 26;                // 默认机位附近：浮标 100%
  let _lblV = null;
  function scaleLabels() {
    if (!labelPairs.length || !camera) return;
    if (!_lblV) _lblV = new THREE.Vector3();
    for (let i = 0; i < labelPairs.length; i++) {
      const it = labelPairs[i];
      it.obj.getWorldPosition(_lblV);
      window.ScenePreset.scaleLabelTo(it, camera.position.distanceTo(_lblV), LBL_REF);
    }
  }

  /* 能量流：每条电缆一根发光管，电流光纹沿线滚动，方向各自按数据、速度全站统一 */
  const flows = [];
  const conductorMats = [];                // 铁塔导线材质（颜色随主题）

  /* 柜体数量按实际上报自动排布；间距放大后设备之间不挤（柜宽 2.5，间距 5.2 → 净空 2.7） */
  const MAXN = 8, GAP = 5.2, STACK_W = 2.5, STACK_H = 2.8, STACK_D = 1.5;
  /* 汇流/PCS 柜位置（放在并网铁塔下面，与储能柜排成横向一列）与半宽 */
  const PCS_X = -8.6, PCS_Z = 3.0, PCS_HW = 2.3;
  /* 厂房（含办公附房）位置与尺寸：两层、平顶、正/背面每排 4 扇大窗 */
  const FAC_X = 16.8, FAC_Z = .8, FAC_W = 13.0, FAC_H = 6.2, FAC_D = 8.0, FAC_RH = 1.7;
  /* 办公附房（厂房的左侧小楼）：正面墙上挂电缆进线箱 */
  const OFF_X = -(FAC_W / 2 + 1.0), OFF_Z = FAC_D / 2 - 1.5, OFF_W = 3.2, OFF_H = 3.0, OFF_D = 2.6;
  /* 铁塔位置 */
  const TWR_X = -13.2, TWR_Z = -2.8;
  let stackN = 2;   // 默认按本站实际（2 堆）；连上后按上报的簇数自动排布
  const stackCables = [];   // { flow } 每柜到 PCS 的电缆

  /* 厂房（工厂用电负荷）：放电时电送进厂房，进线光点流动 */
  let facLabelEl = null, facOn = false, facWinMat = null, facSpillMat = null, facFaceMat = null, facWinBase = .8;

  /* ---------------- 基础工具 ---------------- */
  /* envMapIntensity 一律跟共用 preset 走：金属件和玻璃没有天空反射就是平、哑、塑料感 */
  function std(c, o) {
    return new THREE.MeshStandardMaterial(Object.assign(
      { color: c, roughness: .6, metalness: .35, envMapIntensity: window.ScenePreset.env(theme).envInt }, o || {}));
  }
  function box(w, h, d, m, x, y, z) {
    const M = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    M.position.set(x, y, z);
    M.castShadow = M.receiveShadow = true;
    return M;
  }
  /* 倒角盒：原来所有方块都是硬边直角，这是"像纸盒"的直接原因。
     底座 / 压顶 / 立柱 / 空调这些单材质件改用真倒角；
     六面独立贴图的柜身与楼身仍用 Box（ExtrudeGeometry 给不出六面贴图），
     靠四角立柱和檐口把轮廓的圆角读出来 */
  function rbox(w, h, d, m, x, y, z, r) {
    const M = new THREE.Mesh(window.ScenePreset.roundedBoxCached(THREE, w, h, d, r === undefined ? .05 : r), m);
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

  /* 场坪 / 地坪贴图：三站同一份生成器（js/scene-preset.js）。
     一块贴图 = 12m，3 块 4m 板 + 板缝；场坪再叠 3m 一格的数字孪生格网。
     地面和场坪用同一块物理尺寸，两者接缝才对得上。 */
  const TILE_M = 12;
  function paveTex(grid) {
    const tx = window.ScenePreset.paveTexture(THREE, theme, { grid: !!grid, cells: 3, gridCells: 4 });
    /* 地面是斜着看的，不给各向异性远处格线会被 mipmap 糊成一片灰 */
    if (renderer && renderer.capabilities) tx.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return tx;
  }
  const GROUND_REPEAT = 700 / TILE_M;
  const SLAB_REPEAT = [460 / TILE_M, 240 / TILE_M];
  /* 接触阴影统一贴在坪面顶（.18）之上一点点，浓度随主题；收集起来好一起调 */
  function groundContact(parent, x, z, w, d) {
    const PE = window.ScenePreset.env(theme);
    contacts.push(window.ScenePreset.contact(THREE, parent, x, z, w, d, .186, PE.contact));
  }
  /* 场坪上的光池 / 扫光带贴图（洙边同款） */
  function radialGlowTexture() {
    return tex(function (g, w, h) {
      const grd = g.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, w / 2);
      grd.addColorStop(0, 'rgba(255,255,255,.9)');
      grd.addColorStop(.35, 'rgba(255,255,255,.32)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd; g.fillRect(0, 0, w, h);
    }, 128, 128);
  }
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
  /* 设备贴图配色：白天 / 夜晚两套。
     夜里是深色柜体 + 青色发光线；白天换成浅色柜体 + 深灰缝线，
     否则深色设备在亮背景里就是一团剪影 */
  const TEXPAL = {
    night: {
      cabBg: '#dfe5e6', cabPanel: 'rgba(198,208,210,.95)', seam: 'rgba(96,116,120,.32)',
      seam2: 'rgba(46,230,200,.25)', slot: 'rgba(46,230,200,.20)', door: 'rgba(46,230,200,.34)',
      doorIn: 'rgba(46,230,200,.13)', hinge: 'rgba(46,230,200,.55)', plate: 'rgba(46,230,200,.30)',
      warn: 'rgba(224,148,16,.55)', sideBg: '#d6dddd', sideSeam: 'rgba(96,116,120,.26)',
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
    labelPairs.push({ obj: o, el: el, key: key, owner: groups[key] || scene });       /* 供距离缩放 + 遮挡判断 */
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
  /* 浮标遮挡：浮标是 HTML 图层，天生盖在三维模型之上。这里从相机朝浮标锚点打一条射线，
     被别的设备/建筑挡住的浮标就藏掉（自己那一组的构件不算遮挡，否则浮标会被自己的柜子误挡）。
     每 6 帧算一次（约 12 次/秒），开销可以忽略 */
  const occluders = [];
  const labelBlocked = {};
  let _occRay = null, _occV = null, _occDir = null, _occN = 0;
  function updateLabelOcclusion() {
    if (!labelPairs.length || !camera) return;
    if (!occluders.length) { for (const k in groups) occluders.push(groups[k]); }
    if (!occluders.length) return;
    if (++_occN % 6) return;
    if (!_occRay) {
      _occRay = new THREE.Raycaster();
      _occV = new THREE.Vector3();
      _occDir = new THREE.Vector3();
    }
    let dirty = false;
    for (let i = 0; i < labelPairs.length; i++) {
      const it = labelPairs[i];
      if (!it.key) continue;
      it.obj.getWorldPosition(_occV);
      const dist = _occV.distanceTo(camera.position);
      _occDir.copy(_occV).sub(camera.position).normalize();
      _occRay.set(camera.position, _occDir);
      _occRay.near = 0;
      _occRay.far = Math.max(.5, dist - .6);
      const hits = _occRay.intersectObjects(occluders, true);
      let blocked = false;
      for (let h = 0; h < hits.length; h++) {
        let o = hits[h].object, own = false;
        while (o) { if (o === it.owner) { own = true; break; } o = o.parent; }
        if (!own) { blocked = true; break; }
      }
      if (blocked !== !!labelBlocked[it.key]) { labelBlocked[it.key] = blocked; dirty = true; }
    }
    if (dirty) applyLabelVisibility();
  }

  function applyLabelVisibility() {
    /* 明细卡片打开时把所有浮标藏起来：浮标按 3D 位置投影，会压在卡片上（重叠很难看） */
    const cardOpen = !!activeCardKey;
    for (const k in labelEls) {
      const isStack = k.indexOf('stack') === 0;
      const idx = isStack ? parseInt(k.slice(5), 10) : -1;
      /* 没内容的浮标不显示（否则会剩个空心框，看不出是什么） */
      const empty = !labelEls[k].textContent.trim();
      const hide = cardOpen || !labelsOn || empty || (isStack && idx >= stackN) || labelBlocked[k];
      labelEls[k].style.display = hide ? 'none' : '';
    }
    if (facLabelEl) facLabelEl.style.display = (labelsOn && !cardOpen && !labelBlocked.factory) ? '' : 'none';
  }

  /* ---------------- 能量流 ---------------- */
  /* 只做"电流在电线上流动"：一根深色线芯（电缆本体）+ 一根带流动光纹的发光管，不挂沿线光球 */
  function addFlow(pts, parent, stack) {
    let curve;
    try { curve = new THREE.CatmullRomCurve3(pts); } catch (_) { return null; }
    const len = Math.max(1, curve.getLength());
    const seg = Math.max(14, Math.round(len * 4));

    /* 电缆本身是"被照亮的线"而不是"被灯照的表面"：一律 toneMapped:false，
       否则 ACES 会把工况光纹压到看不见，而光纹亮灭正是这张图要表达的信息 */
    const core = new THREE.Mesh(new THREE.TubeGeometry(curve, seg, .052, 6, false),
      new THREE.MeshBasicMaterial({ color: 0x122a2f, transparent: true, opacity: .95, toneMapped: false }));
    (parent || scene).add(core);

    const tubeMat = new THREE.MeshBasicMaterial({
      map: flowTexture(len), color: 0x16303a, transparent: true, opacity: .3,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
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
      /* 取色分两类（和洙边口径统一）：
         · 储能电缆：放电=青绿、充电=蓝
         · 并网线 / 电网→厂房直供线（stack=-1）：送电（馈电上网）=橙、取电=蓝
         并网线的"取电蓝"只在充电 / 待机时出现（储能放电期间不亮，见 update() 的方向判定）；
         原来两类都用青绿，卖电会被画成"放电"，和洙边的馈电橙对不上 */
      const col = fl.stack === -1
        ? (sd > 0 ? p.flowSell : (sd < 0 ? p.flowChg : p.flowIdle))
        : (sd > 0 ? p.flowDis : (sd < 0 ? p.flowChg : p.flowIdle));
      fl.tubeMat.color.setHex(col);
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

    g.add(rbox(W + .22, .16, D + .22, M.dark, 0, .08, 0, .05));                                 // 底座（倒角）
    const body = new THREE.Mesh(new THREE.BoxGeometry(W, H, D), [M.cabSide, M.cabSide, M.cabTop, M.cabSide, M.cabFront, M.cabSide]);
    body.position.y = H / 2 + .16;
    body.castShadow = body.receiveShadow = true;
    g.add(body);
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (c) {                            // 四角立柱（倒角）
      g.add(rbox(.1, H + .04, .1, post, c[0] * (W / 2 - .02), H / 2 + .16, c[1] * (D / 2 - .02), .028));
    });
    g.add(rbox(W * .72, .3, D * .78, M.ac, 0, H + .33, 0, .06));   // 顶部空调（倒角）
    for (let k = 0; k < 4; k++) {
      g.add(rbox(W * .6, .03, .06, M.acVent, 0, H + .47, -.2 + k * .13, .012));
    }

    const strip = rbox(W * .92, .12, D * .92, std(0x6f9a94, { emissive: 0x000000 }), 0, H + .2, 0, .04);        // 柜顶色条
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
      const socBar = new THREE.Mesh(socGeo, new THREE.MeshBasicMaterial({ color: 0x6f9a94, toneMapped: false }));
      socBar.position.set(sgn * (W / 2 + .062), colBase, colZ);
      g.add(socBar);
      /* 外层光晕：柱体只是涂色，待机色偏暗就看着"没亮"。套一层加色壳，
         做成子物体，update() 里按 SOC 设 scale.y 时光晕自动跟着长 */
      socBar.userData.sleeve = window.ScenePreset.glowSleeve(THREE, socBar, .11, colH, .42, .3);
      gauges[key].push(socBar);
    });

    /* 柜门细节：铰链、把手、铭牌、底部进线箱（让柜子在近景下经得起看） */
    [-1, 1].forEach(function (s) {
      [.3, .7].forEach(function (t) {
        g.add(box(.09, .16, .05, post, s * (W / 2 - .05), .16 + H * t, D / 2 + .03));
      });
    });
    g.add(rbox(.07, .4, .06, post, W / 2 - .28, .16 + H * .5, D / 2 + .04, .02));                                  // 门把手
    g.add(box(.34, .18, .02, M.plate, -W / 2 + .34, .16 + H * .76, D / 2 + .022));                           // 铭牌底
    g.add(box(.3, .14, .03, new THREE.MeshBasicMaterial({ color: 0xd9a02a, toneMapped: false }), -W / 2 + .34, .16 + H * .76, D / 2 + .036));
    g.add(rbox(W * .46, .2, .28, M.ac, 0, .2, D / 2 + .12, .04));                                                  // 底部进线箱
    g.add(rbox(W * .2, .06, .18, M.fan, -W * .3, H + .5, D * .1, .025));                                            // 顶部风机

    /* 门锁、状态指示灯、接地排、柜号牌：近景里经得起看的细节 */
    g.add(box(.05, .13, .05, post, W / 2 - .6, .16 + H * .32, D / 2 + .045));                                // 门锁
    g.add(box(.17, .11, .03, M.slot, -W / 2 + .3, .16 + H * .9, D / 2 + .02));                               // 指示灯底座
    const led = new THREE.Mesh(new THREE.BoxGeometry(.12, .07, .04), new THREE.MeshBasicMaterial({ color: 0x6f9a94, toneMapped: false }));
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
      new THREE.MeshBasicMaterial({ color: 0x2ee6c8, transparent: true, opacity: .06, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    glow.rotation.x = -Math.PI / 2;
    glow.position.set(0, .2, 0);
    glow.renderOrder = 3;
    g.add(glow);
    g.userData.glow = glow;
    /* 接触阴影：方向光的阴影在夜里很弱，只靠它柜子一定飘。脚下先落一层软黑 */
    groundContact(g, 0, 0, W * 1.5, D * 1.9);

    g.userData.key = key;
    groups[key] = g;
    /* 相邻柜子的浮标错开高度 + 再往两侧让一点：光靠高度错开不够，
       在扁画布上「堆 1 / 堆 2」浮标仍会横向压住（实测重叠 15×51 px） */
    const si = parseInt(String(key).replace('stack', ''), 10) || 0;
    addLabel(key, new THREE.Vector3(si % 2 ? 1.0 : -1.0, H + .6 + (si % 2) * .95, 0), 'tag3d tag3d-gt');
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
    const TSPAN = 9.5;               // 跨越导线 / 地线在塔两侧各伸出多远（只建了一座塔，别留长断头）
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
        /* 跨越只留塔两侧一小截（原来拉到 ±17m）：画面里只建了这一座塔，
           线伸太远就是"断在半空"，看着像画面上划了几道痕 */
        const pts = [];
        for (let k = 0; k <= 24; k++) {
          const z = -TSPAN + (k / 24) * TSPAN * 2;
          const sag = Math.sin(Math.min(1, Math.abs(z) / TSPAN) * Math.PI / 2) * .85;
          pts.push(new THREE.Vector3(wx, wy - sag, z));
        }
        g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), condMat));
        /* 防振锤只在中层横担两侧各挂一个示意（挂满一排反而假） */
        if (ai === 1) {
          const zz = TSPAN * .55;
          const sag = Math.sin(Math.min(1, Math.abs(zz) / TSPAN) * Math.PI / 2) * .85;
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
      const z = -TSPAN + (k / 24) * TSPAN * 2;
      gpts.push(new THREE.Vector3(0, hgt + .9 - Math.sin(Math.min(1, Math.abs(z) / TSPAN) * Math.PI / 2) * .55, z));
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

  /* 厂房门口的人气（叉车 + 工人）：都不投影，位置在 loop 里推进 */
  const YARD_Y = .18;                      /* 场地台座顶面：人和叉车站在这个高度 */
  const facWalk = [], facLimbs = [];
  let facFork = null;

  function buildFactory(root) {
    const g = new THREE.Group();
    const fx = FAC_X, fz = FAC_Z;
    const W = FAC_W, H = FAC_H, D = FAC_D;
    const M = texCache.mats;
    const top = .24;                                                                        // 基座顶面
    /* 办公附房贴在厂房左侧（-x）这一段 z 区间上：腰线、窗带都要让开这里，
       否则窗带与窗户会穿进附房、腰线会和附房屋顶板糊成"屋檐重叠" */
    const lzEnd = D / 2 + .11;                       /* 附房已删：左侧腰线/窗带通长到前角 */

    g.add(rbox(W + .7, top, D + .7, M.dark, 0, top / 2, 0, .12));                                  // 基座（倒角）
    /* 两层厂房（参考图：现代工业风 —— 白色主墙 + 灰色分段 + 竖向长条窗 + 平顶，
       夜里窗户随"用电"发光，就是参考图那种暖光 + 黑剪影的效果） */
    const wallMat = regMat(std(0xd7dbdc, { roughness: .72, metalness: .12 }),
      { color: 0x9aa3a5 }, { color: 0xe8ecee });                                              // 主墙：白
    const trimMat = regMat(std(0x6b7476, { roughness: .6, metalness: .3 }),
      { color: 0x4a5457 }, { color: 0x8d9598 });                                              // 灰带 / 窗框
    const bandMat0 = regMat(std(0x232a2d, { roughness: .5, metalness: .35 }),
      { color: 0x1b2225 }, { color: 0x2c3438 });                                              // 深色：基座与窗带
    const hall = new THREE.Mesh(new THREE.BoxGeometry(W, H, D), [wallMat, wallMat, trimMat, wallMat, wallMat, wallMat]);
    hall.position.set(0, H / 2 + top, 0);
    hall.castShadow = hall.receiveShadow = true;
    g.add(hall);
    /* 深色基座（参考图底部那道深色） */
    g.add(rbox(W + .18, .45, D + .18, bandMat0, 0, top + .225, 0, .07));

    /* 楼层线：两层建筑只在中间留一道腰线（浅灰带），上边一层窗带 */
    const fy = top + H / 2;
    [-1, 1].forEach(function (sz) {
      g.add(rbox(W + .22, .16, .18, trimMat, 0, fy, sz * (D / 2 + .04), .045));
    });
    g.add(rbox(.18, .16, D + .22, trimMat, W / 2 + .04, fy, 0, .045));                                // 右侧整条
    const lz0 = -(D / 2) - .11;
    g.add(rbox(.18, .16, lzEnd - lz0, trimMat, -(W / 2 + .04), fy, (lz0 + lzEnd) / 2, .045));         // 左侧只到附房边

    /* 平屋顶：炭黑屋面板 + 女儿墙 + 屋顶机组（替换原来的双坡屋顶与山墙） */
    const parH = .55;
    g.add(rbox(W + .5, .18, D + .5, trimMat, 0, top + H + .09, 0, .06));                             // 屋面板
    [-1, 1].forEach(function (sz) {
      g.add(rbox(W + .6, parH, .26, trimMat, 0, top + H + .18 + parH / 2, sz * (D / 2 + .05), .05));
    });
    [-1, 1].forEach(function (sx) {
      g.add(rbox(.26, parH, D + .6, trimMat, sx * (W / 2 + .05), top + H + .18 + parH / 2, 0, .05));
    });

    /* 窗户贴图（改进版）：窗框 + 窗格 + 暖色室内。
       同一张贴图既当 map 也当 emissiveMap —— 亮灯时透出的是格子里的暖光，
       不再是一整块死白的洞（原来那版就是纯白渐变，夜里/白天都过曝） */
    const winPaneTex = tex(function (gc, w, h) {
      gc.fillStyle = '#3a2f22'; gc.fillRect(0, 0, w, h);
      const m = 4, cw = (w - m * 2) / 2, ch = (h - m * 2) / 3;      /* 2 列 × 3 行玻璃格 */
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 2; c++) {
          const x = m + c * cw, y = m + r * ch;
          const grd = gc.createLinearGradient(0, y, 0, y + ch);
          grd.addColorStop(0, '#fff2d8');
          grd.addColorStop(.55, '#f6d9a4');
          grd.addColorStop(1, '#c9a271');
          gc.fillStyle = grd;
          gc.fillRect(x + 1.5, y + 1.5, cw - 3, ch - 3);
        }
      }
      gc.fillStyle = 'rgba(30,24,18,.55)';                          /* 中梃 / 横档压深，格子才立得起来 */
      gc.fillRect(w / 2 - 2, 0, 4, h);
      for (let r = 1; r < 3; r++) gc.fillRect(0, m + r * ch - 2, w, 4);
    }, 64, 96, 2);
    /* 窗户：暖色室内光（格子里的暖调），夜里 0.5、白天 0.16 —— 不再过曝 */
    const winMat = regMat(new THREE.MeshStandardMaterial({
      map: winPaneTex, emissiveMap: winPaneTex,
      color: 0x20262a, roughness: .35, metalness: .2,
      emissive: new THREE.Color(0xffe2bd), emissiveIntensity: .5
    }), { color: 0x20262a, emissive: new THREE.Color(0xffe2bd), emissiveIntensity: .5 },
      { color: 0x20262a, emissive: new THREE.Color(0xfff3e2), emissiveIntensity: .16 });
    facWinMat = winMat;
    /* 横向深色窗带：整栋只在上面一层做一条带，带内嵌 4 扇大窗（越简洁越显好） */
    const bandMat = bandMat0;
    const bandH = 2.15, bandD = .22;
    const lvY = [top + 4.65];                                                                // 一层不设窗（只留大门）
    function winBand(cx, cy, cz, alongX, len, n, wWin) {
      if (alongX) g.add(box(len, bandH, bandD, bandMat, cx, cy, cz));
      else g.add(box(bandD, bandH, len, bandMat, cx, cy, cz));
      const inner = len - .5, wwv = wWin || .5;
      for (let i = 0; i < n; i++) {
        const off = -inner / 2 + (i + .5) * (inner / n);
        const px = alongX ? cx + off : cx;
        const pz = alongX ? cz : cz + off;
        const ww = alongX ? wwv : bandD + .06;
        const dd = alongX ? bandD + .06 : wwv;
        g.add(box(ww, bandH - .5, dd, winMat, px, cy, pz));                    // 玻璃（用电发光）
        const mw = alongX ? .08 : bandD + .1;
        const md = alongX ? bandD + .1 : .08;
        g.add(box(mw, bandH, md, trimMat, alongX ? px + wwv / 2 : px, cy, alongX ? pz : pz + wwv / 2));  // 竖挺
      }
    }
    [-1, 1].forEach(function (sz) {
      lvY.forEach(function (cy) { winBand(0, cy, sz * (D / 2 + .03), true, W - .3, 4, 2.0); });    // 正面/背面每排 4 扇大窗
    });
    /* 左侧被办公附房占住一段：窗带只画附房前面那一截，不让窗带和窗穿进附房里 */
    const lzStart = -(D / 2) + .15;
    lvY.forEach(function (cy) {
      winBand(W / 2 + .03, cy, 0, false, D - .3, 2, 2.0);                                      // 右侧每排 2 扇
      winBand(-(W / 2 + .03), cy, (lzStart + lzEnd) / 2, false, lzEnd - lzStart, 2, 1.6);       // 左侧让开附房
    });
    /* 窗带在正面墙上的柔光：光晕开在墙面上（不是只亮窗框里那几个方块），
       整片光居中、和窗带一起呼吸 */
    const faceGlowTex = tex(function (gc, w, h) {
      const grd = gc.createRadialGradient(w / 2, h / 2, 4, w / 2, h / 2, w * .5);
      grd.addColorStop(0, 'rgba(255,255,255,.6)');
      grd.addColorStop(.5, 'rgba(255,255,255,.2)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      gc.fillStyle = grd; gc.fillRect(0, 0, w, h);
    }, 128, 64);
    facFaceMat = new THREE.MeshBasicMaterial({ map: faceGlowTex, transparent: true, opacity: .2, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    const faceGlow = new THREE.Mesh(new THREE.PlaneGeometry(W - .2, bandH * 2.6), facFaceMat);
    faceGlow.position.set(0, top + 4.65, D / 2 + .06);
    g.add(faceGlow);
    /* 屋顶不做光伏：莒南这个厂房屋顶是干净的平顶（真实站点没有光伏） */

    /* 参考图里屋顶是干净的平顶（无设备），也不设外挂水塔/排风筒 */

    /* 大门/卷帘门 + 雨棚 + 装卸平台：按参考图放在正面偏左一侧（附房旁边） */
    const doorX = -2.4;
    const canopy = box(4.4, .12, 1.5, trimMat, doorX, 2.7, D / 2 + .75);
    canopy.rotation.x = -.12;
    canopy.castShadow = true;
    g.add(canopy);
    [doorX - 1.9, doorX + 1.9].forEach(function (sx) {
      g.add(box(.08, .6, .08, M.galv, sx, 2.4, D / 2 + 1.35));
    });
    g.add(box(4.6, .26, 1.2, M.dark, doorX, top + .13, D / 2 + .9));                          // 装卸平台
    g.add(box(1.8, .12, 1.1, M.galv, doorX + 3.0, top + .06, D / 2 + 1.85));                  // 台阶
    /* 大门开着：门洞压暗 + 门帘卷到顶上 + 两侧导轨，门里透出光（跟窗户一起呼吸） */
    const doorW = 3.6, doorH = 2.2, doorY = top + .25 + doorH / 2;
    g.add(box(doorW, doorH, .06, M.dark, doorX, doorY, D / 2 + .015));                         // 门洞
    g.add(box(doorW - .3, doorH - .3, .04, winMat, doorX, doorY - .06, D / 2 + .045));         // 门里的光
    g.add(box(doorW + .15, .38, .26, trimMat, doorX, top + .25 + doorH + .19, D / 2 + .06));   // 卷到顶上的门帘
    [doorX - doorW / 2 - .05, doorX + doorW / 2 + .05].forEach(function (sx) {
      g.add(box(.1, doorH + .12, .12, trimMat, sx, doorY, D / 2 + .05));                        // 两侧导轨
    });
    /* 门口地面上的光晕（加色混合，跟窗户一起明暗） */
    const spillTex = tex(function (gc, w, h) {
      const grd = gc.createRadialGradient(w / 2, 0, 3, w / 2, 0, h);
      grd.addColorStop(0, 'rgba(255,255,255,.8)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      gc.fillStyle = grd; gc.fillRect(0, 0, w, h);
    }, 64, 64);
    facSpillMat = new THREE.MeshBasicMaterial({ map: spillTex, transparent: true, opacity: .26, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    const spill = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 1.2), facSpillMat);
    spill.rotation.x = -Math.PI / 2;
    spill.position.set(doorX, top + .27, D / 2 + .9);
    g.add(spill);

    /* 门口的人气：一台叉车在货台前来回跑 + 两个工人在门口走动。
       都刻意抽象（不做五官/手脚这类细节），也都不投影——省阴影开销，
       而且不会因为"动的东西留在静态阴影里"出现鬼影 */
    const wBodyMat = regMat(std(0x8fa6ab, { roughness: .85 }), { color: 0x9fb3b8 }, { color: 0x8e9ea3 });
    const wLegMat = regMat(std(0x2c3a40, { roughness: .85 }), { color: 0x38464c }, { color: 0x556463 });
    const wHeadMat = regMat(std(0xb9c8cb, { roughness: .8 }), { color: 0xc8d4d6 }, { color: 0xb2c2c6 });
    function addWorker(x0, z0, x1, z1, phase, speed) {
      const p = new THREE.Group();
      /* 特斯拉车机风小人（与洙边同款）：圆润白模、四肢摆动、无五官细节 */
      const bodyMat = regMat(std(0xe8eef0, { roughness: .55 }), { color: 0xe8eef0 }, { color: 0xdfe6e8 });
      const limbMat = regMat(std(0xcfd8dc, { roughness: .6 }), { color: 0xcfd8dc }, { color: 0xd5dcde });
      const headMat = regMat(std(0xf2f6f7, { roughness: .5 }), { color: 0xf2f6f7 }, { color: 0xe8eef0 });
      function limb(r, len, mat) {
        const gp = new THREE.Group();
        const c = new THREE.Mesh(new THREE.CylinderGeometry(r * .8, r, len, 10), mat);
        c.position.y = -len / 2;
        const cap = new THREE.Mesh(new THREE.SphereGeometry(r * .8, 10, 8), mat);
        cap.position.y = -len;
        gp.add(c, cap);
        return gp;
      }
      const torso = new THREE.Group();
      const tc = new THREE.Mesh(new THREE.CylinderGeometry(.095, .125, .4, 12), bodyMat);
      const t1 = new THREE.Mesh(new THREE.SphereGeometry(.095, 12, 10), bodyMat); t1.position.y = .16;
      const t2 = new THREE.Mesh(new THREE.SphereGeometry(.125, 12, 10), bodyMat); t2.position.y = -.2;
      torso.add(tc, t1, t2);
      torso.scale.z = .85;
      torso.position.y = .95;
      const head = new THREE.Mesh(new THREE.SphereGeometry(.115, 14, 12), headMat);
      head.position.y = 1.28;
      const armL = limb(.042, .32, limbMat); armL.position.set(-.155, 1.06, 0);
      const armR = limb(.042, .32, limbMat); armR.position.set(.155, 1.06, 0);
      const legL = limb(.058, .46, limbMat); legL.position.set(-.07, .60, 0);
      const legR = limb(.058, .46, limbMat); legR.position.set(.07, .60, 0);
      p.add(torso, head, armL, armR, legL, legR);
      facLimbs.push({ armL: armL, armR: armR, legL: legL, legR: legR });
      g.add(p);
      const len = Math.hypot(x1 - x0, z1 - z0);
      facWalk.push({ g: p, a: [x0, z0], b: [x1, z1], len: len, dist: (phase || 0) * len, speed: speed || .8,
        limbs: facLimbs[facLimbs.length - 1] });
    }
    addWorker(-3.5, 6.0, 1.6, 6.0, 0, .72);                    /* 货台前的人行道（厂房局部坐标） */
    addWorker(-1.0, 6.0, 2.4, 6.0, .55, .95);
    /* 叉车（重做）：现场同款电动平衡重叉车 —— 后配重 / 驾驶舱 / 门架三段剪影，
       货叉上是一板托盘货。原来那版"难看"的直接原因是门架两根立柱把高度 1.5
       当成材质传进了 box()：材质不是 Material，three 判 material.visible 为假就整根不画，
       所以画面上只剩一根 1.72 m 的悬浮顶梁。
       仍是抽象块面拼装、不投影（阴影图是冻结的，动的东西投影会留鬼影）；
       货叉一律朝 +x，行进方向靠 rotation.y 翻，跑货台前那条独立车道（不跟人重叠）。
       车色夜里压到 0x8f6a17：厂房白墙在同一套灯光下会打到近白，不压两档就是一块浅色斑。 */
    const fl = new THREE.Group();
    function fB(w, h, d, m, x, y, z) { const o = box(w, h, d, m, x, y, z); o.castShadow = o.receiveShadow = false; return o; }
    function fR(w, h, d, m, x, y, z, r) { const o = rbox(w, h, d, m, x, y, z, r); o.castShadow = o.receiveShadow = false; return o; }
    function fC(rt, rb, h, seg, m, x, y, z) {
      const o = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m);
      o.position.set(x, y, z); return o;
    }
    function fLit(color, w, h, d, x, y, z) {
      const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d),
        new THREE.MeshBasicMaterial({ color: color, toneMapped: false }));
      o.position.set(x, y, z); return o;
    }
    const flBody = regMat(std(0x8f6a17, { roughness: .55, metalness: .28 }), { color: 0x8f6a17 }, { color: 0xd9a13a });
    const flBodyLo = regMat(std(0x63490f, { roughness: .65, metalness: .22 }), { color: 0x63490f }, { color: 0xa87c22 });
    const flSteel = regMat(std(0x8fa0a6, { roughness: .45, metalness: .55 }), { color: 0x8fa0a6 }, { color: 0xc2ccd0 });
    const flMast = regMat(std(0x4e5f66, { roughness: .5, metalness: .5 }), { color: 0x4e5f66 }, { color: 0x8b979c });
    const flDark = regMat(std(0x162126, { roughness: .7, metalness: .3 }), { color: 0x162126 }, { color: 0x2c3a40 });
    const flSeam = regMat(std(0x0f1719, { roughness: .8, metalness: .1 }), { color: 0x0f1719 }, { color: 0x232b2e });
    const flTyre = regMat(std(0x0a1013, { roughness: .95, metalness: .02 }), { color: 0x0a1013 }, { color: 0x1d2428 });
    const flRim = regMat(std(0x55656c, { roughness: .5, metalness: .45 }), { color: 0x55656c }, { color: 0xa8b4b8 });
    const flWood = regMat(std(0x4b3c27, { roughness: .88, metalness: 0 }), { color: 0x4b3c27 }, { color: 0xa8845a });
    const flCarton = regMat(std(0x5a4830, { roughness: .9, metalness: 0 }), { color: 0x5a4830 }, { color: 0xb8925f });
    const flCarton2 = regMat(std(0x42351f, { roughness: .9, metalness: 0 }), { color: 0x42351f }, { color: 0x93744a });
    const flSeat = regMat(std(0x1b252a, { roughness: .78, metalness: .08 }), { color: 0x1b252a }, { color: 0x3a4750 });
    /* 轮子：胎 + 轮辋 + 中心盖 + 5 颗螺栓（螺栓是"轮子在滚"唯一的读数） */
    function fWheel(r, w, x, y, z) {
      const gp = new THREE.Group();
      const ty = fC(r, r, w, 22, flTyre, 0, 0, 0); ty.rotation.x = Math.PI / 2;
      const rm = fC(r * .6, r * .6, w * .92, 18, flRim, 0, 0, 0); rm.rotation.x = Math.PI / 2;
      const cp = fC(r * .22, r * .22, w * 1.04, 12, flMast, 0, 0, 0); cp.rotation.x = Math.PI / 2;
      gp.add(ty, rm, cp);
      const sgn = z > 0 ? 1 : -1;
      for (let k = 0; k < 5; k++) {
        const a = k / 5 * Math.PI * 2;
        gp.add(fB(r * .13, r * .13, w * .16, flSeam, Math.cos(a) * r * .42, Math.sin(a) * r * .42, sgn * w * .5));
      }
      gp.position.set(x, y, z);
      return gp;
    }
    const flWheels = [];
    /* 后段配重：顶面后掠 + 尾面内收，剪影不再是板砖 */
    fl.add(fR(.96, .66, .84, flBody, -.66, .7, 0, .15));
    fl.add(fR(.34, .38, .8, flBody, -1.18, .56, 0, .1));
    fl.add(fB(.05, .3, .66, flSeam, -1.36, .72, 0));
    [-.14, 0, .14].forEach(function (z) { fl.add(fB(.44, .04, .06, flSeam, -1.02, 1.02, z)); });
    /* 底盘 + 中部电池舱 */
    fl.add(fR(1.9, .19, .86, flDark, -.16, .27, 0, .05));
    fl.add(fR(1.14, .38, .84, flBodyLo, .1, .5, 0, .06));
    fl.add(fB(.02, .3, .74, flSeam, .64, .5, 0));
    /* 驾驶位：座椅 / 靠背 / 仪表台 / 方向盘 / 地板 */
    fl.add(fR(.42, .08, .44, flSeat, -.36, .9, 0, .03));
    const flBack = fR(.085, .48, .44, flSeat, -.6, 1.14, 0, .03); flBack.rotation.z = .1; fl.add(flBack);
    fl.add(fR(.26, .42, .46, flBodyLo, -.02, 1.06, 0, .05));
    const flCol = fC(.028, .028, .26, 10, flSteel, .12, 1.24, 0); flCol.rotation.z = 1.1; fl.add(flCol);
    const flWheelRing = new THREE.Mesh(new THREE.TorusGeometry(.125, .022, 8, 18), flDark);
    flWheelRing.position.set(.24, 1.32, 0); flWheelRing.rotation.y = Math.PI / 2; flWheelRing.rotation.x = .55;
    fl.add(flWheelRing);
    fl.add(fR(.34, .04, .42, flSteel, .06, .83, 0, .015));
    /* 护顶架：四柱收细 + 薄顶板 + 前后檐（原来那块"厚桌板"是显丑的主因之一） */
    [[-.62, .46], [-.62, -.46], [.3, .46], [.3, -.46]].forEach(function (a) {
      fl.add(fR(.07, 1.08, .07, flBody, a[0], 1.4, a[1], .022));
    });
    fl.add(fR(1.22, .045, 1.14, flBody, -.16, 1.96, 0, .02));
    fl.add(fR(1.12, .05, .07, flDark, -.16, 1.9, .53, .018));
    fl.add(fR(1.12, .05, .07, flDark, -.16, 1.9, -.53, .018));
    fl.add(fR(1.06, .02, 1.0, flSeam, -.16, 1.99, 0, .01));
    fl.add(fLit(0xdff0ff, .05, .08, .18, -.62, 1.9, .3), fLit(0xdff0ff, .05, .08, .18, -.62, 1.9, -.3));
    /* 门架：双 C 型钢立柱 + 顶/下横梁 + 链条（这次真的会渲染）+ 内架滑道 */
    const flChains = [];
    [.34, -.34].forEach(function (z) {
      fl.add(fR(.12, 2.1, .18, flMast, .8, 1.21, z, .028));
      fl.add(fB(.05, 1.98, .07, flSeam, .875, 1.21, z));
      fl.add(fB(.15, .05, .185, flSeam, .8, .75, z));
      fl.add(fB(.15, .05, .185, flSeam, .8, 1.67, z));
      const ch = fB(.038, 1.3, .038, flDark, .89, .95, z); fl.add(ch); flChains.push(ch);
      fl.add(fR(.07, 1.9, .1, flSteel, .7, 1.1, z, .02));
    });
    fl.add(fR(.14, .12, .82, flMast, .8, 2.28, 0, .03));
    fl.add(fR(.13, .09, .7, flMast, .8, .22, 0, .025));
    /* 载货架 + L 形货叉 + 一板货（随行程升降） */
    const carriage = new THREE.Group();
    carriage.add(fR(.07, .72, .8, flSteel, .92, .36, 0, .03));
    carriage.add(fR(.11, .07, .11, flMast, .84, .72, .3, .02));
    carriage.add(fR(.11, .07, .11, flMast, .84, .72, -.3, .02));
    [.3, -.3].forEach(function (z) {
      carriage.add(fR(.085, .5, .125, flSteel, .98, .3, z, .02));                 /* 叉跟 */
      carriage.add(fR(1.06, .07, .125, flSteel, 1.47, .035, z, .014));            /* 叉臂 */
      const tip = fR(.1, .05, .125, flMast, 1.96, .02, z, .012); tip.rotation.z = -.22;
      carriage.add(tip);
    });
    const flLoad = new THREE.Group();
    flLoad.add(fR(1.02, .045, .96, flWood, 0, .125, 0, .012));
    [-.36, 0, .36].forEach(function (x) { flLoad.add(fB(.15, .075, .9, flWood, x, .075, 0)); });
    flLoad.add(fR(1.02, .03, .96, flWood, 0, .03, 0, .01));
    flLoad.add(fR(.94, .44, .86, flCarton, 0, .37, 0, .018));
    flLoad.add(fB(.035, .46, .88, flSeam, -.2, .37, 0));
    flLoad.add(fB(.035, .46, .88, flSeam, .2, .37, 0));
    flLoad.add(fB(.96, .02, .035, flSeam, 0, .595, 0));
    flLoad.add(fR(.68, .34, .6, flCarton2, .04, .76, .02, .016));
    flLoad.add(fB(.7, .02, .03, flSeam, .04, .93, .02));
    flLoad.add(fB(.02, .36, .62, flSeam, .04, .76, 0));
    flLoad.position.set(1.58, .08, 0);
    carriage.add(flLoad);
    carriage.position.set(0, .12, 0);
    fl.add(carriage);
    /* 四轮：前大后小（轮子内缘要让开车身和门架，别穿模） */
    [[.48, .335, .18, .55], [.48, .335, .18, -.55], [-.84, .255, .15, .52], [-.84, .255, .15, -.52]]
      .forEach(function (a) { const w = fWheel(a[1], a[2], a[0], a[1], a[3]); fl.add(w); flWheels.push(w); });
    /* 顶警示灯：半球 + 底座 + 呼吸光晕（夜里拉远也有一个可读的高光点） */
    const flBeaconMat = new THREE.MeshBasicMaterial({ color: 0xffb020, toneMapped: false });
    const flBeacon = new THREE.Mesh(new THREE.SphereGeometry(.075, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), flBeaconMat);
    flBeacon.position.set(-.16, 2.01, 0);
    const flBeaconBase = fC(.1, .115, .04, 14, flBeaconMat, -.16, 2, 0);
    const flHalo = new THREE.Mesh(new THREE.SphereGeometry(.17, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffb020, toneMapped: false, transparent: true, opacity: .12,
        blending: THREE.AdditiveBlending, depthWrite: false }));
    flHalo.position.set(-.16, 1.99, 0);
    fl.add(flBeacon, flBeaconBase, flHalo);
    fl.add(fLit(0xff4d4d, .05, .11, .17, -1.4, .6, .24), fLit(0xff4d4d, .05, .11, .17, -1.4, .6, -.24));
    fl.add(fB(.05, .11, .6, flSeam, -1.4, .82, 0));
    g.add(fl);
    facFork = { g: fl, car: carriage, wheels: flWheels, chains: flChains, halo: flHalo,
      liftBase: .12, x0: -4.9, x1: 1.3, dist: 0, speed: 1.35 };

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

    /* 办公附房已按现场要求删除（左侧不再有小楼）：两堆电池的电缆改为直接接到
       厂房左侧外墙上的进线箱（见 layoutStacks 的走线） */
    const jbMat = std(0x4a5a5c, { roughness: .55, metalness: .45 });
    const jbInner = std(0x27312f, { roughness: .7, metalness: .3 });
    const jbZ = D / 2 - 1.0;                                   /* 左墙靠前一侧 */
    g.add(box(.34, 1.05, 2.6, jbMat, -(W / 2 + .17), 1.45, jbZ));
    g.add(box(.12, .86, 2.36, jbInner, -(W / 2 + .36), 1.45, jbZ));
    g.add(box(.06, .1, 2.7, std(0xb8c3c4, { roughness: .5, metalness: .4 }), -(W / 2 + .2), 2.06, jbZ));  /* 箱顶小檐（夜里也认得出是个进线箱） */

    const wrap = document.createElement('div');
    const el = document.createElement('div');
    el.className = 'tag3d tag3d-gt';
    wrap.appendChild(el);
    const o = new THREE.CSS2DObject(wrap);
    o.position.set(0, top + H + .8, 0);
    g.add(o);
    facLabelEl = el;
    labelPairs.push({ obj: o, el: el });       /* 厂房标签也要跟着相机距离缩放 */

    g.position.set(fx, 0, fz);
    g.userData.key = 'factory';          // 点厂房可展开明细卡
    root.add(g);
    groups.factory = g;
    addCard('factory', new THREE.Vector3(0, top + H * .6, D / 2 + 1.6));
  }

  /* ---------------- 构建场景 ---------------- */
  function buildStation() {
    const root = new THREE.Group();
    const PE = window.ScenePreset.env(theme);

    /* 地坪：整片混凝土铺装，铺到 700 见方（远处交给雾效），任何角度都看不到地边与"台下" */
    groundMat = new THREE.MeshStandardMaterial({
      map: paveTex(false), roughness: .78, metalness: .05, envMapIntensity: PE.envInt
    });
    groundMat.map.repeat.set(GROUND_REPEAT, GROUND_REPEAT);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(700, 700), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    root.add(ground);
    /* 场合坪：洙边同款网格场坪（尺寸按本站设备范围） */
    slabYardMat = new THREE.MeshStandardMaterial({
      map: paveTex(true), roughness: .76, metalness: .05, envMapIntensity: PE.envInt
    });
    slabYardMat.map.repeat.set(SLAB_REPEAT[0], SLAB_REPEAT[1]);
    root.add(box(460, .18, 240, slabYardMat, 0, .09, 0));
    /* 场坪发光描边（洙边同款）：只勾边界，浓度压到不抢设备 */
    slabEdge = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(460, .18, 240)),
      regMat(new THREE.LineBasicMaterial({ color: 0x2ee6c8, transparent: true, opacity: PE.edge, depthWrite: false, toneMapped: false }),
        { opacity: PE.edge }, { color: 0x0f9682, opacity: window.ScenePreset.env('day').edge }));
    slabEdge.position.y = .09;
    root.add(slabEdge);
    /* 坪面光池：加色径向渐变（洙边同款 150×100） */
    siteGlow = new THREE.Mesh(new THREE.PlaneGeometry(150, 100),
      regMat(new THREE.MeshBasicMaterial({
        map: radialGlowTexture(), color: 0x2ee6c8, transparent: true, opacity: PE.glow,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
      }), { opacity: PE.glow }, { color: 0x0f9682, opacity: window.ScenePreset.env('day').glow }));
    siteGlow.rotation.x = -Math.PI / 2;
    siteGlow.position.y = .2;
    siteGlow.renderOrder = 2;
    root.add(siteGlow);
    /* 扫光带：极淡的加色光带缓慢横移（18s 一轮） */
    sweepMesh = new THREE.Mesh(new THREE.PlaneGeometry(26, 74),
      new THREE.MeshBasicMaterial({
        map: sweepTexture(), color: 0x2ee6c8, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
      }));
    sweepMesh.rotation.x = -Math.PI / 2;
    sweepMesh.position.y = .21;
    sweepMesh.renderOrder = 3;
    root.add(sweepMesh);

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
         ② 电缆井 → 堆：充电回路，从电缆井接线点过来进柜子左下进线箱
         （下面的点只是 build 时的占位几何，layoutStacks 会立刻按柜位重建；
           点序要跟重建后一致——起点在电缆井/柜子右下，dir 语义才是"充=进柜、放=出柜"） */
      const fpts = [new THREE.Vector3(.55, .3, .95), new THREE.Vector3(.55, .3, 2.4),
        new THREE.Vector3(2.4, .34, 3.7), new THREE.Vector3(4.2, .46, 3.75)];
      const ppts = [new THREE.Vector3(-2.4, .85, 2.4), new THREE.Vector3(-3.0, .5, 1.8),
        new THREE.Vector3(-1.2, .34, 1.5), new THREE.Vector3(-.55, .3, .95)];
      const pcsFlow = addFlow(ppts, g, i);
      pcsFlow.pcs = true;                       // 标记：这条是"汇流柜 → 堆"的充电电缆
      stackCables.push({ flow: addFlow(fpts, g, i), pcs: pcsFlow });
    }

    /* 按现场要求去掉"汇流 / PCS 柜"这个模型（PCS 在储能柜内部，现场没有单独柜体）：
       不再建柜体，它自带的浮标与明细卡也一并省掉（都在 buildPCS 里），
       电缆仍按原路由汇到原位置，不悬空 */
    // buildPCS(root);
    buildTower(root);

    /* 全站出线 → 铁塔（充电 / 待机时按关口表方向；储能放电期间只画余电上网，见 stepFlow 前判定）：
       起点落在电缆井上。原来让管末端斜插进地面，
       视觉模型判为"穿模/悬空断头"，改成落在井口，三条线都汇集到这里 */
    const toTower = [new THREE.Vector3(PCS_X - PCS_HW + .2, .2, PCS_Z),
      new THREE.Vector3(-11.6, 2.6, 1.6), new THREE.Vector3(-12.6, 4.2, -.8),
      new THREE.Vector3(TWR_X, 5.9, TWR_Z)];
    addFlow(toTower, root, -1);
    root.add(box(.95, .3, .95, std(0x39484c, { roughness: .85, metalness: .2 }), PCS_X - PCS_HW + .2, .15, PCS_Z));
    root.add(box(.72, .06, .72, std(0x55666a, { roughness: .7, metalness: .3 }), PCS_X - PCS_HW + .2, .32, PCS_Z));

    /* 电网 → 厂房 直供电缆（工况①：电塔既供厂房、又给储能充电）。
       现场接线是电网和储能并接在厂房进线上：这条与储能那条并排进同一个进线箱。
       点序按"厂房 → 电缆井"排，这样沿用并网线的方向语义（进口时 dir=-1，正好朝厂房流） */
    const facLine = addFlow([
      new THREE.Vector3(FAC_X - FAC_W / 2 - .16, 1.05, FAC_Z + FAC_D / 2 - 1.4),
      new THREE.Vector3(FAC_X - FAC_W / 2 - 1.3, .46, FAC_Z + FAC_D / 2 - .5),
      new THREE.Vector3(FAC_X - FAC_W / 2 - 3.6, .3, 5.05),
      new THREE.Vector3(-5.5, .3, 4.98),
      new THREE.Vector3(PCS_X - PCS_HW + .2, .22, PCS_Z + .38)
    ], root, -1);
    /* 标记：这条是"电网 → 厂房"直供线。亮不亮看三件事：
       ① 储能没在供电（充电 / 待机）——储能放电期间一律不亮（2026-10-27 现场口径：
          储能供电时电网不供电，两者不同时供厂房）；
       ② 厂房自己确实从电网取电（不能只看关口表：工况②关口取电全是给储能充电的，这条不该亮）；
       ③ 充电时先扣掉储能吃掉的那部分，剩的才算进厂房 */
    if (facLine) facLine.fac = true;

    /* ---------- 降水（与洙边同源天气；只做视觉效果，不展示任何数据） ----------
       420 滴合批成一个 InstancedMesh：洙边当年雨写成 420 个独立网格，帧率掉到卡顿 */
    rainMat = new THREE.MeshBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: .5 });
    rainInst = new THREE.InstancedMesh(new THREE.CylinderGeometry(.022, .022, .9, 4), rainMat, RAIN_N);
    rainInst.visible = false;
    rainInst.frustumCulled = false;                /* 位置每帧改，包围盒不跟着走 */
    const rmat = new THREE.Matrix4();
    for (let i = 0; i < RAIN_N; i++) {
      rainX[i] = (Math.random() - .5) * 74;
      rainY[i] = Math.random() * 28 + 2;
      rainZ[i] = (Math.random() - .5) * 62;
      rainV[i] = 2.4 + Math.random() * 2;
      rmat.makeTranslation(rainX[i], rainY[i], rainZ[i]);
      rainInst.setMatrixAt(i, rmat);
    }
    rainInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(rainInst);

    buildFactory(root);

    /* 大件落地阴影：夜里方向光很弱，铁塔和厂房单靠它会飘在格子上 */
    groundContact(root, TWR_X, TWR_Z, 5.4, 5.4);
    groundContact(root, FAC_X, FAC_Z, FAC_W + 3.4, FAC_D + 3.2);

    scene.add(root);
    layoutStacks(stackN);
  }

  /* ---------- 按实际堆数排布储能柜 ---------- */
  function layoutStacks(n) {
    stackN = Math.max(1, Math.min(MAXN, n || 2));
    /* 阴影贴图是冻结的，柜数一变要补烘一次，否则旧柜子的影子留在地上 */
    if (renderer && renderer.shadowMap) renderer.shadowMap.needsUpdate = true;
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
      /* ① 堆 → 厂房（放电）：柜正面右下引出 → 向南进电缆沟 → 沿沟向东 → 上厂房左墙进线箱
         （PCS 柜与办公附房均已删除，两堆各走一道、互不打架） */
      const gz = 4.2 + i * .45;                        // 电缆沟里各走一道，间距拉大，两堆不打架
      const wallX = FAC_X - FAC_W / 2;                 // 厂房左侧（西）外墙
      const landZ = FAC_Z + FAC_D / 2 - 1.6 + i * .8;  // 左墙靠前一侧的进线点，两堆错开
      const turnX = Math.max(x + .45, PCS_X + PCS_HW + .6);
      /* 一条线一口气走完：柜前出来 → 向南 → 沿电缆沟向东 → 折上左墙进线箱。
         不再为"跨过充电电缆"上下起伏，两线在平地交叉即可（原来会被看成 S 形乱绕） */
      rebuild(sc.flow, [new THREE.Vector3(.5, .26, 1.0), new THREE.Vector3(.5, .28, 3.5),
        new THREE.Vector3(turnX - x, .28, 3.8), new THREE.Vector3(turnX - x + 1.8, .3, gz),
        new THREE.Vector3(wallX - x - 2.6, .3, gz), new THREE.Vector3(wallX - x - 1.2, .5, landZ + .9),
        new THREE.Vector3(wallX - x - .16, 1.1, landZ)]);
      /* ② 电网 → 堆（充电）：从电缆井引过来，沿柜前走廊（两堆一前一后）进本柜进线箱 */
      const pz = 1.05 + i * .5;                        // 柜前走廊：两堆各一道，前后分开走
      const cx = Math.min(-2.4, x - 1.2);              // 走廊往东走到本柜左前方为止，不走回头路
      rebuild(sc.pcs, [new THREE.Vector3(PCS_X - PCS_HW + .2 - x, .2, PCS_Z),
        new THREE.Vector3(-9.6 - x, .24, 2.4),
        new THREE.Vector3(-8.4 - x, .28, pz - .3),
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
      /* 分堆号优先取 _meta.arr；没有这个字段时从键名解析（键形如 cluster|0|-1|0|，
         第二段就是分堆号）——否则整套分堆数据会全读成 -- */
      const key = Object.keys(s).filter(function (k) {
        const p = k.split('|');
        if (p[0] !== dim) return false;
        const a = (s[k]._meta && s[k]._meta.arr !== undefined) ? s[k]._meta.arr : p[1];
        return String(a) === String(arr);
      })[0];
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

  /* 全站额定功率（kW）：EMU 的允许充 / 放功率里取大的。没上报按 250 兜底，
     用来把"当时功率"换算成 0~1 的负载比例（光纹速度全站共用这一个比例） */
  function ratedPower() {
    const a = Number(GaoteService.val('emu', 'MaxAllowChargPower'));
    const b = Number(GaoteService.val('emu', 'MinAllowChargPower'));
    const v = Math.max(isFinite(a) ? Math.abs(a) : 0, isFinite(b) ? Math.abs(b) : 0);
    return v > 1 ? v : 250;
  }

  function update() {
    if (!inited) return;
    const emuP = stationPower();
    const emuSoc = GaoteService.val('emu', 'SumsSOC');

    /* 全站总有功：正 = 放电（柜 → PCS → 电网 / 厂房），负 = 充电 */
    const pNum = (emuP === null || emuP === undefined) ? 0 : Number(emuP);

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
        /* 待机也要看得出是一圈亮边（原来 .12 基本是灭的，整台柜子看着"没通电"） */
        strip.material.emissiveIntensity = (chg || dis) ? .9 : .38;
      }
      /* 柜侧 SOC 光柱：高度按 SOC 从下往上长，颜色随充放电状态（左右各一条） */
      const gg = gauges[key];
      if (gg) {
        const raw = d.soc;
        const soc = (raw === null || raw === undefined || !isFinite(Number(raw)))
          ? null : Math.max(0, Math.min(100, Number(raw)));
        gg.forEach(function (b) {
          /* 没上报 SOC 就留一截暗槽（不是缩到看不见，也不是假装满格） */
          b.scale.y = soc == null ? .12 : Math.max(.08, soc / 100);
          b.material.color.setHex(col);
          window.ScenePreset.syncSleeve(b);
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

    /* 各柜电缆按"该柜自己"的电流定方向；光纹速度全站统一（见下） */
    const meterP = GaoteService.val('meter-lems-antireflux', 'meter_tot_p');
    const mv = (meterP === null || meterP === undefined) ? null : Number(meterP);
    const chgNow = pNum < -0.5, disNow = pNum > 0.5;
    /* 全站一个流速：同一时刻所有电缆的光纹跑得一样快（"到厂房"与"到储能"不再一快一慢）。
       参考功率取"全站功率 / 关口功率"里大的那个（谁在动就按谁），除以全站额定功率。
       原来储能电缆拿"每堆功率"、并网线拿"关口功率"，都除以 100，口径差一个堆数
       （5 个堆就慢 5 倍；关口功率还含储能充电那部分，会更快顶到上限），所以看着不一样 */
    const rated = ratedPower();
    const refP = Math.max(Math.abs(pNum), Math.abs(mv === null ? 0 : mv));
    const stSpd = .25 + Math.min(1, refP / rated) * 1.6;

    for (let i = 0; i < flows.length; i++) {
      const fl = flows[i];
      if (fl.stack >= 0 && fl.stack < MAXN) {
        const d = (fl.stack < stackN) ? stackData(fl.stack) : null;
        const cur = (d && d.cur !== null) ? Number(d.cur) : 0;
        /* 每根电缆只在自己该导电时流动，不做双向：
             · 堆 → 厂房 / 堆 → PCS：只在放电（电流为正）时流动
             · 汇流柜 → 堆：只在充电（电流为负）时流动
           原来写成 ±1 双向，充电时"堆 → 厂房"那根会反向亮起来（现场实测到的问题） */
        fl.dir = fl.pcs
          ? (cur < -0.5 ? 1 : 0)
          : (cur > 0.5 ? 1 : 0);
        fl.flip = !!fl.pcs;                      /* 颜色语义仍按充/放区分 */
        fl.speed = stSpd;
      } else if (fl.stack === -1) {
        const hasGp = mv !== null && isFinite(mv);
        const gv = hasGp ? mv : 0;
        if (fl.fac) {
          /* 电网 → 厂房 直供线：只在"储能没在供电"（充电 / 待机）时才可能亮——
             现场口径（2026-10-27）：储能供电时电网不供电，两者不同时供厂房，
             所以储能放电期间这条一律不亮（关口取电只体现在并网点浮标的数值上）。
             真正送进厂房的 = 关口取电 − 储能充电吃掉的那部分：
             两者差不多（工况②）说明厂房没负荷，这条不亮；待机时关口取电都进厂房 */
          const facP = chgNow ? Math.max(0, gv - Math.abs(pNum)) : Math.max(0, gv);
          fl.dir = (!disNow && hasGp && facP > 0.5) ? -1 : 0;
        } else if (disNow) {
          /* 并网线（全站出线 → 铁塔）：储能供电时电网不供电（现场口径 2026-10-27）——
             储能放电期间关口就是在取电，这条也不亮（表读数只体现在并网点浮标上），
             只有余电上网（关口在馈电）才亮橙、从站内上塔；
             阈值跟工况③ 的"余电上网"共用同一个 tol，免得文字写"余电上网"、塔线却不亮 */
          const tol = Math.max(1.5, Math.abs(pNum) * .08);
          fl.dir = (hasGp && gv < -tol) ? 1 : 0;
        } else if (hasGp) {
          fl.dir = gv > 0.5 ? -1 : (gv < -0.5 ? 1 : 0);
        } else {
          fl.dir = pNum < -0.5 ? -1 : 0;
        }
        fl.speed = stSpd;
      }
    }

    if (cardEls.pcs) setCard('pcs', '汇流 / PCS', [
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
    if (gl) {
      /* 电表总有功：正=从电网取电、负=往电网送电（和光纹方向同一口径）。
         原来只显示带符号的数字，正负不直观——直接写"取电 / 馈电"，跟洙边铁塔浮标一致 */
      const gpv = GaoteService.val('meter-lems-antireflux', 'meter_tot_p');
      const gnum = (gpv === null || gpv === undefined) ? null : Number(gpv);
      gl.innerHTML = '<b>并网点</b><i>' + (gnum === null ? '--' : (Math.abs(gnum) > .5
        ? (gnum > 0 ? '取电 ' + gnum.toFixed(1) + ' kW' : '馈电 ' + Math.abs(gnum).toFixed(1) + ' kW')
        : '无交换')) + '</i>';
    }

    /* 供电工况（现场三种）：
       ① 电网供电 + 储能充电：电塔既供厂房、又给储能充电（充电时默认这一种）
       ② 电网只给储能充电：厂房无负荷，关口功率 ≈ 储能充电功率（差得小 = 只充电）
       ③ 储能供厂房：储能放电期间一律算储能供电（电网不同时供电，2026-10-27 现场口径）
       判据：储能功率符号 + 关口表功率（表没上报时，充电按①、放电按③，不臆造）
       只有③才是"储能送厂房"；①②里厂房是电网在供，不能显示成"待机" */
    facOn = disNow;
    let powerMode = '—', powerModeTxt = '待机', powerModeNote = '储能无充放，厂房由电网供电';
    if (chgNow) {
      const onlyChg = (mv !== null && Math.abs(Math.abs(mv) - Math.abs(pNum)) < Math.max(1.5, Math.abs(pNum) * .08));
      if (onlyChg) {
        powerMode = '②'; powerModeTxt = '电网只给储能充电';
        powerModeNote = '厂房无负荷，关口功率≈储能充电功率';
      } else {
        powerMode = '①'; powerModeTxt = '电网供电 + 储能充电';
        powerModeNote = (mv === null ? '电塔供厂房并给储能充电（关口表暂无数据）' : '电塔供厂房，同时给储能充电');
      }
    } else if (disNow) {
      /* ③ 只说明"储能放电供电"这一件事。现场口径（2026-10-27）：储能供电时电网不供电——
         不再按关口方向分"储能 + 电网一起供"那一档，放电期间一律按"储能供厂房"写；
         关口取电与否只体现在并网点浮标的数值上，不进工况文案（余电上网是馈电，仍照写） */
      const tol = Math.max(1.5, Math.abs(pNum) * .08);
      powerMode = '③';
      if (mv === null) {
        powerModeTxt = '储能单独供厂房'; powerModeNote = '储能放电直供厂房（关口表暂无数据）';
      } else if (mv < -tol) {
        powerModeTxt = '储能供厂房 + 余电上网'; powerModeNote = '储能放电供厂房，余电往电网送';
      } else if (mv > tol) {
        powerModeTxt = '储能单独供厂房'; powerModeNote = '储能放电直供厂房，电网不参与供电';
      } else {
        powerModeTxt = '储能单独供厂房'; powerModeNote = '储能放电直供厂房，关口基本不交换';
      }
    }
    /* 厂房灯（呼吸灯的基准亮度在这里算，亮暗起伏在 loop 里做）：
       窗格暖光长亮，工厂受电（放电供电）时再亮一档；改进版整体压暗一档，避免过曝 */
    if (facWinMat) {
      const mag = Math.abs(pNum);
      const day = theme === 'day';
      const baseW = facOn ? (day ? .74 : .95) : (day ? .6 : .82);
      const wb = Math.min(day ? .82 : .98, baseW + mag / 420);
      facWinBase = wb * (day ? .3 : .55);
    }
    if (facLabelEl) {
      /* 数值行固定是"受电 x kW"（版式：名称 / 受电功率 / 供电工况）：
         储能供电时就是储能功率；充电 / 待机时是电网进线（关口取电 − 储能充电吃掉的部分），
         正好与电网→厂房直供线"真正送进厂房的那部分"同口径（见上面 stepFlow） */
      const facKw = facOn ? emuP : (mv === null ? null : Math.max(0, mv - (chgNow ? Math.abs(pNum) : 0)));
      facLabelEl.innerHTML = '<b>厂房（工厂用电）</b><i>受电 '
        + (facKw === null ? '-- kW' : f(facKw, 1, ' kW')) + '</i>'
        + (powerMode === '—' ? '' : '<em>' + powerMode + ' ' + powerModeTxt + '</em>');
    }
    if (cardEls.factory) setCard('factory', '厂房（工厂用电）', [
      ['当前工况', powerMode + ' ' + powerModeTxt],
      ['工况说明', powerModeNote],
      ['厂房进线', facOn ? ('储能直供 ' + f(emuP, 1, ' kW')) : '由电网供电'],
      ['并网点功率', f(GaoteService.val('meter-lems-antireflux', 'meter_tot_p'), 1, ' kW')],
      ['储能 SOC', f(emuSoc, 1, '%')]
    ], facOn ? '储能直供中' : powerModeTxt);
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
    if (!w || !h) return;
    camera.aspect = w / h; camera.updateProjectionMatrix();
    renderer.setSize(w, h); labelRenderer.setSize(w, h);
    window.ScenePreset.resizeComposer(composer, bloomPass, w, h);
  }

  /* ---------------- 天气（与洙边同源：只切效果，不产生任何文字） ----------------
     solar.js 拿到天气后同时调 GaoteWeather(wx)，两地同一份天气数据 */
  const RAIN_N = 420, rainX = [], rainY = [], rainZ = [], rainV = [];
  let rainInst = null, rainMat = null, precipNow = 0, _rainRM = null;
  function setWeather(w) {
    const pr = (w && w.precip !== undefined && w.precip !== null) ? Number(w.precip) : 0;
    precipNow = isFinite(pr) ? pr : 0;
    if (rainMat) rainMat.opacity = precipNow > 0 ? Math.min(.62, .34 + precipNow * .06) : .5;
  }
  if (typeof window !== 'undefined') window.GaoteWeather = setWeather;

  function loop(t) {
    raf = requestAnimationFrame(loop);
    const dt = clock.last ? (t - clock.last) / 1000 : 0;
    clock.last = t;
    /* 画布被隐藏（切到别的站 / 站点目录）时不渲染，别在后台空烧 GPU */
    if (!renderer.domElement.offsetWidth || !renderer.domElement.offsetHeight) return;
    if (rot.auto && controls) controls.autoRotate && (controls.autoRotateSpeed = rot.speed * 6);
    if (controls) controls.update();
    stepFlow(dt);
    /* 雨：合批实例每帧下落、落地回绕（无降水时整块隐藏，不花算力） */
    if (rainInst) {
      rainInst.visible = precipNow > 0;
      if (rainInst.visible) {
        const rm2 = _rainRM || (_rainRM = new THREE.Matrix4());
        for (let i = 0; i < RAIN_N; i++) {
          rainY[i] -= rainV[i] * dt * 9;
          if (rainY[i] < 0) rainY[i] += 30;
          rm2.makeTranslation(rainX[i], rainY[i], rainZ[i]);
          rainInst.setMatrixAt(i, rm2);
        }
        rainInst.instanceMatrix.needsUpdate = true;
      }
    }
    /* 扫光带：和洙边同一条横向呼吸光带（18s 一轮） */
    if (sweepMesh && sweepMesh.material.opacity > 0) {
      sweepMesh.position.x = -58 + ((t / 1000) % 18) / 18 * 116;
    }
    scaleLabels();                       /* 浮标跟着相机距离缩放 */
    updateLabelOcclusion();              /* 被模型挡住的浮标藏起来 */
    /* 厂房灯（玻璃 / 门里的光 / 墙面柔光 / 地面光晕）一起呼吸：
       慢一点（约 4.6 秒一轮）、幅度小一点，才显得高级 */
    if (facWinMat) {
      const breath = .86 + .14 * Math.sin(t / 1000 * 1.35);
      facWinMat.emissiveIntensity = facWinBase * breath;
      if (facSpillMat) facSpillMat.opacity = .34 * breath;
      if (facFaceMat) facFaceMat.opacity = .24 * breath;
    }
    /* 厂房门口的人气：工人来回走、叉车在货台前那条道上来回跑（都不投影） */
    for (let i = 0; i < facWalk.length; i++) {
      const w = facWalk[i];
      w.dist += dt * w.speed;
      const mm = w.dist % (w.len * 2);
      const k = w.len > 0 ? (mm <= w.len ? mm : w.len * 2 - mm) / w.len : 0;
      const wp = {
        x: w.a[0] + (w.b[0] - w.a[0]) * k,
        z: w.a[1] + (w.b[1] - w.a[1]) * k
      };
      w.g.position.set(wp.x, YARD_Y + Math.abs(Math.sin(w.dist * 7.5)) * .035, wp.z);
      /* 面朝行进方向（往返折返时平滑掉头） */
      const dirSign = (mm <= w.len) ? 1 : -1;
      const target = Math.atan2((w.b[0] - w.a[0]) * dirSign, (w.b[1] - w.a[1]) * dirSign);
      let diff = target - w.g.rotation.y;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      w.g.rotation.y += diff * Math.min(1, dt * 6);
      /* 四肢随行走摆动（特斯拉车机小人那种节奏） */
      const ph = w.dist * 7.5, sw = Math.sin(ph);
      const L = w.limbs;
      if (L) {
        L.legL.rotation.x = sw * .6;
        L.legR.rotation.x = -sw * .6;
        L.armL.rotation.x = -sw * .4;
        L.armR.rotation.x = sw * .4;
      }
    }
    if (facFork) {
      facFork.dist += dt * facFork.speed;
      const span = facFork.x1 - facFork.x0;
      const mm = facFork.dist % (span * 2);
      const fwd = mm <= span;
      const d = fwd ? mm : span * 2 - mm;
      facFork.g.position.set(facFork.x0 + d, YARD_Y, 7.0);
      facFork.g.rotation.y = fwd ? 0 : Math.PI;          /* 货叉朝行进方向（模型货叉在 +x 侧） */
      /* 货叉随行程缓慢起落（搬运感），链条跟着伸长 */
      const lift = Math.abs(Math.sin(d / span * Math.PI)) * .5;
      facFork.car.position.y = facFork.liftBase + lift;
      for (let i = 0; i < facFork.chains.length; i++) facFork.chains[i].scale.y = 1 + lift * 1.1;
      /* 轮子按行进方向滚（1.35 m/s ÷ 半径 .3） */
      for (let i = 0; i < facFork.wheels.length; i++) {
        facFork.wheels[i].rotation.z -= dt * (fwd ? 1 : -1) * facFork.speed / .3;
      }
      if (facFork.halo) facFork.halo.material.opacity = .06 + .16 * (.5 + .5 * Math.sin(t / 1000 * 4.2));
    }
    if (composer) composer.render(); else renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
  }

  /* ---------------- 白天 / 夜晚主题 ---------------- */
  function applyTheme(t) {
    theme = THEMES[t] ? t : 'night';
    const p = THEMES[theme];
    const PE = window.ScenePreset.env(theme);
    if (!scene) return;
    scene.background = new THREE.Color(p.bg);
    if (scene.fog) { scene.fog.color.setHex(p.fog); scene.fog.near = p.fogNear; scene.fog.far = p.fogFar; }
    /* 水泥地坪 / 场坪跟着主题重画：夜里深灰、白天浅灰（固定种子，切主题不会重排） */
    if (groundMat) {
      const old = groundMat.map;
      groundMat.map = paveTex(false);
      groundMat.map.repeat.set(GROUND_REPEAT, GROUND_REPEAT);
      groundMat.needsUpdate = true;
      if (old) old.dispose();
    }
    if (slabYardMat) {
      const old = slabYardMat.map;
      slabYardMat.map = paveTex(true);
      slabYardMat.map.repeat.set(SLAB_REPEAT[0], SLAB_REPEAT[1]);
      slabYardMat.needsUpdate = true;
      if (old) old.dispose();
    }
    if (sweepMesh) sweepMesh.material.opacity = PE.sweep;
    /* 光纹混合方式跟着主题：夜里加色发光，白天普通混合（否则浅底上看不见） */
    flows.forEach(function (fl) {
      fl.tubeMat.blending = p.flowBlend ? THREE.AdditiveBlending : THREE.NormalBlending;
      fl.tubeMat.needsUpdate = true;
    });
    /* 铁塔导线：白天要把青色压深，否则浅天空下看不见；整体再调淡一档，
       退成背景而不是抢视线的"划痕" */
    conductorMats.forEach(function (m) {
      m.color.setHex(p.flowBlend ? 0x2ee6c8 : 0x2e6f7c);
      m.opacity = p.flowBlend ? .22 : .42;
    });
    /* 灯光颜色留在本站 THEMES，强度一律取共用 preset：ACES 会吃掉约两成中间调，
       光量必须比"没有色调映射"时代给得高，否则改完反而更黑 */
    if (hemiLight) { hemiLight.color.setHex(p.hemiSky); hemiLight.groundColor.setHex(p.hemiGround); hemiLight.intensity = PE.lights.hemi; }
    if (sunLight) { sunLight.color.setHex(p.sunColor); sunLight.intensity = PE.lights.key; }
    if (fillLight) { fillLight.color.setHex(p.fillColor); fillLight.intensity = PE.lights.fill; }
    window.ScenePreset.setExposure(renderer, theme);
    window.ScenePreset.applyThemeToPasses(bloomPass, vigPass, theme);
    contacts.forEach(function (m) { m.material.opacity = PE.contact; });

    /* 天空：白天用渐变穹顶（顶部蓝 → 地平线雾白），夜里也用穹顶给一条地平线微光，
       地面边缘才有"融进大气"的收口，而不是直接淡进纯黑 */
    if (p.sky) {
      if (!skyDome) { skyDome = makeSkyDome(p.sky); scene.add(skyDome); }
      else {
        const oldSky = skyDome.material.map;
        skyDome.material.map = skyTexture(p.sky);
        skyDome.material.needsUpdate = true;
        if (oldSky) oldSky.dispose();
      }
      skyDome.visible = true;
      scene.background = null;
      /* 穹顶顺手烘一张环境贴图：金属件和玻璃没有它一定是平、哑、塑料感 */
      envRT = window.ScenePreset.buildEnvironment(THREE, renderer, scene, skyDome.material.map, envRT);
    } else if (skyDome) {
      skyDome.visible = false;
      scene.background = new THREE.Color(p.bg);
    } else {
      scene.background = new THREE.Color(p.bg);
    }

    /* 设备材质：浅色柜体 / 深色柜体两套配置，一次切完。
       自发光允许写数字或 THREE.Color —— 只当数字处理会把 Color 对象算成黑 */
    themeMats.forEach(function (e) {
      const cfg = e[theme] || e.night;
      if (cfg.color !== undefined) e.mat.color.setHex(cfg.color);
      if (cfg.map) e.mat.map = cfg.map;
      if (e.mat.envMapIntensity !== undefined) e.mat.envMapIntensity = PE.envInt;
      if (cfg.emissive !== undefined && e.mat.emissive) {
        if (typeof cfg.emissive === 'number') e.mat.emissive.setHex(cfg.emissive);
        else e.mat.emissive.copy(cfg.emissive);
      }
      if (cfg.emissiveIntensity !== undefined) e.mat.emissiveIntensity = cfg.emissiveIntensity;
      if (cfg.opacity !== undefined) e.mat.opacity = cfg.opacity;
      e.mat.needsUpdate = true;
    });
    /* 厂房灯的呼吸基准跟着主题：夜里 0.5 的暖光，白天压到 0.16（浅底上不刺眼） */
    facWinBase = theme === 'day' ? .16 : .5;
    if (facWinMat) facWinMat.emissiveIntensity = facWinBase;
  }

  /* 机位：不写死坐标，按当前画布宽高比二分出"装下全场还留出余量"的距离。
     只用到画面的 70% / 68%（横向 / 纵向）—— 屏幕越宽，卡住构图的其实是纵向
     （浮标摞得高），所以两个方向都放宽；数值越小 = 相机退得越远、画面越小。
     除设备本体外，浮标占的高度也算进装框范围（用户："至少能看见他们的全部"） */
  const FIT_X = .70, FIT_Y = .68;
  /* 注意：three.js 是 main.js 之后才动态加载的，本文件刚解析时 THREE 还不存在，
     所以这个"量尺寸用的临时相机"必须等真正用到时再建（写成模块级常量会永远是 null，
     fitDistance 就会一直走兜底值，机位等于没算） */
  let fitCam = null;
  function fitDistance(tgt, dir, pts, aspect) {
    if (!fitCam) {
      if (typeof THREE === 'undefined' || !THREE.PerspectiveCamera) return 44;
      fitCam = new THREE.PerspectiveCamera(46, 1, .1, 300);
    }
    let lo = 10, hi = 95, best = hi;
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

  function init(el) {
    if (inited) return;
    host = el;
    const w = el.clientWidth || 900, h = el.clientHeight || 600;
    scene = new THREE.Scene();
    scene.fog = new THREE.Fog(THEMES.night.fog, THEMES.night.fogNear, THEMES.night.fogFar);
    camera = new THREE.PerspectiveCamera(46, w / h, .1, 300);
    /* 机位照白天新设计的 Demo：铁塔 → 汇流柜/PCS → 电池堆 → 厂房，从左到右收进画面。
       Demo 是在作者更宽的屏幕上定的，机位照搬会因画布比例不同而"要么裁厂房、要么留白太多"，
       所以只固定目标点与视线方向，距离按当前画布算（fitDistance） */
    const camTgt = new THREE.Vector3(3.5, 2, 1);
    const camDir = new THREE.Vector3(15, 9, 26).normalize();
    /* 装下这些点（含浮标高度），全场连名字就都在画里：
       厂房外角 + 厂房浮标、附房、储能柜 + 柜顶浮标、汇流柜 + 浮标、塔脚与塔尖 */
    const fitPts = [
      new THREE.Vector3(23.3, 0, 4.8), new THREE.Vector3(23.3, 8.2, 4.8),
      new THREE.Vector3(23.3, 8.2, -3.2), new THREE.Vector3(10.3, 8.2, -3.2),
      new THREE.Vector3(10.3, 0, 4.8), new THREE.Vector3(7.7, 2.0, 4.8),
      new THREE.Vector3(16.8, 9.8, .8),                                     // 厂房浮标
      new THREE.Vector3(-3.9, 0, -.8), new THREE.Vector3(3.9, 2.8, .8),
      new THREE.Vector3(-3.9, 5.6, -.8), new THREE.Vector3(3.9, 6.3, .8),    // 两个柜顶浮标（奇数柜再高一档）
      new THREE.Vector3(-10.9, 0, 3.7), new THREE.Vector3(-10.9, 2.4, 2.3),
      new THREE.Vector3(-10.9, 5.2, 3.7),                                    // 汇流柜浮标
      new THREE.Vector3(-17, 0, -2.8), new THREE.Vector3(-17, 8.2, -2.8),
      new THREE.Vector3(-9.4, 8.2, -2.8), new THREE.Vector3(-13.2, 9.4, -2.8)
    ];
    const camLen = fitDistance(camTgt, camDir, fitPts, w / h);
    camera.position.copy(camTgt).add(camDir.multiplyScalar(camLen));
    camHome = { pos: camera.position.clone(), tgt: camTgt.clone() };

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(w, h);
    /* ACES 色调映射 + 柔和阴影：自发光超过 1.0 不再直接裁成纯白，高光有滚降 */
    window.ScenePreset.setupRenderer(THREE, renderer, theme);
    el.appendChild(renderer.domElement);

    labelRenderer = new THREE.CSS2DRenderer();
    labelRenderer.setSize(w, h);
    labelRenderer.domElement.style.position = 'absolute';
    labelRenderer.domElement.style.top = '0';
    labelRenderer.domElement.style.pointerEvents = 'none';
    el.appendChild(labelRenderer.domElement);

    const PE0 = window.ScenePreset.env(theme);
    hemiLight = new THREE.HemisphereLight(0xbfe9ff, 0x0a1a1e, PE0.lights.hemi);
    scene.add(hemiLight);
    sunLight = new THREE.DirectionalLight(0xffffff, PE0.lights.key);
    sunLight.position.set(9, 14, 7); sunLight.castShadow = true;
    /* 阴影相机只要罩住设备群（塔 -17 → 厂房 23，柜阵南北 ±8），罩到整片 460 场坪
       等于把 2048 的贴图摊到几百米上，阴影反而糊成一片。
       normalBias 给格构杆件用，负 bias 太大会让细杆的阴影"脱开"自己 */
    sunLight.shadow.mapSize.set(2048, 2048);
    sunLight.shadow.camera.left = -30; sunLight.shadow.camera.right = 30;
    sunLight.shadow.camera.top = 26; sunLight.shadow.camera.bottom = -26;
    sunLight.shadow.camera.near = 1; sunLight.shadow.camera.far = 90;
    sunLight.shadow.bias = -0.0006;
    sunLight.shadow.normalBias = .02;
    sunLight.target.position.set(3, 0, 1);
    scene.add(sunLight.target);
    scene.add(sunLight);
    fillLight = new THREE.DirectionalLight(0x2ee6c8, PE0.lights.fill);
    fillLight.position.set(-8, 6, -6);
    scene.add(fillLight);

    if (typeof THREE.OrbitControls === 'function') {
      controls = new THREE.OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true; controls.dampingFactor = .08;
      controls.minDistance = 12; controls.maxDistance = 95;
      /* 视角限制在水平线以上：压低到最低也看不到台面下方与地坪边缘 */
      controls.maxPolarAngle = 1.35;
      controls.target.copy(camTgt);      /* 必须和机位用同一个目标点，否则每帧 update() 会把镜头重新瞄偏 */
      controls.autoRotate = rot.auto; controls.autoRotateSpeed = rot.speed * 6;
    }
    const cp = window.ScenePreset.compose(THREE, renderer, scene, camera, theme, { width: w, height: h });
    composer = cp.composer; bloomPass = cp.bloomPass; vigPass = cp.vigPass;
    /* 阴影贴图冻结：太阳不动、行人和叉车都刻意不投影，每帧重烘 2048 的阴影图纯属白烧。
       柜数变化 / 换主题时手动补烘一次（见 layoutStacks 与 applyTheme） */
    if (composer) { renderer.shadowMap.autoUpdate = false; renderer.shadowMap.needsUpdate = true; }
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
      if (camHome && camera && controls) {
        camera.position.copy(camHome.pos);
        controls.target.copy(camHome.tgt);
        controls.update();
      }
    },
    setTheme: function (t) { applyTheme(t); },
    getTheme: function () { return theme; },
    setRotateSync: function (cb) { rot.sync = cb; }
  };
})();
