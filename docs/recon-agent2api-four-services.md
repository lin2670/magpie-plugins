# agent2api 四服务提炼（侦察笔记）

来源：`aimod-cc/agent2api`（克隆于 `D:\Desktop\AI\Agent\.scratch\recon\agent2api`；**MIT**，移植代码片段须保留版权声明）。仓库结构：Rust 网关 `desktop-tauri/src-tauri/server/`（axum）+ TS 面板。侦察日期 2026-10-14。以下路径为 agent2api 仓库相对路径。

## 通盘结论

- 四家（小浣熊 / CatPaw / Loomy / AutoClaw 国内版）全是**纯 HTTP**（无浏览器自动化）；"浏览器"只出现在登录环节。
- 签到**调度**不用搬（magpie 托管调度）；只需搬"怎么签"——各家的请求序列与成功判据。
- 登录来源：CatPaw 桌面端 `auth.json` 实时读；其余三家从 agent2api 导入（小浣熊 / AutoClaw 可自动续期；Loomy 无续期）。
- 域名 / 密钥 / 版本号均为可覆盖常量；全部集中在各 provider 目录，便于插件内配置化。

## 小浣熊（Raccoon，商汤）——首发，移植最易

- 上游：`POST https://xiaohuanxiong.com/api/web/llm/v2/chat/completions`，`Authorization: Bearer <JWT>`，OpenAI body 原样透传（仅 SSE 回帧改写 model 名）；SSE 流式。
- 刷新：`POST /api/web/auth/v1/refresh`（body `refresh_token`；401 后强刷一次重试；429 走冷却）。
- 签到（两步，判据=**今日确入账**、北京时间）：
  1. `GET /api/web/office/v3/setting_info` —— 发放触发器（服务端按天幂等）；头 `X-Client-Platform: desktop-windows`、`X-Client-Version: v1.0.0`、`X-Raccoon-Language: zh`。
  2. `GET /api/web/points/v1/bills?paging.limit=20&paging.offset=0` —— 账单核对今日入账。
- 一次性新手奖励（你账号已领过；二期可选）：desktop / mobile 各 3000。
- 模型目录：`GET {llmBase}/model_catalog`（10 分钟 TTL；静态兜底 5 个）。
- 参考文件：`providers/raccoon/`（`balance.rs` 签到、`oauth.rs`、`credentials.rs`）。
- 桌面端配置（若以后装官方客户端）：`~/.box-agent/config/auth.json`。

## CatPaw（美团妙手）——最难，有状态会话机；无签到

- 上游：`https://ai.catpaw.meituan.com`；agent 协议状态机 `round → event(running) → turn(SSE) → (工具循环) → event(completed)`；路径 `/api/agent/conversation/{round,event,turn,turn/stop}`；turn SSE 总超时 15 分钟。
- 鉴权：`Cookie: X-Passport-Token=…` + `user-uid` 头；来源：账号记录 → `~/.meituan-catpaw/auth.json`（实时读）→ env。**无刷新**，过期靠桌面端重登。
- 关键头：`M-APPKEY`、`gray-set: new-agent-sdk`、`enableHeartBeat: true`、`X-Agent-Version`、`M-TRACEID`（值见仓库常量）。
- 体关键字段：`source=CatX`、`mode=CATX_APP`、`toolVersion`、`modelType`、`requestContext.modelParams.declarativeParams.{effort,context}`（档位 low/high/max）、`toolConfigs`。
- SSE 处理：累积值→差分→OpenAI chunk；usage 修正 `prompt_tokens = total − completion`；图片 >60KB 压缩。
- 会话复用（agent2api 增强）：内存 `x-session-id→conversationId` 注册表 + 消息指纹链增量提交；工具续接只 turn 不 round。
- **v1 建议**：先移植已验证的简化形态（`D:\Desktop\AI\服务器\_miaoshou_test\catpaw-proxy.mjs`）；会话复用 / 工具续接为二期。
- 参考文件：`providers/catpaw/`（17 文件 ≈6.9k 行）。

