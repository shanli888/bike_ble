# LVBU Web 智能码表 — Bluefy Web Bluetooth

纯静态单页 HTML，零依赖，直接丢进 Bluefy 打开即可使用。

## 文件结构

```
lvbu-ble/
├── index.html          # 入口（加载所有 JS/CSS）
├── css/style.css       # 样式（393px iPhone 竖屏基准）
├── js/
│   ├── util.js         # 通用工具（hex/uuid/队列/超时…）
│   ├── protocol.js     # 帧编解码器（可参数化帧头/长度/校验/字节序）
│   ├── config.js       # 默认配置 + 设置持久化
│   ├── adapter.js      # LVBU 协议适配层（命令字/帧构造/解析）
│   ├── ble.js          # Web Bluetooth 传输层
│   ├── app.js          # 应用核心（状态/命令下发/模拟数据）
│   ├── icons.js        # 内联 SVG 图标
│   ├── sim.js          # 演示数据源（无设备时运行）
│   └── ui.js           # 视图层：渲染 + 交互
├── tests/
│   ├── protocol.test.js  # 协议层单元测试（18 项全通过）
│   ├── serve.py          # 静态服务器（带 COOP/COEP）
│   └── smoke.py          # Playwright WebKit 冒烟测试
```

## 蓝牙协议（依据真实 README）

**帧格式：** `AA 55 <len> <cmd> <data...> <checksum>`
- `len` = 1（命令字）+ 数据长度
- **校验**：`0xFF - (sum & 0xFF)`，覆盖整帧含帧头（invsum8）

| 功能 | 命令字 | 帧示例 |
| --- | --- | --- |
| 重启设备 | `0x01` | `AA 55 01 01 FE` |
| 轮胎尺寸 27.5" | `0x02` | `AA 55 04 02 1C 02 BB 21` |
| 查询陀螺仪 | `0x10` | `AA 55 01 10 EF` |
| 校准陀螺仪 | `0x11` | `AA 55 01 11 EE` |
| 助力等级 0~5 | `0x20` | `AA 55 02 20 03 DB`（3 档） |
| 助力模式 | `0x21` | `AA 55 02 21 03 DA`（爬坡） |
| 停止助力 | `0x22` | `AA 55 02 22 00 DC` |
| 手动助力% | `0x23` | `AA 55 02 23 23 B8`（35%） |

## 助力控制逻辑

- **非手动模式**（通勤/运动/爬坡/休闲）：选择档位 0~5
- **手动模式**：0~100% 滑块（5% 步进）
- 所有操作需**停车确认**（速度 < 0.5 km/h）
- 切换模式或调整值后点击「确认下发」

## 在 Bluefy 中使用

1. 将 `lvbu-ble` 文件夹复制到手机
2. 用 Bluefy 打开 `index.html`
3. 点击顶部插头图标 → 选择你的 LvBu motor 设备
4. 连接后可在码表页查看实时数据

## 协议校准

如果实际帧格式与上述不同，可在「设置 → 协议参数」中修改：
- 帧头、长度字段语义、校验算法、字节序
- 修改后立即生效，无需改代码

## 构建 / 测试

```powershell
# 语法检查
Get-ChildItem lvbu-ble\js\*.js | ForEach-Object { node --check $_.FullName }

# 协议单元测试
node lvbu-ble\tests\protocol.test.js

# 启动静态服务器
python lvbu-ble\tests\serve.py lvbu-ble 8899
```
