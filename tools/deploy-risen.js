'use strict';
/* ============================================================
 * 部署「日升云储能接入服务」到自己的服务器
 *
 *   用法：node tools/deploy-risen.js
 *   凭据来源：tools/risen.config.json（已被 .gitignore 排除）
 *
 *   · 上传 risen-cloud-service.js 到 /opt/lichu-risen
 *   · 种子凭据写 /etc/lichu-risen.env（600）——token 只存在服务器上
 *   · 续期后的 token 由服务自己写在 /var/lib/lichu-risen/risen.config.json，
 *     所以每次部署会把这个文件删掉，让种子凭据重新生效
 *   · systemd: lichu-risen.service（开机自启、崩溃重拉）
 *   · nginx: mqtt.ykdesign.top 加 /risen 反代到 127.0.0.1:8097
 *   · 自测：本机 /risen/healthz、https://mqtt.ykdesign.top/risen/healthz
 * ============================================================ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('ssh2');

const cfgPath = path.join(__dirname, 'risen.config.json');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (_) {}
if (!cfg.accessToken || !cfg.refreshToken) {
  console.error('缺少凭据：请先跑 node tools/risen-cloud-token.js 导出到 ' + cfgPath);
  process.exit(1);
}

const HOST = process.env.SRV_HOST || '43.129.27.206';
const USER = process.env.SRV_USER || 'ubuntu';
/* 服务器密码只从环境变量取，不写进代码（仓库是公开的） */
const PASS = process.env.SRV_PASS || '';
if (!PASS) { console.error('缺少环境变量 SRV_PASS（服务器密码）'); process.exit(1); }
const DIR = '/opt/lichu-risen';
const DATA_DIR = '/var/lib/lichu-risen';
const PORT = 8097;
const NGINX_SITE = '/etc/nginx/sites-available/mqtt.ykdesign.top';
const DOMAIN = 'mqtt.ykdesign.top';

