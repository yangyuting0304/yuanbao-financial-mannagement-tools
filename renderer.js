'use strict';
/*
 * renderer.js — 渲染与交互
 * 数据由主进程定时推送（moyu.onTick），界面只负责展示与用户操作。
 */
(function () {
  let config = null;     // 当前配置（含 watchlist 结构）
  let data = null;       // 最近一次行情

  const $body = document.getElementById('body');
  const $updated = document.getElementById('updated');
  const $srcInfo = document.getElementById('srcInfo');
  const $statusDot = document.getElementById('statusDot');
  const $overlay = document.getElementById('overlay');
  const $cfgText = document.getElementById('cfgText');
  const $cfgMsg = document.getElementById('cfgMsg');

  function dirClass(d) {
    if (!d || d.dir == null) return 'flat';
    return d.dir > 0 ? 'up' : d.dir < 0 ? 'down' : 'flat';
  }
  function fmt(n, digits) {
    if (n == null || isNaN(n)) return '—';
    return n.toFixed(digits == null ? 2 : digits);
  }
  function fmtSigned(n, digits) {
    if (n == null || isNaN(n)) return '—';
    return (n > 0 ? '+' : '') + n.toFixed(digits == null ? 2 : digits);
  }

  // 根据 config.watchlist 结构渲染骨架，再填入 data
  function render() {
    if (!config) {
      $body.innerHTML = '<div style="color:var(--txt-dim);padding:12px">初始化中…</div>';
      return;
    }
    if (!data) {
      $body.innerHTML = '<div style="color:var(--txt-dim);padding:12px">行情加载中…</div>';
      return;
    }
    const html = [];
    for (const g of config.watchlist) {
      html.push('<div class="group">');
      html.push('<div class="group-title">' + escapeHtml(g.group || '') + '</div>');
      for (const it of g.items || []) {
        const d = data.items[it.code];
        const cls = d ? dirClass(d) : 'flat';
        let tag = '';
        if (d && d.derived) tag = '<span class="tag">估算</span>';
        else if (d && d.source === 'eastmoney') tag = '<span class="tag">上金所</span>';
        let price = '—';
        let sub = '—';
        if (d && d.price != null) {
          price = fmt(d.price, d.price > 1000 ? 2 : 2);
          if (d.change != null && !isNaN(d.change)) {
            const pct = d.pct != null && !isNaN(d.pct) ? (d.pct > 0 ? '+' : '') + d.pct.toFixed(2) + '%' : '';
            sub = fmtSigned(d.change) + '  ' + pct;
          } else {
            sub = d.time || '';
          }
        }
        html.push(
          '<div class="row">' +
            '<span class="name">' + escapeHtml(it.name || it.code) + tag + '</span>' +
            '<span class="right">' +
              '<div class="price ' + cls + '">' + price + '</div>' +
              '<div class="sub ' + cls + '">' + sub + '</div>' +
            '</span>' +
          '</div>'
        );
      }
      html.push('</div>');
    }
    $body.innerHTML = html.join('');

    // 底部状态
    const t = new Date(data.updatedAt);
    $updated.textContent = '更新 ' + pad(t.getHours()) + ':' + pad(t.getMinutes()) + ':' + pad(t.getSeconds());
    const err = (data.errors || []).filter((e) => !/eastmoney|socket/i.test(e));
    if (data.errors && data.errors.length) {
      $statusDot.className = 'dot err';
      $srcInfo.textContent = data.errors.length + ' 源异常';
    } else {
      $statusDot.className = 'dot';
      $srcInfo.textContent = '实时';
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function pad(n) { return String(n).padStart(2, '0'); }

  // ---------- 事件 ----------
  document.getElementById('btnRefresh').onclick = () => window.moyu.refreshNow();
  document.getElementById('btnHide').onclick = () => window.moyu.hide();
  document.getElementById('btnTop').onclick = async () => {
    const on = await window.moyu.toggleTop();
    document.getElementById('btnTop').style.color = on ? 'var(--gold)' : 'var(--txt-dim)';
  };
  document.getElementById('btnSet').onclick = async () => {
    config = (await window.moyu.getConfig()) || config;
    $cfgText.value = JSON.stringify(config, null, 2);
    $cfgMsg.textContent = '';
    $overlay.classList.add('show');
  };
  document.getElementById('btnCancel').onclick = () => $overlay.classList.remove('show');
  document.getElementById('btnSave').onclick = async () => {
    try {
      const cfg = JSON.parse($cfgText.value);
      if (!cfg.watchlist || !Array.isArray(cfg.watchlist)) throw new Error('watchlist 必须是数组');
      await window.moyu.saveConfig(cfg);
      config = cfg;
      $overlay.classList.remove('show');
      render();
    } catch (e) {
      $cfgMsg.textContent = '保存失败：' + e.message;
    }
  };

  // 主进程推送
  window.moyu.onTick((d) => { data = d; render(); });

  // 初始化
  window.moyu.getState().then((s) => {
    if (s) {
      config = s.config;
      data = s.data;
      render();
    }
  });
})();
