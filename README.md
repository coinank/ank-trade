# Coinank Trader

> 专为加密货币交易者设计的 Chrome 侧边栏插件，支持五大主流交易所的快捷下单、实时行情、订单管理和持仓查看。

![版本](https://img.shields.io/badge/版本-1.0.3-blue) ![Manifest V3](https://img.shields.io/badge/Manifest-V3-green) ![ccxt](https://img.shields.io/badge/ccxt-4.x-orange)

---

## 功能特性

| 功能 | 说明 |
|------|------|
| **Side Panel 侧边栏** | 固定在浏览器右侧，全高显示，不遮挡页面 |
| **实时行情** | 每 3 秒自动刷新当前交易对最新价、涨跌幅、买卖价，丢弃已切换交易对的旧响应 |
| **市价单** | 二次确认后立即以市场价成交 |
| **限价单** | 指定价格挂单，等待市场到达 |
| **止损单** | 设置触发价，到达后自动执行（市价/限价） |
| **止盈单** | 设置触发价，到达后自动止盈 |
| **交易对搜索** | 输入关键词实时过滤，快速切换币种 |
| **比例快速填量** | 25% / 50% / 75% / 100% 余额一键填入数量 |
| **挂单查询** | 分页查询当前交易对的普通及条件挂单，支持一键撤单；读取上限和查询失败明确提示 |
| **历史订单** | 查看当前交易对最近 50 条成交/撤销记录 |
| **合约持仓** | 查看当前交易对的持仓量（基础币）、开仓价、标记价、未实现盈亏、强平价 |
| **只减仓** | 合约下单支持 Reduce-only 模式 |
| **账户余额** | 实时显示各币种可用余额，30 秒自动刷新 |
| **Coinank 联动** | 在 coinank.com 浏览时自动同步当前交易对到侧边栏 |

---

## v1.0.3 更新

- 下单与解除未确认限制共用交易所级锁，锁覆盖本地记录读写及完整下单过程；解除过程中不能进入新的提交，已解除的待提交意图也不能继续发单。
- 区分待提交、正在提交、结果未知三种状态，避免两个窗口同时提交时互相误判；同一请求去重，订单确认成功或明确拒绝后由后台清理记录，结果未知时持久保留，侧边栏关闭或后台重启后仍能恢复保护。
- 多条未确认记录按顺序解除，完成后重新读取本地状态，保留其它窗口新产生的未确认订单。
- Bitget 永续计划单撤单直接校验目标订单的 `successList` / `failureList` 业务结果，不再把 HTTP 成功误当作撤单成功；补齐 `moving_plan` 类型，并拒绝未知计划单类型。
- 增加反向解锁竞态、后台重启、并发提交、本地存储失败和撤单业务失败回归，覆盖列表到撤单的完整类型传递。
- Release 包：`release/coinank-trader-v1.0.3.zip`。此前 v1.0.2 候选包已被本版本替代，不应继续分发。

## v1.0.2 更新

- 修复市价确认绕过、切换 Tab 后重复下单、旧行情/余额/订单覆盖新交易上下文。
- 界面数量统一以基础币表示；线性永续下单时按 `contractSize` 转换成张数，并向下处理数量精度。精度归零时在设置杠杆和下单前拒绝，防止 Hyperliquid 零数量只减仓单造成整仓平仓。
- 当前合约支持范围为 **USDT/USDC 结算的线性永续**；币本位、反向及其他结算产品不展示，并由后台再次拒绝。
- 修复 Binance Algo、Bybit 现货 TP/SL、Bitget 计划单查询和撤单路由；普通父订单的预设止盈止损不会再被误认为计划单。条件单查询失败会明确显示错误。
- Bitget 止损/止盈统一使用有明确数量的触发委托（`normal_plan`），支持触发后市价/限价；以最新成交价校验触发方向，避免使用整仓止盈止损接口。触发依据为成交价。
- 修复 Bitget 现货市价买入的 quote cost 参数。现货市价买入按参考价换算花费金额，实际收到的基础币数量会随成交价及手续费变化。
- 识别 Binance、OKX、Bybit、Bitget 的单向/双向持仓模式；只减仓会发送对应持仓方向。保留现有 OKX / Hyperliquid 持仓的全仓/逐仓模式，Bitget 使用账户当前模式；无法确认模式时拒绝下单。OKX / Hyperliquid 无持仓时采用全仓。
- Bybit 所选杠杆已经一致（`110043`）时继续下单，其他杠杆错误仍阻断。
- 下单使用独立锁和客户端委托标识。结果未确认的订单会保存在本地；重新打开插件后仍须核对交易所挂单、成交和持仓，再解除下单限制。不会自动重试下单。
- 修复 Passphrase 缓存、余额舍入参与计算、市价比例填量引用旧限价和数字币名页面联动。
- Chrome 最低版本为 120；固定 CCXT npm 依赖版本，回归测试直接执行随包浏览器版本。
- Release 包：`release/coinank-trader-v1.0.2.zip`

## v1.0.1 更新

- 增加交易执行层市场类型校验：合约模式只允许 CCXT `swap` 交易对，现货模式只允许 `spot` 交易对，避免 UI 状态不同步时误下到错误市场。
- 合约下单前设置杠杆失败时会直接取消下单，不再静默继续提交订单。
- Bybit / Bitget 合约止损止盈改用 CCXT 统一 `stopLossPrice` / `takeProfitPrice` 语义。
- 补全 OKX / Bybit / Bitget 条件单、止损止盈单的查询和撤单路径。
- 切换现货 / 合约时自动同步到匹配的交易对，例如 `BTC/USDT` → `BTC/USDT:USDT`；找不到安全匹配时不自动猜测。
- Release 包：`release/coinank-trader-v1.0.1.zip`

---

## 支持交易所

| 交易所 | 现货 | 线性永续合约 | 止损单 | 止盈单 | 备注 |
|--------|------|----------|--------|--------|------|
| **Binance** | ✅ | ✅ | ✅ | ✅ | 需开启期货权限 |
| **OKX** | ✅ | ✅ | ✅ | ✅ | 止损/止盈走算法单接口 |
| **Bybit** | ✅ | ✅ | ✅ | ✅ | UNIFIED 账户 |
| **Bitget** | ✅ | ✅ | ✅ | ✅ | 止损/止盈走计划单接口 |
| **Hyperliquid** | ❌ | ✅ | ✅ | ✅ | 仅永续合约，需 API 钱包私钥 |

---

## 安装方法

### 方式一：直接下载（推荐）

1. 前往 [Releases](https://github.com/coinank/ank-trade/releases) 下载最新的 `coinank-trader-vX.X.X.zip`（当前版本：`coinank-trader-v1.0.3.zip`）
2. 解压 zip 文件
3. 打开 Chrome，访问 `chrome://extensions`
4. 右上角开启 **开发者模式**
5. 点击 **加载已解压的扩展程序**，选择解压后直接包含 `manifest.json` 的目录

### 方式二：从源码构建

需要 Node.js 20.19+、Chrome 120+；生成 ZIP 还需要系统 `zip` 命令。

```bash
git clone https://github.com/coinank/ank-trade.git
cd ank-trade
npm ci
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
- **持仓**（合约模式）：查看当前交易对的开仓价、标记价、未实现盈亏、强平价等；切换交易对后查询对应结算市场。

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
| Bybit | `triggerPrice` + 明确触发方向；现货 `tpslOrder` | `triggerPrice` + 明确触发方向；现货 `tpslOrder` |
| Bitget | `triggerPrice`（`fill_price`），合约走指定数量的 `normal_plan` | `triggerPrice`（`fill_price`），校验止盈触发方向 |
| Hyperliquid | `stopLossPrice` → trigger 结构 | `takeProfitPrice` → trigger 结构 |

**交易安全保护**

- `background.js` 是插件的交易执行层，所有下单请求都会在这里再次校验交易对类型，不依赖 UI 状态作为唯一保护。
- 合约只允许 USDT/USDC 线性永续；所有输入在私有写操作前完成精度及有效性检查。
- 若 `marketType=perp` 但传入现货 symbol（如 `BTC/USDT`），或 `marketType=spot` 但传入合约 symbol（如 `BTC/USDT:USDT`），请求会被拒绝。
- 合约杠杆设置失败时不会继续下单，避免实际杠杆与用户选择不一致；Bybit 明确返回“杠杆已一致”时继续执行。
- CCXT 内置限频已启用，减少连续查询 / 下单触发交易所限频的风险。

---

## 本地开发

```bash
# 监听模式（保存后自动重新构建）
npm run dev

# 单次构建
npm run build

# 离线回归（不使用凭据、不发送真实订单）
npm test

# 构建、回归通过后生成版本 ZIP
npm run release

# 用实际构建包验证五家公开市场/行情（联网、不使用凭据）
npm run smoke:public
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
