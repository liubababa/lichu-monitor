#!/usr/bin/env node
/* ============================================================
 * 网关端到端测试（不依赖任何外部服务）
 *
 *   1. 本进程内起一个 aedes 设备 broker（TCP）
 *   2. 子进程起 gateway.js 指向它
 *   3. 「设备」客户端 → 发布 Login / PeriodReport
 *      「网页」客户端 → 连网关 WS，验证收报文、登录应答、只读拦截、
 *                       登录后可下发、新开页面拿快照、无回声环路
 *
 * 用法：node test-gateway.js      （依赖 tools/node_modules，先 cd tools && npm i）
 * ============================================================ */
'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const mqtt = require('mqtt');
const createAedes = require('aedes');

const results = [];
function check(name, pass, extra) {
  results.push({ name, pass });
  console.log((pass ? '[通过] ' : '[失败] ') + name + (extra ? '　' + extra : ''));
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function freePort() {
  return new Promise(res => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

function connect(url, opts) {
  return new Promise((resolve, reject) => {
    const c = mqtt.connect(url, Object.assign({ reconnectPeriod: 0, connectTimeout: 8000 }, opts));
    c.once('connect', () => resolve(c));
    c.once('error', e => reject(new Error(url + ' 连接失败：' + e.message)));
  });
}

function waitMsg(client, matcher, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { client.removeListener('message', h); reject(new Error('超时等待：' + label)); }, timeoutMs);
    function h(topic, payload) {
      let obj = null;
      try { obj = JSON.parse(payload.toString()); } catch (_) {}
      if (matcher(topic, obj)) { clearTimeout(t); client.removeListener('message', h); resolve({ topic, obj, text: payload.toString() }); }
    }
    client.on('message', h);
  });
}

function waitHealthz(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function poll() {
      const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: 1000 }, res => {
        let body = '';
        res.on('data', d => { body += d; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error('/healthz 返回非 JSON：' + body.slice(0, 120))); }
        });
      });
      req.on('error', () => {
        if (Date.now() > deadline) return reject(new Error('网关未在 ' + timeoutMs + 'ms 内就绪'));
        setTimeout(poll, 200);
      });
      req.on('timeout', () => req.destroy());
    })();
  });
}

