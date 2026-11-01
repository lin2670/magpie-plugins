# magpie-copilot-auth

GitHub Copilot 的 magpie provider 插件：GitHub 设备流登录、copilotToken 换取与托管刷新、模型清单（按账号权益动态探测）、聊天转发（`/responses` 与 `/chat/completions` 双端点分流）。

## 安装（本地自用）

```
magpie plugin add ./packages/copilot-auth
magpie plugin login copilot     # 选「GitHub 设备流登录」，浏览器打开 github.com/login/device 输码
```

Magpie 将该插件显示为 `copilot-plugin`（与内置 `copilot` ID 冲突时自动加后缀）；登录仍使用插件原始 ID `copilot`。

## 链路（2026-10-28 全链实测）

1. **登录**：GitHub 设备流（公开 client_id `Iv1.b507a08c87ecfe98`，与所有 Copilot 客户端相同）。浏览器输码授权后插件轮询拿到 GitHub user token，立即换出第一枚 Copilot api token。
2. **api token**：`copilot_internal/v2/token` 换取，**约 30 分钟有效**。三处续期：loader 每请求前检查（临期 5 分钟内重换）、magpie 的 `auth.refresh` 空闲续期、usage 查询顺带续。GitHub user token 本身不过期（设备流 token 撤销前一直有效），它是存在账号里的 `refresh` 字段。
3. **模型清单**：每次从上游 `/models` 动态探测（缓存 1 小时）并按账号权益过滤——模型有没有、叫什么，完全跟随账号，不做静态假表。过滤掉：`-free-auto` 诱饵（实测任何身份都 400）、completion/embedding 型、search/agent 内部型号。
4. **聊天**：模型打哪个端点由它 `/models` 条目的 `supported_endpoints` 决定（同样动态）：
   - `gpt-5.6-luna` / `gpt-6-luna` 等 GPT-5.x/6.x 系 **只支持 `/responses`**（走 `/chat/completions` 会 400 `unsupported_api_for_model`）——magpie 侧声明为 Responses wire（`@ai-sdk/openai`），原生直通；
   - `kimi-k3` / `gpt-4o` 等 **只支持 `/chat/completions`**——fetch 内将 Responses 输入、指令、工具历史及常用参数改写为 Chat 格式，回程再将文本/工具调用转回 Responses 格式（含 SSE）。URL 形式的 `input_image` 会按原顺序转换为 Chat 的 `image_url`；文本与图片混排使用数组，纯文本仍保持字符串。

## 身份（为什么是 visualstudio-chat）

Copilot 网关按 `Copilot-Integration-Id` 决定模型目录授权。实测（免费档 `free_limited_copilot`，2026-10）：

| 身份 | 目录表现 |
|---|---|
| `copilot-developer-cli`（OmniRoute 默认） | 只有 `gpt-4o` 可用，其余全 400 |
| `vscode-chat`（VS Code） | 5.6 系可用，缺 6.x 型号 |
| `visualstudio-chat`（**本插件采用**，Visual Studio 真实身份） | 目录最宽（46 个，含 6.x 与 codex） |

报错 `400 model_not_supported` 九成是身份/权益问题而非模型不存在——先换身份再排查。

## 已知边界

- **模型权益随账号而异**（2026-10-28 双账号实测确认）：同一身份下，A 账号可调
  `kimi-k3`/`gemini-3.8`，B 账号同模型 400 `model_not_supported`；`gpt-4o` 系则两号都可用。
  调用失败以 magpie 的 failover 处理即可。
- **端点判定以目录为准，缺字段视为 chat**：`supported_endpoints` 里**写明** `/responses`
  的才直通 Responses（luna/sol 系）；老 chat 模型（gpt-4o 系）的目录条目**没有该字段**，
  一律转 `/chat/completions`。目录抓取失败时该账号使用最近一次成功目录；尚无缓存时只展示两账号共有的 gpt-4o 系列，直接请求则默认透传 `/responses`。
- **usage（额度与重置时间）**：一次 `copilot_internal/v2/token` 调用同时带回登录态与额度——
  免费档响应里 `limited_user_quotas`（`{chat: 199, completions: 2000}`，**剩余量**：
  2026-10-28 消费实测 200→199 确认语义）。展示为两个窗口（`Chat 额度` / `补全额度`），
  各带 `resetsAt` 重置时间（ISO）。
  **重置日是每月 1 日 00:00 UTC（北京时间 08:00）**，由插件计算；响应里的
  `limited_user_reset_date` **不是**额度重置日（2026-11-01 实测：全部账号当天重置归满，
  该字段仍显示 11-19/11-25/11-27 等按账号各异的日期），插件已弃用之。
  付费档无额度字段，卡片只显示套餐名。多账号各自独立计数（同插件实测 6 账号
  6 份独立的 200 chat/月额度）。
- **图片输入**：chat-only 模型支持 URL 形式的 `input_image`（裸 URL 或 `{url}`），插件会转换为 Chat 的 `image_url`；`file_id` 引用需要 Copilot 网关 Files API，无法解析时返回 400，请改传 URL。原生 `/responses` 模型的图片请求保持直通。
- **Claude 系**：Copilot 对 Claude 走 `/v1/messages` 专用 shim，本插件未实现（v1 只覆盖 Responses/Chat 双协议）；需要 Claude 时在 OmniRoute 侧使用。
- **TLS 拦截环境**：本机 Bun 曾遇到 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`（安全软件 TLS
  拦截）；仅在可信本机的临时诊断命令中按需设置 `NODE_TLS_REJECT_UNAUTHORIZED=0`，
  不要将其作为常驻环境变量或用于生产运行。
- **magpie 的模型列表来源是 config() 的静态表**：magpie 自家 SDK 的 `GET /models`
  不带 Copilot 身份头，网关答 400，所以动态探测（provider.models 钩子）只能作精修；
  兜底是 `KNOWN_MODELS` 静态表（37 项）。

## 环境变量

| 变量 | 默认 | 用途 |
|---|---|---|
| `COPILOT_API_BASE` | `https://api.githubcopilot.com` | 模型网关地址（测试用） |
| `COPILOT_GITHUB_API_BASE` | `https://api.github.com` | GitHub API 地址（本地 fake 测试用） |
| `COPILOT_CLIENT_ID` | `Iv1.b507a08c87ecfe98` | 设备流 client id |
| `COPILOT_INTEGRATION_ID` | `visualstudio-chat` | 客户端身份 |

## 测试

```
cd packages/copilot-auth && bun run test
```

测试经 `nonet.mjs` 拦截非 loopback 网络请求，并连接本地 fake 上游（`fake.mjs`）。覆盖 token 交换、目录筛选、双端点协议改写、图片桥接、工具调用与流式完成；设备流协议格式另有测试，但 OAuth 插件钩子与真实 GitHub 登录仍需端到端验收。

## 许可

MIT。
