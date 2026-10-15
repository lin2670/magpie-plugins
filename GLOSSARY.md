# magpie-plugins：四家服务反代插件

把 小浣熊、CatPaw（妙手）、Loomy、AutoClaw 国内版 四个 AI 服务做成 magpie 原生 provider 插件（含每日签到）的工作目录；本表约定项目用语。

## Language

**反代（reverse proxy）**：
在本地复用某服务官方客户端的登录态，把该服务的私有协议转译成标准 API（如 OpenAI 兼容），供其它工具调用。本项目四个插件的共同本质。
_Avoid_: 反向代理、2api、逆向代理

**登录态复用**：
不重新实现目标服务的登录流程，直接使用与官方客户端相同的凭据及其续期机制。
_Avoid_: 模拟登录、自动登录

**官方客户端**：
各服务厂商发布的正版客户端（桌面端 / 网页端），是协议形态与登录态的上游事实来源。
_Avoid_: 宿主客户端

**桌面端凭据**：
官方桌面客户端保存在本机的登录凭据，是"登录态复用"的首选来源。
_Avoid_: cookie

**上游（upstream）**：
指四家服务厂商及其服务端（美团、小浣熊方、讯飞、阿里）。
_Avoid_: 服务商（泛指时）

**参照实现（agent2api）**：
aimod-cc/agent2api——把多家桌面客户端登录态汇聚为本地 OpenAI 兼容网关的现成工具；本项目从它提取四家的鉴权、协议与每日任务逻辑，但按 magpie 插件规范重写。
_Avoid_: 上游（严禁混用：上游指厂商）

**账号导入**：
把参照实现（agent2api）中已登录账号的凭据一次性搬运进 magpie 插件的账号体系；本项目对小浣熊 / Loomy / AutoClaw 国内版的初始账号来源（CatPaw 直接读桌面端凭据）。
_Avoid_: 同步

**provider 插件（provider plugin）**：
magpie 的插件类型之一：以独立包向 magpie 提供一个"模型来源"的登录、模型清单与请求转发；magpie 为其提供 provider 卡片、用量展示与每日任务调度。
_Avoid_: 扩展、mod

**checkin 钩子（auth.checkin）**：
magpie 插件契约中的每日任务接口：magpie 负责调度（每账号每"北京日"一次），插件负责发送签到 / 领积分请求并回报结果。
_Avoid_: 定时脚本

**北京日**：
magpie 每日任务使用的自然日口径（北京时间）；一个账号一天只会被签到一次。
_Avoid_: 当日（含糊）

**agent 客户端**：
经由 magpie 使用模型的本地编码工具（如 ZCode、Claude Code、pi）。
_Avoid_: 客户端（与"官方客户端"混淆）

**目标四家**：
小浣熊（Raccoon）、CatPaw（美团妙手）、Loomy（讯飞）、AutoClaw 国内版（智谱 autoglm）——本项目优先交付的四个服务。（第四家原定 Accio，见 [ADR-0004](docs/adr/0004-fourth-service-autoclaw-cn-not-accio.md)。）
_Avoid_: 四平台、供应商

**妙手（CatPaw）**：
同一服务的中英文两个名字；中文产品名"妙手"，协议代号 CatPaw。本机已安装其桌面端。
_Avoid_: 混写"妙手CatPaw"（正文首次出现写全，其后任选其一）

**签到（check-in）**：
服务提供的每日领取动作（如小浣熊的"桌面登录积分"）。
_Avoid_: 打卡

**每日赠送（daily grant）**：
服务按日自动刷新 / 发放的积分类权益（如 Loomy 的"每日赠送积分刷新"）；与签到同为每日动作，但无需用户主动领取。
_Avoid_: 白嫖、薅积分

**每日任务（daily task）**：
本项目对"签到 + 每日赠送"两类动作的统称；在 magpie 中统一经由 checkin 钩子执行。
_Avoid_: 用"签到"泛指两类
