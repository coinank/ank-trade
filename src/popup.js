import { initLang, t, langLabel, cycleLang } from './i18n.js';

// ─── 状态 ────────────────────────────────────────────────────────────────────
const state = {
  exchange:          'binance',
  tab:               'trade',    // 'trade' | 'orders'
  ordersTab:         'open',     // 'open' | 'history' | 'positions'
  symbol:            'BTC/USDT',
  marketType:        'spot',     // 'spot' | 'perp'
  leverage:          10,
  side:              'buy',
  orderType:         'limit',    // 'market' | 'limit' | 'stop' | 'takeprofit'
  amount:            '',
  price:             '',
  stopPrice:         '',
  orders:            [],
  balance:           null,
  positions:         [],
  loading:           false,
  submitting:        false,
  ordersError:       null,
  ordersWarning:     null,
  confirmOrder:      null,
  uncertainOrders:   [],
  activeRequestId:   null,
  acknowledging:    false,
  toast:             null,
  markets:           [],
  marketsLoading:    false,
  symSearch:         '',
  ticker:            null,       // { last, bid, ask, change }
  reduceOnly:        false,
  confirmPending:    false,      // 市价单确认
  // ── Symbol Modal ──
  symModalOpen:      false,
  symFavorites:      [],
  symMarketFilter:   'all',      // 'fav' | 'all' | 'perp' | 'spot'
  symTickers:        {},         // { [symbol]: { price, change } }
  symTickersLoading: false,
  recentSymbols:     [],
  symHighlight:      -1,
};

const EXCHANGES = ['binance', 'okx', 'bybit', 'bitget', 'hyperliquid'];
const EX_LABEL  = { binance: 'Binance', okx: 'OKX', bybit: 'Bybit', bitget: 'Bitget', hyperliquid: 'Hyperliquid' };

const STATUS_KEY = {
  new: 'status_new', open: 'status_new', live: 'status_new',
  partially_filled: 'status_partial', filled: 'status_filled',
  canceled: 'status_canceled', cancelled: 'status_canceled',
  rejected: 'status_rejected', triggered: 'status_triggered',
};
const TYPE_KEY = {
  market: 'type_market', limit: 'type_limit', stop: 'type_stop', takeprofit: 'type_takeprofit',
  conditional: 'type_conditional', take_profit: 'type_take_profit', take_profit_market: 'type_tp_market',
};

// 公开接口（不需要 API Key）
const PUBLIC_ACTIONS = new Set(['getMarkets', 'getTicker', 'getMarketTickers', 'acknowledgeOrder']);

// ─── 定时器 ───────────────────────────────────────────────────────────────────
let _tickerTimer      = null;
let _balanceTimer     = null;
let _modalTickerTimer = null;
let _contextVersion = 0;
let _tickerRequest = 0;
let _tickerPending = null;
let _balanceRequest = 0;
let _ordersRequest = 0;
let _positionsRequest = 0;
let _marketsRequest = 0;
let _modalRequest = 0;
let _pendingRequest = 0;

function currentContext() {
  return `${_contextVersion}:${state.exchange}:${state.marketType}:${state.symbol}`;
}

