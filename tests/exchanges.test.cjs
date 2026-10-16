const test = require('node:test');
const assert = require('node:assert/strict');
const { background } = require('./helpers.cjs');

test('Binance conditional orders use algo create, list, history and cancellation endpoints', async () => {
  const run = background();
  const result = await run(`
    const ex = fixtureExchange('binance'), paths = [];
    for (const method of ['fapiPrivatePostAlgoOrder','fapiPrivateGetOpenOrders','fapiPrivateGetOpenAlgoOrders','fapiPrivateGetAllOrders','fapiPrivateGetAllAlgoOrders','fapiPrivateDeleteAlgoOrder']) {
      ex[method] = async request => { paths.push({method,request}); return method.includes('Get') ? [] : {algoId:'123'}; };
    }
    await doPlaceOrder(ex, 'binance', {symbol:'BTC/USDT:USDT',marketType:'perp',side:'sell',orderType:'stop',amount:'.01',stopPrice:'58000'});
    await doGetOpenOrders(ex, 'binance', {symbol:'BTC/USDT:USDT'});
    await doGetOrderHistory(ex, 'binance', {symbol:'BTC/USDT:USDT'});
    await doCancelOrder(ex, 'binance', {symbol:'BTC/USDT:USDT',orderId:'123',isAlgo:true,marketType:'perp'});
    return paths.map(p => p.method);
  `);
  for (const method of ['fapiPrivatePostAlgoOrder','fapiPrivateGetOpenAlgoOrders','fapiPrivateGetAllAlgoOrders','fapiPrivateDeleteAlgoOrder']) {
    assert.ok(result.includes(method), method);
  }
});

test('Bybit spot TP/SL preserves tpslOrder classification through list and cancel', async () => {
  const run = background();
  const result = await run(`
    const ex = fixtureExchange('bybit', 'spot');
    ex.fetchOpenOrders = async (s, since, limit, p) => p.orderFilter === 'tpslOrder' ? [{id:'123',symbol:s,type:'market',triggerPrice:58000}] : [];
    const [order] = await doGetOpenOrders(ex, 'bybit', {symbol:'BTC/USDT'});
    let request;
    ex.privatePostV5OrderCancel = async p => { request=p; return {result:{orderId:'123'}}; };
    await doCancelOrder(ex, 'bybit', {...order,orderId:order.id,marketType:'spot'});
    return request;
  `);
  assert.equal(result.orderFilter, 'tpslOrder');
});

test('Bitget includes profit_loss queries and does not hide API failures', async () => {
  const run = background();
  const types = await run(`
    const ex = fixtureExchange('bitget'), types=[];
    ex.privateMixGetV2MixOrderOrdersPending = async () => ({data:{entrustedList:[]}});
    ex.privateMixGetV2MixOrderOrdersPlanPending = async p => {types.push(p.planType);return {data:{entrustedList:[]}};};
    await doGetOpenOrders(ex,'bitget',{symbol:'BTC/USDT:USDT'}); return types;
  `);
  assert.deepEqual(Array.from(types).sort(), ['normal_plan','profit_loss']);
  await assert.rejects(run(`
    const ex = fixtureExchange('bitget');
    ex.fetchOpenOrders = async (s, a, b, p) => {if(p.planType === 'profit_loss') throw new Error('API denied');return [];};
    return doGetOpenOrders(ex,'bitget',{symbol:'BTC/USDT:USDT'});
  `), /API denied/);
});

test('Bitget ordinary parent with preset TP/SL cancels as an ordinary limit order', async () => {
  const run = background();
  assert.equal(await run(`
    const ex = fixtureExchange('bitget');
    const raw={symbol:'BTCUSDT',orderId:'123',orderType:'limit',side:'buy',size:'1',price:'60000',state:'live',presetStopLossPrice:'58000',presetStopSurplusPrice:'65000'};
    ex.fetchOpenOrders = async (s,a,b,p) => p.trigger ? [] : [ex.parseOrder(raw,ex.market(s))];
    const [order] = await doGetOpenOrders(ex,'bitget',{symbol:'BTC/USDT:USDT'});
    let route;
    ex.privateMixPostV2MixOrderCancelOrder = async () => {route='regular';return {data:{orderId:'123'}};};
    ex.privateMixPostV2MixOrderCancelPlanOrder = async () => {route='WRONG';return {data:{}};};
    await doCancelOrder(ex,'bitget',{...order,orderId:order.id,marketType:'perp'});
    return route;
  `), 'regular');
});

