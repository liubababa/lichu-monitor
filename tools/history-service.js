#!/usr/bin/env node
/* ============================================================
 * 历史数据服务：把设备上报的 SOC / 储能功率 采样落盘，保留 N 天（默认 3 天），
 * 并对外提供查询接口（页面「充放电曲线 · 历史」用）
 *
 *   · 订阅 broker（只读账号即可），按 EMS 汇总帧采样：SOC、储能功率、各堆 SOC
 *   · 落盘：<dir>/YYYY-MM-DD.jsonl，每行一条 { t, sn, soc, p, clu, st }
 *   · 保留：超过 N 天的文件自动删除（启动时 + 每小时）
 *   · 接口：GET /healthz
 *           GET /history?range=today|yesterday|days3|all&step=300
 *           → { range, step, from, to, points:[{t, soc, p}] }（step 秒内取平均降采样）
 *
 * 用法：
 *   node history-service.js --url mqtt://127.0.0.1:1883 --user lichu_log --pass xxx
 *   node history-service.js --listen 8095 --dir /var/lib/lichu-history --days 3
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const mqtt = require('mqtt');

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
}
const OPT = {
  url: arg('url', process.env.HIST_MQTT_URL || 'mqtt://127.0.0.1:1883'),
  user: arg('user', process.env.HIST_MQTT_USER || ''),
  pass: arg('pass', process.env.HIST_MQTT_PASS || ''),
  dir: arg('dir', process.env.HIST_DIR || path.join(__dirname, '..', 'logs', 'history')),
  days: parseInt(arg('days', process.env.HIST_DAYS || '3'), 10),
  listen: parseInt(arg('listen', process.env.HIST_PORT || '8095'), 10),
  step: parseInt(arg('step', '300'), 10),        // 默认降采样粒度（秒）
  sampleGap: parseInt(arg('gap', '20'), 10),     // 同一设备两次采样最小间隔（秒）
  filter: arg('filter', '#')
};

fs.mkdirSync(OPT.dir, { recursive: true });

function log(line) { console.log(new Date().toTimeString().slice(0, 8) + '  ' + line); }

/* ---------------- 采样 ---------------- */
const devices = {};   // sn -> { soc, p, clu:[], ts, lastSaved }
let saved = 0;

function dayFile(ms) {
  const d = new Date(ms);
  const p = function (n) { return String(n).padStart(2, '0'); };
  return path.join(OPT.dir, d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '.jsonl');
}

/* 保留 N 天：删掉更早的日文件 */
function prune() {
  const keep = OPT.days;
  const now = new Date();
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (keep - 1)).getTime();
  let removed = 0;
  fs.readdirSync(OPT.dir).forEach(function (f) {
    const m = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(f);
    if (!m) return;
    const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    if (t < cutoff) { fs.unlinkSync(path.join(OPT.dir, f)); removed++; }
  });
  if (removed) log('清理过期文件 ' + removed + ' 个（保留 ' + keep + ' 天）');
}

function save(sn) {
  const d = devices[sn];
  if (!d) return;
  const now = Date.now();
  if (d.lastSaved && now - d.lastSaved < OPT.sampleGap * 1000) return;   // 采样间隔
  d.lastSaved = now;
  const rec = { t: now, sn: sn, soc: d.soc, p: d.p, clu: d.clu.slice(0, 8) };
  try {
    fs.appendFileSync(dayFile(now), JSON.stringify(rec) + '\n');
    saved++;
  } catch (e) { log('写盘失败：' + e.message); }
}

/* ---------------- MQTT ---------------- */
const client = mqtt.connect(OPT.url, {
  username: OPT.user || undefined, password: OPT.pass || undefined,
  clientId: 'lichu-history-' + Math.random().toString(16).slice(2, 8),
  keepalive: 30, reconnectPeriod: 5000, connectTimeout: 15000
});
client.on('connect', function () {
  log('已连接 broker：' + OPT.url + '，订阅 ' + OPT.filter);
  client.subscribe(OPT.filter, { qos: 1 }, function (err) {
    if (err) log('订阅失败：' + err.message);
  });
});
client.on('reconnect', function () { log('重连中…'); });
client.on('error', function (e) { log('连接错误：' + e.message); });

