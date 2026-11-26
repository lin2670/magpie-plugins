# AutoClaw 国内版：领取桌面端「签到卡」的每日 +300 积分

- 日期：2026-11-26
- 仓库：`magpie-plugins`，包 `packages/autoclaw-cn-auth`（0.5.0 → 0.6.0）
- 状态：探测已通过，待实现

## 1. 背景

AutoClaw 桌面端 2.5.x 不调用任务列表（其代码里 `autoclaw-task-list` / `daily_signin` / `upgrade_pc_app` 命中数为 0），它用的是另一套**签到卡**接口。签到卡与本插件已有的任务签到**叠加**：开过桌面端的日子入账 500（任务 200 + 卡 300），没开的日子只有 200。

### 1.1 只读探测结果（2026-11-26，仅 GET，无副作用）

对三个账号各发 `GET /asset-operation/api/v1/checkin/card`，`X-Version` 取 `1.18.5` 与 `2.5.3` 两轮，**返回完全一致**（不按版本号下发）：

| 账号 | `card_visible` | `claim_status` | `total_claimable_amount` | `claimed_amount` | `daily.amount` |
|---|---|---|---|---|---|
| 185****9906 | true | claimed | 0 | 300 | 300 |
| 173****7959 | true | unclaimed | **300** | 0 | 300 |
| 173****8325 | true | unclaimed | **300** | 0 | 300 |

两个从未登录过桌面端的 173 账号同样可领 → 300 **不是**「登录过桌面端」才有的权益，插件可以直接领取。`events: []`、`rewardGroups` 无、`vip_benefit.text_type: "upgrade"`（免费账号）。

### 1.2 协议（本机客户端 `resources/app/dist/main.cjs`）

- host：`https://autoglm-acceleration-api.zhipuai.cn`（与本插件账号域同一个，即 `userapiBase()`）
- `GET /asset-operation/api/v1/checkin/card`：读卡
- `POST /asset-operation/api/v1/checkin/claim`，body `{"client_request_id":"<uuid>"}`：领取
- 请求头：签名头（`X-Auth-Appid` / `X-Auth-TimeStamp` / `X-Auth-Sign`）、`X-Version`、`X-Tm`、`X-Product: autoclaw`、`X-Lang: zh-CN`、`X-Channel: official`、`Authorization: Bearer`、`X-Request-ID: <uuid>`、`Accept: application/json`。**不带** `X-Harness-Type`、`X-Client-Type`。
- 业务码：`0` 成功；`410000` unauthenticated；`650301` notEligible；`650302` processing；`650303` identityUnavailable；`650304` alreadyClaimed。
- 卡响应 `data`：`biz_date`、`card_visible`、`claim_status`（`unclaimed` / `claimed` / `processing`）、`total_claimable_amount`、`claimed_amount`、`daily{amount,title,validity_seconds,streak{…}}`、`events[]`、`claimed_items[]`、`vip_benefit`、`cta`。
- 领取响应 `data`：`result`（`success` / `partial_success`）、`biz_date`、`claimed_amount`、`retryable`、`items[]`（每项 `amount`、`status`、`replayed`、`reward_source`、`title`）、`popup_reward_groups`。客户端在 claim 成功后会**再读一次卡**取今日状态。

## 2. 设计

### 2.1 新增函数（`index.mjs`）

- 常量：`CHECKIN_CARD_PATH`、`CHECKIN_CLAIM_PATH`、`CHECKIN_CARD_VERSION`（`"2.5.3"`，与桌面端一致；探测显示版本不影响结果，取真实值最稳妥）。
- `checkinCardHeaders(token, requestId)`：在签名逻辑基础上构造客户端同款头——`X-Version: 2.5.3`、`X-Request-ID`、`Accept: application/json`、`Authorization`；不含 `X-Harness-Type` / `X-Client-Type`。签名计算复用 `AUTH_APP_ID` / `AUTH_APP_KEY`。
- `checkinCardRequest(method, path, { token, body })`：与 `userapiRequest` 同样的传输与错误形态（401 → `expired`，非 2xx → Error，解析失败 → Error），但用上面的头。**不改动 `userapiRequest` 本身**（它的 `X-Harness-Type` 对任务/积分接口是已验证可用的，不要连带改）。
- `readCheckinCard(token)` → 归一化对象或 `null`：
  `{ bizDate, visible, status, claimable, claimed, dailyAmount, streakDays, todayCheckedIn, expiresAt }`
  `code !== 0` → `null`；`card_visible !== true` → `visible: false`。
