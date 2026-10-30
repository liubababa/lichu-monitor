#!/usr/bin/env node
/* ============================================================
 * 阳光电源 iSolarCloud 接入服务
 *
 *   1) OAuth2 授权：GET /solar/authorize → 跳阳光授权页 → /solar/callback 收码换 token
 *   2) 定时拉取：每 5 分钟拉电站实时点位 + 设备列表/状态，另按增量拉分钟级历史，落盘
 *   3) 对外接口（给页面用，字段统一）：
 *        GET /solar/summary      当日/累计发电、实时功率、装机、状态、更新时间
 *        GET /solar/devices      设备列表（类型/SN/状态/关键指标）
 *        GET /solar/trend        功率曲线（today | yesterday | daysN；长区间自动降采样）
 *        GET /solar/healthz      连通性、最近拉取时间、错误
 *   4) 发电趋势缓存：每次拉取把那批曲线点归一化成 kW / kWh 后并进 <dir>/trend/<日期>.jsonl
 *      （一点一行 {t, power_kw, daily_yield_kwh, total_yield_kwh}，按 t 去重排序、整文件原子重写）。
 *      它和原始轮询日文件分家：原始文件只留 --days 天（默认 3，体积大），
 *      趋势缓存留 --trend-days 天（默认 400，一天约 26KB）——曲线不会再跟着原始日志被删掉；
 *      页面取趋势只读这份缓存，缺的日子才回退翻原始日志，也不额外打阳光接口。
 *   凭据来自环境变量（部署时写 /etc/lichu-solar.env，600，不进仓库）
 *
 *   用法：node solar-service.js --listen 8096 --dir /var/lib/lichu-solar [--trend-days 400]
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
}

/* 中国区网关与授权站（门户里给出的授权 URL 用的是 web3.isolarcloud.com.cn） */
const REGION = {
  cn: { gateway: 'https://gateway.isolarcloud.com', auth: 'https://web3.isolarcloud.com.cn', cloudId: 1 },
  intl: { gateway: 'https://gateway.isolarcloud.com.hk', auth: 'https://web3.isolarcloud.com.hk', cloudId: 2 },
  eu: { gateway: 'https://gateway.isolarcloud.eu', auth: 'https://web3.isolarcloud.eu', cloudId: 3 }
};

const OPT = {
  appkey: arg('appkey', process.env.SOLAR_APPKEY || ''),
  secret: arg('secret', process.env.SOLAR_SECRET || ''),
  appid: arg('appid', process.env.SOLAR_APPID || ''),
  region: arg('region', process.env.SOLAR_REGION || 'cn'),
  psId: arg('ps', process.env.SOLAR_PS_ID || ''),
  redirect: arg('redirect', process.env.SOLAR_REDIRECT || 'https://mqtt.ykdesign.top/solar/callback'),
  listen: parseInt(arg('listen', process.env.SOLAR_PORT || '8096'), 10),
  dir: arg('dir', process.env.SOLAR_DIR || path.join(__dirname, '..', 'logs', 'solar')),
  poll: parseInt(arg('poll', process.env.SOLAR_POLL || '300'), 10),      // 拉取周期（秒），阳光数据 5 分钟一更
  days: parseInt(arg('days', process.env.SOLAR_DAYS || '3'), 10),        // 原始轮询日文件保留天数
  trendDays: parseInt(arg('trend-days', process.env.SOLAR_TREND_DAYS || '400'), 10)   // 发电趋势缓存保留天数
};
const GW = (REGION[OPT.region] || REGION.cn).gateway;
const AUTH_HOST = (REGION[OPT.region] || REGION.cn).auth;
const CLOUD_ID = (REGION[OPT.region] || REGION.cn).cloudId;

fs.mkdirSync(OPT.dir, { recursive: true });
const TOKEN_FILE = path.join(OPT.dir, 'tokens.json');

/* 我们关心的电站级点位（阳光的点位号，见开发者门户点位表） */
const POINTS = {
  '83022': 'daily_yield',            // 当日发电量 Wh
  '83024': 'total_yield',            // 累计发电量 Wh
  '83033': 'power',                  // 实时功率 W
  '83019': 'power_fraction',         // 功率/装机比
  '83005': 'daily_hours',            // 当日等效小时 h
  '83016': 'ambient_temp',           // 环境温度 ℃
  '83017': 'module_temp',            // 组件温度 ℃
  '83012': 'radiation',              // 辐照 W/㎡
  '83013': 'daily_irradiation'       // 当日辐照 Wh/㎡
};

const state = { last: null, lastError: null, polls: 0, errors: 0, devices: [], summary: null };
function log(line) { console.log(new Date().toTimeString().slice(0, 8) + '  ' + line); }

/* ---------------- token ---------------- */
function loadTokens() { try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch (_) { return null; } }
function saveTokens(t) { fs.writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2), { mode: 0o600 }); }

