# 力储未来能源综合管理系统 · 智能体交接包（合并版）

> 本文件是 `agent-pack/` 下全部内容的合并单文件版本，供一次投喂给无法读取文件的智能体使用。
> 项目：H:\dianzhan · 线上：https://mqtt.ykdesign.top/dianzhan/ · 生成日期 2026-10-27

## 目录

1. README.md
2. 01-项目总览.md
3. 02-代码地图.md
4. 03-本地开发与部署.md
5. 04-领域与业务规则.md
6. 05-约定与红线.md
7. 06-未闭环与坑.md


---

# 【README.md】

# 力储未来能源综合管理系统 · 智能体交接包

> 这份包是写给**另一个 AI 智能体**（或新接手的开发者）的：看完就能上手改这个项目，
> 不用再从代码里反推项目在干什么、哪些规则不能碰。
>
> 项目根：`H:\dianzhan`（git 仓库 `liubababa/lichu-monitor`，**公开仓库**）
> 线上入口：`https://mqtt.ykdesign.top/dianzhan/`

---

## 一、这个包怎么看（给智能体的读数顺序）

| 顺序 | 文件 | 你会得到什么 |
|---|---|---|
| 1 | `01-项目总览.md` | 这是什么产品、几个电站、数据从哪来、线上跑在哪 |
| 2 | `02-代码地图.md` | 每个文件干什么、UI 怎么切、数据怎么流、3D 场景怎么组织 |
| 3 | `03-本地开发与部署.md` | 本地怎么跑起来（命令+端口）、怎么部署、GitHub 怎么推 |
| 4 | `04-领域与业务规则.md` | 电力业务的硬规则：功率符号、工况判定、配色口径、电价与收益口径 |
| 5 | `05-约定与红线.md` | 编辑约定、数据纯度、凭据纪律、3D 场景规则、验收标准 |
| 6 | `06-未闭环与坑.md` | 待厂家确认的事、已知遗留缺陷、本机环境坑 |

**只有一次投喂机会**（对方没法读文件）时，用 `ALL-IN-ONE.md` —— 它是以上全部内容的合并单文件版。

**项目根目录的 `AGENTS.md`** 是给"会自动读项目根约定文件"的智能体看的精简版（规则速查 + 指向本包）；
本包内**没有**它的副本。

项目自己那几份文档（`handoff.md` 本地链路排查、`部署指南.md` 线上部署、两份厂家协议「交叉印证」、
`晶农EMS协议问题清单.md`）**留在项目根目录**，本包内不复制——拿不到仓库时从根目录取。
（两份「接入参数」文档含口令，**不在包里**，需要时从项目根目录取。）

---

## 二、最短上手路径（3 步）

1. 读 `01` + `02`，建立"静态前端 + tools 下一堆 Node 服务"的心智模型；
2. 读 `05`，把红线记住（**版本号必须提、不许有模拟数据、凭据不进仓库、别写死颜色**）；
3. 要真正验证改动 → 按 `03` 把本地四件套跑起来（broker 1884 / 网关 9002 / 模拟器 / 静态站点 8080），
   浏览器打开 `http://127.0.0.1:8080/index.html`，按面板填参数连上，用真实报文看效果。

---

## 三、三条最容易踩的坑（先记住）

1. **改了 js/css 一定要提 `index.html` 里的 `?v=YYYYMMDD字母` 版本号**，否则线上页面"看着没变"（缓存）；
   每个文件各管各的版本号，不是统一的。
2. **项目里不许出现模拟/演示数据**（业务数据），没有数据就显示 `--` / 0；唯一例外是本地调试页 `solar-demo.html`
   （未部署，只在本地跑）；洙边三维页上的「演示工况」下拉已于 2026-10-29 移除，别再加回线上页面。
3. **这个仓库是公开的**：任何口令、token、账号、服务器密码都不能进代码；凭据类文件已写进 `.gitignore`，
   历史上还做过一次全历史清洗，别再把它们加回来。

---

## 四、维护这份包的约定

改动了架构、业务流程、约定或坑时，**顺手更新本包对应文件**（它和 `部署指南.md`、`handoff.md` 是一套东西）。
本包内容不含任何凭据；如果新增内容涉及凭据，只写"在哪、什么用途"，不写值。


---

# 【01-项目总览.md】

# 01 · 项目总览

## 一句话

**「力储未来能源综合管理系统」** 是一个面向工商业储能/光伏电站的网页监控平台：
纯静态前端（无构建工具）+ 一组常驻的 Node 采集/接入服务，把现场设备（高特 CCU、晶农 EMS）
和两家厂家云（阳光电源 iSolarCloud、东方日升日升云）的数据汇总成一套统一界面展示，并支持反向下发控制。

---

## 品牌与命名（改错名字是常见事故）

| 项 | 值 |
|---|---|
| 产品名 | **力储未来能源综合管理系统**（英文副标题 LICHU FUTURE INTEGRATED ENERGY MANAGEMENT SYSTEM） |
| 已废弃旧名 | 「力储未来远程监控平台」——**任何地方都不该再出现** |
| 公司主体 | 力储未来（临沂）能源科技有限责任公司（用在屏保等品牌面） |
| 域名 | `ykdesign.top`（阿里云注册 + 阿里云云解析） |
| 注意 | **站名/设备名 ≠ 产品名**。本站站名「力储未来储能电站」、设备名「力储未来1-2」是**现场实体名**，不要因为产品改名而顺手改掉 |

命名规则：窗口/页面标题是「`<站名>`监测平台」（不能退化成设备 SN，例如不能出现「R250907J0038运行监测图」）。

---

## 站点清单与数据源对照（最重要的一张表）

| 站点 | 物理构成 | 数据源（厂商） | 前端入口 |
|---|---|---|---|
| **旭日东明储能电站**（现场口称"莒南站"） | 125 kW/261 kWh 工商业**液冷**储能柜 ×5 堆；园区**厂房**作为负荷；并网**铁塔**（三跨 10kV 导线）；两台 CCU：`R250907J0038`（在线，默认站）、`R250907J0037`（离线） | **高特 CCU 设备侧 MQTT**（`/{ProductSN}/{DeviceSN}/rtg|cmd|history/...`，30 秒周期） | 页签「设备总览 / 电站监控 / 详细信息 / 电芯健康」（策略页 `display:none` 停用）；三维 `js/gaote-scene3d.js` |
| **洙边卫生院站**（光伏 + 储能） | 屋顶光伏 **110.16 kWp**（`ps_id 2355743`）；储能柜（EMS/金盾 SN `25050015`，SYL 电池 + 恩玖 PCS）；并网铁塔；**卫生院**两层小楼作为负荷；**墙根三通黑盒是全站并网点**，五条电缆（光伏干线 / 储能线 / 电网线 / 负载线 / 电网直供线）全部取直、零交叉 | 光伏：**阳光电源 iSolarCloud**（HTTP OAuth2，5 分钟轮询）<br>储能柜：**东方日升日升云**（`cloud.risen.com`，1 分钟轮询，柜子自己 4G 上报）<br>天气：**Open-Meteo**（免 key） | 页签「电站监控/储能/光伏/详细信息」；三维 `js/solar-scene3d.js` |
| **其他电站** | 未登记的高特协议设备，自动发现 | 同高特 | 站点目录里自动分级 |

两条硬规则（用户明确纠正过）：
1. **两家厂商的设备/协议/参数绝不混用、不交叉引用**——「阳光云是光伏设备，日升云是储能设备…是两家厂商」；
   文件命名按厂商前缀区分：`solar-*`（阳光电源/光伏）、`risen-*`（东方日升/储能）、`gaote-*`（高特 CCU）、`zhhn-*`（晶农）。
2. **两家云的账不能混着算**（详见 `04-领域与业务规则.md`）：日升云=结算口径，阳光云=只报发电量。

---

## 线上拓扑（实测现状）

