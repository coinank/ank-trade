/**
 * Coinank Trader - Background Service Worker
 * 使用 ccxt 统一接口处理所有交易所 API 请求
 */
'use strict';
importScripts('ccxt.browser.min.js');

// ─── SW Keepalive ─────────────────────────────────────────────────────────────
// Chrome MV3 Service Worker 无活动 30 秒会休眠，导致长耗时请求（loadMarkets）中途失败
// 每 24 秒触发一次 alarm 保持 SW 存活
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => {});

// 点击工具栏图标时打开/关闭侧边栏
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

const EX_LABEL = {
  binance: 'Binance', okx: 'OKX', bybit: 'Bybit',
  bitget: 'Bitget', hyperliquid: 'Hyperliquid',
};

// ─── 实例缓存 ─────────────────────────────────────────────────────────────────
const _cache = new Map();

function makeExchange(exchangeId, credentials, marketType) {
  const key = `${exchangeId}_${marketType}_${credentials.apiKey}_${credentials.secret.slice(-8)}`;
  if (_cache.has(key)) return _cache.get(key);

  const ExClass = self.ccxt[exchangeId];
  if (!ExClass) throw new Error(`不支持的交易所: ${exchangeId}`);

  const opts = { enableRateLimit: false, timeout: 30000 };
  if (exchangeId === 'hyperliquid') {
    opts.walletAddress = credentials.apiKey;
    opts.privateKey    = credentials.secret;
  } else {
    opts.apiKey = credentials.apiKey;
    opts.secret = credentials.secret;
    if (credentials.passphrase) opts.password = credentials.passphrase;
  }
  if (marketType === 'perp') opts.options = { defaultType: 'swap' };

  const ex = new ExClass(opts);
  _cache.set(key, ex);
  return ex;
}

// 公开实例（无需 API Key，用于 loadMarkets / fetchTicker 等公开接口）
function makePublicExchange(exchangeId, marketType) {
  const key = `public_${exchangeId}_${marketType}`;
  if (_cache.has(key)) return _cache.get(key);

  const ExClass = self.ccxt[exchangeId];
  if (!ExClass) throw new Error(`不支持的交易所: ${exchangeId}`);

  const opts = { enableRateLimit: false, timeout: 30000 };
  if (marketType === 'perp') opts.options = { defaultType: 'swap' };

  const ex = new ExClass(opts);
  _cache.set(key, ex);
  return ex;
}

// ─── 速率限制重试 ─────────────────────────────────────────────────────────────
async function withRetry(fn, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try { return await fn(); } catch (e) {
      const msg = (e.message || '').toLowerCase();
      if (!msg.includes('rate limit') && !msg.includes('too many requests') && !msg.includes('429')) throw e;
      if (i === maxRetries - 1) throw e; // 最后一次直接抛，不再等待
      await new Promise(r => setTimeout(r, Math.pow(2, i) * 1000));
    }
  }
}

// ─── 消息监听 ─────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // 来自 content script 的页面符号通知（同步响应）
  if (message.action === 'pageSymbol') {
    chrome.storage.local.set({ coinankSymbol: message.symbol });
    sendResponse({ ok: true });
    return false;
  }

  handleMessage(message)
    .then(data => sendResponse({ ok: true, data }))
    .catch(err  => sendResponse({ ok: false, error: err.message }));
  return true;
});

