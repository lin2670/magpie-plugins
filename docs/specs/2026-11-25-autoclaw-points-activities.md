# AutoClaw 国内版：对齐社区实现的积分活动能力（user-info 奖励 / 活动流水 / 积分口径 / 错误语义）

- 日期：2026-11-25
- 仓库：`magpie-plugins`，包 `packages/autoclaw-cn-auth`（0.2.0 → 0.3.0）
- 参考：`magpie-community/plugins` @ `packages/autoclaw` v0.2.25（`@magpie-community/opencode-autoclaw-auth`）
- 状态：待实现

## 1. 背景

社区包（0.2.25，2026-11）实现了本插件缺失的一整块「积分活动」能力，且其结论有真机证据（yetone/magpie#3681、plugins#1157 等）。本插件只做了「签到 + 灵感中心 + 钱包窗口」，缺口如下：

| 能力 | 社区实现 | 本插件现状 | 结论 |
|---|---|---|---|
| 登录类活动奖励（国内「用户登录奖励」+5000 / 国际 Weekly Perks +4000） | checkin 里调 `POST /userapi/v1/user-info`，必须带官方桌面端指纹头，服务端才记 `autoclaw_user_active` 并发奖 | 无 → 这类活动一直领不到 | **P1 必做** |
| 活动积分展示 | `GET /agent-assetmgr/api/v1/ledgers_std?wallet_scope=campaign`，按 wallet 实例 `credit − debit − expire` 对账，10 分钟缓存，失败省略 | 无 | **P2 必做** |
| 积分显示口径 | `积分余额`窗口（`balance`+`unit`，magpie ≥0.1.1790 路由用）+ 每日签到状态行 + 本轮消耗（本地余额差，aside）+ 活动积分行（aside）；细分钱包折进 `balance` 字符串 | 每个钱包一个窗口（`used:0`），无签到行/本轮消耗 | **P3 必做** |
| 403 语义 | 额度用尽（403 + `810000`/额度文案）→ 429 且 `X-Magpie-Sign-In: kept`；封禁（403 + `410004`/封禁文案）→ 403 且 kept；裸 `forbidden` 指纹拒绝 → 查积分确认后 kept | 一律原样 403（会被 magpie 判登录失效） | **P4 必做** |
| 签到前先查 task-list | 有任务才打、已完成跳过；空列表=inactive；双 host 无响应=失败 | 直接打两次 task-complete（幂等） | P4 顺带：加 task-list 前置（失败则退回直打） |
| user-profile 显示名 | 登录/刷新时拉昵称手机号 | 手机号掩码/导入名 | 不做（与积分无关，另立需求） |
| 插件 options（signin/signinOnUsage/signinHour/dump406） | 旧链路补签 + 406 落盘 | 无 | 不做（magpie 原生 checkin 已覆盖调度；406 落盘是诊断需求） |
| 多账号池 / 国际版 OAuth | 有 | 无 | 不做（本插件定位国内单账号） |

## 2. 实测前提（2026-11-25）

1. **聊天整形两种形状都能过**：本插件当前形状（`You are a personal assistant running inside OpenClaw.` 前缀 + `max_tokens` 抬到 10000）与社区形状（`You are AutoClaw. ...` 前缀 + 删除 `max_tokens`）各发一条真实请求，均返回 200。→ **不改聊天整形**，避免无谓 churn。
2. magpie 版本 `0.1.4777`：`windows[].balance`（#3950 路由）、`runsOutAt`/`runsOut`、`aside` 均支持（`host.js` 白名单）。
3. 账号域：社区国内账号走 `https://autoglm-api.zhipuai.cn`，聊天走 `https://autoglm-acceleration-api.zhipuai.cn`；本插件目前两者都走 acceleration host 且 task-list/wallets 实测可用。**user-info 先在现有 host 试，失败再试 `autoglm-api.zhipuai.cn`**（不改变现有 base 配置语义）。
4. 今天该账号两个每日任务均已领，活动流水尚未核对（P2 上线后即可看到历史）。

## 3. 设计

### P1：checkin 增加 user-info 活跃事件（活动奖励）

- 新增 `callUserInfo(access, deviceId, base)`：
  - `POST {base}/userapi/v1/user-info`
  - body：`{"source_id":"autoclaw","device_id":<deviceId>}`
  - 必须带**官方桌面端指纹头**（服务端只认这套）：
    | 头 | 值 |
    |---|---|
    | `User-Agent` | `AutoClaw/2.2.0 (win-x64)` |
    | `X-Version` | `2.2.0` |
    | `X-Tm` | `win-x64` |
    | `X-Channel` | `AutoClaw20` |
    | `X-Product` | `autoclaw` |
    | `X-Lang` | `zh-CN` |
    | `X-Auth-Appid` / `X-Auth-TimeStamp` / `X-Auth-Sign` | 同签名头（`md5(appId&ts&appKey)`） |
    | `Authorization` | `Bearer <access>` |
    | `X-Trace-Id` | 随机 16 hex |
  - deviceId 选取：`auth.deviceId` → access JWT 的 `device_id` claim → refresh JWT 的 `device_id` claim → 空串。
