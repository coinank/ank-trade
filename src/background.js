/**
 * Coinank Trader - Background Service Worker
 * 使用 ccxt 统一接口处理所有交易所 API 请求
 * importScripts 加载 ccxt 浏览器包（设置 self.ccxt）
 */
'use strict';
importScripts('ccxt.browser.min.js');

const EX_LABEL = {
  binance: 'Binance', okx: 'OKX', bybit: 'Bybit',
  bitget: 'Bitget', hyperliquid: 'Hyperliquid',
};

// ─── 消息监听 ─────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(data => sendResponse({ ok: true, data }))
    .catch(err  => sendResponse({ ok: false, error: err.message }));
  return true; // 保持消息通道开放（异步响应）
});

// ─── 创建 ccxt 实例 ───────────────────────────────────────────────────────────
function makeExchange(exchangeId, credentials, marketType) {
  const ExClass = self.ccxt[exchangeId];
  if (!ExClass) throw new Error(`不支持的交易所: ${exchangeId}`);

  const opts = { enableRateLimit: false };

  if (exchangeId === 'hyperliquid') {
    // Hyperliquid：apiKey = 钱包地址，secret = API 钱包私钥
    opts.walletAddress = credentials.apiKey;
    opts.privateKey    = credentials.secret;
  } else {
    opts.apiKey = credentials.apiKey;
    opts.secret = credentials.secret;
    if (credentials.passphrase) opts.password = credentials.passphrase;
  }

  // 合约账户使用 swap 类型
  if (marketType === 'perp') {
    opts.options = { defaultType: 'swap' };
  }

  return new ExClass(opts);
}

// ─── 消息分发 ─────────────────────────────────────────────────────────────────
async function handleMessage({ action, exchange, credentials, params }) {
  if (!exchange)                         throw new Error('未指定交易所');
  if (!action)                           throw new Error('未指定操作类型');
  if (!credentials?.apiKey || !credentials?.secret) {
    throw new Error(`请先在设置页面配置 ${EX_LABEL[exchange] || exchange} 的 API Key`);
  }

  const marketType = params?.marketType || 'spot';
  const ex = makeExchange(exchange, credentials, marketType);

  switch (action) {
    case 'placeOrder':      return doPlaceOrder(ex, exchange, params);
    case 'cancelOrder':     return doCancelOrder(ex, exchange, params);
    case 'getOpenOrders':   return doGetOpenOrders(ex, exchange, params);
    case 'getOrderHistory': return doGetOrderHistory(ex, exchange, params);
    case 'getBalance':      return doGetBalance(ex, exchange, params);
    default:                throw new Error(`未知操作: ${action}`);
  }
}

// ─── 下单 ─────────────────────────────────────────────────────────────────────
async function doPlaceOrder(ex, exchangeId, { symbol, side, orderType, amount, price, stopPrice, marketType }) {
  const amt = parseFloat(amount);
  if (!amt || amt <= 0) throw new Error('数量必须大于 0');

  if (orderType === 'market') {
    return ex.createMarketOrder(symbol, side, amt);
  }

  if (orderType === 'limit') {
    const px = parseFloat(price);
    if (!px || px <= 0) throw new Error('限价单必须填写价格');
    return ex.createLimitOrder(symbol, side, amt, px);
  }

  if (orderType === 'stop') {
    const triggerPx = parseFloat(stopPrice);
    if (!triggerPx || triggerPx <= 0) throw new Error('止损单必须填写触发价格');
    const limitPx = parseFloat(price) > 0 ? parseFloat(price) : null;
    return doStopOrder(ex, exchangeId, symbol, side, amt, limitPx, triggerPx, marketType);
  }

  throw new Error(`不支持的订单类型: ${orderType}`);
}