test('Bitget plan cancellation rejects HTTP-success responses containing a business failure', async () => {
  const run = background();
  await assert.rejects(run(`
    const ex=fixtureExchange('bitget');
    const response={code:'00000',msg:'success',data:{successList:[],failureList:[{orderId:'123',errorMsg:'cancel rejected'}]}};
    ex.privateMixPostV2MixOrderCancelPlanOrder=async()=>{
      ex.handleErrors(200,'OK','MOCK','POST',{},JSON.stringify(response),response,{},'');
      return response;
    };
    return doCancelOrder(ex,'bitget',{symbol:'BTC/USDT:USDT',orderId:'123',isAlgo:true,cancelKind:'trigger',planType:'normal_plan',marketType:'perp'});
  `), /cancel rejected/);
});

test('Bitget plan cancellation requires confirmation for the requested order ID', async () => {
  const run = background();
  await assert.rejects(run(`
    const ex=fixtureExchange('bitget');
    ex.privateMixPostV2MixOrderCancelPlanOrder=async()=>({code:'00000',msg:'success',data:{successList:[{orderId:'other'}],failureList:[]}});
    return doCancelOrder(ex,'bitget',{symbol:'BTC/USDT:USDT',orderId:'123',isAlgo:true,planType:'normal_plan',marketType:'perp'});
  `), /未确认/);
});

for (const planType of ['normal_plan','profit_plan','loss_plan','pos_profit','pos_loss','moving_plan']) {
  test(`Bitget confirms cancellation of ${planType} using its native response`, async () => {
    const run = background();
    const result = await run(`
      const ex=fixtureExchange('bitget');let request;
      ex.privateMixPostV2MixOrderCancelPlanOrder=async p=>{request=p;return {code:'00000',msg:'success',data:{successList:[{orderId:'123'}],failureList:[]}};};
      const order=await doCancelOrder(ex,'bitget',{symbol:'BTC/USDT:USDT',orderId:'123',isAlgo:true,cancelKind:'tpsl',planType:'${planType}',marketType:'perp'});
      return {request,order};
    `);
    assert.equal(result.request.planType, planType);
    assert.equal(result.request.orderIdList[0].orderId, '123');
    assert.equal(result.request.productType, 'USDT-FUTURES');
    assert.equal(result.order.id, '123');
    assert.equal(result.order.status, 'canceled');
  });
}

test('a failed Bitget target cannot be masked by success for another order', async () => {
  const run = background();
  await assert.rejects(run(`
    const ex=fixtureExchange('bitget');
    ex.privateMixPostV2MixOrderCancelPlanOrder=async()=>({code:'00000',msg:'success',data:{successList:[{orderId:'other'}],failureList:[{orderId:'123',errorMsg:'target rejected'}]}});
    return doCancelOrder(ex,'bitget',{symbol:'BTC/USDT:USDT',orderId:'123',isAlgo:true,planType:'normal_plan',marketType:'perp'});
  `), /target rejected/);
});

test('unsupported Bitget plan types are rejected before any cancellation request', async () => {
  const run = background();
  await assert.rejects(run(`
    const ex=fixtureExchange('bitget');
    ex.privateMixPostV2MixOrderCancelPlanOrder=async()=>{throw new Error('must not send');};
    return doCancelOrder(ex,'bitget',{symbol:'BTC/USDT:USDT',orderId:'123',isAlgo:true,planType:'unsupported',marketType:'perp'});
  `), /不支持的计划单/);
});

