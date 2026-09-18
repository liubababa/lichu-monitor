/* ============================================================
 * 高特协议 · 离线演示数据
 *
 * 用途：没有任何环境（不装 Node、不连 broker、没有真机）也能演示整套监控，
 *      适合带电脑外出与厂家/客户沟通时打开即看。
 * 做法：按协议文档的点位定义，往 GaoteService.state 里填一份合理的模拟数据，
 *      随后所有界面（设备总览大屏 / 3D 场景 / 下达表单）照常渲染，无需改动其它代码。
 * 触发：设备总览右上角「离线演示」按钮，或地址后加 ?demo=1
 * ============================================================ */
window.GaoteDemo = (function () {
  'use strict';

  let timer = null, on = false;

  /* 找到某维度下 key → 点号 的映射（大小写不敏感） */
  function indexMap(dim, isStatus) {
    const table = isStatus ? (window.GAOTE && GAOTE.status) : (window.GAOTE && GAOTE.points);
    const want = String(dim).toLowerCase();
    const out = {};
    if (!table) return out;
    Object.keys(table).forEach(function (d) {
      if (String(d).toLowerCase() !== want) return;
      table[d].forEach(function (p) { if (!(p.k in out)) out[p.k] = p; });
    });
    return out;
  }

  function put(dim, arr, clu, dev, model, pairs, isStatus) {
    const map = indexMap(dim, isStatus);
    if (!Object.keys(map).length) return;
    const key = String(dim).toLowerCase() + '|' + arr + '|' + clu + '|' + dev + '|' + (model || '');
    const b = GaoteService.state[key] || (GaoteService.state[key] = {
      _meta: { dim: dim, arr: String(arr), clu: String(clu), dev: String(dev), model: model || '', cls: isStatus ? 'status' : 'data', kind: 'rtg' }
    });
    b._t = Date.now();
    Object.keys(pairs).forEach(function (k) {
      const def = map[k];
      if (!def) return;
      const v = (typeof pairs[k] === 'function') ? pairs[k]() : pairs[k];
      b[def.i] = { v: v, def: def, key: k };
    });
  }

  const R = (b, p) => +(b + b * p * (Math.random() - 0.5)).toFixed(3);
  let t0 = Date.now();

  function wave(minutes, phase) {
    return Math.sin(((Date.now() - t0) % (minutes * 60000)) / (minutes * 60000) * Math.PI * 2 + (phase || 0));
  }
  /* 功率：负=充电 正=放电 */
  function power(scale) { return +(scale * wave(10)).toFixed(1); }
  function soc() { return +(78 + 10 * wave(45) - power(5) / 200).toFixed(1); }

  function fill() {
    const p = power(220);
    const s = Math.max(15, Math.min(96, soc()));
    const now = Math.floor(Date.now() / 1000);
    const N = 5, CELLS = 8;

    /* 系统总览 */
    put('emu', '', '', '', '', {
      PCSSumsActivePower: p, PCSSumsReactivePower: R(8, .5), DCBusVol: R(715, .01),
      DCBusVur: +(p / 0.71).toFixed(1), SumsSOC: s, CellSums: N * CELLS,
      BatteryAverageTem: +(27 + Math.random()).toFixed(1), BatteryMaxTemDif: 4.2,
      MaxCellVol: 3.312, MinCellVol: 3.245, MaxAllowChargPower: 250, MinAllowChargPower: 250,
      ControlSrc: 1, EmuEnChgCap: +(150 + 40 * Math.random()).toFixed(0), EmuEnDisCap: +(120 + 40 * Math.random()).toFixed(0),
      EmuModCod: 2, SysStatus: 0, RunStatus: Math.abs(p) < 3 ? 0 : (p < 0 ? 1 : 2), Ts: now
    });
    /* 网关 / 本体 */
    put('t4GInfo', '', '', '', '', {
      SimCard: '已插入', Mfrs: 'SIMCOM', PML: 'A7670C', Firmware: 'V1.2.3',
      ICCID: '89860121802209000000', NETWORK_TYPE: 'LTE', CSQ_PER: 82, Ip: '10.12.33.7', Ts: now
    });
    put('ems', '', '', '', '', {
      Model_Version: 'EMS-125K261K', Devsid: 'R250907J0038', EMSversion: 'V1.7.5',
      CcuId: '89860121802209000000', TimeZone: 'Asia/Shanghai'
    });

    for (let i = 0; i < N; i++) {
      const pa = +(p / N).toFixed(1);
      const socI = Math.max(12, Math.min(97, s + (i - 2) * 1.2));
      put('array', i, -1, 0, '', {
        arrno: i, arrStatus: Math.abs(pa) < 1 ? 0 : 1, cluSums: 1,
        arrVol: R(710 + i, .004), arrCur: +(pa / 0.71).toFixed(1), arrSOC: +socI.toFixed(1), arrSOH: 99,
        CellVolDif: R(0.06, .3), maxCellVol: 3.312, minCellVol: 3.245,
        CellTemDif: R(4.5, .2), maxCellTem: Math.round(30 + i * .4), minCellTem: 26,
        arrMaxReChaPower: 120, arrMaxReDischgPower: 120, Ts: now
      });
      put('cluster', i, -1, 0, '', {
        cluSoc: +socI.toFixed(1), clusoh: 99, cluStatus: Math.abs(pa) < 1 ? 0 : (pa < 0 ? 2 : 1),
        cluVol: R(710 + i, .004), cluCur: +(pa / 0.71).toFixed(1),
        maxCellVol: 3.312, minCellVol: 3.245, maxCellTem: Math.round(30 + i * .4), minCellTem: 26,
        maxCellVolCellNum: 102, maxCellTemCellNum: 48, minCellVolCellNum: 11, minCellTemCellNum: 7,
        cluPosres: Math.round(R(5200, .06)), cluNegres: Math.round(R(5100, .06)),
        cluRtPower: pa, cluSumsChaElec: 52341, cluSumsDischgElec: 48112,
        cludaychg_cap: +(120 + i * 3 + Math.random() * 20).toFixed(1),
        cludaydis_cap: +(98 + i * 3 + Math.random() * 18).toFixed(1), Ts: now
      });
      put('pcs', i, -1, 0, '', {
        dc_pow: +(pa * .98).toFixed(1), dc_cur: +(pa / .71).toFixed(1),
        ac_uw_vol: R(233, .01), ac_vw_vol: R(235, .01), ac_wu_vol: R(231, .01),
        ac_u_pow_p: +(pa / 3).toFixed(1), ac_v_pow_p: +(pa / 3).toFixed(1), ac_w_pow_p: +(pa / 3).toFixed(1),
        ac_pow_p: pa, ac_pow_q: R(8, .4), ac_pow_s: +(Math.abs(pa) + 6).toFixed(1), ac_pow_pf: .998,
        grd_f: +(50 + (Math.random() - .5) * .04).toFixed(2), igbt_temp: R(38, .08), env_temp: 26,
        battery_voltage: R(710, .004), battery_current: +(pa / .71).toFixed(1),
        run_sta: Math.abs(pa) < 1 ? 5 : 257, offgrd_sta: 0,
        chgday_cap: 120.5, disday_cap: 98.2, comchgday_cap: 1260 + i * 4, comdisday_cap: 1010 + i * 3, Ts: now
      });
      put('liqcool', i, -1, 0, 'blackshields-comm-g1', {
        liq_pump_status: 1, liq_coldsta: 1, liq_hotsta: 0,
        liqhot_water_tmp: R(24.6, .04), liqinlet_water_tmp: R(28.9, .04),
        liqhydraulic_pressure: R(2.1, .05), liqinlet_water_pre: R(2.4, .05),
        liq_outtmp: R(26, .05), alarm_sta: 0, current_mod: 2,
        pump_target_speed: Math.round(R(2100, .08)), Ts: now
      });
      put('drier', i, -1, 0, 'sanda-sdcs-v5', {
        time_tem: Math.round(R(27, .1)), time_wet: Math.round(R(55, .15)),
        drier_wholerun: 1, drier_hotsta: 0, Ts: now
      });
      put('fire', i, -1, 0, 'zhta-v1-v4', {
        fire_co: 2, fire_h2: 1, voc_con: 3, fire_smoke: 0, fire_temp: Math.round(R(26, .1)), Ts: now
      });
      /* 单体 */
      for (let c = 1; c <= CELLS; c++) {
        put('cell', i, -1, c, '', {
          CelVol: +(3.28 + 0.02 * Math.sin(c * .7 + i) + (Math.random() - .5) * .004).toFixed(3),
          CelTem: +(27 + 2 * Math.sin(c * .5) + Math.random()).toFixed(1),
          CelSOC: +socI.toFixed(1), CelSOH: 99, Ts: now
        });
      }
    }

    /* 电表：储能计量(AEMS) / 并网逆流(LEMS) */
    put('meter-aems-storage', -1, -1, 0, 'acrel-dtsd1352-model', {
      meter_f: 50.01, meter_a_vol: R(233, .01), meter_b_vol: R(235, .01), meter_c_vol: R(231, .01),
      meter_a_cur: +(Math.abs(p) / 3 / .233).toFixed(2), meter_b_cur: +(Math.abs(p) / 3 / .233).toFixed(2), meter_c_cur: +(Math.abs(p) / 3 / .233).toFixed(2),
      meter_a_p: +(p / 3).toFixed(1), meter_b_p: +(p / 3).toFixed(1), meter_c_p: +(p / 3).toFixed(1),
      meter_tot_p: p, meter_a_q: 4, meter_b_q: 4, meter_c_q: 4, meter_tot_q: 12,
      meter_tot_s: +(Math.abs(p) + 12).toFixed(1), meter_tot_pf: .998,
      meter_add_pos: 523411.2, meter_add_neg: 481122.9, meter_pt: 1, meter_ct: 1, Ts: now,
      /* 分时电量（kWh）：充电集中在谷/深谷，放电集中在尖/峰 —— 演示峰谷套利正收益 */
      meter_ver_pos: 39989.7, meter_hig_pos: 52341.2, meter_mid_pos: 132480.5, meter_low_pos: 186320.4, meter_dplow_pos: 162800.6,
      meter_ver_neg: 172480.3, meter_hig_neg: 186320.8, meter_mid_neg: 121040.2, meter_low_neg: 48210.6, meter_dplow_neg: 22180.5
    });
    put('meter-lems-antireflux', -1, -1, 1, 'acrel-adl400-v13', {
      meter_f: 50.01, meter_a_vol: R(234, .01), meter_b_vol: R(236, .01), meter_c_vol: R(232, .01),
      meter_a_cur: 427.35, meter_b_cur: 427.35, meter_c_cur: 427.35,
      meter_a_p: 286, meter_b_p: 287, meter_c_p: 285,
      meter_tot_p: +(p + 300).toFixed(1), meter_a_q: 15, meter_tot_q: 45.2,
      meter_tot_s: 302.4, meter_tot_pf: .989,
      meter_add_pos: 1258340.6, meter_add_neg: 982213.4, Ts: now
    });

    /* 遥信（状态）：给几个常见告警位，演示告警条与红灯 */
    put('pcs', 0, -1, 0, '', { run_sta: 257, offgrd_sta: 0 }, true);
    put('cluster', 0, -1, 0, '', { cluStatus: Math.abs(p) < 1 ? 0 : 2 }, true);
    put('liqcool', 0, -1, 0, 'blackshields-comm-g1', { alarm_sta: 0, Read_2: 1 }, true);
    put('fire', 0, -1, 0, 'zhta-v1-v4', { TempAlarm: 0, SmokeAlarm: 0, COAlarm: 0, H2Alarm: 0 }, true);
  }

  function refresh() {
    fill();
    if (window.GaoteView) GaoteView.update();
    if (window.GaoteScene3D) GaoteScene3D.update();
  }

  function start() {
    if (on) return;
    on = true;
    fill();
    timer = setInterval(refresh, 3000);
    if (window.GaoteView) GaoteView.update();
    if (window.GaoteScene3D) GaoteScene3D.update();
  }
  function stop() {
    on = false;
    if (timer) { clearInterval(timer); timer = null; }
  }
  function isOn() { return on; }

  /* 地址带 ?demo=1 时自动进入离线演示（不依赖页面初始化顺序） */
  if (/[?&]demo=1/.test(location.search)) {
    const boot = function () { if (!on) start(); };
    if (document.readyState === 'complete') setTimeout(boot, 600);
    else window.addEventListener('load', function () { setTimeout(boot, 600); });
  }

  return { start, stop, isOn, refresh };
})();
