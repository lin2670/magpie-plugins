# magpie-autoclaw-cn-auth

AutoClaw **国内版**（智谱 autoglm，`autoglm-acceleration-api.zhipuai.cn`）的 magpie provider 插件：手机验证码登录、模型清单、聊天转发、积分钱包、每日双任务签到（签到 + 灵感中心）、桌面端签到卡（每日 +300）、登录类活动奖励（先查后触发 + 到账确认）、活动积分流水，以及网页版免密登录链接（`web` CLI 输出）。

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
- **余额（usage）**：`GET /agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw`（v2 拿不到时降级 v1 `wallet-instances`）→ 积分口径见下；末尾追加一个**网页版快捷登录**窗口，`display` 是固定短提示 `打开网页版：bunx magpie-autoclaw-cn-auth web`（`aside: true`，不报 `used`，不参与账号可用性判断）。自 0.5.0 起该窗口**不再携带登录链接**：GUI 会把长 `display` 截断且无法复制，链接改由 `web` CLI 打印（见「网页版快捷登录链接（web CLI）」）。签到卡的读卡与钱包、task-list、活动流水**并行**发起，按账号键缓存 10 分钟（与活动流水缓存分开），checkin 领取成功后立即失效；读卡失败则「每日签到」行维持原口径。
- **积分口径**：窗口顺序 `[本轮消耗?, 每日签到, 积分余额, 活动积分?, 网页版快捷登录]`。
  - `积分余额`：`{ balance: <总积分>, unit: "积分" }`（纯余额，不报 `used`）。顶层 `balance` 把细分钱包折成字符串，如 `12,700 积分（赠送积分 200 · 通用积分 12,500）`（`display:false` 的不列、四舍五入等于总数的单项不列、最多 3 项，千分位为手写分组，不依赖 locale）。
  - `每日签到`：`今日已签 ✓ +500` / `今日未签（+500）`（任务 `reward_points` + 签到卡 `daily.amount` 之和；卡不可见或读不到时退回任务口径 `+200`），状态取自 task-list 与签到卡，两者都读不到则不出此行。
  - `本轮消耗`（仅 `used > 0` 时）：按本地余额差算「自上次上涨以来花掉的比例」，`used` 是百分比、`amount`/`limit` 是原始积分，附带北京当日 `今日 -X` / `今日 +Y`。任何上涨（含从 0 回升）都开新一轮（peak = 当前、used 归零），不等涨过旧峰值。
  - `total_balance` 为 `null`/空串/非数时返回 `{ error: "积分响应异常", windows: [] }`：不记 0，避免把账号当整池花光。
- **活动积分（campaign 流水）**：`GET /agent-assetmgr/api/v1/ledgers_std?biz_app_id=autoclaw&page_size=200&wallet_scope=campaign`，只认 `wallet_scope === "campaign"` 的 `credit/debit/expire` 流水，按 `wallet_id` 实例对账（`剩 = credit − debit − expire`，截 0）。窗口外只剩消耗/失效的旧实例按 0 计、失效额仍进「过期」。展示为 `剩 4,000（活动名） · 已领 5,000 · 过期 7,711（近期）`（`aside: true`，**不带 `balance`**，不会被当第二个资金池）。缓存按账号键 10 分钟，失败不缓存、协议变更按空缓存，user-info 成功后立即失效；近期有到期库存时在 `积分余额` 窗口上标 `runsOutAt`/`runsOut`。签到不读这份缓存，另有实时直读（见下）。
- **登录类活动奖励（先查后触发 + 到账确认）**：这类活动没有领取接口，由服务端在「登录活跃」时自动入账。checkin 的顺序是**先读活动流水**（`ledgers_std` 实时直读，不走 10 分钟缓存）：
  - 今日已有到账 → **跳过** `POST /userapi/v1/user-info`（当天开过桌面端就已发放，调用次数零浪费）；
  - 今日无到账 → 打 user-info 触发，再回读一次流水确认（触发后读不到也不影响签到结论）。
  - 判定与 agent2api 同口径：`wallet_scope === "campaign"` 且 `mutation_type === "credit"`，`occurred_at` 按北京日算今天，`metadata.event_type` 前缀命中 `autoclaw_user_active` / `autoclaw_user_signup_day`（缺 `event_type` 时退回 `activity_id` 前缀 `autoclaw_user_active_reward` / `autoclaw_user_active_bonus`）。日期或流水读不到按「未知」处理，不误报。读取失败（5xx / 网络）只当未知，**绝不把签到判成失败**。
  - user-info 必须带官方桌面端指纹头（`User-Agent: AutoClaw/2.2.0 (win-x64)`、`X-Version: 2.2.0`、`X-Tm: win-x64`、`X-Channel: AutoClaw20`、`X-Product: autoclaw`、`X-Lang: zh-CN`、签名头、`Authorization: Bearer`、`X-Trace-Id`）。服务端只在这套指纹下记录 `autoclaw_user_active` 并发放「用户登录奖励」类活动积分。device_id 依次取凭据里的 `deviceId` → access JWT 的 `device_id` claim → refresh JWT 的 claim。先在 `AUTOCLAW_USERAPI_BASE_URL` 试，失败再试 `https://autoglm-api.zhipuai.cn`。