## Accio（阿里）——**不在交付范围**（原定第四家，2026-10-15 改为 AutoClaw 国内版，见 ADR-0004）

以下为历史侦察记录，仅供以后需要时参考。

- 两地区 = 两个 provider id（国际 `www.accio.com` / 国内 `www.accio-ai.com`）；你现有两个号都是国际版。
- 登录：OAuth2 授权码 + PKCE(S256)，`client_id=accio-work`；换码 `POST https://phoenix-gw.alibaba.com/api/oauth/token`；续期 `POST /api/auth/refresh_token`。
- ⚠️ token **不走 Authorization 头**：GET 拼 query、POST 放 body；推理放 body 的 `token` 字段。
- 推理：`POST https://phoenix-gw.alibaba.com/api/adk/llm/generateContent?...`，**Gemini 风格 protobuf-JSON** SSE；必带头 `appKey`、`x-package-region: GLOBAL|CN`、`x-app-version`、`utdid`（每账号稳定设备 id）。
- 协议要点：`tool_config` 为 JSON 字符串；`function_call.args_json` / `function_response.response_json` 字符串；`system_instruction` 字符串；思考档走 `properties.reasoning_effort`；图片 `inline_data` / `file_data`。
- 错误藏 200 帧（`error_code`）→ 首帧预读（未下发字节前可换号）+ 流内错误冷却。
- 风控态度：不带 `bx-ua` / `x-cna`（刻意，SDK 不可复现）；`utdid` 按账号生成。
- 参考文件：`providers/accio/`（12 文件 ≈3.6k 行）。

## AutoClaw 国内版（智谱 autoglm）——标准 JWT 对 + 手机验证码 + 每日签到（交付的第四家）

- 站点：userapi（账号/积分/签到/模型目录）`https://autoglm-acceleration-api.zhipuai.cn`；聊天代理 `…/autoclaw-proxy/proxy/autoclaw`（**含尾部 `/autoclaw`**）；模型目录在同 host 的 `/proxy/` 一级（`…/autoclaw-proxy/proxy/autoclaw-model-config`，顶层 `{models:[…]}`、无 code/data 信封）。
- 账号域请求头（**唯一一份签名实现**）：`X-Auth-Appid: 100003` + `X-Auth-TimeStamp`（**秒**）+ `X-Auth-Sign = md5("{appId}&{ts}&{appKey}")`（appKey `38d2391985e2369a5fb8227d8e6cd5e5`，客户端内置常量）；外加品牌头 `X-Product/X-Client-Type/X-Harness-Type/X-Tm/X-Lang/X-Channel` 与 `X-Version: 1.18.5`（**目录按它做版本门控**，值旧会少发模型），以及 `authorization: Bearer <token>`。
- 登录（国内版唯一方式）：`POST /userapi/v1/agent-send-code`（body `{phone, source_id:"autoclaw", device_id}`，device_id 必填）→ `POST /userapi/v1/agent-login/`（body `{phone, code, platform:"web", source_id, device_id}`；**code 必须是 JSON 数字**，字符串会得 `400001 参数错误`）→ 直返 token 对。
- 续期：`POST /userapi/v1/refresh`（body `{refresh_token, source_id, device_id?}`）；签名校验失败（`400002`）降级 `POST /userapi/v1/agent-refresh`。登录态失效业务码 `410000` / `400000`。
- 聊天：`POST {代理}/chat/completions`，认证头是 **`X-Authorization`（不是 Authorization）**；两个模型标识必须都发对 —— `X-Request-Model` = **完整路由 ID**（`zai_*` 走按量、`zaicoding_*` 走 Coding Plan、`zai_auto` 服务端自选），`body.model` = **剥前缀**后的 ID。SSE 帧与非流式响应体的 `model` 回写为客户端请求名。
- 上游 2026-09-22 起的三道闸（**都在 LLM 代理这条路上**，账号域不受影响）：
  1. `X-Harness-Type: zcode` 被区别对待 → 403 pay-view / 406；该路**不发**此头。
  2. system 提示必须**以 `You are a personal assistant running inside OpenClaw.` 开头且带 `## Tooling` 段**，且 system/developer 里不得含外来 harness 身份句（ZCode / Claude Code / Codex / DeepSeek Harness，逐字、大小写不敏感）→ 出站前规范化。
  3. `max_tokens` 小正整数（30~8192）被预校验拒成 **406 空体** → 归一到 10000（缺省不注入，≥10000 放行）。