// ─── 消息分发 ─────────────────────────────────────────────────────────────────
async function handleMessage({ action, exchange, credentials, params }) {
  if (!exchange) throw new Error('未指定交易所');
  if (!action)   throw new Error('未指定操作类型');

  const marketType = params?.marketType || 'spot';

  // 公开接口：有 credentials 则复用已签名实例，否则用公开实例
  if (action === 'getMarkets' || action === 'getTicker' || action === 'getMarketTickers') {
    const ex = (credentials?.apiKey && credentials?.secret)
      ? makeExchange(exchange, credentials, marketType)
      : makePublicExchange(exchange, marketType);
    if (action === 'getMarkets')      return withRetry(() => doGetMarkets(ex, params));
    if (action === 'getTicker')       return doGetTicker(ex, params);
    if (action === 'getMarketTickers') return withRetry(() => doGetMarketTickers(ex, params));
  }

  // 私有接口：必须有 API Key
  if (!credentials?.apiKey || !credentials?.secret) {
    throw new Error(`请先在设置页面配置 ${EX_LABEL[exchange] || exchange} 的 API Key`);
  }

  const ex = makeExchange(exchange, credentials, marketType);

  switch (action) {
    case 'placeOrder':      return doPlaceOrder(ex, exchange, params);
    case 'cancelOrder':     return doCancelOrder(ex, exchange, params);
    case 'getOpenOrders':   return withRetry(() => doGetOpenOrders(ex, exchange, params));
    case 'getOrderHistory': return withRetry(() => doGetOrderHistory(ex, exchange, params));
    case 'getBalance':      return withRetry(() => doGetBalance(ex, exchange));
    case 'getPositions':    return withRetry(() => doGetPositions(ex));
    default:                throw new Error(`未知操作: ${action}`);
  }
}

// ─── 下单（含精度修正）────────────────────────────────────────────────────────
async function doPlaceOrder(ex, exchangeId, { symbol, side, orderType, amount, price, stopPrice, marketType, reduceOnly, leverage }) {
  // loadMarkets 确保精度数据已加载（TTL 缓存，不会每次都重新请求）
  await ex.loadMarkets();

  // 合约：下单前设置杠杆（忽略错误，不阻断下单流程）
  if (marketType === 'perp' && leverage && leverage > 0) {
    try { await ex.setLeverage(leverage, symbol); } catch (_) {}
  }

  const rawAmt = parseFloat(amount);
  if (!rawAmt || rawAmt <= 0) throw new Error('数量必须大于 0');

  // 精度修正：amountToPrecision / priceToPrecision 符合交易所 lotSize / tickSize 要求
  const amt = parseFloat(ex.amountToPrecision(symbol, rawAmt));
  const toP  = v => parseFloat(v) > 0
    ? parseFloat(ex.priceToPrecision(symbol, parseFloat(v)))
    : null;

  const extra = {};
  if (reduceOnly && marketType === 'perp') extra.reduceOnly = true;

  if (orderType === 'market') {
    if (exchangeId === 'hyperliquid') {
      const ticker = await ex.fetchTicker(symbol);
      const refPx = ticker.last || ticker.ask || ticker.bid;
      if (!refPx) throw new Error('Hyperliquid 市价单无法获取当前价格，请改用限价单');
      return ex.createMarketOrder(symbol, side, amt, refPx, Object.keys(extra).length ? extra : undefined);
    }
    return ex.createMarketOrder(symbol, side, amt, undefined, Object.keys(extra).length ? extra : undefined);
  }

  if (orderType === 'limit') {
    const px = toP(price);
    if (!px || px <= 0) throw new Error('限价单必须填写价格');
    return ex.createLimitOrder(symbol, side, amt, px, Object.keys(extra).length ? extra : undefined);
  }

  if (orderType === 'stop') {
    const triggerPx = toP(stopPrice) || parseFloat(stopPrice);
    if (!triggerPx || triggerPx <= 0) throw new Error('止损单必须填写触发价格');
    const limitPx = toP(price);
    return doStopOrder(ex, exchangeId, symbol, side, amt, limitPx, triggerPx, marketType, extra);
  }

  if (orderType === 'takeprofit') {
    const triggerPx = toP(stopPrice) || parseFloat(stopPrice);
    if (!triggerPx || triggerPx <= 0) throw new Error('止盈单必须填写触发价格');
    const limitPx = toP(price);
    return doTakeProfitOrder(ex, exchangeId, symbol, side, amt, limitPx, triggerPx, marketType, extra);
  }

  throw new Error(`不支持的订单类型: ${orderType}`);
}

