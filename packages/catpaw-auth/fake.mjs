// the fake 妙手 (CatPaw) upstream: the round/event/turn conversation machine
// on a local port, with cumulative SSE frames as the real gateway sends.

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

export function fakeCatPaw() {
  const state = {
    token: "cat-token-1",
    conversations: [],
    rounds: 0,
    events: 0,
    turns: 0,
    turnError: null, // "sse-error" makes the turn stream send an error frame
    balanceCalls: 0,
    reset() {
      state.conversations = []
      state.rounds = 0
      state.events = 0
      state.turns = 0
      state.turnError = null
      state.balanceCalls = 0
    },
  }
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)

      // the credit balance lives on its own host in the real vendor and takes
      // `X-Auth-Token`; the cookie the conversation gateway wants is refused
      // here with the real body (401 / code 4010)
      if (url.pathname === "/api/gateway/credit/balance") {
        state.balanceCalls++
        if (req.headers.get("x-auth-token") !== state.token) return json(401, { code: 4010, message: "Authentication token is required", data: null, errorCode: null })
        return json(200, {
          code: 0,
          message: "success",
          data: { availableCredits: "1134.67", userPlan: { planId: "plan_free", planName: "体验版", pro: false, status: "active" } },
          errorCode: null,
        })
      }

      const token = (req.headers.get("cookie") ?? "").match(/X-Passport-Token=(.+)/)?.[1] ?? ""
      if (token !== state.token) return json(401, { code: 401, msg: "token refused" })
      if (req.headers.get("m-appkey") !== "com.sankuai.mcopilot.cli") return json(400, { code: 400, msg: "m-appkey missing" })

      const body = await req.json().catch(() => ({}))

      if (url.pathname === "/api/agent/conversation/round") {
        state.rounds++
        if (body.source !== "CatX" || body.mode !== "CATX_APP") return json(400, { code: 400, msg: `source/mode wrong: ${body.source}/${body.mode}` })
        state.conversations.push({ id: body.conversationId, modelType: body.modelType, prompt: body.message?.content?.[0]?.text ?? "" })
        return json(200, { code: 0, data: { conversationId: body.conversationId } })
      }

      if (url.pathname === "/api/agent/conversation/event") {
        state.events++
        if (body.conversationId !== state.conversations.at(-1)?.id) return json(400, { code: 400, msg: "event for unknown conversation" })
        return json(200, { code: 0 })
      }

      if (url.pathname === "/api/agent/conversation/turn") {
        state.turns++
        const conv = state.conversations.at(-1)
        if (body.conversationId !== conv?.id) return json(400, { code: 400, msg: "turn for unknown conversation" })
        if (state.turnError === "sse-error")
          return new Response(`data: ${JSON.stringify({ error: { code: 500, message: "vendor broke" } })}\n\n`, { headers: { "content-type": "text/event-stream" } })
        // cumulative frames: each carries the whole text so far (as the real gateway does)
        const frames = [
          { message: { content: [{ type: "text", text: "你", reasoningContent: "思" }] } },
          { message: { content: [{ type: "text", text: "你好", reasoningContent: "思考" }] } },
          { message: { content: [{ type: "text", text: "你好，", reasoningContent: "思考" }] } },
          { message: { content: [{ type: "text", text: "你好，收到", reasoningContent: "思考" }] }, finished: true },
        ]
        const sse = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n"
        return new Response(sse, { headers: { "content-type": "text/event-stream" } })
      }

      return json(404, { code: 404, msg: "no such route" })
    },
  })
  return { server, state, url: `http://127.0.0.1:${server.port}` }
}