```
现场设备(高特CCU / 晶农EMS) ──1883/tcp 明文──► mosquitto ──ws 8083──► nginx(wss://.../mqtt) ──► 浏览器
阳光电源 iSolarCloud ──HTTP──► lichu-solar(8096) ──nginx /solar──► 浏览器 (js/solar.js)
东方日升 日升云      ──HTTP──► lichu-risen(8097) ──nginx /risen──► 浏览器
mosquitto ──订阅#──► lichu-history(8095) ──nginx /history,/daily──► 浏览器 (gaote-detail.js 曲线)
```

| 项 | 值 |
|---|---|
| 服务器 | 腾讯云轻量 **43.129.27.206**（实例名 `lichu-mqtt`，Ubuntu + mosquitto + nginx） |
| 唯一入口 | **`https://mqtt.ykdesign.top/dianzhan/`**（文件在 `/var/www/lichu`）；`lichu.ykdesign.top` 与 `ykdesign.top/dianzhan/` 均 **301** 跳到这里 |
| 其它站点 | `ykdesign.top`/`www` → `/var/www/portfolio`（作品集，浅克隆自 GitHub，服务器上 `git pull` 更新），与监控平台无关 |
| 设备接入 | mosquitto **1883 明文 + 账号**：`zhhn_ems`(晶农) / `gaote_ccu`(高特) / `lichu_web`(网页) / `lichu_log`(留痕) / `lichu_hist`(历史) / `lichu_gw`(网关) |
| 网页接入 | `wss://mqtt.ykdesign.top/mqtt` → nginx 反代 `127.0.0.1:8083`；**网页必须填 `lichu_web` 账号密码**否则连不上（填了才有下发权限） |
| TLS | Let's Encrypt + certbot 自动续期；`8883` 已放行（现场暂用 1883 明文）；mosquitto 8883 复用 LE 证书 |
| 登录保护 | nginx HTTP Basic 保护整个 `/dianzhan` 与全部数据接口，靠服务器生成的口令（不进仓库） |
| systemd | `mosquitto` / `nginx` / `mqtt-watch`(报文留痕) / `mqtt-connlog`(连接留痕) / `lichu-history`(8095) / `lichu-solar`(8096) / `lichu-risen`(8097)；`mqtt-gateway`(8090) **已停用** |
| 安全组 | 只放行 `1883`(设备) 与 `443`(网页)；`8083`、`18083` 不对公网开放 |

**已放弃的方案（别重提）**：EMQX Cloud Serverless（2026-09-17 撤回，限制：单客户端最多 10 订阅且超限静默不投递、只有加密端口、额度用尽停服）；前后分离网关（2026-09-19 停用，为把链路从 4 段减到 3 段便于排查，代码与配置都还在，可一条命令恢复）。

---

## 三套协议并存（别搞混）

| 协议 | 用在哪 | 现状 |
|---|---|---|
| **高特 CCU 设备侧 MQTT** | 旭日东明 + 其他自动发现设备 | **在用**，前端解析在 `js/gaote.js`，点表 `js/gaote-points.js` |
| **晶农 EMS 北向 MQTT**（`zhhn/...`） | 中和汇能的 EMS | 协议层完整实现（`js/mqtt.js` + `js/points.js`），**当前现场没有设备用它**；仍有待厂家回答的阻塞项 |
| **厂家云 HTTP 接入** | 阳光电源（光伏）、东方日升（储能） | 在用，各一个独立服务 + 独立凭据 |

---

## 当前状态（快照，2026-10-27）

- git：本地 `main` 与 `origin/main` 同步在 `e584450`（2026-10-24 部署后同步版本号）。
- 本地未提交改动只有两处：`index.html`（`solar-scene3d.js` 版本号 → `20261027a`）、
  `js/solar-scene3d.js`（新增"电线一键隐藏" `?nowires=1`，截图核对走向用）；两处已于 2026-10-27 14:22 部署到线上。
- 线上 `/var/www/lichu` 与本地仓库**逐字节一致**；唯一落后的是服务端 `/opt/lichu-solar/solar-service.js`
  （仍是 10-10 版，本地 10-23 版含趋势缓存与长区间降采样，**未部署**）。
- 近期工作重点：洙边三维场景的走线 / 工况可视化校正；服务侧趋势缓存。
- **改完要跑部署脚本才算上线**（用户认为"上线"属于完成的一部分）。


---

# 【02-代码地图.md】

# 02 · 代码地图

## 一、前端的组织方式（先理解这个，否则改不动）

- **没有构建工具**：没有 npm/webpack/vite。每个 `js/*.js` 是传统 `<script>` 文件，向 `window` 挂一个全局对象。
- **第三方库不在 index.html 里**：`js/main.js` 在启动时按 `LIBS` 清单**异步注入** `libs/three.min.js`（three r128）、
  `libs/echarts.min.js`（5.4.3）、OrbitControls / CSS2DRenderer / EffectComposer / RenderPass / ShaderPass /
  UnrealBloomPass / CopyShader / LuminosityHighPassShader（本地优先，失败退回 CDN）。
  `libs/mqtt.min.js` 单独加载，失败不致命。
  → **推论：绝不能在脚本顶层直接引用 `THREE` / `echarts` / `mqtt`**（那时还没注入），要用时在函数内惰性取。
- **加载顺序有讲究**：`index.html` 第 444–461 行固定顺序加载 18 个 js。顺序错了会拿到未定义的全局。
- **版本号约定（高频踩坑）**：每个资源引用带 `?v=YYYYMMDD<字母>`，字母在同一天内逐次递增（`20261016n → o → q`），
  跨天回到 `a`。**每个文件各管各的版本号**。改了哪个 js/css，就提哪个的版本号；部署脚本 `tools/deploy-site.js`
  会按 md5 比对自动生成新版本号，但**手工改代码后忘了提版本号 = 线上"看着没变"**（缓存）。
  当前版本号（2026-10-27 快照）：`solar-scene3d.js 20261027a`、`gaote-scene3d.js 20261024q`、
  `solar.js 20261023b`、`data.js / mqtt-ui.js / main.js 20261016o`、`gaote-detail.js 20261016q`、
  其余多为 `20261016n`；`css/style.css 20261021a`。

### js/ 文件一览（19 个）

| 文件 | 全局对象 | 作用 |
|---|---|---|
| `data.js` | `APP_CONFIG` / `DataService` | 配置 + **标准数据快照**的唯一入口 `DataService.mqttReport(report)`；默认站点名、默认 MQTT 参数（线上 wss 地址、ProductSN、设备 SN）都在这里 |
| `points.js` | `POINTS` | 晶农 EMS 点表（自动生成，勿手改） |
| `mqtt.js` | `MqttService` | 晶农 EMS 北向协议（`zhhn/...`），含登录/召测/下发/清单 |
| `gaote-points.js` | `GAOTE` | 高特 CCU 点表（自动生成，来自 `refs/SJ2025B3781ESCCU-MQTT.xlsx`，用 `python tools/gen-gaote-points.py`） |
| `gaote.js` | `GaoteService` | 高特协议解析：主题解析 `parseTopic`→`ingest`→800ms 去抖→`pushToUI()`→`DataService.mqttReport()`；`MAP` 是高特字段→平台字段的**唯一**翻译表；`buildTags()` 伪造晶农风格的设备类型以复用整套 UI |
| `gaote-view.js` | `GaoteView` | 高特"设备总览"大屏（九大板块），自轮询 2 秒 |
| `gaote-detail.js` | `GaoteDetail` | "详细信息"页（KPI、尖峰平谷、收益、3 天曲线）；曲线走 `/daily`、`/history`（本地 8095） |
| `gaote-scene3d.js` | `GaoteScene3D` / `GaoteWeather` | **旭日东明三维场景**（工况判定、堆自动排布、能量流光纹、天气） |
| `gaote-strategy.js` | `GaoteStrategy` | 充放电策略表单（由点表 `setpoints` 生成），发 `/{PSN}/{DSN}/cmd/set/emu/{功能}` |
| `overview.js` | `OverviewUI` | 晶农九大板块设备总览 |
| `mqtt-ui.js` | `MqttUI` | **接线中枢**：连接胶囊/配置抽屉/报文日志/设备列表/策略/电芯健康/KPI 措辞；页签分发 `openTab()`；启动后 600ms 自动连接 |
| `portal.js` | `PortalUI` | 站点目录（进门页）+ 设备列表页；站点登记表 `STATIONS` 在这里 |
| `screensaver.js` | `ScreenSaver` | 30 分钟无操作屏保（解析时自初始化），深底青配色、logo+品牌+大标题 |
| `solar.js` | `SolarUI` | **洙边站控制器**：HTTP 轮询（60 秒）、储能/光伏/收益三个页面渲染、演示工况下拉、四个页签挂载 |
| `solar-scene3d.js` | `SolarScene` | **洙边三维场景**（楼体+屋顶光伏阵列+储能柜+铁塔+五条能量流+天气） |
| `solar-scene3d-v2.js` | `SolarSceneV2` | 只在 `solar-preview.html` 用的独立预览版，**绝不能加进 `index.html`**（顶层 `let` 会污染全局） |
| `scene3d.js` | `Scene3D` | 晶农协议的通用储能场景（非高特协议时的兜底分支） |
| `charts.js` | `Charts` | 两个 ECharts 图（PCS 运行情况、主要设备负载） |
| `main.js` | （副作用）`S3D` | 启动引导：注入 libs → 主题（`dianzhan.theme`）→ 协议感知选择三维模块 → 绑定 UI → 发射 resize |

