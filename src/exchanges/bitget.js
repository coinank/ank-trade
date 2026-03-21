import { hmacSha256, formatSymbol, displaySymbol } from './utils.js';

const BASE_URL = 'https://api.bitget.com';

async function safeJson(resp) {
  const text = await resp.text();
  try { return JSON.parse(text); }
  catch { throw new Error(`Bitget HTTP ${resp.status}: ${text.slice(0, 120)}`); }
}

// Bitget V2: sign = HMAC_SHA256(timestamp + method + path + queryString + body)，Base64 编码
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

  const data = await safeJson(resp);
  if (data.code !== '00000') {
    throw new Error(data.msg || `Bitget error: ${data.code}`);
  }
  return data.data;
}

export async function placeOrder(credentials, { symbol, side, orderType, amount, price, stopPrice, marketType = 'spot' }) {
  const sym = formatSymbol(symbol, 'bitget', marketType);

  const qty = toFixed(amount);
  if (!qty || parseFloat(qty) <= 0) throw new Error('数量必须大于 0');

  // ── 止损单（计划委托） ──────────────────────────────────────────────────────
  if (orderType === 'stop') {
    if (!stopPrice || parseFloat(stopPrice) <= 0) throw new Error('止损单必须填写触发价格');

    if (marketType === 'perp') {
      // 合约计划委托
      const body = {
        symbol: sym,
        productType: 'usdt-futures',
        marginMode: 'crossed',
        marginCoin: 'USDT',
        side: side === 'buy' ? 'open_long' : 'open_short',
        orderType: (price && parseFloat(price) > 0) ? 'limit' : 'market',
        triggerPrice: toFixed(stopPrice),
        triggerType: 'mark_price',
        size: qty,
        ...(price && parseFloat(price) > 0 ? { executePrice: toFixed(price) } : {}),
      };
      return request('POST', '/api/v2/mix/order/place-plan-order', credentials, body);
    }

    // 现货计划委托
    const body = {
      symbol: sym,
      side: side.toLowerCase(),
      orderType: (price && parseFloat(price) > 0) ? 'limit' : 'market',
      triggerPrice: toFixed(stopPrice),
      triggerType: 'market_price',
      size: qty,
      ...(price && parseFloat(price) > 0 ? { executePrice: toFixed(price) } : {}),
    };
    return request('POST', '/api/v2/spot/trade/place-plan-order', credentials, body);
  }

  // ── 普通单 ─────────────────────────────────────────────────────────────────
  if (orderType === 'limit' && (!price || parseFloat(price) <= 0)) {
    throw new Error('限价单必须填写价格');
  }

  if (marketType === 'perp') {
    // 合约普通单
    const body = {
      symbol: sym,
      productType: 'usdt-futures',
      marginMode: 'crossed',
      marginCoin: 'USDT',
      side: side === 'buy' ? 'open_long' : 'open_short',
      orderType: orderType === 'market' ? 'market' : 'limit',
      size: qty,
      ...(orderType === 'limit' ? { price: toFixed(price) } : {}),
    };
    return request('POST', '/api/v2/mix/order/place-order', credentials, body);
  }

  // 现货普通单
  const body = {
    symbol: sym,
    side: side.toLowerCase(),
    orderType: orderType === 'market' ? 'market' : 'limit',
    force: 'gtc',
    size: qty,
    ...(orderType === 'limit' ? { price: toFixed(price) } : {}),
  };
  return request('POST', '/api/v2/spot/trade/place-order', credentials, body);
}

export async function cancelOrder(credentials, { symbol, orderId, isAlgo = false, marketType = 'spot' }) {
  if (!orderId) throw new Error('撤单需要 orderId');
  const sym = formatSymbol(symbol, 'bitget', marketType);

  if (marketType === 'perp') {
    if (isAlgo) {
      return request('POST', '/api/v2/mix/order/cancel-plan-order', credentials, {
        symbol: sym, productType: 'usdt-futures', orderId,
      });
    }
    return request('POST', '/api/v2/mix/order/cancel-order', credentials, {
      symbol: sym, productType: 'usdt-futures', orderId,
    });
  }

  // 现货
  if (isAlgo) {
    return request('POST', '/api/v2/spot/trade/cancel-plan-order', credentials, { symbol: sym, orderId });
  }
  return request('POST', '/api/v2/spot/trade/cancel-order', credentials, { symbol: sym, orderId });
}

export async function getOpenOrders(credentials, { symbol, marketType = 'spot' } = {}) {
  let orders;
  if (marketType === 'perp') {
    const params = { productType: 'usdt-futures' };
    if (symbol) params.symbol = formatSymbol(symbol, 'bitget', marketType);
    orders = await request('GET', '/api/v2/mix/order/orders-pending', credentials, null, params);
  } else {
    const params = {};
    if (symbol) params.symbol = formatSymbol(symbol, 'bitget', marketType);
    orders = await request('GET', '/api/v2/spot/trade/unfilled-orders', credentials, null, params);
  }
  return (Array.isArray(orders) ? orders : []).map(o => ({
    id: o.orderId,
    symbol: displaySymbol(o.symbol),
    side: o.side,
    type: o.orderType,
    amount: o.size || o.baseSize,
    price: o.price,
    status: o.status,
    time: o.cTime,
    isAlgo: false,
    raw: o,
  }));
}

export async function getOrderHistory(credentials, { symbol, marketType = 'spot', limit = 50 } = {}) {
  let orders;
  if (marketType === 'perp') {
    const params = { productType: 'usdt-futures', limit: String(limit) };
    if (symbol) params.symbol = formatSymbol(symbol, 'bitget', marketType);
    orders = await request('GET', '/api/v2/mix/order/history', credentials, null, params);
  } else {
    const params = { limit: String(limit) };
    if (symbol) params.symbol = formatSymbol(symbol, 'bitget', marketType);
    orders = await request('GET', '/api/v2/spot/trade/history-orders', credentials, null, params);
  }
  return (Array.isArray(orders) ? orders : []).map(o => ({
    id: o.orderId,
    symbol: displaySymbol(o.symbol),
    side: o.side,
    type: o.orderType,
    amount: o.size || o.baseSize,
    price: o.priceAvg || o.price,
    status: o.status,
    time: o.cTime,
    isAlgo: false,
    raw: o,
  }));
}

export async function getBalance(credentials, { marketType = 'spot' } = {}) {
  if (marketType === 'perp') {
    const data = await request('GET', '/api/v2/mix/account/accounts', credentials, null, { productType: 'usdt-futures' });
    return (Array.isArray(data) ? data : []).filter(b => parseFloat(b.available) > 0);
  }
  const data = await request('GET', '/api/v2/spot/account/assets', credentials);
  return (Array.isArray(data) ? data : []).filter(b => parseFloat(b.available) > 0 || parseFloat(b.frozen) > 0);
}

// ─── 工具 ─────────────────────────────────────────────────────────────────────
function toFixed(val) {
  const n = Number(val);
  if (isNaN(n)) return '';
  return n.toLocaleString('fullwide', { useGrouping: false, maximumFractionDigits: 20 });
}