test('moving_plan classification survives the full list-normalize-cancel path', async () => {
  const run = background();
  const result = await run(`
    const ex=fixtureExchange('bitget');let request;
    ex.fetchOpenOrders=async(s,a,b,p)=>p.planType==='profit_loss' ? [ex.parseOrder({symbol:'BTCUSDT',orderId:'123',planType:'moving_plan',orderType:'market',side:'sell',size:'1',triggerPrice:'58000'},ex.market(s))] : [];
    const [order]=await doGetOpenOrders(ex,'bitget',{symbol:'BTC/USDT:USDT'});
    ex.privateMixPostV2MixOrderCancelPlanOrder=async p=>{request=p;return {code:'00000',msg:'success',data:{successList:[{orderId:'123'}],failureList:[]}};};
    await doCancelOrder(ex,'bitget',{...order,orderId:order.id,marketType:'perp'});return request;
  `);
  assert.equal(result.planType, 'moving_plan');
  assert.equal(result.orderIdList[0].orderId, '123');
});

for (const type of ['market','stop','takeprofit']) {
  test(`Bitget spot ${type} buy supplies a valid quote cost`, async () => {
    const run = background();
    const request = await run(`
      const ex = fixtureExchange('bitget','spot');
      ex.fetchTicker = async () => ({last:60000,ask:60000});
      let request;
      const response = async p => {request=p;return {data:{orderId:'123'}};};
      ex.privateSpotPostV2SpotTradePlaceOrder = response;
      ex.privateSpotPostV2SpotTradePlacePlanOrder = response;
      await doPlaceOrder(ex,'bitget',{symbol:'BTC/USDT',marketType:'spot',side:'buy',orderType:'${type}',amount:'.01',stopPrice:'${type === 'takeprofit' ? 58000 : 62000}'});
      return request;
    `);
    assert.ok(Number(request.size) > 0);
    assert.equal(request.orderType, 'market');
  });
}

for (const type of ['stop','takeprofit']) {
  for (const limit of [false,true]) {
    test(`Bitget perp ${type} ${limit ? 'limit' : 'market'} uses a sized normal trigger plan`, async () => {
      const run = background();
      const request = await run(`
        const ex = fixtureExchange('bitget');
        ex.fetchTicker = async () => ({last:60000});
        let request;
        ex.privateMixPostV2MixOrderPlacePlanOrder = async p => {request=p;return {data:{orderId:'123'}};};
        await doPlaceOrder(ex,'bitget',{symbol:'BTC/USDT:USDT',marketType:'perp',side:'sell',reduceOnly:true,orderType:'${type}',amount:'.01',stopPrice:'${type === 'stop' ? 58000 : 62000}',price:'${limit ? 59000 : ''}'});
        return request;
      `);
      assert.equal(request.planType, 'normal_plan');
      assert.equal(request.size, '0.01');
      assert.equal(request.reduceOnly, 'YES');
      assert.equal(request.orderType, limit ? 'limit' : 'market');
    });
  }
}

test('Bitget wrong trigger direction is rejected before leverage or order submission', async () => {
  const run = background();
  await assert.rejects(run(`
    const ex = fixtureExchange('bitget'); ex.fetchTicker=async()=>({last:60000});
    ex.setLeverage = async () => {throw new Error('unexpected private write');};
    return doPlaceOrder(ex,'bitget',{symbol:'BTC/USDT:USDT',marketType:'perp',side:'sell',orderType:'stop',amount:'1',stopPrice:'65000',leverage:10});
  `), /低于/);
});

test('OKX algo history uses effective/canceled and preserves cancellation records', async () => {
  const run = background();
  const result = await run(`
    const ex = fixtureExchange('okx'), requests=[];
    ex.privateGetTradeOrdersHistory = async p => ({data:[{ordId:p.state,instId:'BTCUSDT',ordType:'limit',side:'buy',state:p.state,sz:'1',px:'60000',cTime:'1000'}]});
    ex.privateGetTradeOrdersAlgoHistory = async p => {requests.push(p);return {data:[]};};
    const orders=await doGetOrderHistory(ex,'okx',{symbol:'BTC/USDT:USDT'});
    return {requests,statuses:orders.map(o=>o.status)};
  `);
  assert.ok(result.statuses.includes('canceled'));
  assert.ok(result.statuses.includes('closed'));
  assert.ok(result.requests.some(p => p.ordType === 'conditional' && p.state === 'effective'));
  assert.ok(result.requests.every(p => ['effective','canceled'].includes(p.state)));
});

