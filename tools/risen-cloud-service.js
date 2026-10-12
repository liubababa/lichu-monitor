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
 *     GET /risen/devices            柜内子设备清单（BCU/PCS/电表/空调/4G，含在线状态）
 *     GET /risen/trend?range=today|yesterday|days3
 *                                   5 分钟粒度曲线：{ t, soc, power_kw, charge_kwh, discharge_kwh, pv_kw }
 *     GET /risen/raw                最近一次原始返回（排查用）
 *     GET /risen/healthz            连通性、最近拉取时间、错误
 *     GET /risen/poll               立即拉一次
 *
 *   凭据：tools/risen.config.json（不进仓库），字段 accessToken / refreshToken /
 *   tenantId / plantId。服务会在 token 失效时用 refreshToken 换新的一对，
 *   并把新值写回该文件；refreshToken 也过期后，需要用浏览器登录一次再导出
 *   （tools/risen-cloud-token.js）。
 *
 *   用法：node tools/risen-cloud-service.js [--port 8097] [--poll 300] [--dir logs/risen]
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

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
  poll: parseInt(arg('poll', process.env.RISEN_POLL || '300'), 10),   // 秒；云端记录本身 5 分钟一条
  plantId: arg('plant', process.env.RISEN_PLANT_ID || ''),
  days: parseInt(arg('days', process.env.RISEN_DAYS || '3'), 10)
};
const API_BASE = OPT.base.replace(/\/+$/, '') + '/admin-api';

fs.mkdirSync(OPT.dir, { recursive: true });

const state = {
  token: null, plants: [], plant: null, binding: null, snap: null,
  things: [], stats: null, storage: null, revenue: null, fault: null, alarms: null,
  polls: 0, errors: 0, last: null, lastError: null, raw: {}
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
  if (!cfg.accessToken) throw new Error('没有 accessToken：请把 tools/risen.config.json 补好');
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
      log('token 续期失败：' + e.message + '（需要用浏览器登录一次再导出，见 tools/risen-cloud-token.js）');
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
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
async function poll() {
  state.polls++;
  try {
    /* 1. 电站 */
    const pl = await call('/station/gcc/plant/all/list', { plantState: '', column: 'start_time', ascFlag: 'false', pageSize: 10, pageNo: 1 });
    state.plants = (pl && pl.list) || [];
    const cfg = loadCfg();
    state.plant = cfg.plantId
      ? state.plants.filter(function (p) { return String(p.id) === String(cfg.plantId); })[0]
      : state.plants[0];
    if (!state.plant) throw new Error('账号下没有可见电站（或 plantId 填错）');
    state.raw.plants = pl;

    /* 2. 这台柜子（EMS 主设备） */
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
    state.raw.binding = bl;
    const sn = bind.deviceCode;

    /* 3. 子设备 + 实时快照 + 统计 + 曲线上游 */
    const [things, latest, stats, storage, revenue, fault, alarms] = await Promise.all([
      call('/station/iot/ems/thing/list/' + sn, { sn: sn }),
      call('/station/system/binding/history', { pageNo: 1, pageSize: 1, type: 0, dataType: 'EMS', deviceCode: sn }),
      call('/station/home/plant/statistics'),
      call('/station/home/storage/power/stats'),
      call('/station/home/revenue/information'),
      call('/station/home/plant/device/fault'),
      call('/station/home/plant/alarm/count')
    ]);
    state.things = things || [];
    state.snap = ((latest && latest.list) || [])[0] || null;
    state.stats = stats || null;
    state.storage = storage || null;
    state.revenue = revenue || null;
    state.fault = fault || null;
    state.alarms = Number(alarms) || 0;
    state.raw = { plant: state.plant, binding: bind, snapshot: state.snap, things: state.things, stats: state.stats, storage: state.storage, revenue: state.revenue, fault: state.fault, alarms: state.alarms };

    /* 4. 今天的 5 分钟曲线（顺带把当天历史补齐） */
    const trend = await pullTrend(sn, 'today').catch(function (e) { log('曲线拉取失败：' + e.message); return []; });
    state.trend = trend;

    fs.appendFileSync(dayFile(Date.now()), JSON.stringify({
      t: Date.now(), plant: state.plant, snapshot: state.snap, things: state.things,
      stats: state.stats, storage: state.storage, revenue: state.revenue, trend: trend.length
    }) + '\n');

    state.last = new Date().toISOString();
    state.lastError = null;
    log('拉取成功：' + state.plant.plantName + '　SOC ' + (state.snap ? state.snap.totalSoc : '--') +
      '%　' + statusText(state.snap ? state.snap.energyStorageStatus : null) +
      '　曲线 ' + trend.length + ' 点');
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
  return state.things.map(function (t) {
    return {
      name: t.name,
      kind: t.kind,
      status: t.workStatus,
      status_text: workStatusText(t.workStatus),
      model: t.model || null,
      version: t.version || null,
      sn: b.deviceCode || null,
      iot_id: t.iotDeviceId
    };
  });
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
        polls: state.polls, errors: state.errors,
        last_poll: state.last, last_error: state.lastError,
        dir: OPT.dir, poll_seconds: OPT.poll
      });
    }
    if (u.pathname === '/risen/summary') {
      if (!state.snap) await poll();
      return json({ ok: !!state.snap, data: summary(), last_error: state.lastError });
    }
    if (u.pathname === '/risen/devices') {
      if (!state.things.length) await poll();
      return json({ ok: !!state.things.length, data: deviceList(), last_error: state.lastError });
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
    if (u.pathname === '/risen/raw') return json({ ok: true, data: state.raw });
    if (u.pathname === '/risen/poll') { await poll(); return json({ ok: !state.lastError, last_error: state.lastError }); }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('risen cloud service\n  GET /risen/summary\n  GET /risen/devices\n  GET /risen/trend?range=today|yesterday|days3\n  GET /risen/raw\n  GET /risen/healthz\n  GET /risen/poll\n');
  } catch (e) {
    json({ ok: false, error: e.message }, 500);
  }
});

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
