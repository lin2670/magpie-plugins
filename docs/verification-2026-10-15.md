# 四家插件验收记录（2026-10-15）

环境：magpie `0.1.1233`（网关 `127.0.0.1:3425`），Windows；四家插件均在 `packages/` 下以本地路径安装（`magpie plugin add <路径>`）。

## 一、离线测试（`bun test`，全部打本地 fake 上游，不触网、不用真实 token）

| 包 | provider id | 用例 | 结果 |
|---|---|---|---|
| `raccoon-auth` | `raccoon` | 18 | 18 pass / 0 fail |
| `catpaw-auth` | `catpaw` | 15 | 15 pass / 0 fail |
| `loomy-auth` | `loomy` | 17 | 17 pass / 0 fail |
| `autoclaw-cn-auth` | `autoclaw` | 31 | 31 pass / 0 fail |

## 二、真机验收（真实账号 + 真实上游）

### 登录与模型清单（`magpie plugin list`）

| 插件 | 账号 | 模型数（目录来源） |
|---|---|---|
| 小浣熊 Raccoon | RaccoonNatalie | 10（远程 `model_catalog`） |
| 妙手 CatPaw | Dstny | 9（静态表） |
| Loomy（讯飞） | 185****9906 | 13（远程 `/api/v1/models`） |
| AutoClaw 国内版 | 185****9906 | 4（远程 `autoclaw-model-config`：`glm-5.3` / `glm-5.3-flash` / `auto` / `auto-fast`） |

网关侧 `GET /v1/models` 四家模型均可列出（重启常驻 Bun 宿主后生效）。

### 真实对话（经网关 `POST /v1/chat/completions`）

| 插件 | 模型 | 结果 |
|---|---|---|
| 小浣熊 | — | 非流式 / 流式通过（M1 验收） |
| CatPaw | — | 非流式 / 流式通过（M2 验收） |
| Loomy | `glm-5.3-flash` | 中文 `'收到'` 正常（M3；曾因上游按 GBK 解 body 出现乱码，加 `Content-Type: application/json;charset=utf-8` 修复） |
| AutoClaw 国内版 | `glm-5.3-flash` | 非流式：`content='收到'`，模型推理里读到的用户原文为**干净中文**；流式：91 个数据帧的 `model` 均为请求名 `glm-5.3-flash`，以 `data: [DONE]` 收尾 |

> AutoClaw 首次 curl 时曾看到模型把用户消息读成乱码（GBK 形态），经**同请求直连上游**对照（带/不带 charset 两种 Content-Type 都给上游干净中文）定位为 **Git Bash 传中文 argv 的编码问题**，非插件缺陷：改用 `--data-binary @-`（heredoc）后即干净。故 AutoClaw 不需 charset 处理（与源实现一致）。

### 每日任务（`magpie accounts checkin`）

| 插件 | 当日结果 |
|---|---|
| 小浣熊 | `claimed`，`今日积分 +300` |
| Loomy | `claimed`，`每日赠送积分已刷新（当前 4891）` |
| AutoClaw 国内版 | `done`，`今天已签到` |

AutoClaw 的判据与真实上游逐字核对（直连上游确认）：

- `POST …/autoclaw-task-complete` body `{"task_id":"daily_signin"}` → `200 {"data":{"already_completed":true,"reward_points":0,"success":false,"task_id":"daily_signin"}}`（该账号今日确已签到，任务列表显示「已签到 2 天」，奖励 200 积分/次）→ 插件正确判为 `done` 而非 `claimed`。
- `claimed` 分支（`reward_points > 0`）由离线用例覆盖。

### 余额（usage）

AutoClaw 经真实上游：`GET /agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw` → 总 29831 积分；只展示 `display: true` 的钱包（`奖励积分 29831`），其余四个（每日/订阅/加油包/其他，均 0 且 `display` 假）按源实现口径过滤。

## 三、签到调度开关

四家的 `settings.json → pluginCheckins` 均为 `true`（magpie 对带 `auth.checkin` 钩子的插件默认接上），由 magpie 按北京日、逐账号自动执行。

## 四、修复记录：CatPaw 账号显示「已退出登录」（2026-10-15）

**现象**：magpie UI 里 catpaw 账号卡片显示「已退出登录」（`logins.json` 里 `lapsed: "Dstny's 妙手 CatPaw sign-in has expired — sign in again"`），但同一 token 的聊天链路 200 正常。

**定性**：**插件逻辑 bug**（不是 UI 问题、也不是凭据失效）。聊天正常而卡片说未登录，说明是 usage 链路误报了 401。

**根因**：`usage` 钩子查余额时把聊天网关的鉴权头照搬到了余额接口 —— 对 `catx.nocode.cn/api/gateway/credit/balance` 发 `Cookie: X-Passport-Token`，而该接口**只认 `X-Auth-Token`**（agent2api `catpaw/balance.rs` 实测结论），于是稳定返回 `401 {code:4010,"Authentication token is required"}`。magpie 把 usage 的 401 当作登录态失效并写入 `logins.json` 的 `lapsed`（`plugin_accounts.go` 的 `notePluginLapse`），UI 据此显示「已退出登录」。