其它前端资产：`css/style.css`（全部样式，含日夜双主题，`:root` 与 `html[data-theme="day"]` 两处令牌）；
`libs/`（第三方库 + logo 三件套）；`views/`（工程视图 PNG，用于建模时对齐）；`solar-preview.html`（洙边场景独立预览页）。

### 视图结构与切换

```
#portal（进门页，PortalUI）
  ├─ 洙边 → SolarUI.open()   → #solarView + #solarTabs(电站监控/储能/光伏/详细信息)
  └─ 其它站 → MqttUI.selectStation() → #main + #mainTabs(总览/监控/详细信息/策略/健康)
#main：左=三维 #scene3d，右=滑出数据面板
覆盖层：#mqttPanel(数据源配置) / #logPanel(报文) / #deviceView(设备列表) / #devModal / #screenSaver / #bootLoading
```

- 页签切换不是"渲染新页面"，而是**显示/隐藏 DOM + 事件委托**：
  `MqttUI.openTab(name)`（`mqtt-ui.js:753`）、`SolarUI.mountTab()`（`solar.js:752`，靠 `#slBlocks` 卡片池**移动**同一批节点）。
  新增卡片块必须登记到 `solar.js:758` 的 `conf` 表里。
- 隐藏 3D 宿主会塌成 0×0：任何隐藏/显示 WebGL 容器的逻辑，恢复后必须补一次 resize（`SolarUI.hide()` 就是这么干的）。
- 已知隐藏项：`strategy` 页签被 `display:none`（停用但代码保留，一句话可恢复）；`health` 在协议=高特时隐藏。

### 数据流

- **高特**：`GaoteService.connect()` 订阅 `/{PSN}/{DSN}/#` 等 → `parseTopic` → `ingest`（按设备/维度存 `stateByDev`）
  → 800ms 去抖 → `pushToUI()` → `buildPseudoReport()` → **`DataService.mqttReport()`** → 快照 → 各视图。
  丢弃超过 900 秒的补传帧（`STALE_SEC`）。多设备用 `setActive()` 切换，状态按 `psn/dsn` 分组。
- **晶农**：`MqttService` 订阅 `zhhn/Post/Login/+`、`zhhn/Post/PeriodReport/+`、`zhhn/GetRsp/#`、`zhhn/SetRsp/#`
  （用 `#` 是因为应答主题段数不一致）→ 同样汇入 `DataService.mqttReport()`。
- **洙边**：不走 MQTT，走 HTTP 轮询（60 秒）：
  - 光伏：`{API}/summary|devices|trend|weather`，线上同源 `/solar/*`，本地 `http://127.0.0.1:8099`（`solar.js:100`）；
  - 储能：`{API_STOR}/full|trend|revenue-trend|power-trend`，线上 `/risen/*`，本地 `http://127.0.0.1:8097`；
  - 带 12 秒超时 + 最多 3 次重试，**刻意串行**（并发经站点代理会挂），90 秒自愈锁防止一次卡死拖垮后续刷新。
- **展示原则**：数据只来自设备/厂家接口；没有数据就 `--` / 0，**不做任何模拟兜底**。

### localStorage 键（换域名会导致配置"消失"，因为按域隔离）

| 键 | 内容 |
|---|---|
| `dianzhan.mqtt.cfg` | 连接配置（地址/账号/SN/协议/站名）；上线后内置了莒南默认参数，打开即自动连 |
| `dianzhan.theme` | `day` / `night` |
| `dianzhan.station.sel` / `dianzhan.station.cur` | 上次进入的站 / 当前站名（顶栏常驻显示） |
| `dianzhan.tariff` | 莒南电价（尖峰平谷深谷 + 装机参数） |
| `dianzhan.solar.tariff` | 洙边上网电价（默认 0.261，可点改） |
| `dianzhan.probe` | 探测 localStorage 是否可用（写完即删） |

---

## 二、3D 场景（这两个文件是工程量最大的地方）

| 站点 | 模块 | 容器 | 选择规则 |
|---|---|---|---|
| 旭日东明 | `gaote-scene3d.js` | `#scene3d` | `main.js:119 S3D()` → 协议=高特且有该模块时用它 |
| 晶农协议站 | `scene3d.js` | `#scene3d` | 兜底分支 |
| 洙边 | `solar-scene3d.js` | `#solar3d` | `SolarUI.ensureScene()` |

- 库：three r128 经典版 + addons（本地 `libs/`）。**不要动 `libs/` 里的任何第三方文件。**
- **主题表是唯一真源**：`solar-scene3d.js:66 THEMES` + `:104 FLOWC`（能量流配色）、`gaote-scene3d.js:36 THEMES` + `:181 TEXPAL`、
  `scene3d.js:19`、`css/style.css:13`（夜色）与 `:1023`（日色）。材质要经 `regThemeMat()` / `regMat()` 注册才会随主题切换。
  **不要把颜色内联写在绘制代码里**（文件里就有"别再各写各的"的警告注释）。
- 主题切换：`<html data-theme="day|night">`，由 `main.js:applyTheme` 扇出给各模块；`SolarScene` 自己用
  `MutationObserver` 订阅（不在扇出列表里）。
- **相机是算出来的，不是写死的**：`fitDistance()` 用二分法把关键点收进画面（`FIT_X=±0.70 / FIT_Y=±0.68`），
  进站时 `portal.js` 调 `resetView()` 归位。`camHome` 在建模时缓存一次，`controls.target` 必须等于 `camHome.tgt`。
  添加"应该被框进默认机位"的新几何 → 要同时把它的极值点加进 `fitStory()`/`fitPts`。
- **浮标（CSS2D）**：`label()` / `addCard()` 生成；按相机距离缩放（写 CSS 变量 `--lbl-scale`，带阈值避免每帧写样式）、
  按射线检测**被模型遮挡时自动隐藏**（只把大件注册为遮挡体，别把细杆也加进去）；打开明细卡时隐藏其它标签。
