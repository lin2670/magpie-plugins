# magpie-loomy-auth

Loomy（讯飞，`loomyad.xunfei.cn`）的 magpie provider 插件：登录、模型清单、聊天转发、双积分钱包与每日赠送积分刷新（签到）。

请求形态移植自 [aimod-cc/agent2api](https://github.com/aimod-cc/agent2api)（MIT）的 `providers/loomy`，按 magpie 插件 API 重写。

## 安装（本地自用）

```
magpie plugin add ./packages/loomy-auth
magpie plugin login loomy     # 选「从 agent2api 导入」/「短信验证码登录」/「手动粘贴 session」
```

## 能力

- **登录**：`从 agent2api 导入`（只读本机 `~/.agent2api/agent2api.db`）或 `短信验证码登录`（发码 → 输入 6 位码完成，session **14 天**）或 `手动粘贴 session`。
- **无续期接口**：session 过期（业务码 `020002`/`100002`）需重新登录（短信或再导入）。
- **聊天**：`POST {积分基址}/api/v1/chat/completions`，OpenAI 兼容，`token` + `Authorization: Bearer` 双头，SSE 直通。
  - 思考档折叠：通用档位折成 `reasoning_effort: low|medium|high`（minimal/low→low，high/max→high，none 不注入）。
  - 图片适配：**deepseek 系模型**只认 `<image_base64>` 标记——data URI 图片块自动转标记并并入前一个文本块；http(s) URL 保持原样。其余模型保持 OpenAI `image_url`。
- **模型**：`GET /api/v1/models`（OpenAI 形态；能力位读 `capabilities`；展示名尾部倍率 `(x3.0)` 拆为 rate 字段；无静态兜底——Loomy 官方网关没有内置清单）。
- **余额（usage）**：`GET /api/v2/points/records?...` → 永久积分 + 每日赠送积分两个窗口。
- **每日签到（checkin）**：`POST /api/v1/points/first-login`（body `{}`）——服务端按"当天是否第一次"把每日赠送刷回 5000；按天幂等，重复调=成功（`claimed`，附当前每日余额）。
- **新手任务（一次性，随首次签到自动补领）**：`GET /api/v1/onboarding/tasks` 查完成表 → 对未完成 key 逐个 `POST /api/v1/onboarding/tasks/complete`（body `{key}`）。上游只认客户端 task-registry 的 8 个 key（合计 10000 积分，未知 key 报业务错）；上报无行为证明，实测直接到账真积分，`alreadyCompleted=true` 幂等。结算结果写进账号记录（`onboardingSettled`），之后每次签到零请求跳过；单个 key 失败不阻断其余，下轮签到重扫（agent2api `providers/loomy/onboarding.rs` 同语义）。

## 账号域签名说明

登录链路（`account.xfinfr.com`）的每个请求带 HMAC-SHA1 签名（9 段待签串：METHOD/ESCAPED_PATH/QUERY/CONTENT_MD5/CONTENT_TYPE/DATE/NONCE/SIGNED_HEADERS/CANONICALIZED_HEADERS），AK/SK 为客户端安装包内置常量（非用户凭证）。这是客户端指纹复刻，不是密码学边界。

## 环境变量（测试 / 镜像用，与 agent2api 同名）

| 变量 | 默认 |
|---|---|
| `LOOMY_POINTS_BASE_URL` | `https://loomyad.xunfei.cn`（积分/签到/模型网关） |
| `LOOMY_XFYUN_BASE_URL` | `https://account.xfinfr.com`（账号/短信登录） |
| `LOOMY_XFYUN_ACCESS_KEY_ID` / `_SECRET` | 客户端内置对（见上） |
| `LOOMY_XFYUN_APP_ID` | `GM3LOOMY` |
| `AGENT2API_DB` | `~/.agent2api/agent2api.db`（导入源，只读） |

## 测试

```
cd packages/loomy-auth && bun test
```

测试打到本地 fake 上游（`fake.mjs`：账号域会**重新计算并校验 HMAC 签名**），不触网、不使用真实 token。

## 许可

MIT。请求逻辑移植自 aimod-cc/agent2api（MIT）。
