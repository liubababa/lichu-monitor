#!/usr/bin/env node
/* ============================================================
 * 阳光云（iSolarCloud）自动重新授权
 *
 *   用途：授权链被平台作废（refresh_token invalid_grant）后，不需要人再手动走一遍——
 *         用无头 Chrome 打开授权页 → 登录 → 点「同意授权」→ 拿 code 到本机接入服务换 token。
 *
 *   用法：
 *     node solar-reauth.js --port 8096 --appid 2661 --cloud-id 2 \
 *          --redirect https://mqtt.ykdesign.top/solar/callback \
 *          --user <账号> --pass <密码>        # 也可用环境变量 SOLAR_USER / SOLAR_PASS
 *
 *   退出码：0 = 授权成功（token 已由接入服务保存）；非 0 = 失败（原因打在 stdout 末尾）。
 *
 *   注意：
 *     · 浏览器走到注册回调时会被【拦下】，改把 code 发到 127.0.0.1:<port> 换 token ——
 *       公网回调有 nginx Basic 认证，而且授权码是一次性的，不能被浏览器和服务各消费一次。
 *     · 登录页有验证码时脚本会停在登录页并报「需要人工登录」。
 * ============================================================ */
'use strict';
const path = require('path');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const OPT = {
  port: arg('port', process.env.SOLAR_PORT || '8096'),
  appid: arg('appid', process.env.SOLAR_APPID || ''),
  cloudId: arg('cloud-id', process.env.SOLAR_CLOUD_ID || '1'),
  redirect: arg('redirect', process.env.SOLAR_REDIRECT || 'https://mqtt.ykdesign.top/solar/callback'),
  user: arg('user', process.env.SOLAR_USER || ''),
  pass: arg('pass', process.env.SOLAR_PASS || ''),
  timeoutMs: parseInt(arg('timeout', '120000'), 10),
  headful: arg('headful', '') === '1'
};

function log(s) { console.log(new Date().toTimeString().slice(0, 8) + '  ' + s); }
function die(msg) { log('失败：' + msg); process.exit(1); }

let puppeteer;
try { puppeteer = require(path.join(__dirname, 'node_modules', 'puppeteer')); }
catch (_) { try { puppeteer = require('puppeteer'); } catch (e) { die('没有找到 puppeteer（' + e.message + '）'); } }
if (!OPT.user || !OPT.pass) die('缺少账号/密码（--user / --pass 或 SOLAR_USER / SOLAR_PASS）');
if (!OPT.appid) die('缺少 --appid');

const AUTH_URL_FALLBACK = 'https://web3.isolarcloud.com.cn/#/authorized-app?cloudId=' + encodeURIComponent(OPT.cloudId)
  + '&applicationId=' + encodeURIComponent(OPT.appid)
  + '&redirectUrl=' + encodeURIComponent(OPT.redirect);

