# Coinank Trader

> 专为加密货币交易者设计的 Chrome 插件，支持五大主流交易所的快捷下单、订单管理和账户余额查看。

![版本](https://img.shields.io/badge/版本-1.0.0-blue) ![Manifest V3](https://img.shields.io/badge/Manifest-V3-green) ![ccxt](https://img.shields.io/badge/ccxt-4.x-orange)

---

## 功能特性

| 功能 | 说明 |
|------|------|
| **市价单** | 立即以当前市场价成交 |
| **限价单** | 指定价格挂单，等待市场到达 |
| **止损单** | 设置触发价，到达后自动执行（市价/限价） |
| **挂单查询** | 查看当前所有未成交订单 |
| **历史订单** | 查看最近 50 条成交/撤销记录 |
| **一键撤单** | 直接从订单列表撤销任意订单 |
| **账户余额** | 实时显示各币种可用余额 |
| **现货/合约** | 支持切换现货和永续合约 |

---

## 支持交易所

| 交易所 | 现货 | 永续合约 | 止损单 | 备注 |
|--------|------|----------|--------|------|
| **Binance** | ✅ | ✅ | ✅ | 需开启期货权限 |
| **OKX** | ✅ | ✅ | ✅ | 止损单走算法单接口 |
| **Bybit** | ✅ | ✅ | ✅ | UNIFIED 账户 |
| **Bitget** | ✅ | ✅ | ✅ | 止损单走计划单接口 |
| **Hyperliquid** | ❌ | ✅ | ✅ | 仅永续合约，需 API 钱包私钥 |

---

## 安装方法

### 1. 克隆仓库并安装依赖

```bash
git clone https://github.com/coinank/ank-trade.git
cd ank-trade
npm install
npm run build
```

### 2. 加载到 Chrome

1. 打开 Chrome，访问 `chrome://extensions`
2. 右上角开启 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择项目中的 `extension/` 目录
5. 插件图标出现在浏览器工具栏

---

## API Key 配置

点击插件图标 → 右上角齿轮图标 → 进入设置页面。

> ⚠️ **安全提示**：API Key 仅存储在本地浏览器（`chrome.storage.local`），不会上传任何服务器。强烈建议只开启交易权限，**禁止开启提现权限**。

### Binance

1. 登录 Binance → 右上角头像 → **API 管理**
2. 创建 API Key，勾选 **启用现货及杠杆交易**
3. 如需合约交易，另勾选 **启用期货**
4. 填入 `API Key` 和 `Secret Key`

### OKX

1. 登录 OKX → 右上角头像 → **API**
2. 创建 API Key，权限选择 **交易**
3. 填入 `API Key`、`Secret Key` 和 **Passphrase**

### Bybit

1. 登录 Bybit → 右上角头像 → **API**
2. 创建 API Key，勾选 **合约订单** 和 **现货订单**
3. 填入 `API Key` 和 `API Secret`

### Bitget

1. 登录 Bitget → 右上角头像 → **API 管理**
2. 创建 API Key，权限选择 **交易**
3. 填入 `API Key`、`Secret Key` 和 **Passphrase**

### Hyperliquid

Hyperliquid 使用 **API 钱包**机制，与其他交易所不同：

1. 登录 [Hyperliquid](https://app.hyperliquid.xyz) → 右上角 → **API**
2. 点击 **Generate API Wallet**，系统生成专用 API 钱包
3. 在插件设置中：
   - **API Key** 填写：你的**主钱包地址**（`0x...`）
   - **Secret** 填写：API 钱包的**私钥**（`0x` 开头的 64 位十六进制字符串）

---

## 使用指南

### 下单

1. 点击插件图标，左上角选择交易所
2. 选择 **现货** 或 **合约**
3. 输入交易对（如 `BTC/USDT`）
4. 选择订单类型：
   - **市价**：直接填数量，点击买入/卖出
   - **限价**：填价格和数量
   - **止损**：填触发价，可选填委托价（不填则触发后以市价执行）
5. 点击 **买入** 或 **卖出**

### 查询订单

- **挂单** 标签：查看所有未成交订单，支持一键撤单
- **历史** 标签：查看最近成交/撤销记录

### 余额

交易界面上方自动显示当前账户余额，按交易对展示对应币种（如 BTC/USDT 显示 BTC 和 USDT 可用余额）。

---

## 技术说明

| 组件 | 技术 |
|------|------|
| Chrome 扩展 | Manifest V3，Service Worker |
| 交易所接口 | [ccxt](https://github.com/ccxt/ccxt) 4.x 浏览器包 |
| 构建工具 | esbuild |
| 签名算法 | 由 ccxt 内部处理（HMAC-SHA256、EIP-712 等） |
| 数据存储 | `chrome.storage.local`（本地，不同步至云端） |

**为什么选择 ccxt？**

ccxt 是业界最广泛使用的加密货币交易所 API 库，由社区持续维护，覆盖 100+ 交易所。使用 ccxt 的优势：

- 交易所 API 变更时，只需 `npm update ccxt` 即可跟进，无需手动维护签名逻辑
- 统一接口屏蔽各交易所的参数差异（如 OKX 止损单路由到算法接口、Bitget 路由到计划单接口）
- 经过大量生产环境验证，稳定可靠

**架构**

```
popup.html / options.html
    │  chrome.runtime.sendMessage
    ▼
background.js (Service Worker)
    │  importScripts('ccxt.browser.min.js')
    │  makeExchange() → ccxt 实例（实例级缓存，markets 只加载一次）
    ▼
ccxt → 各交易所 REST API
```

**止损单路由**

各交易所止损单实现方式不同，ccxt 内部自动处理：

| 交易所 | 实现方式 | ccxt 触发条件 |
|--------|----------|---------------|
| Binance | `STOP` / `STOP_MARKET` (合约) `STOP_LOSS_LIMIT` (现货) | `stopLossPrice` 参数 |
| OKX | `/api/v5/trade/order-algo` (算法单) | `stopLossPrice` 参数 → `ordType=conditional` |
| Bybit | `triggerPrice` 条件单 | `triggerPrice` + `triggerDirection` 参数 |
| Bitget | `/v2/mix/order/place-plan-order` (计划单) | `triggerPrice` 参数 → `planType=normal_plan` |
| Hyperliquid | trigger 订单 | `stopLossPrice` 参数 → trigger 结构 |

---

## 本地开发

```bash
# 监听模式（保存后自动重新构建）
npm run dev

# 单次构建
npm run build
```

修改代码后，在 `chrome://extensions` 页面点击插件卡片上的**刷新按钮**，使 Service Worker 加载最新代码。

---

## 目录结构

```
ank-trade/
├── extension/            # Chrome 插件目录（加载此目录到 Chrome）
│   ├── manifest.json
│   ├── popup.html
│   ├── options.html
│   ├── icons/
│   └── dist/             # 构建产物（自动生成，勿手动修改）
│       ├── background.js
│       ├── ccxt.browser.min.js
│       ├── popup.js/css
│       └── options.js/css
├── src/
│   ├── background.js     # Service Worker（ccxt 请求路由，~180 行）
│   ├── popup.js/css      # 交易 UI
│   └── options.js/css    # API Key 设置页
└── scripts/
    ├── build.js          # esbuild 构建脚本
    └── generate-icons.js # 生成 PNG 图标
```

---

## 免责声明

本插件仅为个人交易工具，不构成任何投资建议。加密货币交易存在高风险，使用前请充分了解相关风险。作者不对任何交易损失承担责任。

---

## License

MIT