- `claimCheckinCard(token, idempotencyKey)` → `{ kind: "claimed", amount } | { kind: "done" } | { kind: "ineligible", reason } | { kind: "failed", reason }`；鉴权失效抛 `expired`。
  - `code === 0` 且 `result ∈ {success, partial_success}`：`amount = data.claimed_amount ?? Σ items(replayed !== true).amount`；`amount > 0` → claimed，否则 done。
  - `650304` → done；`650302`（处理中）→ done（稍后的轮询会看到最终态）；`650301` / `650303` → ineligible；`410000` → expired；其余 → failed（带 msg）。

### 2.2 幂等键

`client_request_id` 对同一账号同一北京日**稳定**：由 `accountKey(ID, auth)` 与卡返回的 `biz_date` 经 sha256 派生成 UUID 形态（设版本位 4 与变体位）。这样 magpie 的 30 分钟重试、以及「Check in now」重复点击，都落在服务端同一个幂等键上，不会重复领取。

### 2.3 接入 `checkin()`

在活动奖励段之后、任务列表之前执行签到卡（**必须早于现有的两个 `return inactive` 提前返回**，否则任务列表为空时卡永远领不到）：

```
card = readCheckinCard()
cardResult =
  card 为 null                → { kind: "skipped" }            // 读不到：不猜、不领
  !card.visible               → { kind: "skipped" }            // 账号没有这张卡
  card.status ∈ {claimed, processing} → { kind: "done" }
  card.claimable <= 0         → { kind: "done" }
  否则                         → claimCheckinCard()
```

- 鉴权失效（expired）：与任务段一致，直接抛出（整次签到标记失效）。
- 其余任何失败**不阻断**任务签到。
- `ineligible` 不重试、不算失败，仅记录在消息里。
- 结果合并：
  - `credit += cardResult.amount`（仅 claimed）
  - `outcome`：若任务段为 `done` 而签到卡为 `claimed`，整体应为 `claimed`（否则 magpie 会把这一天记成「已签」且不再询问）。若任务段为 `inactive` 而签到卡 claimed/done → 仍返回 `inactive`？**否**——见下。
- 消息段（追加在现有消息之后，用「；」）：
  - claimed：`签到卡 +300`
  - done：`签到卡今日已领`
  - ineligible：`签到卡不可领（<原因>）`
  - failed：`签到卡：<原因>`
  - skipped：不追加
- `inactive` 的处理：当任务列表为空 / 两任务都不存在，但签到卡可见时，不再直接返回 `inactive`，而是继续走签到卡并以签到卡结果决定 `outcome`（claimed → `claimed`；done → `done`），消息写「当前没有签到任务；签到卡 +300」。两者都不可用才返回 `inactive`。

### 2.4 `usage()` 的「每日签到」行

读卡（失败则维持现状）后把签到卡金额并入：

- 任务已完成且卡已领：`今日已签 ✓ +500`（任务 `reward_points` + 卡 `daily.amount`）
- 任务未完成：维持现有 `今日未签（+N）`，N 同样取两者之和
- 只有卡、任务列表读不到：`今日已签 ✓ +300` 或 `今日未签（+300）`

为避免 `usage()` 多打一次请求导致延迟，读卡与现有 task-list、wallets、ledger **并行**（`Promise.all` / `allSettled`），且同样加 10 分钟缓存（键与 campaign 缓存分开；checkin 领取成功后失效）。

## 3. 改动清单

