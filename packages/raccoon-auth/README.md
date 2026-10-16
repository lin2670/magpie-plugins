# magpie-raccoon-auth

小浣熊（Raccoon，商汤 xiaohuanxiong.com）的 magpie provider 插件：登录、模型清单、聊天转发、积分余额与每日积分（桌面登录积分）签到。

请求形态移植自 [aimod-cc/agent2api](https://github.com/aimod-cc/agent2api)（MIT）的 `providers/raccoon`，按 magpie 插件 API 重写。

## 安装（本地自用）

```
magpie plugin add ./packages/raccoon-auth
magpie plugin login raccoon     # 选「网页登录」/「从 agent2api 导入」/「手动粘贴 token」
```

## 能力

- **登录**：`网页登录`（无需 agent2api：打开小浣熊官方授权页登录，把浏览器跳转的 `office-raccoon://auth/callback?code=…&state=…` 整条粘回来，state 逐字校验后经 `login_with_authorization_code` 换 token 对；授权码一次性，200035=已失效需重发起）、`从 agent2api 导入`（读本机 `~/.agent2api/agent2api.db`，只读不写回；多账号时列表选择）或 `手动粘贴 token`。
- **续期**：accessToken 临期 5 分钟自动刷新（`POST /api/web/auth/v1/refresh`；响应 `refresh_token` 为空时沿用旧值）。请求中途 401 也会强制续期一次并重试。
- **聊天**：`POST {llmBase}/chat/completions`，OpenAI 兼容 body 原样透传，SSE 流式；上游回帧中的 `model` 名回写为请求名。
- **模型**：`GET {llmBase}/model_catalog`（失败回落静态清单 5 个；重复名首个生效）。
- **余额（usage）**：`GET /api/web/points/v1/balance` + `entitlement_info`。
- **每日签到（checkin）**：`GET /api/web/office/v3/setting_info`（带桌面端身份头，按天幂等触发发放）→ `GET /api/web/points/v1/bills` 核对今日（北京时间）入账，入账即 `claimed`。

## 与 agent2api 并存的注意

小浣熊的 refresh token 可能在每次刷新时轮换。同一账号同时由本插件与 agent2api 刷新，会互相作废对方保存的 token——**导入后建议在 agent2api 面板里停用小浣熊账号**，待本插件验证稳定后再退役 agent2api。

## 环境变量（测试 / 镜像用，与 agent2api 同名）

| 变量 | 默认 |
|---|---|
| `RACCOON_LLM_BASE_URL` | `https://xiaohuanxiong.com/api/web/llm/v2` |
| `RACCOON_MAIN_SITE_URL` | `https://xiaohuanxiong.com` |
| `RACCOON_AUTH_API_BASE` | `{MAIN}/api/web/auth/v1` |
| `AGENT2API_DB` | `~/.agent2api/agent2api.db`（导入源，只读） |

## 测试

```
cd packages/raccoon-auth && bun test
```

测试打到本地 fake 上游（`fake.mjs`），不触网、不使用真实 token。

## 许可

MIT。请求逻辑移植自 aimod-cc/agent2api（MIT）。
