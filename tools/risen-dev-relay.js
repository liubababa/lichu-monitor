#!/usr/bin/env node
/* ============================================================
 * 日升云接入 · 本地联调转发器
 *
 *   本地用静态服务（如 python -m http.server 8080）开发页面时，本地没有
 *   nginx 的 /risen 代理，页面拿不到储能数据。这个转发器把 /risen/* 转给
 *   线上的采集服务，浏览器同源访问即可。
 *
 *   注意：本地二选一 ——
 *     · 跑这个转发器（用线上那台的数据，凭据只在服务器上，推荐）
 *     · 或直接跑 tools/risen-cloud-service.js 自己拉日升云（会消耗/轮换
 *       refreshToken，和线上那台互相顶掉，只适合调试）
 *
 *   用法：node tools/risen-dev-relay.js [--port 8097] [--up https://mqtt.ykdesign.top]
 *   页面端：js/solar.js 在 localhost 下会自动连 http://127.0.0.1:8097
 * ============================================================ */
'use strict';

const http = require('http');

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
}
const PORT = parseInt(arg('port', '8097'), 10);
const UP = arg('up', 'https://mqtt.ykdesign.top').replace(/\/+$/, '');

const server = http.createServer(async function (req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', '*');
  res.setHeader('cache-control', 'no-store');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (!/^\/risen\//.test(req.url)) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: false, error: '只转发 /risen/*' }));
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
  console.log('日升云联调转发器已启动：http://127.0.0.1:' + PORT + '/risen/*  →  ' + UP);
});