function resetTradingContext() {
  _contextVersion++;
  state.ticker = null; state.balance = null;
  state.orders = []; state.positions = []; state.ordersError = null; state.ordersWarning = null;
  state.amount = ''; state.price = ''; state.stopPrice = '';
  state.confirmPending = false; state.confirmOrder = null;
  stopTickerRefresh();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function refreshPendingOrders() {
  const request = ++_pendingRequest;
  const pending = await chrome.storage.local.get(null);
  if (request !== _pendingRequest) return;
  state.uncertainOrders = Object.entries(pending)
    .filter(([key, value]) => key.startsWith('pendingTrade_') && /^[a-f0-9]{32}$/.test(value?.params?.requestId || '') &&
      EXCHANGES.includes(value.exchange) && value.params.requestId !== state.activeRequestId)
    .map(([, value]) => value);
  render();
}

// ─── 初始化 ──────────────────────────────────────────────────────────────────
async function init() {
  await initLang();
  const s = await chrome.storage.local.get([
    'selectedExchange', 'lastSymbol', 'lastMarket', 'coinankSymbol',
    'symFavorites', 'recentSymbols',
  ]);
  if (s.selectedExchange)             state.exchange      = s.selectedExchange;
  if (s.lastSymbol)                   state.symbol        = s.lastSymbol;
  if (s.lastMarket)                   state.marketType    = s.lastMarket;
  if (s.coinankSymbol)                state.symbol        = s.coinankSymbol;
  if (state.exchange === 'hyperliquid') state.marketType = 'perp';
  if (Array.isArray(s.symFavorites))  state.symFavorites  = s.symFavorites;
  if (Array.isArray(s.recentSymbols)) state.recentSymbols = s.recentSymbols;
  chrome.storage.onChanged.addListener(async changes => {
    if (Object.keys(changes).some(key => key.startsWith('pendingTrade_'))) {
      await refreshPendingOrders();
    }
    if (changes.coinankSymbol?.newValue && changes.coinankSymbol.newValue !== state.symbol) {
      resetTradingContext();
      state.symbol = changes.coinankSymbol.newValue;
      syncSymbolToLoadedMarkets();
      render();
      reloadMarketsThenTicker();
    }
  });
  await refreshPendingOrders();
  silentLoadBalance();
  await reloadMarketsThenTicker();
  startBalanceRefresh();
}

// ─── 定时刷新 ─────────────────────────────────────────────────────────────────
function startTickerRefresh() {
  stopTickerRefresh();
  silentLoadTicker();
  _tickerTimer = setInterval(silentLoadTicker, 3000);
}
function stopTickerRefresh() {
  if (_tickerTimer) { clearInterval(_tickerTimer); _tickerTimer = null; }
}
function startBalanceRefresh() {
  stopBalanceRefresh();
  _balanceTimer = setInterval(() => {
    if (state.tab === 'trade') silentLoadBalance();
  }, 30000);
}
function stopBalanceRefresh() {
  if (_balanceTimer) { clearInterval(_balanceTimer); _balanceTimer = null; }
}
function stopModalTickerTimer() {
  if (_modalTickerTimer) { clearInterval(_modalTickerTimer); _modalTickerTimer = null; }
}

// ─── 渲染 ────────────────────────────────────────────────────────────────────
function render() {
  // 弹窗打开时，抑制后台触发的全量重建（弹窗自行管理列表刷新）
  if (state.symModalOpen) return;
  const focused = document.activeElement?.id;
  document.getElementById('app').innerHTML = html();
  bind();
  if (['amtIn', 'pxIn', 'spIn'].includes(focused)) document.getElementById(focused)?.focus({ preventScroll: true });
}

// 强制渲染（弹窗开关时调用，绕过 symModalOpen 守卫）
function forceRender() {
  document.getElementById('app').innerHTML = html();
  bind();
  if (state.symModalOpen) bindSymModalEvents();
}

function html() {
  return `
<div>
  ${header()}
  ${tabs()}
  <div class="content">
    ${state.uncertainOrders.map(order => `<div class="confirm-box"><p>${escapeHtml(t('order_unknown', {
      exchange: EX_LABEL[order.exchange], symbol: order.params.symbol,
      id: order.exchange === 'hyperliquid' ? `0x${order.params.requestId}` : `ank${order.params.requestId.slice(0, 29)}`,
    }))}</p></div>`).join('')}
    ${state.uncertainOrders.length ? `<button class="btn-confirm-no" id="ackUnknownOrder"${state.acknowledging?' disabled':''}>${t('order_checked')}</button>` : ''}
    ${state.tab === 'trade' ? tradeForm() : ordersPanel()}
  </div>
  ${state.toast ? `<div class="toast toast-${state.toast.type}">${escapeHtml(state.toast.msg)}</div>` : ''}
  ${state.symModalOpen ? symModal() : ''}
</div>`;
}

function header() {
  const tk  = state.ticker;
  const chg = tk?.change;
  const chgClass = chg != null ? (chg >= 0 ? 'chg-up' : 'chg-down') : '';
  const chgStr   = chg != null ? (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%' : '';
  return `
<header class="header">
  <div class="logo"><div class="logo-dot"></div> Coinank Trader</div>
  <div class="header-right">
    <button class="btn-icon btn-lang" id="langBtn">${langLabel()}</button>
    <button class="btn-icon" id="settingsBtn" title="${t('settings')}">⚙</button>
  </div>
</header>
<div class="price-bar">
  <span class="price-bar-sym">${escapeHtml(state.symbol)}</span>
  ${tk ? `
  <span class="price-bar-price">${fmtPrice(tk.last)}</span>
  <span class="price-bar-change ${chgClass}">${chgStr}</span>
  <span class="price-bar-spread">${fmtPrice(tk.bid)} / ${fmtPrice(tk.ask)}</span>
  ` : `<span class="price-bar-loading">${t('loading_ticker')}</span>`}
</div>`;
}

function tabs() {
  const isHL = state.exchange === 'hyperliquid';
  return `
<div class="tabs">
  <button class="tab${state.tab==='trade'?' active':''}" data-tab="trade">${t('tab_trade')}</button>
  <button class="tab${state.tab==='orders'?' active':''}" data-tab="orders">${t('tab_orders')}</button>
  <div class="market-toggle">
    <button class="toggle-btn${state.marketType==='spot'?' active':''}" data-mkt="spot"${isHL?' disabled':''}>${t('market_spot')}</button>
    <button class="toggle-btn${state.marketType==='perp'?' active':''}" data-mkt="perp">${t('market_perp')}</button>
  </div>
</div>`;
}

function tradeForm() {
  const showPx = state.orderType !== 'market';
  const showSP = state.orderType === 'stop' || state.orderType === 'takeprofit';
  const quote  = quoteCcy();
  const base   = baseCcy();
  const isPerp = state.marketType === 'perp';
  const typeBadge = isPerp ? 'perp' : 'spot';
  const typeLabel = isPerp ? t('market_perp') : t('market_spot');

  return `
<div class="trade-form">

  <!-- 交易对选择 -->
  <div class="form-group">
    <label>${t('label_symbol')}</label>
    <button class="sym-trigger-btn" id="openSymModalBtn">
      <div class="sym-avatar sym-avatar-sm">${base[0]}</div>
      <span class="sym-trigger-name">${escapeHtml(state.symbol)}</span>
      <span class="sym-type-badge ${typeBadge}">${typeLabel}</span>
      <span class="sym-trigger-arrow">▾</span>
    </button>
  </div>

  <!-- 买卖方向 -->
  <div class="side-selector">
    <button class="side-btn buy${state.side==='buy'?' active':''}" data-side="buy">${t('btn_buy')}</button>
    <button class="side-btn sell${state.side==='sell'?' active':''}" data-side="sell">${t('btn_sell')}</button>
  </div>

  <!-- 订单类型 -->
  <div class="form-group">
    <label>${t('label_order_type')}</label>
    <div class="order-type-tabs">
      <button class="type-btn${state.orderType==='market'?' active':''}"     data-ot="market">${t('type_market')}</button>
      <button class="type-btn${state.orderType==='limit'?' active':''}"      data-ot="limit">${t('type_limit')}</button>
      <button class="type-btn${state.orderType==='stop'?' active':''}"       data-ot="stop">${t('type_stop')}</button>
      <button class="type-btn${state.orderType==='takeprofit'?' active':''}" data-ot="takeprofit">${t('type_takeprofit')}</button>
    </div>
  </div>

  <!-- 数量 -->
  <div class="form-group">
    <label>${t('label_amount')}</label>
    <div class="input-wrap">
      <input class="input" id="amtIn" type="number" value="${state.amount}" placeholder="0.000" min="0" step="any">
      <span class="input-suffix">${base}</span>
    </div>
    ${state.balance ? pctButtons() : ''}
  </div>

  <!-- 价格（限价/止损/止盈） -->
  ${showPx ? `
  <div class="form-group">
    <label>${showSP ? t('label_order_price') : t('label_price')}</label>
    <div class="input-wrap">
      <input class="input" id="pxIn" type="number" value="${state.price}" placeholder="0.00" min="0" step="any">
      <span class="input-suffix">${quote}</span>
    </div>
    ${state.ticker?.last ? `<div class="price-hint">${t('latest_price')} <strong>${fmtPrice(state.ticker.last)}</strong> <button class="btn-fill-price" id="fillPxBtn">${t('btn_fill')}</button></div>` : ''}
  </div>` : ''}

  <!-- 触发价格（止损/止盈） -->
  ${showSP ? `
  <div class="form-group">
    <label>${t('label_trigger_price')}</label>
    <div class="input-wrap">
      <input class="input" id="spIn" type="number" value="${state.stopPrice}" placeholder="0.00" min="0" step="any">
      <span class="input-suffix">${quote}</span>
    </div>
  </div>` : ''}

  <!-- 杠杆倍数（合约） -->
  ${isPerp ? `
  <div class="form-group">
    <label>${t('label_leverage')}</label>
    <div class="order-type-tabs">
      ${[1,2,3,5,10,20,25,50,75,100,125].map(x =>
        `<button class="type-btn${state.leverage===x?' active':''}" data-lev="${x}">${x}x</button>`
      ).join('')}
    </div>
  </div>` : ''}

  <!-- 只减仓（合约） -->
  ${isPerp ? `
  <div class="reduce-only-row">
    <label class="checkbox-label">
      <input type="checkbox" id="reduceOnlyChk"${state.reduceOnly?' checked':''}>
      <span>${t('reduce_only')}</span>
    </label>
  </div>` : ''}

  ${state.balance ? balanceBar() : ''}

  <div class="total-row">
    <span>${t('label_estimate')}</span>
    <span class="total-value">${estimateTotal()}</span>
  </div>

  <!-- 确认框（市价单） -->
  ${state.confirmPending ? confirmBox() : `
  <button class="submit-btn ${state.side}" id="submitBtn"${state.submitting || state.marketsLoading || state.uncertainOrders.length?' disabled':''}>
    ${state.submitting ? t('submitting') : submitLabel()}
  </button>`}

</div>`;
}

function pctButtons() {
  return `
<div class="pct-btns">
  <button class="pct-btn" data-pct="25">25%</button>
  <button class="pct-btn" data-pct="50">50%</button>
  <button class="pct-btn" data-pct="75">75%</button>
  <button class="pct-btn" data-pct="100">${t('all_in')}</button>
</div>`;
}

function confirmBox() {
  const amt = state.amount;
  const dir = t(state.side === 'buy' ? 'confirm_dir_buy' : 'confirm_dir_sell');
  return `
<div class="confirm-box">
  <p>${t('confirm_market', { dir, amt, base: baseCcy() })}</p>
  <p class="confirm-warn">${t('confirm_warn')}</p>
  <div class="confirm-btns">
    <button class="btn-confirm-yes" id="confirmYes">${t(state.side === 'buy' ? 'confirm_yes_buy' : 'confirm_yes_sell')}</button>
    <button class="btn-confirm-no"  id="confirmNo">${t('btn_cancel')}</button>
  </div>
</div>`;
}

function balanceBar() {
  const q = quoteCcy();
  const b = baseCcy();
  const qAvail = getAvail(q);
  const bAvail = getAvail(b);
  return `
<div class="balance-bar">
  <span>${t('label_available')} <strong>${bAvail} ${b}</strong></span>
  <span>/ <strong>${qAvail} ${q}</strong></span>
</div>`;
}

// ─── Symbol Modal ─────────────────────────────────────────────────────────────
function openSymModal() {
  state.symModalOpen    = true;
  state.symSearch       = '';
  state.symHighlight    = -1;
  state.symMarketFilter = 'all';
  forceRender();
  document.getElementById('symSearchInput')?.focus();
  stopModalTickerTimer();
  loadModalTickers();
  _modalTickerTimer = setInterval(loadModalTickers, 30000);
}

function closeSymModal() {
  state.symModalOpen = false;
  state.symTickers   = {};
  state.symHighlight = -1;
  stopModalTickerTimer();
  forceRender();
}

async function loadModalTickers() {
  const context = currentContext();
  const request = ++_modalRequest;
  state.symTickersLoading = true;
  try {
    const data = await sendMsg('getMarketTickers', { marketType: state.marketType });
    if (context !== currentContext() || request !== _modalRequest || !state.symModalOpen) return;
    state.symTickers = data || {};
  } catch (_) {
    if (context !== currentContext() || request !== _modalRequest) return;
    state.symTickers = {};
  }
  state.symTickersLoading = false;
  refreshSymModal();
}

function refreshSymModal() {
  const listEl = document.getElementById('symModalList');
  if (!listEl) return;
  listEl.innerHTML = symModalListItems();
  bindSymModalListEvents();
}

function symModal() {
  const isHL = state.exchange === 'hyperliquid';
  return `
<div class="sym-modal-overlay" id="symModalOverlay">
  <div class="sym-modal">
    <div class="sym-modal-header">
      <span class="sym-modal-title">搜索交易对</span>
      <button class="sym-modal-close" id="symModalClose">✕</button>
    </div>
    <div class="sym-search-wrap">
      <span class="sym-search-icon">🔍</span>
      <input class="sym-search-input" id="symSearchInput" type="text"
        value="${escapeHtml(state.symSearch)}" placeholder="BTC, ETH, SOL..."
        autocomplete="off" spellcheck="false">
    </div>
    <div class="sym-exchange-row">
      ${EXCHANGES.map(ex => {
        const active = state.exchange === ex ? ' active' : '';
        return `<button class="ex-chip ex-chip-${ex}${active}" data-ex="${ex}">
          <span class="ex-chip-icon">${EX_LABEL[ex][0]}</span>
          <span class="ex-chip-name">${EX_LABEL[ex]}</span>
        </button>`;
      }).join('')}
    </div>
    <div class="sym-modal-tabs">
      <button class="sym-tab${state.symMarketFilter==='fav'?' active':''}"  data-filter="fav">⭐ 收藏</button>
      <button class="sym-tab${state.symMarketFilter==='all'?' active':''}"  data-filter="all">全部</button>
      <button class="sym-tab${state.symMarketFilter==='perp'?' active':''}" data-filter="perp">永续</button>
      <button class="sym-tab${state.symMarketFilter==='spot'?' active':''}" data-filter="spot"${isHL?' disabled':''}>现货</button>
    </div>
    <div class="sym-list-header">
      <span></span>
      <span></span>
      <span>交易对</span>
      <span></span>
      <span class="col-right">价格</span>
      <span class="col-right">涨跌%</span>
    </div>
    <div class="sym-list" id="symModalList">
      ${symModalListItems()}
    </div>
  </div>
</div>`;
}

const AVATAR_COLORS = ['#3d7fff','#00c076','#f0b90b','#ff4560','#7B61FF','#00C8D4','#F3BA2F'];

function symModalListItems() {
  if (state.marketsLoading) {
    return `<div class="sym-empty">加载中...</div>`;
  }

  const kw = (state.symSearch || '').toUpperCase().trim();
  let list = [...state.markets];

  if (state.symMarketFilter === 'fav') {
    list = state.symFavorites.filter(s => state.markets.includes(s));
    if (!list.length) {
      return `<div class="sym-empty">暂无收藏，点击 ★ 添加</div>`;
    }
  }

  if (kw) {
    const prefix   = list.filter(s => s.toUpperCase().startsWith(kw));
    const contains = list.filter(s => !s.toUpperCase().startsWith(kw) && s.toUpperCase().includes(kw));
    list = [...prefix, ...contains];
  } else if (state.symMarketFilter !== 'fav') {
    const recent = state.recentSymbols.filter(s => list.includes(s));
    const rest   = list.filter(s => !recent.includes(s));
    list = [...recent, ...rest];
  }

  if (!list.length) {
    return `<div class="sym-empty">${state.markets.length ? '无匹配结果' : '暂无数据'}</div>`;
  }

  const shown  = list.slice(0, 100);
  const isPerp = state.marketType === 'perp';
  const typeBadge = isPerp ? 'perp' : 'spot';
  const typeLabel = isPerp ? '永续' : '现货';

  return shown.map((s, i) => {
    const safeSymbol = escapeHtml(s);
    const isFav = state.symFavorites.includes(s);
    const tk    = state.symTickers[s];
    const priceStr = tk?.price != null ? fmtPrice(tk.price) : '—';
    const chg   = tk?.change;
    const chgClass = chg != null ? (chg >= 0 ? 'chg-up' : 'chg-down') : '';
    const chgStr   = chg != null ? (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%' : '—';
    const base     = s.includes('/') ? s.split('/')[0] : s;
    const color    = AVATAR_COLORS[base.charCodeAt(0) % AVATAR_COLORS.length];
    const highlighted = i === state.symHighlight ? ' highlighted' : '';
    const active   = s === state.symbol ? ' sym-active' : '';

    return `<div class="sym-row${highlighted}${active}" data-sym="${safeSymbol}" data-idx="${i}">
      <button class="sym-fav-btn${isFav?' fav-active':''}" data-fav="${safeSymbol}">★</button>
      <div class="sym-avatar" style="background:${color}">${base[0]}</div>
      <span class="sym-row-sym">${safeSymbol}</span>
      <span class="sym-type-badge ${typeBadge}">${typeLabel}</span>
      <span class="sym-row-price">${priceStr}</span>
      <span class="sym-row-chg ${chgClass}">${chgStr}</span>
    </div>`;
  }).join('');
}

function bindSymModalEvents() {
  q('#symModalOverlay')?.addEventListener('click', e => {
    if (e.target.id === 'symModalOverlay') closeSymModal();
  });
  q('#symModalClose')?.addEventListener('click', closeSymModal);

  const input = q('#symSearchInput');
  if (input) {
    input.addEventListener('input', e => {
      state.symSearch    = e.target.value;
      state.symHighlight = -1;
      refreshSymModal();
    });
    input.addEventListener('keydown', handleModalKeydown);
  }

  qAll('.ex-chip').forEach(btn => btn.addEventListener('click', () => {
    const ex = btn.dataset.ex;
    if (ex === state.exchange) return;
    resetTradingContext();
    state.exchange = ex;
    if (state.exchange === 'hyperliquid') state.marketType = 'perp';
    chrome.storage.local.set({ selectedExchange: state.exchange, lastMarket: state.marketType });
    qAll('.ex-chip').forEach(c => c.classList.toggle('active', c.dataset.ex === state.exchange));
    state.markets    = [];
    state.symTickers = {};
    silentLoadBalance();
    reloadMarketsThenTicker();
    startBalanceRefresh();
    stopModalTickerTimer();
    loadModalTickers();
    _modalTickerTimer = setInterval(loadModalTickers, 30000);
  }));

  qAll('.sym-tab').forEach(btn => btn.addEventListener('click', () => {
    const filter = btn.dataset.filter;
    // Hyperliquid 不支持现货，忽略点击
    if (filter === 'spot' && state.exchange === 'hyperliquid') return;
    state.symMarketFilter = filter;
    state.symHighlight    = -1;
    if ((filter === 'perp' || filter === 'spot') && state.marketType !== filter) {
      resetTradingContext();
      state.marketType = filter;
      state.markets    = [];
      state.symTickers = {};
      chrome.storage.local.set({ lastMarket: state.marketType });
      silentLoadBalance();
      reloadMarketsThenTicker();
      stopModalTickerTimer();
      loadModalTickers();
      _modalTickerTimer = setInterval(loadModalTickers, 30000);
    }
    qAll('.sym-tab').forEach(t => t.classList.toggle('active', t.dataset.filter === filter));
    refreshSymModal();
  }));

  bindSymModalListEvents();
}

function bindSymModalListEvents() {
  qAll('#symModalList .sym-row').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('.sym-fav-btn')) return;
      selectSymbol(row.dataset.sym);
    });
  });
  qAll('#symModalList .sym-fav-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      toggleFavorite(btn.dataset.fav);
    });
  });
}