| 文件 | 改动 |
|---|---|
| `index.mjs` | 新增 2.1 的常量与函数、2.2 幂等键；`checkin()` 接入签到卡与 `inactive` 分支修正；`usage()` 每日签到行并入卡金额（并行 + 缓存）；`_internal` 导出新函数 |
| `fake.mjs` | 新增 `/asset-operation/api/v1/checkin/card` 与 `/claim` 两路由：可配置 `cardVisible`、`cardClaimable`、`cardStatus`、`cardDailyAmount`、各业务码开关、`cardMode`（normal / hidden / error / notEligible / alreadyClaimed / processing）；校验请求头（无 `X-Harness-Type`、有 `X-Request-ID`、Bearer 正确）；记录 `cardCalls` / `claimCalls` / `lastCardHeaders` / `claimRequestIds`；claim 成功后卡状态翻为 claimed；`reset()` 复位 |
| `index.test.mjs` | 新增用例（§4）；既有 96 条保持全绿 |
| `README.md` | 签到卡接口、与任务签到叠加、各结果码语义、免费账号 300 / 会员 600 |
| `package.json` | 0.5.0 → 0.6.0 |

## 4. 测试用例（fake-only，零外网）

1. 任务已完成 + 卡未领：`outcome: claimed`、`credit: 300`、message 含「签到卡 +300」；claim body 的 `client_request_id` 为 UUID 形态。
2. 任务未完成 + 卡未领：`credit: 400`（200 + 200? 依 fake 设定）、message 同时含任务段与「签到卡 +300」。
3. 卡已领（`claim_status: claimed`）：不发 claim（`claimCalls.length === 0`），message 含「签到卡今日已领」。
4. 卡不可见（`card_visible: false`）：不发 claim，message 不含「签到卡」。
5. 读卡失败（5xx / code≠0）：不发 claim，任务签到照常 claimed，message 不含「签到卡」。
6. claim 返回 `650304`：判 done；`650302`：判 done；`650301`：判 ineligible 且不重试（仅 1 次 claim）；`410000`：抛 expired。
7. claim 网络失败：任务签到照常，message 含「签到卡：」，`outcome` 仍为 claimed（任务段决定）。
8. 任务列表为空 + 卡未领：`outcome: claimed`、`credit: 300`、message 含「当前没有签到任务；签到卡 +300」（验证不再提前返回 inactive）。
9. 任务列表为空 + 卡不可见：`outcome: inactive`。
10. 幂等键：同一账号同一天两次 checkin 的 `client_request_id` 相同；不同账号不同；跨北京日不同。
11. 请求头：`x-harness-type` 为 undefined、`x-request-id` 为 UUID、`x-version` 为 `2.5.3`、`authorization` 正确。
12. usage：「每日签到」行在卡已领时显示 `今日已签 ✓ +500`；卡不可见时维持 `+200`；读卡失败维持现状；并行读取不增加总耗时（断言 wallets 与 card 均被调用一次）。
13. 既有 96 条全绿（含 0.5.0 的 web CLI 与窗口行）。

## 5. 验收标准

- `bun test` 全绿（≥ 109 用例，3 个文件），fake-only，凭据/状态文件全部隔离到临时目录。
- 签到卡任何非鉴权失败都不影响任务签到；鉴权失效语义与任务段一致。
- 幂等键同账号同日稳定。
- 请求头与客户端一致（无 `X-Harness-Type` / `X-Client-Type`）。
- `usage()` 的其余窗口（本轮消耗 / 积分余额 / 活动积分 / 网页入口）与字段集不变。
- README 与实现一致。

## 6. 风险

- 领取是真实写操作。实现后的首次真机验证会让两个 173 账号各入账 +300（这是预期结果）。
- 服务端若引入按版本的资格判定，需更新 `CHECKIN_CARD_VERSION`；探测已显示当前不按版本下发。
- `processing` 态按 done 处理，依赖 magpie 的 30 分钟轮询看到最终态；若服务端长期停在 processing，当天可能少记 300（只影响本地记账，不影响实际到账）。
