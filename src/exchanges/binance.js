import { hmacSha256, formatSymbol, displaySymbol } from './utils.js';

const SPOT_BASE = 'https://api.binance.com';
const PERP_BASE = 'https://fapi.binance.com';

function baseUrl(marketType) {
  return marketType === 'perp' ? PERP_BASE : SPOT_BASE;
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

  const data = await resp.json();
  if (!resp.ok || (data.code && data.code < 0)) {
    throw new Error(data.msg || `Binance error ${resp.status}`);
  }
  return data;
}

export async function placeOrder(credentials, { symbol, side, orderType, amount, price, stopPrice, marketType = 'spot' }) {
  const sym = formatSymbol(symbol, 'binance', marketType);
  const params = {
    symbol: sym,
    side: side.toUpperCase(),        // BUY / SELL
    type: getBinanceOrderType(orderType),
    quantity: amount,
  };
  if (orderType === 'limit') {
    params.price = price;
    params.timeInForce = 'GTC';
  } else if (orderType === 'stop') {
    params.stopPrice = stopPrice;
    params.price = price || stopPrice;
    params.timeInForce = 'GTC';
  }
  const path = marketType === 'perp' ? '/fapi/v1/order' : '/api/v3/order';
  return request('POST', path, credentials, params, marketType);
}

export async function cancelOrder(credentials, { symbol, orderId, marketType = 'spot' }) {
  const sym = formatSymbol(symbol, 'binance', marketType);
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
    side: o.side.toLowerCase(),
    type: o.type.toLowerCase(),
    amount: o.origQty,
    price: o.price !== '0' ? o.price : '',
    status: o.status.toLowerCase(),
    time: o.time,
    raw: o,
  }));
}

export async function getOrderHistory(credentials, { symbol, marketType = 'spot', limit = 50 } = {}) {
  const sym = formatSymbol(symbol || 'BTC/USDT', 'binance', marketType);
  const path = marketType === 'perp' ? '/fapi/v1/allOrders' : '/api/v3/allOrders';
  const orders = await request('GET', path, credentials, { symbol: sym, limit }, marketType);
  return (Array.isArray(orders) ? orders : []).map(o => ({
    id: String(o.orderId),
    symbol: displaySymbol(o.symbol),
    side: o.side.toLowerCase(),
    type: o.type.toLowerCase(),
    amount: o.origQty,
    price: o.price !== '0' ? o.price : '',
    status: o.status.toLowerCase(),
    time: o.time,
    raw: o,
  }));
}

export async function getBalance(credentials, { marketType = 'spot' } = {}) {
  if (marketType === 'perp') {
    const data = await request('GET', '/fapi/v2/balance', credentials, {}, 'perp');
    return (Array.isArray(data) ? data : []).filter(b => parseFloat(b.balance) > 0);
  }
  const data = await request('GET', '/api/v3/account', credentials, {}, 'spot');
  return (data.balances || []).filter(b => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0);
}

function getBinanceOrderType(t) {
  switch (t) {
    case 'market': return 'MARKET';
    case 'limit': return 'LIMIT';
    case 'stop': return 'STOP_LOSS_LIMIT';
    default: return t.toUpperCase();
  }
}
