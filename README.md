# magpie-plugins

把 小浣熊（Raccoon）、CatPaw（妙手）、Loomy（讯飞）、AutoClaw 国内版（智谱 autoglm）四个 AI 服务做成 magpie 原生 provider 插件（含每日签到 / 领积分）的工作目录。

- 实施顺序：小浣熊 → CatPaw → Loomy → AutoClaw 国内版（第一家做样板，打通"登录 → 模型 → 对话 → 每日任务"全链路）
- 结构：`packages/raccoon-auth`、`packages/catpaw-auth`、`packages/loomy-auth`、`packages/autoclaw-cn-auth`（provider id：`raccoon` / `catpaw` / `loomy` / `autoclaw`；AutoClaw 只做**国内版**）
- 第四家原定 Accio（阿里国际版），2026-10-15 按用户要求改为 **AutoClaw 国内版** —— 见 [ADR-0004](docs/adr/0004-fourth-service-autoclaw-cn-not-accio.md)
- 参照实现：aimod-cc/agent2api（只取逻辑，按 magpie 插件规范重写）
- 文档：`GLOSSARY.md`（术语表）、`docs/adr/`（决策记录）、`docs/magpie-plugin-mechanism.md`（机制侦察）、`docs/recon-agent2api-four-services.md`（四家提炼）、`docs/recon-community-plugin-playbook.md`（社区写法）
- 状态：**四家全部交付并真机验收**（2026-10-14 开工，2026-10-15 完成）：M1 小浣熊 → M2 CatPaw（v1 简化链路，见 ADR-0003）→ M3 Loomy → M4 AutoClaw 国内版

## 验收口径（每个插件）

1. 登录可见：`magpie plugin list` / accounts 里账号在；各登录方式（从 agent2api 导入 / 手机验证码 / 手动粘贴）可用
2. 模型可见：经 magpie 网关 `/v1/models` 列出该家模型（与 agent2api 对照）
3. 真实对话：curl 过网关，中文非流式与流式各一轮（SSE 正常、模型名回写正确、报错清晰）
4. 每日任务：`magpie accounts checkin` 手动触发返回 claimed / done；开关打开后由调度自动执行
5. 不破坏现有链路：agent2api、18.7 / new-api、已装插件照常
6. 质量线：按社区插件规范写（README / 测试 / 版本），为可提交做准备；公开动作另行决策

四家的实测证据与验收结论见 `docs/verification-2026-10-15.md`。
