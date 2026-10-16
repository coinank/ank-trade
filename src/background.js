/**
 * Coinank Trader - Background Service Worker
 * 使用 ccxt 统一接口处理所有交易所 API 请求
 */
'use strict';
importScripts('ccxt.browser.min.js');

// ─── SW Keepalive ─────────────────────────────────────────────────────────────
// Chrome MV3 Service Worker 无活动 30 秒会休眠，导致长耗时请求（loadMarkets）中途失败
// Chrome 120 起 alarm 最短周期为 30 秒；请求本身仍必须有超时。
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {});

// 点击工具栏图标时打开/关闭侧边栏
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

const EX_LABEL = {
  binance: 'Binance', okx: 'OKX', bybit: 'Bybit',
  bitget: 'Bitget', hyperliquid: 'Hyperliquid',
};

// ─── 实例缓存 ─────────────────────────────────────────────────────────────────
const _cache = new Map();
const _marketLoads = new WeakMap();
const MARKETS_TTL = 60 * 60 * 1000;

async function loadExchangeMarkets(ex, forceReload = false) {
  let state = _marketLoads.get(ex);
  if (!state) { state = { time: 0, loading: null }; _marketLoads.set(ex, state); }
  if (state.loading) return state.loading;
  const stale = Date.now() - state.time >= MARKETS_TTL;
  state.loading = ex.loadMarkets(forceReload || stale);
  try {
    const markets = await state.loading;
    if (forceReload || stale) state.time = Date.now();
    return markets;
  } finally {
    state.loading = null;
  }
}
chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});

chrome.storage.onChanged?.addListener(changes => {
  for (const exchangeId of Object.keys(EX_LABEL)) {
    if (changes[`credentials_${exchangeId}`]) {
      _cache.delete(`${exchangeId}_spot`);
      _cache.delete(`${exchangeId}_perp`);
    }
  }
});

function makeExchange(exchangeId, credentials, marketType) {
  const key = `${exchangeId}_${marketType}`;
  const cached = _cache.get(key);
  if (cached && cached.apiKey === credentials.apiKey && cached.secret === credentials.secret &&
      (cached.password || '') === (credentials.passphrase || '')) return cached.exchange;

  const ExClass = self.ccxt[exchangeId];
  if (!ExClass) throw new Error(`不支持的交易所: ${exchangeId}`);

  const opts = { enableRateLimit: true, timeout: 30000 };
  if (exchangeId === 'hyperliquid') {
    opts.walletAddress = credentials.apiKey;
    opts.privateKey    = credentials.secret;
  } else {
    opts.apiKey = credentials.apiKey;
    opts.secret = credentials.secret;
    if (credentials.passphrase) opts.password = credentials.passphrase;
  }
  opts.options = { defaultType: marketType === 'perp' ? 'swap' : 'spot' };

  const ex = new ExClass(opts);
  _cache.set(key, { apiKey: credentials.apiKey, secret: credentials.secret, password: credentials.passphrase || '', exchange: ex });
  return ex;
}

// 公开实例（无需 API Key，用于 loadMarkets / fetchTicker 等公开接口）
function makePublicExchange(exchangeId, marketType) {
  const key = `public_${exchangeId}_${marketType}`;
  if (_cache.has(key)) return _cache.get(key);

  const ExClass = self.ccxt[exchangeId];
  if (!ExClass) throw new Error(`不支持的交易所: ${exchangeId}`);

  const opts = { enableRateLimit: true, timeout: 30000 };
  opts.options = { defaultType: marketType === 'perp' ? 'swap' : 'spot' };

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
    if (!_sender.url?.startsWith('https://coinank.com/') || !/^[A-Z0-9]{1,20}\/[A-Z0-9]{2,10}$/.test(message.symbol || '')) {
      sendResponse({ ok: false, error: '无效的页面交易对通知' });
      return false;
    }
    chrome.storage.local.set({ coinankSymbol: message.symbol });
    sendResponse({ ok: true });
    return false;
  }

  if (!_sender.url?.startsWith(chrome.runtime.getURL(''))) {
    sendResponse({ ok: false, error: '交易操作仅允许从插件页面发起' });
    return false;
  }

  handleMessage(message)
    .then(data => sendResponse({ ok: true, data }))
    .catch(err  => sendResponse({ ok: false, error: err.message, code: err.code || 'REQUEST_REJECTED' }));
  return true;
});

