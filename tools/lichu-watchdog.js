#!/usr/bin/env node
/* ============================================================
 * 站点看门狗：每分钟探测三站接入链路，异常持续 5 分钟就推企业微信群机器人。
 *
 *   检查项：
 *     · 洙边日升云   8097 /risen/healthz        ok / last_error / auth_block / last_poll 新鲜度
 *     · 洙边阳光云   8096 /solar/summary        updated_at 新鲜度（>15min 停更）+ need_reauth
 *     · 峻涌阳光云   8098 /junyong/pv/summary   同上
 *     · 历史采样     8095 /healthz              mqtt 连接 + 当日 jsonl 落盘新鲜度（东明 CCU 活性代理）
 *     · MQTT 网关    8090 /healthz              upstream connected + msgsIn 递增（设备在发流）
 *
 *   推送：企业微信群机器人 webhook（/etc/lichu-watchdog.env 里 WECOM_WEBHOOK）。
 *         没配置就只写日志——仍然比"挂了几天没人知道"强。
 *   节流：每项异常只在转入异常时发一次，持续 60 分钟后提醒一次；恢复时发"已恢复"。
 *
 *   用法：node lichu-watchdog.js --listen 8094
 *   env： WECOM_WEBHOOK / WATCHDOG_INTERVAL
 * ============================================================ */
'use strict';

const http = require('http');
const path = require('path');

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
}
const OPT = {
  interval: parseInt(arg('interval', process.env.WATCHDOG_INTERVAL || '60'), 10) * 1000,
  listen: parseInt(arg('listen', process.env.WATCHDOG_PORT || '8094'), 10),
  /* 告警通道三选一（按配置的环境变量自动识别，2026-11-21）：
     · 企业微信群机器人：WECOM_WEBHOOK=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx
     · Server酱（微信公号"方糖"收）：SERVERCHAN_KEY=SCTxxxx
     · PushPlus（微信公号"pushplus"收）：PUSHPLUS_TOKEN=xxx */
  webhook: process.env.WECOM_WEBHOOK || '',
  serverchanKey: process.env.SERVERCHAN_KEY || '',
  pushplusToken: process.env.PUSHPLUS_TOKEN || '',
  wxpusherSpt: process.env.WXPUSHER_SPT || '',
  staleMin: 15,            // updated_at 超过多少分钟算停更
  alertAfterMin: 5,        // 异常持续多少分钟才推送（避免抖动）
  remindMin: 60,           // 异常持续多久后重复提醒
  quietMin: 30             // 两次推送的最小间隔
};
function alertChannel() {
  if (OPT.webhook) return 'wecom';
  if (OPT.wxpusherSpt) return 'wxpusher';
  if (OPT.serverchanKey) return 'serverchan';
  if (OPT.pushplusToken) return 'pushplus';
  return 'none';
}

function log(line) { console.log(new Date().toTimeString().slice(0, 8) + '  ' + line); }
function now() { return Date.now(); }
function fmtT(ms) { return new Date(ms || now()).toTimeString().slice(0, 5); }

function fetchT(url, ms) {
  const ac = new AbortController();
  const t = setTimeout(function () { try { ac.abort(); } catch (_) {} }, ms || 8000);
  return fetch(url, { signal: ac.signal, cache: 'no-store' }).finally(function () { clearTimeout(t); });
}
async function getJson(url, ms) {
  const res = await fetchT(url, ms);
  const j = await res.json();
  return j;
}
function ageMin(s) {
  if (!s) return null;
  const t = Date.parse(s);
  return isFinite(t) ? (now() - t) / 60000 : null;
}
function parseCST(s) {
  if (!s) return null;
  const t = Date.parse(String(s).replace(' ', 'T') + '+08:00');
  return isFinite(t) ? t : null;
}