async function api(pathname, params, opt) {
  const tk = loadTokens();
  if (!tk || !tk.access_token) throw new Error('尚未授权（请先访问 /solar/authorize）');
  const body = Object.assign({}, params, { appkey: OPT.appkey, lang: '_zh_CN' });
  const res = await fetch(GW + pathname, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-access-key': OPT.secret,
      'authorization': 'Bearer ' + tk.access_token
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  if (!json) throw new Error('返回非 JSON：' + text.slice(0, 200));
  /* 令牌失效 → 刷新一次重试 */
  if (json.result_code && json.result_code !== '1' && /token|授权|auth/i.test(JSON.stringify(json.error || json))) {
    if (!opt || !opt.retried) {
      const ok = await refreshToken();
      if (ok) return api(pathname, params, { retried: true });
    }
  }
  if (json.result_code && json.result_code !== '1') {
    throw new Error('接口返回错误：' + JSON.stringify(json).slice(0, 300));
  }
  return json;
}

async function fetchToken(code) {
  const body = { appkey: OPT.appkey, code: code, grant_type: 'authorization_code', redirect_uri: OPT.redirect };
  log('换取 token：code len=' + String(code).length + ' redirect=' + OPT.redirect);
  const res = await fetch(GW + '/openapi/apiManage/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-access-key': OPT.secret },
    body: JSON.stringify(body)
  });
  const raw = await res.text();
  let json = null;
  try { json = JSON.parse(raw); } catch (_) {}
  log('token 响应 http=' + res.status + (json && json.access_token ? '（已获取 token，内容省略）'
    : (' ' + raw.slice(0, 120))));
  if (!json || !json.access_token) throw new Error('换取 token 失败：' + raw.slice(0, 300));
  const tk = {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + (Number(json.expires_in) || 3600) - 30,
    got_at: new Date().toISOString()
  };
  saveTokens(tk);
  log('授权成功，token 已保存');
  return tk;
}

let refreshTask = null;
/* 三路并发遇到 token 过期时只刷新一次，避免刷新令牌互相踩 */
function refreshToken() {
  if (!refreshTask) {
    refreshTask = doRefreshToken()
      .then(function (ok) { return ok; }, function () { return false; })
      .finally(function () { refreshTask = null; });
  }
  return refreshTask;
}

async function doRefreshToken() {
  const tk = loadTokens();
  if (!tk || !tk.refresh_token) return false;
  try {
    const res = await fetch(GW + '/openapi/apiManage/refreshToken', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-access-key': OPT.secret },
      body: JSON.stringify({ appkey: OPT.appkey, refresh_token: tk.refresh_token })
    });
    const json = await res.json();
    if (!json.access_token) throw new Error(JSON.stringify(json).slice(0, 200));
    saveTokens({
      access_token: json.access_token,
      refresh_token: json.refresh_token || tk.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + (Number(json.expires_in) || 3600) - 30,
      got_at: new Date().toISOString()
    });
    log('token 已续期');
    return true;
  } catch (e) {
    state.lastError = '续期失败：' + e.message;
    log('token 续期失败：' + e.message);
    return false;
  }
}

async function ensureToken() {
  const tk = loadTokens();
  if (!tk) return false;
  if (tk.expires_at && tk.expires_at < Math.floor(Date.now() / 1000)) await refreshToken();
  return true;
}

/* ---------------- 数据 ---------------- */
function dayFile(ms) {
  const d = new Date(ms);
  const p = function (n) { return String(n).padStart(2, '0'); };
  return path.join(OPT.dir, d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '.jsonl');
}

/* ---------------- 发电趋势缓存 ----------------
   一点一行 {t, power_kw, daily_yield_kwh, total_yield_kwh}，按 t 去重、排序、整文件原子重写。
   保留期由 OPT.trendDays 管（默认 400 天），和原始轮询日文件（OPT.days，默认 3 天）分家 */
function trendDir() {
  const d = path.join(OPT.dir, 'trend');
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  return d;
}
function trendFile(ms) {
  const d = new Date(ms);
  const p = function (n) { return String(n).padStart(2, '0'); };
  return path.join(trendDir(), d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '.jsonl');
}
/* 接口原始点位（W / Wh）与快照点位都收成 kW / kWh 的统一形状 */
function normPoint(raw) {
  if (!raw || !isFinite(raw.t)) return null;
  const o = { t: raw.t };
  const pk = (raw.power_kw !== undefined) ? Number(raw.power_kw)
    : (raw.power !== undefined ? Number(raw.power) / 1000 : undefined);
  if (pk !== undefined && isFinite(pk)) o.power_kw = +pk.toFixed(3);
  const dy = (raw.daily_yield_kwh !== undefined) ? Number(raw.daily_yield_kwh)
    : (raw.daily_yield !== undefined ? Number(raw.daily_yield) / 1000 : undefined);
  if (dy !== undefined && isFinite(dy)) o.daily_yield_kwh = +dy.toFixed(3);
  const ty = (raw.total_yield_kwh !== undefined) ? Number(raw.total_yield_kwh)
    : (raw.total_yield !== undefined ? Number(raw.total_yield) / 1000 : undefined);
  if (ty !== undefined && isFinite(ty)) o.total_yield_kwh = +ty.toFixed(3);
  return o;
}
/* 趋势点清洗：
   1) 只保留 5 分钟整点（历史接口的点）；实时快照（:2x/:3x）一律丢弃，
      它比历史慢一个周期，混进来就是锯齿/累计回退的根因；
   2) 凌晨 5 点前的日发电量不可能是全天值（0 点刚过还在报前一天），压成 0；
   3) 同一天内 total_yield / daily_yield 只允许递增，回退点压平到前一个值。
   返回 { list, dropped, fixed }，便于启动清理时统计。 */
