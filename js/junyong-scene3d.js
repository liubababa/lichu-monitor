/* ============================================================
 * 山东峻涌光储电站 · 光储一体三维场景
 *
 *   三套机组品字围合（一号后排左 / 二号后排右 / 三号前排居中）：
 *     一号机组 1 台光储一体柜、二号机组 1 台、三号机组 3 台（共 5 台）
 *   每群 = 一栋厂房（13×6.2×8，白墙 + 二层格窗 + 门斗雨棚台阶 + 北墙空调外机）
 *         + 屋面光伏 4 排 × 5 块（规格同洙边）
 *         + 储能柜（柜门 / 顶部空调 / 侧面 SOC 光柱，颜色随工况）
 *         + 洙边那九条线（贴地电缆 + 电缆墩，空中不架线）+ 本群关口终端箱
 *   并网：一座铁塔立在场地中心（转 90°，10kV 穿越导线沿东西跨，不从屋顶穿过）；
 *        每群一根线从自己关口箱沿地拉到塔位，再"拉线上塔中央"，三个进塔点不交叉。
 *   一号机组柜列镜像到厂房右侧——两排的院子朝中间对咬，塔才塞得进那条空档。
 *
 *   亮线判据与洙边一致（agent-pack/07 六种工况）：
 *     ① 光伏干线 pv ② 光伏下段 pvlow ③ 光伏→厂房 pvh ④ 光伏→储能 sto
 *     ⑤ 国网→储能 gsto ⑥ 并网段 grid ⑦ 铁塔段 tower ⑧ 储能→厂房 stoh ⑨ 电网直供 gl
 *   数据缺失一律不亮（光伏 null≠0；关口没上报就不判买卖电），不编数据。
 *
 *   对外接口：JunyongScene.init / setGroup(i, d) / setStationPv(kw, seen) / setWeather(w) / setTheme(t)
 *            resize / setActive / setLabels / setRotate / resetView
 * ============================================================ */
