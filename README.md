# Coinank Trader

> 一款专为加密货币交易者打造的 Chrome 浏览器插件，支持在 [Coinank](https://coinank.com) 页面快速下单，无需跳转交易所官网。

<div align="center">

![Version](https://img.shields.io/badge/版本-1.0.0-blue)
![License](https://img.shields.io/badge/许可证-MIT-green)
![Chrome](https://img.shields.io/badge/Chrome-Manifest%20V3-orange)

</div>

---

## ✨ 功能特性

- **5 大主流交易所**：Binance、OKX、Bybit、Bitget、Hyperliquid
- **3 种订单类型**：市价单、限价单、止损单
- **现货 & 合约**：一键切换市场类型（Hyperliquid 仅合约）
- **订单管理**：查询挂单 / 历史订单，支持一键撤单
- **账户余额**：实时显示可用余额
- **安全存储**：API Key 仅保存在本地浏览器，绝不上传至任何服务器
- **深色主题**：专为交易场景优化的 UI 设计

---

## 📸 界面预览

```
┌─────────────────────────────────────┐
│  ⬡ Coinank Trader    [Binance ▼] ⚙  │
├─────────────────────────────────────┤
│       [  交易  ]  [  订单  ]         │
├─────────────────────────────────────┤
│  交易对                 [现货][合约]  │
│  ┌─────────────────────────────┐    │
│  │ BTC/USDT                    │    │
│  └─────────────────────────────┘    │
│                                     │
│  [ 买入 / Long ]  [ 卖出 / Short ]  │
│                                     │
│  订单类型: [市价] [限价] [止损]      │
│  数量:  [0.001           BTC ]      │
│  价格:  [50000          USDT ]      │
│                                     │
│  预估金额    ≈ 50.00 USDT            │
│  ┌─────────────────────────────┐    │
│  │      限价买入 BTC/USDT       │    │
│  └─────────────────────────────┘    │
└─────────────────────────────────────┘
```

---

## 🚀 安装方式

### 方法一：从源码构建（推荐）

**1. 克隆仓库**

```bash
git clone https://github.com/coinank/ank-trade.git
cd ank-trade
```

**2. 安装依赖**

```bash
npm install
```

**3. 构建插件**

```bash
npm run build
```

构建完成后，扩展文件输出到 `extension/` 目录。

**4. 加载到 Chrome**

1. 打开 Chrome，访问 `chrome://extensions`
2. 开启右上角「**开发者模式**」
3. 点击「**加载已解压的扩展程序**」
4. 选择项目中的 `extension/` 目录

---

## ⚙️ 配置 API Key

点击插件右上角的 **⚙ 设置** 按钮，进入 API 配置页面。

### Binance

| 字段 | 说明 |
|------|------|
| API Key | 在 Binance「API 管理」页面创建 |
| Secret Key | 创建时显示一次，请妥善保存 |

> 权限设置：勾选「启用现货及杠杆交易」，**不要勾选提币权限**。

### OKX

| 字段 | 说明 |
|------|------|
| API Key | 在 OKX「API」页面创建 |
| Secret Key | 创建时显示一次 |
| Passphrase | 创建 API 时自行设置的密语 |

### Bybit

| 字段 | 说明 |
|------|------|
| API Key | 在 Bybit「API 管理」页面创建 |
| Secret Key | 创建时显示一次 |

### Bitget

| 字段 | 说明 |
|------|------|
| API Key | 在 Bitget「API 管理」页面创建 |
| Secret Key | 创建时显示一次 |
| Passphrase | 创建 API 时自行设置的密语 |

### Hyperliquid

Hyperliquid 是去中心化衍生品交易所，使用以太坊钱包授权：

| 字段 | 说明 |
|------|------|
| API Key | 填写你的**钱包地址**（0x...） |
| Secret Key | 在 Hyperliquid 应用中创建的 **API Wallet 私钥** |

> ⚠️ **强烈建议**：在 Hyperliquid 应用设置中创建专用的 API 子钱包，不要填写主钱包私钥。
>
> 操作路径：Hyperliquid 官网 → 右上角账户 → API → 生成 API 密钥

---

## 📖 使用指南

### 快速下单

1. 点击 Chrome 工具栏中的插件图标，打开交易面板
2. 顶部下拉菜单选择**交易所**
3. 填写**交易对**（如 `BTC/USDT`）
4. 选择**市场类型**：现货 / 合约
5. 点击 **买入** 或 **卖出**
6. 选择**订单类型**：

   | 类型 | 说明 |
   |------|------|
   | 市价 | 以当前最优价格立即成交 |
   | 限价 | 指定价格挂单，等待成交 |
   | 止损 | 设置触发价，价格达到后自动下单 |

7. 填写**数量**和**价格**（限价/止损单需要）
8. 确认「预估金额」后点击提交按钮

### 查看与撤销订单

1. 点击顶部「**订单**」标签
2. 切换「**挂单**」/ 「**历史**」查看对应订单
3. 点击「**撤单**」按钮撤销未成交订单
4. 点击 **↻** 按钮刷新订单列表

---

## 🛠️ 开发

### 目录结构

```
ank-trade/
├── extension/          # Chrome 扩展包（加载此目录）
│   ├── manifest.json
│   ├── popup.html
│   ├── options.html
│   ├── icons/          # 自动生成
│   └── dist/           # 构建输出，自动生成
├── src/                # 源代码
│   ├── background.js   # Service Worker（处理所有 API 请求）
│   ├── popup.js        # 交易界面逻辑
│   ├── options.js      # 设置页逻辑
│   ├── popup.css       # 交易界面样式
│   ├── options.css     # 设置页样式
│   └── exchanges/      # 各交易所 API 模块
│       ├── utils.js        # 公共工具（HMAC 签名等）
│       ├── binance.js
│       ├── okx.js
│       ├── bybit.js
│       ├── bitget.js
│       └── hyperliquid.js  # EIP-712 签名
├── scripts/
│   ├── build.js            # esbuild 构建脚本
│   └── generate-icons.js   # PNG 图标生成器
└── package.json
```

### 可用命令

```bash
npm run build    # 构建生产版本
npm run dev      # 构建 + 监听文件变化（开发模式）
npm run icons    # 仅重新生成图标
```

### 添加新交易所

在 `src/exchanges/` 下新建文件，导出以下函数：

```js
export async function placeOrder(credentials, params) {}
export async function cancelOrder(credentials, params) {}
export async function getOpenOrders(credentials, params) {}
export async function getOrderHistory(credentials, params) {}
export async function getBalance(credentials, params) {}
```

然后在 `src/background.js` 中注册该交易所即可。

---

## 🔒 安全说明

- 所有 API Key 通过 `chrome.storage.local` 存储在本地浏览器，**不会发送到任何第三方服务器**
- 所有交易所 API 请求**直接**从插件发往交易所官方 API，中间无代理
- 建议 API Key **只开启交易权限**，禁用提币权限
- Hyperliquid 建议使用专用子钱包，避免主钱包私钥暴露风险
- 请勿在不受信任的设备上使用

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

1. Fork 本仓库
2. 创建特性分支：`git checkout -b feature/your-feature`
3. 提交更改：`git commit -m 'feat: add your feature'`
4. 推送分支：`git push origin feature/your-feature`
5. 发起 Pull Request

---

## 📄 许可证

[MIT License](LICENSE) © 2024 Coinank
