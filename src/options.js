import { initLang, t, langLabel, cycleLang } from './i18n.js';

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
  await initLang();
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
    <h1>${t('options_title')}</h1>
    <button class="btn-icon btn-lang" id="langBtn" style="margin-left:auto">${langLabel()}</button>
  </header>

  <div class="exchange-tabs">
    ${EXCHANGES.map(e => `
    <button class="ex-tab${state.cur===e.id?' active':''}" data-ex="${e.id}">
      ${e.name}
      <span class="status-dot${state.creds[e.id]?' configured':''}"></span>
    </button>`).join('')}
  </div>

  <div class="creds-card">
    <h2>${t('api_config_title', { exchange: ex.name })}</h2>

    ${ex.isEth ? `
    <div class="hint">
      ${t('hl_hint')}<br>
      • <strong>API Key</strong> → ${t('hl_key_hint')}<br>
      • <strong>Secret</strong> → ${t('hl_secret_hint')}<br>
      ${t('hl_sub_wallet')}
    </div>` : ''}

    ${ex.hasPass ? `
    <div class="hint">
      ${t('pass_hint', { exchange: ex.name })}
    </div>` : ''}

    <div class="field-group">
      <label>${ex.isEth ? t('label_wallet') : t('label_api_key')}</label>
      <input class="field-input" id="apiKeyIn" type="text"
             value="${creds.apiKey || ''}"
             placeholder="${ex.isEth ? t('ph_wallet') : t('ph_api_key')}" autocomplete="off">
    </div>

    <div class="field-group">
      <label>${ex.isEth ? t('label_private_key') : t('label_secret_key')}</label>
      <input class="field-input" id="secretIn" type="password"
             value="${creds.secret || ''}"
             placeholder="${ex.isEth ? t('ph_private_key') : t('ph_secret_key')}" autocomplete="off">
    </div>

    ${ex.hasPass ? `
    <div class="field-group">
      <label>Passphrase</label>
      <input class="field-input" id="passIn" type="password"
             value="${creds.passphrase || ''}" placeholder="${t('ph_passphrase')}" autocomplete="off">
    </div>` : ''}

    <div class="actions">
      <button class="btn-primary" id="saveBtn"${state.saving?' disabled':''}>
        ${state.saving ? t('btn_saving') : t('btn_save')}
      </button>
      <button class="btn-secondary" id="testBtn"${state.testing?' disabled':''}>
        ${state.testing ? t('btn_testing') : t('btn_test')}
      </button>
      <button class="btn-danger" id="clearBtn">${t('btn_clear')}</button>
    </div>

    ${state.msg ? `<div class="msg ${state.msg.type}">${state.msg.text}</div>` : ''}
  </div>

  <div class="security-note">
    <strong>${t('security_title')}</strong>
    <p>${t('security_body')}</p>
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
  document.getElementById('langBtn')?.addEventListener('click', async () => {
    await cycleLang();
    render();
  });
}

async function doSave() {
  const apiKey     = document.getElementById('apiKeyIn')?.value?.trim();
  const secret     = document.getElementById('secretIn')?.value?.trim();
  const passphrase = document.getElementById('passIn')?.value?.trim();
  if (!apiKey || !secret) return showMsg(t('msg_need_key_secret'), 'error');
  const ex = EXCHANGES.find(e => e.id === state.cur);
  if (ex.hasPass && !passphrase) return showMsg(t('msg_need_pass'), 'error');

  state.saving = true; render();
  const creds = { apiKey, secret };
  if (passphrase) creds.passphrase = passphrase;

  state.creds[state.cur] = creds;
  await chrome.storage.local.set({ [`credentials_${state.cur}`]: creds });
  state.saving = false;
  showMsg(t('msg_save_ok'), 'success');
  render();
}

async function doTest() {
  const apiKey     = document.getElementById('apiKeyIn')?.value?.trim();
  const secret     = document.getElementById('secretIn')?.value?.trim();
  const passphrase = document.getElementById('passIn')?.value?.trim();
  if (!apiKey || !secret) return showMsg(t('msg_need_key_first'), 'error');
  const ex = EXCHANGES.find(e => e.id === state.cur);
  if (ex.hasPass && !passphrase) return showMsg(t('msg_need_pass_first'), 'error');

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
    showMsg(t('msg_test_ok'), 'success');
  } catch (e) {
    showMsg(t('msg_test_fail', { error: e.message }), 'error');
  }
  state.testing = false; render();
}

async function doClear() {
  const ex = EXCHANGES.find(e => e.id === state.cur);
  if (!confirm(t('confirm_clear', { exchange: ex.name }))) return;
  delete state.creds[state.cur];
  await chrome.storage.local.remove(`credentials_${state.cur}`);
  showMsg(t('msg_cleared'), 'info');
  render();
}

function showMsg(text, type) {
  state.msg = { text, type };
  setTimeout(() => { state.msg = null; render(); }, 4000);
}

document.addEventListener('DOMContentLoaded', init);
