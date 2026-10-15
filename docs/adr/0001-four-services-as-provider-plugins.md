# 四家服务反代以 magpie provider 插件交付，4 个独立包

---
status: accepted
date: 2026-10-14
---

> 注：第四家由 Accio 改为 **AutoClaw 国内版**（2026-10-15），见 [ADR-0004](0004-fourth-service-autoclaw-cn-not-accio.md)；本 ADR 其余决策（四家、四个独立包、checkin 钩子托管调度）不变。

需求是把 小浣熊、CatPaw（妙手）、Accio、Loomy 四家的反代与每日任务（签到 / 领积分）引入 magpie。现状是把外挂的 agent2api（本地 OpenAI 兼容网关）当自定义 provider 使用；我们决定改按 magpie 插件规范新写 **4 个独立 provider 插件包**（raccoon / catpaw / accio / loomy），落在独立工作目录 `magpie-plugins`（monorepo，每服务一个包），每日任务经插件 `auth.checkin` 钩子由 magpie 原生调度（四家中 小浣熊、Loomy 有签到类动作）。理由：账号、用量、每日任务在 magpie 统一管理，无额外常驻进程，与既有 `@magpie-community/opencode-*-auth` 插件同构；四个服务协议成本封在各自包内、互不牵连。agent2api 与既有 18.7 / new-api 链路暂并存，验证稳定后逐个退役。

## Considered Options

- **维持 agent2api 外挂**：可行，但签到不进 magpie 调度、多一层进程与一份数据，长期只是临时形态。
- **自研独立反代服务，再作自定义 provider 接入**：重复造轮子，且仍拿不到 magpie 原生账号 / 用量 / 每日任务界面。

## Consequences

- 插件实现跟随 magpie 插件 API 演进；当前装机版 0.1.1233 已实测具备 provider 插件、checkin 钩子与本地（path）安装能力。
- 公开分发（npm 发布 / 提 magpie-community / 开公开仓库）暂缓，另行决策；当前定位为自用。
- 各服务的登录态维护策略（桌面端凭据复用、agent2api 账号导入、手动兜底）细节另立 ADR。