function handleModalKeydown(e) {
  const items = qAll('#symModalList .sym-row');
  if (!items.length) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    state.symHighlight = Math.min(state.symHighlight + 1, items.length - 1);
    refreshSymModal();
    q('#symModalList .sym-row.highlighted')?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    state.symHighlight = Math.max(state.symHighlight - 1, -1);
    refreshSymModal();
    q('#symModalList .sym-row.highlighted')?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    const target = state.symHighlight >= 0 ? items[state.symHighlight] : items[0];
    if (target) selectSymbol(target.dataset.sym);
  } else if (e.key === 'Escape') {
    closeSymModal();
  }
}

function toggleFavorite(sym) {
  const i = state.symFavorites.indexOf(sym);
  if (i >= 0) state.symFavorites.splice(i, 1);
  else state.symFavorites.unshift(sym);
  chrome.storage.local.set({ symFavorites: state.symFavorites });
  refreshSymModal();
}

function selectSymbol(sym) {
  if (sym !== state.symbol) resetTradingContext();
  state.symbol        = sym;
  state.recentSymbols = [sym, ...state.recentSymbols.filter(s => s !== sym)].slice(0, 5);
  state.symModalOpen  = false;
  state.symTickers    = {};
  state.symHighlight  = -1;
  state.ticker        = null;
  stopModalTickerTimer();
  chrome.storage.local.set({ lastSymbol: state.symbol, recentSymbols: state.recentSymbols });
  forceRender();
  silentLoadBalance();
  startTickerRefresh();
}