- **签到卡（桌面端 2.5.x 的每日 +300）**：`GET /asset-operation/api/v1/checkin/card` 读卡，`POST /asset-operation/api/v1/checkin/claim`（body 只有 `{"client_request_id":"<uuid>"}`）领取，host 与账号域同一个。它与任务签到**叠加**：开过桌面端的日子入账 500（任务 200 + 卡 300），只跑任务的日子是 200。金额取卡的 `daily.amount`（免费账号 300、会员 600），插件只相加、不写死。
  - 头与客户端一致：签名头（`X-Auth-Appid`/`X-Auth-TimeStamp`/`X-Auth-Sign`）+ `X-Version: 2.5.3` + `X-Tm`/`X-Product: autoclaw`/`X-Lang: zh-CN`/`X-Channel: official` + `Authorization: Bearer` + `X-Request-ID` + `Accept: application/json`；**不带** `X-Harness-Type` / `X-Client-Type`（该路由按桌面端解析，不能带 magpie 的指纹）。探测显示 1.18.5 与 2.5.3 返回一致，这里取客户端真实版本。
  - 幂等：`client_request_id` 由账号键 + 卡返回的 `biz_date` 经 sha256 派生成 UUID 形态（版本位 4、变体位 89ab），同一账号同一北京日稳定。magpie 的 30 分钟重试和重复「Check in now」都落在服务端同一个幂等键上，不会重复领取。
  - 结果码：`0` 且 `result ∈ {success, partial_success}` → 金额取 `claimed_amount`（缺失时取 `replayed !== true` 的 `items[].amount` 之和），`>0` 记 `claimed`、否则 `done`；`650304` 已领取 / `650302` 处理中 → 视为今日已领（`done`，不重试）；`650301` 无资格 / `650303` 身份不可用 → 不可领（`ineligible`，只记在消息里、不算失败）；`410000` → 登录失效（与任务段一致，整次签到抛 `expired`）；其余业务码、5xx、网络失败 → `failed`，**不阻断任务签到**。
  - 读卡 `code !== 0` / 请求失败 / `card_visible !== true` 一律跳过（不猜、不领）。
- **每日双任务（checkin）**：`fresh()` → 活动流水直读（今日到账？→ 跳过或触发 user-info → 回读确认）→ **签到卡（读卡 + 领取）** → `GET /autoclaw-proxy/proxy/autoclaw-task-list` → `POST /autoclaw-proxy/proxy/autoclaw-task-complete`。签到卡排在 task-list **之前**，所以「任务列表为空」的早退不会吞掉它。两个任务——先 `daily_signin`（每日签到，200/日），再 `daily_inspiration_center`（进入灵感中心，200/日，客户端触发、幂等）。task-list 里 `status === "completed"` 的任务跳过；task-list 请求失败（网络/5xx/非 envelope）退回直接打两个任务（幂等）。空列表或两个任务都不存在时，按签到卡决定结果：卡领取成功 → `claimed`「当前没有签到任务；签到卡 +300」，卡今日已领 → `done`，卡不可见/读不到才 `inactive`「当前没有签到活动」。`credit` 为实际 `reward_points` 之和**再加上签到卡金额**（仅卡 `claimed` 时；**不含活动奖励**）。`message` 用「；」拼接两项任务结果，再追加签到卡段（claimed → `签到卡 +300`；done → `签到卡今日已领`；ineligible → `签到卡不可领（<原因>）`；failed → `签到卡：<原因>`；skipped → 不追加），活动奖励仍只在末尾追加：今日已到账 → `；活动奖励已到账 +10,000（每周限时激励）`（多活动 `（2 个活动）`、无活动名不带括号、千分位）；无到账且 user-info 未到达 → `；活动奖励未触发（登录未上报）`；无到账但 user-info 到达或流水读不到 → 不追加。任务与签到卡互相独立：任一非鉴权失败不阻断其余、失败原因透传上游 `msg`；`401`/业务码 `410000`/`SignedOut` 判为登录失效（`signIn: "expired"`）。上游 `code != 0` 一律按失败处理，不猜测、不重试。

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
| `AUTOCLAW_WEB_BASE_URL` | `https://autoglm.zhipuai.cn`（网页版免密链接的站点，`web` CLI 的 `--base` 优先级更高） |
| `AUTOCLAW_AUTH_FILE` | 不设时按上文「凭据定位与写回锁」的顺序推导（显式指向 `plugin-auth.json`，测试专用） |
| `AUTOCLAW_USERINFO_ALT_BASE_URL` | `https://autoglm-api.zhipuai.cn`（user-info 首个 base 失败后的备用账号域） |
| `AUTOCLAW_USAGE_STATE_FILE` | `$XDG_CONFIG_HOME/magpie/autoclaw-usage.json` → `$HOME/.config/magpie/autoclaw-usage.json`（Windows 用 `USERPROFILE` 兜底；存「本轮消耗」的本地基线） |
| `AGENT2API_DB` | `~/.agent2api/agent2api.db`（导入源，只读） |