- **坐标与常量**（改设备位置必须连带改的东西）：
  - 洙边：`+z = 南`、`+x = 东`，原点=楼体中心；楼 13×6.2×8、屋顶阵列 5 列 ×4 排（倾角 28°）；
    储能柜 `CAB_X=-12.5 / CAB_Z=1.55`；铁塔 `TWR_X=-22 / TWR_Z=4.2`（高 10.4，塔基旁电缆终端箱 `TBOX_X=TWR_X+2.25`）。
    **墙根三通黑盒 `(-7.04, .22, .64)` 是全站并网点**（光伏干线落地进盒）；卫生院两个进线黑盒在
    西墙 `(-6.44, 1.02, 3.28)` / 南墙 `(-5.12, 1.02, 4.05)`。五条能量流（`pv` 光伏干线 / `sto` 储能线 /
    `grid` 电网线 / `load` 负载线 / `gl` 电网直供线）的**路径点列表是手调的、已全部取直且零交叉**，
    挪设备就要同步改 `addFlow()` 的路径与"电缆鞍座"数组。
  - 旭日东明：`MAXN=8` 堆、`GAP=5.2`；堆电缆建在**柜体局部坐标**下，在 `layoutStacks()` 里按 `world - cabinet.x` 重建。
- **截图辅助**：洙边 URL 带 `?nowires=1` → `hideWires()` 把所有电线藏起来（`type === 'Line'` 或 `TubeGeometry`：
  实体电缆 + 电流光纹 + 塔上导线/地线）；女儿墙描边是 `LineSegments`，不受影响——核对走线走向时用。
- **性能预算（已被优化过，别退回去）**：光伏组件/导轨/支腿用 `InstancedMesh` 合批；雨滴一个 InstancedMesh（420 滴）；
  洙边：泛光半分辨率、MSAA 走 `WebGLMultisampleRenderTarget`、**阴影贴图冻结**（`renderer.shadowMap.autoUpdate=false`）
  → 因此会动的物体（行人、叉车）**刻意不投影**。
  ⚠ 这些优化**只在洙边**（`solar-scene3d.js`）：旭日东明（`gaote-scene3d.js`）**没冻结阴影**、泛光全分辨率、
  标签缩放阈值 1%，别按"项目级预算"去套。

---

## 三、后端与工具（`tools/`，82 个文件）

### 常驻服务

| 文件 | 作用 | 启动 | 端口 |
|---|---|---|---|
| `local-broker.js` | 本地开发 broker（aedes）：TCP 给设备、WS 给页面 | `node tools/local-broker.js` | TCP **1884** / WS **9001**（路径 `/mqtt`） |
| `gateway.js` | 前后分离网关（页面⇄网关⇄厂家 broker）：匿名只读、登录应答、健康检查 | `node tools/gateway.js --upstream mqtt://127.0.0.1:1884 --listen 9002` | 默认 8083，线上 8090（**已停用**） |
| `history-service.js` | 订阅 broker 采样 SOC/储能功率落盘 + 查询接口 | `node tools/history-service.js --url mqtt://127.0.0.1:1884 --listen 8095` | **8095** |
| `solar-service.js` | 阳光电源 iSolarCloud 接入（OAuth2 + 5 分钟轮询 + 趋势落盘） | `node tools/solar-service.js --listen 8096 --dir <数据目录>` | **8096** |
| `risen-cloud-service.js` | 东方日升日升云接入（自动登录续期 + 快慢轮询） | `node tools/risen-cloud-service.js --port 8097` | **8097** |
| `solar-dev-relay.js` / `risen-dev-relay.js` | 本地开发转发器：本地 `/solar/*`、`/risen/*` → 线上同路径 | `node tools/solar-dev-relay.js` | **8099** / **8097** |
| `watch-broker.js` | 监视 `zhhn/#` + 自动回登录应答 + 落盘 | `node tools/watch-broker.js <host> <user> <pass> [秒]` | 无监听 |

### 模拟器与测试

- `ccu-simulator.js`：高特 CCU 模拟器（按点表周期上报全部维度 + 收到 `cmd/set` 1 秒后回读 `cmd/get`）。
- `ems-simulator.js`：晶农 EMS 模拟器（Login→等 PostRsp→PeriodReport→应答召测/下发/清单）。
- `test-gateway.js`（13 项断言，自起内部 broker）、`test-solar.js`（阳光 7 步验收）、
  `protocol-check.js` / `doc-conformance.js`（按厂家文档原文逐条验证晶农协议）。

### 服务端约定（新增集成照抄这套形状）

- 代码 `/opt/<svc>`，站点文件 `/var/www/lichu`，数据 `/var/lib/lichu-<svc>/`，
  凭据 `/etc/lichu-<svc>.env`（chmod 600），systemd 单元 `lichu-<svc>.service`，
  nginx `location /<name> → 127.0.0.1:<port>`，端口从 8095 起顺排。
- 部署脚本一律 `tools/deploy-<svc>.js`（ssh2 上传 + 建服务 + 自测），**必须可重复执行且不覆盖线上已有凭据**
  （`--force` 才覆盖），改 nginx 前先备份。
- `solar-service.js` 的三级缓存：内存快照 → 原始轮询日文件 `YYYY-MM-DD.jsonl`（留 3 天）→
  趋势缓存 `trend/YYYY-MM-DD.jsonl`（留 400 天，按天去重原子重写，缺天自动从原始日志回补）。

---

## 四、点表是"生成物"，不是手写文件

- `js/gaote-points.js` ← `python tools/gen-gaote-points.py`（输入 `refs/SJ2025B3781ESCCU-MQTT.xlsx`）。
- `js/points.js`（晶农）同样是生成物。
- 要改点表内容 → **改生成脚本再重新生成**；直接手改生成物会在下次生成时被覆盖。
- 生成脚本**会导出枚举**（`item['e']`，如堆状态 `0 停机/1 充电/2 放电/3 待机/4 故障`），前端按枚举渲染
  （`gaote-view.js:159 ARR_ST`）；协议未定义枚举的字段**显示原始码**，别自己下"正常/异常"结论。


---

# 【03-本地开发与部署.md】

# 03 · 本地开发与部署

## 一、本地跑起来（四件套）

```bash
# 0) 首次：装依赖（关键：aedes 必须是 0.51.3，装成 1.x 会出现"连上了但收不到 CONNACK"）
cd H:\dianzhan\tools && npm i

# 1) 本地 broker：TCP 1884（设备/模拟器）+ WS 9001（页面）
node tools/local-broker.js

# 2) 前后分离网关（页面连这里，上游指向本地 broker）
node tools/gateway.js --upstream mqtt://127.0.0.1:1884 --listen 9002

# 3) 高特 CCU 模拟器（演示用 5 秒周期；协议正常是 30 秒）
node tools/ccu-simulator.js --url mqtt://127.0.0.1:1884 --dsn SN2025B3781TEST --interval 5

# 4) 静态站点（不要用 file:// 打开）
cd H:\dianzhan && python -m http.server 8080 --bind 127.0.0.1
```

可选的本地联调组件：

```bash
node tools/history-service.js --url mqtt://127.0.0.1:1884 --listen 8095   # 详细信息页曲线
node tools/solar-dev-relay.js    # 8099 → 线上 /solar/*
node tools/risen-dev-relay.js    # 8097 → 线上 /risen/*
node tools/test-gateway.js       # 网关自测：13 项断言
```

**面板填什么**（浏览器打开 `http://127.0.0.1:8080/index.html`，右上角数据源面板）：

| 项 | 值 |
|---|---|
| 协议 | 高特 CCU（本项目） |
| 地址 | `ws://127.0.0.1:9002/mqtt`（网关）；回滚路径 `ws://127.0.0.1:9001/mqtt`（直连 broker，无登录应答/无只读保护） |
| 账号密码 | 留空 = 匿名只读；要测下发就填本地配置里那对 web 账号 |
| ProductSN | `kp23bhcpmt91n2v8` |
| 设备 SN | `SN2025B3781TEST`（必须与模拟器 `--dsn` 一致） |

**端口总表**：1884 本地 broker(TCP) · 9001 本地 broker(WS) · 9002 本地网关 · 8080 静态站点 ·
8095 历史 · 8096 阳光云服务 · 8097 日升云服务/转发 · 8099 阳光云转发 ·
线上：1883 设备 · 443 网页 · 8083 mosquitto WS(仅本机) · 8090 网关(停用) · 8095/8096/8097 接入服务。