for (const id of ['binance','bybit','bitget','hyperliquid']) {
  test(`${id} history keeps canceled records and limits the merged newest results`, async () => {
    const run = background();
    const result = await run(`
      const ex = fixtureExchange('${id}');
      const rows=[{id:'old',symbol:'BTC/USDT:USDT',status:'closed',timestamp:1},{id:'cancel',symbol:'BTC/USDT:USDT',status:'canceled',timestamp:2}];
      ex.fetchOrders = async () => rows;
      ${id === 'bybit' || id === 'bitget' ? 'ex.fetchCanceledAndClosedOrders = async (s,a,b,p) => p.trigger ? [] : rows;' : ''}
      return doGetOrderHistory(ex,'${id}',{symbol:'BTC/USDT:USDT',limit:1});
    `);
    assert.equal(result.length, 1);
    assert.equal(result[0].status, 'canceled');
  });
}

for (const id of ['binance','okx','bybit','bitget']) {
  test(`${id} hedge-mode reduce-only orders target the long position`, async () => {
    const run = background();
    const request = await run(`
      const ex = fixtureExchange('${id}');
      ex.fetchPositionMode = async () => ({hedged:true});
      ex.fetchPositions = async () => [{contracts:1,marginMode:'isolated',info:{positionIdx:1}}];
      ex.privateMixGetV2MixAccountAccount = async () => ({data:{posMode:'hedge_mode',marginMode:'isolated'}});
      ex.createLimitOrder = async (s,side,a,p,params) => ex.createOrderRequest(s,'limit',side,a,p,params);
      return doPlaceOrder(ex,'${id}',{symbol:'BTC/USDT:USDT',marketType:'perp',side:'sell',reduceOnly:true,orderType:'limit',amount:'1',price:'60000'});
    `);
    if (id === 'binance') { assert.equal(request.positionSide, 'LONG'); assert.equal(request.reduceOnly, undefined); }
    if (id === 'okx') { assert.equal(request.posSide, 'long'); assert.equal(request.tdMode, 'isolated'); }
    if (id === 'bybit') { assert.equal(request.positionIdx, 1); assert.equal(request.reduceOnly, true); }
    if (id === 'bitget') { assert.equal(request.tradeSide, 'Close'); assert.equal(request.side, 'buy'); assert.equal(request.marginMode, 'isolated'); }
  });
}

test('Hyperliquid preserves an existing isolated margin position when setting leverage', async () => {
  const run = background();
  assert.equal(await run(`
    const ex=fixtureExchange('hyperliquid');
    ex.fetchPositions=async()=>[{contracts:1,marginMode:'isolated'}];
    let mode;ex.setLeverage=async(l,s,p)=>{mode=p.marginMode;};ex.createLimitOrder=async()=>({id:'1'});
    await doPlaceOrder(ex,'hyperliquid',{symbol:'BTC/USDT:USDT',marketType:'perp',side:'buy',orderType:'limit',amount:'1',price:'60000',leverage:10});return mode;
  `), 'isolated');
});

test('unknown Bybit account mode and real leverage failures block submission', async () => {
  const run = background();
  await assert.rejects(run(`
    const ex=fixtureExchange('bybit');ex.fetchPositions=async()=>[];
    ex.createLimitOrder=async()=>{throw new Error('must not submit');};
    return doPlaceOrder(ex,'bybit',{symbol:'BTC/USDT:USDT',marketType:'perp',side:'buy',orderType:'limit',amount:'1',price:'60000'});
  `), /持仓模式/);
  await assert.rejects(run(`
    const ex=fixtureExchange('bybit');ex.setLeverage=async()=>{throw new Error('permission denied');};
    return doPlaceOrder(ex,'bybit',{symbol:'BTC/USDT:USDT',marketType:'perp',side:'buy',orderType:'limit',amount:'1',price:'60000',leverage:10});
  `), /设置杠杆失败/);
});

