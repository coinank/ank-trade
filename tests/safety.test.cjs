const test = require('node:test');
const assert = require('node:assert/strict');
const { background, popup, flush } = require('./helpers.cjs');

test('ordinary market button click requires confirmation before sending', async () => {
  const ui = popup();
  Object.assign(ui.state, { orderType: 'market', amount: '1' });
  ui.bind();
  await ui.buttons.get('#submitBtn').listeners.click({ type: 'click' });
  assert.equal(ui.sent.filter(m => m.action === 'placeOrder').length, 0);
  assert.equal(ui.state.confirmPending, true);
  await ui.submitOrder(true);
  assert.equal(ui.sent.filter(m => m.action === 'placeOrder').length, 1);
});

test('orders query cannot unlock an in-flight order', async () => {
  const pending = [];
  const ui = popup((msg, cb) => msg.action === 'placeOrder' ? pending.push(cb) : cb({ ok: true, data: [] }));
  Object.assign(ui.state, { amount: '1', price: '100' });
  const first = ui.submitOrder();
  await flush();
  await ui.loadOrders();
  const second = ui.submitOrder();
  await flush();
  const count = pending.length;
  pending.forEach(cb => cb({ ok: true, data: { id: '1' } }));
  await Promise.all([first, second]);
  assert.equal(count, 1);
});

test('late ticker and balance responses cannot overwrite another market', async () => {
  const pending = [];
  const ui = popup((msg, cb) => pending.push({ msg, cb }));
  const old = ui.silentLoadTicker(); await flush();
  ui.state.symbol = 'ETH/USDT';
  const latest = ui.silentLoadTicker(); await flush();
  pending[1].cb({ ok: true, data: { last: 3000 } }); await latest;
  pending[0].cb({ ok: true, data: { last: 60000 } }); await old;
  assert.equal(ui.state.ticker.last, 3000);
  const balance = ui.silentLoadBalance(); await flush();
  ui.state.exchange = 'okx'; ui.state.balance = null;
  pending[2].cb({ ok: true, data: [{ asset: 'USDT', free: '1000' }] }); await balance;
  assert.equal(ui.state.balance, null);
});

test('message snapshots the exchange before awaiting credentials', async () => {
  let finish;
  const ui = popup(undefined, key => new Promise(resolve => { finish = () => resolve({ [key]: { apiKey: 'binance-key', secret: 'test' } }); }));
  const request = ui.sendMsg('getBalance', { symbol: 'BTC/USDT' });
  ui.state.exchange = 'okx'; finish(); await request;
  assert.equal(ui.sent[0].exchange, 'binance');
});

test('percentage amount uses market price and unrounded available funds', () => {
  const ui = popup();
  Object.assign(ui.state, { orderType: 'market', side: 'buy', price: '20000', ticker: { last: 100000 }, balance: [{ asset: 'USDT', free: '100' }] });
  assert.ok(Number(ui.calcPctAmount(100)) <= .001);
  Object.assign(ui.state, { side: 'sell', balance: [{ asset: 'BTC', free: '.00006' }] });
  assert.equal(Number(ui.calcPctAmount(100)), .00006);
});

test('changing only passphrase replaces the signed exchange', async () => {
  const run = background();
  assert.equal(await run(`
    const one = makeExchange('okx', {apiKey:'test',secret:'test',passphrase:'wrong'}, 'spot');
    const two = makeExchange('okx', {apiKey:'test',secret:'test',passphrase:'correct'}, 'spot');
    return one !== two && two.password === 'correct';
  `), true);
});

test('base coin quantity converts to OKX contract count', async () => {
  const run = background();
  assert.equal(await run(`
    const ex = fixtureExchange('okx', 'swap', .01, .01);
    ex.createLimitOrder = async (s, side, amount) => amount;
    return doPlaceOrder(ex, 'okx', {symbol:'BTC/USDT:USDT',marketType:'perp',side:'buy',orderType:'limit',amount:'1',price:'60000'});
  `), 100);
});

test('Hyperliquid dust is rejected before leverage or createOrder', async () => {
  const run = background();
  await assert.rejects(run(`
    const ex = fixtureExchange('hyperliquid');
    ex.setLeverage = async () => { throw new Error('LEVERAGE MUST NOT RUN'); };
    ex.fetchTicker = async () => ({last:60000});
    ex.createMarketOrder = async () => 'UNSAFE';
    return doPlaceOrder(ex, 'hyperliquid', {symbol:'BTC/USDT:USDT',marketType:'perp',side:'sell',orderType:'market',amount:'.00001',reduceOnly:true,leverage:10});
  `), /精度|最小|数量/);
});

test('Bybit unchanged leverage still places the requested order', async () => {
  const run = background();
  assert.equal(await run(`
    const ex = fixtureExchange('bybit');
    ex.setLeverage = async () => { throw new Error('bybit {"retCode":110043,"retMsg":"leverage not modified"}'); };
    ex.createLimitOrder = async () => 'PLACED';
    return doPlaceOrder(ex, 'bybit', {symbol:'BTC/USDT:USDT',marketType:'perp',side:'buy',orderType:'limit',amount:'1',price:'60000',leverage:10});
  `), 'PLACED');
});

test('Bybit spot factory requests spot tickers', async () => {
  const run = background();
  assert.equal(await run(`
    const ex = makePublicExchange('bybit', 'spot');
    ex.setMarkets([fixtureMarket('spot'),fixtureMarket()]); ex.loadMarkets = async () => ex.markets;
    let category; ex.publicGetV5MarketTickers = async p => {category=p.category;return {result:{list:[]}};};
    await doGetMarketTickers(ex, {marketType:'spot'}); return category;
  `), 'spot');
});
