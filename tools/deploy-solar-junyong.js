'use strict';
/* ============================================================
 * 部署「阳光电源 iSolarCloud 接入服务 · 第二路（峻涌站 · 另一个阳光云账号）」
 *
 *   用途：新电站「山东峻涌光储电站」的光伏数据来自**另一个**阳光云账号，
 *         和洙边那一路（lichu-solar / 8096 / /solar）完全隔离：
 *         独立目录、独立凭据文件、独立 token、独立端口，互不影响。
 *
 *   用法：node tools/deploy-solar-junyong.js
 *   凭据来源：tools/solar.config.json（同一套应用，别的账号用「授权」授权它）
 *             cfg.psId2 = 峻涌站的 ps_id；留空 = 自动取该账号下第一个电站
 *
 *   · 上传 solar-service.js 到 /opt/lichu-solar-junyong
 *   · 凭据写 /etc/lichu-solar-junyong.env（600）
 *   · systemd: lichu-solar-junyong.service（开机自启、崩溃重拉）
 *   · nginx: /junyong/pv/ 反代到 127.0.0.1:8098（/junyong/pv/xxx → /solar/xxx）
 *   · 自测：本机 8098 /solar/healthz
 *
 *   首次授权（一次性）：把 nginx 的 = /solar/callback 临时指到 8098，
 *   用峻涌账号在浏览器里点「同意授权」，完成后撤掉该临时块。
 * ============================================================ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('ssh2');

const cfgPath = path.join(__dirname, 'solar.config.json');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (_) {}
if (!cfg.appkey || !cfg.secret) {
  console.error('缺少凭据：请先创建 ' + cfgPath + '（AppKey/Secret/AppId）');
  process.exit(1);
}

const HOST = process.env.SRV_HOST || '43.129.27.206';
const USER = process.env.SRV_USER || 'ubuntu';
/* 服务器密码只从环境变量取，不写进代码（仓库是公开的） */
const PASS = process.env.SRV_PASS || '';
if (!PASS) { console.error('缺少环境变量 SRV_PASS（服务器密码）'); process.exit(1); }
const DIR = '/opt/lichu-solar-junyong';
const DATA_DIR = '/var/lib/lichu-solar-junyong';
const PORT = 8098;
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
    console.log('已上传 solar-service.js → ' + DIR);

    /* 凭据（同一套应用；psId2 未配置就留空，服务自动取账号下第一个电站） */
    const env = [
      'SOLAR_APPKEY=' + cfg.appkey,
      'SOLAR_SECRET=' + cfg.secret,
      'SOLAR_APPID=' + (cfg.appid || ''),
      'SOLAR_REGION=' + (cfg.region || 'cn'),
      'SOLAR_PS_ID=' + (cfg.psId2 || ''),
      'SOLAR_REDIRECT=' + (cfg.redirect || ('https://' + DOMAIN + '/solar/callback')),
      'SOLAR_PORT=' + PORT,
      'SOLAR_DIR=' + DATA_DIR,
      'SOLAR_POLL=300',
      'SOLAR_DAYS=3'
    ].join('\n') + '\n';
    await put(conn, tmp('lichu-solar-junyong.env', env), '/tmp/lichu-solar-junyong.env');
    await exec(conn, 'sudo mv /tmp/lichu-solar-junyong.env /etc/lichu-solar-junyong.env && sudo chmod 600 /etc/lichu-solar-junyong.env');
    console.log('凭据已写入 /etc/lichu-solar-junyong.env（600）' + (cfg.psId2 ? '　ps_id=' + cfg.psId2 : '　ps_id 未配置（自动取第一个电站）'));

    const unit = [
      '[Unit]',
      'Description=力储未来 阳光电源 iSolarCloud 接入服务（峻涌站 · 第二路）',
      'After=network-online.target',
      '',
      '[Service]',
      'User=' + USER,
      'WorkingDirectory=' + DIR,
      'EnvironmentFile=/etc/lichu-solar-junyong.env',
      'ExecStart=/usr/bin/node ' + DIR + '/solar-service.js',
      'Restart=always',
      'RestartSec=5',
      '',
      '[Install]',
      'WantedBy=multi-user.target'
    ].join('\n') + '\n';
    await put(conn, tmp('lichu-solar-junyong.service', unit), '/tmp/lichu-solar-junyong.service');
    await exec(conn, 'sudo mv /tmp/lichu-solar-junyong.service /etc/systemd/system/lichu-solar-junyong.service && '
      + 'sudo systemctl daemon-reload && sudo systemctl enable lichu-solar-junyong >/dev/null 2>&1; sudo systemctl restart lichu-solar-junyong; sleep 2; systemctl is-active lichu-solar-junyong');
    console.log('systemd：' + (await exec(conn, 'systemctl is-active lichu-solar-junyong')).trim());

    /* nginx /junyong/pv/（只在没配过时插入；不动 /solar 的配置） */
    await exec(conn, 'sudo cp ' + NGINX_SITE + ' ' + NGINX_SITE + '.bak.junyong.$(date +%Y%m%d%H%M)');
    const has = (await exec(conn, "sudo grep -c 'location /junyong/pv/' " + NGINX_SITE + ' || true')).trim();
    if (has === '0') {
      await exec(conn, "sudo sed -i '/location \\/solar {/i\\    location /junyong/pv/ { proxy_pass http://127.0.0.1:" + PORT + "/solar/; }' " + NGINX_SITE);
      console.log('nginx 已加 /junyong/pv/ → 127.0.0.1:' + PORT + '/solar/');
    } else {
      console.log('nginx 已有 /junyong/pv/，跳过插入');
    }
    await exec(conn, 'sudo nginx -t && sudo systemctl reload nginx');
    console.log('nginx 已重载');

    console.log('\n—— 自测 ——');
    try {
      console.log('本机 8098 /solar/healthz：' + (await exec(conn, 'curl -s -m 8 http://127.0.0.1:' + PORT + '/solar/healthz')).trim());
    } catch (e) { console.log('本机自测失败：' + e.message); }

    console.log('\n完成。下一步：完成峻涌账号的授权（浏览器里点「同意授权」），然后本机 8098 会自动拉到 token。');
    console.log('日志：journalctl -u lichu-solar-junyong -f');
  } finally {
    conn.end();
  }
  process.exit(0);
})().catch(e => { console.error('失败：' + e.message); process.exit(1); });
