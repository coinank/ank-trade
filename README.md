# Coinank Trader

> 专为加密货币交易者设计的 Chrome 侧边栏插件，支持五大主流交易所的快捷下单、实时行情、订单管理和持仓查看。

![版本](https://img.shields.io/badge/版本-1.0.1-blue) ![Manifest V3](https://img.shields.io/badge/Manifest-V3-green) ![ccxt](https://img.shields.io/badge/ccxt-4.x-orange)

---

## 功能特性

| 功能 | 说明 |
|------|------|
| **Side Panel 侧边栏** | 固定在浏览器右侧，全高显示，不遮挡页面 |
| **实时行情** | 每 3 秒自动刷新当前交易对最新价、涨跌幅、买卖价 |
| **市价单** | 二次确认后立即以市场价成交 |
| **限价单** | 指定价格挂单，等待市场到达 |
| **止损单** | 设置触发价，到达后自动执行（市价/限价） |
| **止盈单** | 设置触发价，到达后自动止盈 |
| **交易对搜索** | 输入关键词实时过滤，快速切换币种 |
| **比例快速填量** | 25% / 50% / 75% / 100% 余额一键填入数量 |
| **挂单查询** | 查看当前所有未成交订单，支持一键撤单 |
| **历史订单** | 查看最近 50 条成交/撤销记录 |
| **合约持仓** | 查看持仓量、开仓价、标记价、未实现盈亏、强平价 |
| **只减仓** | 合约下单支持 Reduce-only 模式 |
| **账户余额** | 实时显示各币种可用余额，30 秒自动刷新 |
| **Coinank 联动** | 在 coinank.com 浏览时自动同步当前交易对到侧边栏 |

---

## v1.0.1 更新

- 增加交易执行层市场类型校验：合约模式只允许 CCXT `swap` 交易对，现货模式只允许 `spot` 交易对，避免 UI 状态不同步时误下到错误市场。
- 合约下单前设置杠杆失败时会直接取消下单，不再静默继续提交订单。
- Bybit / Bitget 合约止损止盈改用 CCXT 统一 `stopLossPrice` / `takeProfitPrice` 语义。
- 补全 OKX / Bybit / Bitget 条件单、止损止盈单的查询和撤单路径。
- 切换现货 / 合约时自动同步到匹配的交易对，例如 `BTC/USDT` → `BTC/USDT:USDT`；找不到安全匹配时不自动猜测。
- Release 包：`release/coinank-trader-v1.0.1.zip`

---

## 支持交易所

| 交易所 | 现货 | 永续合约 | 止损单 | 止盈单 | 备注 |
|--------|------|----------|--------|--------|------|
| **Binance** | ✅ | ✅ | ✅ | ✅ | 需开启期货权限 |
| **OKX** | ✅ | ✅ | ✅ | ✅ | 止损/止盈走算法单接口 |
| **Bybit** | ✅ | ✅ | ✅ | ✅ | UNIFIED 账户 |
| **Bitget** | ✅ | ✅ | ✅ | ✅ | 止损/止盈走计划单接口 |
| **Hyperliquid** | ❌ | ✅ | ✅ | ✅ | 仅永续合约，需 API 钱包私钥 |

---

## 安装方法

### 方式一：直接下载（推荐）

1. 前往 [Releases](https://github.com/coinank/ank-trade/releases) 下载最新的 `coinank-trader-vX.X.X.zip`（当前版本：`coinank-trader-v1.0.1.zip`）
2. 解压 zip 文件
3. 打开 Chrome，访问 `chrome://extensions`
4. 右上角开启 **开发者模式**
5. 点击 **加载已解压的扩展程序**，选择解压后的 `extension/` 目录

### 方式二：从源码构建

```bash
git clone https://github.com/coinank/ank-trade.git
cd ank-trade
npm install
npm run build
```

然后在 Chrome 中加载 `extension/` 目录。

### 使用侧边栏

安装完成后，点击浏览器工具栏中的 **Coinank Trader 图标**，侧边栏将自动在浏览器右侧打开，再次点击可关闭。

---

## API Key 配置

点击侧边栏右上角 **⚙ 齿轮图标** 进入设置页面。

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

1. 点击工具栏图标打开侧边栏
2. 左上角选择 **交易所**
3. 顶部 Tab 栏右侧切换 **现货 / 合约**
4. 在交易对输入框中输入关键词搜索（如输入 `BTC` 过滤所有 BTC 交易对）
5. 选择订单类型：
   - **市价**：填数量，点击买入/卖出，二次确认后成交
   - **限价**：填价格和数量
   - **止损**：填触发价，可选填委托价（不填则触发后以市价执行）
   - **止盈**：填触发价，可选填委托价
6. 可用 **25% / 50% / 75% / 全仓** 按钮快速按余额比例填入数量
7. 点击 **买入** 或 **卖出**

### 查询订单与持仓

切换到 **订单** Tab：
- **挂单**：查看所有未成交订单，支持一键撤单
- **历史**：查看最近成交/撤销记录
- **持仓**（合约模式）：查看当前持仓的开仓价、标记价、未实现盈亏、强平价等

### Coinank 联动

在 [coinank.com](https://coinank.com) 浏览某个交易对时，侧边栏会自动切换到对应交易对，无需手动输入。

---

## 技术说明

| 组件 | 技术 |
|------|------|
| Chrome 扩展 | Manifest V3，Side Panel API，Service Worker |
| 交易所接口 | [ccxt](https://github.com/ccxt/ccxt) 4.x 浏览器包 |
| 构建工具 | esbuild |
| 签名算法 | 由 ccxt 内部处理（HMAC-SHA256、EIP-712 等） |
| 数据存储 | `chrome.storage.local`（本地，不同步至云端） |

**架构**

```
sidepanel.html / options.html
    │  chrome.runtime.sendMessage
    ▼
background.js (Service Worker)
    │  importScripts('ccxt.browser.min.js')
    │  makeExchange() / makePublicExchange()
    │  实例级缓存，markets TTL 1 小时
    ▼
ccxt → 各交易所 REST API

content.js (coinank.com)
    │  检测页面 URL / title 中的交易对
    │  chrome.runtime.sendMessage({ action: 'pageSymbol' })
    ▼
background.js → chrome.storage.local → sidepanel.html 自动同步
```

**止损/止盈单路由**

各交易所止损止盈单实现方式不同，由 background.js 统一适配：

| 交易所 | 止损实现 | 止盈实现 |
|--------|----------|----------|
| Binance | `stopLossPrice` 参数 → `STOP_MARKET` / `STOP_LOSS_LIMIT` | `takeProfitPrice` 参数 |
| OKX | `/order-algo` 算法单，`stopLossPrice` | `/order-algo`，`takeProfitPrice` |
| Bybit | `stopLossPrice` 参数 | `takeProfitPrice` 参数 |
| Bitget | 合约使用 `stopLossPrice`；现货触发单使用 `triggerPrice` | 合约使用 `takeProfitPrice`；现货触发单使用 `triggerPrice` |
| Hyperliquid | `stopLossPrice` → trigger 结构 | `takeProfitPrice` → trigger 结构 |

**交易安全保护**

- `background.js` 是插件的交易执行层，所有下单请求都会在这里再次校验交易对类型，不依赖 UI 状态作为唯一保护。
- 若 `marketType=perp` 但传入现货 symbol（如 `BTC/USDT`），或 `marketType=spot` 但传入合约 symbol（如 `BTC/USDT:USDT`），请求会被拒绝。
- 合约杠杆设置失败时不会继续下单，避免实际杠杆与用户选择不一致。
- CCXT 内置限频已启用，减少连续查询 / 下单触发交易所限频的风险。

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
├── extension/              # Chrome 插件目录（加载此目录到 Chrome）
│   ├── manifest.json
│   ├── sidepanel.html      # 侧边栏主页面
│   ├── popup.html          # 保留兼容
│   ├── options.html        # API Key 设置页
│   ├── icons/
│   └── dist/               # 构建产物（自动生成，勿手动修改）
│       ├── background.js
│       ├── ccxt.browser.min.js
│       ├── popup.js / popup.css
│       ├── sidepanel.css
│       └── options.js / options.css
├── src/
│   ├── background.js       # Service Worker（ccxt 请求路由）
│   ├── popup.js            # 交易 UI 逻辑（sidepanel 共用）
│   ├── popup.css           # 弹窗样式
│   ├── sidepanel.css       # 侧边栏样式
│   ├── content.js          # Coinank 页面交易对检测
│   └── options.js / css    # API Key 设置页
└── scripts/
    ├── build.js            # esbuild 构建脚本
    └── generate-icons.js   # 生成 PNG 图标
```

---

## 免责声明

本插件仅为个人交易工具，不构成任何投资建议。加密货币交易存在高风险，使用前请充分了解相关风险。作者不对任何交易损失承担责任。

---

## License

MIT