// ─── 事件绑定 ─────────────────────────────────────────────────────────────────
function bind() {
  q('#ackUnknownOrder')?.addEventListener('click', async () => {
    if (state.acknowledging) return;
    if (!confirm(t('confirm_order_checked'))) return;
    state.acknowledging = true; render();
    try {
      const orders = [...state.uncertainOrders];
      for (const order of orders) await sendMsg('acknowledgeOrder', { requestId: order.params.requestId }, order.exchange);
      await refreshPendingOrders();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      state.acknowledging = false; render();
    }
  });
  q('#settingsBtn')?.addEventListener('click', () => chrome.runtime.openOptionsPage());
  q('#langBtn')?.addEventListener('click', async () => {
    await cycleLang();
    render();
  });

  qAll('[data-tab]').forEach(b => b.addEventListener('click', () => {
    state.tab = b.dataset.tab;
    if (state.tab === 'orders') {
      if (state.ordersTab === 'positions') loadPositions();
      else loadOrders();
    } else {
      startTickerRefresh();
    }
    render();
  }));

  qAll('[data-mkt]').forEach(b => b.addEventListener('click', () => {
    if (state.marketType === b.dataset.mkt) return;
    resetTradingContext();
    state.marketType = b.dataset.mkt;
    state.markets = []; state.ticker = null;
    if (state.marketType === 'spot' && state.ordersTab === 'positions') state.ordersTab = 'open';
    chrome.storage.local.set({ lastMarket: state.marketType });
    render(); silentLoadBalance();
    reloadMarketsThenTicker().then(() => {
      if (state.tab === 'orders') state.ordersTab === 'positions' ? loadPositions() : loadOrders();
    });
    startBalanceRefresh();
  }));

  qAll('[data-side]').forEach(b => b.addEventListener('click', () => {
    state.side = b.dataset.side; render();
  }));
  qAll('[data-ot]').forEach(b => b.addEventListener('click', () => {
    state.orderType = b.dataset.ot; render();
  }));

  // ── Symbol modal trigger ──
  q('#openSymModalBtn')?.addEventListener('click', openSymModal);

  // ── 数量输入 + % 快捷按钮 ──
  q('#amtIn')?.addEventListener('input', e => { state.amount = e.target.value; });
  qAll('.pct-btn').forEach(b => b.addEventListener('click', async () => {
    const context = currentContext();
    const pct = parseInt(b.dataset.pct);
    if (state.marketType === 'perp' && state.reduceOnly) {
      try {
        const positions = await sendMsg('getPositions', { symbol: state.symbol, marketType: 'perp' });
        if (context !== currentContext()) return;
        state.positions = positions;
      } catch (e) { toast(e.message, 'error'); return; }
    }
    const amt = calcPctAmount(pct);
    if (amt) { state.amount = amt; render(); }
    else toast(t('msg_fill_price'), 'error');
  }));

  // ── 价格输入 + 填入最新价 ──
  q('#pxIn')?.addEventListener('input', e => { state.price = e.target.value; });
  q('#fillPxBtn')?.addEventListener('click', () => {
    if (state.ticker?.last) { state.price = String(state.ticker.last); render(); }
  });

  // ── 触发价格 ──
  q('#spIn')?.addEventListener('input', e => { state.stopPrice = e.target.value; });

  // ── 杠杆倍数 ──
  qAll('[data-lev]').forEach(b => b.addEventListener('click', () => {
    state.leverage = parseInt(b.dataset.lev); render();
  }));

  // ── 只减仓 ──
  q('#reduceOnlyChk')?.addEventListener('change', e => { state.reduceOnly = e.target.checked; });

  // ── 下单 / 确认 ──
  q('#submitBtn')?.addEventListener('click', () => submitOrder());
  q('#confirmYes')?.addEventListener('click', () => { submitOrder(true); });
  q('#confirmNo')?.addEventListener('click',  () => { state.confirmPending = false; render(); });

  // ── 订单 tab ──
  qAll('[data-otab]').forEach(b => b.addEventListener('click', () => {
    state.ordersTab = b.dataset.otab;
    if (state.ordersTab === 'positions') loadPositions();
    else loadOrders();
    render();
  }));
  q('#refreshBtn')?.addEventListener('click', () => {
    if (state.ordersTab === 'positions') loadPositions();
    else loadOrders();
  });

  qAll('.cancel-btn').forEach(b => b.addEventListener('click', () => {
    doCancelOrder(b.dataset.oid, b.dataset.sym, b.dataset.isAlgo === '1', b.dataset.cancelKind, b.dataset.planType);
  }));
}

