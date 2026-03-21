/**
 * Hyperliquid 交易所接口
 * 使用 EIP-712 签名 + msgpack 编码
 * API Key = 钱包地址 (wallet address)
 * Secret  = API 钱包私钥 (API wallet private key, 64 位 hex 或 0x 开头)
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

/**
 * 将十六进制字符串转为字节数组，带验证
 */
function hexToBytes(hex) {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (h.length === 0) throw new Error('私钥不能为空');
  if (h.length % 2 !== 0) throw new Error(`私钥十六进制长度必须为偶数，当前长度: ${h.length}`);
  if (!/^[0-9a-fA-F]+$/.test(h)) throw new Error('私钥包含非法字符（仅支持十六进制）');
  return new Uint8Array(h.match(/.{2}/g).map(b => parseInt(b, 16)));
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
// domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: 0x000...0 }
function buildDomainSeparator() {
  const domainTypeHash = keccak256(
    new TextEncoder().encode('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')
  );
  const nameHash    = keccak256(new TextEncoder().encode('Exchange'));
  const versionHash = keccak256(new TextEncoder().encode('1'));
  const chainId     = pad32(1337);
  const contract    = new Uint8Array(32); // zero address padded to 32 bytes
  return keccak256(concatBytes(domainTypeHash, nameHash, versionHash, chainId, contract));
}

const DOMAIN_SEP = buildDomainSeparator();
// keccak256("Agent(string source,bytes32 connectionId)")
const AGENT_TYPE_HASH = keccak256(new TextEncoder().encode('Agent(string source,bytes32 connectionId)'));

/**
 * 计算 action hash:
 * keccak256(msgpack(action) + vaultAddress(20 bytes zero) + nonce_bigendian(8 bytes))
 */
function computeActionHash(action, nonce) {
  const packed   = msgpackEncode(action);
  const vault    = new Uint8Array(20); // no vault = 20 zero bytes
  const nonceBuf = new Uint8Array(8);
  new DataView(nonceBuf.buffer).setBigUint64(0, BigInt(nonce), false); // big-endian
  return keccak256(concatBytes(packed, vault, nonceBuf));
}

/**
 * EIP-712 签名
 * finalHash = keccak256("\x19\x01" + domainSep + hashStruct(Agent))
 */
function signAction(action, nonce, privateKey) {
  const privBytes = hexToBytes(privateKey); // 带验证的转换
  if (privBytes.length !== 32) {
    throw new Error(`私钥长度必须为 32 字节（64 位十六进制），实际: ${privBytes.length} 字节`);
  }

  const actionHash = computeActionHash(action, nonce);
  const sourceHash = keccak256(new TextEncoder().encode('a')); // mainnet source = "a"

  // hashStruct(Agent) = keccak256(typeHash + keccak256(source) + connectionId)
  const structHash = keccak256(concatBytes(AGENT_TYPE_HASH, sourceHash, actionHash));
  // finalHash = keccak256("\x19\x01" + domainSep + structHash)
  const finalHash  = keccak256(concatBytes(new Uint8Array([0x19, 0x01]), DOMAIN_SEP, structHash));

  let sig;
  try {
    sig = secp256k1.sign(finalHash, privBytes, { lowS: true });
  } catch (e) {
    throw new Error(`私钥签名失败: ${e.message}（请检查私钥格式是否正确）`);
  }

  return {
    r: '0x' + sig.r.toString(16).padStart(64, '0'),
    s: '0x' + sig.s.toString(16).padStart(64, '0'),
    v: sig.recovery + 27,
  };
}

// ─── API 请求 ───────────────────────────────────────────────────────────────

async function safeJson(resp, label) {
  const text = await resp.text();
  try { return JSON.parse(text); }
  catch { throw new Error(`Hyperliquid ${label} HTTP ${resp.status}: ${text.slice(0, 120)}`); }
}

async function postInfo(body) {
  const resp = await fetch(`${BASE_URL}/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await safeJson(resp, 'info');
  return data;
}

async function sendSigned(action, nonce, credentials) {
  const signature = signAction(action, nonce, credentials.secret);
  const resp = await fetch(`${BASE_URL}/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, nonce, signature, vaultAddress: null }),
  });
  const data = await safeJson(resp, 'exchange');
  if (data.status !== 'ok') {
    const msg = typeof data.response === 'string' ? data.response : JSON.stringify(data.response);
    throw new Error(`Hyperliquid: ${msg}`);
  }
  return data.response;
}

async function getAssetIndex(symbol) {
  if (!assetCache) {
    const data = await postInfo({ type: 'meta' });
    if (!data?.universe?.length) throw new Error('Hyperliquid: 无法获取资产列表');
    assetCache = data.universe;
  }
  const sym = formatSymbol(symbol, 'hyperliquid');
  const idx = assetCache.findIndex(a => a.name === sym);
  if (idx === -1) {
    const available = assetCache.map(a => a.name).slice(0, 10).join(', ');
    throw new Error(`Hyperliquid: 不支持资产 "${sym}"，可用资产（前10个）: ${available}...`);
  }
  return idx;
}