// ─── 止损单 ───────────────────────────────────────────────────────────────────
async function doStopOrder(ex, exchangeId, symbol, side, amount, limitPrice, stopPrice, marketType, extra) {
  switch (exchangeId) {
    case 'binance': {
      const execType = limitPrice ? 'limit' : 'market';
      const px = limitPrice ?? stopPrice;
      return ex.createOrder(symbol, execType, side, amount, px, { stopLossPrice: stopPrice, ...extra });
    }
    case 'okx':
      return ex.createOrder(symbol, 'stop', side, amount, limitPrice, { stopLossPrice: stopPrice, ...extra });

    case 'bybit': {
      const execType = limitPrice ? 'limit' : 'market';
      return ex.createOrder(symbol, execType, side, amount, limitPrice, {
        triggerPrice: stopPrice, triggerBy: 'LastPrice',
        triggerDirection: side === 'buy' ? '1' : '2', ...extra,
      });
    }
    case 'bitget': {
      const execType = limitPrice ? 'limit' : 'market';
      return ex.createOrder(symbol, execType, side, amount, limitPrice, {
        triggerPrice: stopPrice, triggerType: 'mark_price', ...extra,
      });
    }
    case 'hyperliquid':
      if (limitPrice) return ex.createOrder(symbol, 'limit', side, amount, limitPrice, { stopLossPrice: stopPrice, ...extra });
      return ex.createOrder(symbol, 'market', side, amount, stopPrice, { stopLossPrice: stopPrice, ...extra });

    default:
      throw new Error(`交易所 ${exchangeId} 不支持止损单`);
  }
}

// ─── 止盈单 ───────────────────────────────────────────────────────────────────
// 触发方向与止损单相反：做多止盈 = 价格上穿触发；做空止盈 = 价格下穿触发
async function doTakeProfitOrder(ex, exchangeId, symbol, side, amount, limitPrice, tpPrice, marketType, extra) {
  switch (exchangeId) {
    case 'binance': {
      const execType = limitPrice ? 'limit' : 'market';
      const px = limitPrice ?? tpPrice;
      return ex.createOrder(symbol, execType, side, amount, px, { takeProfitPrice: tpPrice, ...extra });
    }
    case 'okx':
      return ex.createOrder(symbol, 'stop', side, amount, limitPrice, { takeProfitPrice: tpPrice, ...extra });

    case 'bybit': {
      const execType = limitPrice ? 'limit' : 'market';
      // 止盈 triggerDirection 与止损相反
      return ex.createOrder(symbol, execType, side, amount, limitPrice, {
        triggerPrice: tpPrice, triggerBy: 'LastPrice',
        triggerDirection: side === 'buy' ? '2' : '1', ...extra,
      });
    }
    case 'bitget': {
      const execType = limitPrice ? 'limit' : 'market';
      return ex.createOrder(symbol, execType, side, amount, limitPrice, {
        triggerPrice: tpPrice, triggerType: 'mark_price', ...extra,
      });
    }
    case 'hyperliquid':
      if (limitPrice) return ex.createOrder(symbol, 'limit', side, amount, limitPrice, { takeProfitPrice: tpPrice, ...extra });
      return ex.createOrder(symbol, 'market', side, amount, tpPrice, { takeProfitPrice: tpPrice, ...extra });

    default:
      throw new Error(`交易所 ${exchangeId} 不支持止盈单`);
  }
}

// ─── 撤单 ─────────────────────────────────────────────────────────────────────
async function doCancelOrder(ex, exchangeId, { symbol, orderId, isAlgo, marketType }) {
  if (!orderId) throw new Error('撤单需要 orderId');
  switch (exchangeId) {
    case 'okx':
      if (isAlgo) return ex.cancelOrder(orderId, symbol, { trigger: true });
      return ex.cancelOrder(orderId, symbol);
    case 'bybit':
      if (isAlgo && marketType !== 'perp') return ex.cancelOrder(orderId, symbol, { trigger: true });
      return ex.cancelOrder(orderId, symbol);
    case 'bitget':
      if (isAlgo) return ex.cancelOrder(orderId, symbol, { trigger: true });
      return ex.cancelOrder(orderId, symbol);
    default:
      return ex.cancelOrder(orderId, symbol);
  }
}