function sanitizeTrend(input) {
  const list = (input || []).filter(function (o) { return o && isFinite(o.t); })
    .sort(function (a, b) { return a.t - b.t; });
  const out = [];
  let maxTotal = null, maxDaily = null, dropped = 0, fixed = 0;
  list.forEach(function (o) {
    if (o.t % 300000 !== 0) { dropped++; return; }
    const d = new Date(o.t);
    const h = d.getHours() + d.getMinutes() / 60;
    if (o.daily_yield_kwh != null && h < 5 && o.daily_yield_kwh > 10) { o.daily_yield_kwh = 0; fixed++; }
    if (o.total_yield_kwh != null) {
      if (maxTotal != null && o.total_yield_kwh < maxTotal) { o.total_yield_kwh = maxTotal; fixed++; }
      maxTotal = o.total_yield_kwh;
    }
    if (o.daily_yield_kwh != null) {
      if (maxDaily != null && o.daily_yield_kwh < maxDaily) { o.daily_yield_kwh = maxDaily; fixed++; }
      maxDaily = o.daily_yield_kwh;
    }
    out.push(o);
  });
  return { list: out, dropped: dropped, fixed: fixed };
}
/* 把一批点并进一个日文件；按 t 去重、清洗后原子重写。返回文件点数 */
function mergeTrendFile(f, list) {
  const map = {};
  try {
    fs.readFileSync(f, 'utf8').split('\n').forEach(function (line) {
      if (!line) return;
      try { const o = JSON.parse(line); if (o && isFinite(o.t)) map[o.t] = o; } catch (_) {}
    });
  } catch (_) {}
  list.forEach(function (o) { map[o.t] = Object.assign(map[o.t] || {}, o); });
  const clean = sanitizeTrend(Object.keys(map).map(function (k) { return map[k]; }));
  if (!clean.list.length) { try { fs.unlinkSync(f); } catch (_) {} return 0; }
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, clean.list.map(function (o) { return JSON.stringify(o); }).join('\n') + '\n');
  fs.renameSync(tmp, f);
  return clean.list.length;
}
/* 把这批曲线点按各自的日期并进趋势文件；返回写入的点数 */
function saveTrend(pts) {
  const list = (pts || []).map(normPoint).filter(Boolean);
  if (!list.length) return 0;
  const byDay = {};
  list.forEach(function (o) {
    const d = new Date(o.t); d.setHours(0, 0, 0, 0);
    const k = d.getTime();
    (byDay[k] = byDay[k] || []).push(o);
  });
  let n = 0;
  Object.keys(byDay).forEach(function (k) { n += mergeTrendFile(trendFile(Number(k)), byDay[k]); });
  return n;
}
/* 读趋势缓存（按天文件名取，读的是 [from, to] 里的点） */
function readTrendCache(fromMs, toMs) {
  const map = {};
  const d = new Date(fromMs); d.setHours(0, 0, 0, 0);
  for (; d.getTime() <= toMs; d.setDate(d.getDate() + 1)) {
    const f = trendFile(d.getTime());
    if (!fs.existsSync(f)) continue;
    fs.readFileSync(f, 'utf8').split('\n').forEach(function (line) {
      if (!line) return;
      try {
        const o = JSON.parse(line);
        if (o && o.t >= fromMs && o.t <= toMs) map[o.t] = o;
      } catch (_) {}
    });
  }
  return Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) { return a.t - b.t; });
}
function pruneTrend() {
  const today0 = new Date(); today0.setHours(0, 0, 0, 0);
  const cutoff = today0.getTime() - (OPT.trendDays - 1) * 86400000;
  let n = 0;
  try {
    fs.readdirSync(trendDir()).forEach(function (f) {
      const m = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(f);
      if (!m) return;
      const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
      if (t < cutoff) { try { fs.unlinkSync(path.join(trendDir(), f)); n++; } catch (_) {} }
    });
  } catch (_) {}
  return n;
}
/* 启动时清理历史趋势文件：把旧的实时快照点、午夜假峰、累计回退一次性压平；
   之后增量写入本身就干净，第二次启动不会再改文件 */
