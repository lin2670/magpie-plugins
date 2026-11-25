# AutoClaw 国内版：每日双任务签到 + 网页快捷入口

- 日期：2026-11-25
- 仓库：`magpie-plugins`，包 `packages/autoclaw-cn-auth`（版本 0.1.1 → 0.2.0）
- 状态：已评审，待实现
- 关联：`docs/recon-agent2api-four-services.md`（AutoClaw 段）、`docs/magpie-plugin-mechanism.md`

## 1. 背景与实测证据

2026-11-25 用本机已登录账号（`185****9906`）只读/幂等实测：

1. `GET /autoclaw-proxy/proxy/autoclaw-task-list` 返回 4 个任务：

   | task_id | 标题 | 奖励 | 实测状态 | 可否用凭据完成 |
   |---|---|---|---|---|
   | `daily_signin` | 每日签到 | 200/日 | completed（已签到 43 天） | ✅ 插件已实现 |
   | `daily_inspiration_center` | 进入灵感中心 | 200/日 | incomplete，`client_triggered:true`、`display:false` | ✅ 同款 `task-complete`，幂等 |
   | `invite_friends` | 邀请好友 | 200/位（上限 15） | incomplete 0/15 | ❌ 需真人注册 |
   | `upgrade_pc_app` | 升级 PC 客户端 | 300/次 | incomplete 0 次 | ❌ 需真实升级 |

2. `POST …/autoclaw-task-complete` `{"task_id":"daily_inspiration_center"}` → `{already_completed:true, reward_points:0, success:false}`：当天已被客户端触发过，**接口幂等、无副作用**。说明该任务走的是与签到同一个通用任务接口。

3. 网页侧对同一 token 的接受度（AI 侧核对自 `autoglm.zhipuai.cn` 线上 bundle）：
   - `getApiHost() = "https://autoglm-api.zhipuai.cn"`，网页接口用 `Authorization: Bearer`；
   - `checkToken()` 读取 URL 参数 `?autoglm_token=`，`Bearer` 化后写入 localStorage 作为网页登录态；
   - 官方邀请链接模板本身携带 `autoglm_token={{token}}&autoglm_user_id={{userId}}`（`invite_friends` 任务的 `metadata.url`）。
   → 结论：插件存的 `access` 可直接作为网页免密入口，无需另立网页登录协议。

4. magpie 插件契约（`yetone/magpie` main @ 2026-11-25，`internal/plugin/host.js`）：
   - `auth.usage` 窗口字段：`name, used, resetsAt, resetSecs, display, amount, limit, unit, span, model, models, notModels, family, pool, aside, runsOutAt, runsOut, credits, balance`；**没有 url/link 字段**，未知字段会被宿主丢弃。
   - `auth.checkin` 返回：`outcome(claimed|done|ineligible|inactive|captcha|failed), credit?, streak?, message?, until?`；无 url 字段。
   → 网页入口只能以文本形式呈现，`usage` 窗口的 `display` 是唯一常驻可见位。

## 2. 设计决策

### D1：`checkin` 改为每日双任务

- 顺序：`daily_signin` → `daily_inspiration_center`，同一 `fresh()` 出来的 token 连打两次 `task-complete`。
- 两个任务相互独立：任一失败不阻断另一个；鉴权类失败（`401`/业务码 `410000`/`SignedOut`）立即抛 `expired`（整次签到标记失效，引导重登）。
- `credit` = 两次实际 `reward_points` 之和；`message` 用中文分号拼接两项结果。
- 结果矩阵：

  | 签到 | 灵感中心 | outcome | credit | message 示例 |
  |---|---|---|---|---|
  | claimed 200 | claimed 200 | `claimed` | 400 | 签到成功，获得 200 积分；灵感中心已领取 200 积分 |
  | claimed 200 | done/already | `claimed` | 200 | 签到成功，获得 200 积分；灵感中心今日已领 |
  | done/already | claimed 200 | `claimed` | 200 | 今天已签到；灵感中心已领取 200 积分 |
  | done | done | `done` | 0 | 今天已签到；灵感中心今日已领 |
  | claimed 200 | 失败（非鉴权） | `claimed` | 200 | 签到成功，获得 200 积分；灵感中心：<上游原因> |
  | 失败（非鉴权） | claimed 200 | `claimed` | 200 | 签到失败：<原因>；灵感中心已领取 200 积分 |
  | 失败 | 失败 | `failed` | 0 | 签到失败：<原因>；灵感中心：<原因> |