// 止损单：各交易所差异由 ccxt 内部处理，但部分需要额外 params
async function doStopOrder(ex, exchangeId, symbol, side, amount, limitPrice, stopPrice, marketType) {
  switch (exchangeId) {
    case 'binance': {
      if (marketType === 'perp') {
        // 合约止损：有委托价 → STOP（限价止损），否则 → STOP_MARKET
        if (limitPrice) {
          return ex.createOrder(symbol, 'STOP', side, amount, limitPrice, { stopPrice });
        }
        return ex.createOrder(symbol, 'STOP_MARKET', side, amount, null, { stopPrice });
      }
      // 现货止损限价单 STOP_LOSS_LIMIT
      const px = limitPrice || stopPrice;
      return ex.createOrder(symbol, 'STOP_LOSS_LIMIT', side, amount, px, { stopPrice, timeInForce: 'GTC' });
    }

    case 'okx': {
      // ccxt OKX：止损单自动路由到 /api/v5/trade/order-algo
      const px = limitPrice || stopPrice;
      const params = { stopLossPrice: stopPrice };
      if (limitPrice) params.stopLossLimitPrice = limitPrice;
      return ex.createOrder(symbol, 'stop', side, amount, px, params);
    }

    case 'bybit': {
      const px = limitPrice || stopPrice;
      return ex.createOrder(symbol, 'stop', side, amount, px, {
        triggerPrice: stopPrice,
        triggerBy: 'LastPrice',
        triggerDirection: side === 'buy' ? 1 : 2,
        orderFilter: 'StopOrder',
      });
    }

    case 'bitget': {
      const px = limitPrice || stopPrice;
      return ex.createOrder(symbol, 'stop', side, amount, px, {
        triggerPrice: stopPrice,
        triggerType: marketType === 'perp' ? 'mark_price' : 'market_price',
      });
    }

    case 'hyperliquid': {
      // Hyperliquid：仅有合约，触发单用 trigger 类型
      const px = limitPrice || stopPrice;
      return ex.createOrder(symbol, 'trigger', side, amount, px, {
        triggerPrice: stopPrice,
        triggerDirection: 'below',
        isMarket: !limitPrice,
      });
    }

    default:
      throw new Error(`交易所 ${exchangeId} 不支持止损单`);
  }
}

// ─── 撤单 ─────────────────────────────────────────────────────────────────────
async function doCancelOrder(ex, exchangeId, { symbol, orderId, isAlgo }) {
  if (!orderId) throw new Error('撤单需要 orderId');
  // OKX 算法单（止损单）需要传 algoId 参数
  if (exchangeId === 'okx' && isAlgo) {
    return ex.cancelOrder(orderId, symbol, { algoId: String(orderId) });
  }
  return ex.cancelOrder(orderId, symbol);
}

// ─── 挂单查询 ─────────────────────────────────────────────────────────────────
async function doGetOpenOrders(ex, exchangeId, { symbol }) {
  let orders;
  if (exchangeId === 'okx') {
    // OKX 需同时查询普通单和算法单（止损单在算法列表中）
    const [regular, algo] = await Promise.all([
      ex.fetchOpenOrders(symbol).catch(() => []),
      ex.fetchOpenOrders(symbol, undefined, undefined, { ordType: 'conditional' }).catch(() => []),
    ]);
    orders = [...regular, ...algo];
  } else {
    orders = await ex.fetchOpenOrders(symbol);
  }
  return normalizeOrders(orders);
}

// ─── 历史订单 ─────────────────────────────────────────────────────────────────
async function doGetOrderHistory(ex, exchangeId, { symbol, limit = 50 }) {
  let orders;
  if (exchangeId === 'okx') {
    const [regular, algo] = await Promise.all([
      ex.fetchClosedOrders(symbol, undefined, limit).catch(() => []),
      ex.fetchClosedOrders(symbol, undefined, limit, { ordType: 'conditional' }).catch(() => []),
    ]);
    orders = [...regular, ...algo];
  } else {
    orders = await ex.fetchClosedOrders(symbol, undefined, limit);
  }
  return normalizeOrders(orders);
}

// ─── 余额查询 ─────────────────────────────────────────────────────────────────
async function doGetBalance(ex, exchangeId) {
  const balance = await ex.fetchBalance();

  if (exchangeId === 'hyperliquid') {
    const usdc = balance?.USDC || {};
    return [{ asset: 'USDC', free: String(usdc.free || 0), walletBalance: String(usdc.total || 0) }];
  }

  return Object.entries(balance)
    .filter(([key, val]) => typeof val === 'object' && val !== null && 'free' in val)
    .filter(([key]) => !['info', 'free', 'used', 'total', 'debt'].includes(key))
    .filter(([, val]) => parseFloat(val.free) > 0 || parseFloat(val.used) > 0)
    .map(([currency, val]) => ({
      asset: currency,
      free: String(val.free ?? 0),
      locked: String(val.used ?? 0),
      walletBalance: String(val.total ?? 0),
    }));
}

// ─── 归一化订单格式 ───────────────────────────────────────────────────────────
const ALGO_TYPES = new Set(['stop', 'stop_loss_limit', 'stop_market', 'conditional', 'trigger']);

function normalizeOrders(orders) {
  return (orders || []).map(o => ({
    id: String(o.id),
    symbol: o.symbol,
    side: o.side,
    type: o.type,
    amount: String(o.amount ?? ''),
    price: o.price    ? String(o.price)     : '',
    stopPrice: o.stopPrice  ? String(o.stopPrice)  : (o.triggerPrice ? String(o.triggerPrice) : ''),
    status: o.status,
    time: o.timestamp,
    isAlgo: ALGO_TYPES.has((o.type || '').toLowerCase()),
    raw: o,
  }));
}
