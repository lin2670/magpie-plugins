# AutoClaw 国内版：签到活动奖励的「先查后触发 + 到账确认 + 消息呈现」

- 日期：2026-11-25
- 仓库：`magpie-plugins`，包 `packages/autoclaw-cn-auth`（0.3.0 → 0.4.0）
- 参考：agent2api autoclaw 插件 `checkin.rs` / `promotion.rs`（crates/providers/src/providers/autoclaw）
- 状态：待实现

## 1. 背景

agent2api 的 promotion 逻辑比我们完整：签到后先读活动流水判断「今天是否已到账」，未到账才打 `user-info`，打完回读确认，并把到账明细拼进签到消息。2026-11-25 11:52 实测：两个新导入账号各到账 +10,000「每周限时激励」（`event_type=autoclaw_user_active`、`activity_id=autoclaw_user_active_reward_202609`、`occurred_at=2026-11-25T11:52:16.804+08:00`），就是这条链的结果。

我们的 0.3.0 只做了「无条件打 user-info」，不确认、不呈现。本次补齐这三项。

## 2. 设计

### 2.1 今日活动到账判定

新增 `todayActivityReward(entries, now)`：

- 只认 `wallet_scope === "campaign"` 且 `mutation_type === "credit"` 的流水；
- 事件匹配（与 agent2api 同口径）：
  - 主判据：`metadata.event_type` 前缀命中 `["autoclaw_user_active", "autoclaw_user_signup_day"]`
  - 兜底（event_type 缺失）：`activity_id`（顶层或 `metadata.activity_id`）前缀命中 `["autoclaw_user_active_reward", "autoclaw_user_active_bonus"]`
- 日期口径：`occurred_at` 解析后按**北京日**（`beijingDayOf`）等于今天才计入；
- 返回 `{ amount, labels: string[], count }`（amount 求和；labels 取 `metadata.description`/`description`，去重、截 40 字、去掉尾部 `+N credits/积分`）；无命中返回 `null`。

### 2.2 checkin 流程（替换当前 user-info 段）

```
fresh → 读活动流水(直读，不走缓存) → todayReward?
  ├─ 有 → 跳过 user-info
  └─ 无 → user-info（现有尽力而为 + 双 base）
           → 若 user-info 到达，再直读一次活动流水 → todayReward?
→ task-list（现有 P4 前置逻辑）→ 补打两个任务 → 组合 message
```

- 活动流水用 `fetchCampaignLedger` 直读（checkin 每日一次，必须实时；读取失败 `null`，不缓存、不阻断）。
- user-info 成功/失败后照旧失效 `campaignCached`（usage 下次重拉）。
- **message 拼接**（在现有任务消息之后追加，用「；」分隔）：
  - 今日有到账：`；活动奖励已到账 +10,000（每周限时激励）`（多活动：`（2 个活动）`；无 label：不写括号；金额千分位）
  - 无到账且 user-info 未到达：`；活动奖励未触发（登录未上报）`（沿用现有文案，仅在确认没到账时出现）
  - 无到账且 user-info 到达：不追加（活动窗口正常结束的情况，不制造噪音）
  - 活动流水读取失败：不追加（未知不等于未触发）
- `outcome` / `credit` 语义不变（credit 仍只算两个日常任务的 reward_points，活动奖励只进 message）。

### 2.3 不做

- 不引入 agent2api 的 `pluginLedger` claim 台账（magpie 的 `plugin-checkin.json` 已记录每日结果，重复触发代价极低）。
- 不改 `page_size=200`（现有窗口更宽）。
- 不改 usage 的「活动积分」行与 10 分钟缓存。

## 3. 改动清单

| 文件 | 改动 |
|---|---|
| `index.mjs` | 新增 `ACTIVITY_EVENT_PREFIXES` / `ACTIVITY_ID_PREFIXES` / `todayActivityReward` / `readCampaignForCheckin`；重写 checkin 的 user-info 段与 message 组合；`_internal` 导出新函数 |
| `fake.mjs` | `campaignEntries` 支持 `occurred_at` / `metadata`；新增 `creditOnUserInfo` 开关（user-info 到达后向流水追加一笔今日 credit，模拟发奖）；`ledgerStatus` 已有 |
| `index.test.mjs` | 新增用例（见 §4），既有 65 条保持 |
| `README.md` | 签到消息中的活动奖励、先查后触发 + 回读确认语义 |
| `package.json` | 0.3.0 → 0.4.0 |

## 4. 测试用例（fake-only）

1. 今日流水已有 `autoclaw_user_active` 到账 → **user-info 不再调用**（`userInfoCalls=0`），message 含 `活动奖励已到账 +10,000（每周限时激励）`，两个任务照常。
2. 今日无到账 → user-info 调用 1 次 → fake 在 user-info 后追加今日 credit → message 含到账文本；`campaignCache` 被失效（usage 再读会重拉）。
3. 今日无到账 + user-info 失败 → message 追加 `活动奖励未触发（登录未上报）`，任务结果不受影响。
4. 事件过滤：`autoclaw_checkin_daily` 或 `occurred_at` 为昨天的 credit 不计入；`event_type` 缺失但 `activity_id=autoclaw_user_active_bonus_*` 计入；`autoclaw_user_signup_day`（新手期）计入。
5. 活动流水读取失败（5xx）→ checkin 正常（user-info 仍尝试、任务照常），message 不含活动段。
6. 多活动到账：两笔不同 label → `（2 个活动）`，金额求和。
7. 回归：既有 65 条全绿（含 403 语义、积分口径、网页入口、双任务）。

## 5. 验收标准

- `bun test` 全绿（≥ 72 用例），fake-only、零外网、状态文件隔离。
- message 文案与 §2.2 逐条一致；`credit` 不含活动奖励。
- 不新增窗口字段、不改 usage 行为。
- README 与实现一致。

## 6. 风险

- 上游活动流水的 `event_type`/`activity_id` 命名若再换家族，今日到账可能识别不到；届时只影响「消息呈现」与「跳过 user-info」的优化，签到本身不受影响（user-info 仍会打）。
- `occurred_at` 若缺失或时区异常，该笔不计入今日（保守处理，不会误报）。
