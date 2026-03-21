// ─── 状态 ────────────────────────────────────────────────────────────────────
const state = {
  exchange:   'binance',
  tab:        'trade',    // 'trade' | 'orders'
  ordersTab:  'open',     // 'open' | 'history'
  symbol:     'BTC/USDT',
  marketType: 'spot',     // 'spot' | 'perp'
  side:       'buy',
  orderType:  'limit',    // 'market' | 'limit' | 'stop'
  amount:     '',
  price:      '',
  stopPrice:  '',
  orders:     [],
  balance:    null,
  loading:    false,
  toast:      null,       // { msg, type }
};

const EXCHANGES = ['binance', 'okx', 'bybit', 'bitget', 'hyperliquid'];
const EX_LABEL  = { binance: 'Binance', okx: 'OKX', bybit: 'Bybit', bitget: 'Bitget', hyperliquid: 'Hyperliquid' };
const STATUS_ZH = {
  new: '挂单中', open: '挂单中', live: '挂单中',
  partially_filled: '部分成交',
  filled: '已成交',
  canceled: '已撤销', cancelled: '已撤销',
  rejected: '已拒绝', triggered: '已触发',
};
const TYPE_ZH   = { market: '市价', limit: '限价', stop: '止损', conditional: '条件单' };

// ─── 初始化 ──────────────────────────────────────────────────────────────────
async function init() {
  const s = await chrome.storage.local.get(['selectedExchange', 'lastSymbol', 'lastMarket']);
  if (s.selectedExchange) state.exchange   = s.selectedExchange;
  if (s.lastSymbol)       state.symbol     = s.lastSymbol;
  if (s.lastMarket)       state.marketType = s.lastMarket;
  render();
  silentLoadBalance();
}

// ─── 渲染 ────────────────────────────────────────────────────────────────────
function render() {
  document.getElementById('app').innerHTML = html();
  bind();
}

function html() {
  return `
<div>
  ${header()}
  ${tabs()}
  <div class="content">
    ${state.tab === 'trade' ? tradeForm() : ordersPanel()}
  </div>
  ${state.toast ? `<div class="toast toast-${state.toast.type}">${state.toast.msg}</div>` : ''}
</div>`;
}

function header() {
  return `
<header class="header">
  <div class="logo"><div class="logo-dot"></div> Coinank Trader</div>
  <div class="header-right">
    <select class="exchange-select" id="exSel">
      ${EXCHANGES.map(e => `<option value="${e}"${state.exchange===e?' selected':''}>${EX_LABEL[e]}</option>`).join('')}
    </select>
    <button class="btn-icon" id="settingsBtn" title="设置">⚙</button>
  </div>
</header>`;
}

function tabs() {
  return `
<div class="tabs">
  <button class="tab${state.tab==='trade'?' active':''}" data-tab="trade">交易</button>
  <button class="tab${state.tab==='orders'?' active':''}" data-tab="orders">订单</button>
</div>`;
}

function tradeForm() {
  const isHL    = state.exchange === 'hyperliquid';
  const showPx  = state.orderType !== 'market';
  const showSP  = state.orderType === 'stop';
  const quote   = quoteCcy();
  const base    = baseCcy();

  return `
<div class="trade-form">
  <div class="form-group">
    <div class="field-row">
      <label>交易对</label>
      <div class="market-toggle">
        <button class="toggle-btn${state.marketType==='spot'?' active':''}" data-mkt="spot"${isHL?' disabled':''}>现货</button>
        <button class="toggle-btn${state.marketType==='perp'?' active':''}" data-mkt="perp">合约</button>
      </div>
    </div>
    <input class="input" id="symIn" type="text" value="${state.symbol}" placeholder="BTC/USDT">
  </div>

  <div class="side-selector">
    <button class="side-btn buy${state.side==='buy'?' active':''}" data-side="buy">买入 / Long</button>
    <button class="side-btn sell${state.side==='sell'?' active':''}" data-side="sell">卖出 / Short</button>
  </div>

  <div class="form-group">
    <label>订单类型</label>
    <div class="order-type-tabs">
      <button class="type-btn${state.orderType==='market'?' active':''}" data-ot="market">市价</button>
      <button class="type-btn${state.orderType==='limit'?' active':''}"  data-ot="limit">限价</button>
      <button class="type-btn${state.orderType==='stop'?' active':''}"   data-ot="stop">止损</button>
    </div>
  </div>

  <div class="form-group">
    <label>数量</label>
    <div class="input-wrap">
      <input class="input" id="amtIn" type="number" value="${state.amount}" placeholder="0.000" min="0" step="any">
      <span class="input-suffix">${base}</span>
    </div>
  </div>

  ${showPx ? `
  <div class="form-group">
    <label>${state.orderType==='stop'?'委托价格':'价格'}</label>
    <div class="input-wrap">
      <input class="input" id="pxIn" type="number" value="${state.price}" placeholder="0.00" min="0" step="any">
      <span class="input-suffix">${quote}</span>
    </div>
  </div>` : ''}

  ${showSP ? `
  <div class="form-group">
    <label>触发价格</label>
    <div class="input-wrap">
      <input class="input" id="spIn" type="number" value="${state.stopPrice}" placeholder="0.00" min="0" step="any">
      <span class="input-suffix">${quote}</span>
    </div>
  </div>` : ''}

  ${state.balance ? balanceBar() : ''}

  <div class="total-row">
    <span>预估金额</span>
    <span class="total-value">${estimateTotal()}</span>
  </div>

  <button class="submit-btn ${state.side}" id="submitBtn"${state.loading?' disabled':''}>
    ${state.loading ? '提交中...' : submitLabel()}
  </button>
</div>`;
}