// ─── 消息分发 ─────────────────────────────────────────────────────────────────
async function handleMessage({ action, exchange, credentials, params }) {
  if (!exchange) throw new Error('未指定交易所');
  if (!action)   throw new Error('未指定操作类型');
  if (!Object.prototype.hasOwnProperty.call(EX_LABEL, exchange)) throw new Error('不支持的交易所');

  const marketType = params?.marketType || 'spot';
  if (!['spot', 'perp'].includes(marketType)) throw new Error('无效的市场类型');
  if (action === 'acknowledgeOrder') {
    if (!/^[a-f0-9]{32}$/.test(params?.requestId || '')) throw new Error('无效的委托标识');
    return withExchangeOrderLock(exchange, async () => {
      const key = `pendingTrade_${params.requestId}`;
      const stored = await chrome.storage.local.get(key);
      if (stored[key]?.exchange === exchange) await chrome.storage.local.remove(key);
      return true;
    });
  }

  // 公开接口：有 credentials 则复用已签名实例，否则用公开实例
  if (action === 'getMarkets' || action === 'getTicker' || action === 'getMarketTickers') {
    const ex = makePublicExchange(exchange, marketType);
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
    case 'placeOrder':      return placeOrderOnce(ex, exchange, credentials, params);
    case 'cancelOrder':     return doCancelOrder(ex, exchange, params);
    case 'getOpenOrders':   return withRetry(() => doGetOpenOrders(ex, exchange, params));
    case 'getOrderHistory': return withRetry(() => doGetOrderHistory(ex, exchange, params));
    case 'getBalance':      return withRetry(() => doGetBalance(ex, exchange, params));
    case 'getPositions':    return withRetry(() => doGetPositions(ex, params));
    default:                throw new Error(`未知操作: ${action}`);
  }
}

// ─── 下单（含精度修正）────────────────────────────────────────────────────────
const _orderLocks = new Set();
const _orderRequests = new Map();

async function withExchangeOrderLock(exchangeId, run) {
  if (_orderLocks.has(exchangeId)) throw new Error('订单仍在提交或核对，请等待完成后再操作');
  _orderLocks.add(exchangeId);
  try {
    return await run();
  } finally {
    _orderLocks.delete(exchangeId);
  }
}

