# CatPaw 插件分两期交付：v1 简化链路先行

---
status: accepted
date: 2026-10-14
---

CatPaw 的参照实现（agent2api `providers/catpaw/`，约 7 千行）包含跨请求会话复用（`x-session-id → conversationId` 注册表）、消息指纹增量提交与工具续接等有状态机制，是四家中复杂度最高的。此前已有端到端验证过的简化实现（`catpaw-proxy.mjs`：round → event → turn + 累积分差分，OpenAI 兼容）。我们决定 CatPaw 插件的 **v1 只移植简化链路**（对话 + 流式优先），把会话复用与工具续接列为二期增强。

## Considered Options

- **v1 一步到位对齐 agent2api 完整会话机**：工作量大、且会话注册表要自建 TTL / 作废逻辑，拖慢整体交付；等前几家插件的实测经验厚起来再做更稳。

## Consequences

- CatPaw 插件 v1 的会话跨请求不保持（每请求独立 round）；长对话与工具调用场景的体验以 catpaw-proxy.mjs 已验证形态为准。
- 若 v1 实测显示编码 agent 工具场景确实受损，再按二期优先级提前补齐（会话注册表可放插件进程内存，Bun 宿主为常驻单进程，具备承载条件）。