// ─── Orders / Positions UI ────────────────────────────────────────────────────
function ordersPanel() {
  const isPerp    = state.marketType === 'perp';
  const showPos   = isPerp && state.ordersTab === 'positions';

  return `
<div>
  <div class="orders-tabs">
    <button class="orders-tab${state.ordersTab==='open'?' active':''}" data-otab="open">${t('orders_open')}</button>
    <button class="orders-tab${state.ordersTab==='history'?' active':''}" data-otab="history">${t('orders_history')}</button>
    ${isPerp ? `<button class="orders-tab${state.ordersTab==='positions'?' active':''}" data-otab="positions">${t('orders_positions')}</button>` : ''}
    <button class="btn-refresh" id="refreshBtn">↻</button>
  </div>
  ${state.loading ? `<div class="loading">${t('loading')}</div>` : ''}
  ${state.ordersWarning && !showPos ? `<div class="confirm-box">${escapeHtml(state.ordersWarning)}</div>` : ''}
  ${state.ordersError ? `<div class="empty">${escapeHtml(state.ordersError)}</div>` : (showPos ? positionsList() : ordersList())}
</div>`;
}

function ordersList() {
  return `
<div class="orders-list">
  ${state.orders.length === 0
    ? `<div class="empty">${t('no_orders')}</div>`
    : state.orders.map(orderCard).join('')}
</div>`;
}