async function placeOrderOnce(ex, exchangeId, credentials, params) {
  const account = `${exchangeId}:${credentials.apiKey}`;
  const requestId = params.requestId;
  if (!/^[a-f0-9]{32}$/.test(requestId || '')) throw new Error('下单请求缺少有效标识，请刷新插件后重试');
  const key = `${account}:${requestId}`;
  const fingerprint = JSON.stringify(params);
  const previous = _orderRequests.get(key);
  if (previous) {
    if (previous.fingerprint !== fingerprint) throw new Error('委托标识已用于其他订单，请刷新插件');
    return previous.request;
  }
  const request = withExchangeOrderLock(exchangeId, async () => {
    const pending = await chrome.storage.local.get(null);
    if (Object.entries(pending).some(([name, value]) => name.startsWith('pendingTrade_') && value?.exchange === exchangeId &&
        /^[a-f0-9]{32}$/.test(value.params?.requestId || '') && value.params.requestId !== requestId && value.phase !== 'queued')) {
      throw new Error('该交易所有其他未确认的订单，请先核对交易所挂单、成交和持仓后解除限制');
    }
    const pendingKey = `pendingTrade_${requestId}`;
    const record = pending[pendingKey];
    if (record?.exchange !== exchangeId || record.params?.requestId !== requestId) {
      throw new Error('待提交订单记录已撤销，请重新确认后下单');
    }
    if (record.phase !== 'queued') {
      const error = new Error('该委托结果尚未确认，请先核对交易所订单');
      error.code = 'ORDER_STATUS_UNKNOWN';
      throw error;
    }
    // queued 只表示界面已保存意图；后台持久化 submitting 后才允许发单。
    const submitting = { ...record, params, phase: 'submitting' };
    await chrome.storage.local.set({ [pendingKey]: submitting });
    let order;
    try {
      order = await doPlaceOrder(ex, exchangeId, params);
    } catch (e) {
      try {
        if (e.code === 'ORDER_STATUS_UNKNOWN') {
          await chrome.storage.local.set({ [pendingKey]: { ...submitting, phase: 'unknown' } });
        } else {
          await chrome.storage.local.remove(pendingKey);
        }
      } catch (_) {} // 写入失败时保留原 submitting 记录，继续阻止重复下单。
      throw e;
    }
    try {
      await chrome.storage.local.remove(pendingKey);
    } catch (_) {
      const error = new Error('订单已提交，但本地状态清理失败，请先核对交易所订单');
      error.code = 'ORDER_STATUS_UNKNOWN';
      throw error;
    }
    return order;
  });
  _orderRequests.set(key, { fingerprint, request });
  try {
    return await request;
  } finally {
    setTimeout(() => _orderRequests.delete(key), 15 * 60 * 1000);
  }
}

async function doPlaceOrder(ex, exchangeId, { symbol, side, orderType, amount, price, stopPrice, marketType = 'spot', reduceOnly, leverage, requestId }) {
  // loadMarkets 确保精度数据已加载（TTL 缓存，不会每次都重新请求）
  await loadExchangeMarkets(ex, !ex.markets?.[symbol]);
  const market = assertOrderMarketType(ex, symbol, marketType);
  if (!['buy', 'sell'].includes(side)) throw new Error('无效的买卖方向');
  if (!['market', 'limit', 'stop', 'takeprofit'].includes(orderType)) throw new Error('无效的订单类型');

  const rawAmt = Number(amount);
  if (!Number.isFinite(rawAmt) || rawAmt <= 0) throw new Error('数量必须是大于 0 的有限数值');

  // 精度修正：amountToPrecision / priceToPrecision 符合交易所 lotSize / tickSize 要求
  const contracts = market.swap
    ? self.ccxt.Precise.stringDiv(ex.numberToString(rawAmt), String(market.contractSize))
    : ex.numberToString(rawAmt);
  // CCXT TRUNCATE = 0；浏览器包只在实例上暴露 decimalToPrecision。
  const truncated = ex.decimalToPrecision(contracts, 0, market.precision.amount, ex.precisionMode);
  const amt = Number(ex.amountToPrecision(symbol, truncated));
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('数量小于交易所最小精度，请增加数量');
  if (market.limits?.amount?.min && amt < market.limits.amount.min) throw new Error('数量小于交易所最小下单量');
  const toP = v => {
    if (v == null || v === '') return null;
    if (!Number.isFinite(Number(v)) || Number(v) <= 0) throw new Error('价格必须是大于 0 的有限数值');
    const px = Number(ex.priceToPrecision(symbol, Number(v)));
    if (!Number.isFinite(px) || px <= 0) throw new Error('价格小于交易所最小精度');
    return px;
  };
  const px = orderType === 'market' ? null : toP(price);
  const triggerPx = ['stop', 'takeprofit'].includes(orderType) ? toP(stopPrice) : null;
  if (orderType === 'limit' && !px) throw new Error('限价单必须填写价格');
  if (['stop', 'takeprofit'].includes(orderType) && !triggerPx) throw new Error('必须填写触发价格');

  const extra = {};
  if (reduceOnly && marketType === 'perp') extra.reduceOnly = true;
  if (requestId) extra.clientOrderId = exchangeId === 'hyperliquid' ? `0x${requestId}` : `ank${requestId.slice(0, 29)}`;

  // 在任何私有写请求前完成数量、价格及触发方向校验。
  if (['bitget', 'bybit'].includes(exchangeId) && triggerPx) {
    const ticker = await ex.fetchTicker(symbol);
    const current = Number(ticker.last);
    const upward = orderType === 'stop' ? side === 'buy' : side === 'sell';
    if (!current || (upward ? triggerPx <= current : triggerPx >= current)) {
      throw new Error(upward ? '触发价格必须高于当前成交价' : '触发价格必须低于当前成交价');
    }
  }

  if (marketType === 'perp') {
    const account = await orderAccountSettings(ex, exchangeId, market, side, reduceOnly);
    Object.assign(extra, account.params);
    if (leverage != null) {
      if (!Number.isInteger(leverage) || leverage < 1 || leverage > 125) throw new Error('无效的杠杆倍数');
      try {
        await ex.setLeverage(leverage, symbol, account.leverageParams);
      } catch (e) {
        if (!(exchangeId === 'bybit' && /\b110043\b/.test(e.message || ''))) {
          throw new Error(`设置杠杆失败，已取消下单：${e.message || e}`);
        }
      }
    }
  }

  if (orderType === 'market') {
    if (exchangeId === 'hyperliquid' || (exchangeId === 'bitget' && market.spot && side === 'buy')) {
      const ticker = await ex.fetchTicker(symbol);
      const refPx = ticker.last || ticker.ask || ticker.bid;
      if (!Number.isFinite(Number(refPx)) || refPx <= 0) throw new Error('市价单无法获取当前价格，请改用限价单');
      return submitExchangeOrder(() => ex.createMarketOrder(symbol, side, amt, refPx, extra));
    }
    return submitExchangeOrder(() => ex.createMarketOrder(symbol, side, amt, undefined, extra));
  }

  if (orderType === 'limit') {
    return submitExchangeOrder(() => ex.createLimitOrder(symbol, side, amt, px, extra));
  }

  if (orderType === 'stop') {
    return submitExchangeOrder(() => doStopOrder(ex, exchangeId, symbol, side, amt, px, triggerPx, marketType, extra));
  }

  if (orderType === 'takeprofit') {
    return submitExchangeOrder(() => doTakeProfitOrder(ex, exchangeId, symbol, side, amt, px, triggerPx, marketType, extra));
  }

  throw new Error(`不支持的订单类型: ${orderType}`);
}

