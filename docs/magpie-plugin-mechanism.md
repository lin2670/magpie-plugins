# magpie 插件机制（侦察笔记）

来源：magpie 源码本地副本 `C:\Users\Administrator\AppData\Local\Temp\magpie-src`（v0.1.1203，最后提交 2026-10-12）；文中路径为仓库相对路径。侦察日期 2026-10-14。

## 结论

- provider 插件是 magpie 为"带登录态的第三方服务"设计的正规扩展点；**登录态订阅正从内置迁出到社区插件**（`AGENTS.md:25-30`），新登录态 provider 应走插件，不要提内置 PR。
- 插件 = JS/TS（OpenCode 插件 API v1 / pi 包），跑在单一常驻 **Bun 宿主**（`internal/plugin/host.js`，Go↔JS 走 stdin/stdout RPC）。
- 安装：`magpie plugin add <npm | github:owner/repo | ./本地路径>`；本地路径即可自用，无需发布。
- 网关协议转换、路由、分组、配额、日志由 magpie 完成；插件只负责 ① 登录态 ② 模型列表 ③ `auth.loader` 的 `fetch`（真正发往上游的 HTTP）。

## 插件钩子

| Hook | 作用 | 位置 |
|---|---|---|
| `auth` | 声明 provider id、登录方式（oauth / api）、icon | host.js:1572-1586 |
| `auth.authorize / callback` | 登录流程，产出 `{type:"oauth", refresh, access, expires}` 或 `{type:"api", key}` | host.js:1546-1553 |
| `auth.loader` → `{baseURL, apiKey, headers, fetch}` | **反代核心**：请求实际发往哪里、怎么发，由插件的 fetch 决定 | host.js:1713-1735 |
| `auth.refresh` + `refreshLead` | magpie 全托管 token 刷新（默认提前 5 分钟、并发去重、失败退避 30s） | host.js:1619-1705 |
| `auth.usage` | 额度 / 窗口 / 登录状态上报 | host.js:1744-1800 |
| `auth.checkin` | 每日任务钩子（见下） | host.js:1817-1856 |
| `provider.models` | 模型清单（含 NPM 协议提示等） | host.js:1329-1370 |
| `config` | 注入 provider 配置（名称、models.dev 覆盖等） | host.js:1174-1181 |

- 登录态存储：`~/.config/magpie/plugin-auth.json`（OpenCode auth.json 形状）。
- 请求接线：`internal/provider/plugins.go` — `pluginFetch`（:419）；模型 `NPM` 字段决定 magpie→插件之间的协议形态（`@ai-sdk/anthropic`→Anthropic、`@ai-sdk/openai`→Responses、默认 Chat；`plugins.go:127-146`）。
- id 撞名：自动 `-plugin` 后缀（`plugins.go:50`）；同 id 多插件用 `magpie plugin use` 选主。

## 每日任务（签到）托管

- 插件 `auth.checkin` 返回 `{outcome: claimed|done|ineligible|inactive|captcha|failed, credit?, streak?, message?}`。
- magpie 调度：启动 +2 分钟首查，此后每 30 分钟实查（北京日切重置；失败 30 分钟后重试）；仅由"正在跑网关的 magpie 实例"执行；结果存 `plugin-checkin.json`（键 `provider|account`）。
- 开关：默认关；`settings.PluginCheckins`；GUI Settings → Usage → Plugins；API `POST /api/settings/plugin-checkin`、`POST /api/usage/plugin-checkin`。
- 铁律：magpie 与插件都不解验证码，遇验证码回 `captcha` 引导用户去官方 App。
- 无通用 cron：非签到形态的单独周期任务没有现成钩子（不建议在插件进程里自跑 timer——不受 magpie 管理）。

## 关键约束

- 插件是完全受信 JS（可 fetch、可读自己的 plugin-auth 数据），无沙箱。
- 网关中间件（moejs）无网络、无 timer，不承担签到 / 请求转发；转发一律走 provider 插件的 `loader.fetch`。
- 上架社区市场需向 magpie-community/plugins 的 `registry.json` 提交；自用不需要。