// ─── 挂单查询 ─────────────────────────────────────────────────────────────────
async function doGetOpenOrders(ex, exchangeId, { symbol }) {
  let orders;
  if (exchangeId === 'okx') {
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
      free:          String(val.free  ?? 0),
      locked:        String(val.used  ?? 0),
      walletBalance: String(val.total ?? 0),
    }));
}

// ─── 持仓查询（合约）─────────────────────────────────────────────────────────
async function doGetPositions(ex) {
  const positions = await ex.fetchPositions();
  return positions
    .filter(p => p.contracts && Math.abs(parseFloat(p.contracts)) > 0)
    .map(p => ({
      symbol:           p.symbol,
      side:             p.side,
      contracts:        String(p.contracts),
      entryPrice:       p.entryPrice        ? String(Number(p.entryPrice).toFixed(6))        : '',
      markPrice:        p.markPrice         ? String(Number(p.markPrice).toFixed(6))         : '',
      unrealizedPnl:    String(Number(p.unrealizedPnl || 0).toFixed(4)),
      liquidationPrice: p.liquidationPrice  ? String(Number(p.liquidationPrice).toFixed(2))  : '',
      leverage:         p.leverage          ? String(p.leverage)                             : '',
      marginType:       p.marginMode || '',
    }));
}

// ─── 行情查询 ─────────────────────────────────────────────────────────────────
async function doGetTicker(ex, { symbol }) {
  const t = await ex.fetchTicker(symbol);
  // 优先用 percentage，若为 null（如 Hyperliquid）则用 open/last 推算
  let change = t.percentage;
  if (change == null && t.open && t.last) {
    change = ((t.last - t.open) / t.open) * 100;
  }
  return {
    last:   t.last,
    bid:    t.bid,
    ask:    t.ask,
    change,
    high:   t.high,
    low:    t.low,
    volume: t.baseVolume,
  };
}

// ─── 批量行情（弹窗用）────────────────────────────────────────────────────────
async function doGetMarketTickers(ex, { marketType }) {
  await ex.loadMarkets();
  const tickers = await ex.fetchTickers();
  const type = marketType === 'perp' ? 'swap' : 'spot';
  const result = {};
  for (const [sym, t] of Object.entries(tickers)) {
    const mkt = ex.markets[sym];
    if (!mkt || mkt.type !== type) continue;
    let change = t.percentage;
    if (change == null && t.open && t.last)
      change = ((t.last - t.open) / t.open) * 100;
    result[sym] = { price: t.last, change };
  }
  return result;
}

// ─── 市场列表 ─────────────────────────────────────────────────────────────────
const _marketsTs  = new Map();
const MARKETS_TTL = 60 * 60 * 1000; // 1 小时自动过期

async function doGetMarkets(ex, { marketType, forceReload }) {
  const key   = `${ex.id}_${marketType}`;
  const stale = (Date.now() - (_marketsTs.get(key) || 0)) > MARKETS_TTL;
  await ex.loadMarkets(forceReload || stale);
  if (forceReload || stale) _marketsTs.set(key, Date.now());
  const type = marketType === 'perp' ? 'swap' : 'spot';
  return Object.values(ex.markets)
    .filter(m => m.type === type && m.active !== false)
    .map(m => m.symbol)
    .sort();
}

// ─── 归一化订单格式 ───────────────────────────────────────────────────────────
const ALGO_TYPES = new Set([
  'stop', 'stop_loss_limit', 'stop_market', 'stop_loss',
  'take_profit', 'take_profit_market', 'take_profit_limit',
  'conditional', 'trigger',
]);

function normalizeOrders(orders) {
  return (orders || []).map(o => ({
    id:        String(o.id),
    symbol:    o.symbol,
    side:      o.side,
    type:      o.type,
    amount:    String(o.amount ?? ''),
    price:     o.price       ? String(o.price)       : '',
    stopPrice: o.stopPrice   ? String(o.stopPrice)   :
               o.triggerPrice ? String(o.triggerPrice) : '',
    status:    o.status,
    time:      o.timestamp,
    isAlgo:    ALGO_TYPES.has((o.type || '').toLowerCase()),
    raw:       o,
  }));
}
