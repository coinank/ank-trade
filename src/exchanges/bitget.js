import { hmacSha256, formatSymbol, displaySymbol } from './utils.js';

const BASE_URL = 'https://api.bitget.com';

// Bitget V2: sign = HMAC_SHA256(timestamp + method + path + queryString + body)
// 编码格式: Base64
async function request(method, path, credentials, body = null, queryParams = {}) {
  const timestamp = Date.now().toString();
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
      'ACCESS-KEY': credentials.apiKey,
      'ACCESS-SIGN': signature,
      'ACCESS-TIMESTAMP': timestamp,
      'ACCESS-PASSPHRASE': credentials.passphrase || '',
      'locale': 'zh-CN',
    },
    ...(bodyStr ? { body: bodyStr } : {}),
  });

  const data = await resp.json();
  if (data.code !== '00000') {
    throw new Error(data.msg || `Bitget error: ${data.code}`);
  }
  return data.data;
}

export async function placeOrder(credentials, { symbol, side, orderType, amount, price, stopPrice, marketType = 'spot' }) {
  const sym = formatSymbol(symbol, 'bitget', marketType);

  // 止损单走计划委托接口
  if (orderType === 'stop') {
    const body = {
      symbol: sym,
      side: side.toLowerCase(),
      orderType: 'limit',
      triggerPrice: String(stopPrice),
      executePrice: String(price || stopPrice),
      size: String(amount),
      triggerType: 'market_price',
    };
    return request('POST', '/api/v2/spot/trade/place-plan-order', credentials, body);
  }

  const body = {
    symbol: sym,
    side: side.toLowerCase(),
    orderType: orderType === 'market' ? 'market' : 'limit',
    force: 'gtc',
    size: String(amount),
    ...(orderType === 'limit' ? { price: String(price) } : {}),
  };
  return request('POST', '/api/v2/spot/trade/place-order', credentials, body);
}

export async function cancelOrder(credentials, { symbol, orderId, marketType = 'spot' }) {
  return request('POST', '/api/v2/spot/trade/cancel-order', credentials, {
    symbol: formatSymbol(symbol, 'bitget', marketType),
    orderId,
  });
}

export async function getOpenOrders(credentials, { symbol, marketType = 'spot' } = {}) {
  const params = {};
  if (symbol) params.symbol = formatSymbol(symbol, 'bitget', marketType);
  const orders = await request('GET', '/api/v2/spot/trade/unfilled-orders', credentials, null, params);
  return (Array.isArray(orders) ? orders : []).map(o => ({
    id: o.orderId,
    symbol: displaySymbol(o.symbol),
    side: o.side,
    type: o.orderType,
    amount: o.size,
    price: o.price,
    status: o.status,
    time: o.cTime,
    raw: o,
  }));
}

export async function getOrderHistory(credentials, { symbol, marketType = 'spot', limit = 50 } = {}) {
  const params = { limit: String(limit) };
  if (symbol) params.symbol = formatSymbol(symbol, 'bitget', marketType);
  const orders = await request('GET', '/api/v2/spot/trade/history-orders', credentials, null, params);
  return (Array.isArray(orders) ? orders : []).map(o => ({
    id: o.orderId,
    symbol: displaySymbol(o.symbol),
    side: o.side,
    type: o.orderType,
    amount: o.size,
    price: o.price,
    status: o.status,
    time: o.cTime,
    raw: o,
  }));
}

export async function getBalance(credentials) {
  const data = await request('GET', '/api/v2/spot/account/assets', credentials);
  return (Array.isArray(data) ? data : []).filter(b => parseFloat(b.available) > 0 || parseFloat(b.frozen) > 0);
}
