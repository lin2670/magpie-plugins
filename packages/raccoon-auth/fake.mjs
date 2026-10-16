// the fake 小浣熊 upstream: every route the plugin asks, on a local port.
// The refresh token rotates strictly (a spent one is refused), the chat
// frames carry the vendor's own model name, and today's point grant only
// shows in the bills once setting_info was asked.

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const sse = (frames) => frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n"

const beijingNow = () => new Date(Date.now() + 8 * 3600e3).toISOString()

export function fakeRaccoon() {
  const state = {
    access: "access-1",
    refresh: "refresh-1",
    refreshCalls: 0,
    chatCalls: [],
    settingCalls: 0,
    grantAfterSetting: true,
    grantedToday: false,
    webCode: "web-code-1",
    spentCodes: new Set(),
    models: [
      { name: "sn-test-1", display_name: "Test One", description: "TestOne", params: { context_window: 1000, max_tokens: 100 }, tags: [] },
      { name: "sn-test-1", display_name: "Duplicate skipped", tags: [] },
      { name: "sn-test-2", description: "A codename standing in as the display name", params: { context_window: 2000, max_tokens: 200 }, tags: ["vision"] },
    ],
    reset() {
      state.access = "access-1"
      state.refresh = "refresh-1"
      state.refreshCalls = 0
      state.chatCalls = []
      state.settingCalls = 0
      state.grantAfterSetting = true
      state.grantedToday = false
      state.webCode = "web-code-1"
      state.spentCodes = new Set()
    },
  }
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const auth = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "")

      if (url.pathname === "/api/web/auth/v1/refresh") {
        state.refreshCalls++
        const body = await req.json().catch(() => ({}))
        if (body.refresh_token !== state.refresh) return json(401, { code: 401, message: "refresh token refused" })
        state.access = `access-${state.refreshCalls + 1}`
        state.refresh = `refresh-${state.refreshCalls + 1}`
        return json(200, { code: 0, data: { access_token: state.access, refresh_token: state.refresh } })
      }

      // the web sign-in's code exchange (login_with_authorization_code): a
      // one-time code → a token pair; a spent code answers the real vendor's
      // 200035 instead of failing the request
      if (url.pathname === "/api/web/auth/v1/login_with_authorization_code") {
        const body = await req.json().catch(() => ({}))
        const code = String(body?.authorization_code ?? "").trim()
        if (!code || code !== state.webCode || state.spentCodes.has(code))
          return json(200, { code: 200035, message: "authorization code expired" })
        state.spentCodes.add(code)
        state.access = "web-access-1"
        state.refresh = "web-refresh-1"
        return json(200, {
          code: 0,
          data: {
            access_token: state.access,
            refresh_token: state.refresh,
            office_identity: "office-id-1",
            office_org_name: "测试组织",
            office_org_role: "member",
          },
        })
      }

      if (auth !== state.access) return json(401, { code: 401, message: "token refused" })

      if (url.pathname === "/api/web/llm/v2/chat/completions") {
        const body = await req.json().catch(() => ({}))
        state.chatCalls.push({ auth, body })
        if (body.stream === false)
          return json(200, { id: "c1", model: "internal-1", choices: [{ index: 0, message: { role: "assistant", content: "你好" }, finish_reason: "stop" }] })
        return new Response(
          sse([
            { id: "c1", model: "internal-1", choices: [{ index: 0, delta: { content: "你" } }] },
            { id: "c1", model: "internal-1", choices: [{ index: 0, delta: { content: "好" } }] },
            { id: "c1", model: "internal-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          ]),
          { headers: { "content-type": "text/event-stream" } },
        )
      }

      if (url.pathname === "/api/web/llm/v2/model_catalog")
        return json(200, { code: 0, data: { categories: [{ type: "chat", models: state.models }] } })

      if (url.pathname === "/api/web/office/v3/setting_info") {
        state.settingCalls++
        if (state.grantAfterSetting) state.grantedToday = true
        return json(200, { code: 0, data: { point_grant_popups: null, point_grant_toast: null } })
      }

      if (url.pathname === "/api/web/points/v1/bills") {
        const items = state.grantedToday ? [{ points: 6000, created_at: beijingNow(), event_name: "每日登录" }] : []
        return json(200, { code: 0, data: { items } })
      }

      if (url.pathname === "/api/web/points/v1/balance")
        return json(200, {
          code: 0,
          data: { available_points: 6300, daily_points: 6000, monthly_points: 0, reward_points: 300, topup_points: 0 },
        })

      if (url.pathname === "/api/web/auth/v1/entitlement_info")
        return json(200, { code: 0, data: { office: { pro_enable: true, active_plan: { type: "pro" }, pro_expired_time: "2027-01-01" } } })

      return json(404, { code: 404, message: "no such route" })
    },
  })
  return { server, state, url: `http://127.0.0.1:${server.port}` }
}
