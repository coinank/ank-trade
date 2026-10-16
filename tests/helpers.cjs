const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const root = path.resolve(__dirname, '..');

function background(initial = {}) {
  const stored = { ...initial };
  const ctx = vm.createContext({
    console, URL, URLSearchParams, TextEncoder, TextDecoder, Uint8Array, Uint16Array,
    Uint32Array, Int32Array, ArrayBuffer, DataView, atob, btoa, AbortController,
    DOMException, setTimeout: (fn, ms, ...args) => ms >= 60000 ? 0 : setTimeout(fn, ms, ...args), clearTimeout, crypto: webcrypto,
    fetch: async () => { throw new Error('Tests must never send network requests'); },
    importScripts() {},
    chrome: {
      alarms: { create() {}, onAlarm: { addListener() {} } },
      sidePanel: { setPanelBehavior: async () => {} },
      runtime: { onMessage: { addListener() {} } },
      storage: { local: {
        async get(key) { return key == null ? { ...stored } : { [key]: stored[key] }; },
        async set(values) { Object.assign(stored, values); },
        async remove(key) { delete stored[key]; },
      } },
    },
  });
  ctx.self = ctx;
  vm.runInContext('this.WorkerGlobalScope = class {}; Object.setPrototypeOf(globalThis, WorkerGlobalScope.prototype);', ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'node_modules/ccxt/dist/ccxt.browser.min.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'src/background.js'), 'utf8'), ctx);
  vm.runInContext(`
    function fixtureMarket(type = 'swap', contractSize = 1, precision = .001) {
      return {
        id: 'BTCUSDT', symbol: type === 'spot' ? 'BTC/USDT' : 'BTC/USDT:USDT',
        base: 'BTC', baseId: '0', quote: 'USDT', quoteId: 'USDT',
        settle: type === 'spot' ? undefined : 'USDT', settleId: 'USDT',
        type, spot: type === 'spot', swap: type === 'swap', future: false,
        contract: type !== 'spot', linear: type !== 'spot', inverse: false,
        active: true, contractSize, precision: { amount: precision, price: .1 },
        info: { orderTypes: ['LIMIT','MARKET','STOP_MARKET','STOP','TAKE_PROFIT_MARKET','TAKE_PROFIT'] },
        limits: { amount: { min: precision }, price: {}, cost: {} },
      };
    }
    function fixtureExchange(id, type = 'swap', contractSize = 1, precision = .001) {
      const ex = new ccxt[id]({ enableRateLimit: false, options: { defaultType: type } });
      ex.setMarkets([fixtureMarket(type, contractSize, precision)]);
      ex.loadMarkets = async () => ex.markets;
      ex.fetch = async () => { throw new Error('Network forbidden'); };
      ex.fetchPositionMode = async () => ({ hedged: false });
      ex.fetchPositions = async () => [{ symbol: 'BTC/USDT:USDT', contracts: 0, hedged: false, marginMode: 'cross', info: { positionIdx: 0 } }];
      ex.privateMixGetV2MixAccountAccount = async () => ({ data: { posMode: 'one_way_mode', marginMode: 'crossed' } });
      return ex;
    }
  `, ctx);
  return code => vm.runInContext(`(async () => { ${code} })()`, ctx);
}

function popup(handler = (_msg, cb) => cb({ ok: true, data: [] }), storageGet, initial = {}) {
  const sent = [], buttons = new Map(), app = { innerHTML: '' };
  const stored = { ...initial }, changes = [];
  const document = {
    addEventListener() {},
    getElementById(id) { return id === 'app' ? app : null; },
    querySelectorAll() { return []; },
    querySelector(selector) {
      if (!buttons.has(selector)) buttons.set(selector, {
        listeners: {}, addEventListener(type, cb) { this.listeners[type] = cb; },
      });
      return buttons.get(selector);
    },
  };
  const ctx = vm.createContext({ document, console, crypto: webcrypto,
    confirm: () => true,
    setTimeout() {}, setInterval() {}, clearInterval() {},
    t: key => String(key), initLang: async () => {}, langLabel: () => 'EN', cycleLang: async () => {},
    chrome: { storage: { onChanged: { addListener(cb) { changes.push(cb); } }, local: {
      get: storageGet || (async key => {
        if (key == null) return { ...stored };
        if (Array.isArray(key)) return Object.fromEntries(key.map(name => [name, stored[name]]));
        return { [key]: key.startsWith('credentials_') ? { apiKey: 'test', secret: 'test' } : stored[key] };
      }),
      async set(values) { Object.assign(stored, values); },
      async remove(key) { delete stored[key]; },
    } }, runtime: { sendMessage(msg, cb) { sent.push(msg); handler(msg, cb); } } },
  });
  const src = fs.readFileSync(path.join(root, 'src/popup.js'), 'utf8').replace(/^import[^\n]*\n/, '');
  vm.runInContext(src + '\nthis.audit = { state, init, render, bind, submitOrder, loadOrders, loadPositions, silentLoadTicker, silentLoadBalance, calcPctAmount, getAvail, sendMsg };', ctx);
  return { ...ctx.audit, sent, buttons, app, stored, changes };
}

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

module.exports = { background, popup, flush, root };