`AUTOCLAW_USAGE_STATE_FILE` 存的是本地记账基线 `{ accts: { "<key>": { peak, balance, day, daySpent, dayGained, at } } }`：写入走临时文件 + rename、权限 `0600`、30 天未动自动清理，日界按北京时间。换机器/多实例会丢基线（首轮不出「本轮消耗」行），可接受。

## 网页版快捷登录链接（web CLI）

网页端 `checkToken()` 会读取 `?autoglm_token=`、Bearer 化后写入浏览器登录态，因此 access token 本身就是一条免密登录链接。magpie 的 Usage 表格会把长文本截断且没有复制动作（`white-space: nowrap` + 固定列宽、单元格不在可选中区、`usage.windows` 也没有 url/link 字段），链接便改由包内的 `web.mjs` 打印：

```
# 本地自用（bin 入口，Windows 上 npm 生成 .cmd）
bunx magpie-autoclaw-cn-auth web [--account <key>] [--print]
npx magpie-autoclaw-cn-auth web [--account <key>] [--print]
# 直接跑包内脚本
bun packages/autoclaw-cn-auth/web.mjs [--account autoclaw#9q9l5x] [--print]
node packages/autoclaw-cn-auth/web.mjs [--account autoclaw#9q9l5x] [--print]
```

| 参数 | 作用 |
|---|---|
| `--account <key>` | `plugin-auth.json` 的账号键，默认 `autoclaw`；第二账号形如 `autoclaw#9q9l5x` |
| `--print` | 只打印链接，不打开浏览器（stdout 保持干净，便于管道） |
| `--no-open` | 同 `--print` |
| `--base <url>` | 覆盖网页站点，等价 `AUTOCLAW_WEB_BASE_URL`（便于自测） |

输出三行（账号 / 链接 / 有效至，时间为北京时间）：

```
账号：185****9906（autoclaw）
链接：https://autoglm.zhipuai.cn/?autoglm_token=eyJ…
有效至：2026-11-26 11:52（北京时间）   ← 链接随 access 过期失效
```

token 距过期不足 5 分钟（`REFRESH_LEAD`）且有 refresh token 时，脚本先走插件的续期协议、再打印新链接（此后至少还有 5 分钟可用）；没有 refresh token 则不续期，只在 stderr 提示剩余分钟数。默认按平台打开浏览器：`start`（win32）/ `open`（darwin）/ `xdg-open`（linux），spawn 失败退回只打印。

### 凭据定位与写回锁

凭据文件（OpenCode `auth.json` 形状）按以下顺序定位，Windows 上空 `HOME` 绝不会退化成盘根（`C:\.config`）：

`AUTOCLAW_AUTH_FILE`（显式文件）→ `AUTOCLAW_CONFIG_DIR` → `$XDG_CONFIG_HOME/magpie` → `$HOME/.config/magpie` → `%USERPROFILE%\.config\magpie` → `os.homedir()`。

续期结果写回时严格遵守宿主的锁协议（`host.js` 的 `lockAuth`/`writeAuth`）：