async function submitExchangeOrder(send) {
  try {
    return await send();
  } catch (e) {
    const rejected = ['InvalidOrder', 'InsufficientFunds', 'AuthenticationError', 'BadRequest', 'NotSupported', 'ArgumentsRequired', 'OperationRejected']
      .some(name => typeof self.ccxt[name] === 'function' && e instanceof self.ccxt[name]);
    e.code = rejected && !/execution status unknown|unknown error|unexpected response/i.test(e.message || '')
      ? 'ORDER_REJECTED' : 'ORDER_STATUS_UNKNOWN';
    throw e;
  }
}

function assertOrderMarketType(ex, symbol, marketType = 'spot') {
  const market = ex.market(symbol);
  const expected = marketType === 'perp' ? 'swap' : 'spot';
  const actual = market.type || (market.swap ? 'swap' : (market.spot ? 'spot' : 'unknown'));
  const ok = expected === 'swap'
    ? (market.swap || actual === 'swap')
    : (market.spot || actual === 'spot');
  if (!ok) {
    const expectedLabel = expected === 'swap' ? '合约' : '现货';
    const actualLabel = actual === 'swap' ? '合约' : (actual === 'spot' ? '现货' : actual);
    throw new Error(`交易对类型不匹配：当前选择${expectedLabel}，但 ${symbol} 是${actualLabel}交易对。请重新选择${expectedLabel}交易对后再下单。`);
  }
  if (market.active === false) throw new Error('交易对已暂停交易');
  if (market.swap && !supportedSwap(market)) throw new Error('当前版本仅支持 USDT/USDC 线性永续合约，请选择对应交易对');
  return market;
}