function positionsList() {
  return `
<div class="orders-list">
  ${state.positions.length === 0
    ? `<div class="empty">${t('no_positions')}</div>`
    : state.positions.map(positionCard).join('')}
</div>`;
}

function orderCard(o) {
  const timeStr = o.time ? new Date(Number(o.time)).toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }) : '';
  const sideLabel = o.side === 'buy' ? t('side_buy_label') : t('side_sell_label');
  const typeLabel = t(TYPE_KEY[o.type]) || o.type;
  const statusLabel = t(STATUS_KEY[o.status]) || o.status;
  return `
<div class="order-item">
  <div class="order-header">
    <span class="order-symbol">${escapeHtml(o.symbol || '-')}</span>
    <span class="order-side ${o.side}">${sideLabel}</span>
    <span class="order-type">${typeLabel}</span>
  </div>
  <div class="order-details">
    <span>${escapeHtml(o.amount || '-')} ${o.price ? '@ ' + escapeHtml(o.price) : ''} ${o.stopPrice ? escapeHtml(t('label_trigger_price')) + ': ' + escapeHtml(o.stopPrice) : ''} ${timeStr}</span>
    <span class="status-${o.status}">${statusLabel}</span>
  </div>
  ${state.ordersTab === 'open' ? `
  <button class="cancel-btn" data-oid="${escapeHtml(o.id)}" data-sym="${escapeHtml(o.symbol)}" data-is-algo="${o.isAlgo?'1':'0'}" data-cancel-kind="${escapeHtml(o.cancelKind)}" data-plan-type="${escapeHtml(o.planType)}">${t('btn_cancel_order')}</button>` : ''}
</div>`;
}

function positionCard(p) {
  const pnl = parseFloat(p.unrealizedPnl);
  const pnlClass = pnl >= 0 ? 'pnl-pos' : 'pnl-neg';
  const sideLabel = p.side === 'long' ? t('pos_long') : t('pos_short');
  return `
<div class="position-item">
  <div class="pos-header">
    <span class="pos-symbol">${escapeHtml(p.symbol)}</span>
    <span class="pos-side ${p.side}">${sideLabel}</span>
    ${p.leverage ? `<span class="pos-leverage">${p.leverage}x</span>` : ''}
    ${p.marginType ? `<span class="pos-margin-type">${p.marginType}</span>` : ''}
  </div>
  <div class="pos-grid">
    <div class="pos-row"><span>${t('pos_contracts')}</span><span>${escapeHtml(p.amount ?? p.contracts)} ${escapeHtml(p.base || '')}</span></div>
    <div class="pos-row"><span>${t('pos_entry')}</span><span>${p.entryPrice || '-'}</span></div>
    <div class="pos-row"><span>${t('pos_mark')}</span><span>${p.markPrice || '-'}</span></div>
    <div class="pos-row"><span>${t('pos_pnl')}</span><span class="${pnlClass}">${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)}</span></div>
    <div class="pos-row"><span>${t('pos_liq')}</span><span class="liq-price">${p.liquidationPrice || '-'}</span></div>
  </div>
</div>`;
}

// ─── API 调用 ─────────────────────────────────────────────────────────────────
async function getCredentials(exchange) {
  const key = `credentials_${exchange}`;
  const s = await chrome.storage.local.get(key);
  return s[key] || null;
}

