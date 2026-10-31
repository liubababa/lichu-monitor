/* ============================================================
 * 三站共用渲染层（旭日东明 / 洙边 / 峻涌）
 *
 * 为什么要有这个文件：地面贴图、灯光量、泛光、暗角、接触阴影这些"观感数值"
 * 原来在三个 scene3d 里各抄一份，抄着抄着就飘了（东明没有环境反射、没有暗角、
 * 阴影只覆盖中间一小块），三站看着不像同一个产品。观感参数收在这里当唯一真源，
 * 各站只保留自己的语义颜色（光伏黄 / 电网蓝 / 储能青 / 馈电橙）。
 *
 * 红线：THREE 由 main.js 异步注入，本文件顶层不许引用 THREE —— 一律从参数拿。
 * ============================================================ */
window.ScenePreset = (function () {
  'use strict';

  /* ---------------- 观感数值（三站同一套） ----------------
     exposure：ACES 会把中间调压暗约 20%，所以光量要比"没有色调映射"时代给得高，
               否则改完反而更黑。数值靠截图校，不靠直觉。
     envInt  ：天空反射强度。金属/玻璃没有它一定是平、哑、塑料感。
     bloom   ：阈值要低于 ACES 的最大输出（约 .8），否则自发光全被压到阈值以下，
               泛光等于没开。 */
  const ENV = {
    night: {
      exposure: 1.3,
      envInt: .85,
      bloom: { strength: .42, radius: .7, threshold: .68 },
      vignette: { strength: .34, tint: .07 },
      lights: { hemi: 1.35, key: .82, fill: .2 },
      pave: {
        /* 地面是"底座"，必须比设备暗一档，设备才出得来；
           原来夜地面被半球光 + 天空反射抬成一片灰蓝，整屏没对比 */
        base: [15, 22, 27], panelVar: .1,
        aggregate: { dark: .08, light: .03 },
        joint: { alpha: .36, hi: .1 },
        grid: { minor: .07, major: .15 }
      },
      contact: .5,
      edge: .26,
      glow: .07,
      sweep: .04
    },
    day: {
      exposure: 1.16,
      envInt: .6,
      bloom: { strength: .1, radius: .6, threshold: .92 },
      vignette: { strength: .14, tint: 0 },
      lights: { hemi: .82, key: .95, fill: .14 },
      pave: {
        /* 白天原来直接用近白（206），ACES 之后仍然是一片纸白，阴影和板缝全丢 */
        base: [146, 156, 155], panelVar: .06,
        aggregate: { dark: .07, light: .05 },
        joint: { alpha: .3, hi: .2 },
        grid: { minor: .05, major: .11 }
      },
      contact: .3,
      edge: .2,
      glow: .04,
      sweep: 0
    }
  };

  /* ---------------- 浮标缩放规则（三站同一条） ----------------
     浮标是固定像素的 HTML，拉远后模型缩成一点、浮标还是原尺寸就会糊成一片盖住设备。
     ref 由各家按自己的默认机位给；k 是"默认机位下也不占满画面"的整体收小，
     min/max 是远近上下限，threshold 是写 DOM 的变化门槛（性能红线：>4% 才写）。 */
  const LBL = { k: .82, min: .42, max: 1, threshold: .04 };

  function scaleLabelTo(pair, dist, ref) {
    let k = ref * LBL.k / Math.max(1, dist);
    k = Math.min(LBL.max, Math.max(LBL.min, k));
    if (Math.abs((pair.k || 0) - k) < LBL.threshold) return null;
    pair.k = k;
    pair.el.style.setProperty('--lbl-scale', k.toFixed(3));
    /* 拉得越远越淡：到下限降到 .35，远景不至于是"一片标签" */
    pair.el.style.opacity = (.35 + .65 * Math.min(1, (k - LBL.min) / (LBL.max - LBL.min))).toFixed(2);
    return k;
  }

  function env(theme) { return ENV[theme] || ENV.night; }

  /* ---------------- 确定性伪随机 ----------------
     原来地面用 Math.random() 画，每次切主题重排一次，格子会"跳"。换成固定种子。 */
  function rng(seed) {
    let s = seed >>> 0;
    return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }

  /* ---------------- 铺装地面 / 场坪 ----------------
     真实观感来自"逐块板的明度差 + 板缝"，不是随机污渍（原来那 26 个椭圆近看像脏斑）。
     grid=true 时再叠一层数字孪生格网，浓度由 ENV.pave.grid 控制——
     格网是底座，不该比楼和柜子还显眼。 */
  function paveTexture(T, theme, opt) {
    const o = opt || {};
    const p = env(theme), pv = p.pave, grid = !!o.grid;
    const cells = o.cells || 3;              // 一张贴图几块板
    const S = 1024, sc = 2;
    const c = document.createElement('canvas');
    c.width = c.height = S * sc;
    const g = c.getContext('2d');
    g.scale(sc, sc);
    const r = rng(grid ? 20261030 : 20261029);
    const b = pv.base;
    const cell = S / cells;
    for (let sy = 0; sy < cells; sy++) {
      for (let sx = 0; sx < cells; sx++) {
        const d = (r() - .5) * 2 * pv.panelVar;
        g.fillStyle = 'rgb(' + Math.round(b[0] * (1 + d)) + ',' + Math.round(b[1] * (1 + d)) + ',' + Math.round(b[2] * (1 + d)) + ')';
        g.fillRect(sx * cell, sy * cell, cell + 1, cell + 1);
      }
    }
    /* 细骨料：密度高、alpha 低，远距离被 mipmap 平均成"质感"而不是"噪点" */
    for (let i = 0; i < 22000; i++) {
      const darkk = r() > .5;
      g.fillStyle = darkk
        ? 'rgba(0,0,0,' + (r() * pv.aggregate.dark + .004).toFixed(3) + ')'
        : 'rgba(255,255,255,' + (r() * pv.aggregate.light + .004).toFixed(3) + ')';
      g.fillRect(r() * S, r() * S, 1, 1);
    }
    /* 板缝：暗槽 + 下沿一条亮边，等于给每块板做了倒角 */
    const jw = 3, ja = pv.joint.alpha;
    for (let m = 0; m <= cells; m++) {
      const pos = m * cell;
      g.fillStyle = 'rgba(0,0,0,' + ja + ')';
      g.fillRect(pos - jw / 2, 0, jw, S);
      g.fillRect(0, pos - jw / 2, S, jw);
      g.fillStyle = 'rgba(190,215,225,' + pv.joint.hi + ')';
      g.fillRect(pos + jw / 2, 0, 1.6, S);
      g.fillRect(0, pos + jw / 2, S, 1.6);
    }
    if (grid) {
      const gc = o.gridCells || 8, gw = S / gc;
      g.strokeStyle = 'rgba(46,230,200,' + pv.grid.minor + ')';
      g.lineWidth = 1.2;
      for (let i = 0; i <= gc; i++) {
        const pos = Math.round(i * gw) + .5;
        g.beginPath(); g.moveTo(pos, 0); g.lineTo(pos, S); g.stroke();
        g.beginPath(); g.moveTo(0, pos); g.lineTo(S, pos); g.stroke();
      }
      g.strokeStyle = 'rgba(46,230,200,' + pv.grid.major + ')';
      g.lineWidth = 2;
      for (let i = 0; i <= gc; i += 4) {
        const pos = Math.round(i * gw) + .5;
        g.beginPath(); g.moveTo(pos, 0); g.lineTo(pos, S); g.stroke();
        g.beginPath(); g.moveTo(0, pos); g.lineTo(S, pos); g.stroke();
      }
    }
    const tx = new T.CanvasTexture(c);
    tx.wrapS = tx.wrapT = T.RepeatWrapping;
    return tx;
  }

  /* ---------------- 接触阴影 ----------------
     方向光在夜里很弱，只靠它物体一定飘。给每个大件在脚下一层软黑，
     物体才"落地"。用 alphaMap + 纯黑，避免加色那种把地面提亮的反效果。 */
  let _contactTex = null;
  function contactTexture(T) {
    if (_contactTex) return _contactTex;
    const S = 256;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    g.clearRect(0, 0, S, S);
    g.filter = 'blur(26px)';
    g.fillStyle = '#fff';
    const m = 34, rad = 46;
    g.beginPath();
    if (g.roundRect) g.roundRect(m, m, S - m * 2, S - m * 2, rad);
    else {
      const x = m, y = m, w = S - m * 2, h = S - m * 2;
      g.moveTo(x + rad, y);
      g.arcTo(x + w, y, x + w, y + h, rad);
      g.arcTo(x + w, y + h, x, y + h, rad);
      g.arcTo(x, y + h, x, y, rad);
      g.arcTo(x, y, x + w, y, rad);
    }
    g.fill();
    g.filter = 'none';
    _contactTex = new T.CanvasTexture(c);
    return _contactTex;
  }

  let _contactGeo = null;
  /* 在 parent 下 x/z 处铺一块 w×d 的软阴影，贴地 y。同一份几何复用，不新增 draw call 负担 */
  function contact(T, parent, x, z, w, d, y, opacity) {
    if (!_contactGeo) _contactGeo = new T.PlaneGeometry(1, 1);
    const m = new T.Mesh(_contactGeo, new T.MeshBasicMaterial({
      color: 0x000000, alphaMap: contactTexture(T), transparent: true,
      opacity: opacity, depthWrite: false, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4
    }));
    m.rotation.x = -Math.PI / 2;
    m.scale.set(w, d, 1);
    m.position.set(x, y, z);
    m.renderOrder = 1;
    /* 几何与贴图都是全站复用的缓存，站点整场重建时不能跟着 dispose */
    m.userData.presetShared = true;
    parent.add(m);
    return m;
  }

  /* ---------------- 点缀发光 ----------------
     光柱 / 灯带原来只是"涂一块颜色"，颜色暗或泛光阈值一高就看着像没亮。
     这里在外面套一层加色粗壳，让它真的往空气里放光晕。
     做成子物体：父级按 SOC 设 scale.y 时，光晕跟着一起长，不用另外同步高度。 */
  function glowSleeve(T, parent, w, h, d, opacity) {
    const geo = new T.BoxGeometry(w, h, d);
    geo.translate(0, h / 2, 0);
    const m = new T.Mesh(geo, new T.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: opacity,
      blending: T.AdditiveBlending, depthWrite: false, toneMapped: false
    }));
    parent.add(m);
    return m;
  }
  /* 光柱颜色同步：柱体换色时外层光晕跟一起换（状态色只有一个真源） */
  function syncSleeve(bar) {
    const s = bar.userData.sleeve;
    if (s) s.material.color.copy(bar.material.color);
  }

  /* ---------------- 暗角 ----------------
     四角压暗 + 冷调，视线收到中间的设备上。三站同一份 GLSL。 */
  function vignetteShader() {
    return {
      uniforms: {
        tDiffuse: { value: null },
        strength: { value: .3 },
        tint: { value: .06 }
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
    };
  }

  /* 泛光半分辨率 + 暗角，三站同一条链；返回 { composer, bloomPass, vigPass } */
  function compose(T, renderer, scene, camera, theme, opt) {
    const o = opt || {};
    const w = o.width, h = o.height;
    const p = env(theme);
    if (!(typeof T.EffectComposer === 'function' && T.RenderPass && T.UnrealBloomPass)) {
      return { composer: null, bloomPass: null, vigPass: null };
    }
    try {
      const msaa = (typeof T.WebGLMultisampleRenderTarget === 'function')
        ? new T.WebGLMultisampleRenderTarget(w, h, { format: T.RGBAFormat })
        : null;
      const composer = new T.EffectComposer(renderer, msaa || undefined);
      if (msaa) composer.setPixelRatio(renderer.getPixelRatio());
      composer.addPass(new T.RenderPass(scene, camera));
      const bloomPass = new T.UnrealBloomPass(new T.Vector2(w * .5, h * .5),
        p.bloom.strength, p.bloom.radius, p.bloom.threshold);
      composer.addPass(bloomPass);
      let vigPass = null;
      if (typeof T.ShaderPass === 'function') {
        vigPass = new T.ShaderPass(vignetteShader());
        vigPass.uniforms.strength.value = p.vignette.strength;
        vigPass.uniforms.tint.value = p.vignette.tint;
        composer.addPass(vigPass);
      }
      return { composer: composer, bloomPass: bloomPass, vigPass: vigPass };
    } catch (e) {
      return { composer: null, bloomPass: null, vigPass: null };
    }
  }

  function resizeComposer(composer, bloomPass, w, h) {
    if (composer) composer.setSize(w, h);
    /* 泛光是半分辨率跑的，setSize 只按整尺寸给它的内部 RT 定过一遍，这里补上半分辨率 */
    if (bloomPass && bloomPass.setSize) bloomPass.setSize(Math.round(w * .5), Math.round(h * .5));
  }

  function applyThemeToPasses(bloomPass, vigPass, theme) {
    const p = env(theme);
    if (bloomPass) {
      bloomPass.strength = p.bloom.strength;
      bloomPass.radius = p.bloom.radius;
      bloomPass.threshold = p.bloom.threshold;
    }
    if (vigPass) {
      vigPass.uniforms.strength.value = p.vignette.strength;
      vigPass.uniforms.tint.value = p.vignette.tint;
    }
  }

  /* ---------------- 渲染器 ----------------
     ACES 色调映射：自发光超过 1.0 不再直接裁成纯白 255，高光有滚降。
     实测（three r128 + EffectComposer）renderer.toneMapping 在 composer 里生效，
     但 renderer.outputEncoding 不生效——所以这里只设色调映射，不碰编码，
     否则贴图会被二次 gamma 拉灰。 */
  function setupRenderer(T, renderer, theme) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = T.PCFSoftShadowMap;
    if (T.ACESFilmicToneMapping !== undefined) {
      renderer.toneMapping = T.ACESFilmicToneMapping;
      renderer.toneMappingExposure = env(theme).exposure;
    }
  }
  function setExposure(renderer, theme) {
    if (renderer) renderer.toneMappingExposure = env(theme).exposure;
  }

  /* ---------------- 天空反射（IBL） ----------------
     拿穹顶渐变烘一张环境贴图。没有它，金属和玻璃就是死一片纯色。 */
  function buildEnvironment(T, renderer, scene, skyMap, prevRT) {
    if (!renderer || !skyMap || typeof T.PMREMGenerator !== 'function') return prevRT || null;
    try {
      const pmrem = new T.PMREMGenerator(renderer);
      skyMap.mapping = T.EquirectangularReflectionMapping;
      const rt = pmrem.fromEquirectangular(skyMap);
      if (prevRT) prevRT.dispose();
      scene.environment = rt.texture;
      pmrem.dispose();
      return rt;
    } catch (e) {
      scene.environment = null;
      return prevRT || null;
    }
  }

  /* ---------------- 倒角盒 ----------------
     全站所有"方块"都是硬边直角，这是"像纸盒"的直接原因。
     用 ExtrudeGeometry 的 bevel 做真倒角：四条竖棱圆角 + 上下棱倒角。
     只用于单材质零件（底座 / 压顶 / 檐口 / 机柜框架），
     多面贴图的柜体与楼身仍用 Box（ExtrudeGeometry 给不出六面独立贴图）。
     返回几何以原点为中心，和 BoxGeometry 同语义，可直接替换。 */
  function roundedBox(T, w, h, d, r, seg) {
    const rr = Math.max(.004, Math.min(r || .06, Math.min(w, d) / 2 - .004));
    const bev = Math.min(rr, h / 2 - .004);
    const shape = new T.Shape();
    const x = -w / 2, y = -d / 2;
    shape.moveTo(x + rr, y);
    shape.lineTo(x + w - rr, y);
    shape.quadraticCurveTo(x + w, y, x + w, y + rr);
    shape.lineTo(x + w, y + d - rr);
    shape.quadraticCurveTo(x + w, y + d, x + w - rr, y + d);
    shape.lineTo(x + rr, y + d);
    shape.quadraticCurveTo(x, y + d, x, y + d - rr);
    shape.lineTo(x, y + rr);
    shape.quadraticCurveTo(x, y, x + rr, y);
    const geo = new T.ExtrudeGeometry(shape, {
      depth: Math.max(.004, h - bev * 2), bevelEnabled: true,
      bevelThickness: bev, bevelSize: bev, bevelSegments: 1,
      curveSegments: seg || 3, steps: 1
    });
    /* 挤出方向是 +Z，绕 X 转 -90° 让它朝上（+Z → +Y）；形状平面的 Y 落到 -Z */
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, -h / 2, 0);
    geo.computeVertexNormals();
    return geo;
  }

  /* 同尺寸只建一次：储能柜要排 8 台、峻涌三群各一套，重复建 ExtrudeGeometry 太浪费 */
  const _rbCache = {};
  function roundedBoxCached(T, w, h, d, r) {
    const key = [w, h, d, r].join('_');
    if (!_rbCache[key]) _rbCache[key] = roundedBox(T, w, h, d, r);
    return _rbCache[key];
  }

  /* 一个站点的场地参数：接触阴影要贴在场坪顶面，三站场坪厚度一致 */
  const YARD_Y = .18;

  return {
    ENV: ENV, env: env, rng: rng, YARD_Y: YARD_Y,
    LBL: LBL, scaleLabelTo: scaleLabelTo,
    paveTexture: paveTexture,
    contactTexture: contactTexture, contact: contact,
    glowSleeve: glowSleeve, syncSleeve: syncSleeve,
    vignetteShader: vignetteShader,
    compose: compose, resizeComposer: resizeComposer, applyThemeToPasses: applyThemeToPasses,
    setupRenderer: setupRenderer, setExposure: setExposure,
    buildEnvironment: buildEnvironment,
    roundedBox: roundedBox, roundedBoxCached: roundedBoxCached
  };
})();