test('position queries use the selected USDC symbol and convert contracts to base coin', async () => {
  const run = background();
  const result = await run(`
    const ex=fixtureExchange('okx');
    const market={...fixtureMarket('swap',.01),symbol:'BTC/USDC:USDC',quote:'USDC',settle:'USDC',settleId:'USDC'};
    ex.setMarkets([market]);let requested;
    ex.fetchPositions=async symbols=>{requested=symbols;return [{symbol:market.symbol,contracts:100,side:'long'}];};
    const positions=await doGetPositions(ex,{symbol:market.symbol});return {requested,positions};
  `);
  assert.equal(result.requested[0], 'BTC/USDC:USDC');
  assert.equal(result.positions[0].amount, '1');
});

test('unsupported inverse swaps are rejected rather than submitted with incorrect units', async () => {
  const run = background();
  await assert.rejects(run(`
    const ex=fixtureExchange('binance');const market=ex.market('BTC/USDT:USDT');market.linear=false;market.inverse=true;
    return doPlaceOrder(ex,'binance',{symbol:market.symbol,marketType:'perp',side:'buy',orderType:'limit',amount:'1',price:'60000'});
  `), /线性/);
});

for (const type of ['stop', 'takeprofit']) {
  for (const side of ['buy', 'sell']) {
    for (const reduceOnly of [false, true]) {
      test(`Bybit ${type} ${side} hedge trigger respects reduceOnly=${reduceOnly}`, async () => {
        const run = background();
        const ascending = type === 'stop' ? side === 'buy' : side === 'sell';
        const request = await run(`
          const ex=fixtureExchange('bybit');ex.fetchPositions=async()=>[{info:{positionIdx:1}}];
          ex.fetchTicker=async()=>({last:60000});ex.isUnifiedEnabled=async()=>[false,true];
          let request;ex.privatePostV5OrderCreate=async p=>{request=p;return {result:{orderId:'1'}};};
          await doPlaceOrder(ex,'bybit',{symbol:'BTC/USDT:USDT',marketType:'perp',side:'${side}',orderType:'${type}',amount:'1',stopPrice:'${ascending ? 62000 : 58000}',reduceOnly:${reduceOnly}});return request;
        `);
        const position = side === 'buy' ? (reduceOnly ? 2 : 1) : (reduceOnly ? 1 : 2);
        assert.equal(request.positionIdx, position);
        assert.equal(request.triggerDirection, ascending ? 1 : 2);
        assert.equal(Boolean(request.reduceOnly), reduceOnly);
      });
    }
  }
}

for (const type of ['stop', 'takeprofit']) {
  for (const side of ['buy', 'sell']) {
    for (const limit of [false, true]) {
      test(`OKX spot ${type} ${side} ${limit ? 'limit' : 'market'} stays cash and sends algoClOrdId`, async () => {
        const run = background();
        const request = await run(`
          const ex=fixtureExchange('okx','spot');let request;
          ex.privatePostTradeOrderAlgo=async p=>{request=p;return {data:[{algoId:'1'}]};};
          await doPlaceOrder(ex,'okx',{symbol:'BTC/USDT',marketType:'spot',side:'${side}',orderType:'${type}',amount:'1',stopPrice:'58000',price:'${limit ? 59000 : ''}',requestId:'d'.repeat(32)});return request;
        `);
        assert.equal(request.tdMode, 'cash');
        assert.equal(request.algoClOrdId, 'ank' + 'd'.repeat(29));
        assert.equal(request.clOrdId, undefined);
      });
    }
  }
}

test('Bybit spot queries explicit Order/StopOrder/tpslOrder groups without duplicates', async () => {
  const run = background();
  const result = await run(`
    const ex=fixtureExchange('bybit','spot'), filters=[];
    ex.fetchOpenOrders=async(s,a,b,p)=>{filters.push(p.orderFilter);return p.orderFilter==='tpslOrder' ? [{id:'tp',symbol:s,type:'market'}] : [];};
    const orders=await doGetOpenOrders(ex,'bybit',{symbol:'BTC/USDT'});return {filters,orders};
  `);
  assert.deepEqual(Array.from(result.filters).sort(), ['Order', 'StopOrder', 'tpslOrder']);
  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0].cancelKind, 'tpsl');
});

