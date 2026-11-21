'use strict';
/* ============================================================
 * 部署「日升云储能接入服务 · 热备实例」lichu-risen-b
 *
 *   主实例（lichu-risen，8097，nginx /risen）挂掉 / 授权失效时，
 *   备实例（8099，nginx /risen-b）用**第二个日升云账号**顶上，前端自动切换。
 *
 *   用法：node tools/deploy-risen-b.js
 *   凭据：tools/risen-b.config.json（.gitignore 排除，用户自备第二个日升云账号）
 *     { "username": "...", "password": "...", "tenantId": "214", "plantId": "120859" }
 *     —— 账号密码即可（服务支持自动登录），token 种子可选。
 *   登录方式：SSH 密钥（~/.ssh/id_ed25519 已部署到服务器）；没有密钥时走 SRV_PASS。
 * ============================================================ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('ssh2');

const cfgPath = path.join(__dirname, 'risen-b.config.json');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (_) {}
if (!cfg.username || !cfg.password) {
  console.error('缺少备用账号：请创建 ' + cfgPath + '（{"username":"第二个日升云账号","password":"密码"}）');
  process.exit(1);
}

const HOST = process.env.SRV_HOST || '43.129.27.206';
const USER = process.env.SRV_USER || 'ubuntu';
const PASS = process.env.SRV_PASS || '';
let KEY = null;
try { KEY = fs.readFileSync(path.join(os.homedir(), '.ssh', 'id_ed25519'), 'utf8'); } catch (_) {}
if (!KEY && !PASS) { console.error('既没有 SSH 密钥也没有 SRV_PASS，无法登录'); process.exit(1); }

const DIR = '/opt/lichu-risen-b';
const DATA_DIR = '/var/lib/lichu-risen-b';
const PORT = 8099;
const NGINX_SITE = '/etc/nginx/sites-available/mqtt.ykdesign.top';
const DOMAIN = 'mqtt.ykdesign.top';

function exec(conn, cmd) {
  return new Promise((res, rej) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return rej(err);
      let out = '';
      stream.on('data', d => out += d);
      stream.stderr.on('data', d => out += d);
      stream.on('close', code => (code === 0 ? res(out) : rej(new Error('命令失败(' + code + ')：' + out.slice(-500)))));
    });
  });
}
function put(conn, local, remote) {
  return new Promise((res, rej) => {
    conn.sftp((e, sftp) => {
      if (e) return rej(e);
      sftp.fastPut(local, remote, err => { sftp.end(); err ? rej(new Error(remote + ' → ' + err.message)) : res(); });
    });
  });
}
function tmp(name, content) {
  const p = path.join(os.tmpdir(), name);
  fs.writeFileSync(p, content);
  return p;
}

(async () => {
  const conn = new Client();
  const authOpt = KEY
    ? { host: HOST, port: 22, username: USER, privateKey: KEY, tryKeyboard: true, readyTimeout: 20000 }
    : { host: HOST, port: 22, username: USER, password: PASS, tryKeyboard: true, readyTimeout: 20000 };
  await new Promise((res, rej) => conn.on('ready', res).on('error', rej).connect(authOpt));
  console.log('已连接 ' + HOST + '（' + (KEY ? '密钥' : '密码') + '认证）');
  try {
    await exec(conn, 'sudo mkdir -p ' + DIR + ' ' + DATA_DIR + ' && sudo chown -R ' + USER + ':' + USER + ' ' + DIR + ' ' + DATA_DIR);
    await put(conn, path.join(__dirname, 'risen-cloud-service.js'), DIR + '/risen-cloud-service.js');
    console.log('已上传 risen-cloud-service.js（与主实例同一份代码）');

    /* 备实例只写账号密码（自动登录），不写 token 种子——两实例的 token 互不干扰 */
    const q = s => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    const lines = [
      'RISEN_USERNAME=' + cfg.username,
      'RISEN_PASSWORD=' + q(cfg.password),
      'RISEN_TENANT_ID=' + (cfg.tenantId || '214')
    ];
    if (cfg.plantId) lines.push('RISEN_PLANT_ID=' + cfg.plantId);
    if (cfg.accessToken) lines.push('RISEN_ACCESS_TOKEN=' + cfg.accessToken);
    if (cfg.refreshToken) lines.push('RISEN_REFRESH_TOKEN=' + cfg.refreshToken);
    lines.push('RISEN_CONFIG=' + DATA_DIR + '/risen.config.json');
    lines.push('RISEN_PORT=' + PORT);
    lines.push('RISEN_DIR=' + DATA_DIR);
    lines.push('RISEN_POLL=60');
    lines.push('RISEN_DAYS=3');
    await put(conn, tmp('lichu-risen-b.env', lines.join('\n') + '\n'), '/tmp/lichu-risen-b.env');
    await exec(conn, 'sudo mv /tmp/lichu-risen-b.env /etc/lichu-risen-b.env && sudo chmod 600 /etc/lichu-risen-b.env');
    console.log('备用凭据已写入 /etc/lichu-risen-b.env（600）');

    const unit = [
      '[Unit]',
      'Description=力储未来 日升云储能接入服务 · 热备实例（第二账号）',
      'After=network-online.target',
      '',
      '[Service]',
      'User=' + USER,
      'WorkingDirectory=' + DIR,
      'EnvironmentFile=/etc/lichu-risen-b.env',
      'ExecStart=/usr/bin/node ' + DIR + '/risen-cloud-service.js',
      'Restart=always',
      'RestartSec=5',
      '',
      '[Install]',
      'WantedBy=multi-user.target'
    ].join('\n') + '\n';
    await put(conn, tmp('lichu-risen-b.service', unit), '/tmp/lichu-risen-b.service');
    await exec(conn, 'sudo mv /tmp/lichu-risen-b.service /etc/systemd/system/lichu-risen-b.service && '
      + 'sudo systemctl daemon-reload && sudo systemctl enable lichu-risen-b >/dev/null 2>&1; sudo systemctl restart lichu-risen-b; sleep 3');
    console.log('systemd：' + (await exec(conn, 'systemctl is-active lichu-risen-b')).trim());

    /* nginx /risen-b */
    await exec(conn, 'sudo cp ' + NGINX_SITE + ' ' + NGINX_SITE + '.bak.risenb.$(date +%Y%m%d%H%M)');
    const has = (await exec(conn, "sudo grep -c 'location /risen-b' " + NGINX_SITE + ' || true')).trim();
    if (has === '0') {
      await exec(conn, "sudo sed -i '/location \\/risen {/i\\    location /risen-b { proxy_pass http://127.0.0.1:" + PORT + "; }' " + NGINX_SITE);
    }
    await exec(conn, 'sudo nginx -t && sudo systemctl reload nginx');
    console.log('nginx 已加 /risen-b（反代 127.0.0.1:' + PORT + '）');

    console.log('\n—— 自测 ——');
    try { console.log('备实例 healthz：' + (await exec(conn, 'curl -s -m 8 http://127.0.0.1:' + PORT + '/risen/healthz')).trim()); }
    catch (e) { console.log('本机自测失败：' + e.message); }
    try { console.log('https /risen-b/healthz：' + (await exec(conn, 'curl -s -m 10 https://' + DOMAIN + '/risen-b/healthz')).trim()); }
    catch (e) { console.log('https 自测失败：' + e.message); }

    console.log('\n完成。前端已在主实例异常时自动切换到 /risen-b/（见 js/solar.js）');
  } finally {
    conn.end();
  }
  process.exit(0);
})().catch(e => { console.error('失败：' + e.message); process.exit(1); });
