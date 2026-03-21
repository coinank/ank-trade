/**
 * Coinank Trader - Content Script
 * 从 Coinank 页面检测当前交易对，自动同步到侧边栏
 */
(function () {
  'use strict';

  // 从 URL 路径或 DOM 中提取交易对符号
  function extractSymbol() {
    const path  = location.pathname;
    const search = location.search;
    const full  = (path + search).toLowerCase();

    // 常见 quote 货币，按长度降序避免 USDT 匹配到 USD
    const quotes = ['usdt', 'busd', 'usdc', 'btc', 'eth', 'bnb'];

    for (const q of quotes) {
      // 匹配 URL 片段如 /btcusdt /eth-usdt /BTC_USDT
      const re = new RegExp(`[/_-]([a-z]{2,10})[/_-]?${q}(?:[/_?#&]|$)`);
      const m  = full.match(re);
      if (m) {
        const base = m[1].toUpperCase();
        if (base.length >= 2 && base.length <= 10)
          return `${base}/${q.toUpperCase()}`;
      }
    }

    // 从 document.title 提取，如 "BTC/USDT | Coinank" 或 "BTCUSDT 价格"
    const t1 = document.title.match(/\b([A-Z]{2,10})\/([A-Z]{2,8})\b/);
    if (t1) return `${t1[1]}/${t1[2]}`;

    const t2 = document.title.match(/\b([A-Z]{2,10})(USDT|BUSD|USDC|BTC|ETH)\b/);
    if (t2) return `${t2[1]}/${t2[2]}`;

    // 尝试读取页面中常见的符号元素
    const el = document.querySelector(
      '[data-symbol],[data-pair],[class*="symbol"],[class*="ticker-symbol"]'
    );
    if (el) {
      const text = (el.textContent || el.getAttribute('data-symbol') || '').trim().toUpperCase();
      const m2 = text.match(/^([A-Z]{2,10})\/?([A-Z]{2,8})$/);
      if (m2) return `${m2[1]}/${m2[2]}`;
    }

    return null;
  }

  function sendSymbol(symbol) {
    chrome.runtime.sendMessage({ action: 'pageSymbol', symbol }).catch(() => {});
  }

  let lastSymbol = null;

  function check() {
    const sym = extractSymbol();
    if (sym && sym !== lastSymbol) {
      lastSymbol = sym;
      sendSymbol(sym);
    }
  }

  check();

  // 监听 SPA 路由变化（URL 改变但页面不刷新）
  let lastUrl = location.href;
  const urlObserver = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(check, 400); // 等待 title 更新
    }
  });
  urlObserver.observe(document.documentElement, { childList: true, subtree: true });

  // 监听 title 变化
  const titleEl = document.querySelector('title');
  if (titleEl) {
    new MutationObserver(check).observe(titleEl, { childList: true });
  }
})();
