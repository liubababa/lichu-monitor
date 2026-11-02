'use strict';
/* ============================================================
 * 三维页出图用的接收端口（本地调试工具，不上线）
 *
 *   无头 Edge 在这台机器上经常跑不动（软件渲染 WebGL，虚拟时间走不完，
 *   浏览器进程还会挂）；Qoder 的 in-app 浏览器面板不可见时又截不了图。
 *   这条路子绕开两者：在真浏览器里 evaluate_script 强制渲一帧，
 *   把 canvas.toDataURL() POST 回来落盘成 PNG，再用 Read 看图。
 *
 *   canvas 没开 preserveDrawingBuffer，所以必须"同一 JS 任务里先渲染再取图"：
 *     const J = window.JunyongScene;
 *     J.setActive(true);                       // 内部会 resize() + renderNow()
 *     fetch('http://127.0.0.1:8124/save?name=x', {method:'POST',
 *       body: document.querySelector('#jy3d canvas').toDataURL('image/png')});
 *
 *   用法：node tools/shot-recv.js [端口]     （默认 8124，输出到 /tmp/qshot）
 * ============================================================ */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.argv[2] || 8124);
const OUT = path.join(os.tmpdir(), 'qshot');

http.createServer(function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method !== 'POST') { res.writeHead(200); res.end('shot-recv ok'); return; }
  const name = String(new URL(req.url, 'http://x').searchParams.get('name') || 'shot')
    .replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 60) || 'shot';
  let body = '';
  req.setEncoding('utf8');
  req.on('data', function (c) { body += c; });
  req.on('end', function () {
    const b64 = body.replace(/^data:image\/\w+;base64,/, '');
    if (!b64) { res.writeHead(400); res.end('empty'); return; }
    fs.mkdirSync(OUT, { recursive: true });
    const file = path.join(OUT, name + '.png');
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    console.log('saved ' + file + ' ' + Math.round(b64.length * 0.75 / 1024) + 'KB');
    res.writeHead(200); res.end(file);
  });
}).listen(PORT, '127.0.0.1', function () {
  console.log('shot-recv on http://127.0.0.1:' + PORT + ' -> ' + OUT);
});
