#!/usr/bin/env node
/* ============================================================
 * 前后分离网关：网页 ⇄ 本网关 ⇄ 厂家 broker
 *
 *   · broker 连接与账号密码只存在于本服务（浏览器不再直连 broker）
 *   · 订阅 filters（默认 #），把报文经 MQTT-over-WebSocket（默认 /mqtt）转给网页
 *   · 网页下发的报文原样转发给 broker；EMS 登录由本服务自动应答，
 *     页面关着也不掉线（原先前端负责应答，改由网关接管）
 *   · 鉴权：匿名客户端只读（可订阅）；填了正确账号的客户端才允许下发
 *
 * 用法：
 *   node gateway.js                                  # 读同目录 gateway.config.json
 *   node gateway.js --config /etc/mqtt-gateway/config.json
 *   node gateway.js --upstream mqtt://127.0.0.1:1884 --listen 9001 --open-publish
 *
 * 参数（均可被 config 文件里的同名项覆盖前置默认值，CLI 优先级最高）：
 *   --listen 8083          网页侧监听端口（浏览器连 ws://host:8083/mqtt）
 *   --path /mqtt           网页侧 WebSocket 路径
 *   --upstream mqtt://…    厂家 broker 地址（mqtt/mqtts）
 *   --user / --pass        厂家 broker 账号密码
 *   --filters a,b          订阅过滤器，默认 #
 *   --no-login-reply       不自动回 zhhn 登录应答
 *   --no-retain            不保留各主题最后一条（新开页面拿不到历史快照）
 *   --open-publish         允许匿名客户端下发（默认否，只读）
 *
 * 健康检查：GET /healthz
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const mqtt = require('mqtt');
const createAedes = require('aedes');
const websocketStream = require('websocket-stream');

/* ============================ 配置 ============================ */

const DEFAULTS = {
  listen: 8083,
  path: '/mqtt',
  upstream: { url: 'mqtt://127.0.0.1:1883', username: '', password: '', filters: ['#'], qos: 1 },
  autoLoginReply: true,
  retainLast: true,
  allowAnonymous: true,
  anonymousPublish: false,
  users: {},
  logFile: '',
  logMessages: false
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--config') out.config = next();
    else if (a === '--listen') out.listen = parseInt(next(), 10);
    else if (a === '--path') out.path = next();
    else if (a === '--upstream') out.upstreamUrl = next();
    else if (a === '--user') out.upUser = next();
    else if (a === '--pass') out.upPass = next();
    else if (a === '--filters') out.filters = next().split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--no-login-reply') out.autoLoginReply = false;
    else if (a === '--no-retain') out.retainLast = false;
    else if (a === '--open-publish') out.anonymousPublish = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('--')) { console.error('未知参数：' + a); process.exit(2); }
  }
  return out;
}

function loadConfig(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log([
      '用法：node gateway.js [--config 配置文件] [选项]',
      '  --listen 8083          网页侧监听端口（浏览器连 ws://host:8083/mqtt）',
      '  --path /mqtt           网页侧 WebSocket 路径',
      '  --upstream mqtt://…    厂家 broker 地址（mqtt/mqtts）',
      '  --user / --pass        厂家 broker 账号密码',
      '  --filters a,b          订阅过滤器，默认 #',
      '  --no-login-reply       不自动回 zhhn 登录应答',
      '  --no-retain            不保留各主题最后一条',
      '  --open-publish         允许匿名客户端下发（默认否，只读）',
      '示例配置见 gateway.config.example.json，健康检查 GET /healthz。'
    ].join('\n'));
    process.exit(0);
  }
  const file = args.config || path.join(__dirname, 'gateway.config.json');
  let fromFile = {};
  if (fs.existsSync(file)) {
    try { fromFile = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { console.error('配置文件解析失败 ' + file + '：' + e.message); process.exit(2); }
  } else if (args.config) {
    console.error('配置文件不存在：' + file); process.exit(2);
  }
  const cfg = Object.assign({}, DEFAULTS, fromFile);
  cfg.upstream = Object.assign({}, DEFAULTS.upstream, fromFile.upstream || {});
  if (args.listen) cfg.listen = args.listen;
  if (args.path) cfg.path = args.path;
  if (args.upstreamUrl) cfg.upstream.url = args.upstreamUrl;
  if (args.upUser !== undefined) cfg.upstream.username = args.upUser;
  if (args.upPass !== undefined) cfg.upstream.password = args.upPass;
  if (args.filters) cfg.upstream.filters = args.filters;
  if (args.autoLoginReply === false) cfg.autoLoginReply = false;
  if (args.retainLast === false) cfg.retainLast = false;
  if (args.anonymousPublish === true) cfg.anonymousPublish = true;
  if (!Array.isArray(cfg.upstream.filters) || !cfg.upstream.filters.length) cfg.upstream.filters = ['#'];
  cfg.configFile = fs.existsSync(file) ? file : '';
  return cfg;
}