/* ---------------- 检查项 ---------------- */
const CHECKS = [
  {
    name: '洙边日升云',
    probe: async function () {
      const d = await getJson('http://127.0.0.1:8097/risen/healthz');
      const lastPollAge = ageMin(d.last_poll);
      if (d.auth_blocked) return { ok: false, why: '账户被锁定（auth_block），自动登录已暂停' };
      if (d.last_error) return { ok: false, why: 'last_error：' + d.last_error };
      if (lastPollAge === null || lastPollAge > 5) return { ok: false, why: '轮询停摆（最后成功 ' + fmtT(parseCST(d.last_poll)) + '）' };
      return { ok: true, why: '正常 · 最后轮询 ' + fmtT(parseCST(d.last_poll)) };
    }
  },
  {
    name: '洙边阳光云',
    probe: async function () {
      const j = await getJson('http://127.0.0.1:8096/solar/summary');
      const d = j.data || {};
      const a = ageMin(d.updated_at);
      if (!j.ok) return { ok: false, why: 'summary ok=false' + (j.last_error ? '（' + j.last_error + '）' : '') };
      if (d.need_reauth) return { ok: false, why: '阳光云授权失效，需要重新授权' };
      if (a === null || a > OPT.staleMin) return { ok: false, why: '数据停更 ' + (a === null ? '?' : Math.round(a)) + ' 分钟' };
      return { ok: true, why: '正常 · 更新 ' + fmtTimeCST(d.updated_at) };
    }
  },
  {
    name: '峻涌阳光云',
    probe: async function () {
      const j = await getJson('http://127.0.0.1:8098/solar/summary');
      const d = j.data || {};
      const a = ageMin(d.updated_at);
      if (!j.ok) return { ok: false, why: 'summary ok=false' + (j.last_error ? '（' + j.last_error + '）' : '') };
      if (d.need_reauth) return { ok: false, why: '阳光云授权失效，需要重新授权' };
      if (a === null || a > OPT.staleMin) return { ok: false, why: '数据停更 ' + (a === null ? '?' : Math.round(a)) + ' 分钟' };
      return { ok: true, why: '正常 · 更新 ' + fmtTimeCST(d.updated_at) };
    }
  },
  {
    name: '历史采样（东明CCU活性代理）',
    probe: async function () {
      const j = await getJson('http://127.0.0.1:8095/healthz');
      if (!j.ok) return { ok: false, why: 'history 服务异常' };
      if (j.mqtt && j.mqtt !== 'connected') return { ok: false, why: 'MQTT ' + j.mqtt };
      /* 当日 jsonl 的 mtime 超过 5 分钟没动 = 东明 CCU 断流 */
      const fs = require('fs');
      const dir = j.dir;
      const today = new Date();
      const f = path.join(dir, today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0') + '.jsonl');
      if (fs.existsSync(f)) {
        const age = (now() - fs.statSync(f).mtimeMs) / 60000;
        if (age > 5) return { ok: false, why: 'CCU 断流（落盘 ' + Math.round(age) + ' 分钟没更新）' };
      } else {
        return { ok: false, why: '今日还没有采样文件' };
      }
      return { ok: true, why: '正常 · 采样在滚动' };
    }
  },
  {
    name: 'MQTT 网关',
    probe: async function () {
      const j = await getJson('http://127.0.0.1:8090/healthz');
      if (j.upstream !== 'connected') return { ok: false, why: '上游 mosquitto ' + j.upstream };
      const prev = state.msgsInPrev;
      state.msgsInPrev = j.msgsIn;
      if (prev !== null && prev !== undefined && j.msgsIn === prev) {
        return { ok: false, why: '报文流量停了（msgsIn 不再增长，设备可能集体断流）' };
      }
      return { ok: true, why: '正常 · msgsIn ' + j.msgsIn };
    }
  }
];
function fmtTimeCST(iso) {
  const t = iso ? Date.parse(iso) : NaN;
  return isFinite(t) ? new Date(t).toTimeString().slice(0, 5) : '--';
}

/* ---------------- 状态机 ---------------- */
const state = { checks: {}, msgsInPrev: null, started: now() };
function st(name) {
  return state.checks[name] || (state.checks[name] = { ok: null, since: 0, why: '', alertSent: false, lastAlert: 0 });
}

async function pushWeCom(md) {
  const ch = alertChannel();
  if (ch === 'none') { log('（未配置告警通道，仅记录）' + md.replace(/\n/g, ' | ')); return false; }
  const ac = new AbortController();
  const t = setTimeout(function () { try { ac.abort(); } catch (_) {} }, 10000);
  try {
    let res;
    if (ch === 'wecom') {
      res = await fetch(OPT.webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'markdown', markdown: { content: md } }),
        signal: ac.signal
      });
      const j = await res.json().catch(function () { return {}; });
      if (j.errcode === 0) return true;
      log('wecom 返回异常：' + JSON.stringify(j).slice(0, 160));
      return false;
    }
    if (ch === 'wxpusher') {
      /* 极简推送 SPT：免费免实名，summary=标题 content=正文(markdown) */
      res = await fetch('https://wxpusher.zjiecode.com/api/send-message/simple-push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          spt: OPT.wxpusherSpt,
          summary: md.split('\n')[0].replace(/\*/g, '').slice(0, 99),
          content: md,
          contentType: 3
        }),
        signal: ac.signal
      });
      const j = await res.json().catch(function () { return {}; });
      if (j.code === 1000) return true;
      log('wxpusher 返回异常：' + JSON.stringify(j).slice(0, 160));
      return false;
    }
    if (ch === 'serverchan') {
      res = await fetch('https://sctapi.ftqq.com/' + OPT.serverchanKey + '.send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ title: md.split('\n')[0].replace(/\*/g, ''), desp: md }).toString(),
        signal: ac.signal
      });
      const j = await res.json().catch(function () { return {}; });
      if (j.code === 0) return true;
      log('serverchan 返回异常：' + JSON.stringify(j).slice(0, 160));
      return false;
    }
    /* pushplus */
    res = await fetch('http://www.pushplus.plus/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: OPT.pushplusToken, title: md.split('\n')[0].replace(/\*/g, ''), content: md, template: 'markdown' }),
      signal: ac.signal
    });
    const j = await res.json().catch(function () { return {}; });
    if (j.code === 200) return true;
    log('pushplus 返回异常：' + JSON.stringify(j).slice(0, 160));
    return false;
  } catch (e) {
    log('告警推送失败（' + ch + '）：' + e.message);
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function runOnce() {
  for (const chk of CHECKS) {
    const s = st(chk.name);
    let r = null;
    try { r = await chk.probe(); }
    catch (e) { r = { ok: false, why: '探测失败：' + e.message }; }
    const was = s.ok;
    s.why = r.why || '';
    if (r.ok) {
      if (was === false && s.alertSent) {
        pushWeCom('**✅ ' + chk.name + ' 已恢复**\n> ' + s.why + '\n> 断了 ' + Math.round((now() - s.since) / 60000) + ' 分钟');
      }
      s.ok = true; s.since = 0; s.alertSent = false;
    } else {
      if (was !== false) s.since = now();               // 记录转入异常的时刻
      s.ok = false;
      const badMin = (now() - s.since) / 60000;
      const shouldAlert = badMin >= OPT.alertAfterMin
        && (!s.alertSent || (now() - s.lastAlert) > OPT.remindMin * 60000)
        && (now() - s.lastAlert) > OPT.quietMin * 60000;
      if (shouldAlert) {
        s.alertSent = true; s.lastAlert = now();
        pushWeCom('**⚠ ' + chk.name + ' 异常**\n> ' + s.why + '\n> 已持续 ' + Math.round(badMin) + ' 分钟（' + fmtT() + '）');
      }
    }
    log('[' + chk.name + '] ' + (s.ok ? 'OK' : '异常 ' + Math.round((now() - s.since) / 60000) + ' 分钟') + ' · ' + s.why);
  }
}

/* ---------------- HTTP（看门狗自身的 healthz，方便远程探活） ---------------- */
const server = http.createServer(function (req, res) {
  res.setHeader('cache-control', 'no-store');
  if (req.url === '/healthz') {
    const out = { ok: true, started: new Date(state.started).toISOString(), channel: alertChannel(), checks: [] };
    for (const chk of CHECKS) {
      const s = st(chk.name);
      out.checks.push({ name: chk.name, ok: s.ok, since: s.since || null, why: s.why, alertSent: s.alertSent });
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(out, null, 1));
  }
  res.writeHead(404); res.end();
});

server.listen(OPT.listen, '127.0.0.1', function () {
  log('看门狗已启动：http://127.0.0.1:' + OPT.listen + '/healthz　间隔 ' + OPT.interval / 1000 + 's　告警通道 ' + alertChannel());
});
server.on('error', function (e) { log('监听失败：' + e.message); process.exit(1); });

runOnce().catch(function (e) { log('首轮异常：' + e.message); });
setInterval(function () { runOnce().catch(function (e) { log('轮次异常：' + e.message); }); }, OPT.interval);
process.on('SIGTERM', function () { server.close(function () { process.exit(0); }); });
process.on('SIGINT', function () { server.close(function () { process.exit(0); }); });
