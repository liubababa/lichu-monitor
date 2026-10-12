#!/usr/bin/env node
/* ============================================================
 * 洙边卫生院站 · 储能柜接入服务（东方日升「日升云」cloud.risen.com）
 *
 *   现场那台储能柜（EMS/金盾 SN 25050015，SYL 电池 + 恩玖 PCS）自己通过 4G
 *   把数据上报到日升云，所以这条链路不碰现场网络：本服务登录日升云，
 *   定时把电站/储能数据拉回来，落盘并转成页面用的字段。
 *
 *   对外接口（给页面用）：
 *     GET /risen/summary            电站 + 储能实时：SOC、状态、功率、今日充放、
 *                                   累计充放、温度、剩余电量、收益、子设备统计
 *     GET /risen/pcs                PCS 实时：三相电压电流、有功/无功/视在、频率、
 *                                   功率因数、环境与 IGBT 温度
 *     GET /risen/battery            电池簇 + 液冷空调：SOC/SOH/SOE、簇压簇流、
 *                                   单体电压温度极值（含编号）、进出水温度压力
 *     GET /risen/devices            柜内子设备（含量型号/版本/在线状态）
 *     GET /risen/full               上面全部 + 补传情况，一次拿全
 *     GET /risen/trend?range=today|yesterday|days3
 *                                   5 分钟粒度曲线：{ t, soc, power_kw, charge_kwh, discharge_kwh, pv_kw }
 *     GET /risen/revenue-trend?days=7   日粒度收益：{ date, storage, solar, total }
 *     GET /risen/power-trend?days=7     日粒度充放：{ date, charge, discharge, efficiency }
 *     GET /risen/raw                最近一次原始返回（排查用）
 *     GET /risen/healthz            连通性、最近拉取时间、错误
 *     GET /risen/poll               立即拉一次
 *
 *   拉取节奏：本柜实时（EMS 快照 / PCS / 电池簇+空调 / 子设备在线）按 --poll 秒
 *   一轮（默认 60 秒）；电站、统计、收益、曲线等变化慢的每 5 分钟一轮（慢轮询）。
 *   注意云端自己也是约 5 分钟记一条，所以 1 分钟拉到的常是同一个值 —— 好处是
 *   云端一更新我们 1 分钟内就能拿到。
 *
 *   凭据：tools/risen.config.json（不进仓库），字段 accessToken / refreshToken /
 *   tenantId / plantId，可选 username / password。
 *   · 平时用 refreshToken 自动续期，新值写回配置文件
 *   · refreshToken 过期后：有账号密码就自己重新登录（无需人工）
 *   · 没配账号密码才需要浏览器登录一次再导出（tools/risen-cloud-token.js）
 *
 *   用法：node tools/risen-cloud-service.js [--port 8097] [--poll 300] [--dir logs/risen]
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
}

const OPT = {
  base: arg('base', process.env.RISEN_BASE || 'https://cloud.risen.com'),
  cfgFile: arg('config', process.env.RISEN_CONFIG || path.join(ROOT, 'tools', 'risen.config.json')),
  host: arg('host', process.env.RISEN_HOST || '127.0.0.1'),
  port: parseInt(arg('port', process.env.RISEN_PORT || '8097'), 10),
  dir: arg('dir', process.env.RISEN_DIR || path.join(ROOT, 'logs', 'risen')),
  poll: parseInt(arg('poll', process.env.RISEN_POLL || '60'), 10),   // 秒；本柜实时 1 分钟一拉，聚合类 5 分钟一拉
  plantId: arg('plant', process.env.RISEN_PLANT_ID || ''),
  days: parseInt(arg('days', process.env.RISEN_DAYS || '3'), 10)
};
const API_BASE = OPT.base.replace(/\/+$/, '') + '/admin-api';

fs.mkdirSync(OPT.dir, { recursive: true });

const state = {
  token: null, plants: [], plant: null, binding: null, snap: null,
  things: [], subs: [], pcs: null, bcu: null, air: null, complete: null,
  stats: null, storage: null, revenue: null, fault: null, alarms: null, pemsStats: null,
  polls: 0, errors: 0, last: null, lastError: null, lastSlow: 0, slowRuns: 0, raw: {}
};
let refreshing = null;

function log(line) { console.log(new Date().toTimeString().slice(0, 8) + '  ' + line); }

/* ---------------- 凭据 ---------------- */
function loadCfg() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(OPT.cfgFile, 'utf8')); } catch (_) {}
  /* 续期后的凭据写在配置文件里，优先于环境变量里的种子值 */
  cfg.accessToken = cfg.accessToken || process.env.RISEN_ACCESS_TOKEN || '';
  cfg.refreshToken = cfg.refreshToken || process.env.RISEN_REFRESH_TOKEN || '';
  cfg.tenantId = cfg.tenantId || process.env.RISEN_TENANT_ID || '';
  cfg.username = cfg.username || process.env.RISEN_USERNAME || '';
  cfg.password = cfg.password || process.env.RISEN_PASSWORD || '';
  if (OPT.plantId) cfg.plantId = OPT.plantId;
  return cfg;
}
function saveCfg(cfg) {
  try {
    fs.writeFileSync(OPT.cfgFile, JSON.stringify(cfg, null, 2));
  } catch (e) { log('凭据写回失败：' + e.message); }
}

