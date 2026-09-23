#!/usr/bin/env node
/* ============================================================
 * 阳光电源 iSolarCloud 接入服务
 *
 *   1) OAuth2 授权：GET /solar/authorize → 跳阳光授权页 → /solar/callback 收码换 token
 *   2) 定时拉取：每 5 分钟拉电站实时点位 + 设备列表/状态，另按增量拉分钟级历史，落盘
 *   3) 对外接口（给页面用，字段统一）：
 *        GET /solar/summary      当日/累计发电、实时功率、装机、状态、更新时间
 *        GET /solar/devices      设备列表（类型/SN/状态/关键指标）
 *        GET /solar/trend        功率曲线（today | yesterday | days3，interval 分钟）
 *        GET /solar/healthz      连通性、最近拉取时间、错误
 *   凭据来自环境变量（部署时写 /etc/lichu-solar.env，600，不进仓库）
 *
 *   用法：node solar-service.js --listen 8096 --dir /var/lib/lichu-solar
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
  days: parseInt(arg('days', process.env.SOLAR_DAYS || '3'), 10)         // 历史保留天数
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
  const res = await fetch(GW + '/openapi/apiManage/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-access-key': OPT.secret },
    body: JSON.stringify({ appkey: OPT.appkey, code: code, grant_type: 'authorization_code', redirect_uri: OPT.redirect })
  });
  const json = await res.json();
  if (!json.access_token) throw new Error('换取 token 失败：' + JSON.stringify(json).slice(0, 300));
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

async function refreshToken() {
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

/* 分钟级历史（start/end 为 Date） */
async function getHistory(psId, start, end, intervalMin) {
  const ids = Object.keys(POINTS);
  const fmt = function (d) {
    const p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  };
  const j = await api('/openapi/platform/getPowerStationPointMinuteDataList', {
    ps_id_list: [String(psId)], points: ids.map(function (i) { return 'p' + i; }).join(','),
    is_get_point_dict: '1', start_time_stamp: fmt(start), end_time_stamp: fmt(end), minute_interval: String(intervalMin || 5)
  });
  const rd = j.result_data || {};
  const rows = rd[String(psId)] || rd[Number(psId)] || [];
  return rows.map(function (frame) {
    const ts = frame.time_stamp;
    const t = ts && ts.length === 14
      ? new Date(Number(ts.slice(0, 4)), Number(ts.slice(4, 6)) - 1, Number(ts.slice(6, 8)), Number(ts.slice(8, 10)), Number(ts.slice(10, 12)), Number(ts.slice(12, 14)))
      : new Date(ts);
    const o = { t: t.getTime() };
    Object.keys(frame).forEach(function (k) {
      if (k === 'time_stamp' || k[0] !== 'p') return;
      const code = POINTS[k.slice(1)];
      if (code) o[code] = Number(frame[k]);
    });
    return o;
  }).filter(function (r) { return isFinite(r.t); }).sort(function (a, b) { return a.t - b.t; });
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
    const now = new Date();
    const from = new Date(now.getTime() - 1000 * 60 * 60 * 6);          // 取近 6 小时（5 分钟粒度）
    const hist = await getHistory(psId, from, now, 5).catch(function () { return []; });

    const rec = {
      t: Date.now(), ps_id: psId,
      plant: detail ? { name: detail.ps_name, capacity: detail.ps_capacity || detail.capacity, status: detail.ps_status } : null,
      rt: rt,
      devices: devices.map(function (d) {
        return { sn: d.device_sn || d.device_sn_str, name: d.device_name, type: d.device_type,
                 status: d.dev_fault_status, model: d.device_model_code };
      }),
      hist: hist
    };
    fs.appendFileSync(dayFile(Date.now()), JSON.stringify(rec) + '\n');

    state.devices = rec.devices;
    state.summary = {
      ps_id: psId,
      plant: rec.plant,
      power: rt.power ? rt.power.value : null,
      daily_yield: rt.daily_yield ? rt.daily_yield.value : null,
      total_yield: rt.total_yield ? rt.total_yield.value : null,
      daily_hours: rt.daily_hours ? rt.daily_hours.value : null,
      ambient_temp: rt.ambient_temp ? rt.ambient_temp.value : null,
      module_temp: rt.module_temp ? rt.module_temp.value : null,
      devices: rec.devices.length,
      updated_at: now.toISOString()
    };
    state.last = now.toISOString();
    state.lastError = null;
    log('拉取成功：实时点位 ' + Object.keys(rt).length + ' 个，设备 ' + rec.devices.length + ' 台，历史 ' + hist.length + ' 点');
  } catch (e) {
    state.errors++;
    state.lastError = e.message;
    log('拉取失败：' + e.message);
  }
}

/* 保留 N 天：删更早的日文件 */
function prune() {
  const today0 = new Date(); today0.setHours(0, 0, 0, 0);
  const cutoff = today0.getTime() - (OPT.days - 1) * 86400000;
  fs.readdirSync(OPT.dir).forEach(function (f) {
    const m = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(f);
    if (!m) return;
    const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    if (t < cutoff) { try { fs.unlinkSync(path.join(OPT.dir, f)); } catch (_) {} }
  });
}

/* 读某天的曲线（把多次拉取的 hist 合并去重） */
function readTrend(fromMs, toMs) {
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
    });
  }
  return Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) { return a.t - b.t; });
}

/* ---------------- HTTP ---------------- */
const server = http.createServer(async function (req, res) {
  const u = new URL(req.url, 'http://localhost');
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('cache-control', 'no-store');

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
        devices: state.devices.length, dir: OPT.dir
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
      else if (range === 'days3') { from = today - 2 * 86400000; }
      const pts = readTrend(from, to);
      return json({ ok: true, range: range, from: Math.floor(from / 1000), to: Math.floor(to / 1000), points: pts });
    }
    if (u.pathname === '/solar/poll') { await poll(); return json({ ok: !state.lastError, last_error: state.lastError }); }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('solar service\n  GET /solar/authorize\n  GET /solar/callback\n  GET /solar/healthz\n  GET /solar/summary\n  GET /solar/devices\n  GET /solar/trend?range=today|yesterday|days3\n  GET /solar/poll\n');
  } catch (e) {
    json({ ok: false, error: e.message }, 500);
  }
});

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
