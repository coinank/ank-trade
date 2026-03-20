import { hmacSha256, formatSymbol, displaySymbol } from './utils.js';

const BASE_URL = 'https://api.bybit.com';
const RECV_WINDOW = '5000';

async function request(method, path, credentials, params = {}) {
  const timestamp = Date.now().toString();
  let url, bodyStr = '', preSign;

  if (method === 'GET') {
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

  const data = await resp.json();
  if (data.retCode !== 0) {
    throw new Error(data.retMsg || `Bybit error: ${data.retCode}`);
  }
  return data.result;
}

export async function placeOrder(credentials, { symbol, side, orderType, amount, price, stopPrice, marketType = 'spot' }) {
  const category = marketType === 'perp' ? 'linear' : 'spot';
  const sym = formatSymbol(symbol, 'bybit', marketType);
  const params = {
    category,
    symbol: sym,
    side: cap(side),        // Buy / Sell
    orderType: orderType === 'market' ? 'Market' : 'Limit',
    qty: String(amount),
  };

  if (orderType === 'limit') {
    params.price = String(price);
  } else if (orderType === 'stop') {
    params.price = String(price || stopPrice);
    params.triggerPrice = String(stopPrice);
    params.triggerDirection = side === 'buy' ? 1 : 2;
    params.orderFilter = 'StopOrder';
  }

  return request('POST', '/v5/order/create', credentials, params);
}

export async function cancelOrder(credentials, { symbol, orderId, marketType = 'spot' }) {
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
    side: o.side.toLowerCase(),
    type: o.orderType.toLowerCase(),
    amount: o.qty,
    price: o.price,
    status: o.orderStatus.toLowerCase(),
    time: o.createdTime,
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
    side: o.side.toLowerCase(),
    type: o.orderType.toLowerCase(),
    amount: o.qty,
    price: o.price,
    status: o.orderStatus.toLowerCase(),
    time: o.createdTime,
    raw: o,
  }));
}

export async function getBalance(credentials, { marketType = 'spot' } = {}) {
  const accountType = marketType === 'perp' ? 'CONTRACT' : 'SPOT';
  const result = await request('GET', '/v5/account/wallet-balance', credentials, { accountType });
  return result?.list?.[0]?.coin || [];
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}