function supportedSwap(market) {
  return market.swap && market.linear && ['USDT', 'USDC'].includes(market.settle) &&
    market.settle === market.quote && Number.isFinite(market.contractSize) && market.contractSize > 0;
}

async function orderAccountSettings(ex, exchangeId, market, side, reduceOnly) {
  const params = {}, leverageParams = {};
  const positionSide = side === 'buy' ? (reduceOnly ? 'short' : 'long') : (reduceOnly ? 'long' : 'short');
  if (exchangeId === 'binance' || exchangeId === 'okx') {
    const mode = await ex.fetchPositionMode(market.symbol);
    if (typeof mode.hedged !== 'boolean') throw new Error('无法确认账户持仓模式，已取消下单');
    if (mode.hedged) {
      if (exchangeId === 'binance') params.positionSide = positionSide.toUpperCase();
      else params.posSide = positionSide;
      params.reduceOnly = undefined;
    }
  }
  if (exchangeId === 'bybit' || exchangeId === 'okx' || exchangeId === 'hyperliquid') {
    const positions = await ex.fetchPositions([market.symbol]);
    if (exchangeId === 'bybit') {
      const indices = positions.map(p => p.info?.positionIdx).filter(v => v != null).map(Number);
      if (!indices.length || indices.some(v => ![0, 1, 2].includes(v))) throw new Error('无法确认 Bybit 持仓模式，已取消下单');
      params.positionIdx = indices.some(v => v > 0) ? (positionSide === 'long' ? 1 : 2) : 0;
    } else {
      const modes = [...new Set(positions.filter(p => Number(p.contracts) > 0).map(p => p.marginMode).filter(Boolean))];
      if (modes.length > 1) throw new Error('该交易对同时存在全仓和逐仓持仓，请在交易所管理订单');
      const marginMode = modes[0] || 'cross';
      if (!['cross', 'isolated'].includes(marginMode)) throw new Error('无法确认保证金模式，已取消下单');
      leverageParams.marginMode = marginMode;
      if (exchangeId === 'okx') {
        params.marginMode = marginMode;
        if (params.posSide) leverageParams.posSide = params.posSide;
      }
    }
  }
  if (exchangeId === 'bitget') {
    const response = await ex.privateMixGetV2MixAccountAccount({ symbol: market.id, productType: `${market.settleId}-FUTURES`, marginCoin: market.settleId });
    const account = response.data;
    if (!['one_way_mode', 'hedge_mode'].includes(account?.posMode) || !['crossed', 'isolated'].includes(account?.marginMode)) {
      throw new Error('无法确认 Bitget 账户模式，已取消下单');
    }
    params.hedged = account.posMode === 'hedge_mode';
    params.marginMode = account.marginMode === 'crossed' ? 'cross' : 'isolated';
    if (params.hedged && params.marginMode === 'isolated') leverageParams.holdSide = positionSide;
  }
  return { params, leverageParams };
}