- 互斥文件 `plugin-auth.json.lock`，`openSync(lock, "wx", 0o600)` 成功即持有；`EEXIST` 时按 5–50ms 退避重试；
- 锁文件 mtime 超过 **10 秒**视为崩溃残留，删除后继续；总等待上限 **20 秒**，超时报错；
- **加锁后重新读取**文件，只改目标账号的 `access/refresh/expires`，其他账号保持读到的最新值（不会覆盖宿主刚写入的别家 token）；
- 原子写：临时文件 `plugin-auth.json.<pid>.tmp` → `rename`，内容 `JSON.stringify(all, null, 2) + "\n"`，权限 `0600`；结束后无论成败都删锁。

写回失败（目录不可写等）时**仍然打印链接**（当前 access 仍有效），只在 stderr 警告「续期成功但写回失败…magpie 中的 refresh 已失效，请重新登录」，退出码仍为 `0`。

续期请求本身失败（网络错误 / refresh 已失效）时：当前 access 还没过期就仍打印链接并在 stderr 告警「续期失败…链接即将失效」；access 已过期则按未登录退出码 `2`。`expires` 缺失（token 无 `exp` claim）时不猜测、不续期，`有效至` 显示为「未知」。

### 退出码

| 码 | 场景 |
|---|---|
| `0` | 已打印链接（含「写回失败」「无法自动打开浏览器」等警告；锁等待超时也走写回失败告警，不改变退出码） |
| `1` | 参数错误、I/O 错误 |
| `2` | 未登录：账号键不存在、`type !== "oauth"`、缺 `access`、凭据文件缺失或损坏 |

### 安全提示

- 链接**等同于实时登录凭证**：`--print` 输出、终端回滚、截图、日志、工单、聊天记录里都不要带完整链接；
- 脚本只读本机 `plugin-auth.json`（续期时按上面的锁协议写回），不联网保存、不外发链接；但它属于完全受信的执行，不要在不可信的 cwd 里跑外来副本；
- 链接随 `access` 过期失效；需要更长的可用时间就在 magpie 里重新登录。

## 测试

```
cd packages/autoclaw-cn-auth && bun test
```

测试打到本地 fake 上游（`fake.mjs`），**不触网、不使用真实 token**：fake 会重新计算并校验 `X-Auth-Sign`、校验 `X-Authorization`/`X-Request-Model`/`body.model`、模拟 406 预校验与 `400002` 降级、两个每日任务各自的幂等两态与独立失败开关，以及 user-info 官方指纹头校验、task-list 状态/失败/403 额度与封禁、`ledgers_std` 可配置流水（含 `occurred_at`/`metadata`）与 5xx、user-info 到达后追加今日活动 credit 的 `creditOnUserInfo` 开关、聊天 403 额度/封禁。签到卡的两条路由（`checkin/card`、`checkin/claim`）可配置可见性、可领金额、状态、日金额、北京日与各业务码/HTTP 状态（`cardVisible`/`cardClaimable`/`cardStatus`/`cardDailyAmount`/`cardMode`/`cardReadCode`/`cardClaimCode`/`cardReadStatus`/`cardClaimStatus`），并校验客户端头（无 `X-Harness-Type`/`X-Client-Type`、`X-Request-ID` 为 UUID、`X-Version: 2.5.3`、Bearer、签名）与 UUID 形态的 `client_request_id`；记录 `cardCalls`/`claimCalls`/`lastCardHeaders`/`claimRequestIds`，领取成功后卡状态翻为 `claimed`，`reset()` 复位。`AUTOCLAW_USAGE_STATE_FILE` 在测试中由 `_internal.setUsageStatePath` 指向临时目录，绝不写真实 `~/.config/magpie`。

`web.test.mjs` 覆盖 `web` CLI：凭据文件与锁文件全部在 `mkdtemp` 目录内（通过 `AUTOCLAW_AUTH_FILE` 指向），续期只打 fake 的 `127.0.0.1`，`opener` 与「现在时间」均为注入，测试不启动任何浏览器；用例包括不续期只打印、临期续期 + 带锁写回保留他键、等待他人锁、清理 10 秒残留锁、写回失败仍输出、无 refresh 的剩余分钟提示、未登录退出码 2、`--account` 第二账号、`--print`/`--no-open` 不开浏览器等。

## 许可

MIT。请求逻辑移植自 aimod-cc/agent2api（MIT）。
