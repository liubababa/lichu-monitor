'use strict';
/* ============================================================
 * 部署「阳光电源 iSolarCloud 接入服务」到自己的服务器
 *
 *   用法：node tools/deploy-solar.js
 *   凭据来源：tools/solar.config.json（已被 .gitignore 排除）
 *
 *   · 上传 solar-service.js 到 /opt/lichu-solar
 *   · 凭据写 /etc/lichu-solar.env（600）——AppKey/Secret 只存在服务器上
 *   · systemd: lichu-solar.service（开机自启、崩溃重拉）
 *   · nginx: /solar 反代到 127.0.0.1:8096
 *   · 自测：本机 /solar/healthz、https://域名/solar/healthz
 * ============================================================ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('ssh2');

const cfgPath = path.join(__dirname, 'solar.config.json');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (_) {}
if (!cfg.appkey || !cfg.secret) {
  console.error('缺少凭据：请先创建 ' + cfgPath + '，内容形如');
  console.error(JSON.stringify({
    appkey: '1D68B7E7…', secret: '8dqhh7bj…', appid: '2590', region: 'cn',
    psId: '', redirect: 'https://mqtt.ykdesign.top/solar/callback'
  }, null, 2));
  process.exit(1);
}

const HOST = process.env.SRV_HOST || '43.129.27.206';
const USER = process.env.SRV_USER || 'ubuntu';
/* 服务器密码只从环境变量取，不写进代码（仓库是公开的） */
const PASS = process.env.SRV_PASS || '';
if (!PASS) { console.error('缺少环境变量 SRV_PASS（服务器密码）'); process.exit(1); }
const DIR = '/opt/lichu-solar';
const DATA_DIR = '/var/lib/lichu-solar';
const PORT = 8096;
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
    await put(conn, path.join(__dirname, 'solar-service.js'), DIR + '/solar-service.js');
    console.log('已上传 solar-service.js');

    /* 凭据（只落在服务器上，600） */
    const env = [
      'SOLAR_APPKEY=' + cfg.appkey,
      'SOLAR_SECRET=' + cfg.secret,
      'SOLAR_APPID=' + (cfg.appid || ''),
      'SOLAR_REGION=' + (cfg.region || 'cn'),
      'SOLAR_PS_ID=' + (cfg.psId || ''),
      'SOLAR_REDIRECT=' + (cfg.redirect || ('https://' + DOMAIN + '/solar/callback')),
      'SOLAR_PORT=' + PORT,
      'SOLAR_DIR=' + DATA_DIR,
      'SOLAR_POLL=300',
      'SOLAR_DAYS=3'
    ].join('\n') + '\n';
    await put(conn, tmp('lichu-solar.env', env), '/tmp/lichu-solar.env');
    await exec(conn, 'sudo mv /tmp/lichu-solar.env /etc/lichu-solar.env && sudo chmod 600 /etc/lichu-solar.env');
    console.log('凭据已写入 /etc/lichu-solar.env（600）');

    const unit = [
      '[Unit]',
      'Description=力储未来 阳光电源 iSolarCloud 接入服务',
      'After=network-online.target',
      '',
      '[Service]',
      'User=' + USER,
      'WorkingDirectory=' + DIR,
      'EnvironmentFile=/etc/lichu-solar.env',
      'ExecStart=/usr/bin/node ' + DIR + '/solar-service.js',
      'Restart=always',
      'RestartSec=5',
      '',
      '[Install]',
      'WantedBy=multi-user.target'
    ].join('\n') + '\n';
    await put(conn, tmp('lichu-solar.service', unit), '/tmp/lichu-solar.service');
    await exec(conn, 'sudo mv /tmp/lichu-solar.service /etc/systemd/system/lichu-solar.service && '
      + 'sudo systemctl daemon-reload && sudo systemctl enable lichu-solar >/dev/null 2>&1; sudo systemctl restart lichu-solar; sleep 2; systemctl is-active lichu-solar');
    console.log('systemd：' + (await exec(conn, 'systemctl is-active lichu-solar')).trim());

    /* nginx /solar */
    await exec(conn, 'sudo cp ' + NGINX_SITE + ' ' + NGINX_SITE + '.bak.solar.$(date +%Y%m%d%H%M)');
    const has = (await exec(conn, "sudo grep -c 'location /solar' " + NGINX_SITE + ' || true')).trim();
    if (has === '0') {
      await exec(conn, "sudo sed -i '/location \\/history {/i\\    location /solar { proxy_pass http://127.0.0.1:" + PORT + "; }' " + NGINX_SITE);
    }
    await exec(conn, 'sudo nginx -t && sudo systemctl reload nginx');
    console.log('nginx 已加 /solar（反代 127.0.0.1:' + PORT + '）');

    console.log('\n—— 自测 ——');
    try {
      console.log('本机 /solar/healthz：' + (await exec(conn, 'curl -s -m 8 http://127.0.0.1:' + PORT + '/solar/healthz')).trim());
    } catch (e) { console.log('本机自测失败：' + e.message); }
    try {
      console.log('https /solar/healthz：' + (await exec(conn, 'curl -s -m 10 https://' + DOMAIN + '/solar/healthz')).trim());
    } catch (e) { console.log('https 自测失败：' + e.message); }

    console.log('\n完成。下一步：浏览器打开 https://' + DOMAIN + '/solar/authorize 完成授权（选洙边卫生院）');
    console.log('日志：journalctl -u lichu-solar -f');
  } finally {
    conn.end();
  }
  process.exit(0);
})().catch(e => { console.error('失败：' + e.message); process.exit(1); });