const cfg = loadConfig(process.argv.slice(2));

/* ============================ 日志 ============================ */

let logStream = null;
if (cfg.logFile) {
  try { logStream = fs.createWriteStream(cfg.logFile, { flags: 'a' }); }
  catch (e) { console.error('日志文件打不开 ' + cfg.logFile + '：' + e.message); }
}
function log(line) {
  const text = new Date().toTimeString().slice(0, 8) + '  ' + line;
  console.log(text);
  if (logStream) logStream.write(text + '\n');
}

/* ============================ 网页侧 broker（aedes） ============================ */

const aedes = createAedes();
const stats = { startedAt: Date.now(), msgsIn: 0, msgsOut: 0, loginReplies: 0, denied: 0 };

aedes.authenticate = function (client, username, password, done) {
  const u = username ? String(username) : '';
  const p = password ? String(password) : '';
  if (!u && !p) {
    client.gwUser = '';
    return done(null, !!cfg.allowAnonymous);
  }
  const expect = Object.prototype.hasOwnProperty.call(cfg.users, u) ? cfg.users[u] : undefined;
  if (expect !== undefined && p === String(expect)) {
    client.gwUser = u;
    log('网页登录：' + u + '（可下发）');
    return done(null, true);
  }
  client.gwUser = '';
  log('拒绝网页登录：' + u);
  return done(null, false);
};

aedes.authorizePublish = function (client, packet, done) {
  /* 不在授权层拒绝（aedes 拒绝会断开网页连接），只读拦截在桥接处丢弃并计数 */
  return done(null);
};

/* ============================ 厂家 broker（上游） ============================ */

const up = mqtt.connect(cfg.upstream.url, {
  username: cfg.upstream.username || undefined,
  password: cfg.upstream.password || undefined,
  clientId: 'lichu-gateway-' + Math.random().toString(16).slice(2, 8),
  keepalive: 30, reconnectPeriod: 5000, connectTimeout: 15000, clean: true
});

up.on('connect', function () {
  log('上游 broker 已连接：' + cfg.upstream.url);
  up.subscribe(cfg.upstream.filters, { qos: Math.min(cfg.upstream.qos || 1, 2) }, function (err) {
    if (err) log('订阅失败：' + err.message);
    else log('已订阅 ' + cfg.upstream.filters.join(' , '));
  });
});
up.on('reconnect', () => log('上游重连中…'));
up.on('close', () => log('上游连接断开'));
up.on('error', e => log('上游错误：' + ((e && e.message) || e)));

function replyLogin(topic) {
  const m = /^zhhn\/Post\/Login\/([^/]+)$/.exec(topic);
  if (!m) return;
  const sn = m[1];
  const body = JSON.stringify({ identifier: 'Login', result: 1, time: Math.floor(Date.now() / 1000) });
  up.publish('zhhn/PostRsp/Login/' + sn, body, { qos: 1 }, function (err) {
    if (err) log('登录应答发送失败 ' + sn + '：' + err.message);
  });
  stats.loginReplies++;
  log('登录应答 → zhhn/PostRsp/Login/' + sn);
}