async function sendMsg(action, params, exchange = state.exchange) {
  const creds = PUBLIC_ACTIONS.has(action) ? null : await getCredentials(exchange);
  if (!creds && !PUBLIC_ACTIONS.has(action)) {
    throw new Error(t('msg_need_api', { exchange: EX_LABEL[exchange] }));
  }
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { action, exchange, credentials: creds, params },
      res => {
        if (chrome.runtime.lastError || !res) {
          const error = new Error(chrome.runtime.lastError?.message || '插件未返回结果，请先核对交易所订单后重试');
          error.code = 'TRANSPORT_ERROR'; return reject(error);
        }
        if (res.ok) return resolve(res.data);
        const error = new Error(res.error); error.code = res.code; reject(error);
      }
    );
  });
}

async function submitOrder(confirmed = false) {
  if (state.submitting || state.uncertainOrders.length) return;
  if (!Number.isFinite(Number(state.amount)) || Number(state.amount) <= 0) return toast(t('msg_enter_amount'), 'error');
  if (state.orderType === 'limit' && !(Number(state.price) > 0)) return toast(t('msg_enter_price'), 'error');
  if ((state.orderType === 'stop' || state.orderType === 'takeprofit') && !(Number(state.stopPrice) > 0))
    return toast(t('msg_enter_trigger'), 'error');

  const exchange = state.exchange;
  const context = currentContext();
  const params = {
    symbol: state.symbol, side: state.side, orderType: state.orderType, amount: state.amount,
    price: state.price, stopPrice: state.stopPrice, marketType: state.marketType,
    reduceOnly: state.reduceOnly, leverage: state.marketType === 'perp' ? state.leverage : undefined,
  };
  const signature = JSON.stringify({ exchange, ...params });
  if (state.orderType === 'market' && (confirmed !== true || state.confirmOrder !== signature)) {
    state.confirmPending = true; state.confirmOrder = signature; render(); return;
  }
  state.confirmPending = false; state.confirmOrder = null;
  state.submitting = true; render();
  params.requestId = crypto.randomUUID().replace(/-/g, '');
  state.activeRequestId = params.requestId;
  const record = { exchange, params, time: Date.now(), phase: 'queued' };
  const pendingKey = `pendingTrade_${params.requestId}`;
  let dispatched = false;
  let accepted = false;

  try {
    await chrome.storage.local.set({ [pendingKey]: record });
    dispatched = true;
    await sendMsg('placeOrder', params, exchange);
    accepted = true;
    await chrome.storage.local.remove(pendingKey);
    if (context === currentContext() && state.amount === params.amount) state.amount = '';
    toast(`${EX_LABEL[exchange]} ${params.symbol}: ${t('msg_order_success')}`, 'success');
    silentLoadBalance();
  } catch (e) {
    const uncertain = dispatched && (accepted || !['ORDER_REJECTED', 'REQUEST_REJECTED'].includes(e.code));
    if (uncertain) state.uncertainOrders.push(record);
    else {
      try { await chrome.storage.local.remove(pendingKey); } catch (_) {}
    }
    toast(uncertain ? `${e.message}。订单结果未确认，请先核对交易所订单，勿直接重复提交。` : e.message, 'error');
  } finally {
    state.activeRequestId = null;
    state.submitting = false; render();
  }
}

async function loadOrders() {
  const context = currentContext();
  const tab = state.ordersTab;
  const request = ++_ordersRequest;
  state.loading = true; state.ordersError = null; state.ordersWarning = null; render();
  try {
    const action = tab === 'open' ? 'getOpenOrders' : 'getOrderHistory';
    const data = await sendMsg(action, { symbol: state.symbol, marketType: state.marketType });
    if (context !== currentContext() || tab !== state.ordersTab || request !== _ordersRequest) return;
    state.orders = Array.isArray(data) ? data : (data?.orders || []);
    state.ordersWarning = data?.warning || null;
  } catch (e) {
    if (context !== currentContext() || tab !== state.ordersTab || request !== _ordersRequest) return;
    state.ordersError = e.message;
  } finally {
    if (context === currentContext() && tab === state.ordersTab && request === _ordersRequest) {
      state.loading = false; render();
    }
  }
}

async function loadPositions() {
  const context = currentContext();
  const request = ++_positionsRequest;
  state.loading = true; state.ordersError = null; render();
  try {
    const data = await sendMsg('getPositions', { symbol: state.symbol, marketType: 'perp' });
    if (context !== currentContext() || state.ordersTab !== 'positions' || request !== _positionsRequest) return;
    state.positions = Array.isArray(data) ? data : [];
  } catch (e) {
    if (context !== currentContext() || state.ordersTab !== 'positions' || request !== _positionsRequest) return;
    state.ordersError = e.message;
  } finally {
    if (context === currentContext() && state.ordersTab === 'positions' && request === _positionsRequest) { state.loading = false; render(); }
  }
}

async function doCancelOrder(orderId, symbol, isAlgo, cancelKind, planType) {
  const context = currentContext();
  try {
    await sendMsg('cancelOrder', { symbol: symbol || state.symbol, orderId, isAlgo, cancelKind, planType, marketType: state.marketType });
    if (context !== currentContext()) return;
    toast(t('msg_cancel_success'), 'success');
    loadOrders();
  } catch (e) { if (context === currentContext()) toast(e.message, 'error'); }
}

async function silentLoadBalance() {
  const context = currentContext();
  const request = ++_balanceRequest;
  try {
    const data = await sendMsg('getBalance', { symbol: state.symbol, marketType: state.marketType });
    if (context !== currentContext() || request !== _balanceRequest) return;
    state.balance = Array.isArray(data) ? data : null;
  } catch (_) {
    if (context !== currentContext() || request !== _balanceRequest) return;
    state.balance = null;
  }
  render();
}

