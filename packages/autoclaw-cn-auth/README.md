# magpie-autoclaw-cn-auth

AutoClaw **国内版**（智谱 autoglm，`autoglm-acceleration-api.zhipuai.cn`）的 magpie provider 插件：手机验证码登录、模型清单、聊天转发、积分钱包、每日双任务签到（签到 + 灵感中心）与网页版快捷登录入口。

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
- **余额（usage）**：`GET /agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw`（v2 拿不到时降级 v1 `wallet-instances`）→ 各积分钱包窗口；末尾追加一个**网页版快捷登录**窗口，`display` 为 `{AUTOCLAW_WEB_BASE_URL}/?autoglm_token=<access>`（`aside: true`，不报 `used`，不参与账号可用性判断）。
- **每日双任务（checkin）**：同一个 token 依次 `POST /autoclaw-proxy/proxy/autoclaw-task-complete` 两个任务——先 `daily_signin`（每日签到，200/日），再 `daily_inspiration_center`（进入灵感中心，200/日，客户端触发、幂等）。`credit` 为两次实际 `reward_points` 之和，`message` 用「；」拼接两项结果（如「签到成功，获得 200 积分；灵感中心已领取 200 积分」「今天已签到；灵感中心今日已领」）。任一任务非鉴权失败不阻断另一个、失败原因透传上游 `msg`；`401`/业务码 `410000`/`SignedOut` 立即判为登录失效（`signIn: "expired"`），引导重登。上游返回 `code != 0` 一律按失败处理，不猜测、不重试。

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

## 环境变量（测试 / 镜像用，与 agent2api 同名）

| 变量 | 默认 |
|---|---|
| `AUTOCLAW_USERAPI_BASE_URL` | `https://autoglm-acceleration-api.zhipuai.cn`（账号/积分/签到/模型目录） |
| `AUTOCLAW_UPSTREAM_BASE_URL` | `https://autoglm-acceleration-api.zhipuai.cn/autoclaw-proxy/proxy/autoclaw`（聊天代理，含尾部 `/autoclaw`） |
| `AUTOCLAW_WEB_BASE_URL` | `https://autoglm.zhipuai.cn`（网页版快捷登录链接的站点） |
| `AGENT2API_DB` | `~/.agent2api/agent2api.db`（导入源，只读） |

## 网页版快捷登录（安全提示）

`usage` 的「网页版快捷登录」窗口展示的是免密链接 `{AUTOCLAW_WEB_BASE_URL}/?autoglm_token=<access>`：网页端 `checkToken()` 会读取该参数、Bearer 化后写入浏览器登录态。因此**该链接等同于实时登录凭证**：

- **勿外发**：截图、日志、工单、聊天记录里都不要带上完整链接；
- 链接随 `access` 过期而失效；`usage` 取的是 `fresh()` 续期后的 token，正常情况至少还有 5 分钟可用；
- GUI 若把长链接截成省略号，可从 `usage` 原文完整复制，或手工拼接：`https://autoglm.zhipuai.cn/?autoglm_token=` 后接 URL 编码后的 access token（`encodeURIComponent`）。

## 测试

```
cd packages/autoclaw-cn-auth && bun test
```

测试打到本地 fake 上游（`fake.mjs`），**不触网、不使用真实 token**：fake 会重新计算并校验 `X-Auth-Sign`、校验 `X-Authorization`/`X-Request-Model`/`body.model`、模拟 406 预校验与 `400002` 降级，以及两个每日任务各自的幂等两态与独立失败开关。

## 许可

MIT。请求逻辑移植自 aimod-cc/agent2api（MIT）。
