/**
 * Coinank Trader - Background Service Worker
 * 所有交易所 API 请求均在此处理，避免 CORS 问题
 */
import * as binance     from './exchanges/binance.js';
import * as okx         from './exchanges/okx.js';
import * as bybit       from './exchanges/bybit.js';
import * as bitget      from './exchanges/bitget.js';
import * as hyperliquid from './exchanges/hyperliquid.js';

const EXCHANGES = { binance, okx, bybit, bitget, hyperliquid };

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(data => sendResponse({ ok: true, data }))
    .catch(err => sendResponse({ ok: false, error: err.message }));
  return true; // 保持消息通道开放（异步响应）
});

async function handleMessage({ action, exchange, credentials, params }) {
  // 基础参数校验
  if (!exchange) throw new Error('未指定交易所');
  if (!action)   throw new Error('未指定操作类型');

  const ex = EXCHANGES[exchange];
  if (!ex) throw new Error(`不支持的交易所: ${exchange}`);

  // 凭证校验（Hyperliquid 的 apiKey 是钱包地址，secret 是私钥）
  if (!credentials?.apiKey || !credentials?.secret) {
    throw new Error(`请先在设置页面填写 ${exchange} 的 API Key 和 Secret`);
  }

  // 下单时额外校验 params
  if (action === 'placeOrder') {
    const { symbol, side, orderType, amount } = params || {};
    if (!symbol)    throw new Error('交易对不能为空');
    if (!side)      throw new Error('交易方向不能为空');
    if (!orderType) throw new Error('订单类型不能为空');
    if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
      throw new Error('请输入有效的交易数量（必须大于 0）');
    }
    if ((orderType === 'limit' || orderType === 'stop') && (!params.price || isNaN(Number(params.price)))) {
      if (orderType === 'limit') throw new Error('限价单请填写价格');
    }
    if (orderType === 'stop' && (!params.stopPrice || isNaN(Number(params.stopPrice)))) {
      throw new Error('止损单请填写触发价格');
    }
  }

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