- checkin 流程：`fresh()` → **user-info（尽力而为）** → task-list（见 P4 顺带）→ 双任务 task-complete → 组合结果。
  - user-info 网络错误 / 非 2xx / `code != 0`：不阻断签到，message 末尾追加 ` · 活动奖励未触发（登录未上报）`。
  - user-info 成功（2xx + `code === 0`）：不做额外提示；立即失效活动流水缓存（P2）。
- 不读取返回体的 `daily_check_in_completed_on_request`（社区实测恒 false，签到仍由 task-complete 完成）。

### P2：活动积分行（campaign 流水对账）

- `GET {base}/agent-assetmgr/api/v1/ledgers_std?biz_app_id=autoclaw&page_size=200&wallet_scope=campaign`
- 解析：只认 `wallet_scope === "campaign"`（服务端可能忽略过滤，客户端必须再过滤）且 `mutation_type ∈ {credit,debit,expire}` 的流水；按 `wallet_id` 实例聚合：
  - `remaining = max(0, credit − debit − expire)` 求和；`claimed = Σcredit`；`expired = Σexpire`
  - `wallet_expires_at`（epoch 秒）取最小未到期实例的到期时间 → `lapseAt`；该时刻到期实例剩余之和 → `lapsing`
- 展示（`usage.windows` 末尾，`aside: true`，不带 `balance`，避免被当第二个资金池）：
  - 有流水时：`{ name: "活动积分", used: 0, display: "剩 4,000（活动名） · 已领 14,000 · 过期 7,711（近期）" }`
  - 活动名取 `metadata.description` 或 `description`，去掉尾部 `+4000 credits/积分`
- 缓存：按账号键 10 分钟；**失败不缓存**（下次 usage 立即重试）；协议变更（`entries` 非数组）按 null 缓存；user-info 成功时清缓存。上限 100 条。
- 任何读取失败只省略该行，绝不影响余额/签到行。
- 若 `lapsing > 0` 且 `total > 0`：在 `积分余额` 窗口上写 `runsOutAt`（ISO）与 `runsOut = min(total, lapsing)`。

### P3：积分显示口径

`usage()` 重写为（窗口顺序即展示顺序）：

1. `本轮消耗`（仅 `used > 0` 时）：`{ name: "本轮消耗", aside: true, used: pct, amount, limit, display: "1,200 / 12,700 积分 · 今日 -1,200 · 今日 +200" }`
   - pct = `min(100, round(used/peak*1000)/10)`；amount/limit 为原始积分
2. `每日签到`：`{ name: "每日签到", used: 0, aside: true, display: "今日已签 ✓ +200" | "今日未签（+200）" }`（状态取自 task-list，读不到则无此行）
3. `积分余额`：`{ name: "积分余额", balance: total, unit: "积分" }`（不设 `used`；可选 `runsOutAt`/`runsOut`）
4. `活动积分`（P2，可选）
5. `网页版快捷登录`（保留现有功能，`aside: true`，`display` = `?autoglm_token=<fresh>`）

顶层 `balance`：`"12,700 积分（赠送积分 200 · 通用积分 12,500）"`（细分钱包：`display !== false` 且 `balance > 0` 且四舍五入不等于总数；最多 3 项；千分位分组）。`fmtPoints` 手写分组，不依赖 locale。

本轮消耗状态（本地）：
- 文件：`AUTOCLAW_USAGE_STATE_FILE` → `$XDG_CONFIG_HOME/magpie/autoclaw-usage.json` → `~/.config/magpie/autoclaw-usage.json`（Windows 用 `USERPROFILE` 兜底，绝不落 `C:\.config`）
- 结构：`{ accts: { "<key>": { peak, balance, day, daySpent, dayGained, at } } }`，key = `autoclaw|uid:<userId>`（无 uid 则 `autoclaw|tok:<sha256(refresh|access).slice(16)>`）
- 规则：`total > 上次 balance`（含从 0 回升）即开新一轮（peak=total、used=0）；`total < 上次` 累计当日消耗；北京日界 `beijingDayOf()`；30 天未动清理；写入 tmp+rename、0600；测试用 `_internal.setUsageStatePath` 指向临时文件。
- `total_balance` 为 null/空串/非数 → 返回 `{ error: "积分响应异常", windows: [] }`（不记 0，避免误判花光）。

### P4：403 错误语义（聊天链路 + task-list）

