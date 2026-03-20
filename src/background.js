/**
 * Coinank Trader - Background Service Worker
 * 所有交易所 API 请求均在此处理，避免 CORS 问题
 */
import * as binance from './exchanges/binance.js';
import * as okx     from './exchanges/okx.js';
import * as bybit   from './exchanges/bybit.js';
import * as bitget  from './exchanges/bitget.js';
import * as hyperliquid from './exchanges/hyperliquid.js';

const EXCHANGES = { binance, okx, bybit, bitget, hyperliquid };

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(data => sendResponse({ ok: true, data }))
    .catch(err => sendResponse({ ok: false, error: err.message }));
  return true; // 保持消息通道开放（异步响应）
});

async function handleMessage({ action, exchange, credentials, params }) {
  const ex = EXCHANGES[exchange];
  if (!ex) throw new Error(`未知交易所: ${exchange}`);

  switch (action) {
    case 'placeOrder':      return ex.placeOrder(credentials, params);
    case 'cancelOrder':     return ex.cancelOrder(credentials, params);
    case 'getOpenOrders':   return ex.getOpenOrders(credentials, params);
    case 'getOrderHistory': return ex.getOrderHistory(credentials, params);
    case 'getBalance':      return ex.getBalance(credentials, params);
    default:
      throw new Error(`未知操作: ${action}`);
  }
}