/* 解析：/{PSN}/{SN}/{rtg|history}/{data|status}/{维度}/…  —— 只关心数据帧里的几个汇总点 */
function onMessage(topic, buf) {
  const seg = topic.replace(/^\//, '').split('/');
  if (seg.length < 5) return;
  if (seg[2] !== 'rtg' && seg[2] !== 'history') return;
  if (seg[3] !== 'data') return;
  const sn = seg[1];
  if (!sn) return;
  let p = null;
  try { p = JSON.parse(buf.toString()); } catch (_) { return; }
  if (!p || typeof p !== 'object') return;

  let dim = seg[4];
  if (dim === 'meter' && seg[5]) dim = 'meter-' + seg[5] + '-' + seg[6];

  const d = devices[sn] || (devices[sn] = { soc: null, p: null, clu: [], ts: 0, lastSaved: 0 });
  const num = function (k) { const v = p[k]; const n = Number(v); return isFinite(n) ? n : null; };

  /* 断网补传帧（几小时前的数据）不入库：设备会周期性重发，混进来会让曲线在两个值之间跳。
     Ts 的位置各维度不同（emu=22、cluster=38…），这里直接取报文里最像 Unix 时间戳的那个值 */
  let tsGuess = 0;
  Object.keys(p).forEach(function (k) {
    const v = Number(p[k]);
    if (isFinite(v) && v > 1.7e9 && v < Date.now() / 1000 + 3600 && v > tsGuess) tsGuess = v;
  });
  if (tsGuess && Math.floor(Date.now() / 1000) - tsGuess > 900) return;

  if (dim === 'emu') {
    /* 汇总帧：SOC + 储能功率（按点位名或按索引两种写法都兼容） */
    const soc = (p.SumsSOC !== undefined) ? num('SumsSOC') : num('5');
    const pw = (p.PCSSumsActivePower !== undefined) ? num('PCSSumsActivePower') : num('1');
    if (soc !== null) d.soc = soc;
    if (pw !== null) d.p = pw;
    const ts = num('Ts') !== null ? num('Ts') : num('21');
    if (ts) d.ts = ts * 1000;
    if (d.soc !== null || d.p !== null) save(sn);
    return;
  }
  if (dim === 'cluster') {
    const soc = (p.cluSoc !== undefined) ? num('cluSoc') : num('3');
    const arr = (p.arrno !== undefined) ? Number(p.arrno) : Number(seg[5]);
    if (soc !== null && isFinite(arr)) d.clu[arr] = soc;
  }
  if (dim === 'array') {
    const soc = (p.arrSOC !== undefined) ? num('arrSOC') : num('3');
    if (soc !== null && d.soc === null) d.soc = soc;    // 没有汇总帧时用堆 SOC 兜底
  }
}
client.on('message', onMessage);

/* ---------------- HTTP 接口 ---------------- */
function readPoints(fromMs, toMs) {
  const out = [];
  const days = [];
  for (let t = new Date(fromMs).setHours(0, 0, 0, 0); t <= toMs; t += 86400000) {
    const f = dayFile(t);
    if (fs.existsSync(f)) days.push(f);
  }
  days.forEach(function (f) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch (_) { return; }
    text.split('\n').forEach(function (line) {
      if (!line) return;
      let r = null;
      try { r = JSON.parse(line); } catch (_) { return; }
      if (!r || !r.t || r.t < fromMs || r.t > toMs) return;
      if (r.soc === null && r.p === null) return;
      out.push(r);
    });
  });
  out.sort(function (a, b) { return a.t - b.t; });
  return out;
}

/* 按 step 秒取平均，减少点数（图表不用几万个点） */
function downsample(rows, stepSec) {
  const step = Math.max(1, stepSec) * 1000;
  const buckets = {};
  rows.forEach(function (r) {
    const k = Math.floor(r.t / step) * step;
    const b = buckets[k] || (buckets[k] = { t: k, socSum: 0, socN: 0, pSum: 0, pN: 0 });
    if (r.soc !== null && r.soc !== undefined) { b.socSum += Number(r.soc); b.socN++; }
    if (r.p !== null && r.p !== undefined) { b.pSum += Number(r.p); b.pN++; }
  });
  return Object.keys(buckets).map(function (k) {
    const b = buckets[k];
    return {
      t: Math.round(Number(k) / 1000),
      soc: b.socN ? +(b.socSum / b.socN).toFixed(2) : null,
      p: b.pN ? +(b.pSum / b.pN).toFixed(2) : null
    };
  }).sort(function (a, b) { return a.t - b.t; });
}

function rangeOf(name) {
  const now = Date.now();
  const d0 = new Date(); d0.setHours(0, 0, 0, 0);
  const today = d0.getTime();
  if (name === 'today') return [today, now];
  if (name === 'yesterday') return [today - 86400000, today - 1];
  if (name === 'days3' || name === 'history') return [today - 2 * 86400000, now];
  return [now - OPT.days * 86400000, now];
}

const server = http.createServer(function (req, res) {
  const u = new URL(req.url, 'http://localhost');
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('cache-control', 'no-store');
  if (u.pathname === '/healthz') {
    const files = fs.readdirSync(OPT.dir).filter(function (f) { return /\.jsonl$/.test(f); });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: true, mqtt: client.connected ? 'connected' : 'disconnected',
      dir: OPT.dir, days: OPT.days, keptFiles: files.sort(), saved: saved,
      devices: Object.keys(devices)
    }, null, 2));
    return;
  }
  if (u.pathname === '/history') {
    const range = u.searchParams.get('range') || 'days3';
    const step = parseInt(u.searchParams.get('step') || String(OPT.step), 10);
    const r = rangeOf(range);
    const rows = readPoints(r[0], r[1]);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      range: range, step: step, from: Math.floor(r[0] / 1000), to: Math.floor(r[1] / 1000),
      raw: rows.length, points: downsample(rows, step)
    }));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('lichu history service\n  GET /healthz\n  GET /history?range=today|yesterday|days3&step=300\n');
});

prune();
setInterval(prune, 3600000);
server.listen(OPT.listen, function () {
  log('历史服务已启动：http://127.0.0.1:' + OPT.listen + '　目录 ' + OPT.dir + '　保留 ' + OPT.days + ' 天　采样间隔 ' + OPT.sampleGap + 's');
});
server.on('error', function (e) { log('监听失败：' + e.message); process.exit(1); });

process.on('SIGINT', function () { try { client.end(true); } catch (_) {} server.close(function () { process.exit(0); }); });
process.on('SIGTERM', function () { try { client.end(true); } catch (_) {} server.close(function () { process.exit(0); }); });