async function silentLoadMarkets(forceReload = false) {
  const requestedExchange = state.exchange;
  const requestedMarketType = state.marketType;
  const request = ++_marketsRequest;
  state.marketsLoading = true;
  if (state.symModalOpen) refreshSymModal(); // 弹窗内显示「加载中」
  else render();
  try {
    const data = await sendMsg('getMarkets', { marketType: state.marketType, forceReload });
    if (state.exchange !== requestedExchange || state.marketType !== requestedMarketType || request !== _marketsRequest) return false;
    state.markets = Array.isArray(data) ? data : [];
    syncSymbolToLoadedMarkets();
  } catch (_) {
    if (state.exchange !== requestedExchange || state.marketType !== requestedMarketType || request !== _marketsRequest) return false;
    state.markets = [];
  }
  state.marketsLoading = false;
  if (state.symModalOpen) refreshSymModal();
  else render();
  return true;
}

async function reloadMarketsThenTicker(forceReload = false) {
  const ok = await silentLoadMarkets(forceReload);
  if (ok) { startTickerRefresh(); silentLoadBalance(); }
  return ok;
}

function syncSymbolToLoadedMarkets() {
  if (!state.markets.length || state.markets.includes(state.symbol)) return;
  const base  = baseCcy();
  const quote = quoteCcy();
  const preferred = state.marketType === 'perp'
    ? [`${base}/${quote}:${quote}`, `${base}/USDT:USDT`, `${base}/USDC:USDC`]
    : [`${base}/${quote}`];
  let next = preferred.find(sym => state.markets.includes(sym));
  if (!next) {
    next = state.markets.find(sym => {
      const [b, rest = ''] = sym.split('/');
      return b.toUpperCase() === base && rest.split(':')[0].toUpperCase() === quote;
    });
  }
  if (!next) return;
  state.symbol = next;
  state.ticker = null;
  chrome.storage.local.set({ lastSymbol: state.symbol });
}

async function silentLoadTicker() {
  const context = currentContext();
  if (_tickerPending === context) return;
  _tickerPending = context;
  const request = ++_tickerRequest;
  try {
    const data = await sendMsg('getTicker', { symbol: state.symbol, marketType: state.marketType });
    if (context !== currentContext() || request !== _tickerRequest) return;
    state.ticker = data;
  } catch (_) {
    if (context !== currentContext() || request !== _tickerRequest) return;
    state.ticker = null;
  } finally {
    if (_tickerPending === context) _tickerPending = null;
  }
  render();
}

// ─── 辅助函数 ─────────────────────────────────────────────────────────────────
function baseCcy() {
  if (state.symbol.includes('/')) return state.symbol.split('/')[0].toUpperCase();
  for (const q of ['USDT','BUSD','USDC']) if (state.symbol.toUpperCase().endsWith(q)) return state.symbol.toUpperCase().slice(0,-q.length);
  return state.symbol.toUpperCase();
}
function quoteCcy() {
  if (state.symbol.includes('/')) return state.symbol.split('/')[1].split(':')[0].toUpperCase();
  for (const q of ['USDT','BUSD','USDC']) if (state.symbol.toUpperCase().endsWith(q)) return q;
  return 'USDT';
}
function fmtPrice(n) {
  if (n == null) return '-';
  const v = parseFloat(n);
  if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (v >= 1)    return v.toFixed(4);
  return v.toFixed(6);
}
function estimateTotal() {
  const amt = parseFloat(state.amount) || 0;
  const px  = parseFloat(state.price) || (['stop', 'takeprofit'].includes(state.orderType) ? Number(state.stopPrice) : 0) || state.ticker?.last || 0;
  if (state.orderType === 'market') {
    if (!amt || !state.ticker?.last) return t('market_price_label');
    return `≈ ${(amt * state.ticker.last).toFixed(2)} ${quoteCcy()}`;
  }
  if (!amt || !px) return `0.00 ${quoteCcy()}`;
  return `≈ ${(amt * px).toFixed(2)} ${quoteCcy()}`;
}
function getAvail(currency) {
  if (!state.balance) return '0';
  const list = Array.isArray(state.balance) ? state.balance : [];
  for (const b of list) {
    const ccy = b.asset || b.ccy || b.currency || b.coin || '';
    if (ccy.toUpperCase() === currency.toUpperCase()) {
      const v = Number(b.free ?? b.available ?? b.walletBalance ?? 0);
      return Number.isFinite(v) && v > 0 ? String(v) : '0';
    }
  }
  return '0';
}
function calcPctAmount(pct) {
  const base = baseCcy(), quote = quoteCcy();
  if (state.marketType === 'perp' && state.reduceOnly) {
    const side = state.side === 'sell' ? 'long' : 'short';
    const available = state.positions.filter(p => p.symbol === state.symbol && p.side === side)
      .reduce((sum, p) => sum + Number(p.amount || 0), 0);
    return available > 0 ? String(available * pct / 100) : '';
  }
  if (state.side === 'sell' && state.marketType !== 'perp') {
    const available = Number(getAvail(base));
    return available > 0 ? String(available * pct / 100) : '';
  }
  const px = state.orderType === 'market' ? state.ticker?.last : (Number(state.price) || (['stop', 'takeprofit'].includes(state.orderType) ? Number(state.stopPrice) : 0) || state.ticker?.last);
  const available = Number(getAvail(quote));
  if (!(px > 0) || !available) return '';
  const leverage = state.marketType === 'perp' ? state.leverage : 1;
  return String(available * pct / 100 * leverage / px * .995);
}
function submitLabel() {
  const typeKey = { market: 'type_market', limit: 'type_limit', stop: 'type_stop', takeprofit: 'type_takeprofit' };
  const type = t(typeKey[state.orderType] || state.orderType);
  const key  = state.side === 'buy' ? 'submit_buy' : 'submit_sell';
  return t(key, { type, base: baseCcy() });
}
function toast(msg, type = 'info') {
  state.toast = { msg, type };
  render();
  setTimeout(() => { state.toast = null; render(); }, 3000);
}
const q    = s => document.querySelector(s);
const qAll = s => document.querySelectorAll(s);

document.addEventListener('DOMContentLoaded', init);