- 签到：`POST /autoclaw-proxy/proxy/autoclaw-task-complete`，body `{"task_id":"daily_signin"}`（**通用任务接口**，非签到专用）→ `{already_completed, reward_points, success}`；判"本次领到"看 `reward_points > 0`（或 success 且非 already_completed），重复调用返回 `already_completed:true` → `done`「今天已签到」。任务列表 `GET …/autoclaw-task-list` 可作失败归因。
- 余额：`GET /agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw`（v2 不可用时降级 v1 `wallet-instances`）；订阅 `POST /agentpay/v1/assistant/subscribe-info`（国际版路径不同）；即将过期 `GET /agent-assetmgr/api/v1/points/expiring`。
- 静态兜底模型：`glm-5.3`（路由 `zaicoding_glm-5.3`）、`glm-5.3-flash`（路由 `zai_glm-5.3-flash`）；远程目录实测多出 `zai_auto` / `zai_auto-fast`。
- 参考文件：`providers/autoclaw/`（16 文件 ≈6.3k 行；`region.rs` 地区、`refresh.rs` 签名、`balance.rs` 积分、`checkin.rs` 签到、`catalog.rs` 目录、`adapter.rs` 转发、`prompt.rs` system 规范化）。

## Loomy（讯飞）——HMAC 签名复刻；签到=每日首登赠送

- 登录：手机验证码两步 `POST https://account.xfinfr.com/login/phone/{sendMsgCode,checkCode}`（session **14 天**）；两请求带 HMAC-SHA1 签名头（9 段待签串，AK/SK 为客户端内置常量，见 `endpoints.rs`）；**无续期**。
- 推理：`POST https://loomyad.xunfei.cn/api/v1/chat/completions`，双鉴权头 `token:` + `Authorization: Bearer`；body 基本透传，两处适配（参照实现 `reasoning_patch` / `images.rs`）：思考档折进 low/medium/high（超档删除）、DeepSeek 系模型的 data-URI 图片转 `<image_base64>` 标记；SSE。
- 签到：`POST {loomyad}/api/v1/points/first-login`（body `{}`，头 `token`）——服务端按"当天首登"把每日赠送刷回 5000；按天幂等，重复调=成功。
- 余额（两份账）：`GET /api/v2/points/records?...` → `data.balance`（永久）+ `data.dailyBalance`（每日赠送）。
- 一次性新手任务（你号上已完成）：8 个 key（合计 10000），幂等；只挂手动补领，不进定时。
- 参考文件：`providers/loomy/`（12 文件 ≈2.1k 行）+ 根目录 `points-service.js`（Electron 参考件）。

## 签到调度语义（参照，不复刻）

- agent2api：30s tick、北京时间、当天去重、启动补签、串行执行、多条目 schedules。
- magpie 侧：由其 checkin 托管（北京日、30 分钟循环、失败重试）——插件实现的 `auth.checkin` 只需：发请求 → 按各家判据映射 `claimed / done / inactive / captcha / failed`。

## 移植红线（既有决策的落地）

- 只用官方客户端已带的行为与凭据；不引入 agent2api 未带的新伪装；遇验证码走 `captcha` 通道（magpie 铁律）。
- 上游常量易变，全部集中配置，不散落。