function balanceBar() {
  const q = quoteCcy();
  const avail = getAvail(q);
  return `<div class="balance-bar">可用: <strong>${avail} ${q}</strong></div>`;
}

function ordersPanel() {
  return `
<div>
  <div class="orders-tabs">
    <button class="orders-tab${state.ordersTab==='open'?' active':''}" data-otab="open">挂单</button>
    <button class="orders-tab${state.ordersTab==='history'?' active':''}" data-otab="history">历史</button>
    <button class="btn-refresh" id="refreshBtn">↻</button>
  </div>
  ${state.loading ? '<div class="loading">加载中...</div>' : ''}
  <div class="orders-list">
    ${state.orders.length === 0
      ? '<div class="empty">暂无订单</div>'
      : state.orders.map(orderCard).join('')}
  </div>
</div>`;
}

function orderCard(o) {
  const statusClass = `status-${o.status}`;
  const timeStr = o.time ? new Date(Number(o.time)).toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }) : '';
  return `
<div class="order-item">
  <div class="order-header">
    <span class="order-symbol">${o.symbol || '-'}</span>
    <span class="order-side ${o.side}">${o.side === 'buy' ? '买入' : '卖出'}</span>
    <span class="order-type">${TYPE_ZH[o.type] || o.type}</span>
  </div>
  <div class="order-details">
    <span>${o.amount || '-'} ${o.price ? '@ ' + o.price : ''} ${timeStr}</span>
    <span class="${statusClass}">${STATUS_ZH[o.status] || o.status}</span>
  </div>
  ${state.ordersTab === 'open' ? `
  <button class="cancel-btn" data-oid="${o.id}" data-sym="${o.symbol}" data-is-algo="${o.isAlgo ? '1' : '0'}">撤单</button>` : ''}
</div>`;
}

// ─── 事件绑定 ─────────────────────────────────────────────────────────────────
function bind() {
  q('#exSel')?.addEventListener('change', e => {
    state.exchange = e.target.value;
    chrome.storage.local.set({ selectedExchange: state.exchange });
    render(); silentLoadBalance();
  });
  q('#settingsBtn')?.addEventListener('click', () => chrome.runtime.openOptionsPage());

  qAll('[data-tab]').forEach(b => b.addEventListener('click', () => {
    state.tab = b.dataset.tab;
    if (state.tab === 'orders') loadOrders();
    render();
  }));
  qAll('[data-mkt]').forEach(b => b.addEventListener('click', () => {
    state.marketType = b.dataset.mkt;
    chrome.storage.local.set({ lastMarket: state.marketType });
    render(); silentLoadBalance();
  }));
  qAll('[data-side]').forEach(b => b.addEventListener('click', () => { state.side = b.dataset.side; render(); }));
  qAll('[data-ot]').forEach(b => b.addEventListener('click', () => { state.orderType = b.dataset.ot; render(); }));

  q('#symIn')?.addEventListener('change', e => {
    state.symbol = e.target.value.trim();
    chrome.storage.local.set({ lastSymbol: state.symbol });
  });
  q('#amtIn')?.addEventListener('input', e => { state.amount = e.target.value; });
  q('#pxIn')?.addEventListener('input',  e => { state.price  = e.target.value; });
  q('#spIn')?.addEventListener('input',  e => { state.stopPrice = e.target.value; });

  q('#submitBtn')?.addEventListener('click', submitOrder);

  qAll('[data-otab]').forEach(b => b.addEventListener('click', () => {
    state.ordersTab = b.dataset.otab;
    loadOrders(); render();
  }));
  q('#refreshBtn')?.addEventListener('click', loadOrders);

  qAll('.cancel-btn').forEach(b => b.addEventListener('click', () => {
    doCancelOrder(b.dataset.oid, b.dataset.sym, b.dataset.isAlgo === '1');
  }));
}