function cleanTrend() {
  let files = 0, dropped = 0, fixed = 0;
  try {
    fs.readdirSync(trendDir()).forEach(function (f) {
      const m = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(f);
      if (!m) return;
      const p = path.join(trendDir(), f);
      const dayStart = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
      const dayEnd = dayStart + 86400000;
      const list = [];
      let cross = 0;
      try {
        fs.readFileSync(p, 'utf8').split('\n').forEach(function (line) {
          if (!line) return;
          try {
            const o = JSON.parse(line);
            if (!o || !isFinite(o.t)) return;
            /* 旧版跨午夜把前一天的尾点写进了今天的文件，这里剔掉；昨天那份会由原始日志回补 */
            if (o.t >= dayStart && o.t < dayEnd) list.push(o); else cross++;
          } catch (_) {}
        });
      } catch (_) { return; }
      const clean = sanitizeTrend(list);
      if (!cross && !clean.dropped && !clean.fixed) return;
      if (!clean.list.length) { try { fs.unlinkSync(p); } catch (_) {} }
      else {
        const tmp = p + '.tmp';
        fs.writeFileSync(tmp, clean.list.map(function (o) { return JSON.stringify(o); }).join('\n') + '\n');
        fs.renameSync(tmp, p);
      }
      files++; dropped += clean.dropped + cross; fixed += clean.fixed;
    });
  } catch (_) {}
  if (files) log('趋势清理：' + files + ' 个文件，删实时快照 ' + dropped + ' 点，压平回退 ' + fixed + ' 点');
}
/* 趋势缓存概况（/solar/healthz 用）：保留天数、文件数、今天已攒多少点 */
function trendStat() {
  let files = 0, todayPts = 0;
  try {
    files = fs.readdirSync(trendDir()).filter(function (f) { return /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f); }).length;
  } catch (_) {}
  try { todayPts = fs.readFileSync(trendFile(Date.now()), 'utf8').split('\n').filter(Boolean).length; } catch (_) {}
  return { dir: trendDir(), keep_days: OPT.trendDays, files: files, today_points: todayPts };
}
/* 长区间降采样：桶内取大（峰值和当日累计都不会被抹平），免得一次甩几万个点给页面 */
function downsample(pts, bucketMs) {
  const map = {};
  pts.forEach(function (p) {
    const k = Math.floor(p.t / bucketMs) * bucketMs;
    const o = map[k] || (map[k] = { t: k });
    ['power_kw', 'daily_yield_kwh', 'total_yield_kwh', 'power_fraction'].forEach(function (key) {
      if (p[key] === undefined || p[key] === null) return;
      if (o[key] === undefined || p[key] > o[key]) o[key] = p[key];
    });
  });
  return Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) { return a.t - b.t; });
}

async function getPlants() {
  const j = await api('/openapi/platform/queryPowerStationList', { page: 1, size: 100 });
  return (j.result_data && j.result_data.pageList) || [];
}

async function getPlantDetail(psId) {
  const j = await api('/openapi/platform/getPowerStationDetail', { ps_ids: String(psId) });
  const list = (j.result_data && j.result_data.data_list) || [];
  return list[0] || null;
}

async function getDevices(psId) {
  const j = await api('/openapi/platform/getDeviceListByPsId', { ps_id: String(psId), page: 1, size: 100 });
  return (j.result_data && j.result_data.pageList) || [];
}

/* 光伏逆变器实时测点（开发者平台 /openapi/getPVInverterRealTimeData）
   dev_status 0 离线 / 1 在线；dev_fault_status 1 故障 / 2 告警 / 4 正常；
   p1 日发电量 Wh、p2 总发电量 Wh、p24 总有功功率 W、device_time 数据时间 */
async function getPvInverterRealtime(snList) {
  if (!snList || !snList.length) return {};
  const j = await api('/openapi/getPVInverterRealTimeData', { sn_list: snList });
  const list = (j.result_data && j.result_data.device_point_list) || [];
  const out = {};
  list.forEach(function (x) {
    const d = x.device_point || x;
    if (!d || !d.device_sn) return;
    out[String(d.device_sn)] = d;
  });
  return out;
}

/* 电站实时点位 → { code: {value, unit, name} } */
async function getRealtime(psId) {
  const ids = Object.keys(POINTS);
  const j = await api('/openapi/platform/getPowerStationRealTimeData', {
    ps_id_list: [String(psId)], point_id_list: ids, is_get_point_dict: '1'
  });
  const dict = {};
  ((j.result_data && j.result_data.point_dict) || []).forEach(function (p) { dict[String(p.point_id)] = p; });
  const row = (((j.result_data || {}).device_point_list) || [])[0] || {};
  const out = {};
  Object.keys(row).forEach(function (k) {
    if (k[0] !== 'p') return;
    const pid = k.slice(1);
    const code = POINTS[pid];
    if (!code) return;
    const v = row[k];
    out[code] = {
      value: (v === null || v === '' || isNaN(Number(v))) ? v : Number(v),
      unit: (dict[pid] || {}).point_unit || '',
      name: (dict[pid] || {}).point_name || code
    };
  });
  return out;
}

/* 分钟级历史（start/end 为 Date）：接口限制单次查询跨度（6 小时会报 exceeds the
   maximum limit），按 3 小时分段拉取再合并；某段失败不影响其它段 */