test('Bybit reads the next cursor page of pending orders', async () => {
  const run = background();
  const result = await run(`
    const ex=fixtureExchange('bybit'), requests=[];
    ex.privateGetV5OrderRealtime=async p=>{
      requests.push(p);
      const ids=p.cursor ? [51] : Array.from({length:50},(_,i)=>i+1);
      return {result:{category:'linear',nextPageCursor:p.cursor?'':'next',list:ids.map(i=>({orderId:String(i),symbol:'BTCUSDT',orderStatus:'New',orderType:'Limit',side:'Buy',qty:'1',price:'60000',createdTime:String(i)}))}};
    };
    const orders=await doGetOpenOrders(ex,'bybit',{symbol:'BTC/USDT:USDT'});return {orders,requests};
  `);
  assert.equal(result.orders.length, 51);
  assert.equal(result.requests[0].limit, 50);
  assert.equal(result.requests[1].cursor, 'next');
});

test('OKX pending orders advance the oldest order ID cursor', async () => {
  const run = background();
  const result = await run(`
    const ex=fixtureExchange('okx'), cursors=[];
    ex.fetchOpenOrders=async(s,a,b,p)=>{
      if(p.trigger)return [];
      cursors.push(p.after);
      return (p.after?[0]:Array.from({length:100},(_,i)=>i+1)).map(i=>({id:String(i),symbol:s,type:'limit',timestamp:i}));
    };
    const orders=await doGetOpenOrders(ex,'okx',{symbol:'BTC/USDT:USDT'});return {orders,cursors};
  `);
  assert.equal(result.orders.length, 101);
  assert.equal(result.cursors[1], '1');
});

test('Bitget contract pending orders advance idLessThan even when CCXT drops endId', async () => {
  const run = background();
  const result = await run(`
    const ex=fixtureExchange('bitget'), requests=[];
    ex.privateMixGetV2MixOrderOrdersPlanPending=async()=>({data:{entrustedList:[]}});
    ex.privateMixGetV2MixOrderOrdersPending=async p=>{
      requests.push(p);
      const ids=p.idLessThan ? [0] : Array.from({length:100},(_,i)=>100-i);
      return {data:{endId:'next',entrustedList:ids.map(i=>({orderId:String(i),symbol:'BTCUSDT',orderType:'limit',side:'buy',state:'live',size:'1',price:'60000',cTime:String(i)}))}};
    };
    const orders=await doGetOpenOrders(ex,'bitget',{symbol:'BTC/USDT:USDT'});return {orders,requests};
  `);
  assert.equal(result.orders.length, 101);
  assert.equal(result.requests[1].idLessThan, '1');
});

test('a bounded spot listing warns rather than pretending a full page is complete', async () => {
  const run = background();
  const result = await run(`
    const ex=fixtureExchange('bitget','spot');
    ex.fetchOpenOrders=async(s,a,b,p)=>p.trigger?[]:Array.from({length:100},(_,i)=>({id:String(i),symbol:s,type:'limit'}));
    return doGetOpenOrders(ex,'bitget',{symbol:'BTC/USDT'});
  `);
  assert.equal(result.orders.length, 100);
  assert.ok(result.warning);
});

test('market metadata TTL is per instance and concurrent refreshes share one load', async () => {
  const run = background();
  const result = await run(`
    const ex=fixtureExchange('okx'), other=fixtureExchange('okx'), loads=[];
    let now=100000000;Date.now=()=>now;
    ex.loadMarkets=async force=>{loads.push(force);await Promise.resolve();return ex.markets;};
    let otherLoads=0;other.loadMarkets=async()=>{otherLoads++;return other.markets;};
    await Promise.all([loadExchangeMarkets(ex),loadExchangeMarkets(ex)]);
    now+=3600001;await loadExchangeMarkets(ex);await loadExchangeMarkets(other);
    return {loads,otherLoads};
  `);
  assert.deepEqual(Array.from(result.loads), [true,true]);
  assert.equal(result.otherLoads, 1);
});