function orderPrice(price) {
  return price ?? undefined;
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
      return ex.createOrder(symbol, 'stop', side, amount, orderPrice(limitPrice), {
        stopLossPrice: stopPrice, ...extra, ...(marketType === 'spot' ? { tdMode: 'cash' } : {}),
        ...(extra.clientOrderId ? { algoClOrdId: extra.clientOrderId, clientOrderId: undefined, clOrdId: undefined } : {}),
      });

    case 'bybit': {
      const execType = limitPrice ? 'limit' : 'market';
      return ex.createOrder(symbol, execType, side, amount, orderPrice(limitPrice), {
        triggerPrice: stopPrice, ...extra,
        ...(marketType === 'perp' ? { triggerDirection: side === 'buy' ? 'ascending' : 'descending' } : { orderFilter: 'tpslOrder' }),
      });
    }
    case 'bitget': {
      const execType = limitPrice ? 'limit' : 'market';
      return ex.createOrder(symbol, execType, side, amount, limitPrice ?? stopPrice, { triggerPrice: stopPrice, triggerType: 'fill_price', ...extra });
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
      return ex.createOrder(symbol, 'stop', side, amount, orderPrice(limitPrice), {
        takeProfitPrice: tpPrice, ...extra, ...(marketType === 'spot' ? { tdMode: 'cash' } : {}),
        ...(extra.clientOrderId ? { algoClOrdId: extra.clientOrderId, clientOrderId: undefined, clOrdId: undefined } : {}),
      });

    case 'bybit': {
      const execType = limitPrice ? 'limit' : 'market';
      return ex.createOrder(symbol, execType, side, amount, orderPrice(limitPrice), {
        triggerPrice: tpPrice, ...extra,
        ...(marketType === 'perp' ? { triggerDirection: side === 'buy' ? 'descending' : 'ascending' } : { orderFilter: 'tpslOrder' }),
      });
    }
    case 'bitget': {
      const execType = limitPrice ? 'limit' : 'market';
      return ex.createOrder(symbol, execType, side, amount, limitPrice ?? tpPrice, { triggerPrice: tpPrice, triggerType: 'fill_price', ...extra });
    }
    case 'hyperliquid':
      if (limitPrice) return ex.createOrder(symbol, 'limit', side, amount, limitPrice, { takeProfitPrice: tpPrice, ...extra });
      return ex.createOrder(symbol, 'market', side, amount, tpPrice, { takeProfitPrice: tpPrice, ...extra });

    default:
      throw new Error(`交易所 ${exchangeId} 不支持止盈单`);
  }
}

// ─── 撤单 ─────────────────────────────────────────────────────────────────────
async function doCancelOrder(ex, exchangeId, { symbol, orderId, isAlgo, cancelKind, planType, marketType }) {
  if (!orderId || !symbol) throw new Error('撤单需要 orderId 和交易对');
  await loadExchangeMarkets(ex, !ex.markets?.[symbol]);
  const params = {};
  if (exchangeId === 'bybit' && marketType !== 'perp') {
    if (cancelKind === 'tpsl') params.orderFilter = 'tpslOrder';
    else if (isAlgo) params.orderFilter = 'StopOrder';
  } else if (isAlgo && ['binance', 'okx', 'bitget'].includes(exchangeId)) {
    params.trigger = true;
    if (exchangeId === 'bitget') {
      if (planType && !['normal_plan', 'profit_plan', 'loss_plan', 'pos_profit', 'pos_loss', 'moving_plan'].includes(planType)) {
        throw new Error('不支持的计划单类型，请在交易所核对并撤单');
      }
      if (!planType && cancelKind === 'tpsl') throw new Error('无法确认止盈止损计划单类型，请刷新订单后重试');
      params.planType = planType || 'normal_plan';
    }
  }
  const market = ex.market(symbol);
  if (exchangeId === 'bitget' && market.swap && isAlgo) {
    const [productType] = ex.handleProductTypeAndParams(market, {});
    const response = await ex.privateMixPostV2MixOrderCancelPlanOrder({
      symbol: market.id, productType, marginCoin: market.settleId,
      orderIdList: [{ orderId: String(orderId) }], planType: params.planType,
    });
    // CCXT 单笔撤单会丢掉 failureList，必须在解析前核对目标订单的业务结果。
    const data = response?.data;
    const failed = Array.isArray(data?.failureList)
      ? data.failureList.find(order => String(order.orderId) === String(orderId)) : null;
    if (failed) throw new Error(`撤单失败：${failed.errorMsg || failed.errorCode || '交易所拒绝撤单'}`);
    const success = Array.isArray(data?.successList)
      ? data.successList.find(order => String(order.orderId) === String(orderId)) : null;
    if (response?.code !== '00000' || !success) throw new Error('撤单结果未确认，请刷新挂单并在交易所核对');
    return { ...ex.parseOrder(success, market), status: 'canceled' };
  }
  return ex.cancelOrder(orderId, symbol, params);
}