(async () => {
  /* 授权地址优先向本机接入服务要：区域/cloudId/应用号由服务自己拼，脚本不重复维护
     （cloudId 选错会跳到国际站，登录页报 "Please check your server selection…"） */
  let AUTH_URL = AUTH_URL_FALLBACK;
  try {
    const r0 = await fetch('http://127.0.0.1:' + OPT.port + '/solar/authorize', { redirect: 'manual' });
    const loc = r0.headers.get('location');
    if (loc) AUTH_URL = loc;
    log('授权地址（来自本机服务）：' + AUTH_URL);
  } catch (e) { log('取本机 /solar/authorize 失败，用内置地址：' + e.message); }

  const browser = await puppeteer.launch({
    headless: !OPT.headful,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
      '--lang=zh-CN', '--window-size=1280,900']
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1280, height: 900 });

  let codeSeen = null;
  await page.setRequestInterception(true);
  page.on('request', req => {
    const u = req.url();
    /* 公网回调：只取 code，不放行（授权码一次性，留给本机服务消费） */
    if (u.indexOf('/solar/callback') > -1 || u.indexOf('/pv/callback') > -1) {
      const m = /[?&]code=([^&]+)/.exec(u);
      if (m && !codeSeen) codeSeen = decodeURIComponent(m[1]);
      return req.abort();
    }
    req.continue();
  });

  const wait = async (fn, ms, what) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      /* 页面在导航时 evaluate 会偶发失败（执行上下文被销毁）——那种忽略；
         但回调里 deliberately 抛的 fatal 错误要冒出来，别吞成超时 */
      try { if (await fn()) return true; }
      catch (e) { if (e && e.fatal) throw e; }
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error('等待超时：' + what);
  };
  const fatal = m => { const e = new Error(m); e.fatal = true; return e; };

  try {
    log('打开授权页…');
    await page.goto(AUTH_URL, { waitUntil: 'domcontentloaded', timeout: OPT.timeoutMs });
    await wait(async () => (await page.$$('input')).length > 0, 30000, '页面输入框出现');

    /* Cookie 弹窗：能点掉就点掉（页面可能是中文或英文） */
    try {
      const ok = await page.$x("//*[contains(text(),'是的，我同意') or contains(text(),'Yes, I agree')]");
      if (ok && ok.length) { await ok[0].click(); log('关掉 Cookie 弹窗'); }
    } catch (_) {}

    /* 选服务器：表单第一个输入是「服务器站点 / Server」，不选对会报
       "Please check your server selection and verify that the account exists."（没有验证码，纯地区选错） */
    try {
      const srv = await page.$('input[placeholder="服务器站点"], input[placeholder="Server"]');
      if (srv) {
        await srv.click();
        await new Promise(r => setTimeout(r, 1000));
        const opts = await page.$$('.el-select-dropdown__item, .el-option, li[role="option"]');
        let picked = null;
        for (const o of opts) {
          const t = (await page.evaluate(x => (x.innerText || '').trim(), o)) || '';
          if (/中国|Chinese|China/i.test(t) && !/国际|International/i.test(t)) {
            await o.click();
            picked = t;
            break;
          }
        }
        log(picked ? ('已选服务器：' + picked) : '未找到「中国」服务器选项（沿用页面默认）');
        await new Promise(r => setTimeout(r, 800));
      }
    } catch (e) { log('选服务器时出错（继续）：' + e.message); }

    /* 切站后页面可能整页重载/换成中文站，这里等表单回来，必要时重新打开授权页 */
    const waitForSel = async (sel, ms) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        try { const el = await page.$(sel); if (el) return el; } catch (_) {}
        await new Promise(r => setTimeout(r, 500));
      }
      return null;
    };
    const ACC = 'input[placeholder="账号"], input[placeholder="Account"], input[placeholder*="账号"]';
    let accEl = await waitForSel(ACC, 8000);
    if (!accEl) {
      log('切站后表单没出现，重新打开授权页…');
      await page.goto(AUTH_URL, { waitUntil: 'domcontentloaded', timeout: OPT.timeoutMs });
      accEl = await waitForSel(ACC, 30000);
    }
    if (!accEl) throw new Error('找不到账号输入框');

    /* 登录页在选完服务器/输入过程中会整块重渲染，元素句柄随时可能失效（Node is detached），
       所以：每次重新取元素 → 点一下 → 输入 → 读回值确认，失败重来 */
    const readInp = kind => page.evaluate(function (k) {
      if (k === 'pw') { var p = document.querySelector('input[type="password"]'); return p ? (p.value || '') : null; }
      var sels = ['input[placeholder="账号"]', 'input[placeholder="Account"]', 'input[placeholder*="账号"]'];
      for (var i = 0; i < sels.length; i++) { var e = document.querySelector(sels[i]); if (e) return e.value || ''; }
      return null;
    }, kind);
    const typeInto = async (sel, val, kind, what) => {
      for (let i = 0; i < 6; i++) {
        try {
          const el = await waitForSel(sel, 8000);
          if (!el) continue;
          await el.click({ clickCount: 3 });
          await el.type(val, { delay: 25 });
          const got = await readInp(kind);
          if (got === val) return true;
        } catch (e) { /* 句柄失效 → 重试 */ }
        await new Promise(r => setTimeout(r, 700));
      }
      throw new Error('填' + what + '失败（页面反复重渲染）');
    };

    log('填账号密码…');
    await typeInto('input[placeholder="账号"], input[placeholder="Account"], input[placeholder*="账号"]', OPT.user, 'acc', '账号');
    await typeInto('input[type="password"]', OPT.pass, 'pw', '密码');

    /* 勾上没勾的复选框（隐私协议；「记住我」通常是勾着的，别把它点掉） */
    try {
      const boxes = await page.$$('input[type="checkbox"], .el-checkbox');
      for (const b of boxes) {
        const on = await page.evaluate(x => x.checked === true || (x.className || '').indexOf('is-checked') > -1, b);
        if (!on) { try { await b.click(); } catch (_) {} }
      }
    } catch (_) {}

    log('点登录…');
    const clicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, .el-button, div[role="button"]'));
      const b = btns.find(x => /^\s*(登\s*录|Login)\s*$/i.test((x.innerText || '').trim()));
      if (!b) return false;
      b.click(); return true;
    });
    if (!clicked) throw new Error('页面上找不到「登录」按钮');

    /* 登录成功判定：页面上不再有密码框，并且已经出现「授权详情」的内容
       （登录后可能跳 #/apiAuth/detail 或 #/authorized-app，别只认其中一个路径） */
    const loginOk = await wait(async () => {
      const txt = await page.evaluate(() => (document.body.innerText || ''));
      const hasPw = !!(await page.$('input[type="password"]'));
      if (!hasPw && /Authorization details|授权详情|Agree to authorize|同意授权|Authorized plant|授权电站/i.test(txt)) return true;
      if (/验证码|滑动|拖动|captcha|verification code/i.test(txt)) throw fatal('登录页要求验证码，需要人工登录一次');
      if (/账号或密码|密码错误|用户不存在|账号不存在|incorrect|invalid|wrong password|does not exist|server selection/i.test(txt)) throw fatal('账号或密码不正确（或服务器选错）');
      return false;
    }, 90000, '登录完成');
    if (!loginOk) throw new Error('登录后没有回到授权页');
    log('登录成功，停在授权页');

    /* 授权页：① 勾「我已阅读并同意隐私政策」（不勾时「同意授权」是灰的，点了没反应）
       ② 电站列表里没勾的也勾上（有些账号要手动选电站）③ 等按钮可点再点 */
    await new Promise(r => setTimeout(r, 2000));
    log('授权页文字：' + await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 300)));
    let consent = 'none';
    for (let i = 0; i < 12; i++) {
      await page.evaluate(() => {
        document.querySelectorAll('.el-checkbox').forEach(function (b) {
          var inp = b.querySelector('input');
          if (inp && !inp.checked) { var l = b.querySelector('.el-checkbox__label') || b; l.click(); }
        });
        document.querySelectorAll('input[type="checkbox"]').forEach(function (c) {
          if (!c.checked) { try { c.click(); } catch (_) {} }
        });
      });
      consent = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, .el-button'));
        /* 只认按钮本身，别把「Authorized plant」这种标题当成按钮 */
        const b = btns.find(x => /^(同意授权|同意并授权|确认授权|同意|Agree to authorize|Agree and authorize|Authorize|Confirm)$/i.test((x.innerText || '').trim()))
          || btns.find(x => /同意授权|同意并授权|确认授权|Agree to authorize|Agree and authorize/i.test((x.innerText || '').trim()));
        if (!b) return 'none';
        if (b.disabled || (b.className || '').indexOf('is-disabled') > -1 || b.getAttribute('aria-disabled') === 'true') return 'disabled';
        b.click(); return 'clicked';
      });
      if (consent === 'clicked' || consent === 'none') break;   /* 点了 / 页面没有按钮（可能是别的形态）都往下走 */
      await new Promise(r => setTimeout(r, 1500));
    }
    if (consent === 'disabled') throw new Error('「同意授权」按钮一直是灰的（隐私政策勾选框可能没勾上）');
    log('授权按钮：' + consent + '，等回调…');

    await wait(async () => !!codeSeen, 90000, '拿到授权 code');
    log('拿到 code，交给本机接入服务换 token…');

    const res = await fetch('http://127.0.0.1:' + OPT.port + '/solar/callback?code=' + encodeURIComponent(codeSeen));
    const body = await res.text();
    if (!res.ok || body.indexOf('授权成功') < 0) throw new Error('换 token 失败（HTTP ' + res.status + '）：' + body.slice(0, 200));
    log('REAUTH-OK 授权成功，token 已保存');
    await browser.close();
    process.exit(0);
  } catch (e) {
    log('失败：' + (e && e.message));
    try { await page.screenshot({ path: '/tmp/solar-reauth-fail.png' }); log('现场截图：/tmp/solar-reauth-fail.png'); } catch (_) {}
    try { await browser.close(); } catch (_) {}
    process.exit(2);
  }
})().catch(e => die(e && e.message));
