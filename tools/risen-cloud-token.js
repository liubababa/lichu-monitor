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
  let old = {};
  try { old = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (_) {}
  const cfg = Object.assign({}, old, {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken || old.refreshToken || '',
    tenantId: String(data.tenantId || old.tenantId || '214'),
    user: data.user || old.user || null,
    savedAt: new Date().toISOString()
  });
  fs.writeFileSync(OUT, JSON.stringify(cfg, null, 2));
  console.log('已写入 ' + OUT);
  console.log('  tenantId=' + cfg.tenantId + '　accessToken ' + cfg.accessToken.length +
    ' 字符　refreshToken ' + cfg.refreshToken.length + ' 字符' +
    (cfg.username ? '　（保留了已有的账号密码，可自动登录）' : ''));
}

/* ---------------- 从文件导入（服务器上用） ---------------- */
if (IMPORT) {
  save(JSON.parse(fs.readFileSync(IMPORT, 'utf8')));
  process.exit(0);
}

/* ---------------- 配置账号密码（给采集服务自动登录用） ---------------- */
if (argv.indexOf('--set-login') >= 0) {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = q => new Promise(res => rl.question(q, res));
  (async () => {
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (_) {}
    const name = (await ask('日升云账号（回车沿用 ' + (cfg.username || '空') + '）：')).trim();
    process.stdout.write('日升云密码（输入时不显示，回车沿用原值）：');
    const pwd = await new Promise(function (res) {
      const stdin = process.stdin, stdout = process.stdout;
      let buf = '';
      stdin.resume();
      stdin.setRawMode(true);
      const onData = function (ch) {
        ch = ch.toString('utf8');
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          stdin.removeListener('data', onData); stdin.setRawMode(false); stdin.pause();
          stdout.write('\n'); res(buf);
        } else if (ch === '\u0003') {          /* Ctrl+C */
          stdin.setRawMode(false); process.exit(1);
        } else if (ch === '\u007f' || ch === '\b') {
          buf = buf.slice(0, -1);
        } else buf += ch;
      };
      stdin.on('data', onData);
    });
    if (name) cfg.username = name;
    if (pwd) cfg.password = pwd;
    fs.writeFileSync(OUT, JSON.stringify(cfg, null, 2));
    rl.close();
    console.log('已写入 ' + OUT + '：账号 ' + (cfg.username || '(空)') +
      '，密码 ' + (cfg.password ? '已设置（' + cfg.password.length + ' 位）' : '未设置'));
    console.log('接着跑：node tools/deploy-risen.js   （服务器上会自动登录，不再需要人工导出 token）');
  })();
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
