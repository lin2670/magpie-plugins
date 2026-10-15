// the fake AutoClaw upstream: the account domain (signed login / refresh /
// points / check-in / model catalog) and the LLM proxy, both on one local
// port (they share a host in the real vendor).

import { createHash } from "node:crypto"

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

// a JWT-shaped token whose payload carries exp / user_id / device_id, so the
// plugin's jwtEnd (and the real server's claims) see the same shape
function jwt(exp, userId, deviceId) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
  return `${enc({ alg: "HS256", typ: "JWT" })}.${enc({ user_id: userId, device_id: deviceId, exp })}.sig`
}

const APP_ID = "100003"
const APP_KEY = "38d2391985e2369a5fb8227d8e6cd5e5"

export function fakeAutoClaw() {
  const state = {
    phone: "13800138000",
    code: 123456,
    userId: "20260001",
    deviceId: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0",
    access: jwt(Math.floor(Date.now() / 1000) + 3600, "20260001", "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0"),
    refresh: "refresh-1",
    signinDone: false,
    // when true, /userapi/v1/refresh answers 400002 and the plugin must
    // degrade to /userapi/v1/agent-refresh
    refreshNeedsFallback: false,
    sendCodeCalls: [],
    loginCalls: [],
    refreshCalls: [],
    agentRefreshCalls: [],
    taskCalls: [],
    walletCalls: 0,
    chatCalls: [],
    catalogCalls: 0,
    lastUserapiHeaders: null,
    lastProxyHeaders: null,
    lastAuthHeader: null,
    reset() {
      state.signinDone = false
      state.refreshNeedsFallback = false
      state.sendCodeCalls = []
      state.loginCalls = []
      state.refreshCalls = []
      state.agentRefreshCalls = []
      state.taskCalls = []
      state.walletCalls = 0
      state.chatCalls = []
      state.catalogCalls = 0
      state.lastUserapiHeaders = null
      state.lastProxyHeaders = null
      state.lastAuthHeader = null
    },
  }

  // every account-domain request must carry the client's fingerprint: the
  // sign is recomputed from the appId it names and the timestamp it sent
  const signedOk = (headers) => {
    const appId = headers.get("x-auth-appid") ?? ""
    const ts = headers.get("x-auth-timestamp") ?? ""
    const sign = headers.get("x-auth-sign") ?? ""
    if (appId !== APP_ID) return false
    const expect = createHash("md5").update(`${appId}&${ts}&${APP_KEY}`).digest("hex")
    return sign === expect
  }

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const path = url.pathname
      const signed = signedOk(req.headers)

      // paths that need a live Bearer token as well as the signature
      const AUTHED = new Set([
        "/agent-assetmgr/api/v2/wallets",
        "/agent-assetmgr/api/v1/points/expiring",
        "/agentpay/v1/assistant/subscribe-info",
        "/autoclaw-proxy/proxy/autoclaw-task-complete",
        "/autoclaw-proxy/proxy/autoclaw-task-list",
      ])
      const isAccountDomain =
        path.startsWith("/userapi/") || path.startsWith("/agent-assetmgr/") || path.startsWith("/agentpay/") || AUTHED.has(path)

      // ── account domain ────────────────────────────────────────────────
      if (isAccountDomain) {
        if (!signed) return json(401, { code: 400_002, msg: "签名校验失败" })
        state.lastUserapiHeaders = Object.fromEntries(req.headers)
        state.lastAuthHeader = req.headers.get("authorization")
        if (AUTHED.has(path) && state.lastAuthHeader !== `Bearer ${state.access}`)
          return json(401, { code: 410_000, msg: "登录态已失效" })
        const body = await req.json().catch(() => ({}))

        if (path === "/userapi/v1/agent-send-code") {
          state.sendCodeCalls.push(body)
          if (body.phone !== state.phone) return json(200, { code: 400_001, msg: "请求数据有问题,请检查后重试" })
          if (!body.device_id) return json(200, { code: 400_001, msg: "请求数据有问题,请检查后重试" })
          return json(200, { code: 0, msg: "ok", data: { result: true } })
        }

        if (path === "/userapi/v1/agent-login/") {
          state.loginCalls.push(body)
          // the code must be a JSON number (agent2api's lesson)
          if (typeof body.code !== "number") return json(200, { code: 400_001, msg: "请求数据有问题,请检查后重试" })
          if (body.code !== state.code) return json(200, { code: 630_202, msg: "抱歉,验证码错误，请输入正确验证码！" })
          if (body.platform !== "web") return json(200, { code: 400_001, msg: "请求数据有问题,请检查后重试" })
          state.access = jwt(Math.floor(Date.now() / 1000) + 3600, state.userId, body.device_id)
          state.refresh = "refresh-2"
          return json(200, { code: 0, msg: "ok", data: { access_token: state.access, refresh_token: state.refresh } })
        }

        if (path === "/userapi/v1/refresh" || path === "/userapi/v1/agent-refresh") {
          const isFallback = path.endsWith("agent-refresh")
          ;(isFallback ? state.agentRefreshCalls : state.refreshCalls).push(body)
          if (state.refreshNeedsFallback && !isFallback) return json(200, { code: 400_002, msg: "签名校验失败" })
          if (body.refresh_token !== state.refresh) return json(200, { code: 401, msg: "登录态已失效" })
          if (body.source_id !== "autoclaw") return json(200, { code: 400_001, msg: "参数错误" })
          state.access = jwt(Math.floor(Date.now() / 1000) + 3600, state.userId, state.deviceId)
          state.refresh = `refresh-${state.refreshCalls.length + state.agentRefreshCalls.length + 2}`
          return json(200, { code: 0, msg: "ok", data: { access_token: state.access, refresh_token: state.refresh } })
        }

        if (path === "/agent-assetmgr/api/v2/wallets") {
          state.walletCalls++
          return json(200, {
            code: 0,
            msg: "ok",
            data: {
              total_balance: 12700,
              wallets: [
                { public_wallet_type: "daily", display_name: "赠送积分", balance: 200, display: true, priority: 1 },
                { public_wallet_type: "long_term", display_name: "通用积分", balance: 12500, display: true, priority: 3 },
                { public_wallet_type: "hidden", display_name: "隐藏", balance: 999, display: false, priority: 2 },
              ],
            },
          })
        }

        if (path === "/agent-assetmgr/api/v1/points/expiring") {
          return json(200, { code: 0, msg: "ok", data: { expiring_points: 200, total_points: 12700 } })
        }

        if (path === "/agentpay/v1/assistant/subscribe-info") {
          return json(200, { code: 0, msg: "ok", data: { subscribeInfo: { productName: "Coding Plan", status: "active" } } })
        }

        if (path === "/autoclaw-proxy/proxy/autoclaw-task-complete") {
          state.taskCalls.push(body)
          if (body.task_id !== "daily_signin") return json(200, { code: 400_001, msg: "参数错误" })
          if (state.signinDone)
            return json(200, { code: 0, msg: "ok", data: { already_completed: true, reward_points: 0, success: false, task_id: "daily_signin" } })
          state.signinDone = true
          return json(200, { code: 0, msg: "ok", data: { already_completed: false, reward_points: 200, success: true, task_id: "daily_signin" } })
        }

        if (path === "/autoclaw-proxy/proxy/autoclaw-task-list") {
          return json(200, { code: 0, msg: "ok", data: [{ task_id: "daily_signin", completed: state.signinDone }] })
        }

        return json(404, { code: 400_001, msg: "no route" })
      }

      // ── LLM proxy ─────────────────────────────────────────────────────
      if (path === "/autoclaw-proxy/proxy/autoclaw-model-config") {
        if (!signed) return json(401, { code: 400_002, msg: "签名校验失败" })
        state.catalogCalls++
        return json(200, {
          models: [
            { id: "zaicoding_glm-5.3", name: "GLM-5.3", reasoning: true, input: ["text"], contextWindow: 1048576, maxTokens: 307200, creditConsumptionLevel: "低" },
            { id: "zai_glm-5.3-flash", name: "GLM-5.3-Flash", reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 131072, creditConsumptionLevel: "中" },
            { id: "zai_auto", name: "Auto", reasoning: true, input: ["text", "image"] },
            { id: "zai_auto-fast", name: "Auto Fast", reasoning: true, input: ["text"] },
          ],
        })
      }

      if (path === "/autoclaw-proxy/proxy/autoclaw/chat/completions") {
        state.lastProxyHeaders = Object.fromEntries(req.headers)
        const auth = req.headers.get("x-authorization") ?? ""
        if (auth !== `Bearer ${state.access}`) return json(401, { message: "unauthorized" })
        // the proxy pre-refuses a small max_tokens (406, empty body)
        const body = await req.json().catch(() => ({}))
        if (typeof body.max_tokens === "number" && body.max_tokens > 0 && body.max_tokens < 10_000)
          return new Response("", { status: 406 })
        state.chatCalls.push(body)
        const model = body.stream ? body.model : body.model
        const reply = body.stream
          ? new Response(
              [
                `data: ${JSON.stringify({ id: "c1", model: "zai_auto", choices: [{ index: 0, delta: { role: "assistant", content: "你" } }] })}\n\n`,
                `data: ${JSON.stringify({ id: "c1", model: "zai_auto", choices: [{ index: 0, delta: { content: "好" } }] })}\n\n`,
                `data: ${JSON.stringify({ id: "c1", model: "zai_auto", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
                "data: [DONE]\n\n",
              ].join(""),
              { headers: { "content-type": "text/event-stream" } },
            )
          : json(200, { id: "c1", model: "zai_auto", choices: [{ index: 0, message: { role: "assistant", content: `你好（${model}）` }, finish_reason: "stop" }] })
        return reply
      }

      return json(404, { message: "no route" })
    },
  })

  return {
    server,
    state,
    base: `http://127.0.0.1:${server.port}`,
    proxyBase: `http://127.0.0.1:${server.port}/autoclaw-proxy/proxy/autoclaw`,
    jwt,
  }
}
