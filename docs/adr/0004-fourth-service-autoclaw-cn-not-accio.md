# 第四家由 Accio 改为 AutoClaw 国内版

---

status: accepted
date: 2026-10-15
---

原计划第四家做 **Accio**（阿里，国际版 OAuth2+PKCE，Gemini 风格信封）。2026-10-15 用户指示"不用做 accio，改做 **AutoClaw 国内版**"，第四家改为 AutoClaw 国内版（智谱 autoglm，`autoglm-acceleration-api.zhipuai.cn`）。理由：Accio 的两个账号都是国际版、且 token 不走标准 Authorization 头、信封为 Gemini 风格 protobuf-JSON，移植与排障成本都高于国内直连的 AutoClaw；AutoClaw 国内版是手机验证码登录 + 标准 JWT 对 + 每日签到（task-complete）的简单形态，与已交付三家同构。

## Consequences

- 交付四个包为 `raccoon-auth` / `catpaw-auth` / `loomy-auth` / `autoclaw-cn-auth`；provider id `raccoon` / `catpaw` / `loomy` / `autoclaw`（`autoclaw` 沿用 agent2api 的 provider id，只做国内版；国际版是另一套站点与 OAuth 登录，不属本工作目录范围）。
- AutoClaw 的 name/refresh 与已交付的 raccoon 同档（可自动续期），因此 ADR-0002 的三级登录来源里，AutoClaw 属"从 agent2api 导入 + 可自动续期"一类。
- Accio 的侦察笔记（`docs/recon-agent2api-four-services.md` 的 Accio 段）保留为历史记录，标注为**不在交付范围**；AutoClaw 的协议提炼补在同一文档。
- 第四家的每日任务从"无签到"变为"有签到"：AutoClaw 有每日签到（`daily_signin`，+200 积分/次），经 `auth.checkin` 钩子交给 magpie 调度。
