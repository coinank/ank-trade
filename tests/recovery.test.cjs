const test = require('node:test');
const assert = require('node:assert/strict');
const { background, popup, flush } = require('./helpers.cjs');

test('changed market order parameters require a fresh confirmation', async () => {
  const ui = popup();
  Object.assign(ui.state, { orderType: 'market', amount: '1' });
  await ui.submitOrder();
  ui.state.amount = '2';
  await ui.submitOrder(true);
  assert.equal(ui.sent.filter(m => m.action === 'placeOrder').length, 0);
  await ui.submitOrder(true);
  assert.equal(ui.sent.find(m => m.action === 'placeOrder').params.amount, '2');
});

for (const code of ['ORDER_STATUS_UNKNOWN', 'TRANSPORT_ERROR', undefined]) {
  test(`unknown result (${code || 'missing status'}) persists and blocks retry even after reopening`, async () => {
    const ui = popup((msg, cb) => cb(msg.action === 'placeOrder'
      ? { ok: false, error: 'An unexpected response was received from the message bus. Execution status unknown.', code }
      : { ok: true, data: [] }));
    Object.assign(ui.state, { amount: '1', price: '60000' });
    await ui.submitOrder();
    assert.equal(ui.state.uncertainOrders.length, 1);
    assert.equal(Object.keys(ui.stored).filter(k => k.startsWith('pendingTrade_')).length, 1);
    await ui.submitOrder();
    assert.equal(ui.sent.filter(m => m.action === 'placeOrder').length, 1);
    const reopened = popup(undefined, undefined, ui.stored);
    await reopened.init();
    assert.equal(reopened.state.uncertainOrders.length, 1);
    Object.assign(reopened.state, { amount: '1', price: '60000' });
    await reopened.submitOrder();
    assert.equal(reopened.sent.filter(m => m.action === 'placeOrder').length, 0);
  });
}

test('definite order rejection removes its pending record and allows correction', async () => {
  const ui = popup((msg, cb) => cb(msg.action === 'placeOrder'
    ? { ok: false, error: 'Insufficient funds', code: 'ORDER_REJECTED' }
    : { ok: true, data: [] }));
  Object.assign(ui.state, { amount: '1', price: '60000' });
  await ui.submitOrder();
  assert.equal(ui.state.uncertainOrders.length, 0);
  assert.equal(Object.keys(ui.stored).length, 0);
});

test('another open window observes persistent pending orders', async () => {
  const ui = popup();
  await ui.init();
  const id = 'a'.repeat(32);
  ui.stored[`pendingTrade_${id}`] = { exchange: 'binance', params: { requestId: id, symbol: 'BTC/USDT' } };
  await ui.changes[0]({ [`pendingTrade_${id}`]: { newValue: ui.stored[`pendingTrade_${id}`] } });
  assert.equal(ui.state.uncertainOrders.length, 1);
  Object.assign(ui.state, { amount: '1', price: '60000' });
  await ui.submitOrder();
  assert.equal(ui.sent.filter(m => m.action === 'placeOrder').length, 0);
});

test('a late position error cannot hide a successfully loaded history tab', async () => {
  const pending = [];
  const ui = popup((msg, cb) => pending.push({ msg, cb }));
  ui.state.ordersTab = 'positions';
  const positions = ui.loadPositions(); await flush();
  ui.state.ordersTab = 'history';
  const history = ui.loadOrders(); await flush();
  pending[1].cb({ ok: true, data: [{ id: 'history' }] }); await history;
  pending[0].cb({ ok: false, error: 'positions API unavailable' }); await positions;
  assert.equal(ui.state.orders[0].id, 'history');
  assert.equal(ui.state.ordersError, null);
});

test('editing a new context while an old order is pending preserves the new draft', async () => {
  let finish;
  const ui = popup((msg, cb) => msg.action === 'placeOrder' ? finish = cb : cb({ ok: true, data: [] }));
  Object.assign(ui.state, { amount: '1', price: '60000' });
  const pending = ui.submitOrder(); await flush();
  Object.assign(ui.state, { symbol: 'ETH/USDT', amount: '2', price: '3000' });
  finish({ ok: true, data: { id: '1' } }); await pending;
  assert.equal(ui.state.amount, '2');
});