**启动顺序无所谓**：页面每 5 秒自动重连，先点连接后起 broker 也能自愈。

---

## 二、本地常见坑

| 现象 | 原因与处理 |
|---|---|
| 模拟器"已连接"、页面永远没数据 | **本机 1883 被 `CMAgent.exe`（Cooler Master）占用，而且它自带一个可用 broker** → 数据全进了那边。用 1884，别用 1883；`netstat -ano \| findstr :1883` 看清 PID |
| 页面连不上/连错地方 | 浏览器里残留旧配置（`localStorage` 键 `dianzhan.mqtt.cfg`）：清掉刷新，或重填并「保存配置」 |
| `EADDRINUSE` | 旧进程还占着端口（netstat 看起来仍在监听）→ `taskkill /pid <PID> /f` 再起 |
| 网关能连但收不到 CONNACK | aedes 版本不对：`cd tools && node -e "console.log(require('aedes/package.json').version)"` 应为 `0.51.3` |
| 本地走代理导致 localhost 不通 | 代理软件需把 `127.0.0.1` 加白名单 |

---

## 三、部署（发布 = 任务的一部分）

| 内容 | 命令 / 方式 |
|---|---|
| 前端站点 | `node tools/deploy-site.js` → 上传 `index.html/css/js/libs` 到 `/var/www/lichu`，按 md5 自动提版本号。**需要服务器口令（环境变量）** |
| 阳光云服务 | `node tools/deploy-solar.js`（→ `/opt/lichu-solar`、`/etc/lichu-solar.env`、nginx `/solar`→8096） |
| 日升云服务 | `node tools/deploy-risen.js`（→ `/opt/lichu-risen`、nginx `/risen`→8097；会删云端 token 缓存让种子凭据生效） |
| 历史服务 | `node tools/deploy-history.js`（→ `lichu-history`，nginx `/history`、`/daily`→8095） |
| broker/nginx/TLS | `tools/deploy-broker.sh`、`deploy-nginx.sh`、`deploy-site-nginx.sh`、`deploy-portfolio-nginx.sh`、`setup-tls.sh`、`setup-tls-sites.sh` |
| nginx 细节脚本 | `enable-gzip.sh`（three/echarts 之前是裸传）、`enable-html-nocache.sh`（入口 HTML 不缓存，避免 `?v=` 卡住）、`install-mqtt-connlog.sh`、`setup-login-auth.sh`（给 443 加 Basic 认证） |
| 远程体检 | `node tools/remote-run.js --file tools/diagnose.sh` 等（`diagnose/check-live/check-device/evidence/check-ports` 一组） |

**部署纪律**：脚本要能重复执行、不能覆盖线上已有凭据（`--force` 才覆盖）；改 nginx 前自动备份。
用户的口径是**"_上传到服务器直接上线_ 才算完成"**，不要停在"本地改完"。

**服务器**：43.129.27.206（Ubuntu + mosquitto + nginx + systemd）。常用运维：
`systemctl status lichu-<svc>`、`journalctl -u lichu-<svc> -n 50`、`curl -s https://mqtt.ykdesign.top/healthz`、
`sudo tail -50 /var/log/mqtt-watch/messages.log`（报文留痕）、`sudo tail -80 /var/log/mqtt-watch/connections.log`（连接留痕）。

**mosquitto 警告**：`/etc/mosquitto/passwd` 的属主必须保持 `mosquitto:mosquitto 0600`，改成 root 直接起不来；
加账号用 `mosquitto_passwd -b` 后 `systemctl reload mosquitto`（HUP 会重读密码文件，不用重启）。

**故障三段定位**：① 设备连过吗（mosquitto 日志里非 127.0.0.1 的 `New client connected`）→
② 收到报文吗（报文留痕）→ ③ 外网 `Test-NetConnection 43.129.27.206 -Port 1883`（秒拒=端口通但无服务；超时=被拦）。
注意"端口填错 ≠ 没痕迹"，什么都没看到才是设备侧根本没发。

---

## 四、GitHub 推送（本机网络现状，2026-10-23 实测）

仓库是 **公开仓库**，推之前先确认没有凭据混进去。

本机到 GitHub 的通路情况（换机器/换时间可能变，先测再判断）：

| 通路 | 现状 |
|---|---|
| `git clone/push` 直连 `github.com:443` | **时通时断**，小请求（`ls-remote`）偶尔能过，大流量必被重置 |
| `api.github.com:443` | **通**（可用于 API 操作） |
| `ssh.github.com:443`（SSH over 443） | **通道本身通**，但本机 `~/.ssh/id_ed25519` 的**公钥尚未注册到 GitHub 账号**，所以报 `Permission denied (publickey)` |
| 本机 Clash Verge | 装了但**订阅（`xyproxy.top`）已失效，节点全部不可达**；混合代理端口是 **7897**（不是老配置里的 7890） |
| Windows 凭据管理器 | 存有 `git:https://github.com` 的 OAuth token（`gho_` 开头，权限 `gist, repo, workflow`），git 推送可免交互使用 |

**临时可用办法（本次实际推成功的方式）**：GitHub 是多 IP 的，逐个实测找出能完整传输的 IP
（本次是 `20.27.177.113`，约 56 KB/s），然后写一个本地小代理**只把 `github.com` 的 CONNECT 钉到该 IP**
（TLS 仍正常校验，SNI 不变），再 `git -c http.proxy=http://127.0.0.1:8899 push origin main`。
脚本思路：`http.createServer()` + `server.on('connect')` + `net.connect(port, 指定IP)`，可加多 IP 回退。

**长期建议**：把 SSH 公钥加到 `github.com/settings/keys`，之后走 `ssh.github.com:443` 推送（`~/.ssh/config` 已配好
443 转发）；或者给 Clash 续订/换订阅，恢复后走代理最省事。

**不要做的事**：不要把失效的代理写回 `.git/config`（会在代理没开时把 git 卡死）；不要在用户不知情时
关闭他的代理（用户明确拒绝"关代理"这类方案）。


---

# 【04-领域与业务规则.md】

# 04 · 领域与业务规则（改逻辑前必读）

这一份是"电力业务口径"。这些规则是用户在长期现场使用中一条条纠正出来的，
**按它写就是对的，凭直觉写基本会错**。

---

## 一、功率符号与无效值（最常出错的地方）

| 项 | 规则 |
|---|---|
| 储能功率符号 | **正 = 放电，负 = 充电**（统一定义，两套协议一致；高特点表注释就是「-充 +放」） |
| 日升云口径 | `realtime.power_kw` 正=放电/负=充电；`realtime.grid_kw` **正=从电网取电，负=上网馈电** |
| 关口表/并网点 | **正 = 取电（买），负 = 馈电（卖）** |
| 待机阈值 | 高特详细信息页用 `\|P\| < 3 kW → 待机`；三维场景用符号阈值 |
| 高特无效值 | `65535`（另把 `65534 / -1 / -2` 也当无效）→ 显示 `--` |
| 晶农无效值 | 字符串 `"Bad"`、空、`--` → 显示 `--` |
| 光伏缺失 vs 0 | **`null` ≠ 0**：三维场景用 `cur.pvSeen` 区分"光伏没上报"和"光伏 0 kW"；把 0 当缺失会误判工况 |

---

## 二、工况 / 供电模式判定（两张表，都写在三维模块里）

### 旭日东明（高特站，负荷=厂房）—— 三种工况 + 待机

判定输入：储能功率 `pNum`（正放负充）、关口（逆流表）`mv`（正取负馈）。
代码：`gaote-scene3d.js:update()` 约 1401–1433 行（各线方向在 1344–1373 行）。