// 保留查询来源作为撤单路由，不把普通父订单的预设止盈止损误当成独立条件单。
function orderSources(exchangeId, market) {
  const sources = [{ kind: 'regular', params: {} }];
  if (exchangeId === 'binance' && market.swap && market.linear) {
    sources.push({ kind: 'trigger', params: { trigger: true } });
  } else if (exchangeId === 'okx') {
    sources.push(
      { kind: 'conditional', params: { trigger: true, ordType: 'conditional' } },
      { kind: 'trigger', params: { trigger: true, ordType: 'trigger' } },
      { kind: 'oco', params: { trigger: true, ordType: 'oco' } },
    );
  } else if (exchangeId === 'bybit' && market.spot) {
    sources[0].params.orderFilter = 'Order';
    sources.push(
      { kind: 'trigger', params: { orderFilter: 'StopOrder' } },
      { kind: 'tpsl', params: { orderFilter: 'tpslOrder' } },
    );
  } else if (exchangeId === 'bitget') {
    sources.push({ kind: 'trigger', params: market.spot ? { trigger: true } : { trigger: true, planType: 'normal_plan' } });
    if (market.swap) sources.push({ kind: 'tpsl', params: { trigger: true, planType: 'profit_loss' } });
  }
  return sources;
}

// ─── 挂单查询 ─────────────────────────────────────────────────────────────────
async function doGetOpenOrders(ex, exchangeId, { symbol }) {
  await loadExchangeMarkets(ex, !ex.markets?.[symbol]);
  let truncated = false;
  const lists = await Promise.all(orderSources(exchangeId, ex.market(symbol)).map(async source => {
    try {
      const market = ex.market(symbol);
      let orders;
      if (exchangeId === 'bybit') {
        const pageSize = 50;
        orders = await ex.fetchOpenOrders(symbol, undefined, undefined, {
          ...source.params, paginate: true, paginationCalls: 10, maxEntriesPerRequest: pageSize,
        });
        if (orders.length >= pageSize * 10) truncated = true;
      } else if (exchangeId === 'okx' || (exchangeId === 'bitget' && market.swap)) {
        orders = [];
        let after;
        for (let page = 0; page < 10; page++) {
          const cursor = exchangeId === 'okx' ? 'after' : 'idLessThan';
          const batch = await ex.fetchOpenOrders(symbol, undefined, 100, { ...source.params, ...(after ? { [cursor]: after } : {}) });
          orders.push(...batch);
          if (batch.length < 100) break;
          const ids = batch.map(o => o.id).filter(id => /^\d+$/.test(id || ''));
          if (ids.length !== batch.length) { truncated = true; break; }
          const next = ids.reduce((oldest, id) => BigInt(id) < BigInt(oldest) ? id : oldest, ids[0]);
          if (!next || next === after || page === 9) { truncated = true; break; }
          after = next;
        }
      } else {
        orders = await ex.fetchOpenOrders(symbol, undefined, exchangeId === 'bitget' ? 100 : undefined, source.params);
        if (exchangeId === 'bitget' && orders.length >= 100) truncated = true;
      }
      return normalizeOrders(orders, ex, source.kind);
    } catch (e) {
      throw new Error(`${EX_LABEL[exchangeId]} ${source.kind} 订单查询失败：${e.message}`);
    }
  }));
  const orders = mergeOrders(...lists).sort((a, b) => (b.time || 0) - (a.time || 0));
  return truncated ? { orders, warning: '挂单较多，当前列表可能未完整读取；请到交易所核对其余挂单。' } : orders;
}

// ─── 历史订单 ─────────────────────────────────────────────────────────────────
async function doGetOrderHistory(ex, exchangeId, { symbol, limit = 50 }) {
  await loadExchangeMarkets(ex, !ex.markets?.[symbol]);
  limit = Math.min(100, Math.max(1, Number(limit) || 50));
  const lists = await Promise.all(orderSources(exchangeId, ex.market(symbol)).map(async source => {
    try {
      const orders = exchangeId === 'okx'
        ? (await Promise.all([
            ex.fetchClosedOrders(symbol, undefined, limit, source.params),
            ex.fetchCanceledOrders(symbol, undefined, limit, source.params),
          ])).flat()
        : await ex.fetchCanceledAndClosedOrders(symbol, undefined, limit, source.params);
      return normalizeOrders(orders, ex, source.kind);
    } catch (e) {
      throw new Error(`${EX_LABEL[exchangeId]} ${source.kind} 历史查询失败：${e.message}`);
    }
  }));
  return mergeOrders(...lists).sort((a, b) => (b.time || 0) - (a.time || 0)).slice(0, limit);
}