- 上游对单任务返回 `code != 0` 时按失败处理并透传 `msg`（例如任务未开始/下线），不猜测、不重试。
- 不改 `until`：magpie 已按北京日切调度，无需插件自报。

### D2：网页快捷入口 = `usage` 的只读文本窗口

- 新增环境变量 `AUTOCLAW_WEB_BASE_URL`（默认 `https://autoglm.zhipuai.cn`），与现有 `AUTOCLAW_USERAPI_BASE_URL`/`AUTOCLAW_UPSTREAM_BASE_URL` 同风格，便于测试覆盖。
- URL 构造：`${webBase}/?autoglm_token=${encodeURIComponent(access)}`；`access` 取 `usage()` 内 `fresh()` 之后的 token（临近过期会先续期，保证链接可用期 ≥ 5 分钟）。
- 以 `usage.windows` 追加一项呈现：`{ name: "网页版快捷登录", display: <url>, aside: true }`；**省略 `used`**（宿主语义：未上报 = 无占比，而不是 0%）。`aside: true` 表示该窗口用尽不影响账号可用性。
- 该窗口只加在 `usage` 成功路径；`usage` 报错时维持现有 `{error, signIn}` 行为。
- 不在 `checkin.message` 里重复拼 token（避免每日持久化一条长凭证）；README 记录手工构造方式。
- 安全提示写入 README：链接内含实时凭证，勿外发；随 access 过期失效。

## 3. 改动清单

| 文件 | 改动 |
|---|---|
| `packages/autoclaw-cn-auth/index.mjs` | 新增 `INSPIRATION_TASK_ID`、`webBase()`、`webEntryUrl(access)`（并入 `_internal`）；重写 `checkin()` 为双任务组合；`usage()` 追加网页窗口 |
| `packages/autoclaw-cn-auth/fake.mjs` | 新增 `inspirationDone`、`signinError`、`inspirationError` 状态与 `reset()`；`task-complete` 支持两个 task_id；`task-list` 返回两任务 |
| `packages/autoclaw-cn-auth/index.test.mjs` | 更新 `checkin`/`usage` 用例并补新用例（见 §4） |
| `packages/autoclaw-cn-auth/README.md` | 每日双任务、网页入口、`AUTOCLAW_WEB_BASE_URL`、安全提示 |
| `packages/autoclaw-cn-auth/package.json` | 版本 0.1.1 → 0.2.0 |

不做：邀请好友/升级客户端（真实行为，接口不可伪造）；网页 cookie 会话；多账号并行。

## 4. 测试用例（`bun test`，全部打 fake 上游、零外网）

1. 首次签到：`outcome=claimed`、`credit=400`、`taskCalls` 依次为 `daily_signin`、`daily_inspiration_center`。
2. 当日第二次：`outcome=done`，message 同时含"已签到"与"灵感中心"。
3. 签到成功 + 灵感中心失败（`inspirationError=400001`）：`outcome=claimed`、`credit=200`、message 含失败原因。
4. 两项均失败（非鉴权）：`outcome=failed`。
5. 鉴权失效（refreshToken 错误）：抛 `/失效/`。
6. `usage` 窗口顺序：`["赠送积分","通用积分","网页版快捷登录"]`；网页窗口 `aside=true`、`used` 为 `undefined`、`display` 以 `https://autoglm.zhipuai.cn/?autoglm_token=` 开头且包含当前 `access`（URL 编码后）。
7. 临期 token：`saved.expires = Date.now()+30_000` 时 `usage` 触发续期，网页窗口内是**续期后**的新 token。
8. 既有 33 个用例保持全绿（模型/转发/签名/续期/登录）。

## 5. 验收标准

- `cd packages/autoclaw-cn-auth && bun test` 全绿（≥ 40 个用例）。
- `grep` 确认测试与 fake 中无真实域名请求（测试仅 `127.0.0.1`）。
- 网页窗口字段严格符合 host.js 白名单（无自造字段）。
- 双任务失败互不阻断；鉴权失败整次抛 `expired`。
- README 与实现一致（任务名、环境变量、安全提示）。

## 6. 风险与观察点

- 灵感中心任务上游若要求"真实进入灵感中心"的客户端事件，`task-complete` 可能返回不可完成；实现已按"失败降级、不阻断签到"处理，上线后观察首日返回。
- 网页窗口长 URL 在 GUI 中可能被省略号截断；README 给出复制兜底与手工构造方式。若截断严重，后续再评估 CLI 小工具（不在本次范围）。