| 工况 | 判据 | 文案 |
|---|---|---|
| ① | 储能在充电，且关口功率与储能充电功率**差异大** | 电网供电 + 储能充电（电塔既供厂房又给储能充） |
| ② | 储能在充电，且 `||mv| − |pNum|| < max(1.5, 8%)` | 电网只给储能充电（厂房无负荷） |
| ③ | 储能在放电 | 一律「储能单独供厂房」（关口表没数据也这么写）；关口 <−阈值 → 「储能供厂房 + 余电上网」 |
| 待机 | 其余 | 储能无充放，厂房由电网供电 |

**只有③才叫"储能送厂房"**；①②里厂房是电网在供，不能显示成"待机"。
**储能供电时电网不供电**（2026-10-27 现场口径）：储能放电期间"电网→厂房"直供线一律不亮，
工况文案也不再出现"储能 + 电网一起供 · 缺口由电网补"；直供线只在"储能没在供电"（充电 / 待机）
**且厂房确实从电网取电**时才亮。**并网线（站内 → 铁塔）同一口径**：储能放电期间关口就是在取电也不画，
只有余电上网（关口馈电，阈值同 ③ 的 `tol`）才亮橙上行；充电 / 待机时照旧跟关口表
（取电蓝：塔 → 站内 / 馈电橙：站内 → 塔）。关口取电与否只体现在并网点浮标的数值上（那是表读数，不是供电口径）。
并网点浮标：`>0` 取电 / `<0` 馈电 / `|x|≤0.5` 无交换。

### 洙边（光伏站，负荷=卫生院）—— 五种供电模式

判定输入：光伏 `power`、储能 `storPower`（正放负充）、负载 `loadKw`、关口 `gridKw`（正取负馈）。
代码：`solar-scene3d.js:updateEnergyFlows()` 约 1667–1789 行（五模式判定在 1754–1779）。

模式按"电从哪来"分，**不看电池充没充**——墙根三通黑盒是全站并网点：光伏干线落地进盒，
储能线 / 负载线 / 电网线再从盒侧引出，所以"储能满/待机 + 光伏出力"不单列（2026-10-23 用户口径：并进 ①/②，电池状态写备注）：

| 模式 | 判据 | 文案 |
|---|---|---|
| ① | 光伏出力 + 关口在卖电（储能充没充都算） | 光伏→储能→卫生院→卖电网 |
| ② | 光伏出力 + 不卖电（储能充电/已满待机都算） | 光伏→储能→卫生院 |
| ③ | 储能充 + 光伏没出力 | 电网给储能充电（并供医院） |
| ⑤ | 储能在放电（先于光伏判定：清晨光伏刚起量时放电仍是主角） | 储能直供卫生院（余电上网/缺口电网补写在备注） |
| ④ | 其余 | 全部由电网供电 |

阈值：光伏出力 `> 0.5 kW` 算"有出力"；储能 `±0.5 kW` 判充放；关口净额 **±0.3 kW** 判买卖。
判定所需的三个量只要有一个没数据（`known=false`），模式文本一律留空显示 `--`，**绝不编**。
`surplus`（余电）优先取关口表反推（`meterKw = -gridKw`），拿不到才退回 `光伏 + 储能 − 负载`。

**硬要求**：约定过的工况必须**落到画面几何上**（每根线的亮/灭、方向、颜色），不能只写在文字里——
用户会检查"逻辑改了但模型没体现"。

---

## 三、配色口径（平台级统一，按"谁在供电"取色）

**语义配色（谁供电 → 什么颜色）**：

| 供电方 | 颜色 |
|---|---|
| 光伏出力 | **黄**（光伏→储能、光伏→卫生院、光伏电卖电网，全部黄） |
| 电网 / 市电 | **蓝** |
| 储能放电 | **青绿** |
| 馈电（卖电） | **橙** |
| 直供线（电网→负荷） | 取电时蓝；馈电上网时橙 |

要点：
1. **一条线只在自己那条在通电时才亮**（光伏线不该在电网供电时亮）；充电时线取**电源方的颜色**（光伏充=黄、电网充=蓝）。
2. 这个口径**取代**了更早的"直流=青 / 交流=橙 / 充电=蓝"那套；状态色要在所有表面保持一致
   （能量流光纹、柜体状态灯、SOC 光柱、柜下光晕用同一套）。
3. 日夜各一套色板，**别写死只有夜色能看的 hex**（白底日主题下会看不见）；进主题表，不要内联。
4. 日主题的**灯/玻璃光用中性白**（黄光"很难看"）；暖黄橙留给"带电/通电"的语义元素。
5. 3D 模型材质要**按现场实物**（液冷储能柜是**白**的，夜里也用白；光伏板是近黑深蓝），这条优先于主题配色。

---

## 四、电价与收益口径（不许混算）

| 项 | 规则 |
|---|---|
| 洙边上网电价 | 默认 **0.261 元/度**（山东 2026 年新能源机制电价的光伏价格，鲁发改价格〔2026〕149 号）；旧的燃煤基准价 0.3949 那套自 2025-6-1 起已被取代，**不再使用**。页面点数字即可改（存 `dianzhan.solar.tariff`） |
| 莒南电价 | 尖 1.20 / 峰 0.95 / 平 0.65 / 谷 0.35 / 深谷 0.25 元·kWh⁻¹（本地可改，存 `dianzhan.tariff`） |
| 日升云 | **结算口径**：今日/累计收益、储能/光伏累计收益、度电收益、充放量、减排 |
| 阳光云 | **只报发电量**（实时功率、今日/累计发电、等效小时）；**不自己折算收益** |
| 卖电/买电估算 | 关口表电量 × 电价，页面必须标「估算」，且**不与厂家结算相加**（避免重复计） |
| 高特站收益 | 电表分时电量 × 电价；缺分时电量就用累计电量估算并标「估算」（带 `＊` = 当日实时累计） |
| 通用原则 | 两个来源的数字**各自独立、各自标口径**；自算值一律标"估算/仅参考"；拿不到就 `--`，不编数字 |
| 环境换算常数 | CO₂ 0.997 kg/kWh、标煤 0.404 kg/kWh、等效植树按每棵 18.3 kg CO₂/年 |

**口径标签是硬要求**：KPI 小字必须写明这个数是"厂家日点位"还是"会话积分"/"估算"。

---

## 五、设备与现场事实（建模/文案的依据）

- **旭日东明**：5 堆液冷柜（125 kW/261 kWh ×5）；单台 CCU 管 2 柜；页面默认装机 **250 kW / 522 kWh**；
  储能功率取 **EMU 汇总值**（不能取单个 PCS，否则一直显示 0.0 kW 待机）；厂房屋顶**没有光伏**（干净平顶，别加）；
  PCS 柜**不单独建模**（PCS 在柜内），删设备要连同标签、点击卡、点击处理一起删。
- **洙边**：光伏装机 **110.16 kWp**；**墙根三通黑盒是全站并网点**——光伏干线落地进盒，储能线 / 负载线 / 电网线
  从盒侧引出，柜子只挂一条储能线；五条线（光伏干线 / 储能线 / 电网线 / 负载线 / 电网直供线）**全部取直、全程零交叉**；
  铁塔有**真实三跨 10kV 导线**（横担沿 ±x、线路沿 ±z 穿塔，半跨 20 m / 弧垂 0.95 m，塔顶地线），
  而站内自有线路走**地下/沿墙**（不许空中乱跨、不许横穿院门口）；现场已去掉院名牌与并网点计量箱。
  现场实测常态：午后储能充满转待机、光伏供卫生院、余电全上网（40~68 kW）；夜间储能放 11~12 kW 供卫生院；
  **现场目前不做谷电充电**。
- **通用**：设备"在线" = 2 分钟内有报文；高特不需要平台回登录应答，晶农**必须**有 `zhhn/PostRsp/Login/{SN}` 才上报；
  下发前现场要把控制源切"远程"，且必须先发 `powerCmd` 设模式
  （`powerCmd`：0 远程子系统 / 1 峰谷套利 / 2 远程总功率 / 3 功率调度-不允许馈网 / 4 功率调度-允许馈网）。