async function getHistory(psId, start, end, intervalMin) {
  const ids = Object.keys(POINTS);
  const fmt = function (d) {
    const p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  };
  const span = 3 * 3600 * 1000;
  const out = [];
  for (let t0 = start.getTime(); t0 < end.getTime(); t0 += span) {
    const s = new Date(t0), e = new Date(Math.min(t0 + span, end.getTime()));
    try {
      const j = await api('/openapi/platform/getPowerStationPointMinuteDataList', {
        ps_id_list: [String(psId)], points: ids.map(function (i) { return 'p' + i; }).join(','),
        is_get_point_dict: '1', start_time_stamp: fmt(s), end_time_stamp: fmt(e), minute_interval: String(intervalMin || 5)
      });
      const rd = j.result_data || {};
      const rows = rd[String(psId)] || rd[Number(psId)] || [];
      rows.forEach(function (frame) {
        const ts = frame.time_stamp;
        const t = ts && ts.length === 14
          ? new Date(Number(ts.slice(0, 4)), Number(ts.slice(4, 6)) - 1, Number(ts.slice(6, 8)), Number(ts.slice(8, 10)), Number(ts.slice(10, 12)), Number(ts.slice(12, 14)))
          : new Date(ts);
        if (!isFinite(t.getTime())) return;
        const o = { t: t.getTime() };
        Object.keys(frame).forEach(function (k) {
          if (k === 'time_stamp' || k[0] !== 'p') return;
          const code = POINTS[k.slice(1)];
          if (code) o[code] = Number(frame[k]);
        });
        out.push(o);
      });
    } catch (_) { /* 该段无数据或超限，跳过 */ }
  }
  return out.sort(function (a, b) { return a.t - b.t; });
}

/* ---------------- 天气（Open-Meteo：免费、无需 key，含实测辐照度） ---------------- */
const WMO = {
  0: '晴', 1: '晴间多云', 2: '多云', 3: '阴',
  45: '雾', 48: '雾凇',
  51: '毛毛雨', 53: '小雨', 55: '中雨', 56: '冻雨', 57: '冻雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '霰',
  80: '阵雨', 81: '阵雨', 82: '强阵雨', 85: '阵雪', 86: '阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '雷阵雨伴冰雹'
};
let wx = { at: 0, data: null };

async function getWeather(lat, lon) {
  if (wx.data && Date.now() - wx.at < 10 * 60 * 1000) return wx.data;
  const u = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon +
    '&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,' +
    'cloud_cover,wind_speed_10m,wind_direction_10m,is_day,shortwave_radiation' +
    '&daily=sunrise,sunset,uv_index_max&timezone=Asia%2FShanghai&forecast_days=1';
  const r = await fetch(u, { cache: 'no-store' });
  const j = await r.json();
  const c = j.current || {}, d = j.daily || {};
  const data = {
    time: c.time, is_day: c.is_day,
    temp: c.temperature_2m, feels: c.apparent_temperature, humidity: c.relative_humidity_2m,
    wind: c.wind_speed_10m, wind_dir: c.wind_direction_10m,
    cloud: c.cloud_cover, precip: c.precipitation, radiation: c.shortwave_radiation,
    code: c.weather_code, text: WMO[c.weather_code] || ('天气码 ' + c.weather_code),
    sunrise: String((d.sunrise || [])[0] || '').slice(11, 16),
    sunset: String((d.sunset || [])[0] || '').slice(11, 16),
    uv: (d.uv_index_max || [])[0],
    updated_at: new Date().toISOString()
  };
  wx = { at: Date.now(), data: data };
  return data;
}