test('public requests never read or forward exchange credentials', async () => {
  const ui = popup(undefined, () => { throw new Error('must not read credentials'); });
  await ui.sendMsg('getTicker', { symbol: 'BTC/USDT' });
  assert.equal(ui.sent[0].credentials, null);
});

test('exchange error text is escaped in the sidepanel', () => {
  const ui = popup();
  ui.state.toast = { type: 'error', msg: '<img src=x onerror="steal()">' };
  ui.render();
  assert.ok(ui.app.innerHTML.includes('&lt;img'));
  assert.ok(!ui.app.innerHTML.includes('<img'));
});

test('write-boundary classification distinguishes rejection from unknown server outcomes', async () => {
  const run = background();
  const codes = await run(`
    const results=[];
    for (const error of [new ccxt.InvalidOrder('rejected'),new ccxt.ExchangeNotAvailable('HTTP 503'),new ccxt.ExchangeError('Execution status unknown')]) {
      try { await submitExchangeOrder(async()=>{throw error;}); } catch(e) {results.push(e.code);}
    }
    return results;
  `);
  assert.deepEqual(Array.from(codes), ['ORDER_REJECTED','ORDER_STATUS_UNKNOWN','ORDER_STATUS_UNKNOWN']);
});

test('backend also blocks a new request while another window has an unresolved order', async () => {
  const run = background();
  await assert.rejects(run(`
    await chrome.storage.local.set({'pendingTrade_old':{exchange:'binance',params:{requestId:'a'.repeat(32)}}});
    return placeOrderOnce(fixtureExchange('binance'),'binance',{apiKey:'test'},
      {requestId:'b'.repeat(32),symbol:'BTC/USDT:USDT',marketType:'perp',side:'buy',orderType:'limit',amount:'1',price:'60000'});
  `), /未确认/);
});

test('backend deduplicates the same request and refuses acknowledgment during submission', async () => {
  const run = background();
  const result = await run(`
    const ex=fixtureExchange('binance');let calls=0,finish;
    ex.createLimitOrder=async()=>{calls++;return new Promise(resolve=>{finish=resolve;});};
    const params={requestId:'c'.repeat(32),symbol:'BTC/USDT:USDT',marketType:'perp',side:'buy',orderType:'limit',amount:'1',price:'60000'};
    await chrome.storage.local.set({['pendingTrade_'+params.requestId]:{exchange:'binance',params,phase:'queued'}});
    const first=placeOrderOnce(ex,'binance',{apiKey:'test'},params);
    for(let i=0;i<20;i++) await Promise.resolve();
    const second=placeOrderOnce(ex,'binance',{apiKey:'test'},params);
    let rejected=false;
    try {await handleMessage({action:'acknowledgeOrder',exchange:'binance',params:{requestId:params.requestId}});} catch(e){rejected=/仍在提交/.test(e.message);}
    finish({id:'123'});await Promise.all([first,second]);return {calls,rejected};
  `);
  assert.equal(result.calls, 1);
  assert.equal(result.rejected, true);
});

test('acknowledgment holding a storage read prevents a new submission from entering', async () => {
  const run = background();
  const result = await run(`
    const id='d'.repeat(32), key='pendingTrade_'+id;
    const params={requestId:id,symbol:'BTC/USDT:USDT',marketType:'perp',side:'buy',orderType:'limit',amount:'1',price:'60000'};
    const record={exchange:'binance',params,phase:'queued'};
    await chrome.storage.local.set({[key]:record});
    const get=chrome.storage.local.get.bind(chrome.storage.local);let resume;
    chrome.storage.local.get=async name=>name===key?new Promise(resolve=>{resume=()=>resolve({[key]:record});}):get(name);
    const ack=handleMessage({action:'acknowledgeOrder',exchange:'binance',params:{requestId:id}});
    const ex=fixtureExchange('binance');let calls=0,finish;
    ex.createLimitOrder=async()=>{calls++;return new Promise(resolve=>{finish=resolve;});};
    const placing=placeOrderOnce(ex,'binance',{apiKey:'test'},params).then(()=>false,()=>true);
    for(let i=0;i<40;i++)await Promise.resolve();
    const callsBeforeAcknowledgment=calls;
    resume();await ack;
    if(finish)finish({id:'123'});
    return {callsBeforeAcknowledgment,rejected:await placing};
  `);
  assert.equal(result.callsBeforeAcknowledgment, 0);
  assert.equal(result.rejected, true);
});