/* ---------------- 请求 ---------------- */
async function call(pathname, params, opt) {
  const cfg = loadCfg();
  if (!cfg.accessToken) {
    if (!(opt && opt.loginTried) && await login()) return call(pathname, params, { loginTried: true });
    throw new Error('没有 accessToken，自动登录也不可用（检查 RISEN_USERNAME / RISEN_PASSWORD）');
  }
  const url = new URL(API_BASE + pathname);
  Object.keys(params || {}).forEach(function (k) {
    if (params[k] !== undefined && params[k] !== null && params[k] !== '') url.searchParams.set(k, params[k]);
  });
  const res = await fetch(url, {
    headers: {
      'Authorization': 'Bearer ' + cfg.accessToken,
      'tenant-id': String(cfg.tenantId),
      'language': 'zh',
      'Client-TimeZone': 'Asia/Shanghai',
      'Accept': 'application/json, text/plain, */*'
    }
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  if (!json) throw new Error('返回非 JSON（HTTP ' + res.status + '）：' + text.slice(0, 160));
  /* token 失效：换一次再重试（401 / 提示刷新令牌无效） */
  if (!opt || !opt.retried) {
    const bad = res.status === 401 || json.code === 401 ||
      /刷新令牌|令牌|token/i.test(String(json.msg || ''));
    if (bad) {
      const ok = await refreshToken();
      if (ok) return call(pathname, params, { retried: true });
    }
  }
  if (json.code !== 200) throw new Error('接口 ' + pathname + ' 返回 ' + json.code + '：' + (json.msg || ''));
  return json.data;
}

async function refreshToken() {
  if (refreshing) return refreshing;
  refreshing = (async function () {
    const cfg = loadCfg();
    if (!cfg.refreshToken) return false;
    try {
      const url = new URL(API_BASE + '/system/auth/refresh-token');
      url.searchParams.set('refreshToken', cfg.refreshToken);
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'tenant-id': String(cfg.tenantId),
          'language': 'zh',
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/plain, */*'
        }
      });
      const json = await res.json();
      if (!json.data || !json.data.accessToken) throw new Error(json.msg || ('code ' + json.code));
      cfg.accessToken = json.data.accessToken;
      cfg.refreshToken = json.data.refreshToken || cfg.refreshToken;
      cfg.refreshedAt = new Date().toISOString();
      saveCfg(cfg);
      state.token = cfg.accessToken;
      log('token 已续期');
      return true;
    } catch (e) {
      state.lastError = 'token 续期失败：' + e.message;
      log('token 续期失败：' + e.message + '，改用账号密码重新登录');
      return await login();
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/* ---------------- 自动登录 ----------------
 * 登录接口是 /system/auth/login/decrypt：前端把密码用 AES 加密后提交，密钥写死在前端
 * bundle 里（dfrs7aa0290b15bc）。服务端不区分「解密失败」和「密码不对」，所以这里把几种
 * 常见方案依次试一遍，第一个成功的会记进配置文件（密码对的话通常第一次就成）。
 * 账号密码放 /etc/lichu-risen.env：RISEN_USERNAME / RISEN_PASSWORD。
 * ------------------------------------------------------------------ */
const LOGIN_KEY = Buffer.from('dfrs7aa0290b15bc', 'utf8');

function encEcb(text) {
  const c = crypto.createCipheriv('aes-128-ecb', LOGIN_KEY, null);
  return Buffer.concat([c.update(text, 'utf8'), c.final()]).toString('base64');
}
function encCbc(text, iv) {
  const c = crypto.createCipheriv('aes-128-cbc', LOGIN_KEY, iv);
  return Buffer.concat([c.update(text, 'utf8'), c.final()]).toString('base64');
}
/* CryptoJS 直接拿字符串当口令时的默认算法：EvpKDF(MD5) + 随机盐，密文带 "Salted__" 前缀 */
function encEvpKdf(text) {
  const salt = crypto.randomBytes(8);
  const md5 = b => crypto.createHash('md5').update(b).digest();
  let derived = Buffer.alloc(0), prev = Buffer.alloc(0);
  while (derived.length < 48) {
    prev = md5(Buffer.concat([prev, LOGIN_KEY, salt]));
    derived = Buffer.concat([derived, prev]);
  }
  const c = crypto.createCipheriv('aes-128-cbc', derived.slice(0, 16), derived.slice(16, 32));
  const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([Buffer.from('Salted__', 'utf8'), salt, body]).toString('base64');
}

const LOGIN_SCHEMES = [
  ['aes-128-ecb', encEcb],
  ['aes-128-cbc(密钥当IV)', t => encCbc(t, LOGIN_KEY)],
  ['aes-128-cbc(IV全0)', t => encCbc(t, Buffer.alloc(16, 0))],
  ['cryptojs口令模式', encEvpKdf]
];
const LOGIN_TYPES = ['uname', 'mobile'];

async function login() {
  const cfg = loadCfg();
  if (!cfg.username || !cfg.password) {
    log('没有账号密码，跳过自动登录（需要的话在 /etc/lichu-risen.env 里填 RISEN_USERNAME / RISEN_PASSWORD）');
    return false;
  }
  for (let i = 0; i < LOGIN_SCHEMES.length; i++) {
    const label = LOGIN_SCHEMES[i][0], enc = LOGIN_SCHEMES[i][1];
    for (let j = 0; j < LOGIN_TYPES.length; j++) {
      const type = LOGIN_TYPES[j];
      try {
        const res = await fetch(API_BASE + '/system/auth/login/decrypt', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'tenant-id': String(cfg.tenantId),
            'language': 'zh',
            'Accept': 'application/json, text/plain, */*'
          },
          body: JSON.stringify({
            loginType: type === 'mobile' ? 'sms' : 'uname',
            username: cfg.username, password: enc(cfg.password), type: type,
            mobile: '', mobileCode: '', rememberMe: true, tenantName: '', readed: true
          })
        });
        const json = await res.json();
        if (json.code === 200 && json.data && json.data.accessToken) {
          cfg.accessToken = json.data.accessToken;
          cfg.refreshToken = json.data.refreshToken || cfg.refreshToken;
          cfg.loginScheme = label + ' / type=' + type;
          cfg.loggedInAt = new Date().toISOString();
          saveCfg(cfg);
          state.token = cfg.accessToken;
          log('自动登录成功（' + cfg.loginScheme + '）');
          return true;
        }
        log('登录未通过：' + label + ' / type=' + type + ' → ' + (json.msg || json.code));
      } catch (e) {
        log('登录请求出错：' + label + ' → ' + e.message);
      }
      await new Promise(r => setTimeout(r, 1200));      /* 别把失败次数堆得太快 */
    }
  }
  log('自动登录所有方案都没通过 —— 先确认账号密码对不对（密码改过就更新 RISEN_PASSWORD 再重启服务）');
  return false;
}

/* ---------------- 接口探测（找数据用）----------------
 * node tools/risen-cloud-service.js --probe
 * 会把各接口的原始返回写到 <dir>/probe/*.json，并在终端打一行摘要。
 * ------------------------------------------------------------------ */
async function probe() {
  const dir = path.join(OPT.dir, 'probe');
  fs.mkdirSync(dir, { recursive: true });

  /* 先拉一次，拿到 plantId / SN */
  await poll();
  const cfg = loadCfg();
  const pid = state.plant ? state.plant.id : cfg.plantId;
  const sn = state.binding ? state.binding.deviceCode : '';
  const id = state.binding ? state.binding.id : '';
  log('探测用：plantId=' + pid + '　sn=' + sn + '　bindingId=' + id);

  const P = { plantId: pid, sn: sn, deviceCode: sn };
  const CASES = [
    ['pems_statistics', '/station/pems/detail/statistics', [{ plantId: pid }, { sn: sn }, {}]],
    ['pems_pcs', '/station/pems/detail/storage/pcs', [{ sn: sn }, { plantId: pid }, { deviceCode: sn }]],
    ['pems_bcu_air', '/station/pems/detail/storage/bcu/air', [{ sn: sn }, { plantId: pid }, { deviceCode: sn }]],
    ['pems_inverter', '/station/pems/detail/solar/inverter', [{ plantId: pid }, { sn: sn }]],
    ['ems_list', '/station/iot/ems/list/' + sn, [{ sn: sn }, {}]],
    ['ems_menu', '/station/iot/ems/menu/' + pid, [{}]],
    ['ems_subsn', '/station/iot/ems/subSnList', [{ plantId: pid }, { sn: sn }]],
    ['thing_list', '/station/iot/ems/thing/list/' + sn, [{ sn: sn }]],
    ['device_log', '/station/device/Log/page', [{ pageNo: 1, pageSize: 5, deviceCode: sn }, { pageNo: 1, pageSize: 5, sn: sn }]],
    ['history_complete_device', '/station/system/binding/history/complete/device', [{ sn: sn }, { deviceCode: sn }]],
    ['dataDirection', '/station/system/binding/dataDirection/list', [{ plantId: pid }, { sn: sn }]],
    ['revenue_kilowatt', '/station/home/plant/revenue/kilowatt', [{ type: 'STORAGE', queryType: 'DAY', plantId: pid }]],
    ['revenue_curve', '/station/home/plant/revenue/curve', [{ queryType: 'DAY', startTime: dayStartCN(0) + ' 00:00:00', endTime: fmtTime(new Date()), plantId: pid }]],
    ['power_curve_hour', '/station/home/plant/power/curve', [{ queryType: 'HOUR', startTime: dayStartCN(0) + ' 00:00:00', endTime: fmtTime(new Date()), plantId: pid }]],
    ['power_curve_day', '/station/home/plant/power/curve', [{ queryType: 'DAY', startTime: dayStartCN(-6) + ' 00:00:00', endTime: fmtTime(new Date()), plantId: pid }]],
    ['electricity_page', '/station/electricity/report/page', [{ pageNo: 1, pageSize: 5, plantId: pid }]],
    ['bind_detail', '/station/system/binding/detail/' + id, [{}]]
  ];

  for (const [name, pathname, paramSets] of CASES) {
    for (let k = 0; k < paramSets.length; k++) {
      const params = paramSets[k];
      const tag = name + (k ? '-' + k : '');
      try {
        const data = await call(pathname, params);
        const text = JSON.stringify(data);
        fs.writeFileSync(path.join(dir, tag + '.json'), text);
        let brief = text.slice(0, 180);
        if (Array.isArray(data)) brief = 'array(' + data.length + ') ' + JSON.stringify(data[0] || {}).slice(0, 150);
        else if (data && typeof data === 'object' && Array.isArray(data.list)) brief = 'page(total=' + data.total + ') ' + JSON.stringify(data.list[0] || {}).slice(0, 150);
        else if (data && typeof data === 'object') brief = 'keys[' + Object.keys(data).slice(0, 18).join(',') + '] ' + text.slice(0, 140);
        log(tag + '  ' + JSON.stringify(params) + '  → ' + text.length + 'B  ' + brief);
      } catch (e) {
        log(tag + '  ' + JSON.stringify(params) + '  → 失败：' + e.message);
      }
      await new Promise(r => setTimeout(r, 400));
    }
  }
  log('探测完成，结果在 ' + dir);
}

/* ---------------- 时间 ---------------- */
function fmtTime(d) {
  const p = n => String(n).padStart(2, '0');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(d).reduce(function (o, x) { o[x.type] = x.value; return o; }, {});
  return parts.year + '-' + parts.month + '-' + parts.day + ' ' + p(parts.hour === '24' ? 0 : Number(parts.hour)) + ':' + parts.minute + ':' + parts.second;
}
function dayStartCN(offsetDays) {
  const s = fmtTime(new Date()).slice(0, 10);
  const d = new Date(s + 'T00:00:00+08:00');
  d.setTime(d.getTime() + (offsetDays || 0) * 86400000);
  return fmtTime(d).slice(0, 10);
}

/* ---------------- 一次完整拉取 ---------------- */
let polling = null;
function poll() {
  /* 启动时的首拉和页面/自测请求可能撞在一起，这里保证同一时刻只有一次在跑 */
  if (polling) return polling;
  polling = doPoll().catch(function () {}).then(function (v) { polling = null; return v; });
  return polling;
}
async function doPoll() {
  state.polls++;
  const now = Date.now();
  /* 慢轮询：电站/统计/收益/曲线这些变化慢的，每 5 分钟拉一次；
     快的（本柜 EMS 快照、PCS、电池簇、子设备在线）每次轮询都拉 */
  const slow = !state.lastSlow || (now - state.lastSlow) > 240000;
  try {
    /* 1. 电站 + 这台柜子的绑定（慢轮询 / 首次） */
    if (slow || !state.binding) {
      const pl = await call('/station/gcc/plant/all/list', { plantState: '', column: 'start_time', ascFlag: 'false', pageSize: 10, pageNo: 1 });
      state.plants = (pl && pl.list) || [];
      const cfg = loadCfg();
      state.plant = cfg.plantId
        ? state.plants.filter(function (p) { return String(p.id) === String(cfg.plantId); })[0]
        : state.plants[0];
      if (!state.plant) throw new Error('账号下没有可见电站（或 plantId 填错）');

      const bl = await call('/station/system/binding/list', { pageNo: 1, pageSize: 10 });
      const list = (bl && bl.list) || [];
      let bind = list.filter(function (b) { return String(b.plantId) === String(state.plant.id); })[0] || list[0];
      if (!bind) throw new Error('电站下没有绑定的 EMS 设备');
      try {   /* bind/list 那条记录字段更全（BCU/PCS 品牌、运营商、各版本号） */
        const rich = await call('/station/system/binding/bind/list/' + state.plant.id);
        const r0 = (rich || [])[0];
        if (r0) bind = Object.assign({}, bind, r0);
      } catch (_) {}
      state.binding = bind;
    }
    const sn = state.binding.deviceCode;
    const pid = state.plant.id;

    /* 2. 快轮询：本柜实时数据（EMS 总览 / PCS / 电池簇+液冷空调 / 子设备在线） */
    const [latest, pcs, bcu, things] = await Promise.all([
      call('/station/system/binding/history', { pageNo: 1, pageSize: 1, type: 0, dataType: 'EMS', deviceCode: sn }),
      call('/station/pems/detail/storage/pcs', { plantId: pid }).catch(function (e) { log('PCS 读数失败：' + e.message); return null; }),
      call('/station/pems/detail/storage/bcu/air', { plantId: pid }).catch(function (e) { log('电池簇读数失败：' + e.message); return null; }),
      call('/station/iot/ems/thing/list/' + sn, { sn: sn }).catch(function () { return null; })
    ]);
    const snap = ((latest && latest.list) || [])[0];
    if (snap) state.snap = snap;
    if (pcs && pcs[0]) state.pcs = pcs[0];
    const bcuRow = bcu && bcu[0];
    if (bcuRow) { state.bcu = bcuRow; state.air = (bcuRow.air && bcuRow.air[0]) || null; }
    if (things) state.things = things;

    /* 3. 慢轮询：子设备型号版本 / 统计 / 收益 / 故障 / 今日曲线 / 补传情况 */
    if (slow) {
      const [subs, pemsStats, stats, storage, revenue, fault, alarms, comp, kilo] = await Promise.all([
        call('/station/iot/ems/list/' + sn, { sn: sn }).catch(function () { return null; }),
        call('/station/pems/detail/statistics', { sn: sn }).catch(function () { return null; }),
        call('/station/home/plant/statistics').catch(function () { return null; }),
        call('/station/home/storage/power/stats').catch(function () { return null; }),
        call('/station/home/revenue/information').catch(function () { return null; }),
        call('/station/home/plant/device/fault').catch(function () { return null; }),
        call('/station/home/plant/alarm/count').catch(function () { return null; }),
        call('/station/system/binding/history/complete/device', { sn: sn }).catch(function () { return null; }),
        call('/station/home/plant/revenue/kilowatt', { type: 'STORAGE', queryType: 'DAY' }).catch(function () { return null; })
      ]);
      if (subs) state.subs = subs;
      if (pemsStats) state.pemsStats = pemsStats;
      if (stats) state.stats = stats;
      if (storage) state.storage = storage;
      if (revenue) state.revenue = revenue;
      if (fault) state.fault = fault;
      if (alarms !== null) state.alarms = Number(alarms) || 0;
      if (comp) state.complete = comp;
      state.kilowatt = (kilo && kilo[0]) || state.kilowatt;
      state.trend = await pullTrend(sn, 'today').catch(function (e) { log('曲线拉取失败：' + e.message); return state.trend || []; });
      state.lastSlow = now;
      state.slowRuns++;
    }

    /* 4. 落盘：每分钟一条，含本柜全部实时数据 */
    fs.appendFileSync(dayFile(now), JSON.stringify({
      t: now,
      ems: state.snap,
      pcs: state.pcs,
      bcu: state.bcu,
      air: state.air,
      subs: state.subs,
      things: (state.things || []).map(function (t) { return { n: t.name, k: t.kind, s: t.workStatus }; }),
      stats: slow ? state.stats : undefined,
      storage: slow ? state.storage : undefined,
      revenue: slow ? state.revenue : undefined,
      fault: slow ? state.fault : undefined,
      complete: slow ? state.complete : undefined
    }) + '\n');

    state.last = new Date().toISOString();
    state.lastError = null;
    log('拉取成功：SOC ' + (state.snap ? state.snap.totalSoc : '--') + '%　' +
      statusText(state.snap ? state.snap.energyStorageStatus : null) +
      '　PCS ' + (state.pcs ? state.pcs.totalActivePower + 'kW' : '--') +
      '　电池簇 ' + (state.bcu ? state.bcu.clusterVoltage + 'V/' + state.bcu.clusterCurrent + 'A' : '--') +
      (slow ? '　[慢轮询 第' + state.slowRuns + '轮]' : ''));
  } catch (e) {
    state.errors++;
    state.lastError = e.message;
    log('拉取失败：' + e.message);
  }
}

function dayFile(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return path.join(OPT.dir, d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '.jsonl');
}

/* 5 分钟粒度的储能总览历史（云端一天约 288 条） */
async function pullTrend(sn, range) {
  const off = range === 'yesterday' ? -1 : (range === 'days3' ? -2 : 0);
  const from = dayStartCN(off);
  const to = fmtTime(new Date());
  const out = [];
  for (let page = 1; page <= 3; page++) {
    const d = await call('/station/system/binding/history', {
      pageNo: page, pageSize: 200, type: 0, dataType: 'EMS', deviceCode: sn,
      startTime: from + ' 00:00:00', endTime: to
    });
    const rows = (d && d.list) || [];
    rows.forEach(function (r) {
      const t = Date.parse(String(r.recordTime).replace(' ', 'T') + '+08:00');
      if (!isFinite(t)) return;
      out.push({
        t: t,
        soc: num(r.totalSoc),
        power_kw: num(r.totalActivePower),
        charge_kwh: num(r.dailyCharge),
        discharge_kwh: num(r.dailyDischarge),
        pv_kw: num(r.photovoltaicPower),
        grid_kw: num(r.gridPower),
        status: num(r.energyStorageStatus)
      });
    });
    const total = (d && d.total) || 0;
    if (!rows.length || page * 200 >= total) break;
  }
  return out.sort(function (a, b) { return a.t - b.t; });
}

/* ---------------- 字段整理 ---------------- */
function num(v) {
  if (v === null || v === undefined || v === '' || isNaN(Number(v))) return null;
  return Number(v);
}
function statusText(s) {
  const v = num(s);
  return v === 0 ? '待机' : v === 1 ? '放电' : v === 2 ? '充电' : '--';
}
function workStatusText(s) {
  return { HEALTHY: '正常', FAULT: '故障', ALARM: '告警', OFFLINE: '离线' }[s] || (s || '--');
}

function summary() {
  const p = state.plant || {};
  const s = state.snap || {};
  const r = state.revenue || {};
  const st = state.storage || {};
  const so = state.stats || {};
  const f = state.fault || {};
  const on = state.things.filter(function (t) { return t.workStatus === 'HEALTHY'; }).length;
  return {
    ok: !!state.snap,
    station: {
      name: p.plantName || null,
      no: p.plantNo || null,
      address: p.address || null,
      system_type: p.systemType || null,
      pv_capacity_kw: num(p.capacity),
      storage_capacity_kwh: num(p.installedCapacity),
      lat: num(p.latitude),
      lon: num(p.longitude),
      work_status: workStatusText(p.workStatus),
      today_pv_kwh: num(p.todayEnergy),
      equivalent_hour: num(p.equivalentHour)
    },
    device: state.binding ? {
      sn: state.binding.deviceCode,
      name: state.binding.deviceName,
      model: state.binding.deviceTypeCode,
      rated_power_kw: num(state.binding.ratedPower),
      bcu_brand: state.binding.bcuBrand || null,
      pcs_brand: state.binding.pcsBrand || null,
      master_version: state.binding.masterVersion || null,
      operator: state.binding.operator || null,
      online: num(state.binding.bingdingStatus) === 1
    } : null,
    realtime: {
      time: s.recordTime || null,
      status: num(s.energyStorageStatus),
      status_text: statusText(s.energyStorageStatus),
      soc: num(s.totalSoc),
      remaining_kwh: num(s.remainingPower),
      rated_kwh: num(s.ratedPower),
      power_kw: num(s.totalActivePower),
      grid_kw: num(s.gridPower),
      load_kw: num(s.loadPower),
      pv_kw: num(s.photovoltaicPower),
      voltage_v: num(s.totalVoltage),
      current_a: num(s.totalCurrent),
      temp_avg: num(s.averageTemperature),
      temp_max: num(s.maxTemperature),
      temp_min: num(s.minTemperature),
      warning: s.warning || '',
      fault: s.fault || ''
    },
    /* PCS 实时（/station/pems/detail/storage/pcs） */
    pcs: state.pcs ? {
      time: state.pcs.recordTime,
      work_status: workStatusText(state.pcs.workStatus),
      power_kw: num(state.pcs.totalActivePower),
      reactive_kvar: num(state.pcs.totalReactivePower),
      apparent_kva: num(state.pcs.totalApparentPower),
      freq_hz: num(state.pcs.gridFrequency),
      power_factor: num(state.pcs.powerFactor),
      volt_v: [num(state.pcs.av), num(state.pcs.bv), num(state.pcs.cv)],
      curr_a: [num(state.pcs.ai), num(state.pcs.bi), num(state.pcs.ci)],
      ambient_c: num(state.pcs.ambientTemperature),
      igbt_a_c: num(state.pcs.aigbtTemperature)
    } : null,
    /* 电池簇 + 液冷空调（/station/pems/detail/storage/bcu/air） */
    battery: state.bcu ? {
      time: state.bcu.recordTime,
      soc: num(state.bcu.soc),
      soh: num(state.bcu.soh),
      soe: num(state.bcu.soe),
      voltage_v: num(state.bcu.clusterVoltage),
      current_a: num(state.bcu.clusterCurrent),
      remaining_kwh: num(state.bcu.dischargingCapacity),
      rechargeable_kwh: num(state.bcu.rechargeableCapacity),
      cell_volt_avg_mv: num(state.bcu.averageVoltageCells),
      cell_volt_max_mv: num(state.bcu.maxVoltageCells),
      cell_volt_min_mv: num(state.bcu.minVoltageCells),
      cell_volt_max_id: state.bcu.maxVoltageCellsId || null,
      cell_volt_min_id: state.bcu.minVoltageCellsId || null,
      cell_temp_avg: num(state.bcu.averageTemperatureCells),
      cell_temp_max: num(state.bcu.maxTemperatureCells),
      cell_temp_min: num(state.bcu.minTemperatureCells),
      cell_temp_max_id: state.bcu.maxTemperatureCellsId || null,
      cell_temp_min_id: state.bcu.minTemperatureCellsId || null,
      cooler: state.air ? {
        time: state.air.recordTime,
        inlet_water_c: num(state.air.inletWaterTemperature),
        outlet_water_c: num(state.air.drainWaterTemperature),
        ambient_c: num(state.air.ambientTemperature),
        inlet_pressure: num(state.air.inletWaterPressure),
        outlet_pressure: num(state.air.drainWaterPressure),
        cooling_point: num(state.air.coolingPoint),
        heating_point: num(state.air.heatingPoint),
        fault_flag: num(state.air.faultFlag)
      } : null
    } : null,
    today: {
      charge_kwh: num(s.dailyCharge),
      discharge_kwh: num(s.dailyDischarge),
      pv_kwh: num(p.todayEnergy)
    },
    total: {
      charge_kwh: num(s.cumulativeCharge),
      discharge_kwh: num(s.cumulativeDischarge),
      efficiency: num(st.comprehensiveEfficiency)
    },
    stats: {
      remaining_power_kwh: num(so.remainingPower),
      storage_capacity_kwh: num(so.storageCapacity),
      pv_capacity_kw: num(so.photovoltaicCapacity)
    },
    revenue: {
      day: num(r.dayIncomeSum),
      total: num(r.totalIncomeSum),
      storage: num(r.totalStorageIncomeSum),
      solar: num(r.totalSolarIncomeSum),
      per_kwh: state.kilowatt ? num(state.kilowatt.storageKilowatt) : null,
      reduce_carbon_t: num(r.reduceCarbon),
      trees: num(r.equivalentTree),
      coal_t: num(r.savingStandardCoal)
    },
    devices: {
      total: state.things.length,
      normal: on,
      alarm: num(f.alarmNum) || 0,
      fault: num(f.faultNum) || 0,
      offline: state.things.length - on,
      alarms: state.alarms || 0
    },
    updated_at: state.last
  };
}

function deviceList() {
  const b = state.binding || {};
  /* /station/iot/ems/list 里有型号/版本（EJ=恩玖 PCS、SYL=电池、YWK=英维克空调） */
  const subsByKind = {};
  (state.subs || []).forEach(function (s) { if (s.kind && !subsByKind[s.kind]) subsByKind[s.kind] = s; });
  const out = (state.things || []).map(function (t) {
    const s = subsByKind[t.kind] || {};
    return {
      name: t.name,
      kind: t.kind,
      status: t.workStatus,
      status_text: workStatusText(t.workStatus),
      brand: s.type || null,
      version: s.version ? String(s.version).split('\r\n')[0] : null,
      model: t.model || null,
      sn: b.deviceCode || null,
      iot_id: t.iotDeviceId
    };
  });
  /* 柜子里还有 3 台光伏逆变器，thing/list 里没有，从 ems/list 补上 */
  (state.subs || []).forEach(function (s) {
    if (s.kind !== 'INVERTER') return;
    out.push({
      name: s.name, kind: s.kind, status: s.workStatus, status_text: workStatusText(s.workStatus),
      brand: s.type || null, version: s.version ? String(s.version).split('\r\n')[0] : null,
      model: null, sn: b.deviceCode || null, iot_id: null
    });
  });
  return out;
}

/* ---------------- 保留天数 ---------------- */
function prune() {
  const cutoff = new Date(fmtTime(new Date()).slice(0, 10) + 'T00:00:00+08:00').getTime() - (OPT.days - 1) * 86400000;
  fs.readdirSync(OPT.dir).forEach(function (f) {
    const m = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(f);
    if (!m) return;
    const t = Date.parse(m[1] + '-' + m[2] + '-' + m[3] + 'T00:00:00+08:00');
    if (t < cutoff) { try { fs.unlinkSync(path.join(OPT.dir, f)); } catch (_) {} }
  });
}

/* ---------------- HTTP ---------------- */
const server = http.createServer(async function (req, res) {
  const u = new URL(req.url, 'http://localhost');
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', '*');
  res.setHeader('cache-control', 'no-store');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const json = function (obj, code) {
    res.writeHead(code || 200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  try {
    if (u.pathname === '/risen/healthz') {
      return json({
        ok: !state.lastError,          /* 刚重启时还没拉过，但也没出错 —— 也算健康 */
        base: OPT.base, plant_id: state.plant ? state.plant.id : (loadCfg().plantId || null),
        device_sn: state.binding ? state.binding.deviceCode : null,
        polls: state.polls, errors: state.errors, slow_runs: state.slowRuns,
        last_poll: state.last, last_error: state.lastError, poll_seconds: OPT.poll,
        dir: OPT.dir
      });
    }
    if (u.pathname === '/risen/summary') {
      if (!state.snap) await poll();
      return json({ ok: !!state.snap, data: summary(), last_error: state.lastError });
    }
    if (u.pathname === '/risen/pcs') {
      if (!state.pcs) await poll();
      return json({ ok: !!state.pcs, data: summary().pcs, last_error: state.lastError });
    }
    if (u.pathname === '/risen/battery') {
      if (!state.bcu) await poll();
      return json({ ok: !!state.bcu, data: summary().battery, last_error: state.lastError });
    }
    if (u.pathname === '/risen/devices') {
      if (!state.things.length) await poll();
      return json({ ok: !!state.things.length, data: deviceList(), last_error: state.lastError });
    }
    /* 一次给全：总览 + PCS + 电池簇/空调 + 子设备 + 补传情况 */
    if (u.pathname === '/risen/full') {
      if (!state.snap) await poll();
      const sm = summary();
      return json({
        ok: !!state.snap,
        data: Object.assign({}, sm, {
          devices: deviceList(),
          pems_stats: state.pemsStats || null,
          complete: state.complete || null,
          trend_points: (state.trend || []).length
        }),
        last_error: state.lastError
      });
    }
    if (u.pathname === '/risen/trend') {
      const range = u.searchParams.get('range') || 'today';
      let pts = state.trend || [];
      if (range !== 'today' || !pts.length) {
        if (!state.binding) await poll();
        if (state.binding) pts = await pullTrend(state.binding.deviceCode, range);
      }
      return json({ ok: true, range: range, points: pts });
    }
    /* 日粒度收益曲线（近 N 天）：{date, storage, solar, total} */
    if (u.pathname === '/risen/revenue-trend') {
      const days = Math.max(1, Math.min(30, parseInt(u.searchParams.get('days') || '7', 10)));
      const pid = state.plant ? state.plant.id : loadCfg().plantId;
      const d = await call('/station/home/plant/revenue/curve', {
        queryType: 'DAY', plantId: pid,
        startTime: dayStartCN(-(days - 1)) + ' 00:00:00', endTime: fmtTime(new Date())
      });
      return json({
        ok: true, days: days,
        points: (d || []).map(function (x) {
          return { date: x.xset, storage: num(x.storageProfit), solar: num(x.solarProfit), total: num(x.totalProfit) };
        })
      });
    }
    /* 日粒度充放电曲线（近 N 天）：{date, charge, discharge, efficiency} */
    if (u.pathname === '/risen/power-trend') {
      const days = Math.max(1, Math.min(30, parseInt(u.searchParams.get('days') || '7', 10)));
      const pid = state.plant ? state.plant.id : loadCfg().plantId;
      const d = await call('/station/home/plant/power/curve', {
        queryType: 'DAY', plantId: pid,
        startTime: dayStartCN(-(days - 1)) + ' 00:00:00', endTime: fmtTime(new Date())
      });
      return json({
        ok: true, days: days,
        points: (d || []).map(function (x) {
          return { date: x.xset, charge: num(x.powerCharge), discharge: num(x.powerConsume), efficiency: num(x.efficiency) };
        })
      });
    }
    if (u.pathname === '/risen/raw') return json({ ok: true, data: state.raw });
    if (u.pathname === '/risen/poll') { await poll(); return json({ ok: !state.lastError, last_error: state.lastError }); }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('risen cloud service\n  GET /risen/summary\n  GET /risen/pcs\n  GET /risen/battery\n  GET /risen/devices\n  GET /risen/full\n  GET /risen/trend?range=today|yesterday|days3\n  GET /risen/revenue-trend?days=7\n  GET /risen/power-trend?days=7\n  GET /risen/raw\n  GET /risen/healthz\n  GET /risen/poll\n');
  } catch (e) {
    json({ ok: false, error: e.message }, 500);
  }
});

/* ---------------- 启动 ---------------- */
if (argv.indexOf('--probe') >= 0) {
  /* 摸接口用：把各接口的原始返回写到 <dir>/probe/，不启服务 */
  probe().then(function () { process.exit(0); })
    .catch(function (e) { console.error('探测失败：' + e.message); process.exit(1); });
} else if (argv.indexOf('--login') >= 0) {
  /* 只测一次自动登录，不启服务：node tools/risen-cloud-service.js --login */
  login().then(function (ok) {
    console.log(ok ? '自动登录可用' : '自动登录失败');
    process.exit(ok ? 0 : 1);
  });
} else {
  prune();
  setInterval(prune, 3600000);
  setInterval(function () { poll().catch(function () {}); }, OPT.poll * 1000);
  server.listen(OPT.port, OPT.host, function () {
    const cfg = loadCfg();
    log('日升云接入服务已启动：http://' + OPT.host + ':' + OPT.port + '　数据目录 ' + OPT.dir +
      '　拉取周期 ' + OPT.poll + 's' + (cfg.accessToken ? '' : '　⚠ 缺 accessToken'));
    poll().catch(function () {});
  });
  server.on('error', function (e) { log('监听失败：' + e.message); process.exit(1); });
  process.on('SIGTERM', function () { server.close(function () { process.exit(0); }); });
  process.on('SIGINT', function () { server.close(function () { process.exit(0); }); });
}
