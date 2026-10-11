/* ============================================================
 * 屏保：30 分钟没人操作就盖上待机页（样式与启动加载页同一套）
 *
 *   内容：logo + 系统名称 + 大时钟 + 日期 + 唤醒提示
 *   任意鼠标 / 键盘 / 触摸操作即唤醒，唤醒后重新计时；
 *   切到后台再回来也重新计时，避免刚回来就被盖住。
 * ============================================================ */
window.ScreenSaver = (function () {
  'use strict';

  const IDLE_MS = 30 * 60 * 1000;        /* 30 分钟无操作进入屏保 */
  let el = null, timer = null, clockTimer = null, shown = false;

  function build() {
    if (el) return el;
    el = document.createElement('div');
    el.id = 'screenSaver';
    el.className = 'hidden';
    el.innerHTML =
      '<div class="ss-brand">'
      + '<img src="libs/logo.png" alt="力储未来"/>'
      + '<div class="ss-brand-txt"><b>力储未来</b>'
      + '<span>力储未来（临沂）能源科技有限责任公司</span></div>'
      + '</div>'
      + '<div class="ss-center">'
      + '<h2 class="ss-title">能源综合管理系统</h2>'
      + '<p class="ss-sub">LICHU FUTURE INTEGRATED ENERGY MANAGEMENT SYSTEM</p>'
      + '<p class="ss-when"><i id="ssClock">--:--</i><span id="ssDate">--</span></p>'
      + '</div>'
      + '<div class="ss-hint">点击或按任意键唤醒</div>';
    document.body.appendChild(el);
    return el;
  }

  function tick() {
    if (!el) return;
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    const c = el.querySelector('#ssClock');
    if (c) c.textContent = p(d.getHours()) + ':' + p(d.getMinutes());
    const dt = el.querySelector('#ssDate');
    if (dt) {
      dt.textContent = d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日 · 星期'
        + '日一二三四五六'.charAt(d.getDay());
    }
  }

  function show() {
    if (shown) return;
    build();
    shown = true;
    tick();
    el.classList.remove('hidden');
    if (!clockTimer) clockTimer = setInterval(tick, 1000);
  }

  function hide() {
    if (!shown) return;
    shown = false;
    if (el) el.classList.add('hidden');
    if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
  }

  /* 有操作就重新计时 */
  function reset() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(show, IDLE_MS);
  }

  function onActivity() {
    if (shown) hide();
    reset();
  }

  function init() {
    build();
    /* 手动测试按钮：顶栏「屏保」按钮（立即进入，不用等 30 分钟） */
    document.querySelectorAll('[data-screensaver]').forEach(function (b) {
      b.addEventListener('click', function () { show(); });
    });
    ['mousemove', 'mousedown', 'wheel', 'keydown', 'touchstart', 'pointerdown'].forEach(function (ev) {
      window.addEventListener(ev, onActivity, { passive: true });
    });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) reset();
    });
    reset();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return {
    show: show,
    hide: hide,
    isShown: function () { return shown; },
    idleMs: IDLE_MS
  };
})();