test('an acknowledged queued intent cannot be submitted later without its protective record', async () => {
  const run = background();
  const result = await run(`
    const params={requestId:'e'.repeat(32),symbol:'BTC/USDT:USDT',marketType:'perp',side:'buy',orderType:'limit',amount:'1',price:'60000'};
    await chrome.storage.local.set({['pendingTrade_'+params.requestId]:{exchange:'binance',params,phase:'queued'}});
    await handleMessage({action:'acknowledgeOrder',exchange:'binance',params:{requestId:params.requestId}});
    const ex=fixtureExchange('binance');let calls=0;
    ex.createLimitOrder=async()=>{calls++;return {id:'must-not-place'};};
    let rejected=false;
    try{await placeOrderOnce(ex,'binance',{apiKey:'test'},params);}catch(e){rejected=true;}
    return {calls,rejected};
  `);
  assert.equal(result.calls, 0);
  assert.equal(result.rejected, true);
});

test('simultaneous queued intents place exactly one order instead of rejecting both', async () => {
  const run = background();
  const result = await run(`
    const params=id=>({requestId:id.repeat(32),symbol:'BTC/USDT:USDT',marketType:'perp',side:'buy',orderType:'limit',amount:'1',price:'60000'});
    for(const id of ['f','a'])await chrome.storage.local.set({['pendingTrade_'+params(id).requestId]:{exchange:'binance',params:params(id),phase:'queued'}});
    const ex=fixtureExchange('binance');let calls=0;
    ex.createLimitOrder=async()=>{calls++;return {id:'123'};};
    const results=await Promise.allSettled(['f','a'].map(id=>placeOrderOnce(ex,'binance',{apiKey:'test'},params(id))));
    return {calls,successes:results.filter(r=>r.status==='fulfilled').length};
  `);
  assert.equal(result.calls, 1);
  assert.equal(result.successes, 1);
});

test('backend persists an unknown outcome and blocks another order after a worker restart', async () => {
  const run = background();
  const persisted = await run(`
    const params={requestId:'b'.repeat(32),symbol:'BTC/USDT:USDT',marketType:'perp',side:'buy',orderType:'limit',amount:'1',price:'60000'};
    await chrome.storage.local.set({['pendingTrade_'+params.requestId]:{exchange:'binance',params,phase:'queued'}});
    const ex=fixtureExchange('binance');
    ex.createLimitOrder=async()=>{throw new ccxt.RequestTimeout('response timed out');};
    try{await placeOrderOnce(ex,'binance',{apiKey:'test'},params);}catch(e){if(e.code!=='ORDER_STATUS_UNKNOWN')throw e;}
    return chrome.storage.local.get(null);
  `);
  assert.equal(persisted['pendingTrade_' + 'b'.repeat(32)].phase, 'unknown');
  const restarted = background(persisted);
  await assert.rejects(restarted(`
    const params={requestId:'c'.repeat(32),symbol:'BTC/USDT:USDT',marketType:'perp',side:'buy',orderType:'limit',amount:'1',price:'60000'};
    await chrome.storage.local.set({['pendingTrade_'+params.requestId]:{exchange:'binance',params,phase:'queued'}});
    return placeOrderOnce(fixtureExchange('binance'),'binance',{apiKey:'test'},params);
  `), /未确认/);
});