- 新判定（聊天 response 与 task-list 403 共用）：
  - 封禁：`code === 410004` 或 message 含 banned/封禁/账号异常/账号被冻结 → 聊天转 `403 permission_error` + `X-Magpie-Sign-In: kept`；task-list 抛 `{ banned, signIn: "kept" }`
  - 额度用尽：`code ∈ {810000, 810001}` 或 message 含 额度/余额已用完/系统繁忙·升级会员 → 聊天转 `429` + kept，原文案透传；task-list 抛 `{ quota, signIn: "kept" }`
  - 其余 401/403：保持现有 `expired` 语义
- 不做：413 请求过大判定（需记录成功请求大小，复杂度高）、裸 `forbidden` 指纹确认（社区用积分接口二次确认）——记为后续观察项。

### P4 顺带：checkin 前置 task-list

- `GET …/autoclaw-task-list`（带签名 + Bearer）：
  - 两个任务都存在：`status === "completed"` 的跳过、只打未完成的；
  - 列表为空数组：返回 `{ outcome: "inactive", message: "当前没有签到活动" }`；
  - 请求失败（网络/5xx/非 envelope）：**退回当前行为**（直接打两个 task-complete，幂等），message 不变；
  - 401/403 按 P4 语义（quota/banned → kept；其余 expired）。
- 结果矩阵沿用现有（签到×灵感中心），credit 求和、失败互不阻断。

## 4. 改动清单

| 文件 | 改动 |
|---|---|
| `index.mjs` | 新增 user-info / campaign / 用量状态模块；重写 `usage()`、`checkin()` 流程；聊天 403 语义；task-list 前置；`_internal` 导出新函数；版本注释 |
| `fake.mjs` | 新增 `user-info`（校验官方指纹头，记 `userInfoCalls`）、`ledgers_std`（可配置 entries）、task-list 双任务状态、403 额度/封禁开关；reset 复位 |
| `index.test.mjs` | 现有 42 条保持 + 新增（见 §5） |
| `README.md` | 活动奖励、活动积分行、积分口径、403 语义、`AUTOCLAW_USAGE_STATE_FILE` |
| `package.json` | 0.2.0 → 0.3.0 |

## 5. 测试用例（fake-only，零外网）

1. checkin：先 user-info 后两个 task-complete；user-info 头完整（UA/X-Version/X-Tm/X-Channel/X-Auth-Sign/Authorization）；成功时 message 无「未触发」。
2. checkin：user-info 失败（网络/非0码）→ 签到照常 claimed，message 追加「活动奖励未触发（登录未上报）」。
3. checkin：task-list 标记 daily_signin 已完成 → 不重复打该任务；灵感中心仍打；outcome done。
4. checkin：task-list 空数组 → `inactive`「当前没有签到活动」，零 task-complete。
5. checkin：task-list 5xx → 退回直打两任务（claimed 400）。
6. checkin：task-list 403 + 810000 → 抛 `{quota, signIn:"kept"}`，不轮换 token。
7. usage：窗口顺序 `[本轮消耗?, 每日签到, 积分余额, 活动积分, 网页版快捷登录]`；`积分余额` 有 `balance/unit` 无 `used`。
8. usage：活动流水对账（credit/debit/expire、非 campaign 条目被过滤、窗口外实例按 0 计）；活动行文本与千分位正确；`entries` 空数组 → 无活动行。
9. usage：`ledgers_std` 5xx → 省略活动行、余额行照常；10 分钟内第二次不重复请求（缓存），user-info 成功后缓存失效重拉。
10. usage：`total_balance` 为 null → `{error:"积分响应异常", windows:[]}`。
11. usage：本轮消耗——首次无行；余额上涨开新轮；余额下降累计 used；`AUTOCLAW_USAGE_STATE_FILE` 隔离不影响真实目录。
12. 聊天：403 + 810000 → 429 + `X-Magpie-Sign-In: kept`；403 + 410004 → 403 + kept；401 → 401 + expired。
13. 既有 42 条全绿（含网页入口窗口、模型、签名、续期、聊天整形）。

## 6. 验收标准

- `bun test` 全绿（≥ 60 用例），fake 只打 127.0.0.1。
- 窗口字段严格落在 host.js 白名单（`name/used/display/aside/balance/unit/amount/limit/runsOutAt/runsOut`），无自造字段；活动行不带 `balance`。
- user-info 头与社区实测值一致（`AutoClaw/2.2.0 (win-x64)`、`X-Version: 2.2.0`、`X-Tm: win-x64`、`X-Channel: AutoClaw20`）。
- 403 语义：额度/封禁不改登录状态；其余 401/403 仍 expired。
- README 与实现一致。

## 7. 风险

- user-info 发奖依赖上游对指纹的判定，若上游再改版可能失效；失败时只提示「未上报」，不影响签到。
- 活动流水的 `~151 条`窗口限制：极老活动不计入「剩」，但失效额仍计入「过期」；按社区口径接受。
- 本轮消耗依赖本地状态文件；换机器/多实例会丢基线（首轮无行），可接受。
- 领活动奖励是真实写操作（+5000 一次性），实现后需用真实账号验证一次（本次规格允许，单账号）。
