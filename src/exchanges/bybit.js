import { hmacSha256, formatSymbol, displaySymbol } from './utils.js';

const BASE_URL = 'https://api.bybit.com';
const RECV_WINDOW = '5000';

async function safeJson(resp) {
  const text = await resp.text();
  try { return JSON.parse(text); }
  catch { throw new Error(`Bybit HTTP ${resp.status}: ${text.slice(0, 120)}`); }
}

async function request(method, path, credentials, params = {}) {
  const timestamp = Date.now().toString();
  let url, bodyStr = '', preSign;

  if (method === 'GET') {
    // Bybit V5 签名：timestamp + apiKey + recvWindow + queryString（不含 ?）
    const qStr = Object.keys(params).length ? new URLSearchParams(params).toString() : '';
    url = `${BASE_URL}${path}${qStr ? '?' + qStr : ''}`;
    preSign = timestamp + credentials.apiKey + RECV_WINDOW + qStr;
  } else {
    url = `${BASE_URL}${path}`;
    bodyStr = JSON.stringify(params);
    preSign = timestamp + credentials.apiKey + RECV_WINDOW + bodyStr;
  }

  const signature = await hmacSha256(credentials.secret, preSign);
  const resp = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-BAPI-API-KEY': credentials.apiKey,
      'X-BAPI-SIGN': signature,
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-RECV-WINDOW': RECV_WINDOW,
    },
    ...(bodyStr ? { body: bodyStr } : {}),
  });

  const data = await safeJson(resp);
  if (data.retCode !== 0) {
    throw new Error(data.retMsg || `Bybit error: ${data.retCode}`);
  }
  return data.result;
}

export async function placeOrder(credentials, { symbol, side, orderType, amount, price, stopPrice, marketType = 'spot' }) {
  const category = marketType === 'perp' ? 'linear' : 'spot';
  const sym = formatSymbol(symbol, 'bybit', marketType);

  const qty = toFixed(amount);
  if (!qty || parseFloat(qty) <= 0) throw new Error('数量必须大于 0');

  if (orderType === 'limit' && (!price || parseFloat(price) <= 0)) {
    throw new Error('限价单必须填写价格');
  }
  if (orderType === 'stop' && (!stopPrice || parseFloat(stopPrice) <= 0)) {
    throw new Error('止损单必须填写触发价格');
  }

  const params = {
    category,
    symbol: sym,
    side: cap(side),        // Buy / Sell
    orderType: orderType === 'market' ? 'Market' : 'Limit',
    qty,
  };

  if (orderType === 'limit') {
    params.price = toFixed(price);
  } else if (orderType === 'stop') {
    params.price = toFixed(price || stopPrice);
    params.triggerPrice = toFixed(stopPrice);
    // triggerDirection: 1 = 价格上涨到达触发价（买入止损）; 2 = 下跌（卖出止损）
    params.triggerDirection = side === 'buy' ? 1 : 2;
    params.orderFilter = 'StopOrder';
    params.triggerBy = 'LastPrice';
  }

  return request('POST', '/v5/order/create', credentials, params);
}

export async function cancelOrder(credentials, { symbol, orderId, marketType = 'spot' }) {
  if (!orderId) throw new Error('撤单需要 orderId');
  return request('POST', '/v5/order/cancel', credentials, {
    category: marketType === 'perp' ? 'linear' : 'spot',
    symbol: formatSymbol(symbol, 'bybit', marketType),
    orderId,
  });
}

export async function getOpenOrders(credentials, { symbol, marketType = 'spot' } = {}) {
  const category = marketType === 'perp' ? 'linear' : 'spot';
  const params = { category };
  if (symbol) params.symbol = formatSymbol(symbol, 'bybit', marketType);
  const result = await request('GET', '/v5/order/realtime', credentials, params);
  return (result?.list || []).map(o => ({
    id: o.orderId,
    symbol: displaySymbol(o.symbol),
    side: (o.side || '').toLowerCase(),
    type: (o.orderType || '').toLowerCase(),
    amount: o.qty,
    price: o.price,
    stopPrice: o.triggerPrice || '',
    status: (o.orderStatus || '').toLowerCase(),
    time: o.createdTime,
    isAlgo: false,
    raw: o,
  }));
}

export async function getOrderHistory(credentials, { symbol, marketType = 'spot', limit = 50 } = {}) {
  const category = marketType === 'perp' ? 'linear' : 'spot';
  const params = { category, limit: String(limit) };
  if (symbol) params.symbol = formatSymbol(symbol, 'bybit', marketType);
  const result = await request('GET', '/v5/order/history', credentials, params);
  return (result?.list || []).map(o => ({
    id: o.orderId,
    symbol: displaySymbol(o.symbol),
    side: (o.side || '').toLowerCase(),
    type: (o.orderType || '').toLowerCase(),
    amount: o.qty,
    price: o.avgPrice && o.avgPrice !== '0' ? o.avgPrice : o.price,
    stopPrice: o.triggerPrice || '',
    status: (o.orderStatus || '').toLowerCase(),
    time: o.createdTime,
    isAlgo: false,
    raw: o,
  }));
}

export async function getBalance(credentials, { marketType = 'spot' } = {}) {
  // 大多数 Bybit 新用户是 UNIFIED 账户（统一交易账户），同时包含现货和合约余额
  // 旧版 Classic 账户：现货用 SPOT，合约用 CONTRACT
  // 优先尝试 UNIFIED，失败时不抛错而返回空
  let result = await request('GET', '/v5/account/wallet-balance', credentials, { accountType: 'UNIFIED' })
    .catch(() => null);

  if (!result?.list?.[0]?.coin?.length) {
    // 回退到 Classic 账户类型
    const fallback = marketType === 'perp' ? 'CONTRACT' : 'SPOT';
    result = await request('GET', '/v5/account/wallet-balance', credentials, { accountType: fallback })
      .catch(() => null);
  }

  return (result?.list?.[0]?.coin || []).filter(c => parseFloat(c.walletBalance) > 0);
}

// ─── 工具 ─────────────────────────────────────────────────────────────────────
function toFixed(val) {
  const n = Number(val);
  if (isNaN(n)) return '';
  return n.toLocaleString('fullwide', { useGrouping: false, maximumFractionDigits: 20 });
}

function cap(s) {
  if (!s) throw new Error('交易方向不能为空');
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}
