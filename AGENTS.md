# AGENTS.md · 力储未来能源综合管理系统

> 给所有接手本项目的 AI 智能体的**精简速查**。详细内容看 `agent-pack/`（README.md 是入口）。

## 这是什么

「力储未来能源综合管理系统」：工商业储能/光伏电站的网页监控平台。
**纯静态前端**（`index.html` + `js/*`，无构建工具，每个 js 挂一个全局对象）+ `tools/` 下一组 Node 服务
（MQTT broker/网关、阳光电源 iSolarCloud 接入、东方日升日升云接入、历史服务、设备模拟器）。
线上入口 **https://mqtt.ykdesign.top/dianzhan/**，服务器 43.129.27.206（mosquitto + nginx + systemd）。

## 动手前必读（红线）

1. **改了 js/css 必须提 `index.html` 里的 `?v=YYYYMMDD字母` 版本号**（每个文件各管各的），否则线上"看着没变"。
2. **页面不许有任何模拟/演示数据**；没数据就 `--`/0。唯一例外：洙边三维的「演示工况」下拉，只喂 3D 场景。
3. **公开仓库，凭据不进代码**：`tools/*.config.json`、`refs/`、`logs/`、接入参数文档、含口令的部署脚本都已被
   `.gitignore` 排除，不要加回来；新脚本用环境变量取口令。
4. **别动 `libs/`**；别在脚本顶层引用 `THREE`/`echarts`/`mqtt`（由 `main.js` 异步注入）。
5. **颜色进主题表**（`THEMES`/`FLOWC`/`css :root`），不内联写死；语义配色：光伏=黄、电网=蓝、储能放电=青绿、馈电=橙。
6. **功率符号：正=放电、负=充电**；关口表 正=取电、负=馈电；光伏 `null ≠ 0`。
7. **点表是生成物**（`js/gaote-points.js` 由 `tools/gen-gaote-points.py` 从 `refs/*.xlsx` 生成），别手改。
8. 3D 场景：**不许穿模、不许共面闪烁、别加看不懂的装饰**，标签随距离缩放并被模型遮挡。

## 验证与交付

- 改完 → `node --check` → 浏览器里真跑一遍（连真实数据/现场报文）→ 看渲染结果（截图）→ 与厂家后台或原始报文对照数值。
  核对走线时用 `?nowires=1`（洙边）把电线全隐藏，只看建筑与线路路径。
- **部署才算完成**：前端 `node tools/deploy-site.js`，服务用对应 `tools/deploy-<svc>.js`。
- 本地四件套：`tools/local-broker.js`(1884/9001) + `tools/gateway.js --listen 9002` +
  `tools/ccu-simulator.js`(SN2025B3781TEST) + `python -m http.server 8080`。

## 详细文档（按需读）

- `agent-pack/01-项目总览.md` — 站点/数据源/线上拓扑
- `agent-pack/02-代码地图.md` — 文件表、数据流、3D 场景组织
- `agent-pack/03-本地开发与部署.md` — 命令、端口、部署、GitHub 推送现状
- `agent-pack/04-领域与业务规则.md` — 工况判定、配色口径、电价与收益口径
- `agent-pack/05-约定与红线.md` — 编辑约定、3D 规则、验收标准
- `agent-pack/06-未闭环与坑.md` — 待厂家确认、已知遗留、环境坑
- `agent-pack/07-洙边-当前状态与交接.md` — 洙边 3D 现状定稿（九条线亮灯条件 / 六工况 / 流速 / 接线盒 / 演示页），**接手前必读**
- 项目既有文档：`handoff.md`（本地链路排查）、`部署指南.md`（线上部署）、两份「交叉印证」（厂家协议对账）
