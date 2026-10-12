#!/usr/bin/env node
/* ============================================================
 * 日升云凭据导出（refreshToken 过期时用）
 *
 *   采集服务（tools/risen-cloud-service.js）平时自己用 refreshToken 续期，
 *   但 refreshToken 也有有效期，过期后需要「用浏览器登录一次」再导出新凭据。
 *
 *   用法：
 *     node tools/risen-cloud-token.js                     # 弹出登录页，登录后自动写配置
 *     node tools/risen-cloud-token.js --exec "C:\...\msedge.exe"   # 没装 Chrome 时指一个浏览器
 *     node tools/risen-cloud-token.js --session myname     # 指定 agent-browser 会话（默认 risen-token）
 *     node tools/risen-cloud-token.js --import saved.json  # 从导出的 JSON 导入（服务器上用）
 *
 *   写入：tools/risen.config.json（已加入 .gitignore，不进仓库）
 *   把该文件拷到服务器同名位置，或用 --import 在服务器上导入。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
}

const OUT = arg('config', process.env.RISEN_CONFIG || path.join(ROOT, 'tools', 'risen.config.json'));
const SESSION = arg('session', 'risen-token');
const EXEC = arg('exec', '');
const IMPORT = arg('import', '');

/* 在页面里读 localStorage 里的登录态（ACCESS_TOKEN / REFRESH_TOKEN / tenantId） */
const EVAL = `(() => {
  const g = k => { try { return JSON.parse(JSON.parse(localStorage.getItem(k)).v); } catch (e) { return null; } };
  return 'JSONSTART' + JSON.stringify({
    accessToken: g('ACCESS_TOKEN'), refreshToken: g('REFRESH_TOKEN'),
    tenantId: g('tenantId'), user: g('user')
  }) + 'JSONEND';
})()`;

function save(data) {
  if (!data || !data.accessToken) throw new Error('没有读到 accessToken');
  const cfg = {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken || '',
    tenantId: String(data.tenantId || '214'),
    user: data.user || null,
    savedAt: new Date().toISOString()
  };
  fs.writeFileSync(OUT, JSON.stringify(cfg, null, 2));
  console.log('已写入 ' + OUT);
  console.log('  tenantId=' + cfg.tenantId + '　accessToken ' + cfg.accessToken.length +
    ' 字符　refreshToken ' + cfg.refreshToken.length + ' 字符');
}

/* ---------------- 从文件导入（服务器上用） ---------------- */
if (IMPORT) {
  save(JSON.parse(fs.readFileSync(IMPORT, 'utf8')));
  process.exit(0);
}

/* ---------------- 用浏览器登录并导出 ---------------- */
function ab(cmd, input) {
  const exe = EXEC ? ' --executable-path "' + EXEC + '"' : '';
  return execSync('agent-browser --session ' + SESSION + exe + ' ' + cmd, {
    input: input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
  });
}

function readTokens() {
  let raw = '';
  try { raw = ab('eval --stdin', EVAL); } catch (e) {
    raw = String((e.stdout || '') + (e.stderr || ''));
  }
  /* eval 的输出是「被 JSON 转义过的字符串」+ 可能带一行 agent-browser 提示 */
  const i = raw.indexOf('JSONSTART');
  const j = raw.indexOf('JSONEND');
  if (i < 0 || j < 0) return null;
  const inner = raw.slice(i + 'JSONSTART'.length, j).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  try { return JSON.parse(inner); } catch (_) { return null; }
}

console.log('打开日升云登录页（会话 ' + SESSION + '）…');
try {
  ab('open https://cloud.risen.com/');
} catch (e) {
  console.error('打不开浏览器：' + String(e.message || e).split('\n')[0]);
  console.error('没装 Chrome 的话，加参数指定浏览器：--exec "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"');
  process.exit(1);
}

console.log('请在弹出的窗口里登录 cloud.risen.com，登录成功后本脚本会自动导出凭据（最多等 10 分钟）。');
const deadline = Date.now() + 10 * 60 * 1000;
(function tick() {
  const data = readTokens();
  if (data && data.accessToken) {
    save(data);
    console.log('完成。采集服务下次启动/续期时就会用这对凭据。');
    return;
  }
  if (Date.now() > deadline) {
    console.error('超时：没有读到登录态。确认已登录成功后再跑一次即可。');
    process.exit(1);
  }
  setTimeout(tick, 3000);
})();