function exec(conn, cmd) {
  return new Promise((res, rej) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return rej(err);
      let out = '';
      stream.on('data', d => out += d);
      stream.stderr.on('data', d => out += d);
      stream.on('close', code => (code === 0 ? res(out) : rej(new Error('命令失败(' + code + ')：' + out.slice(-600)))));
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
  await new Promise((res, rej) => conn.on('ready', res).on('error', rej)
    .connect({ host: HOST, port: 22, username: USER, password: PASS, tryKeyboard: true, readyTimeout: 20000 }));
  console.log('已连接 ' + HOST);
  try {
    await exec(conn, 'sudo mkdir -p ' + DIR + ' ' + DATA_DIR + ' && sudo chown -R ' + USER + ':' + USER + ' ' + DIR + ' ' + DATA_DIR);
    await put(conn, path.join(__dirname, 'risen-cloud-service.js'), DIR + '/risen-cloud-service.js');
    console.log('已上传 risen-cloud-service.js');

    /* 服务器上已经在跑、数据正常时，不要用本地这份（可能已经过期的）凭据去覆盖它 */
    let remoteOk = false;
    try {
      remoteOk = /"ok":true/.test(await exec(conn, 'curl -s -m 8 http://127.0.0.1:' + PORT + '/risen/healthz || true'));
    } catch (_) {}
    const FORCE = process.argv.indexOf('--force') >= 0;
    const seedTokens = !remoteOk || FORCE;

    /* 账号密码是固定的（不轮换），每次部署都写；token 只在需要时当种子写 */
    const q = s => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    const lines = [];
    if (seedTokens) {
      lines.push('RISEN_ACCESS_TOKEN=' + cfg.accessToken);
      lines.push('RISEN_REFRESH_TOKEN=' + cfg.refreshToken);
    }
    lines.push('RISEN_TENANT_ID=' + (cfg.tenantId || '214'));
    if (cfg.plantId) lines.push('RISEN_PLANT_ID=' + cfg.plantId);
    if (cfg.username) lines.push('RISEN_USERNAME=' + cfg.username);
    if (cfg.password) lines.push('RISEN_PASSWORD=' + q(cfg.password));
    lines.push('RISEN_CONFIG=' + DATA_DIR + '/risen.config.json');
    lines.push('RISEN_PORT=' + PORT);
    lines.push('RISEN_DIR=' + DATA_DIR);
    lines.push('RISEN_POLL=300');
    lines.push('RISEN_DAYS=3');

    await put(conn, tmp('lichu-risen.env', lines.join('\n') + '\n'), '/tmp/lichu-risen.env');
    await exec(conn, 'sudo mv /tmp/lichu-risen.env /etc/lichu-risen.env && sudo chmod 600 /etc/lichu-risen.env');
    console.log('凭据已写入 /etc/lichu-risen.env（600）' +
      (cfg.username ? (cfg.password ? '：账号 + 密码已配，可自动登录' : '：只有账号，缺密码') : '：没配账号密码（只能靠 refreshToken）') +
      (seedTokens ? '' : '；token 沿用服务器上的（远端本来就健康）'));
    if (seedTokens) {
      await exec(conn, 'rm -f ' + DATA_DIR + '/risen.config.json');    /* 让这次部署的种子凭据生效 */
    }

    const unit = [
      '[Unit]',
      'Description=力储未来 东方日升日升云储能接入服务',
      'After=network-online.target',
      '',
      '[Service]',
      'User=' + USER,
      'WorkingDirectory=' + DIR,
      'EnvironmentFile=/etc/lichu-risen.env',
      'ExecStart=/usr/bin/node ' + DIR + '/risen-cloud-service.js',
      'Restart=always',
      'RestartSec=5',
      '',
      '[Install]',
      'WantedBy=multi-user.target'
    ].join('\n') + '\n';
    await put(conn, tmp('lichu-risen.service', unit), '/tmp/lichu-risen.service');
    await exec(conn, 'sudo mv /tmp/lichu-risen.service /etc/systemd/system/lichu-risen.service && '
      + 'rm -f ' + DATA_DIR + '/risen.config.json && '          /* 让这次部署的种子凭据生效 */
      + 'sudo systemctl daemon-reload && sudo systemctl enable lichu-risen >/dev/null 2>&1; sudo systemctl restart lichu-risen; sleep 3; systemctl is-active lichu-risen');
    console.log('systemd：' + (await exec(conn, 'systemctl is-active lichu-risen')).trim());

    /* nginx /risen */
    await exec(conn, 'sudo cp ' + NGINX_SITE + ' ' + NGINX_SITE + '.bak.risen.$(date +%Y%m%d%H%M)');
    const has = (await exec(conn, "sudo grep -c 'location /risen' " + NGINX_SITE + ' || true')).trim();
    if (has === '0') {
      await exec(conn, "sudo sed -i '/location \\/history {/i\\    location /risen { proxy_pass http://127.0.0.1:" + PORT + "; }' " + NGINX_SITE);
    }
    await exec(conn, 'sudo nginx -t && sudo systemctl reload nginx');
    console.log('nginx 已加 /risen（反代 127.0.0.1:' + PORT + '）');

    console.log('\n—— 自测 ——');
    try {
      console.log('本机 /risen/healthz：' + (await exec(conn, 'curl -s -m 8 http://127.0.0.1:' + PORT + '/risen/healthz')).trim());
    } catch (e) { console.log('本机自测失败：' + e.message); }
    try {
      console.log('https /risen/healthz：' + (await exec(conn, 'curl -s -m 10 https://' + DOMAIN + '/risen/healthz')).trim());
    } catch (e) { console.log('https 自测失败：' + e.message); }
    try {
      console.log('https /risen/summary：' + (await exec(conn, 'curl -s -m 12 https://' + DOMAIN + '/risen/summary | head -c 500')).trim());
    } catch (e) { console.log('summary 自测失败：' + e.message); }

    console.log('\n完成。日志：journalctl -u lichu-risen -f');
    console.log('别忘了：node tools/deploy-site.js 把页面（js/solar.js 等）传上去');
  } finally {
    conn.end();
  }
  process.exit(0);
})().catch(e => { console.error('失败：' + e.message); process.exit(1); });
