import { hmacSha256, formatSymbol, displaySymbol } from './utils.js';

const BASE_URL = 'https://www.okx.com';

async function request(method, path, credentials, body = null, queryParams = {}) {
  const timestamp = new Date().toISOString();
  const qStr = Object.keys(queryParams).length
    ? '?' + new URLSearchParams(queryParams).toString()
    : '';
  const bodyStr = body ? JSON.stringify(body) : '';
  const preSign = timestamp + method.toUpperCase() + path + qStr + bodyStr;
  const signature = await hmacSha256(credentials.secret, preSign, 'base64');

  const resp = await fetch(`${BASE_URL}${path}${qStr}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'OK-ACCESS-KEY': credentials.apiKey,
      'OK-ACCESS-SIGN': signature,
      'OK-ACCESS-TIMESTAMP': timestamp,
      'OK-ACCESS-PASSPHRASE': credentials.passphrase || '',
    },
    ...(bodyStr ? { body: bodyStr } : {}),
  });

  const data = await resp.json();
  if (data.code !== '0') {
    throw new Error(data.msg || `OKX error: ${data.code}`);
  }
  return data.data;
}

export async function placeOrder(credentials, { symbol, side, orderType, amount, price, stopPrice, marketType = 'spot' }) {
  const instId = formatSymbol(symbol, 'okx', marketType);
  const body = {
    instId,
    tdMode: marketType === 'perp' ? 'cross' : 'cash',
    side: side.toLowerCase(),
    sz: String(amount),
    ...(orderType === 'stop' ? {
      ordType: 'conditional',
      slTriggerPx: String(stopPrice),
      slOrdPx: String(price || stopPrice),
      slTriggerPxType: 'last',
    } : {
      ordType: orderType === 'market' ? 'market' : 'limit',
      ...(orderType === 'limit' ? { px: String(price) } : {}),
    }),
  };
  return request('POST', '/api/v5/trade/order', credentials, body);
}

export async function cancelOrder(credentials, { symbol, orderId, marketType = 'spot' }) {
  const instId = formatSymbol(symbol, 'okx', marketType);
  return request('POST', '/api/v5/trade/cancel-order', credentials, { instId, ordId: orderId });
}

export async function getOpenOrders(credentials, { symbol, marketType = 'spot' } = {}) {
  const params = { instType: marketType === 'perp' ? 'SWAP' : 'SPOT' };
  if (symbol) params.instId = formatSymbol(symbol, 'okx', marketType);
  const orders = await request('GET', '/api/v5/trade/orders-pending', credentials, null, params);
  return (orders || []).map(o => ({
    id: o.ordId,
    symbol: displaySymbol(o.instId),
    side: o.side,
    type: o.ordType,
    amount: o.sz,
    price: o.px && o.px !== '0' ? o.px : '',
    status: o.state,
    time: o.cTime,
    raw: o,
  }));
}

export async function getOrderHistory(credentials, { symbol, marketType = 'spot', limit = 50 } = {}) {
  const params = { instType: marketType === 'perp' ? 'SWAP' : 'SPOT', limit: String(limit) };
  if (symbol) params.instId = formatSymbol(symbol, 'okx', marketType);
  const orders = await request('GET', '/api/v5/trade/orders-history', credentials, null, params);
  return (orders || []).map(o => ({
    id: o.ordId,
    symbol: displaySymbol(o.instId),
    side: o.side,
    type: o.ordType,
    amount: o.sz,
    price: o.px && o.px !== '0' ? o.px : '',
    status: o.state,
    time: o.cTime,
    raw: o,
  }));
}

export async function getBalance(credentials) {
  const data = await request('GET', '/api/v5/account/balance', credentials);
  return (data?.[0]?.details || []).filter(b => parseFloat(b.cashBal) > 0);
}
