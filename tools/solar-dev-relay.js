#!/usr/bin/env node
/* ============================================================
 * 阳光云接入 · 本地联调转发器
 *
 *   本地用静态服务（如 python -m http.server 8080）开发页面时，
 *   本地没有 nginx 的 /solar 代理，页面拿不到数据。
 *   这个转发器把 /solar/* 请求转给线上的接入服务，浏览器同源访问即可。
 *
 *   用法：node tools/solar-dev-relay.js [--port 8099] [--up https://mqtt.ykdesign.top]
 *   页面端：js/solar.js 在 localhost 下会自动连 http://127.0.0.1:8099
 * ============================================================ */
'use strict';

const http = require('http');

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
}
const PORT = parseInt(arg('port', '8099'), 10);
const UP = arg('up', 'https://mqtt.ykdesign.top').replace(/\/+$/, '');

const server = http.createServer(async function (req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('cache-control', 'no-store');
  if (!/^\/solar\//.test(req.url)) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: false, error: '只转发 /solar/*' }));
  }
  try {
    const r = await fetch(UP + req.url, { cache: 'no-store' });
    const body = await r.text();
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json; charset=utf-8' });
    res.end(body);
    console.log(new Date().toTimeString().slice(0, 8) + '  ' + req.url + '  →  ' + r.status);
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: '转发失败：' + e.message }));
    console.log(new Date().toTimeString().slice(0, 8) + '  ' + req.url + '  →  502 ' + e.message);
  }
});

server.listen(PORT, '127.0.0.1', function () {
  console.log('阳光云联调转发器已启动：http://127.0.0.1:' + PORT + '/solar/*  →  ' + UP);
});
