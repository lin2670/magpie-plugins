// the fake Copilot upstream: device flow, token exchange, /models catalog,
// /responses and /chat/completions on a local port — the four surfaces the
// plugin touches, with the same response shapes as the real gateway.

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

export function fakeCopilot() {
  const state = {
    // the device flow: codes awaiting approval, like GitHub's
    deviceCodes: new Map(), // device_code -> { user_code, approved, token }
    exchangeCalls: 0,
    modelCalls: [], // { endpoint, model } per chat request
    requestUrls: [],
    catalogCalls: 0,
    catalogTokens: [],
    chatBody: null,
    streamChat: false,
    streamToolCalls: false,
    reset() {
      state.deviceCodes = new Map()
      state.exchangeCalls = 0
      state.modelCalls = []
      state.requestUrls = []
      state.catalogCalls = 0
      state.catalogTokens = []
      state.chatBody = null
      state.streamChat = false
      state.streamToolCalls = false
      state.account = "default"
      state.paid = false
    },
    // a paid-shaped exchange answer (no quota fields) for the usage tests
    paid: false,
    // a device code the test can pre-approve (or approve later)
    issueDevice(approvedToken = null) {
      const dc = "dc_" + crypto.randomUUID().replace(/-/g, "")
      const uc = "TEST-CODE"
      state.deviceCodes.set(dc, { user_code: uc, approved: !!approvedToken, token: approvedToken })
      return { device_code: dc, user_code: uc, verification_uri: "http://device", interval: 1, expires_in: 900 }
    },
    approve(dc, token = "gho_fake_user_token") {
      const d = state.deviceCodes.get(dc)
      if (d) {
        d.approved = true
        d.token = token
      }
    },
  }

  const CATALOGS = {
    default: { data: [
      { id: "gpt-6-luna", capabilities: { type: "chat" }, supported_endpoints: ["/responses"], policy: { state: "enabled" } },
      { id: "gpt-5.6-luna", capabilities: { type: "chat" }, supported_endpoints: ["/responses"], policy: { state: "enabled" } },
      { id: "kimi-k3", capabilities: { type: "chat" }, supported_endpoints: ["/chat/completions"], policy: { state: "enabled" } },
      { id: "disabled-model", capabilities: { type: "chat" }, supported_endpoints: ["/responses"], policy: { state: "disabled" } },
      { id: "gpt-5.6-luna-free-auto", capabilities: { type: "chat" }, supported_endpoints: ["/responses"], policy: { state: "enabled" } },
      { id: "gpt-41-copilot", capabilities: { type: "completion" }, supported_endpoints: ["/completions"] },
      { id: "copilot-search-a", capabilities: { type: "chat" }, supported_endpoints: ["/responses"] },
    ] },
    a: { data: [
      { id: "gpt-6-luna", capabilities: { type: "chat" }, supported_endpoints: ["/responses"], policy: { state: "enabled" } },
      { id: "kimi-k3", capabilities: { type: "chat" }, supported_endpoints: ["/chat/completions"], policy: { state: "enabled" } },
    ] },
    b: { data: [
      { id: "gpt-4o", display_name: "GPT-4o", capabilities: { type: "chat" }, supported_endpoints: ["/chat/completions"], policy: { state: "enabled" } },
    ] },
  }

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)

      // ── GitHub device flow ────────────────────────────────────────────
      if (url.pathname === "/login/device/code") {
        const b = await req.json()
        if (!b.client_id) return json(404, { error: "Not Found" })
        return json(200, state.issueDevice())
      }
      if (url.pathname === "/login/oauth/access_token") {
        const b = await req.json()
        const d = state.deviceCodes.get(b.device_code)
        if (!d) return json(200, { error: "expired_token", error_description: "bad device code" })
        if (!d.approved) return json(200, { error: "authorization_pending" })
        return json(200, { access_token: d.token, token_type: "bearer" })
      }
      if (url.pathname === "/user") {
        const auth = req.headers.get("authorization") || ""
        if (!auth.startsWith("token ")) return json(401, { message: "Bad credentials" })
        return json(200, { login: "fake-user" })
      }

      // ── copilot_internal token exchange ───────────────────────────────
      if (url.pathname === "/copilot_internal/v2/token") {
        const auth = req.headers.get("authorization") || ""
        if (!auth.startsWith("token ")) return json(401, { message: "Bad credentials" })
        state.exchangeCalls++
        // a revoked github token (test marks it by value) answers 401
        if (auth === "token gho_revoked") return json(401, { message: "Bad credentials" })
        if (state.paid)
          return json(200, {
            token: "tid_paid_" + state.exchangeCalls,
            expires_at: Math.floor(Date.now() / 1000 + 1500),
            refresh_in: 1500,
            sku: "copilot_pro",
            tracking_id: "fake-tracking",
            endpoints: { api: "http://" + url.host },
          })
        return json(200, {
          token: "tid_fake_copilot_token_" + state.exchangeCalls + ";exp=" + Math.floor(Date.now() / 1000 + 1500),
          expires_at: Math.floor(Date.now() / 1000 + 1500),
          refresh_in: 1500,
          sku: "free_limited_copilot",
          tracking_id: "fake-tracking",
          // the real shape (measured 2026-10-28): plain numbers, what is LEFT
          // of the free monthly allowance, plus a unix-seconds date that is
          // NOT the quota reset (measured 2026-11-01: every account reset on
          // the 1st while this field still named scattered per-account dates)
          limited_user_quotas: { chat: 199, completions: 2000 },
          limited_user_reset_date: Math.floor(Date.UTC(2027, 5, 15) / 1000),
          endpoints: { api: "http://" + url.host },
        })
      }

      // ── the Copilot API host ──────────────────────────────────────────
      if (url.pathname === "/models") {
        const auth = req.headers.get("authorization") || ""
        if (!auth.startsWith("Bearer tid_")) return json(401, { error: { message: "no token" } })
        state.catalogCalls++
        state.catalogTokens.push(auth)
        return json(200, CATALOGS[state.account] ?? CATALOGS.default)
      }
      if (url.pathname === "/responses") {
        state.requestUrls.push(url.href)
        const auth = req.headers.get("authorization") || ""
        if (!auth.startsWith("Bearer tid_")) return json(401, { error: { message: "no token" } })
        const b = await req.json()
        state.modelCalls.push({ endpoint: "/responses", model: b.model })
        if (b.model === "kimi-k3") return json(400, { error: { message: "model not on /responses", code: "unsupported_api_for_model" } })
        if (b.stream) {
          return new Response(
            `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "HE" })}\n\n` +
              `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "LLO" })}\n\n` +
              `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}\n\n` +
              `data: [DONE]\n\n`,
            { status: 200, headers: { "content-type": "text/event-stream" } },
          )
        }
        return json(200, {
          id: "resp_1",
          object: "response",
          status: "completed",
          model: b.model,
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK:" + b.model }] }],
          usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
        })
      }
      if (url.pathname === "/chat/completions") {
        const auth = req.headers.get("authorization") || ""
        if (!auth.startsWith("Bearer tid_")) return json(401, { error: { message: "no token" } })
        const b = await req.json()
        state.chatBody = b
        state.modelCalls.push({ endpoint: "/chat/completions", model: b.model })
        if (b.model === "gpt-6-luna") return json(400, { error: { message: "not on chat/completions", code: "unsupported_api_for_model" } })
        if (state.streamChat && b.stream) {
          const frames = state.streamToolCalls
            ? [
                { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "lookup", arguments: "{\\\"q\\\":" } }] } }] },
                { choices: [{ delta: { tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "count", arguments: "{}" } }] } }] },
                { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }], content: "done" } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]
            : [
                { choices: [{ delta: { content: "HELLO" } }] },
                { choices: [{ delta: {}, finish_reason: "stop" }] },
              ]
          return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          })
        }
        return json(200, {
          id: "chat_1",
          object: "chat.completion",
          created: 1700000000,
          model: b.model,
          choices: [{ index: 0, message: { role: "assistant", content: "HI:" + b.model }, finish_reason: "stop" }],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        })
      }

      return json(404, { error: { message: "no such path " + url.pathname } })
    },
  })

  return { server, state, base: `http://127.0.0.1:${server.port}` }
}
