const EXCHANGES = [
  { id: 'binance',     name: 'Binance',     hasPass: false },
  { id: 'okx',         name: 'OKX',         hasPass: true  },
  { id: 'bybit',       name: 'Bybit',       hasPass: false },
  { id: 'bitget',      name: 'Bitget',      hasPass: true  },
  { id: 'hyperliquid', name: 'Hyperliquid', hasPass: false, isEth: true },
];

const state = {
  cur:      'binance',
  creds:    {},   // { [exchangeId]: { apiKey, secret, passphrase? } }
  saving:   false,
  testing:  false,
  msg:      null,  // { text, type }
};

async function init() {
  const keys  = EXCHANGES.map(e => `credentials_${e.id}`);
  const stored = await chrome.storage.local.get(['selectedExchange', ...keys]);
  if (stored.selectedExchange) state.cur = stored.selectedExchange;
  for (const e of EXCHANGES) {
    const v = stored[`credentials_${e.id}`];
    if (v) state.creds[e.id] = v;
  }
  render();
}

function render() {
  document.getElementById('app').innerHTML = html();
  bind();
}

function html() {
  const ex    = EXCHANGES.find(e => e.id === state.cur);
  const creds = state.creds[state.cur] || {};
  return `
<div class="options-wrap">
  <header class="options-header">
    <div class="logo-dot"></div>
    <h1>Coinank Trader — API 设置</h1>
  </header>

  <div class="exchange-tabs">
    ${EXCHANGES.map(e => `
    <button class="ex-tab${state.cur===e.id?' active':''}" data-ex="${e.id}">
      ${e.name}
      <span class="status-dot${state.creds[e.id]?' configured':''}"></span>
    </button>`).join('')}
  </div>

  <div class="creds-card">
    <h2>${ex.name} API 配置</h2>

    ${ex.isEth ? `
    <div class="hint">
      Hyperliquid 使用以太坊钱包授权。<br>
      • <strong>API Key</strong> → 钱包地址（Wallet Address），如 0x...。<br>
      • <strong>Secret</strong> → API Wallet 私钥（在 Hyperliquid 应用中创建）。<br>
      建议使用专用 API 子钱包，不要填写主钱包私钥。
    </div>` : ''}

    ${ex.hasPass ? `
    <div class="hint">
      ${ex.name} 需要额外的 Passphrase（创建 API 时自行设置）。
    </div>` : ''}

    <div class="field-group">
      <label>${ex.isEth ? '钱包地址 (Wallet Address)' : 'API Key'}</label>
      <input class="field-input" id="apiKeyIn" type="text"
             value="${creds.apiKey || ''}"
             placeholder="${ex.isEth ? '0x...' : '请输入 API Key'}" autocomplete="off">
    </div>

    <div class="field-group">
      <label>${ex.isEth ? '私钥 (API Wallet Private Key)' : 'Secret Key'}</label>
      <input class="field-input" id="secretIn" type="password"
             value="${creds.secret || ''}"
             placeholder="${ex.isEth ? '0x... 或 64 位十六进制' : '请输入 Secret Key'}" autocomplete="off">
    </div>

    ${ex.hasPass ? `
    <div class="field-group">
      <label>Passphrase</label>
      <input class="field-input" id="passIn" type="password"
             value="${creds.passphrase || ''}" placeholder="请输入 Passphrase" autocomplete="off">
    </div>` : ''}

    <div class="actions">
      <button class="btn-primary" id="saveBtn"${state.saving?' disabled':''}>
        ${state.saving ? '保存中...' : '保存'}
      </button>
      <button class="btn-secondary" id="testBtn"${state.testing?' disabled':''}>
        ${state.testing ? '测试中...' : '测试连接'}
      </button>
      <button class="btn-danger" id="clearBtn">清除</button>
    </div>

    ${state.msg ? `<div class="msg ${state.msg.type}">${state.msg.text}</div>` : ''}
  </div>

  <div class="security-note">
    <strong>🔒 安全提示</strong>
    <p>
      所有 API Key 仅存储在您的本地浏览器（chrome.storage.local），
      不会上传到任何服务器或第三方。建议仅开启交易权限，
      <strong>不要开启提现权限</strong>。
    </p>
  </div>
</div>`;
}

function bind() {
  document.querySelectorAll('[data-ex]').forEach(b => b.addEventListener('click', () => {
    state.cur = b.dataset.ex;
    chrome.storage.local.set({ selectedExchange: state.cur });
    render();
  }));
  document.getElementById('saveBtn')?.addEventListener('click', doSave);
  document.getElementById('testBtn')?.addEventListener('click', doTest);
  document.getElementById('clearBtn')?.addEventListener('click', doClear);
}

async function doSave() {
  const apiKey     = document.getElementById('apiKeyIn')?.value?.trim();
  const secret     = document.getElementById('secretIn')?.value?.trim();
  const passphrase = document.getElementById('passIn')?.value?.trim();
  if (!apiKey || !secret) return showMsg('请填写 API Key 和 Secret', 'error');

  state.saving = true; render();
  const creds = { apiKey, secret };
  if (passphrase) creds.passphrase = passphrase;

  state.creds[state.cur] = creds;
  await chrome.storage.local.set({ [`credentials_${state.cur}`]: creds });
  state.saving = false;
  showMsg('✓ 保存成功', 'success');
  render();
}

async function doTest() {
  const apiKey     = document.getElementById('apiKeyIn')?.value?.trim();
  const secret     = document.getElementById('secretIn')?.value?.trim();
  const passphrase = document.getElementById('passIn')?.value?.trim();
  if (!apiKey || !secret) return showMsg('请先填写 API Key 和 Secret', 'error');

  state.testing = true; render();
  const creds = { apiKey, secret };
  if (passphrase) creds.passphrase = passphrase;

  try {
    await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { action: 'getBalance', exchange: state.cur, credentials: creds, params: {} },
        res => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          res.ok ? resolve(res.data) : reject(new Error(res.error));
        }
      );
    });
    showMsg('✓ 连接成功，API 有效', 'success');
  } catch (e) {
    showMsg(`✗ 连接失败: ${e.message}`, 'error');
  }
  state.testing = false; render();
}

async function doClear() {
  const ex = EXCHANGES.find(e => e.id === state.cur);
  if (!confirm(`确定要清除 ${ex.name} 的 API 配置吗？`)) return;
  delete state.creds[state.cur];
  await chrome.storage.local.remove(`credentials_${state.cur}`);
  showMsg('已清除', 'info');
  render();
}

function showMsg(text, type) {
  state.msg = { text, type };
  setTimeout(() => { state.msg = null; render(); }, 4000);
}

document.addEventListener('DOMContentLoaded', init);