---

## 六、协议要点（够用来定位问题）

**高特 CCU（在用）**
- 主题：`/{ProductSN}/{DeviceSN}/rtg/data|status/{维度}[/{arrNum}/{CluNum}/{devIndex}]`、`cmd/set|get/emu/{功能}`、`history/...`。
- 手册示例用简写（`arr`/`clu`），项目点表用全写（`array`/`cluster`）且电表带 `/extend/{型号}` 段——
  **前端已做双向兼容**（`js/gaote.js:parseTopic`），但现场固件实际形状仍需厂家抓一条真实报文确认。
- 电表 4 个维度：`meter-aems-storage`、`meter-mems-storage`、`meter-lems-antireflux`（防逆流）、`meter-lems-demand`（需量）；
  同维度不同型号点位一致，型号经 `extend` 通配——**不需要按型号单独配置**。
- 上报周期 30 秒；无效值 65535；断网本地最多存 7 天，恢复后补传到上行历史主题。

**晶农 EMS（已实现，现场暂未使用）**
- 主流程：`zhhn/Post/Login/{SN}` → 平台回 `zhhn/PostRsp/Login/{SN}` → `zhhn/Post/PeriodReport/{SN}`；
  另召测（5 秒 ×60 帧）、`Set/EmsSet` 下发、`Get/DeviceInfor` 设备清单、`UserInfor`。
- 上报周期 10 分钟；电压单位差 1000 倍（点表最高单体电压按 mV 显示，映射必须换算）。
- 前端已做容错：全角标点/尾逗号、`SN`/`sn` 混用、`UserInfor` 无 SN 后缀、`identifier` 与业务不一致时按 Topic 兜底。


---

# 【05-约定与红线.md】

# 05 · 约定与红线

这一份是"这个项目的脾气"。**违反红线 = 返工。**

---

## 一、前端编辑约定（机械但必须遵守）

1. **改了 js/css，一定提 `index.html` 里的 `?v=YYYYMMDD字母` 版本号**——每个文件各管各的，跨天回到 `a`。
   忘了提 = 线上"看着没变"（缓存）。
2. **不许在脚本顶层引用 `THREE` / `echarts` / `mqtt`**（`main.js` 是异步注入的），要在函数里惰性取。
3. **不许动 `libs/`**（第三方库原样使用）。
4. **`solar-scene3d-v2.js` 不许加进 `index.html`**（顶层 `let` 会污染全局，只在 `solar-preview.html` 用）。
5. **新增视图 = index.html 加 `<section class="hidden">` + 在对应分发器里加显隐分支**
   （`MqttUI.openTab` / `SolarUI.mountTab` / `PortalUI.open*`），注意还有几处 `hideOthers()` 列表要同步。
6. **点表是生成物**：改 `tools/gen-gaote-points.py` 后重新生成，别手改 `js/gaote-points.js` / `js/points.js`。
7. **颜色只进主题表**（`THEMES` / `FLOWC` / `TEXPAL` / `:root`），不在绘制代码里内联 hex；
   材质要经 `regThemeMat()` / `regMat()` 注册才会随主题切换。
8. **别用 PowerShell 原地改含中文/JSON 的文件**（`Get-Content -Raw | Set-Content` 会把 UTF-8 双重编码、破坏转义）——
   用编辑器工具改；生成类文件写 Python/Node 脚本去做。

## 二、数据纯度（本项目的硬底线）

- **页面不许出现任何模拟/演示数据**：没数据就显示 `--` / 0，不做"演示兜底"。
- 唯一的模拟是本地调试页 `solar-demo.html`（**未部署**）：它直接调 `SolarScene.setPower/setStorage/setWeather`，
  不碰真实数据链路；切换演示时要正确传 `null`（不是 0），否则工况会误判。
- 发现页面对不上数（"数据一闪一闪"、"数据对不上"）→ 按**任何一层可能注入脏数据**排查：
  模拟器还在发、broker 保留消息、网关的最后一帧回放缓存、留痕日志里的测试数据。清干净再上线。

## 三、安全与凭据（仓库是公开的）

- **公开仓库，任何口令/token/账号/服务器密码都不许进代码。**
- 已忽略的敏感文件（`.gitignore` 里维护）：`tools/*.config.json` 及其 `.server.json` 变体、
  `tools/gateway.config.json`、`refs/`、`logs/`、`给厂家的接入参数.*`、`给高特的接入参数.*`，
  以及 20 多个写死口令的部署/联调脚本（`deploy-remote.sh`、`deploy-site.js`、`remote-run.js`、`diagnose.sh` 等）。
- 新增脚本要取服务器口令时，**走环境变量**（例如 `SRV_PASS`），不要写默认值。
- 服务器侧凭据一律 `/etc/lichu-<svc>.env`（600），不落到仓库。
- 推送到 GitHub 前先扫一遍有没有凭据混进去；历史上做过一次全历史清洗（filter-repo + 强推），**别倒退**。
- 线上平台有登录保护（nginx Basic + noindex），对外接口在同一个保护里；但**应用内部没有用户体系**，别指望前端鉴权。

## 四、厂商隔离

- 不同厂商的设备/协议/凭据/参数**绝不混用**，文件按厂商前缀命名：
  `solar-*`=阳光电源(光伏)、`risen-*`=东方日升(储能)、`gaote-*`=高特 CCU、`zhhn-*`=晶农 EMS。
- 借用别的模块"当模板"时，明确说清只借代码形状，不借厂商/设备/协议/数据。
- 页面上**不出现第三方厂商品牌**（顶栏厂家标签已被要求删掉）；只在"接入参数"这类确实需要说明的地方保留。

## 五、3D 场景规则（用户验收最严的地方）

**质量红线**
1. **不许穿模**（几何穿插）：电缆穿柜体/穿墙、部件埋在墙里、元素悬空——"会显得很廉价"。
   交付前做一次几何求交扫描（电缆多段线对设备包围盒 + 管半径）。
2. **不许共面闪烁**（z-fighting）：装饰性描边/发光面/铭牌与所依附的表面共面 → 必须做微小法向偏移或 `polygonOffset`；
   同类构造要**全部**修，不是只修被指出的那一个。
3. **不许有看不懂的装饰**：解释不清的小指示灯/装饰点 → 删掉，不解释。
4. **标签要克制**：只给有数据/有意义的设备挂牌；重复的、纯装饰的标签删掉；标签随相机距离**缩小+淡出**，
   被模型挡住时**自动隐藏**；标签整体要小，不遮挡设备。

**建模口径**
5. **按现场实物建**：颜色、材质、有哪些设备、有几个，全按现场；不在场的设备不建（如 PCS 柜）；
   删设备要连带标签/卡片/点击处理一起删，并把剩余电缆重新收头，不留悬空线头。
6. **工况要有几何**：约定过的每种工况/供电路径都要在画面里能看出来（线的亮灭/方向/颜色）。
7. **接线按真实单线图**：每条线从哪来、到哪去按现场实际（用户会纠正"你编的走法"）。
8. **走线要整洁**：每条线走自己的平行车道，避免 S 形来回折、避免在柜前打结；地面平交可以接受，
   为了躲交叉而抬起的"上下绕"不行；站内自有线路走地下/沿墙，别在入口前横穿。
9. **别加真实站点没有的东西**（山、小树这类自然景观 = 土）；方向是**科技感 / 高级大气**（暗色数字孪生那一路）。
10. **活动元素**用抽象占位（胶囊人/叉车），厂房与医院的门可以开着、窗要长亮（白光，不是黄光），
    但这些**会动的东西不投影**（阴影贴图是冻结的）。

**性能红线（已优化过，别退回去）**
11. 重复元素合批（`InstancedMesh`）、雨滴单实例、泛光半分辨率、阴影贴图冻结、
    隐藏的 3D 场景不渲染；标签缩放写 DOM 要带阈值（>4% 才写）。