// ─── 余额查询 ─────────────────────────────────────────────────────────────────
async function doGetBalance(ex, exchangeId, { symbol, marketType } = {}) {
  await loadExchangeMarkets(ex);
  const params = {};
  if (marketType === 'perp' && symbol) {
    await loadExchangeMarkets(ex, !ex.markets?.[symbol]);
    const market = ex.market(symbol);
    if (exchangeId === 'bitget') params.productType = `${market.settleId}-FUTURES`;
    if (exchangeId === 'binance') params.subType = market.linear ? 'linear' : 'inverse';
  }
  const balance = await ex.fetchBalance(params);
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
async function doGetPositions(ex, { symbol } = {}) {
  if (!symbol) throw new Error('持仓查询需要选择交易对');
  await loadExchangeMarkets(ex, !ex.markets?.[symbol]);
  const market = ex.market(symbol);
  if (!market.swap) throw new Error('请选择合约交易对');
  const params = {};
  if (ex.id === 'binance') params.subType = market.linear ? 'linear' : 'inverse';
  const positions = await ex.fetchPositions([symbol], params);
  return positions
    .filter(p => p.contracts && Math.abs(parseFloat(p.contracts)) > 0)
    .map(p => ({
      symbol:           p.symbol,
      side:             p.side,
      contracts:        String(p.contracts),
      amount:           market.linear ? self.ccxt.Precise.stringMul(String(p.contracts), String(market.contractSize)) : String(p.contracts),
      base:             market.linear ? market.base : 'contracts',
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
  await loadExchangeMarkets(ex, !ex.markets?.[symbol]);
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
  await loadExchangeMarkets(ex);
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
async function doGetMarkets(ex, { marketType, forceReload }) {
  await loadExchangeMarkets(ex, forceReload);
  const type = marketType === 'perp' ? 'swap' : 'spot';
  return Object.values(ex.markets)
    .filter(m => m.type === type && m.active !== false && (type !== 'swap' || supportedSwap(m)))
    .map(m => m.symbol)
    .sort();
}

// ─── 归一化订单格式 ───────────────────────────────────────────────────────────
function mergeOrders(...lists) {
  const seen = new Set();
  const result = [];
  for (const list of lists) {
    for (const order of (list || [])) {
      const key = `${order.id || ''}:${order.symbol || ''}:${order.cancelKind || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(order);
    }
  }
  return result;
}

function normalizeOrders(orders, ex, cancelKind = 'regular') {
  return (orders || []).map(o => {
    const triggerPx = o.triggerPrice ?? o.stopPrice;
    const isAlgo = cancelKind !== 'regular';
    const market = ex?.markets[o.symbol];
    const amount = market?.linear && o.amount != null
      ? self.ccxt.Precise.stringMul(String(o.amount), String(market.contractSize))
      : o.amount;
    return {
      id:              String(o.id),
      symbol:          o.symbol,
      side:            o.side,
      type:            o.type,
      amount:          String(amount ?? ''),
      price:           o.price           ? String(o.price)           : '',
      stopPrice:       triggerPx != null ? String(triggerPx)         : '',
      stopLossPrice:   o.stopLossPrice   ? String(o.stopLossPrice)   : '',
      takeProfitPrice: o.takeProfitPrice ? String(o.takeProfitPrice) : '',
      status:          o.status,
      time:            o.timestamp,
      isAlgo,
      cancelKind,
      planType:        o.info?.planType || '',
      raw:             o,
    };
  });
}