/* 一次完整拉取：电站实时 + 设备 + 当日历史增量，全部落盘 */
async function poll() {
  state.polls++;
  try {
    if (!OPT.appkey || !OPT.secret) throw new Error('缺少 SOLAR_APPKEY / SOLAR_SECRET 配置');
    if (!(await ensureToken())) throw new Error('未授权：请先访问 /solar/authorize 完成授权');

    let psId = OPT.psId;
    if (!psId) {
      const plants = await getPlants();
      if (!plants.length) throw new Error('账号下没有可见电站');
      psId = String(plants[0].ps_id);
      log('未指定 ps_id，使用第一个电站：' + (plants[0].ps_name || '') + '（' + psId + '）');
    }
    const [detail, devices, rt] = await Promise.all([
      getPlantDetail(psId).catch(function () { return null; }),
      getDevices(psId).catch(function () { return []; }),
      getRealtime(psId)
    ]);
    /* 8 台逆变器的单机数据（功率/日发电/在线/故障/数据时间）；拿不到不影响站级数据 */
    const invSns = devices.filter(function (d) { return Number(d.device_type) === 1; })
      .map(function (d) { return d.device_sn || d.device_sn_str; }).filter(Boolean);
    let invRt = {};
    try { invRt = await getPvInverterRealtime(invSns); }
    catch (e) { log('单机实时数据获取失败：' + e.message); }
    const now = new Date();
    /* 历史窗口：服务首次拉取时回补当天 00:00 起的整条曲线（分段请求，最多 8 段），
       之后每 5 分钟只补最近 6 小时，省接口配额 */
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const from = state.polls <= 1
      ? dayStart
      : new Date(now.getTime() - 1000 * 60 * 60 * 6);
    const hist = await getHistory(psId, from, now, 5).catch(function () { return []; });

    const rec = {
      t: Date.now(), ps_id: psId,
      plant: detail ? {
        name: detail.ps_name,
        capacity: detail.install_power ? detail.install_power / 1000 : (detail.ps_capacity || detail.capacity),
        location: detail.ps_location, type: detail.ps_type_name,
        lat: detail.latitude, lon: detail.longitude,
        online: detail.online_status, alarms: detail.alarm_count, faults: detail.fault_count,
        install_date: detail.install_date
      } : null,
      rt: rt,
      devices: devices.map(function (d) {
        const sn = d.device_sn || d.device_sn_str;
        const r = invRt[sn] || null;
        return {
          sn: sn, name: d.device_name, type: d.device_type,
          status: d.dev_fault_status,
          fault_status: d.dev_fault_status == null ? null : Number(d.dev_fault_status),
          online: r && r.dev_status != null ? Number(r.dev_status) === 1
            : (d.dev_status != null ? Number(d.dev_status) === 1 : null),
          device_time: r && r.device_time ? String(r.device_time) : (d.device_time ? String(d.device_time) : null),
          power_kw: r && r.p24 != null && isFinite(Number(r.p24)) ? Number(r.p24) / 1000 : null,
          today_kwh: r && r.p1 != null && isFinite(Number(r.p1)) ? Number(r.p1) / 1000 : null,
          total_kwh: r && r.p2 != null && isFinite(Number(r.p2)) ? Number(r.p2) / 1000 : null,
          model: d.device_model_code
        };
      }),
      hist: hist
    };
    fs.appendFileSync(dayFile(Date.now()), JSON.stringify(rec) + '\n');

    /* 趋势缓存只用分钟历史：实时快照比历史慢一个周期，混进来会造成锯齿/累计回退 */
    const trendPts = saveTrend(hist);
    const invDevs = rec.devices.filter(function (d) { return Number(d.type) === 1; });
    const hasPow = invDevs.some(function (d) { return d.power_kw != null; });
    const hasDay = invDevs.some(function (d) { return d.today_kwh != null; });
    const devicePower = invDevs.reduce(function (s, d) { return s + (d.power_kw || 0); }, 0);
    const deviceToday = invDevs.reduce(function (s, d) { return s + (d.today_kwh || 0); }, 0);
    const dataTime = invDevs.map(function (d) { return d.device_time; }).filter(Boolean).sort().pop() || null;

    state.devices = rec.devices;
    state.summary = {
      ps_id: psId,
      plant: rec.plant,
      capacity: rec.plant ? rec.plant.capacity : null,
      location: rec.plant ? rec.plant.location : null,
      online: rec.plant ? rec.plant.online : null,
      alarms: rec.plant ? rec.plant.alarms : null,
      power: rt.power ? rt.power.value : null,
      daily_yield: rt.daily_yield ? rt.daily_yield.value : null,
      total_yield: rt.total_yield ? rt.total_yield.value : null,
      daily_hours: rt.daily_hours ? rt.daily_hours.value : null,
      ambient_temp: rt.ambient_temp ? rt.ambient_temp.value : null,
      module_temp: rt.module_temp ? rt.module_temp.value : null,
      radiation: rt.radiation ? rt.radiation.value : null,
      daily_irradiation: rt.daily_irradiation ? rt.daily_irradiation.value : null,
      device_power_kw: hasPow ? +devicePower.toFixed(3) : null,
      device_today_kwh: hasDay ? +deviceToday.toFixed(3) : null,
      data_time: dataTime,
      devices: rec.devices.length,
      updated_at: now.toISOString()
    };
    state.last = now.toISOString();
    state.lastError = null;
    log('拉取成功：实时点位 ' + Object.keys(rt).length + ' 个，设备 ' + rec.devices.length +
      ' 台（单机 ' + invDevs.length + '），历史 ' + hist.length + ' 点，趋势缓存 ' + trendPts + ' 点' +
      (dataTime ? '，设备数据时间 ' + dataTime : ''));
  } catch (e) {
    state.errors++;
    state.lastError = e.message;
    log('拉取失败：' + e.message);
  }
}

/* 保留 N 天：删更早的原始日文件；趋势缓存按 OPT.trendDays 另算 */
function prune() {
  const today0 = new Date(); today0.setHours(0, 0, 0, 0);
  const cutoff = today0.getTime() - (OPT.days - 1) * 86400000;
  fs.readdirSync(OPT.dir).forEach(function (f) {
    const m = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(f);
    if (!m) return;
    const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    if (t < cutoff) { try { fs.unlinkSync(path.join(OPT.dir, f)); } catch (_) {} }
  });
  const n = pruneTrend();
  if (n) log('趋势缓存清理：删了 ' + n + ' 个过期日文件（保留 ' + OPT.trendDays + ' 天）');
}

/* 原始轮询日文件里回捞曲线：历史接口的数据 + 每次拉取的实时快照（功率 / 当日发电）合并去重。
   快照是 5 分钟一条，够画当天的功率曲线；历史接口一旦有数据会自动一起合并进来 */