test('acknowledging several orders from one exchange sends requests sequentially', async () => {
  const initial = {};
  for (const id of ['d', 'e']) initial['pendingTrade_' + id.repeat(32)] = {
    exchange: 'binance', params: { requestId: id.repeat(32), symbol: 'BTC/USDT' }, phase: 'unknown',
  };
  let active = 0, maxActive = 0, acknowledged = 0, ui;
  ui = popup((msg, cb) => {
    if (msg.action !== 'acknowledgeOrder') return cb({ ok: true, data: [] });
    active++; maxActive = Math.max(maxActive, active);
    if (active > 1) { active--; cb({ ok: false, error: 'busy', code: 'REQUEST_REJECTED' }); return; }
    Promise.resolve().then(() => {
      delete ui.stored['pendingTrade_' + msg.params.requestId];
      active--; acknowledged++; cb({ ok: true, data: true });
    });
  }, undefined, initial);
  await ui.init();
  await ui.buttons.get('#ackUnknownOrder').listeners.click();
  assert.equal(maxActive, 1);
  assert.equal(acknowledged, 2);
  assert.equal(ui.state.uncertainOrders.length, 0);
});

test('acknowledgment does not hide an unresolved order arriving from another window', async () => {
  const oldId = 'f'.repeat(32), newId = 'a'.repeat(32);
  const initial = { ['pendingTrade_' + oldId]: { exchange: 'binance', params: { requestId: oldId, symbol: 'BTC/USDT' }, phase: 'unknown' } };
  let ui;
  ui = popup((msg, cb) => {
    if (msg.action === 'acknowledgeOrder') {
      delete ui.stored['pendingTrade_' + oldId];
      ui.stored['pendingTrade_' + newId] = { exchange: 'okx', params: { requestId: newId, symbol: 'BTC/USDT' }, phase: 'unknown' };
    }
    cb({ ok: true, data: [] });
  }, undefined, initial);
  await ui.init();
  await ui.buttons.get('#ackUnknownOrder').listeners.click();
  assert.equal(ui.state.uncertainOrders.length, 1);
  assert.equal(ui.state.uncertainOrders[0].params.requestId, newId);
});

for (const outcome of ['confirmed', 'rejected']) {
  test(`backend finalizes a ${outcome} order without depending on its UI staying open`, async () => {
    const run = background();
    const result = await run(`
      const params={requestId:'b'.repeat(32),symbol:'BTC/USDT:USDT',marketType:'perp',side:'buy',orderType:'limit',amount:'1',price:'60000'};
      const key='pendingTrade_'+params.requestId;
      await chrome.storage.local.set({[key]:{exchange:'binance',params,phase:'queued'}});
      const ex=fixtureExchange('binance');let phase,code;
      ex.createLimitOrder=async()=>{
        phase=(await chrome.storage.local.get(key))[key].phase;
        ${outcome === 'rejected' ? "throw new ccxt.InsufficientFunds('insufficient funds');" : "return {id:'123'};"}
      };
      try{await placeOrderOnce(ex,'binance',{apiKey:'test'},params);}catch(e){code=e.code;}
      return {phase,code,recordPresent:Boolean((await chrome.storage.local.get(key))[key])};
    `);
    assert.equal(result.phase, 'submitting');
    assert.equal(result.recordPresent, false);
    if (outcome === 'rejected') assert.equal(result.code, 'ORDER_REJECTED');
  });
}

test('failure to clean up an accepted order retains protection and is never a definite rejection', async () => {
  const run = background();
  const result = await run(`
    const params={requestId:'c'.repeat(32),symbol:'BTC/USDT:USDT',marketType:'perp',side:'buy',orderType:'limit',amount:'1',price:'60000'};
    const key='pendingTrade_'+params.requestId;
    await chrome.storage.local.set({[key]:{exchange:'binance',params,phase:'queued'}});
    const ex=fixtureExchange('binance');ex.createLimitOrder=async()=>({id:'123'});
    chrome.storage.local.remove=async()=>{throw new Error('storage unavailable');};
    let code;try{await placeOrderOnce(ex,'binance',{apiKey:'test'},params);}catch(e){code=e.code;}
    return {code,phase:(await chrome.storage.local.get(key))[key].phase};
  `);
  assert.equal(result.code, 'ORDER_STATUS_UNKNOWN');
  assert.equal(result.phase, 'submitting');
});
