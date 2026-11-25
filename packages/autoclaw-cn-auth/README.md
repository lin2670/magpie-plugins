# magpie-autoclaw-cn-auth

AutoClaw **国内版**（智谱 autoglm，`autoglm-acceleration-api.zhipuai.cn`）的 magpie provider 插件：手机验证码登录、模型清单、聊天转发、积分钱包、每日双任务签到（签到 + 灵感中心）、登录类活动奖励（先查后触发 + 到账确认）、活动积分流水与网页版快捷登录入口。

请求形态移植自 [aimod-cc/agent2api](https://github.com/aimod-cc/agent2api)（MIT）的 `providers/autoclaw`，按 magpie 插件 API 重写。

> 只做**国内版**（provider id `autoclaw`，与 agent2api 现名一致）。国际版是另一套站点、另一套登录方式（Zai / Google OAuth），本包不涉及。

## 安装（本地自用）

```
magpie plugin add ./packages/autoclaw-cn-auth
magpie plugin login autoclaw     # 选「从 agent2api 导入」/「手机验证码登录」/「手动粘贴 token」
```

## 能力

- **登录**：`从 agent2api 导入`（只读本机 `~/.agent2api/agent2api.db`，provider=`autoclaw`）、`手机验证码登录`（发码 → 输入 6 位码，直返 token 对，无需回调窗口）、`手动粘贴 token`。
  - 验证码必须作为 **JSON 数字** 提交（字符串会得到 `400001 参数错误`，与「验证码错误」无关）——插件内部已转换。
  - 上游业务码翻成人话：`400001`=参数错误、`630202`=验证码错误、`631002`/`630014`=风控未过（提示改用「填写凭证」）。
- **续期**：`POST {userapi}/userapi/v1/refresh`（签名头 + `{refresh_token, source_id:"autoclaw", device_id}`）；签名校验失败（`400002`）自动降级 `agent-refresh` 重试一次。401（token 被拒）时强刷一次重发。
- **聊天**：`POST {上游代理}/{chat/completions}`，OpenAI 兼容，SSE 直通；三处出站整形（**都是上游硬闸**，见下）。
- **模型**：`GET {configBase}autoclaw-model-config`（顶层 `{models:[…]}`，无信封）；不可达时回落客户端内置静态表（`GLM-5.3` / `GLM-5.3-Flash`）。
- **余额（usage）**：`GET /agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw`（v2 拿不到时降级 v1 `wallet-instances`）→ 积分口径见下；末尾追加一个**网页版快捷登录**窗口，`display` 为 `{AUTOCLAW_WEB_BASE_URL}/?autoglm_token=<access>`（`aside: true`，不报 `used`，不参与账号可用性判断）。
- **积分口径**：窗口顺序 `[本轮消耗?, 每日签到, 积分余额, 活动积分?, 网页版快捷登录]`。
  - `积分余额`：`{ balance: <总积分>, unit: "积分" }`（纯余额，不报 `used`）。顶层 `balance` 把细分钱包折成字符串，如 `12,700 积分（赠送积分 200 · 通用积分 12,500）`（`display:false` 的不列、四舍五入等于总数的单项不列、最多 3 项，千分位为手写分组，不依赖 locale）。
  - `每日签到`：`今日已签 ✓ +200` / `今日未签（+200）`，状态取自 task-list，读不到则不出此行。
  - `本轮消耗`（仅 `used > 0` 时）：按本地余额差算「自上次上涨以来花掉的比例」，`used` 是百分比、`amount`/`limit` 是原始积分，附带北京当日 `今日 -X` / `今日 +Y`。任何上涨（含从 0 回升）都开新一轮（peak = 当前、used 归零），不等涨过旧峰值。
  - `total_balance` 为 `null`/空串/非数时返回 `{ error: "积分响应异常", windows: [] }`：不记 0，避免把账号当整池花光。
- **活动积分（campaign 流水）**：`GET /agent-assetmgr/api/v1/ledgers_std?biz_app_id=autoclaw&page_size=200&wallet_scope=campaign`，只认 `wallet_scope === "campaign"` 的 `credit/debit/expire` 流水，按 `wallet_id` 实例对账（`剩 = credit − debit − expire`，截 0）。窗口外只剩消耗/失效的旧实例按 0 计、失效额仍进「过期」。展示为 `剩 4,000（活动名） · 已领 5,000 · 过期 7,711（近期）`（`aside: true`，**不带 `balance`**，不会被当第二个资金池）。缓存按账号键 10 分钟，失败不缓存、协议变更按空缓存，user-info 成功后立即失效；近期有到期库存时在 `积分余额` 窗口上标 `runsOutAt`/`runsOut`。签到不读这份缓存，另有实时直读（见下）。
- **登录类活动奖励（先查后触发 + 到账确认）**：这类活动没有领取接口，由服务端在「登录活跃」时自动入账。checkin 的顺序是**先读活动流水**（`ledgers_std` 实时直读，不走 10 分钟缓存）：
  - 今日已有到账 → **跳过** `POST /userapi/v1/user-info`（当天开过桌面端就已发放，调用次数零浪费）；
  - 今日无到账 → 打 user-info 触发，再回读一次流水确认（触发后读不到也不影响签到结论）。
  - 判定与 agent2api 同口径：`wallet_scope === "campaign"` 且 `mutation_type === "credit"`，`occurred_at` 按北京日算今天，`metadata.event_type` 前缀命中 `autoclaw_user_active` / `autoclaw_user_signup_day`（缺 `event_type` 时退回 `activity_id` 前缀 `autoclaw_user_active_reward` / `autoclaw_user_active_bonus`）。日期或流水读不到按「未知」处理，不误报。读取失败（5xx / 网络）只当未知，**绝不把签到判成失败**。
  - user-info 必须带官方桌面端指纹头（`User-Agent: AutoClaw/2.2.0 (win-x64)`、`X-Version: 2.2.0`、`X-Tm: win-x64`、`X-Channel: AutoClaw20`、`X-Product: autoclaw`、`X-Lang: zh-CN`、签名头、`Authorization: Bearer`、`X-Trace-Id`）。服务端只在这套指纹下记录 `autoclaw_user_active` 并发放「用户登录奖励」类活动积分。device_id 依次取凭据里的 `deviceId` → access JWT 的 `device_id` claim → refresh JWT 的 claim。先在 `AUTOCLAW_USERAPI_BASE_URL` 试，失败再试 `https://autoglm-api.zhipuai.cn`。
- **每日双任务（checkin）**：`fresh()` → 活动流水直读（今日到账？→ 跳过或触发 user-info → 回读确认）→ `GET /autoclaw-proxy/proxy/autoclaw-task-list` → `POST /autoclaw-proxy/proxy/autoclaw-task-complete`。两个任务——先 `daily_signin`（每日签到，200/日），再 `daily_inspiration_center`（进入灵感中心，200/日，客户端触发、幂等）。task-list 里 `status === "completed"` 的任务跳过；空列表返回 `inactive`「当前没有签到活动」；task-list 请求失败（网络/5xx/非 envelope）退回直接打两个任务（幂等）。`credit` 为实际 `reward_points` 之和（**不含活动奖励**），`message` 用「；」拼接两项结果，活动奖励只在末尾追加：今日已到账 → `；活动奖励已到账 +10,000（每周限时激励）`（多活动 `（2 个活动）`、无活动名不带括号、千分位）；无到账且 user-info 未到达 → `；活动奖励未触发（登录未上报）`；无到账但 user-info 到达或流水读不到 → 不追加。任一任务非鉴权失败不阻断另一个、失败原因透传上游 `msg`；`401`/业务码 `410000`/`SignedOut` 判为登录失效（`signIn: "expired"`）。上游 `code != 0` 一律按失败处理，不猜测、不重试。

## 出站整形（上游 2026-09-22 起的两道闸 + 预校验）

| 处理 | 做什么 | 依据 |
|---|---|---|
| **认证头** | LLM 代理用 **`X-Authorization`**（不是 `Authorization`） | 源实现 `modelProxyUpstreamHeaders` |
| **路由头** | `X-Request-Model` 填**完整路由 ID**（`zai_*`/`zaicoding_*`，前缀决定计费通道），`body.model` 填**剥前缀**后的模型 ID | 上游用两个标识定位模型 |
| **去 `X-Harness-Type`** | LLM 代理**不发** `X-Harness-Type: zcode`（账号域照发） | 带 `zcode` 在该路上稳定 403 pay-view / 406 |
| **`max_tokens` 下限** | 小正整数（`< 10000`）抬到 `10000` | 30~8192 一律被预校验拒成 406 空体；缺省或 ≥10000 放行 |
| **system 规范化** | 首条 system 前置 OpenClaw 身份句 + `## Tooling` 段；system/developer 里的外来身份句（ZCode / Claude Code / Codex / DeepSeek Harness / pi）改写成中性说法 | 首句指纹 + 黑名单逐字匹配（大小写不敏感） |
| **SSE 回写** | 每个响应帧（含非流式响应体）的 `model` 改写为客户端请求名 | 上游回自己的路由名 |

账号域（登录/续期/积分/签到/模型目录）则走另一套头：`X-Auth-Appid` + `X-Auth-TimeStamp`（秒）+ `X-Auth-Sign = md5("{appId}&{ts}&{appKey}")`（appId/appKey 为客户端内置常量，非用户凭证），外加品牌头与 `X-Harness-Type: zcode`。这是客户端指纹复刻，不是密码学边界。

## 403 语义（额度用尽 / 封禁不是登录失效）

聊天链路与 task-list 共用同一套判定，只读响应体的 `code`/`message` 字段：

| 上游 | 判定 | 输出 |
|---|---|---|
| `403` + `code ∈ {810000, 810001}` 或文案含额度/余额已用完/系统繁忙/升级会员 | 额度用尽 | 聊天转 `429`，原文案透传，`X-Magpie-Sign-In: kept`；task-list 抛 `{ quota: true, signIn: "kept" }` |
| `403` + `code 410004` 或文案含 banned/封禁/账号异常/冻结 | 账号被封禁 | 聊天转 `403 permission_error`，`X-Magpie-Sign-In: kept`；task-list 抛 `{ banned: true, signIn: "kept" }` |
| 其余 `401`/`403` | 登录失效 | 保持 `expired` 语义，`X-Magpie-Sign-In: expired` |

额度用尽或封禁都不轮换、不刷新 token：重新登录只会拿到同一个账号和同一个拒绝，旧实现按 `expired` 处理会让 magpie 静默丢掉健康账号。

## 环境变量（测试 / 镜像用，与 agent2api 同名）

| 变量 | 默认 |
|---|---|
| `AUTOCLAW_USERAPI_BASE_URL` | `https://autoglm-acceleration-api.zhipuai.cn`（账号/积分/签到/模型目录） |
| `AUTOCLAW_UPSTREAM_BASE_URL` | `https://autoglm-acceleration-api.zhipuai.cn/autoclaw-proxy/proxy/autoclaw`（聊天代理，含尾部 `/autoclaw`） |
| `AUTOCLAW_WEB_BASE_URL` | `https://autoglm.zhipuai.cn`（网页版快捷登录链接的站点） |
| `AUTOCLAW_USERINFO_ALT_BASE_URL` | `https://autoglm-api.zhipuai.cn`（user-info 首个 base 失败后的备用账号域） |
| `AUTOCLAW_USAGE_STATE_FILE` | `$XDG_CONFIG_HOME/magpie/autoclaw-usage.json` → `$HOME/.config/magpie/autoclaw-usage.json`（Windows 用 `USERPROFILE` 兜底；存「本轮消耗」的本地基线） |
| `AGENT2API_DB` | `~/.agent2api/agent2api.db`（导入源，只读） |

`AUTOCLAW_USAGE_STATE_FILE` 存的是本地记账基线 `{ accts: { "<key>": { peak, balance, day, daySpent, dayGained, at } } }`：写入走临时文件 + rename、权限 `0600`、30 天未动自动清理，日界按北京时间。换机器/多实例会丢基线（首轮不出「本轮消耗」行），可接受。

## 网页版快捷登录（安全提示）

`usage` 的「网页版快捷登录」窗口展示的是免密链接 `{AUTOCLAW_WEB_BASE_URL}/?autoglm_token=<access>`：网页端 `checkToken()` 会读取该参数、Bearer 化后写入浏览器登录态。因此**该链接等同于实时登录凭证**：

- **勿外发**：截图、日志、工单、聊天记录里都不要带上完整链接；
- 链接随 `access` 过期而失效；`usage` 取的是 `fresh()` 续期后的 token，正常情况至少还有 5 分钟可用；
- GUI 若把长链接截成省略号，可从 `usage` 原文完整复制，或手工拼接：`https://autoglm.zhipuai.cn/?autoglm_token=` 后接 URL 编码后的 access token（`encodeURIComponent`）。

## 测试

```
cd packages/autoclaw-cn-auth && bun test
```

测试打到本地 fake 上游（`fake.mjs`），**不触网、不使用真实 token**：fake 会重新计算并校验 `X-Auth-Sign`、校验 `X-Authorization`/`X-Request-Model`/`body.model`、模拟 406 预校验与 `400002` 降级、两个每日任务各自的幂等两态与独立失败开关，以及 user-info 官方指纹头校验、task-list 状态/失败/403 额度与封禁、`ledgers_std` 可配置流水（含 `occurred_at`/`metadata`）与 5xx、user-info 到达后追加今日活动 credit 的 `creditOnUserInfo` 开关、聊天 403 额度/封禁。`AUTOCLAW_USAGE_STATE_FILE` 在测试中由 `_internal.setUsageStatePath` 指向临时目录，绝不写真实 `~/.config/magpie`。

## 许可

MIT。请求逻辑移植自 aimod-cc/agent2api（MIT）。