function readTrendRaw(fromMs, toMs) {
  const map = {};
  for (let d = new Date(fromMs).setHours(0, 0, 0, 0); d <= toMs; d += 86400000) {
    const f = dayFile(d);
    if (!fs.existsSync(f)) continue;
    fs.readFileSync(f, 'utf8').split('\n').forEach(function (line) {
      if (!line) return;
      let r = null;
      try { r = JSON.parse(line); } catch (_) { return; }
      (r.hist || []).forEach(function (p) {
        if (p.t < fromMs || p.t > toMs) return;
        map[p.t] = map[p.t] || { t: p.t };
        Object.keys(p).forEach(function (k) { if (k !== 't' && p[k] !== null && p[k] !== undefined) map[p.t][k] = p[k]; });
      });
      const rt = r.rt || {}, t = r.t;
      if (t && t >= fromMs && t <= toMs) {
        const o = {};
        if (rt.power && rt.power.value !== null && rt.power.value !== undefined) o.power_kw = Number(rt.power.value) / 1000;
        if (rt.daily_yield && rt.daily_yield.value !== null && rt.daily_yield.value !== undefined) o.daily_yield_kwh = Number(rt.daily_yield.value) / 1000;
        if (rt.total_yield && rt.total_yield.value !== null && rt.total_yield.value !== undefined) o.total_yield_kwh = Number(rt.total_yield.value) / 1000;
        if (Object.keys(o).length) {
          map[t] = map[t] || { t: t };
          Object.keys(o).forEach(function (k) { map[t][k] = o[k]; });
        }
      }
    });
  }
  return Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) { return a.t - b.t; });
}

/* 把某天的原始轮询日志一次性转成趋势缓存（没有原始日志就跳过）。
   页面第一次看昨天/前天时只慢这一次，之后只读小文件 */
function ensureTrendDay(dayStartMs) {
  if (fs.existsSync(trendFile(dayStartMs))) return false;
  if (!fs.existsSync(dayFile(dayStartMs))) return false;
  const pts = readTrendRaw(dayStartMs, dayStartMs + 86400000 - 1);
  if (!pts.length) return false;
  saveTrend(pts);
  return true;
}
/* 启动时把手上还在的原始日志整体回补一遍（正常最多 --days 天，一次性开销） */
function backfillTrend() {
  let days = 0;
  try {
    fs.readdirSync(OPT.dir).forEach(function (f) {
      const m = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(f);
      if (!m) return;
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
      if (ensureTrendDay(d)) days++;
    });
  } catch (_) {}
  if (days) log('趋势缓存回补：从原始日志生成了 ' + days + ' 天（之后只读小文件）');
  return days;
}
/* 曲线：按天读趋势缓存；缓存缺的那天先拿原始日志回补一次，再读缓存 */
function readTrend(fromMs, toMs) {
  const d0 = new Date(fromMs); d0.setHours(0, 0, 0, 0);
  for (let d = d0.getTime(); d <= toMs; d += 86400000) ensureTrendDay(d);
  return readTrendCache(fromMs, toMs);
}

