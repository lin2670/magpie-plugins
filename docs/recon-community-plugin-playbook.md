# 社区插件写法（侦察笔记）

来源：`magpie-community/plugins`（HEAD `cff78b3`，clone 于 `Agent/.scratch/recon/magpie-community-plugins`）+ magpie 主仓库 + 本机已装插件（`~/.config/magpie/plugins/node_modules/@magpie-community/`）。侦察日期 2026-10-14。

## 包结构（provider 插件）

- `package.json`：`name` / `type: module` / `main: ./index.mjs` / `exports` / `files: [index.mjs, README.md]` / `keywords` / `license: MIT`；**无运行时依赖**（Bun/Node 自带 fetch / crypto / fs）。
- magpie 专有字段：`magpie: { icon, maxConcurrency }`（也可写在 `auth.icon` / `auth.maxConcurrency`，钩子优先）。
- 入口：导出 **async 插件函数** `async ({client, directory, project, $, …}, options) => hooks`（`options` 来自 `magpie plugin options`）；**命名导出多个函数 = 一包多 provider**（qoder → qoder + qoder-cn；trae / workbuddy / minimax 同型；`makePlugin(SITES[site])` 工厂）。不同导出必须用不同 `auth.provider` id（后注册覆盖）。
- provider id：与内置订阅同名会被挂 `-plugin` 后缀；本项目 4 个新厂商无内置，用原名。

## 钩子清单（要点）

```js
return {
  config(cfg) { cfg.provider[ID] = { name, npm, api, models } }, // npm: @ai-sdk/openai-compatible | @ai-sdk/openai | @ai-sdk/anthropic
  auth: {
    provider: ID, icon?, maxConcurrency?,
    methods: [
      { type: "oauth", label, prompts?, authorize: async (inputs) => ({ url, instructions, method: "auto"|"code", callback }) },
      { type: "api", label, placeholder? },
    ],                                    // 多登录方法；authorize 成功返回 {type:"success", refresh, access, expires} 或 {type:"success", key}；带 error 字段会展示给用户
    loader: async (getAuth, provider) => ({ baseURL, apiKey, headers, fetch(input, init) {…} }),
    refresh?: async (auth, provider) => ({ access, refresh, expires }), // 返回值"合并"进账号
    refreshLead?: ms,                     // 默认提前 5 分钟
    usage?: async (getAuth, provider) => ({ plan, user, windows, resets, signIn: "kept"|"renewed"|"expired" }),
    checkin?: async (getAuth, provider) => ({ outcome, credit?, streak?, message? }),
  },
  provider: { id: ID, async models(provider, { auth }) {…} },
  "chat.headers"?: async (input, output) => {},
}
```

- `loader.fetch`：headers 顺序 = apiKey 头 → loader headers → 网关请求头 → chat.headers；body 为该 API 形状的 JSON 字符串；返回 Response 原样流回；**抛错 = failover 换账号 / 模型**；非 2xx = 上游答案（401 标记账号）。
- 账号作用域：钩子拿 `getAuth()`（当前账号）/ `auth` 快照；保存用 `client.auth.set({path:{id}, body})`（覆盖式）；`auth.refresh` 返回值合并。调试输出走 stderr → magpie 日志（`plugin: …`）；`client.app.log` 可用。
- 存储：`~/.config/magpie/plugin-auth.json`（600 + 锁文件），与 OpenCode auth.json 同形可互拷。
- 并发：按账号可设 `auth.maxConcurrency`（保守 1~2，适配上游风控）。

## checkin（用机制 2）

- 机制 2（magpie ≥ 0.1.1083；本机 0.1.1233 ✓）：插件 `auth.checkin(getAuth, provider)`，调度由 magpie 托管（北京日、逐账号、失败重试；见 `magpie-plugin-mechanism.md`）。
- **全社区暂无机制 2 实例**；官方最小可运行样例 = magpie `internal/plugin/testdata/fake/index.js:179-200`（覆盖 claimed / done / captcha / throw / 未知 outcome 全分支）。
- 旧机制（magpie 代按、经 loader.fetch 转签到页）只对内置签到厂商（WorkBuddy / Trae / MiniMax / Qoder）存在，与本项目无关。
- outcome 六态；`captcha` 铁律：不解，返回后 magpie 提示用户去官方 App。

## 登录态复用先例（Q7 模式有成熟范本）

- `kiro`：读 kiro-cli sqlite / IDE token 文件，**只读引用、刷新写回原处**；
- `zcode`：读 ZCode 桌面端会话；`grok`：spawn 官方 login 解析；`commandcode` 同型。
- → 我们"读妙手凭据 / 从 agent2api 导入"属同一成熟模式。

## 开发 / 测试 / 发布

- 本地跑：`magpie plugin add ./path`（路径型不走 bun install；改完代码 CLI 每命令新起 host 即生效；GUI 里 off/on 重载）。`Update()` 跳过路径型，不会被自动覆盖。
- 测试设施：`bun test`；`bun scripts/check.mjs`（校验钩子形状）；`scripts/try.sh`（沙箱 HOME 跑真 magpie）；`magpie provider test <id> [model…]`（真端点小请求）；**每包自带 `fake.mjs`（Bun.serve 假上游）+ `nonet.mjs`（拦死非本机 fetch，防真 token 外泄）**——本项目照做。
- 发布（暂缓）：自有 npm 包 `npm publish` 即可被 `magpie plugin add` 使用；上市场 = registry.json 提 PR（首个版本需先手动 publish 建包）。

## 最可复用样板

| 样板 | 抄什么 |
|---|---|
| `packages/qoder/` | 总模板：token 锁（`locked()` 串行化 refresh + `spent` 防双花，供 raccoon / accio 参考）、`fresh()`、usage 三态、loader.fetch 全量接管、双 provider 工厂 |
| `packages/trae/` | 签到协议文档范本 + checkin 页透传写法 |
| `packages/kiro/` | 登录态复用（读兄弟客户端凭据） |
| magpie `testdata/fake/index.js` | 全钩子最小实现（含 checkin 六态） |
| magpie `internal/plugin/host.js:1286-1520` | refresh / usage / checkin 权威契约注释 |
