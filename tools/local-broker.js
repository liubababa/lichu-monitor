#!/usr/bin/env node
/* ============================================================
 * 本地 MQTT broker（开发/联调用，基于 aedes）
 *
 *   TCP  监听 mqtt://127.0.0.1:1884        —— 给 EMS 模拟器用
 *   WS   监听 ws://127.0.0.1:9001/mqtt     —— 给浏览器页面用（页面 Broker 地址填 ws://127.0.0.1:9001/mqtt）
 *
 * 用法：node local-broker.js
 * 生产环境请改用服务器上的 EMQX/mosquitto（见 部署指南.md）。
 * ============================================================ */
'use strict';
const aedes = require('aedes')();
const net = require('net');
const http = require('http');
const websocketStream = require('websocket-stream');

const TCP_PORT = 1884, WS_PORT = 9001;

net.createServer(c => aedes.handle(c)).listen(TCP_PORT, () =>
  console.log('MQTT/TCP  mqtt://127.0.0.1:' + TCP_PORT));

const httpServer = http.createServer((req, res) => {
  res.writeHead(404); res.end('ws endpoint: ws://127.0.0.1:' + WS_PORT + '/mqtt');
});
websocketStream.createServer({ server: httpServer, path: '/mqtt' }, aedes.handle);
httpServer.listen(WS_PORT, () =>
  console.log('MQTT/WS   ws://127.0.0.1:' + WS_PORT + '/mqtt'));

aedes.on('client', c => console.log('client connected:', c.id));
aedes.on('clientDisconnect', c => console.log('client disconnected:', c.id));
aedes.on('publish', (packet, client) => {
  if (client) console.log('[' + packet.topic + '] ' + packet.payload.length + 'B from ' + client.id);
});
