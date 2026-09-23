#!/usr/bin/env node
/* ============================================================
 * 阳光电源 iSolarCloud 链路自测（"先连上"的验收脚本）
 *
 *   ① 配置检查       AppKey / Secret / Application Id / 区域
 *   ② 令牌           已授权？（没有则打印授权链接）
 *   ③ 电站列表       应能看到「洙边卫生院」
 *   ④ 电站详情       装机容量等
 *   ⑤ 设备列表       逆变器 / 通信模块（SN、状态）
 *   ⑥ 电站实时点位   当日发电、实时功率、累计发电…（原样 JSON）
 *   ⑦ 分钟级历史     近 1 小时首末点
 *
 *   用法：node tools/test-solar.js
 *        （配置读 tools/solar.config.json，或环境变量 SOLAR_*）
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const CFG_FILE = path.join(__dirname, 'solar.config.json');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch (_) {}

const C = {
  appkey: process.env.SOLAR_APPKEY || cfg.appkey || '',
  secret: process.env.SOLAR_SECRET || cfg.secret || '',
  appid: process.env.SOLAR_APPID || cfg.appid || '',
  region: process.env.SOLAR_REGION || cfg.region || 'cn',
  psId: process.env.SOLAR_PS_ID || cfg.psId || '',
  redirect: process.env.SOLAR_REDIRECT || cfg.redirect || 'https://mqtt.ykdesign.top/solar/callback',
  tokenFile: process.env.SOLAR_TOKEN_FILE || cfg.tokenFile || '',
  base: process.env.SOLAR_BASE || cfg.base || 'http://127.0.0.1:8096'
};
const REGION = {
  cn: { gateway: 'https://gateway.isolarcloud.com', auth: 'https://web3.isolarcloud.com.cn', cloudId: 1 },
  intl: { gateway: 'https://gateway.isolarcloud.com.hk', auth: 'https://web3.isolarcloud.com.hk', cloudId: 2 },
  eu: { gateway: 'https://gateway.isolarcloud.eu', auth: 'https://web3.isolarcloud.eu', cloudId: 3 }
};
const R = REGION[C.region] || REGION.cn;

const POINTS = { '83022': '当日发电量', '83024': '累计发电量', '83033': '实时功率', '83019': '功率/装机', '83005': '当日等效小时', '83016': '环境温度', '83017': '组件温度' };
const DTYPE = { 1: '逆变器', 22: '通信模块', 14: '储能', 9: '数据采集器', 43: '电池' };
const FAULT = { 1: '故障', 2: '告警', 4: '正常' };

let pass = 0, fail = 0;
function ok(n, msg) { pass++; console.log('  ✅ ' + n + '　' + (msg || '')); }
function no(n, msg) { fail++; console.log('  ❌ ' + n + '　' + (msg || '')); }
function h(t) { console.log('\n' + t); }

function loadTokens() {
  const f = C.tokenFile;
  if (!f) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; }
}

async function api(pathname, params, token) {
  const body = Object.assign({}, params, { appkey: C.appkey, lang: '_zh_CN' });
  const res = await fetch(R.gateway + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-access-key': C.secret, 'authorization': 'Bearer ' + token },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch (_) { throw new Error('返回非 JSON：' + text.slice(0, 200)); }
}

(async function main() {
  console.log('阳光电源 iSolarCloud 链路自测　区域=' + C.region + '　网关=' + R.gateway);

  h('① 配置检查');
  C.appkey ? ok('AppKey', C.appkey.slice(0, 8) + '…' + C.appkey.slice(-4)) : no('AppKey', '未配置');
  C.secret ? ok('Secret Key', C.secret.slice(0, 4) + '…' + C.secret.slice(-4)) : no('Secret Key', '未配置');
  C.appid ? ok('Application Id', C.appid) : no('Application Id', '未配置');
  ok('回调地址', C.redirect);
  if (!C.appkey || !C.secret) {
    console.log('\n配置不全，先把 tools/solar.config.json 填好（或在服务器 /etc/lichu-solar.env）');
    process.exit(1);
  }

  h('② 授权状态');
  let token = null;
  if (C.tokenFile) {
    const tk = loadTokens();
    if (tk && tk.access_token) {
      token = tk.access_token;
      const left = tk.expires_at ? Math.round((tk.expires_at - Date.now() / 1000) / 60) : null;
      ok('已有令牌', left === null ? '' : ('剩余约 ' + left + ' 分钟（过期会自动续期）'));
    } else {
      no('令牌', 'tokens.json 里没有 access_token');
    }
  } else {
    /* 本地没配 tokenFile 时，问服务端要健康状态 */
    try {
      const r = await fetch(C.base + '/solar/healthz');
      const j = await r.json();
      j.authorized ? ok('服务端已授权', '最近拉取 ' + (j.last_poll || '-')) : no('服务端未授权', j.last_error || '');
    } catch (e) { no('服务端健康检查', e.message); }
  }
  if (!token) {
    console.log('\n授权链接（在浏览器打开，选「洙边卫生院」同意授权）：');
    console.log('  ' + R.auth + '/#/authorized-app?cloudId=' + R.cloudId +
      '&applicationId=' + encodeURIComponent(C.appid) + '&redirectUrl=' + encodeURIComponent(C.redirect));
    console.log('\n（或直接访问服务端 ' + C.base + '/solar/authorize）');
    process.exit(fail ? 1 : 0);
  }

  h('③ 电站列表');
  let plants = [];
  try {
    const j = await api('/openapi/platform/queryPowerStationList', { page: 1, size: 100 }, token);
    plants = (j.result_data && j.result_data.pageList) || [];
    if (!plants.length) no('电站列表', '账号下没有可见电站（检查该账号是否绑定/授权了洙边卫生院）');
    else {
      ok('电站 ' + plants.length + ' 个');
      plants.forEach(function (p) { console.log('     · ' + (p.ps_name || '') + '　ps_id=' + p.ps_id + '　状态=' + (p.ps_status || '')); });
    }
  } catch (e) { no('电站列表', e.message); }

  const psId = C.psId || (plants[0] && String(plants[0].ps_id));
  if (!psId) { console.log('\n没有可用 ps_id，后续步骤跳过'); process.exit(fail ? 1 : 0); }
  console.log('    使用 ps_id=' + psId + (C.psId ? '（配置指定）' : '（取第一个）'));

  h('④ 电站详情');
  try {
    const j = await api('/openapi/platform/getPowerStationDetail', { ps_ids: String(psId) }, token);
    const d = ((j.result_data && j.result_data.data_list) || [])[0] || {};
    const cap = d.ps_capacity || d.capacity || d.ps_installed_capacity;
    ok('详情', (d.ps_name || '') + '　装机=' + (cap === undefined ? '（字段待确认）' : cap));
    if (cap === undefined) console.log('     返回字段：' + Object.keys(d).join(', '));
  } catch (e) { no('电站详情', e.message); }

  h('⑤ 设备列表');
  try {
    const j = await api('/openapi/platform/getDeviceListByPsId', { ps_id: String(psId), page: 1, size: 100 }, token);
    const list = (j.result_data && j.result_data.pageList) || [];
    if (!list.length) no('设备列表', '空');
    else {
      ok('设备 ' + list.length + ' 台');
      list.forEach(function (d) {
        console.log('     · ' + (DTYPE[d.device_type] || ('类型' + d.device_type)) + '　' + (d.device_name || '') +
          '　SN=' + (d.device_sn || d.device_sn_str || '') + '　状态=' + (FAULT[d.dev_fault_status] || d.dev_fault_status) +
          '　型号=' + (d.device_model_code || ''));
      });
      const inv = list.filter(function (d) { return Number(d.device_type) === 1; })[0];
      const com = list.filter(function (d) { return Number(d.device_type) === 22; })[0];
      inv ? ok('找到逆变器', inv.device_sn || '') : no('逆变器', '未找到（device_type=1）');
      com ? ok('找到通信模块', com.device_sn || '') : no('通信模块', '未找到（device_type=22）');
      if (list[0]) console.log('     设备字段：' + Object.keys(list[0]).join(', '));
    }
  } catch (e) { no('设备列表', e.message); }

  h('⑥ 电站实时点位（原样返回）');
  try {
    const ids = Object.keys(POINTS);
    const j = await api('/openapi/platform/getPowerStationRealTimeData',
      { ps_id_list: [String(psId)], point_id_list: ids, is_get_point_dict: '1' }, token);
    const row = (((j.result_data || {}).device_point_list) || [])[0] || {};
    const got = Object.keys(row).filter(function (k) { return k[0] === 'p'; });
    ok('拿到点位 ' + got.length + ' / 请求 ' + ids.length);
    got.forEach(function (k) {
      const pid = k.slice(1);
      console.log('     · ' + pid + ' ' + (POINTS[pid] || '') + ' = ' + row[k]);
    });
    if (!got.length) console.log('     原始返回：' + JSON.stringify(j).slice(0, 400));
  } catch (e) { no('实时点位', e.message); }

  h('⑦ 分钟级历史（近 1 小时）');
  try {
    const now = new Date(), from = new Date(now.getTime() - 3600e3);
    const fmt = function (d) {
      const p = function (n) { return String(n).padStart(2, '0'); };
      return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    };
    const j = await api('/openapi/platform/getPowerStationPointMinuteDataList', {
      ps_id_list: [String(psId)], points: 'p83033,p83022', is_get_point_dict: '1',
      start_time_stamp: fmt(from), end_time_stamp: fmt(now), minute_interval: '5'
    }, token);
    const rows = (j.result_data || {})[String(psId)] || [];
    rows.length ? ok('历史点 ' + rows.length + ' 个', '首=' + JSON.stringify(rows[0]).slice(0, 120) + '　末=' + JSON.stringify(rows[rows.length - 1]).slice(0, 120))
      : no('历史点', '空（原始：' + JSON.stringify(j).slice(0, 300) + '）');
  } catch (e) { no('历史点', e.message); }

  h('结果');
  console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})();