/* ---------------- HTTP ---------------- */
const server = http.createServer(async function (req, res) {
  const u = new URL(req.url, 'http://localhost');
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', '*');
  res.setHeader('cache-control', 'no-store');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }   /* 跨域调试的预检 */

  const json = function (obj, code) {
    res.writeHead(code || 200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  const html = function (body) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!DOCTYPE html><meta charset="utf-8"><title>阳光电源接入</title>' +
      '<body style="font:14px/1.8 system-ui;background:#0b1418;color:#d8fbf4;padding:32px">' + body + '</body>');
  };

  try {
    /* 授权跳转 */
    if (u.pathname === '/solar/authorize') {
      if (!OPT.appid) return html('<h3>缺少 Application Id（SOLAR_APPID）</h3>');
      const url = AUTH_HOST + '/#/authorized-app?cloudId=' + CLOUD_ID +
        '&applicationId=' + encodeURIComponent(OPT.appid) +
        '&redirectUrl=' + encodeURIComponent(OPT.redirect);
      res.writeHead(302, { location: url });
      return res.end();
    }
    /* 授权回调：收 code 换 token */
    if (u.pathname === '/solar/callback') {
      const code = u.searchParams.get('code');
      if (!code) return html('<h3>回调缺少 code</h3><p>原始查询：' + u.search + '</p>');
      const tk = await fetchToken(code);
      return html('<h3>✅ 授权成功</h3><p>令牌已保存到服务器（' + TOKEN_FILE + '），之后自动续期。</p>' +
        '<p>可以关闭本页，回到平台查看数据。</p>' +
        '<p style="opacity:.6">access_token 有效期约 ' + Math.round((tk.expires_at - Date.now() / 1000) / 60) + ' 分钟</p>');
    }
    if (u.pathname === '/solar/healthz') {
      const tk = loadTokens();
      return json({
        ok: !state.lastError && !!tk, region: OPT.region, gateway: GW,
        appkey: OPT.appkey ? OPT.appkey.slice(0, 6) + '…' : null,
        ps_id: OPT.psId || null,
        authorized: !!tk, token_expires_in_sec: tk ? tk.expires_at - Math.floor(Date.now() / 1000) : null,
        polls: state.polls, errors: state.errors,
        last_poll: state.last, last_error: state.lastError,
        devices: state.devices.length, dir: OPT.dir,
        trend: trendStat()
      });
    }
    if (u.pathname === '/solar/summary') {
      if (!state.summary) await poll();
      return json({ ok: !!state.summary, data: state.summary, last_error: state.lastError });
    }
    if (u.pathname === '/solar/devices') {
      if (!state.devices.length) await poll();
      return json({ ok: !!state.devices.length, data: state.devices, last_error: state.lastError });
    }
    if (u.pathname === '/solar/trend') {
      const range = u.searchParams.get('range') || 'today';
      const now = Date.now();
      const d0 = new Date(); d0.setHours(0, 0, 0, 0);
      const today = d0.getTime();
      let from = today, to = now;
      if (range === 'yesterday') { from = today - 86400000; to = today - 1; }
      else {
        /* daysN = 近 N 天（含今天）；N 的上限就是趋势缓存的保留天数 */
        const m = /^days(\d+)$/.exec(range);
        const n = m ? Math.max(1, Math.min(OPT.trendDays, parseInt(m[1], 10))) : 1;
        if (n > 1) from = today - (n - 1) * 86400000;
      }
      /* 统一单位：功率 kW、发电量 kWh（历史接口给 W / Wh，快照已是 kW / kWh） */
      const pts = readTrend(from, to).map(function (p) {
        const o = { t: p.t };
        const pk = (p.power_kw !== undefined) ? Number(p.power_kw)
          : (p.power !== undefined ? Number(p.power) / 1000 : undefined);
        if (pk !== undefined && isFinite(pk)) o.power_kw = pk;
        const dy = (p.daily_yield_kwh !== undefined) ? Number(p.daily_yield_kwh)
          : (p.daily_yield !== undefined ? Number(p.daily_yield) / 1000 : undefined);
        if (dy !== undefined && isFinite(dy)) o.daily_yield_kwh = dy;
        const ty = (p.total_yield_kwh !== undefined) ? Number(p.total_yield_kwh)
          : (p.total_yield !== undefined ? Number(p.total_yield) / 1000 : undefined);
        if (ty !== undefined && isFinite(ty)) o.total_yield_kwh = ty;
        if (p.power_fraction !== undefined) o.power_fraction = Number(p.power_fraction);
        return o;
      });
      /* 长区间自动降采样：> 7 天按 15 分钟、> 30 天按 1 小时取桶内峰值，免得一次甩几万个点 */
      const spanDays = (to - from) / 86400000;
      const bucketMs = spanDays > 30 ? 3600000 : (spanDays > 7 ? 900000 : 0);
      const points = bucketMs ? downsample(pts, bucketMs) : pts;
      return json({
        ok: true, range: range, from: Math.floor(from / 1000), to: Math.floor(to / 1000),
        points: points, raw_points: pts.length, bucket_ms: bucketMs || null,
        trend_days_kept: OPT.trendDays
      });
    }
    if (u.pathname === '/solar/weather') {
      /* 电站经纬度来自阳光云的电站详情（洙边镇兜底），天气 10 分钟缓存 */
      const pl = (state.summary && state.summary.plant) || {};
      const lat = pl.lat || 35.08333, lon = pl.lon || 118.86010;
      try {
        const w = await getWeather(lat, lon);
        return json({ ok: true, data: w, lat: lat, lon: lon });
      } catch (e) {
        return json({ ok: false, data: null, last_error: '天气获取失败：' + e.message });
      }
    }
    if (u.pathname === '/solar/poll') { await poll(); return json({ ok: !state.lastError, last_error: state.lastError }); }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('solar service\n  GET /solar/authorize\n  GET /solar/callback\n  GET /solar/healthz\n  GET /solar/summary\n  GET /solar/devices\n  GET /solar/trend?range=today|yesterday|daysN\n  GET /solar/poll\n');
  } catch (e) {
    json({ ok: false, error: e.message }, 500);
  }
});

cleanTrend();
backfillTrend();
prune();
setInterval(prune, 3600000);
setInterval(function () { poll().catch(function () {}); }, OPT.poll * 1000);
server.listen(OPT.listen, function () {
  log('阳光太阳能服务已启动：http://127.0.0.1:' + OPT.listen + '　区域 ' + OPT.region + '　数据目录 ' + OPT.dir +
      '　拉取周期 ' + OPT.poll + 's' + (OPT.appkey ? '' : '　⚠ 未配置 AppKey'));
  poll().catch(function () {});
});
server.on('error', function (e) { log('监听失败：' + e.message); process.exit(1); });
process.on('SIGTERM', function () { server.close(function () { process.exit(0); }); });
process.on('SIGINT', function () { server.close(function () { process.exit(0); }); });
