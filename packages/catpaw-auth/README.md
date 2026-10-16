# magpie-catpaw-auth

妙手（CatPaw，美团 `ai.catpaw.meituan.com`）的 magpie provider 插件：登录、模型清单、聊天转发、余额查询。

v1 为**简化链路**（`round → event(running) → turn(SSE)`，无跨请求会话复用），移植自 2026-10-09 端到端验证过的 `catpaw-proxy.mjs`。会话复用与工具续接为二期（见仓库 ADR-0003）。

## 安装（本地自用）

```
magpie plugin add ./packages/catpaw-auth
magpie plugin login catpaw     # 选「网页登录」/「妙手桌面端登录态」/「手动粘贴 token」
```

## 能力

- **登录**：`网页登录`（无需妙手桌面端、无需 agent2api：插件问 `login-config` 取官方登录页，浏览器完成登录后插件按官方客户端同款 **poll-token 兜底通道**每秒轮询 `?sid` 直接拿 token——服务端对服务端，无监听端口、不受浏览器 PNA 拦截；再问一次 `current-user` 补 uid/昵称，失败不影响登录）、`妙手桌面端登录态`（每次请求前实时读 `~/.meituan-catpaw/auth.json`，mtime 缓存 5 分钟内；重开妙手即自动刷新）或 `手动粘贴 token`。
- **无续期接口**：token 过期后 401，网页登录的重新发起一次即可；桌面端登录态则在妙手里重新登录（下一请求自动读新 token）。
- **聊天**：`round → event → turn` 三步会话机；上游 SSE 帧为累积式，插件做差分转 OpenAI delta（`content` + `reasoning_content`），流式与非流式都支持。
- **模型**：妙手桌面端的 9 个模型（longcat-2.0 / glm-5.3 系列 / deepseek-v4 系列 / minimax-m3 / kimi-k3 / auto），静态表（无远程目录接口）。
- **余额（usage）**：`GET https://catx.nocode.cn/api/gateway/credit/balance`，鉴权头是 **`X-Auth-Token: <auth.json 的 accessToken>`**。
  - ⚠️ 这个接口与聊天网关**不是同一个鉴权头**：它只认 `X-Auth-Token`，把聊天用的 `Cookie: X-Passport-Token` 发到这里会稳定 401（body `code 4010 "Authentication token is required"`）。发错头的后果不只是余额查不到 —— magpie 把 usage 的 401 当作「登录态失效」，账号卡片会显示「已退出登录」，直到手动重新登录。响应形态 `{code, message, data:{availableCredits, userPlan}}`。
  - 读成功后**不带 `signIn` 字段**：magpie 以此把「已退出登录」的标记撤掉（带 `kept` 会保留标记，一次瞬时 401 就会永久显示未登录）。
- **无签到**：CatPaw 没有每日签到活动（agent2api 与逆向均确认）。

## 协议细节（来自 catpaw-proxy.mjs 实测）

- 必须头：`m-appkey: com.sankuai.mcopilot.cli`、`source: CatX`（请求体内）、`x-agent-version: 1.2.0-beta.6`、`Cookie: X-Passport-Token=...`
- **注意**：上表是**聊天网关**（`ai.catpaw.meituan.com`）的头；**余额接口**（`catx.nocode.cn`）改用 `X-Auth-Token`（见上）。
- turn SSE 总超时：15 分钟（参照实现 `SSE_TIMEOUT_MS`，插件同值——带工具循环的长回答全程在推流，更短会把长回答掐断；README 旧版写 120s 是 catpaw-proxy.mjs 早期实测口径，已废弃）
- `mode=CATX_APP` 时全部 9 个模型可用；`mode=CLI` 只有小部分

## 环境变量

| 变量 | 默认 |
|---|---|
| `CATPAW_AUTH_PATH` | `~/.meituan-catpaw/auth.json`（妙手桌面端登录态） |
| `CATPAW_BALANCE_URL` | `https://catx.nocode.cn/api/gateway/credit/balance`（余额接口，测试用） |
| `CATPAW_PASSPORT_BASE` | `https://catx.nocode.cn`（网页登录的 passport 域，测试用） |

## 测试

```
cd packages/catpaw-auth && bun test
```

测试打到本地 fake 上游（`fake.mjs`），不触网、不使用真实 token。

## 许可

MIT。协议实现移植自 catpaw-proxy.mjs（安安 2026-10-09 实测验证）。
