/**
 * HMAC-SHA256 签名（使用 Web Crypto API，服务工作者中可用）
 * @param {string} secret
 * @param {string} message
 * @param {'hex'|'base64'} encoding
 */
export async function hmacSha256(secret, message, encoding = 'hex') {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  const bytes = new Uint8Array(sig);
  if (encoding === 'base64') {
    return btoa(String.fromCharCode(...bytes));
  }
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 将标准交易对符号转换为各交易所格式
 * 输入: "BTC/USDT" 或 "BTCUSDT"
 */
export function formatSymbol(symbol, exchange, marketType = 'spot') {
  let base, quote;
  if (symbol.includes('/')) {
    [base, quote] = symbol.toUpperCase().split('/');
  } else {
    const quotes = ['USDT', 'BUSD', 'USDC', 'BTC', 'ETH', 'BNB'];
    let found = false;
    for (const q of quotes) {
      if (symbol.toUpperCase().endsWith(q)) {
        base = symbol.toUpperCase().slice(0, -q.length);
        quote = q;
        found = true;
        break;
      }
    }
    if (!found) { base = symbol.toUpperCase(); quote = 'USDT'; }
  }

  switch (exchange) {
    case 'okx':
      return marketType === 'perp' ? `${base}-${quote}-SWAP` : `${base}-${quote}`;
    case 'hyperliquid':
      return base; // 只需要基础资产名
    default: // binance, bybit, bitget
      return `${base}${quote}`;
  }
}

/** 解析交易对 */
export function parseSymbol(symbol) {
  if (symbol.includes('/')) {
    const [base, quote] = symbol.toUpperCase().split('/');
    return { base, quote };
  }
  for (const q of ['USDT', 'BUSD', 'USDC']) {
    if (symbol.toUpperCase().endsWith(q)) {
      return { base: symbol.toUpperCase().slice(0, -q.length), quote: q };
    }
  }
  return { base: symbol.toUpperCase(), quote: 'USDT' };
}

/** 将交易所格式符号转换为 BTC/USDT 显示格式 */
export function displaySymbol(symbol) {
  if (!symbol) return '';
  if (symbol.includes('/')) return symbol;
  for (const q of ['USDT', 'BUSD', 'USDC', 'BTC', 'ETH']) {
    if (symbol.toUpperCase().endsWith(q)) {
      return `${symbol.toUpperCase().slice(0, -q.length)}/${q}`;
    }
  }
  // OKX format: BTC-USDT or BTC-USDT-SWAP
  if (symbol.includes('-')) {
    const parts = symbol.split('-');
    return `${parts[0]}/${parts[1]}`;
  }
  return symbol;
}
