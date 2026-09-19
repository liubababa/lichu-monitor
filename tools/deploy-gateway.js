'use strict';
/* ============================================================
 * 部署「前后分离网关」到自己的服务器（/opt/mqtt-gateway）
 *
 * 用法：node deploy-gateway.js [配置文件]
 *   配置文件默认 tools/gateway.config.server.json（不进仓库，含密码）：
 *     · listen 用 8090（mosquitto 自己占着 8083，留着可随时回滚）
 *     · upstream.url = mqtt://127.0.0.1:1883，账号密码填服务器 mosquitto 账号
 *     · users 里放网页可下发的账号（不填账号的访客只读）
 *
 * 脚本会做：
 *   1. 缺 Node 就装（NodeSource 20.x）
 *   2. 上传 gateway.js / package.json / config.json 到 /opt/mqtt-gateway 并 npm i
 *   3. 用配置里的 upstream 账号建/更新 mosquitto 账号
 *   4. systemd: mqtt-gateway.service（开机自启、崩溃重拉）
 *   5. nginx: mqtt.ykdesign.top 的 /mqtt 由 mosquitto:8083 改指网关，并加 /healthz
 *      （改前备份站点配置，回滚方式见脚本末尾输出）
 *   6. 自测：本机 /healthz、网页侧 WS 登录+回环、https 域名 /healthz
 * ============================================================ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('ssh2');

const HOST = process.env.SRV_HOST || '43.129.27.206';
const USER = process.env.SRV_USER || 'ubuntu';
const PASS = process.env.SRV_PASS || 'Lyk872373!';

const GW_DIR = '/opt/mqtt-gateway';
const GW_PORT = 8090;
const NGINX_SITE = '/etc/nginx/sites-available/mqtt.ykdesign.top';
const DOMAIN = 'mqtt.ykdesign.top';

const cfgPath = path.resolve(process.argv[2] || path.join(__dirname, 'gateway.config.server.json'));

function fail(msg) { console.error('失败：' + msg); process.exit(1); }
function shq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

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

function sftpPut(conn, local, remote) {
  return new Promise((res, rej) => {
    conn.sftp((e, sftp) => {
      if (e) return rej(e);
      sftp.fastPut(local, remote, err => {
        sftp.end();
        if (err) return rej(new Error(remote + ' → ' + err.message));
        res();
      });
    });
  });
}

function tmpFile(name, content) {
  const p = path.join(os.tmpdir(), name);
  fs.writeFileSync(p, content);
  return p;
}

(async () => {
  /* ---------- 0. 本地配置 ---------- */
  if (!fs.existsSync(cfgPath)) fail('配置文件不存在：' + cfgPath + '\n  先复制 tools/gateway.config.example.json 为 tools/gateway.config.server.json 并填好。');
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (e) { fail('配置解析失败：' + e.message); }
  if (!cfg.upstream || !cfg.upstream.url) fail('配置缺少 upstream.url');
  if (!cfg.listen) cfg.listen = GW_PORT;
  if (/改成|请填|xxx/i.test(JSON.stringify(cfg))) fail('配置里还有占位符文字（"改成…"），请先填真实值');
  const userNames = Object.keys(cfg.users || {});
  console.log('配置：' + cfgPath);
  console.log('  listen=' + cfg.listen + '　upstream=' + cfg.upstream.url + '　可下发账号：' + (userNames.join(',') || '（无，网页只能只读）'));

  /* ---------- 1. 连接服务器 ---------- */
  const conn = new Client();
  await new Promise((res, rej) => conn.on('ready', res).on('error', rej)
    .connect({ host: HOST, port: 22, username: USER, password: PASS, tryKeyboard: true, readyTimeout: 20000 }));
  console.log('已连接 ' + HOST);
  try {
    /* ---------- 2. Node ---------- */
    let nodeVer = (await exec(conn, 'command -v node >/dev/null 2>&1 && node -v || echo NONE')).trim();
    if (nodeVer === 'NONE') {
      console.log('服务器未装 Node，正在安装（NodeSource 20.x）…');
      await exec(conn, 'curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - >/dev/null 2>&1 && sudo apt-get install -y nodejs >/dev/null 2>&1');
      nodeVer = (await exec(conn, 'node -v')).trim();
    }
    console.log('服务器 Node：' + nodeVer);

    /* ---------- 3. 上传 ---------- */
    await exec(conn, 'sudo mkdir -p ' + GW_DIR + ' && sudo chown -R ' + USER + ':' + USER + ' ' + GW_DIR);
    await sftpPut(conn, path.join(__dirname, 'gateway.js'), GW_DIR + '/gateway.js');
    await sftpPut(conn, cfgPath, GW_DIR + '/config.json');
    const pkg = {
      name: 'mqtt-gateway', version: '1.0.0', private: true, type: 'commonjs',
      dependencies: { aedes: '0.51.3', mqtt: '^5.16.0', 'websocket-stream': '^5.5.2' }
    };
    await sftpPut(conn, tmpFile('gateway-package.json', JSON.stringify(pkg, null, 2)), GW_DIR + '/package.json');
    await exec(conn, 'chmod 600 ' + GW_DIR + '/config.json');
    console.log('已上传 gateway.js / config.json / package.json');

    console.log('安装依赖（aedes 锁 0.51.3）…');
    console.log((await exec(conn, 'cd ' + GW_DIR + ' && npm i --omit=dev --no-audit --no-fund 2>&1 | tail -2')).trim());

    /* ---------- 4. mosquitto 账号 ---------- */
    if (cfg.upstream.username) {
      await exec(conn, 'sudo mosquitto_passwd -b /etc/mosquitto/passwd ' + shq(cfg.upstream.username) + ' ' + shq(cfg.upstream.password || ''));
      await exec(conn, 'sudo systemctl reload mosquitto');
      console.log('mosquitto 账号已建/更新：' + cfg.upstream.username);
    }

    /* ---------- 5. systemd ---------- */
    const unit = [
      '[Unit]',
      'Description=MQTT 前后分离网关（网页 ⇄ 网关 ⇄ mosquitto）',
      'After=network-online.target mosquitto.service',
      'Wants=mosquitto.service',
      '',
      '[Service]',
      'User=' + USER,
      'WorkingDirectory=' + GW_DIR,
      'ExecStart=/usr/bin/node ' + GW_DIR + '/gateway.js --config ' + GW_DIR + '/config.json',
      'Restart=always',
      'RestartSec=5',
      '',
      '[Install]',
      'WantedBy=multi-user.target'
    ].join('\n') + '\n';
    await sftpPut(conn, tmpFile('mqtt-gateway.service', unit), '/tmp/mqtt-gateway.service');
    await exec(conn, 'sudo mv /tmp/mqtt-gateway.service /etc/systemd/system/mqtt-gateway.service && '
      + 'sudo systemctl daemon-reload && sudo systemctl enable --now mqtt-gateway >/dev/null 2>&1; '
      + 'sudo systemctl restart mqtt-gateway; sleep 2; systemctl is-active mqtt-gateway');
    console.log('systemd 服务：' + (await exec(conn, 'systemctl is-active mqtt-gateway')).trim());

    /* ---------- 6. nginx ---------- */
    await exec(conn, 'sudo cp ' + NGINX_SITE + ' ' + NGINX_SITE + '.bak.$(date +%Y%m%d%H%M)');
    await exec(conn, "sudo sed -i 's|proxy_pass http://127.0.0.1:8083;|proxy_pass http://127.0.0.1:" + cfg.listen + ";|' " + NGINX_SITE);
    const hasHealthz = (await exec(conn, "sudo grep -c 'location /healthz' " + NGINX_SITE + ' || true')).trim();
    if (hasHealthz === '0') {
      await exec(conn, "sudo sed -i '/location \\/mqtt {/i\\    location /healthz { proxy_pass http://127.0.0.1:" + cfg.listen + "; }' " + NGINX_SITE);
    }
    await exec(conn, 'sudo nginx -t && sudo systemctl reload nginx');
    console.log('nginx /mqtt 已改指 127.0.0.1:' + cfg.listen);

    /* ---------- 7. 自测 ---------- */
    console.log('\n—— 自测 ——');
    let h = null;
    try { h = JSON.parse(await exec(conn, 'curl -s -m 5 http://127.0.0.1:' + cfg.listen + '/healthz')); } catch (_) {}
    console.log('本机 /healthz：' + (h ? ('upstream=' + h.upstream + '  clients=' + h.clients + '  登录应答=' + h.autoLoginReply) : '无响应'));
    if (h && h.upstream !== 'connected') console.log('  ！上游未连接：检查 config.json 的账号密码、mosquitto 状态、journalctl -u mqtt-gateway');

    const firstUser = userNames[0];
    if (firstUser) {
      const js = [
        "const m = require('mqtt');",
        "const t = 'probe/gateway-' + Date.now();",
        "const c = m.connect('ws://127.0.0.1:" + cfg.listen + "/mqtt', { username: process.argv[2], password: process.argv[3], reconnectPeriod: 0 });",
        "c.on('connect', () => c.subscribe(t, { qos: 1 }, () => c.publish(t, '{\"ok\":1}', { qos: 1 })));",
        "c.on('message', tp => { console.log('WS 登录+回环 OK：' + tp); process.exit(0); });",
        "c.on('error', e => { console.log('WS 错误：' + e.message); process.exit(1); });",
        "setTimeout(() => { console.log('WS 超时'); process.exit(1); }, 6000);"
      ].join('\n');
      await sftpPut(conn, tmpFile('gw-selftest.js', js), GW_DIR + '/gw-selftest.js');
      const out = await exec(conn, 'cd ' + GW_DIR + ' && node ' + GW_DIR + '/gw-selftest.js ' + shq(firstUser) + ' ' + shq(cfg.users[firstUser]) + '; rm -f ' + GW_DIR + '/gw-selftest.js')
        .catch(e => e.message);
      console.log('网页侧 WS 自测：' + out.trim());
    } else {
      console.log('网页侧 WS 自测：跳过（配置里没有 users，浏览器只能只读）');
    }

    const https = await exec(conn, 'curl -s -m 10 https://' + DOMAIN + '/healthz').catch(e => 'HTTPS 请求失败：' + e.message);
    console.log('https://' + DOMAIN + '/healthz：' + String(https).trim().slice(0, 300));

    console.log('\n部署完成。网页「网关地址」填 wss://' + DOMAIN + '/mqtt，账号可留空（只读）或填 users 里的账号（可下发）。');
    console.log('回滚：sudo cp ' + NGINX_SITE + '.bak.* ' + NGINX_SITE + ' && sudo nginx -t && sudo systemctl reload nginx');
  } finally {
    conn.end();
  }
  process.exit(0);
})().catch(e => fail(e.message));