(async function main() {
  const devicePort = await freePort();
  const gwPort = await freePort();
  const cfgPath = path.join(os.tmpdir(), 'gateway-test-' + Date.now() + '.json');
  let gw = null, device = null, pageAnon = null, pageAuth = null, pageLate = null, devBroker = null, devServer = null;

  try {
    /* ---------- 1. 设备侧 broker（厂家 broker 的替身，本地进程内） ---------- */
    devBroker = createAedes();
    const seenByBroker = [];
    devBroker.on('publish', packet => { if (packet.topic) seenByBroker.push(packet.topic); });
    devServer = net.createServer(c => devBroker.handle(c));
    await new Promise(r => devServer.listen(devicePort, '127.0.0.1', r));
    console.log('设备侧 broker：mqtt://127.0.0.1:' + devicePort);

    /* ---------- 2. 网关 ---------- */
    fs.writeFileSync(cfgPath, JSON.stringify({
      listen: gwPort,
      path: '/mqtt',
      upstream: { url: 'mqtt://127.0.0.1:' + devicePort, filters: ['#'], qos: 1 },
      autoLoginReply: true,
      retainLast: true,
      allowAnonymous: true,
      anonymousPublish: false,
      users: { webuser: 'webpass' },
      logMessages: true
    }, null, 2));
    gw = spawn(process.execPath, [path.join(__dirname, 'gateway.js'), '--config', cfgPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let gwLog = '';
    gw.stdout.on('data', d => { gwLog += d.toString(); process.stdout.write('  [网关] ' + d.toString().trim() + '\n'); });
    gw.stderr.on('data', d => { gwLog += d.toString(); process.stderr.write('  [网关:err] ' + d.toString().trim() + '\n'); });
    const health0 = await waitHealthz(gwPort, 8000);
    check('网关启动并监听 ws://127.0.0.1:' + gwPort + '/mqtt', health0.ok === true);
    check('网关连上上游 broker', health0.upstream === 'connected', 'upstream=' + health0.upstream);

    /* ---------- 3. 设备客户端 ---------- */
    device = await connect('mqtt://127.0.0.1:' + devicePort, { clientId: 'test-device' });
    await new Promise(r => device.subscribe('#', { qos: 1 }, r));
    const SN = 'SNGW0001';

    /* ---------- 4. 匿名网页客户端 ---------- */
    pageAnon = await connect('ws://127.0.0.1:' + gwPort + '/mqtt', { clientId: 'test-page-anon' });
    await new Promise(r => pageAnon.subscribe('#', { qos: 1 }, r));

    /* 4.1 网关自动回登录应答（先挂监听再发登录，避免竞态） */
    const rspWait = waitMsg(device, (t) => t === 'zhhn/PostRsp/Login/' + SN, 4000, '登录应答');
    device.publish('zhhn/Post/Login/' + SN, JSON.stringify({ identifier: 'Login', vendor: 'zhhn', time: 1 }), { qos: 1 });
    const rsp = await rspWait;
    check('网关自动应答 EMS 登录（页面无需在线）', rsp.obj && String(rsp.obj.result) === '1', JSON.stringify(rsp.obj));

    /* 4.2 设备上报 → 网页收到 */
    const repWait = waitMsg(pageAnon, (t, o) => t === 'zhhn/Post/PeriodReport/' + SN && o && o.identifier === 'PeriodReport', 4000, '周期上报');
    device.publish('zhhn/Post/PeriodReport/' + SN, JSON.stringify({ identifier: 'PeriodReport', SN, data: [{ deviceType: 'PCS', tags: { ActivePower: '-150.5' } }], time: 2 }), { qos: 1 });
    const rep = await repWait;
    check('设备上报经网关转给网页', !!rep.obj, rep.topic);

    /* 4.3 匿名客户端下发被静默丢弃（连接保持，不被断开） */
    const before = seenByBroker.length;
    pageAnon.publish('zhhn/Set/EmsSet/' + SN, JSON.stringify({ identifier: 'EmsSet', Tag: [{ deviceTag: 'EMS', wayName: 'OnOff', varValue: '1' }] }), { qos: 1 });
    await sleep(1200);
    const reached = seenByBroker.slice(before).some(t => t.indexOf('zhhn/Set/EmsSet/') === 0);
    check('匿名客户端下发被丢弃（只读模式）', !reached);
    check('只读拦截后匿名连接保持在线', pageAnon.connected === true);
    const health1 = await waitHealthz(gwPort, 3000);
    check('/healthz 记录了丢弃次数', health1.deniedPublish >= 1, 'deniedPublish=' + health1.deniedPublish);

    /* 4.4 新开页面立即拿到各主题最后一条（retainLast，先挂监听再订阅） */
    pageLate = await connect('ws://127.0.0.1:' + gwPort + '/mqtt', { clientId: 'test-page-late' });
    const snapWait = waitMsg(pageLate, (t, o) => t === 'zhhn/Post/PeriodReport/' + SN && o && o.identifier === 'PeriodReport', 3000, '新客户端快照');
    pageLate.subscribe('zhhn/Post/PeriodReport/#', { qos: 1 });
    const snap = await snapWait;
    check('新打开页面立即收到最后一条快照', !!snap.obj, snap.topic);

    /* ---------- 5. 登录后可下发 ---------- */
    pageAuth = await connect('ws://127.0.0.1:' + gwPort + '/mqtt', { clientId: 'test-page-auth', username: 'webuser', password: 'webpass' });
    await new Promise(r => pageAuth.subscribe('#', { qos: 1 }, r));
    const topicSet = 'zhhn/Set/EmsSet/' + SN;
    const downWait = waitMsg(device, t => t === topicSet, 4000, '下发到达设备');
    pageAuth.publish(topicSet, JSON.stringify({ identifier: 'EmsSet', Tag: [{ deviceTag: 'EMS', wayName: 'OnOff', varValue: '1' }] }), { qos: 1 });
    const down = await downWait;
    check('登录客户端下发可到达设备', !!down.obj && !!down.obj.Tag, down.topic);

    /* ---------- 6. 防环：上游报文不会经网关回发 ---------- */
    device.publish('zhhn/Post/PeriodReport/' + SN, JSON.stringify({ identifier: 'PeriodReport', SN, data: [{ deviceType: 'PCS', tags: { ActivePower: '-1' } }], time: 3 }), { qos: 1 });
    await sleep(1200);
    const reportAtBroker = seenByBroker.filter(t => t === 'zhhn/Post/PeriodReport/' + SN).length;
    check('设备两次上报在 broker 恰好各一次（无环路重发）', reportAtBroker === 2, 'broker 收到 ' + reportAtBroker + ' 次');
    const gwUpReports = (gwLog.match(/↑ zhhn\/Post\/PeriodReport\//g) || []).length;
    check('网关未把上游报文回发（日志无对应 ↑）', gwUpReports === 0, '↑ 次数 ' + gwUpReports);

    /* ---------- 7. 错误密码被拒 ---------- */
    let badRejected = false;
    try {
      const bad = await connect('ws://127.0.0.1:' + gwPort + '/mqtt', { clientId: 'test-bad', username: 'webuser', password: 'wrong' });
      bad.end(true);
    } catch (_) { badRejected = true; }
    check('错误密码连接被拒绝', badRejected);

    /* ---------- 8. 收尾统计 ---------- */
    const health2 = await waitHealthz(gwPort, 3000);
    check('/healthz 统计正常', health2.msgsIn > 0 && health2.msgsOut >= 1 && health2.loginReplies >= 1,
      'in=' + health2.msgsIn + ' out=' + health2.msgsOut + ' loginReply=' + health2.loginReplies + ' clients=' + health2.clients);

  } catch (e) {
    check('测试执行', false, e.message);
  } finally {
    try { pageAnon && pageAnon.end(true); } catch (_) {}
    try { pageAuth && pageAuth.end(true); } catch (_) {}
    try { pageLate && pageLate.end(true); } catch (_) {}
    try { device && device.end(true); } catch (_) {}
    await sleep(200);
    try { gw && gw.kill(); } catch (_) {}
    await sleep(300);
    try { devBroker && devBroker.close(); } catch (_) {}
    try { devServer && devServer.close(); } catch (_) {}
    try { fs.unlinkSync(cfgPath); } catch (_) {}
  }

  const failed = results.filter(r => !r.pass);
  console.log('\n共 ' + results.length + ' 项，通过 ' + (results.length - failed.length) + ' 项' + (failed.length ? '，失败 ' + failed.length + ' 项' : ''));
  failed.forEach(f => console.log('  × ' + f.name));
  process.exit(failed.length ? 1 : 0);
})();
