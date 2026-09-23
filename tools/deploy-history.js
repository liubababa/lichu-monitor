'use strict';
/* ============================================================
 * 部署「历史数据服务」到自己的服务器（/opt/lichu-history）
 *
 * 用法：node deploy-history.js
 *   · 上传 tools/history-service.js 与依赖（mqtt）
 *   · 建只读账号 lichu_hist（订阅 #，仅用于采样）
 *   · systemd: lichu-history.service（开机自启、崩溃重拉），凭据放 /etc/lichu-history.env（600）
 *   · nginx: 加 /history 反代到 127.0.0.1:8095（页面同源访问）
 *   · 自测：本机 /history、https://域名/history
 * 数据落在服务器 /var/lib/lichu-history（按天 jsonl，保留 3 天）
 * ============================================================ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('ssh2');

const HOST = process.env.SRV_HOST || '43.129.27.206';
const USER = process.env.SRV_USER || 'ubuntu';
/* 服务器密码与 broker 口令只从环境变量取，不写进代码（仓库是公开的） */
const PASS = process.env.SRV_PASS || '';
const MQTT_PASS = process.env.HIST_MQTT_PASS || '';
if (!PASS || !MQTT_PASS) {
  console.error('缺少环境变量：SRV_PASS（服务器密码）、HIST_MQTT_PASS（历史服务 broker 口令）');
  process.exit(1);
}

const DIR = '/opt/lichu-history';
const DATA_DIR = '/var/lib/lichu-history';
const PORT = 8095;
const MQTT_USER = 'lichu_hist';
const MQTT_PASS = 'Lichu@Hist2026';
const NGINX_SITE = '/etc/nginx/sites-available/mqtt.ykdesign.top';
const DOMAIN = 'mqtt.ykdesign.top';

function fail(m) { console.error('失败：' + m); process.exit(1); }
function exec(conn, cmd) {
  return new Promise((res, rej) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return rej(err);
      let out = '';
      stream.on('data', d => out += d);
      stream.stderr.on('data', d => out += d);
      stream.on('close', code => (code === 0 ? res(out) : rej(new Error('命令失败(' + code + ')：' + out.slice(-800)))));
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
    /* 1. 上传 */
    await exec(conn, 'sudo mkdir -p ' + DIR + ' ' + DATA_DIR + ' && sudo chown -R ' + USER + ':' + USER + ' ' + DIR + ' ' + DATA_DIR);
    await put(conn, path.join(__dirname, 'history-service.js'), DIR + '/history-service.js');
    await put(conn, tmp('hist-package.json', JSON.stringify({
      name: 'lichu-history', version: '1.0.0', private: true, type: 'commonjs',
      dependencies: { mqtt: '^5.16.0' }
    }, null, 2)), DIR + '/package.json');
    console.log('已上传 history-service.js / package.json');

    console.log((await exec(conn, 'cd ' + DIR + ' && npm i --omit=dev --no-audit --no-fund 2>&1 | tail -2')).trim());

    /* 2. broker 只读账号 */
    await exec(conn, 'sudo mosquitto_passwd -b /etc/mosquitto/passwd ' + MQTT_USER + " '" + MQTT_PASS + "'");
    await exec(conn, 'sudo systemctl reload mosquitto');
    console.log('mosquitto 账号已建/更新：' + MQTT_USER);

    /* 3. 凭据文件 + systemd */
    await put(conn, tmp('lichu-history.env',
      'HIST_MQTT_URL=mqtt://127.0.0.1:1883\nHIST_MQTT_USER=' + MQTT_USER + '\nHIST_MQTT_PASS=' + MQTT_PASS +
      '\nHIST_DIR=' + DATA_DIR + '\nHIST_DAYS=3\nHIST_PORT=' + PORT + '\n'), '/tmp/lichu-history.env');
    await exec(conn, 'sudo mv /tmp/lichu-history.env /etc/lichu-history.env && sudo chmod 600 /etc/lichu-history.env');
    const unit = [
      '[Unit]',
      'Description=力储未来 历史数据服务（SOC/功率采样，保留 3 天）',
      'After=network-online.target mosquitto.service',
      'Wants=mosquitto.service',
      '',
      '[Service]',
      'User=' + USER,
      'WorkingDirectory=' + DIR,
      'EnvironmentFile=/etc/lichu-history.env',
      'ExecStart=/usr/bin/node ' + DIR + '/history-service.js',
      'Restart=always',
      'RestartSec=5',
      '',
      '[Install]',
      'WantedBy=multi-user.target'
    ].join('\n') + '\n';
    await put(conn, tmp('lichu-history.service', unit), '/tmp/lichu-history.service');
    await exec(conn, 'sudo mv /tmp/lichu-history.service /etc/systemd/system/lichu-history.service && '
      + 'sudo systemctl daemon-reload && sudo systemctl enable --now lichu-history >/dev/null 2>&1; '
      + 'sudo systemctl restart lichu-history; sleep 2; systemctl is-active lichu-history');
    console.log('systemd 服务：' + (await exec(conn, 'systemctl is-active lichu-history')).trim());

    /* 4. nginx：/history 反代 */
    await exec(conn, 'sudo cp ' + NGINX_SITE + ' ' + NGINX_SITE + '.bak.$(date +%Y%m%d%H%M)');
    const has = (await exec(conn, "sudo grep -c 'location /history' " + NGINX_SITE + ' || true')).trim();
    if (has === '0') {
      await exec(conn, "sudo sed -i '/location \\/mqtt {/i\\    location = /history/healthz { proxy_pass http://127.0.0.1:" + PORT + "/healthz; }\\n    location /history { proxy_pass http://127.0.0.1:" + PORT + "; }\\n    location /daily { proxy_pass http://127.0.0.1:" + PORT + "; }' " + NGINX_SITE);
    }
    /* /daily（每日电量，供收益趋势用）单独兜底：老配置里可能只有 /history */
    const hasDaily = (await exec(conn, "sudo grep -c 'location /daily' " + NGINX_SITE + ' || true')).trim();
    if (hasDaily === '0') {
      await exec(conn, "sudo sed -i '/location \\/history {/i\\    location /daily { proxy_pass http://127.0.0.1:" + PORT + "; }' " + NGINX_SITE);
    }
    await exec(conn, 'sudo nginx -t && sudo systemctl reload nginx');
    console.log('nginx 已加 /history（反代 127.0.0.1:' + PORT + '）');

    /* 5. 自测 */
    console.log('\n—— 自测 ——');
    console.log('本机 /history：' + (await exec(conn, 'curl -s -m 5 "http://127.0.0.1:' + PORT + '/history?range=today&step=300" | head -c 300')).trim());
    try {
      const out = await exec(conn, 'curl -s -m 10 "https://' + DOMAIN + '/history?range=today&step=300" | head -c 300');
      console.log('https://' + DOMAIN + '/history：' + out.trim());
    } catch (e) { console.log('https 自测失败：' + e.message); }
    try {
      console.log('服务状态：' + (await exec(conn, 'curl -s -m 5 http://127.0.0.1:' + PORT + '/healthz')).trim().replace(/\s+/g, ' '));
    } catch (_) {}
    console.log('\n完成。页面「详细信息 → 充放电曲线」可切 今日 / 昨日 / 近3天。');
    console.log('数据目录 ' + DATA_DIR + '（按天 jsonl，保留 3 天）；日志：journalctl -u lichu-history -f');
  } finally {
    conn.end();
  }
  process.exit(0);
})().catch(e => fail(e.message));