window.JunyongScene = (function () {
  'use strict';

  var T_ = function () { return window.THREE; };
  /* 三站共用的观感数值与地面 / 接触阴影生成器（js/scene-preset.js） */
  var SP = window.ScenePreset;
  var inited = false, scene, camera, renderer, composer = null, bloomPass = null, vigPass = null, controls, labelR = null;
  var root = null, raf = null, W = 0, H = 0, active = true, last = 0;
  var theme = 'night', labelsOn = true, rotating = false, camHome = null, camAz = 0;
  var flows = [], units = [], tower = null, beacons = [], occluders = [];
  var labelPairs = [], cards = {}, activeCard = null;
  var key = null, hemi = null, fill = null, dome = null;
  /* 环境层（照洙边那套）：坪面光池 / 扫光带 / 日月 / 云 / 降水 / 天空环境贴图 */
  var siteGlow = null, sweepMesh = null, sun = null, sunGlow = null, moon = null;
  var cloudGrp = null, rainInst = null, rainMat = null, cloudMats = [], envRT = null;
  var RAIN_N = 420, rainX = [], rainY = [], rainZ = [], rainV = [], _rainM = null;
  /* 三组机组各自的数据；null = 该路没上报（不亮线，不当 0 处理） */
  var data = [ {}, {}, {} ];
  /* 全站口径：没有分机组数据时，用站级光伏功率驱动三栋的光纹（分群数字仍不编） */
  var stationPv = { seen: false, kw: 0 };
  var wx = { cloud: null, precip: null, isDay: null, radiation: null };

  /* ---------------- 洙边原始尺寸 ---------------- */
  var W2 = 13, H2 = 6.2, D2 = 8, FLOOR_Y = H2 / 2, roofY = H2 + .3;
  var CAB = { w: 2.7, h: 2.6, d: 1.7 }, CABX = -(W2 / 2 + 6), CABZ = 1.55, PITCH = 3.15;
  var TWRX = -22, TWRZ = 4.2, TWRH = 10.4, TBOXX = TWRX + 2.25;
  var NLO = [-6.94, 1.2, .55], NHI = [-6.94, 3.9, .55];
  var LN = { gsto: 3.15, grid: 3.60, stoh: 2.95, gl: 5.45 };
  var COLS = 5, MW = 2.28, MD = 1.13, MT = .045, TILT = .49, ROW_Y = .62, RAIL_Z = .40, RAIL_DROP = .0525;
  var ROWZ = [-2.55, -1.05, 1.05, 2.55], rowW = COLS * MW + (COLS - 1) * .06;
  var GN = ['一号机组', '二号机组', '三号机组'], GCAB = [1, 1, 3];
  /* 三维标签用：厂房名 / 每群那台（组）柜的现场编号，与平台「储能机组」表一致 */
  var GB = ['一号厂房', '二号厂房', '三号厂房'], GCABN = ['6号柜', '7号柜', '3-5号柜'];
  /* 品字：一号（柜列镜像到右）、二号在后排，三号在前排居中；塔在三群中心 */
  var SLOT = 20, SITE = [{ x: -SLOT, z: -12, m: true }, { x: SLOT, z: -12, m: false }, { x: 0, z: 14, m: false }];
  var TWR_AT = { x: 0, z: -3.33 };

  /* 观感数值（泛光 / 暗角 / 曝光 / 灯光量 / 地面 / 接触阴影）三站共用，在 js/scene-preset.js；
     这里只留本站的语义颜色 */
  var THEMES = {
    night: {
      sky: [[0, '#04080c'], [.42, '#071219'], [.66, '#0d2530'], [.84, '#123743'], [1, '#17505f']],
      bg: 0x050b0d, fog: { c: 0x0b1c24, near: 105, far: 300 },
      sweep: SP.ENV.night.sweep, cloud: 0x22343c,
      key: SP.ENV.night.lights.key, keyRad: .42, hemi: SP.ENV.night.lights.hemi, fill: SP.ENV.night.lights.fill,
      steel: 0x46565d, dark: 0x1b272c, top: 0x2b3a42, pad: 0x2a3a40, frame: 0x5a6a70,
      leg: 0x6d8b93, brace: 0x54737b, arm: 0x2ee6c8, ins: 0xd8e6e4,
      wallTop: 0x22333c, wallBot: 0x0d1519, trim: 0x2c4048, base: 0x1b2830, par: 0x1f2f38,
      roofLine: 0x2ee6c8, roofLineO: .72, winC: 0x0e1a1f, winE: 0xeef4f2, winI: .58,
      doorFrame: 0x22333c, door: 0x14262e, doorLight: 0x4e4b40, headGlass: 0x16333c,
      aw: 0x1c2a31, awPost: 0x18242a, step: 0x1a252b, ac: 0x26343b,
      rail: 0x55666e, legP: 0x46565d, tray: 0x3d4d55, walk: 0x26343b,
      edge: 0x2ee6c8, glow: 0x2ee6c8, glowO: .1, cabBase: '#dfe5e6', cabBase2: '#dfe5e6'
    },
    day: {
      sky: [[0, '#2f74b8'], [.45, '#5fa6d8'], [.62, '#9ccbe4'], [.78, '#cfe2ec'], [1, '#dbe9f0']],
      bg: 0xdbe9f0, fog: { c: 0xd3e3ec, near: 120, far: 340 },
      sweep: SP.ENV.day.sweep, cloud: 0xffffff,
      key: SP.ENV.day.lights.key, keyRad: .22, hemi: SP.ENV.day.lights.hemi, fill: SP.ENV.day.lights.fill,
      steel: 0xc6ccce, dark: 0x3c4a50, top: 0xd6dbdc, pad: 0x9aa3a6, frame: 0xb9c1c3,
      leg: 0x93a3a8, brace: 0x7d8f94, arm: 0x18b39a, ins: 0xf2f6f5,
      wallTop: 0xbcc0b7, wallBot: 0x545c58, trim: 0x8d9598, base: 0x515b5e, par: 0xb3b8ad,
      roofLine: 0x0f9682, roofLineO: .4, winC: 0x20262a, winE: 0xfff3e2, winI: .16,
      doorFrame: 0xcfd6d2, door: 0x31505c, doorLight: 0x8e8a7e, headGlass: 0xbcd6dd,
      aw: 0xc3c8c2, awPost: 0xadb2ab, step: 0xaaafa6, ac: 0xdfe4e2,
      rail: 0x9fb0b6, legP: 0x8b9aa0, tray: 0x9aa5a6, walk: 0xadb2a9,
      edge: 0x0f9682, glow: 0x0f9682, glowO: .05, cabBase: '#e9edee', cabBase2: '#e2e7e8'
    }
  };
  /* 线色按"谁在供电"分（同洙边 FLOWC）：光伏黄、电网蓝、储能放电青绿、无出力暗青 */
  var FLOWC = {
    night: { ac: 0xffb020, idle: 0x24444a, dis: 0x3df0a0, buy: 0x8fd8ff, bar: 0x2f8f7d },
    day: { ac: 0xd97700, idle: 0x6f8a86, dis: 0x159a63, buy: 0x1f7fd0, bar: 0x4f9c8c }
  };

  /* ---------------- 基础工具 ---------------- */
  function tex(fn, w, h, sc) {
    var T = T_(), s = sc || 1, c = document.createElement('canvas');
    c.width = (w || 256) * s; c.height = (h || 256) * s;
    var g = c.getContext('2d'); if (s > 1) g.scale(s, s);
    fn(g, w || 256, h || 256);
    var t = new T.CanvasTexture(c); t.anisotropy = 4; return t;
  }
  function std(color, o) {
    var T = T_(); o = o || {};
    return new T.MeshStandardMaterial({ color: color, roughness: o.rough === undefined ? .7 : o.rough,
      metalness: o.metal === undefined ? .2 : o.metal,
      /* 天空反射强度跟共用 preset：金属件和玻璃没有它就是平、哑、塑料感 */
      envMapIntensity: o.env === undefined ? SP.env(theme).envInt : o.env,
      emissive: o.em || 0x000000, emissiveIntensity: o.ei === undefined ? 1 : o.ei });
  }
  function box(w, h, d, m, x, y, z) {
    var T = T_(), o = new T.Mesh(new T.BoxGeometry(w, h, d), m);
    o.position.set(x || 0, y || 0, z || 0); o.castShadow = o.receiveShadow = true; return o;
  }
  /* 倒角盒：原来所有方块都是硬边直角，这是"像纸盒"的直接原因。
     底座 / 压顶 / 立柱 / 空调这些单材质件改用真倒角；
     六面独立贴图的柜身与楼身仍用 Box（ExtrudeGeometry 给不出六面贴图），
     靠四角立柱和檐口把轮廓的圆角读出来 */
  function rbox(w, h, d, m, x, y, z, r) {
    var o = new (T_()).Mesh(SP.roundedBoxCached(T_(), w, h, d, r === undefined ? .05 : r), m);
    o.position.set(x || 0, y || 0, z || 0); o.castShadow = o.receiveShadow = true; return o;
  }
  function cyl(r1, r2, h, m, x, y, z, seg) {
    var T = T_(), o = new T.Mesh(new T.CylinderGeometry(r1, r2, h, seg || 10), m);
    o.position.set(x || 0, y || 0, z || 0); o.castShadow = o.receiveShadow = true; return o;
  }
  function instanced(list, mat, geo) {
    var T = T_();
    if (!list.length) return null;
    var im = new T.InstancedMesh(geo || new T.CylinderGeometry(1, 1, 1, 6), mat, list.length);
    var up = new T.Vector3(0, 1, 0), m = new T.Matrix4(), q = new T.Quaternion(), v = new T.Vector3();
    list.forEach(function (it, k) {
      var a = it[0], b = it[1], th = it[2];
      var dir = new T.Vector3().subVectors(b, a), len = dir.length();
      if (len < .02) { m.makeScale(0, 0, 0); im.setMatrixAt(k, m); return; }
      q.setFromUnitVectors(up, dir.normalize());
      v.addVectors(a, b).multiplyScalar(.5);
      m.compose(v, q, new T.Vector3(th, len, th));
      im.setMatrixAt(k, m);
    });
    im.instanceMatrix.needsUpdate = true; im.castShadow = true; im.receiveShadow = true;
    return im;
  }
  function spanLine(g, m, ax, ay, az, bx, by, bz, sag, seg) {
    var T = T_(), pts = []; seg = seg || 16;
    for (var k = 0; k <= seg; k++) {
      var t = k / seg;
      pts.push(new T.Vector3(ax + (bx - ax) * t, ay + (by - ay) * t - Math.sin(t * Math.PI) * sag, az + (bz - az) * t));
    }
    g.add(new T.Line(new T.BufferGeometry().setFromPoints(pts), m));
  }
  function label(html, cls, x, y, z, parent) {
    var T = T_(), wrap = document.createElement('div'), el = document.createElement('div');
    el.className = 'tag3d ' + (cls || 'tag3d-gt'); el.innerHTML = html;
    wrap.appendChild(el);
    var o = new T.CSS2DObject(wrap); o.position.set(x, y, z); (parent || root).add(o);
    labelPairs.push({ obj: o, el: el });
    return el;
  }
  /* 浮标按相机距离缩放：HTML 浮标是固定像素大小，拉远后模型缩成一点、浮标还是原尺寸，
     就会糊成一片把设备全盖住。基准取"默认机位距离 = 100%"，随画幅自动跟着变 */
  var lblRef = 95, _lv = null;
  function scaleLabels() {
    if (!labelPairs.length || !camera) return;
    var T = T_();
    if (!_lv) _lv = new T.Vector3();
    for (var i = 0; i < labelPairs.length; i++) {
      var it = labelPairs[i];
      it.obj.getWorldPosition(_lv);
      /* 缩放规则三站共用（ScenePreset.scaleLabelTo） */
      SP.scaleLabelTo(it, camera.position.distanceTo(_lv), lblRef);
    }
  }
  function addCard(key, x, y, z) {
    var T = T_(), wrap = document.createElement('div'), el = document.createElement('div');
    el.className = 'card3d'; el.style.display = 'none';
    el.innerHTML = '<div class="c-head"><span></span><i class="c-x">✕</i></div><div class="c-rows"></div><div class="c-status" style="display:none"></div>';
    el.querySelector('.c-x').addEventListener('click', function (e) { e.stopPropagation(); showCard(null); });
    wrap.appendChild(el);
    var o = new T.CSS2DObject(wrap); o.position.set(x, y, z); root.add(o);
    cards[key] = el;
  }
  function setCard(k, title, rows, status) {
    var el = cards[k]; if (!el) return;
    el.querySelector('.c-head span').textContent = title;
    el.querySelector('.c-rows').innerHTML = rows.map(function (r) {
      return '<div class="c-row"><span>' + r[0] + '</span><i>' + r[1] + '</i></div>';
    }).join('');
    var st = el.querySelector('.c-status');
    if (status) { st.style.display = ''; st.textContent = status; } else st.style.display = 'none';
  }
  function showCard(k) {
    activeCard = (k && cards[k]) ? k : null;
    applyLabelVisibility();
    refreshCards();
  }
  function applyLabelVisibility() {
    var hide = !labelsOn || !!activeCard;
    labelPairs.forEach(function (it) {
      var vis = !hide && !it.blocked;
      if (it.obj.visible !== vis) it.obj.visible = vis;
    });
    for (var k in cards) cards[k].style.display = (k === activeCard) ? '' : 'none';
  }
  var _ray = null, _v = null, _d = null, _n = 0;
  function updateOcclusion() {
    if (!labelPairs.length || !camera || !occluders.length) return;
    if (++_n % 6) return;
    var T = T_();
    if (!_ray) { _ray = new T.Raycaster(); _v = new T.Vector3(); _d = new T.Vector3(); }
    var dirty = false;
    labelPairs.forEach(function (it) {
      it.obj.getWorldPosition(_v);
      var dist = _v.distanceTo(camera.position);
      _d.copy(_v).sub(camera.position).normalize();
      _ray.set(camera.position, _d); _ray.near = 0; _ray.far = Math.max(.5, dist - .6);
      var blocked = _ray.intersectObjects(occluders, true).length > 0;
      if (blocked !== !!it.blocked) { it.blocked = blocked; dirty = true; }
    });
    if (dirty) applyLabelVisibility();
  }

  /* ---------------- 贴图（逐条同洙边） ---------------- */
  function wallTex() {
    return tex(function (g, w, h) {
      g.fillStyle = '#dfe3e3'; g.fillRect(0, 0, w, h);
      g.fillStyle = 'rgba(120,138,140,.10)'; g.fillRect(0, 0, w, 10);
    }, 512, 256);
  }
  /* 地面 / 场坪：三站同一份生成器。一块贴图 = 12m（3 块 4m 板 + 板缝），
     场坪再叠 3m 一格的数字孪生格网；固定种子，切主题不会重排 */
  var TILE_M = 12;
  var GROUND_REPEAT = 700 / TILE_M;
  var SLAB_REPEAT = [460 / TILE_M, 240 / TILE_M];
  function paveTex(t, grid) {
    var T = T_();
    var x = SP.paveTexture(T, t, { grid: !!grid, cells: 3, gridCells: 4 });
    if (grid) x.repeat.set(SLAB_REPEAT[0], SLAB_REPEAT[1]);
    else x.repeat.set(GROUND_REPEAT, GROUND_REPEAT);
    if (renderer && renderer.capabilities) x.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return x;
  }
  /* 接触阴影：方向光夜里很弱，只靠它大件一定飘 */
  var contacts = [];
  function groundContact(parent, x, z, w, d) {
    contacts.push(SP.contact(T_(), parent, x, z, w, d, .186, SP.env(theme).contact));
  }
  function panelTex() {
    return tex(function (g, w, h) {
      g.fillStyle = '#07182c'; g.fillRect(0, 0, w, h);
      var bx = 8, by = 8, bw = w - 16, bh = h - 16, cw = bw / 10, ch = bh / 6, r, c, x, y;
      for (r = 0; r < 6; r++) for (c = 0; c < 10; c++) {
        x = bx + c * cw; y = by + r * ch;
        g.fillStyle = (r + c) % 2 ? '#0a2240' : '#0c2947';
        g.fillRect(x + 1.2, y + 1.2, cw - 2.4, ch - 2.4);
        g.strokeStyle = 'rgba(170,205,235,.20)'; g.lineWidth = .8;
        g.beginPath(); g.moveTo(x + cw / 3, y + 2); g.lineTo(x + cw / 3, y + ch - 2); g.stroke();
        g.beginPath(); g.moveTo(x + cw * 2 / 3, y + 2); g.lineTo(x + cw * 2 / 3, y + ch - 2); g.stroke();
      }
      var lg = g.createLinearGradient(0, 0, w, h);
      lg.addColorStop(0, 'rgba(190,225,255,.10)'); lg.addColorStop(.42, 'rgba(190,225,255,.03)');
      lg.addColorStop(.58, 'rgba(255,255,255,0)'); lg.addColorStop(1, 'rgba(255,255,255,.03)');
      g.fillStyle = lg; g.fillRect(0, 0, w, h);
      g.strokeStyle = '#c3ced4'; g.lineWidth = 9; g.strokeRect(4.5, 4.5, w - 9, h - 9);
      g.strokeStyle = 'rgba(20,40,60,.5)'; g.lineWidth = 2; g.strokeRect(11, 11, w - 22, h - 22);
    }, 320, 160, 2);
  }
  function winPaneTex() {
    return tex(function (g, w, h) {
      g.fillStyle = '#3a2f22'; g.fillRect(0, 0, w, h);
      var m = 4, cw = (w - m * 2) / 2, ch = (h - m * 2) / 3, r, c, x, y;
      for (r = 0; r < 3; r++) for (c = 0; c < 2; c++) {
        x = m + c * cw; y = m + r * ch;
        var grd = g.createLinearGradient(0, y, 0, y + ch);
        grd.addColorStop(0, '#fff2d8'); grd.addColorStop(.55, '#f6d9a4'); grd.addColorStop(1, '#c9a271');
        g.fillStyle = grd; g.fillRect(x + 1.5, y + 1.5, cw - 3, ch - 3);
      }
      g.fillStyle = 'rgba(30,24,18,.55)'; g.fillRect(w / 2 - 2, 0, 4, h);
      for (r = 1; r < 3; r++) g.fillRect(0, m + r * ch - 2, w, 4);
    }, 64, 96, 2);
  }
  function cabFrontTex(t) {
    var night = t === 'night', th = THEMES[t];
    return tex(function (g, w, h) {
      g.fillStyle = th.cabBase; g.fillRect(0, 0, w, h);
      g.strokeStyle = night ? 'rgba(46,230,200,.34)' : 'rgba(96,116,120,.45)'; g.lineWidth = 3; g.strokeRect(8, 8, w - 16, h - 16);
      g.fillStyle = night ? 'rgba(198,208,210,.95)' : 'rgba(206,216,218,.95)'; g.fillRect(16, 16, w - 32, 54);
      g.strokeStyle = night ? 'rgba(46,230,200,.24)' : 'rgba(96,116,120,.35)'; g.strokeRect(16, 16, w - 32, 54);
      for (var i = 0; i < 5; i++) { g.fillStyle = night ? 'rgba(46,230,200,.13)' : 'rgba(96,116,120,.25)'; g.fillRect(26, 25 + i * 9, w - 52, 3); }
      g.strokeStyle = night ? 'rgba(46,230,200,.45)' : 'rgba(70,96,100,.5)'; g.lineWidth = 4;
      g.beginPath(); g.moveTo(w / 2, 84); g.lineTo(w / 2, h - 20); g.stroke();
      g.lineWidth = 2; g.strokeStyle = night ? 'rgba(46,230,200,.2)' : 'rgba(96,116,120,.3)';
      g.strokeRect(20, 90, w / 2 - 30, h - 122); g.strokeRect(w / 2 + 10, 90, w / 2 - 30, h - 122);
      g.fillStyle = night ? 'rgba(46,230,200,.5)' : 'rgba(52,86,88,.55)';
      g.fillRect(w / 2 - 20, h / 2 - 12, 6, 36); g.fillRect(w / 2 + 14, h / 2 - 12, 6, 36);
      g.fillStyle = night ? 'rgba(46,230,200,.42)' : 'rgba(16,160,138,.5)'; g.fillRect(24, h - 36, 74, 11);
      g.fillStyle = night ? 'rgba(255,176,32,.6)' : 'rgba(224,148,16,.6)'; g.fillRect(w - 98, h - 36, 74, 11);
    }, 256, 320, 2);
  }
  function cabSideTex(t) {
    var night = t === 'night', th = THEMES[t];
    return tex(function (g, w, h) {
      g.fillStyle = th.cabBase2; g.fillRect(0, 0, w, h);
      g.strokeStyle = night ? 'rgba(46,230,200,.18)' : 'rgba(96,116,120,.22)'; g.lineWidth = 2;
      for (var i = 1; i < 4; i++) { var x = i * w / 4; g.beginPath(); g.moveTo(x, 6); g.lineTo(x, h - 6); g.stroke(); }
      g.strokeStyle = night ? 'rgba(46,230,200,.26)' : 'rgba(96,116,120,.3)'; g.strokeRect(6, 6, w - 12, h - 12);
      for (var j = 0; j < 9; j++) { g.fillStyle = night ? 'rgba(46,230,200,.14)' : 'rgba(96,116,120,.28)'; g.fillRect(18, h - 72 + j * 7, w - 36, 3); }
    }, 256, 320, 2);
  }
  function glowTex() {
    return tex(function (g, w, h) {
      var grd = g.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, w / 2);
      grd.addColorStop(0, 'rgba(255,255,255,.9)'); grd.addColorStop(.35, 'rgba(255,255,255,.32)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd; g.fillRect(0, 0, w, h);
    }, 128, 128);
  }
  /* 日月光晕（暖色径向，同洙边） */
  function sunGlowTex() {
    return tex(function (g, w, h) {
      var grd = g.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, w / 2);
      grd.addColorStop(0, 'rgba(255,246,214,.95)'); grd.addColorStop(.32, 'rgba(255,228,150,.42)');
      grd.addColorStop(1, 'rgba(255,224,140,0)');
      g.fillStyle = grd; g.fillRect(0, 0, w, h);
    }, 128, 128);
  }
  /* 扫光带：横向一条柔和亮带（加色混合，淡到只当呼吸用） */
  function sweepTex() {
    return tex(function (g, w, h) {
      var grd = g.createLinearGradient(0, 0, w, 0);
      grd.addColorStop(0, 'rgba(255,255,255,0)'); grd.addColorStop(.42, 'rgba(255,255,255,.05)');
      grd.addColorStop(.5, 'rgba(255,255,255,.5)'); grd.addColorStop(.58, 'rgba(255,255,255,.05)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd; g.fillRect(0, 0, w, h);
    }, 128, 8);
  }
  function skyTex(stops) {
    return tex(function (g, w, h) {
      var grd = g.createLinearGradient(0, 0, 0, h);
      stops.forEach(function (s) { grd.addColorStop(s[0], s[1]); });
      g.fillStyle = grd; g.fillRect(0, 0, w, h);
    }, 16, 256);
  }
  function tagTex(txt) {
    return tex(function (g, w, h) {
      g.fillStyle = '#1d2a2e'; g.fillRect(0, 0, w, h);
      g.strokeStyle = 'rgba(232,255,250,.85)'; g.lineWidth = 2; g.strokeRect(3, 3, w - 6, h - 6);
      g.fillStyle = '#eafffa'; g.font = 'bold 15px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(txt, w / 2, h / 2 + 1);
    }, 44, 24);
  }
  var flowProto = null;
  function flowTex(len) {
    var T = T_();
    if (!flowProto) {
      flowProto = tex(function (g, w, h) {
        g.clearRect(0, 0, w, h);
        for (var k = 0; k < 2; k++) {
          var x = k * (w / 2), lg = g.createLinearGradient(x, 0, x + w / 2, 0);
          lg.addColorStop(0, 'rgba(255,255,255,0)'); lg.addColorStop(.34, 'rgba(255,255,255,.30)');
          lg.addColorStop(.5, 'rgba(255,255,255,1)'); lg.addColorStop(.62, 'rgba(255,255,255,1)');
          lg.addColorStop(.74, 'rgba(255,255,255,.26)'); lg.addColorStop(1, 'rgba(255,255,255,0)');
          g.fillStyle = lg; g.fillRect(x, 0, w / 2, h);
        }
      }, 128, 8);
      flowProto.wrapS = flowProto.wrapT = T.RepeatWrapping;
    }
    var t = flowProto.clone(); t.needsUpdate = true;
    t.wrapS = t.wrapT = T.RepeatWrapping;
    t.repeat.set(Math.max(2, Math.round(len / 4.2)), 1);
    return t;
  }

  /* ---------------- 材质表（按主题） ---------------- */
  function mats(t) {
    var T = T_(), th = THEMES[t], night = t === 'night';
    var wp = winPaneTex();
    return {
      t: th, night: night, F: FLOWC[t],
      ground: new T.MeshStandardMaterial({ map: paveTex(t, false), roughness: .78, metalness: .05, envMapIntensity: SP.env(t).envInt }),
      slab: (function () {
        var m = new T.MeshStandardMaterial({ map: paveTex(t, true), roughness: .76, metalness: .05, envMapIntensity: SP.env(t).envInt });
        m.polygonOffset = true; m.polygonOffsetFactor = 1; m.polygonOffsetUnits = 1; return m;
      })(),
      edge: new T.LineBasicMaterial({ color: th.edge, transparent: true, opacity: SP.env(t).edge, depthWrite: false, toneMapped: false }),
      steel: std(th.steel, { rough: .45, metal: .55, env: .8 }),
      dark: std(th.dark, { rough: .5, metal: .5, env: .5 }),
      top: std(th.top, { rough: .6, metal: .3 }),
      pad: std(th.pad, { rough: .92, metal: .05 }),
      box: std(0x232d33, { rough: .7, metal: .3 }),
      wall: new T.MeshStandardMaterial({ map: wallTex(), roughness: .78, metalness: .1, envMapIntensity: night ? .3 : .16 }),
      wallTop: std(th.wallTop, { rough: .92, env: night ? .26 : .14 }),
      wallBot: std(th.wallBot, { rough: .95, env: .12 }),
      trim: std(th.trim, { rough: .62, metal: .3 }),
      band: std(0x232a2d, { rough: .5, metal: .35 }),
      base: std(th.base, { rough: .9, env: .26 }),
      par: std(th.par, { rough: .85, env: .26 }),
      roofLine: new T.MeshBasicMaterial({ color: th.roofLine, transparent: true, opacity: th.roofLineO, toneMapped: false }),
      win: new T.MeshStandardMaterial({ map: wp, emissiveMap: wp, color: th.winC, roughness: .35, metalness: .2,
        emissive: new T.Color(th.winE), emissiveIntensity: th.winI }),
      doorFrame: std(th.doorFrame, { rough: .7, env: .3 }),
      door: std(th.door, { rough: .45, metal: .35, env: .7 }),
      doorHole: std(0x060d11, { rough: 1 }),
      doorLight: new T.MeshBasicMaterial({ color: th.doorLight }),
      headGlass: std(th.headGlass, { rough: .3, metal: .3, env: .8 }),
      aw: std(th.aw, { rough: .8, env: .26 }),
      awPost: std(th.awPost, { rough: .8 }),
      step: std(th.step, { rough: .9 }),
      ac: std(th.ac, { rough: .6 }),
      panel: new T.MeshStandardMaterial({ map: panelTex(), color: 0x33383c, roughness: .32, metalness: .5,
        emissive: new T.Color(0x0a0d10), emissiveIntensity: .1, envMapIntensity: .38 }),
      rail: std(th.rail, { rough: .42, metal: .72, env: .8 }),
      legP: std(th.legP, { rough: .5, metal: .6, env: .7 }),
      tray: std(th.tray, { rough: .45, metal: .6, env: .7 }),
      walk: std(th.walk, { rough: .9, env: .3 }),
      cable2: std(0x22343c, { rough: .6, metal: .3 }),
      frame: std(th.frame, { rough: .4, metal: .6 }),
      leg: std(th.leg, { rough: .55, metal: .6 }),
      brace: std(th.brace, { rough: .62, metal: .55 }),
      arm: std(th.arm, { rough: .5, metal: .3, em: night ? 0x0a5a4a : 0x000000, ei: .35 }),
      ins: std(th.ins, { rough: .35, metal: .1 }),
      cond: new T.LineBasicMaterial({ color: night ? 0x2ee6c8 : 0x0d8f7a, transparent: true, opacity: .22, toneMapped: false }),
      cabF: new T.MeshStandardMaterial({ map: cabFrontTex(t), roughness: .5, metalness: .35, envMapIntensity: .6 }),
      cabS: new T.MeshStandardMaterial({ map: cabSideTex(t), roughness: .55, metalness: .35, envMapIntensity: .6 }),
      cabTop: std(night ? 0x2b3a42 : 0xd6dbdc, { rough: .6, metal: .3 }),
      cable: std(0x2a3b42, { rough: .48, metal: .45 }),
      saddle: std(0x5a6a70, { rough: .85 }),
      glow: new T.MeshBasicMaterial({ color: th.glow, transparent: true, opacity: th.glowO,
        blending: T.AdditiveBlending, depthWrite: false, toneMapped: false })
    };
  }

  /* ---------------- 厂房（逐条照洙边 buildBuilding + buildArray） ---------------- */
  function makeBuilding(M) {
    var T = T_(), g = new T.Group();
    g.add(rbox(W2 + .9, .3, D2 + .9, M.base, 0, .15, 0, .06));
    var bld = new T.Mesh(new T.BoxGeometry(W2, H2, D2), [M.wall, M.wall, M.wallTop, M.wallBot, M.wall, M.wall]);
    bld.position.set(0, H2 / 2 + .3, 0); bld.castShadow = bld.receiveShadow = true; g.add(bld);
    occluders.push(bld);
    g.add(rbox(W2 + .2, .55, D2 + .2, M.band, 0, .58, 0, .07));                 /* 深色基座带（倒角） */
    [-1, 1].forEach(function (sz) { g.add(rbox(W2 + .24, .16, .18, M.trim, 0, FLOOR_Y + .3, sz * (D2 / 2 + .05), .045)); });
    [-1, 1].forEach(function (sx) { g.add(rbox(.18, .16, D2 + .24, M.trim, sx * (W2 / 2 + .05), FLOOR_Y + .3, 0, .045)); });
    /* 女儿墙（倒角：硬边墙压着屋顶，远看像贴了一张纸） */
    g.add(rbox(W2 + .6, .5, .3, M.par, 0, roofY + .25, -D2 / 2, .05));
    g.add(rbox(W2 + .6, .5, .3, M.par, 0, roofY + .25, D2 / 2, .05));
    g.add(rbox(.3, .5, D2, M.par, -W2 / 2, roofY + .25, 0, .05));
    g.add(rbox(.3, .5, D2, M.par, W2 / 2, roofY + .25, 0, .05));
    g.add(box(W2 + .66, .05, .05, M.roofLine, 0, roofY + .535, D2 / 2));
    g.add(box(W2 + .66, .05, .05, M.roofLine, 0, roofY + .535, -D2 / 2));
    g.add(box(.05, .05, D2 + .06, M.roofLine, W2 / 2, roofY + .555, 0));
    g.add(box(.05, .05, D2 + .06, M.roofLine, -W2 / 2, roofY + .555, 0));
    var bandH = 1.75, bandD = .24, winY = FLOOR_Y + .3 + 1.7;
    function winBand(alongX, len, n, cx, cz, ww) {
      var inner = len - .7, wwv = ww || 1.6;
      g.add(alongX ? box(len, bandH, bandD, M.band, cx, winY, cz) : box(bandD, bandH, len, M.band, cx, winY, cz));
      for (var i = 0; i < n; i++) {
        var off = -inner / 2 + (i + .5) * (inner / n);
        var px = alongX ? cx + off : cx, pz = alongX ? cz : cz + off;
        g.add(box(alongX ? wwv : bandD + .08, bandH - .46, alongX ? bandD + .08 : wwv, M.win, px, winY, pz));
        if (i < n - 1) {
          var mx = alongX ? cx + off + inner / (n * 2) : cx, mz = alongX ? cz : cz + off + inner / (n * 2);
          g.add(box(alongX ? .1 : bandD + .12, bandH, alongX ? bandD + .12 : .1, M.trim, mx, winY, mz));
        }
      }
    }
    [-1, 1].forEach(function (sz) { winBand(true, W2 - .4, 4, 0, sz * (D2 / 2 + .04), 2.0); });
    [-1, 1].forEach(function (sx) { winBand(false, D2 - .4, 2, sx * (W2 / 2 + .04), 0, 2.0); });
    [-1, 1].forEach(function (sx) {
      [-2.0, 2.0].forEach(function (oz) {
        g.add(box(.24, 1.5, 2.0, M.band, sx * (W2 / 2 + .04), 1.85, oz));
        g.add(box(.2, 1.1, 1.7, M.win, sx * (W2 / 2 + .07), 1.85, oz));
      });
    });
    var dz = D2 / 2;
    g.add(box(3.4, 2.9, .24, M.doorFrame, 0, 1.75, dz + .04));
    [1, -1].forEach(function (s) {
      var pv = new T.Group();
      pv.position.set(s * 1.45, 1.55, dz + .14);
      pv.add(box(1.42, 2.5, .1, M.door, -s * .71, 0, 0));
      pv.rotation.y = s * 1.38;
      g.add(pv);
    });
    g.add(box(2.92, 2.56, .04, M.doorHole, 0, 1.55, dz + .175));
    g.add(box(2.6, 2.28, .03, M.doorLight, 0, 1.5, dz + .2));
    g.add(box(2.2, .22, .1, M.headGlass, 0, 2.62, dz + .16));
    g.add(box(5.4, .16, 2.0, M.aw, 0, H2 - .35, dz + 1.0));
    g.add(box(.18, H2 - .5, .18, M.awPost, -2.5, (H2 - .5) / 2, dz + 1.85));
    g.add(box(.18, H2 - .5, .18, M.awPost, 2.5, (H2 - .5) / 2, dz + 1.85));
    g.add(box(5.0, .12, .5, M.step, 0, .24, dz + .75));
    [[-4.2, 2.35], [4.2, 2.35]].forEach(function (p) {
      g.add(box(1.05, .78, .42, M.ac, p[0], p[1], -D2 / 2 - .24));
      g.add(box(.62, .05, .3, M.trim, p[0], p[1] - .42, -D2 / 2 - .24));
    });
    /* 逆变器（北墙）+ 通信模块立杆：同洙边，不接线、不挂浮标 */
    var inv = new T.Group(); inv.position.set(-5.7, 0, -D2 / 2); inv.rotation.y = Math.PI / 2;
    inv.add(box(.07, 1.66, 1.28, M.steel, .035, 2.18, 0));
    inv.add(box(.36, 1.5, 1.1, M.dark, .26, 2.18, 0));
    inv.add(box(.04, 1.56, 1.16, M.top, .44, 2.18, 0));
    for (var k = 0; k < 5; k++) inv.add(box(.03, 1.24, .1, M.frame, .12 + k * .09, 2.18, -.575));
    inv.add(box(.03, .52, .62, M.box, .465, 2.46, 0));
    inv.add(box(.03, .16, .22, std(0xd9b23a, { rough: .5 }), .465, 1.95, -.34));
    g.add(inv);
    g.add(cyl(.07, .09, 3.4, M.steel, -W2 / 2 - 2.2, 1.7, -2.6, 10));
    g.add(box(.5, .56, .36, M.top, -W2 / 2 - 2.2, 3.05, -2.6));
    g.add(box(.52, .05, .38, M.frame, -W2 / 2 - 2.2, 3.34, -2.6));
    g.add(cyl(.022, .022, .8, M.steel, -W2 / 2 - 2.2, 3.76, -2.6, 6));
    /* 南墙三个进线黑盒 + 分岔端子 + 过墙套管 */
    g.add(box(.34, .44, .10, M.box, -5.75, 3.9, D2 / 2 + .03));
    g.add(box(.34, .44, .10, M.box, -6.35, .86, D2 / 2 + .03));
    g.add(box(.30, .40, .10, M.box, -5.12, 1.02, D2 / 2 + .05));
    [[NLO[0], NLO[1], NLO[2], .10], [NHI[0], NHI[1], NHI[2], .075]].forEach(function (p) {
      var j = new T.Mesh(new T.SphereGeometry(p[3], 10, 10), M.cable);
      j.position.set(p[0], p[1], p[2]); g.add(j);
    });
    g.add(box(.7, .2, .2, M.steel, -W2 / 2 - .06, roofY + .42, .55));
    /* 屋面光伏：组件 / 导轨 / 竖撑合批 + 走道 + 线槽 + 组串电缆 */
    function planeY(zl) { return roofY + ROW_Y - Math.tan(TILT) * zl; }
    var yMod = planeY(0), yRailF = planeY(RAIL_Z) - RAIL_DROP, yRailR = planeY(-RAIL_Z) - RAIL_DROP;
    var hLegF = yRailF - .03 - roofY, hLegR = yRailR - .03 - roofY;
    var legXs = [-(rowW / 2 - .5), -rowW / 6, rowW / 6, rowW / 2 - .5];
    var modI = new T.InstancedMesh(new T.BoxGeometry(MW, MT, MD), M.panel, ROWZ.length * COLS);
    var railI = new T.InstancedMesh(new T.BoxGeometry(rowW + .5, .06, .12), M.rail, ROWZ.length * 2);
    var legFI = new T.InstancedMesh(new T.BoxGeometry(.09, hLegF, .09), M.legP, ROWZ.length * legXs.length);
    var legRI = new T.InstancedMesh(new T.BoxGeometry(.09, hLegR, .09), M.legP, ROWZ.length * legXs.length);
    var mtx = new T.Matrix4(), mi = 0, ri = 0, li = 0;
    ROWZ.forEach(function (rz) {
      for (var c = 0; c < COLS; c++) {
        mtx.makeRotationX(TILT);
        mtx.setPosition(-rowW / 2 + MW / 2 + c * (MW + .06), yMod, rz);
        modI.setMatrixAt(mi++, mtx);
      }
      [[RAIL_Z, yRailF], [-RAIL_Z, yRailR]].forEach(function (r) {
        mtx.makeRotationX(TILT); mtx.setPosition(0, r[1], rz + r[0]); railI.setMatrixAt(ri++, mtx);
      });
      legXs.forEach(function (x) {
        mtx.makeTranslation(x, roofY + hLegF / 2, rz + RAIL_Z); legFI.setMatrixAt(li, mtx);
        mtx.makeTranslation(x, roofY + hLegR / 2, rz - RAIL_Z); legRI.setMatrixAt(li, mtx);
        li++;
      });
    });
    [modI, railI, legFI, legRI].forEach(function (o) {
      o.instanceMatrix.needsUpdate = true; o.castShadow = true; o.receiveShadow = true; g.add(o);
    });
    g.add(box(rowW + .8, .04, 1.5, M.walk, 0, roofY + .02, 0));
    g.add(box(rowW + .6, .05, .34, M.tray, 0, roofY + .30, 0));
    g.add(box(rowW + .6, .09, .05, M.tray, 0, roofY + .345, -.17));
    g.add(box(rowW + .6, .09, .05, M.tray, 0, roofY + .345, .17));
    [[-4.2, -2.55], [-1.4, -1.05], [1.4, 1.05], [4.2, 2.55]].forEach(function (d) {
      var zEnd = d[1] + RAIL_Z;
      var a = new T.Vector3(d[0], roofY + .16, 0), b = new T.Vector3(d[0], planeY(RAIL_Z) - .085, zEnd);
      var mid = new T.Vector3(d[0], (a.y + b.y) / 2 + .04, zEnd / 2);
      var cm = new T.Mesh(new T.TubeGeometry(new T.CatmullRomCurve3([a, mid, b]), 12, .022, 5, false), M.cable2);
      cm.castShadow = true; g.add(cm);
    });
    g.userData.roofY = roofY;
    return g;
  }

  /* ---------------- 储能柜 ---------------- */
  function makeCabinet(M) {
    var T = T_(), g = new T.Group(), w = CAB.w, h = CAB.h, d = CAB.d;
    g.add(rbox(w + .42, .16, d + .42, M.pad, 0, .08, 0, .06));
    g.add(rbox(w + .24, .18, d + .24, M.dark, 0, .09, 0, .05));
    var body = new T.Mesh(new T.BoxGeometry(w, h, d), [M.cabS, M.cabS, M.cabTop, M.cabS, M.cabF, M.cabS]);
    body.position.y = h / 2 + .18; body.castShadow = body.receiveShadow = true; g.add(body);
    occluders.push(body);
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (c) {
      g.add(rbox(.1, h + .04, .1, M.steel, c[0] * (w / 2 - .02), h / 2 + .18, c[1] * (d / 2 - .02), .028));
    });
    g.add(rbox(w * .74, .32, d * .78, M.ac, 0, h + .36, 0, .06));
    for (var k = 0; k < 4; k++) g.add(rbox(w * .6, .04, .07, M.steel, 0, h + .52, -.22 + k * .15, .014));
    var colH = h * .62, base = .18 + h * .5 - colH / 2, bars = [];
    [-1, 1].forEach(function (s) {
      g.add(rbox(.06, colH + .1, .32, M.dark, s * (w / 2 + .04), .18 + h * .5, d * .2, .02));
      var geo = new T.BoxGeometry(.05, colH, .26); geo.translate(0, colH / 2, 0);
      var bar = new T.Mesh(geo, new T.MeshBasicMaterial({ color: FLOWC[theme].bar, transparent: true, opacity: .85, toneMapped: false }));
      bar.position.set(s * (w / 2 + .07), base, d * .2);
      g.add(bar);
      /* 外层光晕：柱体只是涂色，色一暗就看着"没亮"。做成子物体，
         按 SOC 设 scale.y 时光晕自动跟着长 */
      bar.userData.sleeve = SP.glowSleeve(T, bar, .11, colH, .44, .3);
      bars.push(bar);
    });
    g.add(box(.22, .13, .04, M.dark, w / 2 - .5, .18 + h * .86, d / 2 + .03));
    var led = new T.Mesh(new T.BoxGeometry(.16, .09, .05), new T.MeshBasicMaterial({ color: FLOWC[theme].idle, toneMapped: false }));
    led.position.set(w / 2 - .5, .18 + h * .86, d / 2 + .055); g.add(led);
    var glow = new T.Mesh(new T.PlaneGeometry(w * 1.7, d * 1.9), M.glow);
    glow.rotation.x = -Math.PI / 2; glow.position.y = .22; g.add(glow);
    g.userData.bars = bars; g.userData.led = led; g.userData.glow = glow;
    return g;
  }
  function makeTermBox(M) {
    var T = T_(), g = new T.Group();
    g.add(box(.72, .1, .62, M.dark, 0, .23, 0));
    g.add(box(.6, .72, .5, M.top, 0, .64, 0));
    g.add(box(.66, .06, .56, M.dark, 0, 1.03, 0));
    return g;
  }

  /* ---------------- 铁塔（格构塔，同洙边） ---------------- */
  function makeTower(M, tag) {
    var T = T_(), g = new T.Group(), hgt = TWRH;
    var halfAt = function (y) {
      var t = Math.max(0, Math.min(1, y / hgt)), b = 1.5, wa = .62, tp = .84;
      return t < .6 ? b + (wa - b) * (t / .6) : wa + (tp - wa) * ((t - .6) / .4);
    };
    var P = function (sx, y, sz) { return new T.Vector3(sx * halfAt(y), y, sz * halfAt(y)); };
    var legs = [], braces = [], arms = [], ins = [], lv = 9;
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (c) {
      for (var k = 0; k < lv; k++) legs.push([P(c[0], hgt * k / lv, c[1]), P(c[0], hgt * (k + 1) / lv, c[1]), .05]);
    });
    for (var k = 1; k <= lv; k++) {
      var y = hgt * k / lv, w = halfAt(y);
      braces.push([new T.Vector3(-w, y, -w), new T.Vector3(w, y, -w), .022]);
      braces.push([new T.Vector3(-w, y, w), new T.Vector3(w, y, w), .022]);
      braces.push([new T.Vector3(-w, y, -w), new T.Vector3(-w, y, w), .022]);
      braces.push([new T.Vector3(w, y, -w), new T.Vector3(w, y, w), .022]);
      if (k < lv) {
        var yn = hgt * (k + 1) / lv, wn = halfAt(yn);
        [[-1, 0], [1, 0], [0, -1], [0, 1]].forEach(function (f) {
          var a = new T.Vector3(f[0] * w, y, f[1] * w), b = new T.Vector3(f[0] * wn, yn, f[1] * wn);
          braces.push([a, b, .02]);
          braces.push([a, new T.Vector3(f[0] ? a.x : b.x, yn, f[1] ? a.z : b.z), .02]);
        });
      }
    }
    /* 半跨收到 10m（原来 18m）：画面里只建了这一座塔，线伸太远就是"断在半空"，
       看着像画面上划了几道痕；导线透明度同步调淡一档，退成背景不抢视线 */
    var SPAN = 10, SAG = .9;
    [[6.6, 3.0], [7.8, 2.7], [9.0, 2.4]].forEach(function (a) {
      var ay = a[0], len = a[1], w = halfAt(ay);
      [-1, 1].forEach(function (s) {
        var inn = new T.Vector3(s * w, ay, 0), tip = new T.Vector3(s * (w + len), ay, 0);
        arms.push([inn, tip, .06]);
        braces.push([inn.clone().setY(ay - .22), tip.clone().setY(ay - .3), .024]);
        for (var j = 0; j < 4; j++) ins.push([tip.clone().setY(ay - .12 - j * .09), 0]);
        spanLine(g, M.cond, tip.x, tip.y - .5, -SPAN, tip.x, tip.y - .5, SPAN, SAG, 22);
      });
    });
    var tw = halfAt(hgt);
    arms.push([new T.Vector3(-tw, hgt, 0), new T.Vector3(0, hgt + .9, 0), .045]);
    arms.push([new T.Vector3(tw, hgt, 0), new T.Vector3(0, hgt + .9, 0), .045]);
    spanLine(g, M.cond, 0, hgt + .9, -SPAN, 0, hgt + .9, SPAN, .6, 22);
    [[1.5, 1.5], [1.5, -1.5], [-1.5, 1.5], [-1.5, -1.5]].forEach(function (p) {
      g.add(box(.74, .5, .74, M.pad, p[0], .25, p[1]));
    });
    for (var l = 0; l < 18; l++) {
      var wy = .75 + l * .5, ww = halfAt(wy);
      g.add(box(.26, .03, .03, M.brace, -ww + .12, wy, -ww - .07));
    }
    [instanced(legs, M.leg), instanced(braces, M.brace), instanced(arms, M.arm)].forEach(function (o) { if (o) g.add(o); });
    if (ins.length) {
      var im = new T.InstancedMesh(new T.CylinderGeometry(.11, .11, .045, 8), M.ins, ins.length), m4 = new T.Matrix4();
      ins.forEach(function (it, i) { m4.makeTranslation(it[0].x, it[0].y, it[0].z); im.setMatrixAt(i, m4); });
      im.instanceMatrix.needsUpdate = true; im.castShadow = true; g.add(im);
    }
    var pt = new T.Mesh(new T.PlaneGeometry(.44, .28), new T.MeshBasicMaterial({ map: tagTex(tag), side: T.DoubleSide }));
    pt.position.set(halfAt(2.6) + .17, 2.6, 0); pt.rotation.y = Math.PI / 2; g.add(pt);
    var bc = new T.Mesh(new T.SphereGeometry(.13, 10, 10),
      new T.MeshBasicMaterial({ color: 0xff5a3c, transparent: true, opacity: .9, fog: false, toneMapped: false }));
    bc.position.set(0, hgt + 1.06, 0); g.add(bc);
    var bg = new T.Sprite(new T.SpriteMaterial({ map: glowTex(), color: 0xff5a3c, transparent: true,
      opacity: .5, blending: T.AdditiveBlending, depthWrite: false, fog: false }));
    bg.position.copy(bc.position); bg.scale.set(2.6, 2.6, 1); g.add(bg);
    beacons.push([bc, bg]);
    return g;
  }

  /* ---------------- 一条线（芯管 + 加色光纹） ---------------- */
  function addFlow(parent, kind, gi, pts, r) {
    var T = T_(), M = parent.userData.M;
    var raw = pts.map(function (p) { return new T.Vector3(p[0], p[1], p[2]); });
    var vs = [];
    raw.forEach(function (v) { if (!vs.length || v.distanceTo(vs[vs.length - 1]) > .35) vs.push(v); });
    if (vs.length < 2) return null;
    var curve = new T.CatmullRomCurve3(vs, false, 'catmullrom', .1);
    var len = Math.max(1, curve.getLength()), seg = Math.max(14, Math.round(len * 2));
    r = r || .052;
    var core = new T.Mesh(new T.TubeGeometry(curve, seg, r, 6, false), M.cable);
    core.castShadow = true; parent.add(core);
    var map = flowTex(len);
    var tm = new T.MeshBasicMaterial({ map: map, color: FLOWC[theme].idle, transparent: true, opacity: .22,
      blending: T.AdditiveBlending, depthWrite: false, toneMapped: false });
    parent.add(new T.Mesh(new T.TubeGeometry(curve, seg, r * 2.1, 8, false), tm));
    var f = { kind: kind, gi: gi, map: map, tubeMat: tm, dir: 1, spd: .06, len: len };
    flows.push(f);
    return f;
  }

  /* ---------------- 一个机组（厂房 + 柜 + 九条线） ---------------- */
  function makeUnit(M, gi) {
    var T = T_(), n = GCAB[gi], span = (n - 1) * PITCH;
    var grp = new T.Group(); grp.userData.M = M;
    grp.add(makeBuilding(M));
    var cabs = [];
    for (var k = 0; k < n; k++) {
      var c = makeCabinet(M);
      c.position.set(CABX - span / 2 + k * PITCH, 0, CABZ);
      grp.add(c); cabs.push({ x: c.position.x, z: CABZ, ref: c });
    }
    var east = cabs[cabs.length - 1], west = cabs[0];
    var boxE = [east.x + CAB.w / 2 + .10, 1.0, east.z];
    var boxW = [west.x - CAB.w / 2 - .10, 1.0, west.z];
    cabs.forEach(function (c) {
      grp.add(box(.10, .40, .34, M.box, c.x + CAB.w / 2 + .10, 1.0, c.z));
      grp.add(box(.10, .40, .34, M.box, c.x - CAB.w / 2 - .10, 1.0, c.z));
      grp.add(box(.34, .40, .10, M.box, c.x + .2, .40, c.z + CAB.d / 2 + .05));
    });
    var TBX = n > 1 ? CABX - span / 2 - CAB.w / 2 - 1.0 : -15.5;
    var tb = makeTermBox(M); tb.position.set(TBX, 0, TWRZ); grp.add(tb);
    if (n > 1) grp.add(box(span + CAB.w + 1.2, .1, CAB.d + 1.4, M.pad, CABX, .045, CABZ));
    var F = FLOWC[theme];
    /* ① 光伏干线：屋面线槽 → 西墙直落 → 二楼分岔点 */
    addFlow(grp, 'pv', gi, [[rowW / 2 + .2, roofY + .40, 0], [3.2, roofY + .42, 0], [-3.2, roofY + .42, .1],
      [-W2 / 2 - .08, roofY + .42, .55], [-W2 / 2 - .36, 6.6, .55], [NHI[0], 3.9, .55]], .052);
    /* ② 光伏下段：二楼分岔点 → 低位节点 */
    addFlow(grp, 'pvlow', gi, [[NHI[0], 3.9, .55], [NLO[0], 1.2, .55]], .052);
    /* ③ 光伏→厂房：二楼改道 → 沿西墙往南 → 西南角转弯 → 南墙二楼黑盒 */
    addFlow(grp, 'pvh', gi, [[NHI[0], 3.9, .55], [NHI[0], 3.9, D2 / 2 + .36],
      [-5.75, 3.9, D2 / 2 + .36], [-5.75, 3.9, D2 / 2 + .02]], .052);
    /* ④ 光伏→储能：低位节点 → 柜东面接线盒 */
    addFlow(grp, 'sto', gi, [[NLO[0], NLO[1], NLO[2]], boxE], .052);
    /* ⑤ 国网→储能：关口箱 → 柜前北车道 z3.15 → 折北 → 柜西面 */
    addFlow(grp, 'gsto', gi, [[TBX - .4, .36, TWRZ - .15], [TBX - .4, .34, LN.gsto],
      [boxW[0] + .75, .34, LN.gsto], [boxW[0] + .25, .36, boxW[2] + 1.0], boxW], .052);
    /* ⑥ 并网段：低位节点 → 贴墙根向南 → 向西并入走廊 z3.60 → 关口箱 */
    var gpts = [[NLO[0], NLO[1], NLO[2]], [NLO[0], .34, .55], [NLO[0], .34, LN.grid]];
    for (var gx = NLO[0] - 2.5; gx > TBX + 1.2; gx -= 2.5) gpts.push([gx, .34, LN.grid]);
    gpts.push([TBX + .2, .38, TWRZ - .25], [TBX, .44, TWRZ - .08]);
    addFlow(grp, 'grid', gi, gpts, .052);
    /* ⑧ 储能→厂房：柜正面（南面）出线 → 楼前走廊 z2.95 → 南墙墙脚黑盒（多柜先并干线） */
    cabs.forEach(function (c, i) {
      var last = i === cabs.length - 1, laneZ = LN.stoh + (cabs.length > 1 ? i * .22 : 0);
      var pts = [[c.x + .2, .40, c.z + CAB.d / 2 + .08], [c.x + .2, .34, laneZ], [-6.48, .34, laneZ]];
      if (last) pts.push([-6.40, .36, 3.95], [-6.35, .72, 4.02]);
      else pts.push([-6.48, .34, LN.stoh]);
      addFlow(grp, 'stoh', gi, pts, .052);
    });
    /* ⑨ 电网直供：关口箱 → 前院南沿 z5.45 → 折北 → 南墙进线盒 */
    var lpts = [[TBX - .1, .36, TWRZ + .3]];
    for (var lx = TBX + 2.4; lx < -7.6; lx += 2.5) lpts.push([lx, .34, LN.gl]);
    lpts.push([-7.5, .36, LN.gl], [-5.95, .40, LN.gl - .9], [-5.35, .95, 4.30], [-5.14, 1.02, 4.04]);
    addFlow(grp, 'gl', gi, lpts, .052);
    /* 电缆墩：四条贴地车道按 x 每 2.5m 一格 */
    [[LN.grid, NLO[0], TBX], [LN.gsto, TBX, boxW[0]], [LN.gl, TBX, -7.5], [LN.stoh, cabs[0].x, -7.5]]
      .forEach(function (lane) {
        var a = Math.min(lane[1], lane[2]), b = Math.max(lane[1], lane[2]);
        for (var x = Math.ceil(a / 2.5) * 2.5; x <= b - .6; x += 2.5) {
          grp.add(box(.16, .16, .16, M.saddle, x, .26, lane[0]));
        }
      });
    return { grp: grp, cabs: cabs, tbLocal: new T.Vector3(TBX, .44, TWRZ), tbWorld: null, gi: gi };
  }

  /* ---------------- 六工况判据（洙边口径；缺数据的路不亮） ---------------- */
  function cond(d) {
    var hasGroupPv = !!(d.pvSeen && d.pv != null);
    var hasPv = hasGroupPv || stationPv.seen;
    var pv = hasGroupPv ? d.pv : (stationPv.seen ? stationPv.kw : 0);
    var hasSt = d.st != null, hasGrid = d.grid != null;
    var st = hasSt ? d.st : 0;
    var surplus = hasGrid ? -d.grid : null;              /* 正 = 送电（卖） */
    var loadEff = hasGrid ? Math.max(0, pv + st - surplus) : (d.load != null ? Math.max(0, pv + st) : 0);
    /* 储能数据未接入时的暂定显示：按「工况 1 · 光伏充储能」点亮，数字仍为 -- */
    var provChg = !hasSt && hasPv;
    var pvOn = hasPv && pv > .5, chg = hasSt ? (st < -.5) : provChg, dis = hasSt && st > .5;
    var sell = hasGrid && surplus > .3, buy = hasGrid && surplus < -.3;
    var its = [];
    if (pvOn && chg) its.push('1');
    if (pvOn && loadEff > .3) its.push('2');
    if (pvOn && sell) its.push('3');
    if (buy && loadEff > .3) its.push('4');
    if (chg && buy) its.push('5');
    if (dis) its.push('6');
    return { hasPv: hasPv, hasSt: hasSt, hasGrid: hasGrid, pv: pv, st: st, surplus: surplus,
      stationPv: !hasGroupPv && stationPv.seen, provChg: provChg,
      loadEff: loadEff, pvOn: pvOn, chg: chg, dis: dis, sell: sell, buy: buy, its: its };
  }
  function updateFlows() {
    var F = FLOWC[theme];
    units.forEach(function (u, i) {
      var c = cond(data[i]);
      var spd = .25 + Math.min(1, Math.max(Math.abs(c.st), Math.abs(c.surplus || 0)) / 625) * 1.6;
      if (c.pvOn) spd = Math.max(spd, .25 + Math.min(1, c.pv / 972.4) * 1.6);
      function lit(f, on, color, dir) {
        f.tubeMat.color.setHex(on ? color : F.idle);
        f.tubeMat.opacity = on ? .95 : .22;
        f.dir = dir || 1; f.spd = on ? spd : .06;
      }
      flows.forEach(function (f) {
        if (f.gi !== i || f.outside) return;
        switch (f.kind) {
          case 'pv': lit(f, c.pvOn, F.ac, 1); break;
          case 'pvlow': lit(f, c.pvOn && (c.chg || c.sell), F.ac, 1); break;
          case 'pvh': lit(f, c.pvOn && c.loadEff > .3, F.ac, 1); break;
          case 'sto': lit(f, c.pvOn && c.chg, F.ac, 1); break;
          case 'gsto': lit(f, c.chg && c.buy, F.buy, 1); break;
          case 'grid': lit(f, c.pvOn && c.sell, F.ac, 1); break;
          case 'stoh': lit(f, c.dis && c.loadEff > .3, F.dis, 1); break;
          case 'gl': lit(f, c.buy && c.loadEff > .3, F.buy, 1); break;
        }
      });
      /* 本群那根上塔线：卖电黄上行、受电蓝下行 */
      flows.forEach(function (f) {
        if (!f.outside || f.gi !== i) return;
        var on = c.sell || c.buy;
        f.tubeMat.color.setHex(on ? (c.sell ? F.ac : F.buy) : F.idle);
        f.tubeMat.opacity = on ? .95 : .22;
        f.dir = c.sell ? 1 : -1; f.spd = on ? spd : .06;
      });
      /* 柜体 SOC 光柱 / 指示灯 / 柜底光晕：颜色跟工况（放电青绿 / 光伏充黄 / 电网充蓝 / 待机暗绿）。
         待机一律用 bar 而不是线路的 idle——idle 是给"没电的线"用的近黑色，
         拿来涂电量柱就看着像没亮 */
      var cc = c.dis ? F.dis : (c.chg ? (c.buy ? F.buy : F.ac) : F.bar);
      var soc = (data[i].soc == null) ? null : Math.max(0, Math.min(100, data[i].soc));
      u.cabs.forEach(function (cb) {
        var ud = cb.ref.userData;
        ud.bars.forEach(function (b) {
          b.material.color.setHex(cc);
          b.scale.y = soc == null ? .12 : Math.max(.08, soc / 100);   /* 没上报 SOC 就留一截暗槽，不装样子 */
          SP.syncSleeve(b);
        });
        ud.led.material.color.setHex(cc);
        ud.glow.material.color.setHex(cc);
        ud.glow.material.opacity = (c.dis || c.chg) ? (theme === 'day' ? .07 : .13) : .03;
      });
      /* 标签：厂房 = 本群工况 + 关口；储能柜 = 功率 / SOC / 今日充放；屋顶光伏 = 分群（暂无）与全站口径 */
      var dd = data[i];
      if (u.tagBld) {
        u.tagBld.querySelector('i').textContent = c.provChg ? '工况 1（暂按光伏充储能）'
          : (c.its.length ? '工况 ' + c.its.join('+')
            : (c.stationPv ? '全站光伏' : ((c.hasPv || c.hasSt || c.hasGrid) ? '本群待机' : '无数据')));
        u.tagBld.querySelector('em').textContent = '光伏 ' + (dd.pv == null ? '--kW' : num(dd.pv, 'kW'))
          + ' · 关口 ' + (dd.grid == null ? '--kW'
            : ((dd.grid >= 0 ? '取 ' : '送 ') + Math.abs(+dd.grid).toFixed(1) + 'kW'));
      }
      if (u.tagSt) {
        u.tagSt.querySelector('i').textContent = (dd.st == null ? '--kW'
          : ((dd.st > .5 ? '放电 ' : (dd.st < -.5 ? '充电 ' : '待机 ')) + Math.abs(+dd.st).toFixed(1) + 'kW'))
          + ' · SOC ' + (dd.soc == null ? '--%' : Math.round(dd.soc) + '%');
        u.tagSt.querySelector('em').textContent = '今日充 ' + (dd.chg == null ? '--' : (+dd.chg).toFixed(0))
          + ' / 放 ' + (dd.dis == null ? '--' : (+dd.dis).toFixed(0)) + ' 度';
      }
      if (u.tagPv) {
        /* 版式同洙边：实时功率 + 今日发电（不展示总装机容量） */
        u.tagPv.querySelector('i').textContent = dd.pv == null ? '--kW' : (+dd.pv).toFixed(2) + ' kW';
        u.tagPv.querySelector('em').textContent = '今日 '
          + (dd.pvToday == null ? '--' : (+dd.pvToday).toFixed(1)) + ' 度';
      }
    });
    /* 组件发光：全站光伏 / 装机容量；没数据就回暗态 */
    var pvRatio = stationPv.seen ? Math.max(0, Math.min(1, stationPv.kw / 972.4)) : 0;
    units.forEach(function (u) {
      var m = u.grp.userData.M && u.grp.userData.M.panel;
      if (!m || !m.emissive) return;
      m.emissive.setHex(pvRatio > .005 ? (theme === 'day' ? 0x14507f : 0x0b3c60) : 0x0a0d10);
      m.emissiveIntensity = stationPv.seen
        ? ((theme === 'day' ? .04 : .14) + pvRatio * (theme === 'day' ? .22 : .34))
        : .1;
    });
    if (tower && tower.tagEl) {
      var anySell = units.some(function (u, i) { return cond(data[i]).sell; });
      var anyBuy = units.some(function (u, i) { return cond(data[i]).buy; });
      var anyGrid = units.some(function (u, i) { return cond(data[i]).hasGrid; });
      tower.tagEl.querySelector('em').textContent = (anySell || anyBuy)
        ? (anySell ? '送出中' : '受电中')
        : (anyGrid ? '待机' : (stationPv.seen ? ('全站光伏 ' + num(stationPv.kw, 'kW')) : '无数据'));
    }
    refreshCards();
  }
  function num(v, unit) { return v == null ? '--' + (unit || '') : (+v).toFixed(1) + (unit || ''); }
  function refreshCards() {
    if (!activeCard) return;
    units.forEach(function (u, i) {
      if ('g' + i !== activeCard) return;
      var d = data[i], c = cond(d);
      setCard('g' + i, GN[i] + ' · ' + GCAB[i] + ' 台光储一体柜', [
        ['光伏出力', num(d.pv, ' kW')],
        ['储能功率', d.st == null ? '-- kW' : ((d.st > 0 ? '放电 ' : d.st < 0 ? '充电 ' : '待机 ') + Math.abs(d.st).toFixed(1) + ' kW')],
        ['SOC', d.soc == null ? '-- %' : (+d.soc).toFixed(0) + ' %'],
        ['负载', num(d.load, ' kW')],
        ['关口表', d.grid == null ? '-- kW' : ((+d.grid >= 0 ? '取电 ' : '送电 ') + Math.abs(d.grid).toFixed(1) + ' kW')]
      ], c.provChg ? '当前工况：1（暂按光伏充储能，储能数据未接入）'
        : (c.its.length ? '当前工况：' + c.its.join(' + ')
          : ((c.hasPv || c.hasSt || c.hasGrid) ? '本群待机（数据已接入，当前无工况）' : '数据未接入')));
    });
    if (activeCard === 'tower') {
      setCard('tower', '并网铁塔 · 10kV 上网线路', [
        ['进塔回路', units.length + ' 回（每群一根）'],
        ['塔身', '格构塔 · 三层横担 · 三跨导线'],
        ['本站装机', '光伏 972.4kWp / 逆变器 820kW'],
        ['储能', '625kW / 1305kWh']
      ], '关口在各群终端箱，本塔为全站共用上网点');
    }
  }

  /* ---------------- 环境层（坪面光池 / 扫光带 / 日月 / 云 / 降水，逐条照洙边） ---------------- */
  function buildEnv(th) {
    var T = T_();
    /* 坪面光池：加色径向渐变，场坪中心亮、四周暗 */
    siteGlow = new T.Mesh(new T.PlaneGeometry(150, 100), new T.MeshBasicMaterial({
      map: glowTex(), color: th.glow, transparent: true, opacity: SP.env(theme).glow,
      blending: T.AdditiveBlending, depthWrite: false, toneMapped: false }));
    siteGlow.rotation.x = -Math.PI / 2; siteGlow.position.set(0, .2, 1); siteGlow.renderOrder = 2;
    root.add(siteGlow);
    /* 扫光带：一条极淡的加色光带缓慢横移（18s 一轮），给静态画面一点"数据在跑"的呼吸 */
    sweepMesh = new T.Mesh(new T.PlaneGeometry(26, 74), new T.MeshBasicMaterial({
      map: sweepTex(), color: th.glow, transparent: true, opacity: th.sweep,
      blending: T.AdditiveBlending, depthWrite: false, toneMapped: false }));
    sweepMesh.rotation.x = -Math.PI / 2; sweepMesh.position.set(-58, .21, 1); sweepMesh.renderOrder = 3;
    root.add(sweepMesh);
    /* 日 / 月：真实昼夜决定挂哪一个（见 refreshSkyLight） */
    sun = new T.Mesh(new T.SphereGeometry(3.2, 20, 20), new T.MeshBasicMaterial({ color: 0xffe9a8, fog: false }));
    sun.position.set(52, 46, 30); root.add(sun);
    sunGlow = new T.Sprite(new T.SpriteMaterial({ map: sunGlowTex(), transparent: true,
      blending: T.AdditiveBlending, depthWrite: false, fog: false, opacity: .6 }));
    sunGlow.position.copy(sun.position); sunGlow.scale.set(26, 26, 1); root.add(sunGlow);
    moon = new T.Mesh(new T.SphereGeometry(1.9, 18, 18), new T.MeshBasicMaterial({ color: 0xdfe9f5, fog: false }));
    moon.position.set(-48, 42, 22); root.add(moon);
    /* 云：9 团、缓慢东移，按云量显隐 */
    cloudGrp = new T.Group();
    for (var i = 0; i < 9; i++) {
      var cg = new T.Group();
      for (var k = 0; k < 4; k++) {
        var cm = new T.MeshBasicMaterial({ color: th.cloud, transparent: true, opacity: .7 + Math.random() * .25 });
        var s = new T.Mesh(new T.SphereGeometry(2.6 + Math.random() * 2.2, 10, 10), cm);
        s.position.set(k * 3.1 - 4.4, Math.random() * 1.2, Math.random() * 2.4 - 1.2);
        cloudMats.push(cm); cg.add(s);
      }
      cg.position.set((Math.random() - .5) * 140, 42 + Math.random() * 16, (Math.random() - .5) * 120);
      cg.userData.speed = .35 + Math.random() * .5;
      cloudGrp.add(cg);
    }
    root.add(cloudGrp);
    /* 降水：420 滴合批成一个 InstancedMesh（1 个 draw call） */
    rainMat = new T.MeshBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: .5 });
    rainInst = new T.InstancedMesh(new T.CylinderGeometry(.022, .022, .9, 4), rainMat, RAIN_N);
    rainInst.visible = false;
    rainInst.frustumCulled = false;                /* 位置每帧改，包围盒不跟着走 */
    var rm = new T.Matrix4();
    for (var q = 0; q < RAIN_N; q++) {
      rainX[q] = (Math.random() - .5) * 92; rainY[q] = Math.random() * 30 + 2;
      rainZ[q] = (Math.random() - .5) * 80; rainV[q] = 2.4 + Math.random() * 2;
      rm.makeTranslation(rainX[q], rainY[q], rainZ[q]);
      rainInst.setMatrixAt(q, rm);
    }
    rainInst.instanceMatrix.setUsage(T.DynamicDrawUsage);
    root.add(rainInst);
  }

  /* 天空当环境贴图：金属、玻璃、柜面才有天光反射（洙边同款做法） */
  function refreshEnv() {
    var T = T_();
    if (!renderer || typeof T.PMREMGenerator !== 'function' || !dome) return;
    try {
      var pmrem = new T.PMREMGenerator(renderer);
      var envTex = dome.material.map;
      envTex.mapping = T.EquirectangularReflectionMapping;
      var rt = pmrem.fromEquirectangular(envTex);
      if (envRT) envRT.dispose();
      envRT = rt;
      scene.environment = envRT.texture;
      pmrem.dispose();
    } catch (e) { scene.environment = null; }
  }

  /* 天气驱动灯光与日月云雨；没上报的字段按"无云 / 按主题昼夜"处理，不编数据 */
  function refreshSkyLight() {
    var th = THEMES[theme];
    var cloud = wx.cloud == null ? 0 : Math.max(0, Math.min(100, Number(wx.cloud) || 0));
    var rad = wx.radiation == null ? 0 : Math.max(0, Number(wx.radiation) || 0);
    var day = wx.isDay == null ? theme !== 'night' : !!wx.isDay;
    var dim = 1 - cloud / 100 * .38;
    if (key) key.intensity = (th.key + (rad > 0 ? Math.min(1, rad / 950) * th.keyRad : .1)) * dim;
    if (hemi) hemi.intensity = th.hemi * dim;
    if (fill) fill.intensity = th.fill;
    if (sun) sun.visible = day;
    if (sunGlow) {
      sunGlow.visible = day;
      sunGlow.material.opacity = (theme === 'day' ? .55 : .4) * (1 - cloud / 160);
    }
    if (moon) moon.visible = !day;
    var cf = cloud / 100;
    if (cloudGrp) cloudGrp.children.forEach(function (cg) {
      cg.visible = cf > .08;
      cg.children.forEach(function (s) {
        s.material.opacity = (theme === 'day' ? .35 : .22) + cf * (theme === 'day' ? .6 : .45);
      });
    });
    if (rainInst) {
      rainInst.visible = Number(wx.precip) > 0;
      if (rainMat) rainMat.opacity = cf > .5 ? .6 : .45;
    }
    if (sweepMesh) sweepMesh.material.opacity = th.sweep;
  }

  /* ---------------- 建站 ---------------- */
  function build(M) {
    var T = T_();
    root = new T.Group(); root.userData.M = M; scene.add(root);
    var th = THEMES[theme];
    dome = new T.Mesh(new T.SphereGeometry(210, 28, 18),
      new T.MeshBasicMaterial({ map: skyTex(th.sky), side: T.BackSide, depthWrite: false, fog: false }));
    dome.renderOrder = -1;
    root.add(dome);
    hemi = new T.HemisphereLight(theme === 'night' ? 0xbfe9ff : 0xdff0ff,
      theme === 'night' ? 0x0a1518 : 0x76815f, th.hemi);
    root.add(hemi);
    key = new T.DirectionalLight(theme === 'night' ? 0xcfe8ff : 0xfff2d0, th.key);
    key.position.set(-70, 100, 80); key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    /* 阴影相机罩住品字三群 + 中心塔（x ±27 / z ±19）即可；铺到整片 460 场坪
       等于把 2048 摊到几百米上，阴影反而糊成一片 */
    var sc = key.shadow.camera;
    sc.left = -40; sc.right = 40; sc.top = 36; sc.bottom = -36; sc.near = 1; sc.far = 260;
    key.shadow.bias = -0.0006;
    key.shadow.normalBias = .02;
    root.add(key);
    fill = new T.DirectionalLight(theme === 'night' ? 0x2ee6c8 : 0xbfe0ff, th.fill);
    fill.position.set(-24, 14, -18); root.add(fill);

    var ground = new T.Mesh(new T.PlaneGeometry(700, 700), M.ground);
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; root.add(ground);
    buildEnv(th);

    var xs = [], zs = [];
    SITE.forEach(function (p, i) {
      var u = makeUnit(M, i);
      u.grp.position.set(p.x, 0, p.z);
      if (p.m) u.grp.scale.x = -1;                 /* 一号柜列镜像到厂房右侧 */
      root.add(u.grp);
      u.grp.updateMatrixWorld(true);
      u.tbWorld = u.tbLocal.clone().applyMatrix4(u.grp.matrixWorld);
      var cw = u.cabs.map(function (c) { return u.grp.localToWorld(new T.Vector3(c.x, 0, c.z)); });
      /* 三块标签各归其位（版式同洙边 / 东明）：厂房 = 南立面（同洙边「卫生院」那块）、
         储能柜 = 柜列正上方、屋顶光伏阵列 = 屋面正上方 */
      var ccx = 0, ccz = 0;
      cw.forEach(function (v) { ccx += v.x; ccz += v.z; });
      ccx /= cw.length; ccz /= cw.length;
      u.tagBld = label('<b>' + GB[i] + '（工厂用电）</b><i>--</i><em>--</em>', 'tag3d-gt',
        p.x, 4.4, p.z + D2 / 2 + 1.0);
      u.tagSt = label('<b>储能柜 · ' + GCABN[i] + '</b><i>--</i><em>--</em>', 'tag3d-gt',
        ccx, CAB.h + 1.5, ccz);
      /* 光伏标签挂屋面北沿并抬高：前排三号的屋面标签原来看起来压在南立面的厂房标签上 */
      u.tagPv = label('<b>屋顶光伏阵列</b><i>--kW</i><em>今日 -- 度</em>', 'tag3d-gt',
        p.x, roofY + 2.7, p.z - D2 / 2 - .8);
      addCard('g' + i, p.x, roofY + 1.2, p.z);
      u.grp.userData.cardKey = 'g' + i;
      units.push(u);
      /* 落地阴影走世界坐标：一号群是 scale.x=-1 的镜像组，往里面塞平面会被翻转成背面 */
      groundContact(root, p.x, p.z, W2 + 3.6, D2 + 3.4);
      cw.forEach(function (v) { groundContact(root, v.x, v.z, CAB.w * 1.55, CAB.d * 1.95); });
      var c0 = Math.min.apply(null, cw.map(function (v) { return v.x; }));
      var c1 = Math.max.apply(null, cw.map(function (v) { return v.x; }));
      xs.push(c0 - 2, c1 + 2, p.x - W2 / 2 - 1.2, p.x + W2 / 2 + 1.2, u.tbWorld.x - .6, u.tbWorld.x + .6);
      zs.push(p.z - D2 / 2 - 1.6, p.z + D2 / 2 + 2.6, u.tbWorld.z + 1);
    });

    /* 中央铁塔：转 90°，10kV 穿越导线沿东西跨，不从厂房屋顶穿过 */
    tower = makeTower(M, '1#');
    tower.position.set(TWR_AT.x, 0, TWR_AT.z);
    tower.rotation.y = Math.PI / 2;
    root.add(tower);
    groundContact(root, TWR_AT.x, TWR_AT.z, 5.6, 5.6);
    tower.userData.cardKey = 'tower';
    addCard('tower', TWR_AT.x, TWRH - 1.8, TWR_AT.z);
    tower.tagEl = label('<b>并网铁塔</b><i>10kV 上网线路 · 三回</i><em>--</em>', 'tag3d-gt',
      TWR_AT.x, TWRH + .5, TWR_AT.z);
    xs.push(TWR_AT.x - 4.5, TWR_AT.x + 4.5); zs.push(TWR_AT.z - 4.5, TWR_AT.z + 4.5);

    /* 每群一根线上塔：贴地到塔位，再拉线上塔中央；三个进塔点不交叉 */
    units.forEach(function (u, i) {
      var land, pts;
      if (i === 2) {                                 /* 前排三号：绕自己厂房东侧空档北上 */
        var ringZ = u.tbWorld.z + 2.4, side = TWR_AT.x + 9.5;
        land = [TWR_AT.x + 2.4, .44, TWR_AT.z + 2.0];
        pts = [[u.tbWorld.x, .44, u.tbWorld.z], [u.tbWorld.x, .44, ringZ],
          [side, .44, ringZ], [side, .44, land[2]], land];
      } else {
        land = [TWR_AT.x + (i === 0 ? -2.4 : 2.4), .44, TWR_AT.z];
        pts = [[u.tbWorld.x, .44, u.tbWorld.z], [u.tbWorld.x, .44, TWR_AT.z], land];
      }
      var f1 = addFlow(root, 'lead', i, pts, .05);
      if (f1) f1.outside = true;
      var f2 = addFlow(root, 'tower', i, [land, [land[0], 1.2, land[2]],
        [TWR_AT.x + (land[0] - TWR_AT.x) * .35, 3.6, TWR_AT.z + (land[2] - TWR_AT.z) * .35],
        [TWR_AT.x, 5.9, TWR_AT.z]], .052);
      if (f2) f2.outside = true;
      if (state_duis()) {
        for (var s = 1; s < pts.length - 1; s++) {
          var a = pts[s], b = pts[s + 1];
          var L = Math.sqrt(Math.pow(b[0] - a[0], 2) + Math.pow(b[2] - a[2], 2));
          for (var q = 1.2; q < L - .6; q += 2.5) {
            var t = q / L;
            root.add(box(.16, .16, .16, M.saddle, a[0] + (b[0] - a[0]) * t, .26, a[2] + (b[2] - a[2]) * t));
          }
        }
      }
    });

    /* 场坪：按设备占位算，外扩 6m */
    var x0 = Math.min.apply(null, xs) - 6, x1 = Math.max.apply(null, xs) + 6;
    var z0 = Math.min.apply(null, zs) - 6, z1 = Math.max.apply(null, zs) + 6;
    var sw = x1 - x0, sd = z1 - z0;
    M.slab.map.repeat.set(19, 10);
    var slab = new T.Mesh(new T.BoxGeometry(460, .18, 240), M.slab);
    slab.position.set((x0 + x1) / 2, .09, (z0 + z1) / 2); slab.receiveShadow = true; root.add(slab);
    var ed = new T.LineSegments(new T.EdgesGeometry(new T.BoxGeometry(460, .18, 240)), M.edge);
    ed.position.copy(slab.position); root.add(ed);
    center = new T.Vector3((x0 + x1) / 2, 2, (z0 + z1) / 2);
    fitPts = [];
    units.forEach(function (u, i) {
      fitPts.push(new T.Vector3(SITE[i].x, roofY + 2, SITE[i].z));
      fitPts.push(u.tbWorld.clone());
    });
    fitPts.push(new T.Vector3(TWR_AT.x, TWRH + 1.2, TWR_AT.z));
    /* 取景按设备轮廓，不算场坪外扩的那圈空坪：带上 6m 外扩会把机位顶到 84m，
       三栋厂房在画面里就缩成一小块（洙边 fitStory 同样只框设备，不框场坪） */
    var ex0 = Math.min.apply(null, xs), ex1 = Math.max.apply(null, xs);
    var ez0 = Math.min.apply(null, zs), ez1 = Math.max.apply(null, zs);
    fitPts.push(new T.Vector3(ex0, .2, ez0)); fitPts.push(new T.Vector3(ex1, .2, ez0));
    fitPts.push(new T.Vector3(ex0, .2, ez1)); fitPts.push(new T.Vector3(ex1, .2, ez1));
  }
  var center = null, fitPts = [], duisOn = true;
  function state_duis() { return duisOn; }

  /* ---------------- 相机 ---------------- */
  var FIT_CAM = null;
  function fitDistance(tgt, dir, pts, aspect) {
    var T = T_();
    if (!FIT_CAM) FIT_CAM = new T.PerspectiveCamera(46, 1, .1, 1400);
    var lo = 14, hi = 420, best = hi;
    for (var i = 0; i < 26; i++) {
      var mid = (lo + hi) / 2;
      FIT_CAM.position.copy(tgt).add(dir.clone().multiplyScalar(mid));
      FIT_CAM.lookAt(tgt); FIT_CAM.aspect = aspect;
      FIT_CAM.updateMatrixWorld(true); FIT_CAM.updateProjectionMatrix();
      var ok = true;
      for (var k = 0; k < pts.length; k++) {
        var v = pts[k].clone().project(FIT_CAM);
        if (Math.abs(v.x) > .74 || Math.abs(v.y) > .72) { ok = false; break; }
      }
      if (ok) { best = mid; hi = mid; } else lo = mid;
    }
    return best;
  }
  function resetView() {
    if (!camera || !center) return;
    var dir = new (T_().Vector3)(-.3, .42, .86).normalize();
    var d = fitDistance(center, dir, fitPts, Math.max(.2, (W || 1200) / (H || 800)));
    camera.position.copy(center).add(dir.multiplyScalar(d));
    controls.target.copy(center);
    camHome = { p: camera.position.clone(), t: center.clone() };
    lblRef = d;                      /* 默认机位 = 浮标 100% */
    camAz = 0;
    controls.update();
  }

  /* ---------------- 主题 ---------------- */
  /* 整场重建前把旧几何 / 旧材质 / 旧贴图释放掉：不然每切一次主题就留下一份
     三群场景的显存，切几轮就卡（接触阴影和地面贴图都是新建的 CanvasTexture） */
  function disposeRoot(g) {
    if (!g) return;
    g.traverse(function (o) {
      if (o.userData && o.userData.presetShared) return;   // 全站复用的接触阴影几何 / 贴图不能释放
      if (o.geometry && o.geometry.dispose) o.geometry.dispose();
      var ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      ms.forEach(function (m) {
        if (m.map && m.map.dispose) m.map.dispose();
        if (m.emissiveMap && m.emissiveMap.dispose) m.emissiveMap.dispose();
        if (m.dispose) m.dispose();
      });
    });
  }

  function applyTheme() {
    theme = document.documentElement.getAttribute('data-theme') === 'day' ? 'day' : 'night';
    var th = THEMES[theme], M = mats(theme);
    /* 换材质：整场重建（构件材质上百个，逐个换更容易漏；重建一次比留错值划算） */
    disposeRoot(root);
    scene.remove(root);
    root = null; flows = []; units = []; labelPairs = []; cards = {}; occluders = []; beacons = [];
    contacts = [];
    cloudMats = [];
    activeCard = null;
    build(M);
    scene.fog.color.setHex(th.fog.c); scene.fog.near = th.fog.near; scene.fog.far = th.fog.far;
    scene.background.setHex(th.bg);
    SP.setExposure(renderer, theme);
    SP.applyThemeToPasses(bloomPass, vigPass, theme);
    refreshEnv();
    refreshSkyLight();
    updateFlows();
    applyLabelVisibility();
  }

  /* ---------------- 循环 ---------------- */
  function loop(ts) {
    raf = requestAnimationFrame(loop);
    var dt = Math.min(.05, (ts - last) / 1000 || 0); last = ts;
    if (!active) return;
    if (rotating) {
      camAz += dt * .055;
      var p = camera.position.clone().sub(controls.target);
      var s = Math.sin(camAz), c = Math.cos(camAz);
      camera.position.set(controls.target.x + p.x * c - p.z * s, camera.position.y, controls.target.z + p.x * s + p.z * c);
    }
    controls.update();
    var spd = 1;
    flows.forEach(function (f) {
      f.map.offset.x = (f.map.offset.x - dt * f.spd * spd * .35 * f.dir) % 1;
    });
    beacons.forEach(function (b) {
      var k = .45 + .45 * Math.sin(ts / 520);
      b[0].material.opacity = .55 + k * .45; b[1].material.opacity = .25 + k * .4;
    });
    /* 云缓慢东移、降水下落、扫光带 18s 横移一轮 */
    if (cloudGrp) cloudGrp.children.forEach(function (cg) {
      cg.position.x += cg.userData.speed * dt * 6;
      if (cg.position.x > 78) cg.position.x = -78;
    });
    if (rainInst && rainInst.visible) {
      if (!_rainM) _rainM = new (T_().Matrix4)();
      for (var i = 0; i < RAIN_N; i++) {
        rainY[i] -= rainV[i] * dt * 3.6;
        if (rainY[i] < 0) rainY[i] = 30;
        _rainM.makeTranslation(rainX[i], rainY[i], rainZ[i]);
        rainInst.setMatrixAt(i, _rainM);
      }
      rainInst.instanceMatrix.needsUpdate = true;
    }
    if (sweepMesh && sweepMesh.material.opacity > 0) {
      sweepMesh.position.x = -58 + ((ts / 1000) % 18) / 18 * 116;
    }
    scaleLabels();
    updateOcclusion();
    renderer.setScissorTest(false); renderer.setViewport(0, 0, W, H);
    if (composer) composer.render(); else renderer.render(scene, camera);
    if (labelR) labelR.render(scene, camera);
  }

  /* ---------------- 初始化 ---------------- */
  function init(onReady) {
    if (inited) { resize(); return; }
    if (typeof window.THREE === 'undefined') {          /* THREE 由 main.js 异步注入，等它 */
      setTimeout(function () { init(onReady); }, 300); return;
    }
    var T = T_();
    var host = document.getElementById('jy3d');
    if (!host) return;
    inited = true;
    theme = document.documentElement.getAttribute('data-theme') === 'day' ? 'day' : 'night';
    scene = new T.Scene();
    scene.fog = new T.Fog(THEMES[theme].fog.c, THEMES[theme].fog.near, THEMES[theme].fog.far);
    scene.background = new T.Color(THEMES[theme].bg);
    camera = new T.PerspectiveCamera(46, 1, .1, 1400);
    renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    /* ACES 色调映射 + 柔和阴影：自发光超过 1.0 不再直接裁成纯白，高光有滚降 */
    SP.setupRenderer(T, renderer, theme);
    host.appendChild(renderer.domElement);
    if (typeof T.CSS2DRenderer === 'function') {
      labelR = new T.CSS2DRenderer();
      labelR.domElement.style.position = 'absolute';
      labelR.domElement.style.top = '0';
      labelR.domElement.style.pointerEvents = 'none';
      host.appendChild(labelR.domElement);
    }
    controls = new T.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = .08;
    controls.maxPolarAngle = Math.PI * .495;
    controls.minDistance = 12; controls.maxDistance = 320;

    try {
      build(mats(theme));
    } catch (e) {
      console.error('峻涌 3D 场景初始化失败', e);
      return;
    }

    /* 点设备 → 明细卡（卡片打开时浮标全藏，同洙边） */
    var down = null;
    renderer.domElement.addEventListener('pointerdown', function (e) { down = [e.clientX, e.clientY]; });
    renderer.domElement.addEventListener('pointerup', function (e) {
      if (!down) return;
      var moved = Math.abs(e.clientX - down[0]) + Math.abs(e.clientY - down[1]);
      down = null;
      if (moved > 6) return;
      var r = renderer.domElement.getBoundingClientRect();
      var v = new T.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      var ray = new T.Raycaster();
      ray.setFromCamera(v, camera);
      var hit = ray.intersectObjects(root.children, true)[0];
      while (hit && !hit.object.userData.cardKey) hit = hit.object.parent ? { object: hit.object.parent } : null;
      showCard(hit ? hit.object.userData.cardKey : null);
    });
    resize();            /* 先量画幅：resetView 的取景距离要用 W/H，顺序反了算出来是 NaN，整屏黑 */
    /* 后期处理：MSAA + 泛光（半分辨率）+ 暗角冷调，三站同一条链，见 js/scene-preset.js
       暗角 pass 是"高级感"的关键一步：压住四角、让画面中心聚焦到设备上 */
    if (typeof T.EffectComposer === 'function' && T.RenderPass && T.UnrealBloomPass) {
      var cp = SP.compose(T, renderer, scene, camera, theme, { width: W, height: H });
      composer = cp.composer; bloomPass = cp.bloomPass; vigPass = cp.vigPass;
    }
    refreshEnv();
    refreshSkyLight();
    resetView();
    updateFlows();
    raf = requestAnimationFrame(loop);
    window.addEventListener('resize', resize);
    /* 主题：和洙边一样盯 data-theme 属性，顶栏一切换就整场按新材质重建 */
    new MutationObserver(function () { applyTheme(); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    if (onReady) onReady();
  }
  function resize() {
    if (!renderer) return;
    var host = document.getElementById('jy3d');
    if (!host) return;
    var r = host.getBoundingClientRect();
    W = Math.max(2, Math.floor(r.width)); H = Math.max(2, Math.floor(r.height));
    renderer.setSize(W, H);
    camera.aspect = W / H; camera.updateProjectionMatrix();
    if (labelR) labelR.setSize(W, H);
    SP.resizeComposer(composer, bloomPass, W, H);   /* 泛光半分辨率：4K 屏上省 4 倍填充率 */
    if (camHome) {                       /* 比例变了按新画幅重新算距离，保留当前视线方向 */
      var dir = camera.position.clone().sub(controls.target).normalize();
      var d = fitDistance(center, dir, fitPts, Math.max(.2, W / H));
      camera.position.copy(center).add(dir.multiplyScalar(d));
      controls.target.copy(center); controls.update();
      camHome = { p: camera.position.clone(), t: center.clone() };
      lblRef = d;
    }
  }
  function setLabels(on) { labelsOn = !!on; applyLabelVisibility(); }
  function setRotate(on) { rotating = !!on; }
  function setActive(on) { active = !!on; if (on) resize(); }
  function setDuis(on) { duisOn = !!on; applyTheme(); }
  function setGroup(i, d) {
    if (i < 0 || i > 2 || !d) return;
    for (var k in d) data[i][k] = d[k];
    if (inited) updateFlows();
  }
  /* 全站口径：kw = 站级光伏功率（kW）；seen=false 表示没数据（回到待机暗态） */
  function setStationPv(kw, seen) {
    var v = Number(kw);
    stationPv.seen = !!seen && kw !== null && kw !== undefined && isFinite(v);
    stationPv.kw = stationPv.seen ? v : 0;
    if (inited) updateFlows();
  }
  function setWeather(w) {
    if (!w) return;
    wx.cloud = w.cloud; wx.precip = w.precip; wx.radiation = w.radiation;
    wx.isDay = (w.is_day === undefined || w.is_day === null) ? null
      : ((w.is_day === 0 || w.is_day === '0') ? 0 : 1);
    if (inited) refreshSkyLight();
  }
  return {
    init: init, resize: resize, resetView: resetView, setLabels: setLabels, setRotate: setRotate,
    setActive: setActive, setGroup: setGroup, setStationPv: setStationPv, setWeather: setWeather, setDuis: setDuis,
    setTheme: function () { if (inited) applyTheme(); },
    ready: function () { return inited; }
  };
})();