/* 上游 → 网页：注入 aedes（retainLast 时保留各主题最后一条，新开页面立即有数据） */
up.on('message', function (topic, payload, packet) {
  stats.msgsIn++;
  if (cfg.logMessages) log('↓ ' + topic + '  ' + payload.length + 'B');
  aedes.publish({
    cmd: 'publish', topic: topic, payload: payload,
    qos: Math.min(packet.qos || 0, 1), retain: !!cfg.retainLast, dup: false
  }, function (err) { if (err) log('注入失败 ' + topic + '：' + err.message); });
  if (cfg.autoLoginReply) replyLogin(topic);
});

/* 网页 → 上游：只转发客户端发布的报文，网关注入的不回发（否则成环） */
aedes.on('publish', function (packet, client) {
  if (!client) return;
  if (packet.topic.indexOf('$SYS') === 0) return;
  if (!client.gwUser && !cfg.anonymousPublish) {
    /* 只读模式：丢弃而不是拒绝，避免 aedes 因授权失败断开网页连接 */
    stats.denied++;
    log('丢弃下发（只读模式）：' + packet.topic);
    return;
  }
  stats.msgsOut++;
  if (cfg.logMessages) log('↑ ' + packet.topic + '  ' + packet.payload.length + 'B  from ' + client.id);
  up.publish(packet.topic, packet.payload, { qos: Math.min(packet.qos || 0, 1), retain: false }, function (err) {
    if (err) log('转发失败 ' + packet.topic + '：' + err.message);
  });
});

aedes.on('client', c => log('网页接入：' + c.id + (c.gwUser ? '（账号 ' + c.gwUser + '）' : '（匿名只读）')));
aedes.on('clientDisconnect', c => log('网页断开：' + c.id));
aedes.on('clientError', (c, e) => log('网页客户端错误：' + ((e && e.message) || e)));
aedes.on('connectionError', (c, e) => log('网页连接错误：' + ((e && e.message) || e)));

/* ============================ HTTP + WebSocket ============================ */

const server = http.createServer(function (req, res) {
  const p = String(req.url || '').split('?')[0];
  if (p === '/healthz') {
    const body = JSON.stringify({
      ok: true,
      uptimeSec: Math.round((Date.now() - stats.startedAt) / 1000),
      upstream: up.connected ? 'connected' : 'disconnected',
      upstreamUrl: cfg.upstream.url,
      filters: cfg.upstream.filters,
      clients: Object.keys(aedes.clients).length,
      msgsIn: stats.msgsIn, msgsOut: stats.msgsOut,
      loginReplies: stats.loginReplies, deniedPublish: stats.denied,
      anonymousPublish: cfg.anonymousPublish, autoLoginReply: cfg.autoLoginReply
    }, null, 2);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(body);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('lichu mqtt gateway\nWS: ' + cfg.path + '\n健康检查: /healthz\n');
});

websocketStream.createServer({ server: server, path: cfg.path }, aedes.handle);

server.listen(cfg.listen, function () {
  log('网关已启动：ws://127.0.0.1:' + cfg.listen + cfg.path + '  →  ' + cfg.upstream.url
    + '　订阅 ' + cfg.upstream.filters.join(',')
    + '　登录应答 ' + (cfg.autoLoginReply ? '开' : '关')
    + '　匿名下发 ' + (cfg.anonymousPublish ? '开' : '关'));
  if (cfg.configFile) log('配置文件：' + cfg.configFile);
});
server.on('error', function (e) {
  log('监听失败 ' + cfg.listen + '：' + e.message);
  process.exit(1);
});

/* ============================ 退出 ============================ */

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  log('退出中…');
  try { up.end(true); } catch (_) {}
  try { aedes.close(); } catch (_) {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