// ─── 公开接口 ───────────────────────────────────────────────────────────────

export async function placeOrder(credentials, { symbol, side, orderType, amount, price, stopPrice }) {
  if (!credentials.apiKey || !credentials.secret) {
    throw new Error('Hyperliquid 需要填写钱包地址（API Key）和私钥（Secret）');
  }

  const assetIdx = await getAssetIndex(symbol);
  const isBuy = side === 'buy';

  const qty = toFixed(amount);
  if (!qty || parseFloat(qty) <= 0) throw new Error('数量必须大于 0');

  let px, orderTif;
  if (orderType === 'market') {
    // 市价单模拟：使用激进价格 + IOC
    // 注意：不能用过于极端的价格，否则会被拒绝；使用较为激进的值
    px = isBuy ? '9999999' : '0.000001';
    orderTif = { limit: { tif: 'Ioc' } };
  } else if (orderType === 'limit') {
    if (!price || parseFloat(price) <= 0) throw new Error('限价单必须填写价格');
    px = toFixed(price);
    orderTif = { limit: { tif: 'Gtc' } };
  } else if (orderType === 'stop') {
    if (!stopPrice || parseFloat(stopPrice) <= 0) throw new Error('止损单必须填写触发价格');
    px = toFixed(price || stopPrice);
    orderTif = {
      trigger: {
        isMarket: !price || parseFloat(price) <= 0,
        triggerPx: toFixed(stopPrice),
        tpsl: 'sl',
      },
    };
  } else {
    throw new Error(`不支持的订单类型: ${orderType}`);
  }

  const action = {
    type: 'order',
    orders: [{ a: assetIdx, b: isBuy, p: px, s: qty, r: false, t: orderTif }],
    grouping: 'na',
  };

  return sendSigned(action, Date.now(), credentials);
}

export async function cancelOrder(credentials, { symbol, orderId }) {
  if (!orderId) throw new Error('撤单需要 orderId');

  // Hyperliquid oid 是整数；使用 Number() 而非 parseInt() 避免精度丢失
  const oid = Number(orderId);
  if (!Number.isInteger(oid) || oid <= 0) {
    throw new Error(`无效的订单 ID: ${orderId}`);
  }

  const assetIdx = await getAssetIndex(symbol);
  const action = { type: 'cancel', cancels: [{ a: assetIdx, o: oid }] };
  return sendSigned(action, Date.now(), credentials);
}

export async function getOpenOrders(credentials) {
  if (!credentials.apiKey) throw new Error('需要填写钱包地址');
  const orders = await postInfo({ type: 'openOrders', user: credentials.apiKey });
  return (Array.isArray(orders) ? orders : []).map(o => {
    // Hyperliquid 返回格式: { order: { oid, coin, isBuy, limitPx, sz, timestamp, ... }, status: "open" }
    const ord = o.order ?? o;
    return {
      id: String(ord.oid),
      symbol: `${ord.coin}/USDT`,
      side: ord.isBuy ? 'buy' : 'sell',
      type: 'limit',
      amount: ord.sz,
      price: ord.limitPx,
      stopPrice: '',
      status: 'open',
      time: ord.timestamp,
      isAlgo: false,
      raw: o,
    };
  });
}

export async function getOrderHistory(credentials, { limit = 50 } = {}) {
  if (!credentials.apiKey) throw new Error('需要填写钱包地址');
  const fills = await postInfo({ type: 'userFills', user: credentials.apiKey });
  return (Array.isArray(fills) ? fills.slice(0, limit) : []).map(f => ({
    id: String(f.oid),
    symbol: `${f.coin}/USDT`,
    // Hyperliquid 成交方向: "A" = Ask(卖), "B" = Bid(买)
    side: f.side === 'B' ? 'buy' : 'sell',
    type: 'market',
    amount: f.sz,
    price: f.px,
    stopPrice: '',
    status: 'filled',
    time: f.time,
    isAlgo: false,
    raw: f,
  }));
}

export async function getBalance(credentials) {
  if (!credentials.apiKey) throw new Error('需要填写钱包地址');
  const data = await postInfo({ type: 'clearinghouseState', user: credentials.apiKey });
  const summary = data?.marginSummary || {};
  return [{
    asset: 'USDC',
    free: summary.withdrawable || '0',
    walletBalance: summary.accountValue || '0',
  }];
}

// ─── 工具 ───────────────────────────────────────────────────────────────────
function toFixed(val) {
  const n = Number(val);
  if (isNaN(n)) return '';
  return n.toLocaleString('fullwide', { useGrouping: false, maximumFractionDigits: 20 });
}
