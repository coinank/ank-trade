/**
 * Hyperliquid 交易所接口
 * 使用 EIP-712 签名 + msgpack 编码
 * API Key = 钱包地址 (wallet address)
 * Secret  = API 钱包私钥 (API wallet private key)
 */
import { keccak_256 } from '@noble/hashes/sha3.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { encode as msgpackEncode } from '@msgpack/msgpack';
import { formatSymbol } from './utils.js';

const BASE_URL = 'https://api.hyperliquid.xyz';

// 缓存资产列表（服务工作者重启后会重新获取）
let assetCache = null;

// ─── EIP-712 工具函数 ───────────────────────────────────────────────────────

function keccak256(data) {
  return keccak_256(data instanceof Uint8Array ? data : new Uint8Array(data));
}

function concatBytes(...arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

function hexToBytes(hex) {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  return new Uint8Array(h.match(/.{2}/g).map(b => parseInt(b, 16)));
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function pad32(n) {
  const buf = new Uint8Array(32);
  let v = BigInt(n);
  for (let i = 31; i >= 0 && v > 0n; i--) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

// 预计算 EIP-712 domain separator
// domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: 0x0...0 }
function buildDomainSeparator() {
  const domainTypeHash = keccak256(
    new TextEncoder().encode('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')
  );
  const nameHash    = keccak256(new TextEncoder().encode('Exchange'));
  const versionHash = keccak256(new TextEncoder().encode('1'));
  const chainId     = pad32(1337);
  const contract    = new Uint8Array(32); // zero address
  return keccak256(concatBytes(domainTypeHash, nameHash, versionHash, chainId, contract));
}

const DOMAIN_SEP = buildDomainSeparator();
// keccak256("Agent(string source,bytes32 connectionId)")
const AGENT_TYPE_HASH = keccak256(new TextEncoder().encode('Agent(string source,bytes32 connectionId)'));

/**
 * 计算 action hash:
 * keccak256(msgpack(action) + vaultAddress(20 bytes) + nonce_bigendian(8 bytes))
 */
function computeActionHash(action, nonce) {
  const packed   = msgpackEncode(action);
  const vault    = new Uint8Array(20); // no vault
  const nonceBuf = new Uint8Array(8);
  new DataView(nonceBuf.buffer).setBigUint64(0, BigInt(nonce), false);
  return keccak256(concatBytes(packed, vault, nonceBuf));
}

/**
 * EIP-712 hash for Agent type and sign
 */
function signAction(action, nonce, privateKey) {
  const actionHash = computeActionHash(action, nonce);
  const sourceHash = keccak256(new TextEncoder().encode('a')); // mainnet = "a"
  // hashStruct(Agent) = keccak256(typeHash + keccak256(source) + connectionId)
  const structHash = keccak256(concatBytes(AGENT_TYPE_HASH, sourceHash, actionHash));
  // final = keccak256("\x19\x01" + domainSep + structHash)
  const finalHash  = keccak256(concatBytes(new Uint8Array([0x19, 0x01]), DOMAIN_SEP, structHash));

  const privBytes = hexToBytes(privateKey);
  const sig = secp256k1.sign(finalHash, privBytes, { lowS: true });
  return {
    r: '0x' + sig.r.toString(16).padStart(64, '0'),
    s: '0x' + sig.s.toString(16).padStart(64, '0'),
    v: sig.recovery + 27,
  };
}

// ─── API 请求 ───────────────────────────────────────────────────────────────

async function postInfo(body) {
  const resp = await fetch(`${BASE_URL}/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return resp.json();
}

async function sendSigned(action, nonce, credentials) {
  const signature = signAction(action, nonce, credentials.secret);
  const resp = await fetch(`${BASE_URL}/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, nonce, signature, vaultAddress: null }),
  });
  const data = await resp.json();
  if (data.status !== 'ok') {
    throw new Error(typeof data.response === 'string' ? data.response : JSON.stringify(data.response));
  }
  return data.response;
}

async function getAssetIndex(symbol) {
  if (!assetCache) {
    const data = await postInfo({ type: 'meta' });
    assetCache = data.universe;
  }
  const sym = formatSymbol(symbol, 'hyperliquid');
  const idx = assetCache.findIndex(a => a.name === sym);
  if (idx === -1) throw new Error(`Hyperliquid: 未知资产 ${sym}（支持: ${assetCache.map(a => a.name).slice(0, 10).join(', ')}...）`);
  return idx;
}

// ─── 公开接口 ───────────────────────────────────────────────────────────────

export async function placeOrder(credentials, { symbol, side, orderType, amount, price, stopPrice }) {
  const assetIdx = await getAssetIndex(symbol);
  const isBuy = side === 'buy';

  let px, orderTif;
  if (orderType === 'market') {
    // 市价单 = IOC 限价单，价格设置得足够激进
    px = isBuy ? '999999999' : '0.000001';
    orderTif = { limit: { tif: 'Ioc' } };
  } else if (orderType === 'limit') {
    px = String(price);
    orderTif = { limit: { tif: 'Gtc' } };
  } else if (orderType === 'stop') {
    px = String(price || stopPrice);
    orderTif = { trigger: { isMarket: false, triggerPx: String(stopPrice), tpsl: 'sl' } };
  }

  const action = {
    type: 'order',
    orders: [{ a: assetIdx, b: isBuy, p: px, s: String(amount), r: false, t: orderTif }],
    grouping: 'na',
  };

  return sendSigned(action, Date.now(), credentials);
}

export async function cancelOrder(credentials, { symbol, orderId }) {
  const assetIdx = await getAssetIndex(symbol);
  const action = { type: 'cancel', cancels: [{ a: assetIdx, o: parseInt(orderId) }] };
  return sendSigned(action, Date.now(), credentials);
}

export async function getOpenOrders(credentials) {
  const orders = await postInfo({ type: 'openOrders', user: credentials.apiKey });
  return (Array.isArray(orders) ? orders : []).map(o => ({
    id: String(o.order?.oid ?? o.oid),
    symbol: `${o.order?.coin ?? o.coin}/USDT`,
    side: (o.order?.isBuy ?? o.isBuy) ? 'buy' : 'sell',
    type: 'limit',
    amount: o.order?.sz ?? o.sz,
    price: o.order?.limitPx ?? o.limitPx,
    status: 'open',
    time: o.order?.timestamp ?? o.timestamp,
    raw: o,
  }));
}

export async function getOrderHistory(credentials, { limit = 50 } = {}) {
  const fills = await postInfo({ type: 'userFills', user: credentials.apiKey });
  return (Array.isArray(fills) ? fills.slice(0, limit) : []).map(f => ({
    id: String(f.oid),
    symbol: `${f.coin}/USDT`,
    side: f.side === 'B' ? 'buy' : 'sell',
    type: 'market',
    amount: f.sz,
    price: f.px,
    status: 'filled',
    time: f.time,
    raw: f,
  }));
}

export async function getBalance(credentials) {
  const data = await postInfo({ type: 'clearinghouseState', user: credentials.apiKey });
  const summary = data?.marginSummary || {};
  // 返回统一格式，方便 popup 显示
  return [{ ccy: 'USDC', cashBal: summary.accountValue || '0', available: summary.withdrawable || '0' }];
}
