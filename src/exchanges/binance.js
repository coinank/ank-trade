import { hmacSha256, formatSymbol, displaySymbol } from './utils.js';

const SPOT_BASE = 'https://api.binance.com';
const PERP_BASE = 'https://fapi.binance.com';

function baseUrl(marketType) {
  return marketType === 'perp' ? PERP_BASE : SPOT_BASE;
}

/** 安全解析 JSON，避免非 JSON 响应（如 HTML 502）引发 crash */
async function safeJson(resp) {
  const text = await resp.text();
  try { return JSON.parse(text); }
  catch { throw new Error(`Binance HTTP ${resp.status}: ${text.slice(0, 120)}`); }
}

async function request(method, path, credentials, params = {}, marketType = 'spot') {
  const timestamp = Date.now();
  const allParams = { ...params, timestamp, recvWindow: 5000 };
  const queryStr = new URLSearchParams(
    Object.entries(allParams).map(([k, v]) => [k, String(v)])
  ).toString();
  const signature = await hmacSha256(credentials.secret, queryStr);

  let url, body;
  if (method === 'GET' || method === 'DELETE') {
    url = `${baseUrl(marketType)}${path}?${queryStr}&signature=${signature}`;
  } else {
    url = `${baseUrl(marketType)}${path}`;
    body = `${queryStr}&signature=${signature}`;
  }

  const resp = await fetch(url, {
    method,
    headers: {
      'X-MBX-APIKEY': credentials.apiKey,
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(body ? { body } : {}),
  });

  const data = await safeJson(resp);
  // Binance 错误：HTTP 非 2xx，或 code 为负数
  if (!resp.ok || (typeof data.code === 'number' && data.code < 0)) {
    throw new Error(data.msg || `Binance error ${resp.status}`);
  }
  return data;
}

export async function placeOrder(credentials, { symbol, side, orderType, amount, price, stopPrice, marketType = 'spot' }) {
  const sym = formatSymbol(symbol, 'binance', marketType);

  // 数量精度：去除科学计数法
  const qty = toFixed(amount);
  if (!qty || parseFloat(qty) <= 0) throw new Error('数量必须大于 0');

  const params = {
    symbol: sym,
    side: side.toUpperCase(),  // BUY / SELL
    type: getBinanceOrderType(orderType, marketType),
    quantity: qty,
  };

  if (orderType === 'limit') {
    if (!price || parseFloat(price) <= 0) throw new Error('限价单必须填写价格');
    params.price = toFixed(price);
    params.timeInForce = 'GTC';
  } else if (orderType === 'stop') {
    if (!stopPrice || parseFloat(stopPrice) <= 0) throw new Error('止损单必须填写触发价格');
    params.stopPrice = toFixed(stopPrice);
    // 合约 STOP 类型：有 price 时为限价止损，无 price 时改用 STOP_MARKET
    if (marketType === 'perp') {
      if (price && parseFloat(price) > 0) {
        params.type = 'STOP';
        params.price = toFixed(price);
        params.timeInForce = 'GTC';
      } else {
        params.type = 'STOP_MARKET';
      }
    } else {
      // 现货 STOP_LOSS_LIMIT 必须有委托价
      params.price = toFixed(price || stopPrice);
      params.timeInForce = 'GTC';
    }
  }

  const path = marketType === 'perp' ? '/fapi/v1/order' : '/api/v3/order';
  return request('POST', path, credentials, params, marketType);
}

export async function cancelOrder(credentials, { symbol, orderId, marketType = 'spot' }) {
  const sym = formatSymbol(symbol, 'binance', marketType);
  if (!orderId) throw new Error('撤单需要 orderId');
  const path = marketType === 'perp' ? '/fapi/v1/order' : '/api/v3/order';
  return request('DELETE', path, credentials, { symbol: sym, orderId }, marketType);
}

export async function getOpenOrders(credentials, { symbol, marketType = 'spot' } = {}) {
  const params = {};
  if (symbol) params.symbol = formatSymbol(symbol, 'binance', marketType);
  const path = marketType === 'perp' ? '/fapi/v1/openOrders' : '/api/v3/openOrders';
  const orders = await request('GET', path, credentials, params, marketType);
  return (Array.isArray(orders) ? orders : []).map(o => ({
    id: String(o.orderId),
    symbol: displaySymbol(o.symbol),
    side: (o.side || '').toLowerCase(),
    type: (o.type || '').toLowerCase(),
    amount: o.origQty,
    price: o.price && o.price !== '0.00000000' ? o.price : '',
    status: (o.status || '').toLowerCase(),
    time: o.time,
    isAlgo: false,
    raw: o,
  }));
}

export async function getOrderHistory(credentials, { symbol, marketType = 'spot', limit = 50 } = {}) {
  if (!symbol) throw new Error('查询历史订单需要指定交易对');
  const sym = formatSymbol(symbol, 'binance', marketType);
  const path = marketType === 'perp' ? '/fapi/v1/allOrders' : '/api/v3/allOrders';
  const orders = await request('GET', path, credentials, { symbol: sym, limit }, marketType);
  return (Array.isArray(orders) ? orders : []).map(o => ({
    id: String(o.orderId),
    symbol: displaySymbol(o.symbol),
    side: (o.side || '').toLowerCase(),
    type: (o.type || '').toLowerCase(),
    amount: o.origQty,
    price: o.price && o.price !== '0.00000000' ? o.price : '',
    status: (o.status || '').toLowerCase(),
    time: o.time,
    isAlgo: false,
    raw: o,
  }));
}

export async function getBalance(credentials, { marketType = 'spot' } = {}) {
  if (marketType === 'perp') {
    const data = await request('GET', '/fapi/v2/balance', credentials, {}, 'perp');
    return (Array.isArray(data) ? data : [])
      .filter(b => parseFloat(b.balance) > 0)
      .map(b => ({ asset: b.asset, free: b.availableBalance, locked: '0' }));
  }
  const data = await request('GET', '/api/v3/account', credentials, {}, 'spot');
  return (data.balances || []).filter(b => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0);
}

// ─── 工具 ────────────────────────────────────────────────────────────────────

/**
 * 将数字转为固定小数字符串，去除科学计数法
 * e.g. 1e-5 → "0.00001", 1.10 → "1.1"
 */
function toFixed(val) {
  const n = Number(val);
  if (isNaN(n)) return '';
  // 避免科学计数法
  return n.toLocaleString('fullwide', { useGrouping: false, maximumFractionDigits: 20 });
}

function getBinanceOrderType(orderType, marketType) {
  if (orderType === 'market') return 'MARKET';
  if (orderType === 'limit')  return 'LIMIT';
  if (orderType === 'stop') {
    // 合约止损：STOP（限价） 或 STOP_MARKET（市价），在 placeOrder 中动态决定
    return marketType === 'perp' ? 'STOP' : 'STOP_LOSS_LIMIT';
  }
  return orderType.toUpperCase();
}