**修复**（`packages/catpaw-auth/index.mjs`）：
1. 余额请求改发 `X-Auth-Token: <accessToken>`（附 `gray-set: new-agent-sdk`），按 `availableCredits` / `userPlan` 解析，401 与 body 的 `4010`/`4011` 判失效；
2. 读成功时**不再返回 `signIn: "kept"`** —— 该值让 magpie 保留既有标记；省略 `signIn` + 无错误才走「清除标记」路径（`plugin_usage.go`）。否则一次瞬时 401 会让账号**永久**显示未登录（CatPaw 无续期接口，无法靠 renewal 自愈）。
3. 余额 URL 改可覆盖（`CATPAW_BALANCE_URL`），fake 增加该接口并要求 `X-Auth-Token`，新增 3 条用例（含「发错头会 401」的回归）。

**同类修一处**：`packages/loomy-auth/index.mjs` 的 usage 同样在干净读时返回 `signIn: "kept"`，而 Loomy 与 CatPaw 一样**没有续期接口**，同样的瞬时 401 会留下永不消除的标记 —— 一并改为省略 `signIn`。raccoon / autoclaw 有 `auth.refresh`，magpie 会在续期成功时报 `renewed` 从而清标记，暂不动。

**验证**：`magpie accounts` 显示 `● catpaw Dstny · 体验版 可用积分 0% (1133.94 credit)`（无 expired 后缀）；`logins.json` 中 lapsed 标记消失且未被重新写回；聊天 200 正常；四包测试 18/15/17/31 全绿。

## 五、修复记录：Pi 调 AutoClaw 全量 406（2026-10-15，下午）

**现象**：Pi（earendil-works）经 magpie 调 `autoclaw/glm-5.3-flash` 10 次全 406 空体（usage.jsonl：`pi` 9×406 + 1×499；`zcode` 16×200、`dsh` 3×200、curl 直连 5×200 同账号同时段）。Pi 报 `406: {"message":"AutoClaw 国内版: AutoClaw 上游返回 406: 无错误说明"}`，约 1 秒即拒。

**根因**：上游 system 身份句指纹拦截。Pi 的开场白 `You are an expert coding assistant operating inside pi, a coding agent harness. …`（定义在 pi-coding-agent，不在 AGENTS.md）是 FOREIGN_IDENTITIES 表外的新指纹。dsh / zcode 因各自身份句早已收录而正常。网关回放二分定位：最小命中单元为整句 `You are an expert coding assistant operating inside pi`（含 "You are" 前缀才命中；"An expert…" 变体与单片段均不命中）。Pi 请求形状特征（developer 角色、store:false、reasoning_effort=xhigh、max_completion_tokens）单独回放均 200，已排除。

**修复**（`packages/autoclaw-cn-auth/index.mjs`）：FOREIGN_IDENTITIES 收录两条改写规则（完整同位语句式 + 短句变体），`bun test` 新增 2 条用例；杀 magpie-bun.exe 重建网关后回放 Pi 原始 preamble 406→200。

## 六、代码审查修复批次（2026-10-15，晚）

两轴审查（Standards / Spec）后的修复：ADR-0002 追加 SMS 登录修订（Loomy/AutoClaw 重实现验证码登录转正）；autoclaw checkin 改走 `fresh()`（临期自动续期）+ checkin 失败查 task-list 归因；loomy checkin 不再把刷新后余额当 credit（参照实现语义）+ 死代码清理；raccoon 刷新 429 十分钟冷却 + 模型目录 10 分钟 TTL 缓存；catpaw turn SSE 补 15 分钟总超时（参照 `SSE_TIMEOUT_MS`，README 旧口径 120s 废弃）+ 死代码清理；三包逐字重复的 `agent2apiAccounts` 曾抽到 `packages/shared/`，因 npm 发布只认各包 files 白名单、父目录外文件进不了 tarball，发布准备时已内联回三包（raccoon/loomy/autoclaw 各自携带同一段函数，catpaw 无 agent2api 导入不涉及）；autoclaw README 身份句清单补 pi。autoclaw 的 `max_tokens` 归一窗口经核对与参照实现逐字一致（"<10000 正整数全归一"），不改。

修复后测试：raccoon 18 / catpaw 15 / loomy 17 / autoclaw 33 全绿（autoclaw 比验收时 +2，即 pi 两条用例）。

## 五、待办 / 注意

- 小浣熊的 refresh token 可能轮换：导入后建议在 agent2api 停用小浣熊账号，避免两边互踢（见 `packages/raccoon-auth/README.md`）。
- AutoClaw 的 refresh token 服务端会轮换；与 agent2api 并存时同理（本包只读导入，不回写 agent2api）。
- 插件代码改动后需重启常驻 Bun 宿主（`taskkill //IM magpie-bun.exe //F`，网关会自动重建），否则网关仍跑旧代码。
