import { hmacSha256, formatSymbol, displaySymbol } from './utils.js';

const BASE_URL = 'https://www.okx.com';

async function safeJson(resp) {
  const text = await resp.text();
  try { return JSON.parse(text); }
  catch { throw new Error(`OKX HTTP ${resp.status}: ${text.slice(0, 120)}`); }
}

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

  const data = await safeJson(resp);
  if (data.code !== '0') {
    throw new Error(data.msg || `OKX error: ${data.code}`);
  }
  return data.data;
}

// ─── 下单 ─────────────────────────────────────────────────────────────────────
// OKX 区分两类订单：
//   普通单 → POST /api/v5/trade/order          (market / limit)
//   算法单 → POST /api/v5/trade/order-algo     (conditional / trigger 等)
// 止损单必须走算法单接口，普通接口不支持 conditional 类型

export async function placeOrder(credentials, { symbol, side, orderType, amount, price, stopPrice, marketType = 'spot' }) {
  const instId = formatSymbol(symbol, 'okx', marketType);
  const qty    = toFixed(amount);
  if (!qty || parseFloat(qty) <= 0) throw new Error('数量必须大于 0');

  // ── 止损单：走 order-algo 接口 ──────────────────────────────────────────
  if (orderType === 'stop') {
    if (!stopPrice || parseFloat(stopPrice) <= 0) throw new Error('止损单必须填写触发价格');
    const algoBody = {
      instId,
      tdMode: marketType === 'perp' ? 'cross' : 'cash',
      side: side.toLowerCase(),
      ordType: 'conditional',
      sz: qty,
      // slOrdPx: '-1' 代表触发后以市价成交；有委托价时用限价
      slTriggerPx: toFixed(stopPrice),
      slOrdPx: (price && parseFloat(price) > 0) ? toFixed(price) : '-1',
      slTriggerPxType: 'last',
    };
    const result = await request('POST', '/api/v5/trade/order-algo', credentials, algoBody);
    // 返回 algoId，统一标记 isAlgo: true 供撤单识别
    return { ...result?.[0], isAlgo: true };
  }

  // ── 普通单：market / limit ──────────────────────────────────────────────
  if (orderType === 'limit' && (!price || parseFloat(price) <= 0)) {
    throw new Error('限价单必须填写价格');
  }
  const body = {
    instId,
    tdMode: marketType === 'perp' ? 'cross' : 'cash',
    side: side.toLowerCase(),
    ordType: orderType === 'market' ? 'market' : 'limit',
    sz: qty,
    ...(orderType === 'limit' ? { px: toFixed(price) } : {}),
  };
  const result = await request('POST', '/api/v5/trade/order', credentials, body);
  return { ...result?.[0], isAlgo: false };
}

// ─── 撤单 ─────────────────────────────────────────────────────────────────────
// 普通单用 /cancel-order，算法单用 /cancel-algos（参数格式也不同）
export async function cancelOrder(credentials, { symbol, orderId, isAlgo = false, marketType = 'spot' }) {
  const instId = formatSymbol(symbol, 'okx', marketType);
  if (!orderId) throw new Error('撤单需要 orderId');

  if (isAlgo) {
    // 算法单撤单：body 为数组
    const result = await request('POST', '/api/v5/trade/cancel-algos', credentials, [{ instId, algoId: String(orderId) }]);
    return result?.[0];
  }
  const result = await request('POST', '/api/v5/trade/cancel-order', credentials, { instId, ordId: String(orderId) });
  return result?.[0];
}

// ─── 挂单查询 ─────────────────────────────────────────────────────────────────
// 需要同时查询普通挂单 + 算法挂单（止损单在算法挂单列表中）
export async function getOpenOrders(credentials, { symbol, marketType = 'spot' } = {}) {
  const instType = marketType === 'perp' ? 'SWAP' : 'SPOT';
  const qp = { instType };
  if (symbol) qp.instId = formatSymbol(symbol, 'okx', marketType);

  // 并发查询普通单和算法单
  const [regular, algo] = await Promise.all([
    request('GET', '/api/v5/trade/orders-pending', credentials, null, qp).catch(() => []),
    request('GET', '/api/v5/trade/orders-algo-pending', credentials, null, { ...qp, ordType: 'conditional' }).catch(() => []),
  ]);

  const norm = (orders, isAlgo) => (orders || []).map(o => ({
    id: isAlgo ? o.algoId : o.ordId,
    symbol: displaySymbol(o.instId),
    side: o.side,
    type: isAlgo ? 'stop' : o.ordType,
    amount: o.sz,
    price: isAlgo ? (o.slOrdPx !== '-1' ? o.slOrdPx : '') : (o.px && o.px !== '0' ? o.px : ''),
    stopPrice: isAlgo ? o.slTriggerPx : '',
    status: isAlgo ? 'live' : o.state,
    time: o.cTime,
    isAlgo,
    raw: o,
  }));

  return [...norm(regular, false), ...norm(algo, true)];
}

// ─── 历史订单 ─────────────────────────────────────────────────────────────────
export async function getOrderHistory(credentials, { symbol, marketType = 'spot', limit = 50 } = {}) {
  const instType = marketType === 'perp' ? 'SWAP' : 'SPOT';
  const qp = { instType, limit: String(limit) };
  if (symbol) qp.instId = formatSymbol(symbol, 'okx', marketType);

  const [regular, algo] = await Promise.all([
    request('GET', '/api/v5/trade/orders-history', credentials, null, qp).catch(() => []),
    request('GET', '/api/v5/trade/orders-algo-history', credentials, null, { ...qp, ordType: 'conditional' }).catch(() => []),
  ]);

  const normR = (regular || []).map(o => ({
    id: o.ordId,
    symbol: displaySymbol(o.instId),
    side: o.side,
    type: o.ordType,
    amount: o.sz,
    price: o.avgPx && o.avgPx !== '0' ? o.avgPx : (o.px || ''),
    status: o.state,
    time: o.cTime,
    isAlgo: false,
    raw: o,
  }));
  const normA = (algo || []).map(o => ({
    id: o.algoId,
    symbol: displaySymbol(o.instId),
    side: o.side,
    type: 'stop',
    amount: o.sz,
    price: o.slOrdPx !== '-1' ? o.slOrdPx : '',
    stopPrice: o.slTriggerPx,
    status: o.state,
    time: o.cTime,
    isAlgo: true,
    raw: o,
  }));
  return [...normR, ...normA];
}

export async function getBalance(credentials) {
  const data = await request('GET', '/api/v5/account/balance', credentials);
  return (data?.[0]?.details || []).filter(b => parseFloat(b.cashBal) > 0);
}

// ─── 工具 ─────────────────────────────────────────────────────────────────────
function toFixed(val) {
  const n = Number(val);
  if (isNaN(n)) return '';
  return n.toLocaleString('fullwide', { useGrouping: false, maximumFractionDigits: 20 });
}