12. 用户报"卡"时，**先测量再改**（注入 WebGL 探针数 draw call/帧时间，在 1080p 与 DPR2/4K 下、拖动状态下测），
    不要凭感觉改代码。

## 六、UI 品味（已被明确要求过的）

- **大屏是主目标环境**：实际是一台 **4K 显示器 + PC**（不是智能电视）；清晰度优先，
  "变大"只是其中一个手段——对比度、字重、字体栈（CJK）、更实的浮标底色、避免模糊缩放同样重要。
- **KPI 一格一个意思**：不要把充/放加成一个"充放合计"；当前在做什么就显示那个（待机时保持上一次方向），
  明细放悬浮提示里。
- **提示/告警不许压住正文**：走正常文档流，重复告警合并成一条带 `×N`，不要同一条刷四遍。
- **面板贴边**，不留对称缝（右栏 `right:0`）。
- **屏保固定深底青**（不做白色日主题版本），品牌是主角、时钟缩小；logo 相对字标要克制。
- **数值刷新要稳**：复用 DOM 和图表实例（别重建导致图表空白）、无变化不重渲染、重渲染保留滚动位置、
  小变化（<0.4%）不做数字滚动动画。
- **全局统一措辞**：同一个东西在各站叫同一个名字（页签用语、图标都对齐），改名要扫全仓库（含注释）。

## 七、验收标准（怎么算"做完"）

1. `node --check` 过一遍改动的 js。
2. **真的在浏览器里跑起来看**：连上真实数据源（或现场报文重放），走一遍所有相关页签/面板，收集控制台报错。
3. **看渲染结果**（截图/视觉复核），不要只靠读代码或算几何下结论。
4. 涉及业务数值 → 与**厂家后台/设备原始报文**做逐字段对照，说明哪些一致、哪些是我们算错、哪些拿不到。
5. 用户说"改完顺便查查 bug"时，做**周边扫描**，不只修被点名的那个。
6. 完成后**部署到服务器**并报告线上状态（用户认为"上线"才算交付）。


---

# 【06-未闭环与坑.md】

# 06 · 未闭环问题与已知坑

## 一、待厂家确认（数据/协议层的悬念，接了新设备先看这里）

**高特（杭州高特电子）**
1. 两台 CCU 的真实 `ProductSN` / `DeviceSN`（是否就是 `kp23bhcpmt91n2v8` 与 `R250907J0038`/`R250907J0037`）。
2. 现场固件实际的主题形状：`array/cluster` 全写还是 `arr/clu` 简写？电表是否带 `/extend/{型号}`？
   **并抓一条真实报文**——前端已双向兼容，但这是唯一的确定性依据。
3. 是否支持 TLS(8883)、是否启用压缩（comp-gzip / comp-lz4）。
4. 现场实装哪几块电表/型号（决定 `extend` 取值）、电表的堆/簇/设备号取值、部分电能的单位（kWh 还是 0.01kWh）。

**中和汇能（晶农 EMS）**
5. `EmsSet` 的 `wayName` ↔ 点表 TAG 对照表（含 `S1Power…S10Power`）——**没有它就无法实现下发策略**。
6. `deviceType`（中文名）↔ 点表设备号 的完整对照表。
7. MQTT 接入参数说明（broker/端口/TLS、认证、QoS、retain、keepalive、clientId 规则）。
8. 修订版协议文档（现文档有 4 段示例报文**不是合法 JSON**：全角冒号/逗号、尾逗号、`time` 放错位置、`DeviceName` 键重复）。
9. 行为约定：周期上报节拍、无效点表示（`"Bad"` 还是 null）、召测与周期上报是否冲突、
   未收到平台应答是否重发、`SetRsp.errormsg` 错误码规范、时间时区、SN 规则。

> 这些"待确认"是**给厂家的问题**，不是让你猜的。遇到就按现状容错处理，并把问题列出来交给用户转达。

## 二、已知遗留缺陷（看着不对，不算新 bug）

| # | 现象 | 位置/原因 | 修法方向 |
|---|---|---|---|
| 1 | `js/data.js` 里"网关可匿名只读"的注释已过期 | 网关 2026-09-19 停用后，网页**必须填账号** | 改注释 |
| 2 | PCS 建模被注释掉但电缆仍指向旧交汇点 | `gaote-scene3d.js` 的 `buildPCS()` 调用处被注掉（现场要求删柜） | 别盲目取消注释，要连带重走电缆 |
| 3 | `strategy` 页签被 `display:none` 停用 | 用户要求"先隐藏，暂时不需要" | **保留代码**，一句话可恢复 |
| 4 | 储能 / 光伏 / 详细信息整页**没有刷新和返回按钮** | `solar.js:863-867` 绑的 `#slRefresh` / `#slBack` 在 `index.html` 里不存在（死绑定） | 要么补按钮，要么删绑定 |
| 5 | 演示工况 / 天气的场景提示文字不显示 | `solar.js:714` 往 `#slSceneMeta` 写字，但该元素在 `index.html` 里不存在 | 补元素，或改写到 `#sceneTitle` |
| 6 | 几处死代码 | `solar-scene3d.js:864 TWR_WIRE_X` 声明后从未使用；`solar.js:30 last` 只写不读、`sceneOn` 永远不会变 false | 顺手清理 |
| 7 | `#devPanel`（旧侧边设备列表）与 `#deviceView` 并存 | `mqtt-ui.js:325` 仍留作 PortalUI 缺席时的兜底，不算死界面 | 确认 PortalUI 恒在后再删 |

## 三、本机环境坑（换机器/换会话都可能遇到）

| 坑 | 说明 |
|---|---|
| 1883 端口被占 | 本机 `CMAgent.exe`（Cooler Master）占着 1883，**它自带一个能用的 broker** → 模拟器发到 1883 会"显示已连接但页面永远收不到"。一律用 1884 |
| aedes 版本 | 必须 `0.51.3`；装成 1.x 在 Node 24 上"连得上但收不到 CONNACK" |
| 浏览器缓存 | 页面配置存 localStorage（`dianzhan.mqtt.cfg`），残留旧地址会造成"连不上"的假象 |
| PowerShell | 别用 `Get-Content -Raw \| Set-Content` 改中文文件（会双重编码）；别用 `Select-Object -First N` 截断长任务的输出（会提前终止管道、让部署静默失败）；多行带引号的脚本别硬塞进一次调用 |
| 视觉能力 | 本机曾有本地 Ollama 视觉模型（`tools/see.py` / `qwen2.5vl`），但它是临时安装、经常挂；**优先用智能体自带的图像识别**，退而用 `tools/image-look.py`（零依赖，出色块图/边缘图） |
| ffmpeg | 不在 PATH，需要抽视频帧时找 `C:\Program Files (x86)\...` 里应用自带的 `ffmpeg.exe`，或用 Python 的 `cv2` |
| 旧版本号/缓存 | 线上还有 `enable-html-nocache.sh` 保证入口 HTML 回源；但 js 改了不提版本号仍然是"没变" |

## 四、交接时的进行中事项（2026-10-27）

- 未提交改动只有两处：`index.html`（`solar-scene3d.js` 版本号 → `20261027a`）、`js/solar-scene3d.js`
  （新增 `?nowires=1` 电线一键隐藏，截图核对走向用）；两处已于 2026-10-27 14:22 部署到线上，**只差提交推送**。
- 服务端落后一处：`/opt/lichu-solar/solar-service.js` 还是 10-10 的版本，本地 10-23 版
  （趋势缓存 / 长区间降采样，约 175 行改动）**尚未部署**，要跑 `tools/deploy-solar.js`。
- 本机 GitHub 推送通路受限（详见 `03-本地开发与部署.md` 第四节）：直连 `github.com:443` 经常
  `Connection reset`，可用办法是"钉 IP 的本地代理"或走 `ssh.github.com:443`。
- Clash 订阅（`xyproxy.top`）已失效，节点全部不可达；混合端口是 **7897**。
