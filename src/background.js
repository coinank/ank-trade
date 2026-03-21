/**
 * Coinank Trader - Background Service Worker
 * 使用 ccxt 统一接口处理所有交易所 API 请求
 */
'use strict';
importScripts('ccxt.browser.min.js');

const EX_LABEL = {
  binance: 'Binance', okx: 'OKX', bybit: 'Bybit',
  bitget: 'Bitget', hyperliquid: 'Hyperliquid',
};

// ─── 实例缓存（markets 只加载一次，后续请求复用）────────────────────────────
const _cache = new Map();

function makeExchange(exchangeId, credentials, marketType) {
  const key = `${exchangeId}_${marketType}_${credentials.apiKey}`;
  if (_cache.has(key)) return _cache.get(key);

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

  // 合约账户使用 swap/perp 类型
  if (marketType === 'perp') {
    opts.options = { defaultType: 'swap' };
  }

  const ex = new ExClass(opts);
  _cache.set(key, ex);
  return ex;
}

// ─── 消息监听 ─────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(data => sendResponse({ ok: true, data }))
    .catch(err  => sendResponse({ ok: false, error: err.message }));
  return true;
});

// ─── 消息分发 ─────────────────────────────────────────────────────────────────
async function handleMessage({ action, exchange, credentials, params }) {
  if (!exchange)  throw new Error('未指定交易所');
  if (!action)    throw new Error('未指定操作类型');
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
    case 'getBalance':      return doGetBalance(ex, exchange);
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

// ─── 止损单（各交易所差异）────────────────────────────────────────────────────
// 统一使用 ccxt 的标准 stopLossPrice / triggerPrice 参数，避免直接拼接交易所专有类型名
async function doStopOrder(ex, exchangeId, symbol, side, amount, limitPrice, stopPrice, marketType) {
  switch (exchangeId) {

    case 'binance': {
      // ccxt Binance 自动根据 stopLossPrice + 执行类型决定：
      //   合约: limit → STOP，market → STOP_MARKET
      //   现货: limit → STOP_LOSS_LIMIT，market → STOP_LOSS
      const execType = limitPrice ? 'limit' : 'market';
      // market 止损：stopPrice 作为价格参数传入（ccxt Binance 需要价格用于精度计算）
      const px = limitPrice ?? stopPrice;
      return ex.createOrder(symbol, execType, side, amount, px, { stopLossPrice: stopPrice });
    }

    case 'okx': {
      // ccxt OKX：检测到 stopLossPrice → conditional=true → ordType='conditional'
      //   → 自动路由到 /api/v5/trade/order-algo
      // price 参数 = limitPrice：
      //   undefined → slOrdPx 默认 '-1'（触发后市价执行）
      //   有值      → slOrdPx = limitPrice（触发后限价执行）
      return ex.createOrder(symbol, 'stop', side, amount, limitPrice, { stopLossPrice: stopPrice });
    }

    case 'bybit': {
      // ccxt Bybit：triggerPrice 参数触发条件单逻辑
      // type 必须是 'limit' 或 'market'（不能是 'stop'）
      // triggerDirection 必须是字符串 '1'(上穿) / '2'(下穿)
      const execType = limitPrice ? 'limit' : 'market';
      return ex.createOrder(symbol, execType, side, amount, limitPrice, {
        triggerPrice:     stopPrice,
        triggerBy:        'LastPrice',
        triggerDirection: side === 'buy' ? '1' : '2',
      });
    }

    case 'bitget': {
      // ccxt Bitget：triggerPrice 参数 → isTriggerOrder=true
      //   → planType='normal_plan' → 路由到 /v2/mix/order/place-plan-order
      // type 必须是 'limit' 或 'market'
      const execType = limitPrice ? 'limit' : 'market';
      return ex.createOrder(symbol, execType, side, amount, limitPrice, {
        triggerPrice: stopPrice,
        triggerType:  'mark_price',
      });
    }

    case 'hyperliquid': {
      // ccxt Hyperliquid：stopLossPrice 参数 → isTrigger=true → trigger 订单
      // type.toUpperCase() === 'MARKET' 决定 isMarket；市价止损需要 price 用于滑点计算
      if (limitPrice) {
        return ex.createOrder(symbol, 'limit', side, amount, limitPrice, { stopLossPrice: stopPrice });
      }
      // 市价止损：传 stopPrice 作为 price（ccxt 据此计算滑点上限）
      return ex.createOrder(symbol, 'market', side, amount, stopPrice, { stopLossPrice: stopPrice });
    }

    default:
      throw new Error(`交易所 ${exchangeId} 不支持止损单`);
  }
}

// ─── 撤单 ─────────────────────────────────────────────────────────────────────
async function doCancelOrder(ex, exchangeId, { symbol, orderId, isAlgo, marketType }) {
  if (!orderId) throw new Error('撤单需要 orderId');

  switch (exchangeId) {
    case 'okx':
      // 算法单（止损单）必须传 trigger:true，ccxt 才会路由到 /api/v5/trade/cancel-algos
      // 否则走 /api/v5/trade/cancel-order → 返回 "order does not exist" 错误
      if (isAlgo) return ex.cancelOrder(orderId, symbol, { trigger: true });
      return ex.cancelOrder(orderId, symbol);

    case 'bybit':
      // 合约止损单：与普通单共用同一撤单接口，无需特殊参数
      // 现货触发单：需要 trigger:true（ccxt 设置 orderFilter=StopOrder）
      if (isAlgo && marketType !== 'perp') return ex.cancelOrder(orderId, symbol, { trigger: true });
      return ex.cancelOrder(orderId, symbol);

    case 'bitget':
      // 计划单（止损单）必须传 trigger:true，ccxt 才会路由到 /v2/mix/order/cancel-plan-order
      if (isAlgo) return ex.cancelOrder(orderId, symbol, { trigger: true });
      return ex.cancelOrder(orderId, symbol);

    default:
      // Binance / Hyperliquid：同一接口处理所有订单类型
      return ex.cancelOrder(orderId, symbol);
  }
}

// ─── 挂单查询 ─────────────────────────────────────────────────────────────────
async function doGetOpenOrders(ex, exchangeId, { symbol }) {
  let orders;
  if (exchangeId === 'okx') {
    // OKX 止损单在算法单列表中，需并发查询两个接口
    // ordType='conditional' 触发 ccxt 使用 privateGetTradeOrdersAlgoPending 接口
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
    // Hyperliquid 只有永续合约，结算货币为 USDC
    const usdc = balance?.USDC || {};
    return [{ asset: 'USDC', free: String(usdc.free || 0), walletBalance: String(usdc.total || 0) }];
  }

  // ccxt fetchBalance 返回格式：{ 'BTC': { free, used, total }, 'free': {...}, ... }
  // 过滤掉 info/free/used/total/debt 等顶层汇总键，只保留各币种对象
  return Object.entries(balance)
    .filter(([key, val]) => typeof val === 'object' && val !== null && 'free' in val)
    .filter(([key]) => !['info', 'free', 'used', 'total', 'debt'].includes(key))
    .filter(([, val]) => parseFloat(val.free) > 0 || parseFloat(val.used) > 0)
    .map(([currency, val]) => ({
      asset: currency,
      free:         String(val.free  ?? 0),
      locked:       String(val.used  ?? 0),
      walletBalance: String(val.total ?? 0),
    }));
}

// ─── 归一化订单格式 ───────────────────────────────────────────────────────────
// 凡是触发型订单（需要特殊撤单路由）都标记 isAlgo:true
const ALGO_TYPES = new Set([
  'stop', 'stop_loss_limit', 'stop_market',
  'conditional', 'trigger', 'stop_loss',
]);

function normalizeOrders(orders) {
  return (orders || []).map(o => ({
    id:        String(o.id),
    symbol:    o.symbol,
    side:      o.side,
    type:      o.type,
    amount:    String(o.amount ?? ''),
    price:     o.price      ? String(o.price)      : '',
    stopPrice: o.stopPrice  ? String(o.stopPrice)  :
               o.triggerPrice ? String(o.triggerPrice) : '',
    status:    o.status,
    time:      o.timestamp,
    isAlgo:    ALGO_TYPES.has((o.type || '').toLowerCase()),
    raw:       o,
  }));
}