// ─── API 调用 ─────────────────────────────────────────────────────────────────
async function getCredentials() {
  const key = `credentials_${state.exchange}`;
  const s = await chrome.storage.local.get(key);
  return s[key] || null;
}

function sendMsg(action, params) {
  return new Promise(async (resolve, reject) => {
    const creds = await getCredentials();
    if (!creds) return reject(new Error(`请先在设置页面配置 ${EX_LABEL[state.exchange]} 的 API Key`));
    chrome.runtime.sendMessage(
      { action, exchange: state.exchange, credentials: creds, params },
      res => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        res.ok ? resolve(res.data) : reject(new Error(res.error));
      }
    );
  });
}

async function submitOrder() {
  if (!state.amount)    return toast('请输入数量', 'error');
  if (state.orderType !== 'market' && !state.price) return toast('请输入价格', 'error');
  if (state.orderType === 'stop' && !state.stopPrice) return toast('请输入触发价格', 'error');

  state.loading = true; render();
  try {
    await sendMsg('placeOrder', {
      symbol: state.symbol, side: state.side,
      orderType: state.orderType, amount: state.amount,
      price: state.price, stopPrice: state.stopPrice,
      marketType: state.marketType,
    });
    state.loading = false;
    state.amount = '';
    toast('下单成功!', 'success');
  } catch (e) {
    state.loading = false;
    toast(e.message, 'error');
  }
  render();
}

async function loadOrders() {
  state.loading = true; render();
  try {
    const action = state.ordersTab === 'open' ? 'getOpenOrders' : 'getOrderHistory';
    const data = await sendMsg(action, { symbol: state.symbol, marketType: state.marketType });
    state.orders = Array.isArray(data) ? data : (data?.list || data?.orders || []);
  } catch (e) {
    state.orders = [];
    toast(e.message, 'error');
  }
  state.loading = false; render();
}

async function doCancelOrder(orderId, symbol, isAlgo) {
  try {
    await sendMsg('cancelOrder', { symbol: symbol || state.symbol, orderId, isAlgo, marketType: state.marketType });
    toast('撤单成功', 'success');
    loadOrders();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function silentLoadBalance() {
  try {
    const data = await sendMsg('getBalance', { marketType: state.marketType });
    state.balance = Array.isArray(data) ? data : (data ? [data] : null);
    render();
  } catch (_) { state.balance = null; }
}

// ─── 辅助函数 ─────────────────────────────────────────────────────────────────
function baseCcy() {
  if (state.symbol.includes('/')) return state.symbol.split('/')[0].toUpperCase();
  for (const q of ['USDT','BUSD','USDC']) if (state.symbol.toUpperCase().endsWith(q)) return state.symbol.toUpperCase().slice(0,-q.length);
  return state.symbol.toUpperCase();
}
function quoteCcy() {
  if (state.symbol.includes('/')) return state.symbol.split('/')[1].toUpperCase();
  for (const q of ['USDT','BUSD','USDC']) if (state.symbol.toUpperCase().endsWith(q)) return q;
  return 'USDT';
}
function estimateTotal() {
  const amt = parseFloat(state.amount) || 0;
  const px  = parseFloat(state.price)  || 0;
  if (state.orderType === 'market') return '市价';
  if (!amt || !px) return `0.00 ${quoteCcy()}`;
  return `≈ ${(amt * px).toFixed(2)} ${quoteCcy()}`;
}
function getAvail(currency) {
  if (!state.balance) return '0';
  const list = Array.isArray(state.balance) ? state.balance : [];
  for (const b of list) {
    const ccy = b.asset || b.ccy || b.currency || b.coin || b.coinName || '';
    if (ccy.toUpperCase() === currency.toUpperCase()) {
      const v = parseFloat(b.free || b.available || b.cashBal || b.availableToWithdraw || b.walletBalance || 0);
      return v.toFixed(4);
    }
  }
  return '0';
}
function submitLabel() {
  const action = state.side === 'buy' ? '买入' : '卖出';
  const type   = TYPE_ZH[state.orderType] || state.orderType;
  return `${type}${action} ${baseCcy()}`;
}
function toast(msg, type = 'info') {
  state.toast = { msg, type };
  render();
  setTimeout(() => { state.toast = null; render(); }, 3000);
}
const q    = s => document.querySelector(s);
const qAll = s => document.querySelectorAll(s);

document.addEventListener('DOMContentLoaded', init);
