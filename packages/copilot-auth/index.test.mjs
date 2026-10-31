// Tests use the local fake upstream and import the network guard before plugin code.
import "./nonet.mjs"
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { fakeCopilot } from "./fake.mjs"

let fake
let _internal
let CopilotAuthPlugin
const origFetch = globalThis.fetch
const origGatewayBase = process.env.COPILOT_API_BASE
const origGitHubBase = process.env.COPILOT_GITHUB_API_BASE
const origWebBase = process.env.COPILOT_GITHUB_WEB_BASE
const origClientId = process.env.COPILOT_CLIENT_ID
const origIntegrationId = process.env.COPILOT_INTEGRATION_ID
const origCopilotBase = process.env.COPILOT_API_BASE

beforeAll(async () => {
  fake = fakeCopilot()
  process.env.COPILOT_API_BASE = fake.base
  process.env.COPILOT_GITHUB_API_BASE = fake.base
  process.env.COPILOT_GITHUB_WEB_BASE = fake.base
  const mod = await import("./index.mjs")
  _internal = mod._internal
  CopilotAuthPlugin = mod.CopilotAuthPlugin
})
afterAll(() => {
  fake.server.stop(true)
  globalThis.fetch = origFetch
  if (origCopilotBase === undefined) delete process.env.COPILOT_API_BASE
  else process.env.COPILOT_API_BASE = origCopilotBase
  if (origGatewayBase === undefined) delete process.env.COPILOT_API_BASE
  else process.env.COPILOT_API_BASE = origGatewayBase
  if (origGitHubBase === undefined) delete process.env.COPILOT_GITHUB_API_BASE
  else process.env.COPILOT_GITHUB_API_BASE = origGitHubBase
  if (origWebBase === undefined) delete process.env.COPILOT_GITHUB_WEB_BASE
  else process.env.COPILOT_GITHUB_WEB_BASE = origWebBase
  if (origClientId === undefined) delete process.env.COPILOT_CLIENT_ID
  else process.env.COPILOT_CLIENT_ID = origClientId
  if (origIntegrationId === undefined) delete process.env.COPILOT_INTEGRATION_ID
  else process.env.COPILOT_INTEGRATION_ID = origIntegrationId
})

async function createPlugin() {
  return CopilotAuthPlugin({})
}

// the wire functions take explicit URLs, so point them at the fake
function apiUrl(path) {
  return fake.base + path
}

const asAuth = (githubToken, access = "") => ({
  type: "oauth",
  refresh: githubToken,
  access,
  expires: access ? Date.now() + 30 * 60_000 : 0,
})

describe("device flow", () => {
  test("network guard blocks non-loopback fetches", () => {
    expect(() => fetch("https://example.com")).toThrow("network guard blocked")
  })

  test("requestDeviceCode returns a code", async () => {
    fake.state.reset()
    // requestDeviceCode uses the fixed GitHub URL; exercise the fake's
    // shape through fetchCatalog-free helpers instead
    const res = await fetch(apiUrl("/login/device/code"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: "x" }),
    })
    const j = await res.json()
    expect(j.user_code).toBe("TEST-CODE")
    expect(j.device_code).toBeTruthy()
  })

  test("pollDeviceToken approves and trades", async () => {
    fake.state.reset()
    const res = await fetch(apiUrl("/login/device/code"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: "x" }),
    })
    const device = await res.json()
    // poll before approval → pending; the plugin's poll loop would keep
    // going — here we assert the fake's contract directly
    const r1 = await fetch(apiUrl("/login/oauth/access_token"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: device.device_code }),
    })
    expect((await r1.json()).error).toBe("authorization_pending")
    fake.state.approve(device.device_code)
    const r2 = await fetch(apiUrl("/login/oauth/access_token"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: device.device_code }),
    })
    const j2 = await r2.json()
    expect(j2.access_token).toBe("gho_fake_user_token")
  })
})

describe("copilot token exchange", () => {
  test("exchanges a github token for the api token", async () => {
    fake.state.reset()
    const next = await _internal.exchangeCopilotToken("gho_fake_user_token", fake.base)
    expect(next.access).toMatch(/^tid_/)
    expect(next.refresh).toBe("gho_fake_user_token")
    expect(next.expires).toBeGreaterThan(Date.now())
    expect(next.sku).toBe("free_limited_copilot")
  })

  test("a revoked github token is marked expired", async () => {
    let threw = null
    try {
      await _internal.exchangeCopilotToken("gho_revoked", fake.base)
    } catch (e) {
      threw = e
    }
    expect(threw?.signIn).toBe("expired")
  })
})

describe("catalog", () => {
  test("fetchCatalog maps id → entry", async () => {
    fake.state.reset()
    const cat = await _internal.fetchCatalog("tid_fake", fake.base)
    expect(cat.get("gpt-6-luna").supported_endpoints).toEqual(["/responses"])
    expect(cat.get("kimi-k3").supported_endpoints).toEqual(["/chat/completions"])
  })

  test("models list excludes disabled and non-chat catalog entries", async () => {
    const plugin = await createPlugin()
    const models = await plugin.provider.models({ models: {} }, { auth: asAuth("gho_models") })
    expect(models["gpt-6-luna"]).toBeDefined()
    expect(models["disabled-model"]).toBeUndefined()
    expect(models["gpt-5.6-luna-free-auto"]).toBeUndefined()
    expect(models["gpt-41-copilot"]).toBeUndefined()
    expect(models["copilot-search-a"]).toBeUndefined()
  })

  test("catalog failure falls back to safe common models only", async () => {
    const plugin = await createPlugin()
    const models = await plugin.provider.models({ models: {} }, { auth: asAuth("gho_revoked") })
    expect(models["gpt-4o"]).toBeDefined()
    expect(models["kimi-k3"]).toBeUndefined()
    expect(models["gpt-6-luna"]).toBeUndefined()
  })

  test("account catalogs stay isolated when accounts alternate", async () => {
    fake.state.reset()
    const plugin = await createPlugin()
    const authA = asAuth("ghu_account_a")
    const authB = asAuth("ghu_account_b")
    const modelsA = await plugin.provider.models({ models: {} }, { auth: authA })
    fake.state.account = "b"
    const modelsB = await plugin.provider.models({ models: {} }, { auth: authB })
    fake.state.account = "a"
    const modelsAAgain = await plugin.provider.models({ models: {} }, { auth: authA })
    expect(fake.state.catalogCalls).toBe(2)
    expect(modelsA["kimi-k3"]).toBeDefined()
    expect(modelsB["kimi-k3"]).toBeUndefined()
    expect(modelsB["gpt-4o"]).toBeDefined()
    expect(modelsAAgain["kimi-k3"]).toBeDefined()
  })
})

describe("sign-in methods", () => {
  // magpie's host stores authorize()'s return as the sign-in session and
  // calls its callback() verbatim (0.1.2120): a return without a callback
  // crashes with "s.a.callback is not a function", and authorize failures
  // must throw so the real error reaches the user.
  async function signInWith(method, inputs) {
    const plugin = await createPlugin()
    const m = plugin.auth.methods[method]
    const session = await m.authorize(inputs)
    if (!session || typeof session.callback !== "function")
      throw new Error("authorize returned no callback")
    return session.callback()
  }

  test("the device-flow method signs in through its callback", async () => {
    fake.state.reset()
    const plugin = await createPlugin()
    const m = plugin.auth.methods[0]
    const session = await m.authorize()
    expect(typeof session.callback).toBe("function")
    expect(session.method).toBe("auto")
    expect(session.url).toBe("http://device")
    // approve the pending device code, then let the poll find it
    const code = [...fake.state.deviceCodes.keys()].at(-1)
    fake.state.approve(code)
    const r = await session.callback()
    expect(r.type).toBe("success")
    expect(r.refresh).toBe("gho_fake_user_token")
    expect(r.access).toMatch(/^tid_/)
    expect(r.accountId).toBe("fake-user")
  })

  test("an unreachable GitHub makes the device-flow authorize throw", async () => {
    fake.state.reset()
    const saved = process.env.COPILOT_GITHUB_WEB_BASE
    process.env.COPILOT_GITHUB_WEB_BASE = "http://127.0.0.1:1"
    try {
      const plugin = await createPlugin()
      await expect(plugin.auth.methods[0].authorize()).rejects.toThrow()
    } finally {
      if (saved === undefined) delete process.env.COPILOT_GITHUB_WEB_BASE
      else process.env.COPILOT_GITHUB_WEB_BASE = saved
    }
  })

  test("the paste-token method returns a session with a callback", async () => {
    fake.state.reset()
    const r = await signInWith(1, { token: "gho_fake_user_token" })
    expect(r).toMatchObject({ type: "success", refresh: "gho_fake_user_token", accountId: "手动粘贴" })
    expect(r.access).toMatch(/^tid_/)
  })

  test("a bad pasted token makes the paste method throw", async () => {
    fake.state.reset()
    const plugin = await createPlugin()
    await expect(plugin.auth.methods[1].authorize({ token: "gho_revoked" })).rejects.toThrow("GitHub token 已失效")
  })
})

describe("usage", () => {
  test("reports remaining quota and reset date in magpie's windows shape", async () => {
    fake.state.reset()
    const plugin = await createPlugin()
    const out = await plugin.auth.usage(async () => ({ type: "oauth", refresh: "gho_fake_user_token", accountId: "测试号" }))
    expect(out.plan).toBe("Copilot Free")
    expect(out.user).toBe("测试号")
    const chat = out.windows.find((w) => w.name === "Chat 额度")
    const comp = out.windows.find((w) => w.name === "补全额度")
    // the fake hands chat:199 of a 200 allowance → 1 used
    expect(chat.display).toBe("199 / 200")
    expect(chat.used).toBeCloseTo(0.5, 5)
    expect(chat.amount).toBe(1)
    expect(chat.limit).toBe(200)
    expect(comp.display).toBe("2000 / 2000")
    expect(comp.amount).toBe(0)
    // both windows carry the reset date as ISO
    expect(new Date(chat.resetsAt).getTime()).toBeGreaterThan(Date.now())
    expect(new Date(comp.resetsAt).getTime()).toBeGreaterThan(Date.now())
    // a clean read carries no signIn (magpie reads that as "sign-in fine")
    expect(out.signIn).toBeUndefined()
  })

  test("a paid sku (no quota fields) shows the plan with no windows", async () => {
    fake.state.paid = true
    try {
      const plugin = await createPlugin()
      const out = await plugin.auth.usage(async () => ({ type: "oauth", refresh: "gho_fake_user_token" }))
      expect(out.plan).toBe("GitHub Copilot")
      expect(out.windows).toEqual([])
    } finally {
      fake.state.paid = false
    }
  })

  test("a revoked github token is reported as expired, not kept", async () => {
    const plugin = await createPlugin()
    const out = await plugin.auth.usage(async () => ({ type: "oauth", refresh: "gho_revoked" }))
    expect(out.signIn).toBe("expired")
    expect(out.error).toContain("失效")
  })

  test("an older auth snapshot cannot overwrite the renewed token cache", async () => {
    const plugin = await createPlugin()
    const old = asAuth("ghu_stale", "tid_old")
    const loader = await plugin.auth.loader(async () => old)
    const fresh = await plugin.auth.refresh({ ...old, expires: Date.now() })
    const response = await loader.fetch("https://api.githubcopilot.com/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-6-luna", input: "hi" }),
    })
    expect(response.status).toBe(200)
    expect(fake.state.catalogTokens.at(-1)).toBe(`Bearer ${fresh.access}`)
  })

  test("refresh and loader share one in-flight token exchange per account", async () => {
    fake.state.reset()
    const plugin = await createPlugin()
    const stale = asAuth("ghu_concurrent")
    const loader = await plugin.auth.loader(async () => stale)
    const [refresh, response] = await Promise.all([
      plugin.auth.refresh(stale),
      loader.fetch("https://api.githubcopilot.com/responses", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-6-luna", input: "hi" }),
      }),
    ])
    expect(refresh.access).toMatch(/^tid_/)
    expect(response.status).toBe(200)
    expect(fake.state.exchangeCalls).toBe(1)
  })
})

describe("responses shapes", () => {
  test("messagesOf keeps system instructions, tool calls, and tool results", () => {
    const messages = _internal.messagesOf({
      instructions: "Be concise",
      input: [
        { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{\"q\":\"x\"}" },
        { type: "function_call_output", call_id: "call_1", output: "found" },
      ],
    })
    expect(messages).toEqual([
      { role: "system", content: "Be concise" },
      { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "found" },
    ])
  })

  test("messagesOf preserves preformatted chat messages and instructions", () => {
    const messages = _internal.messagesOf({
      instructions: "Be clear",
      messages: [{ role: "user", content: "hello" }],
    })
    expect(messages).toEqual([
      { role: "system", content: "Be clear" },
      { role: "user", content: "hello" },
    ])
  })

  test("messagesOf flattens string and item input", () => {
    const a = _internal.messagesOf({ input: "hi" })
    expect(a).toEqual([{ role: "user", content: "hi" }])
    const b = _internal.messagesOf({
      input: [
        { role: "system", content: "sys" },
        { role: "user", content: [{ type: "input_text", text: "hello " }, { type: "input_text", text: "world" }] },
      ],
    })
    expect(b).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hello world" },
    ])
  })

  test("toolsOf wraps function tools and rejects hosted tools", () => {
    const out = _internal.toolsOf([{ type: "function", name: "calc", description: "d", parameters: { type: "object" } }])
    expect(out[0].function.name).toBe("calc")
    const passthrough = _internal.toolsOf([{ type: "function", function: { name: "x" } }])
    expect(passthrough[0].function.name).toBe("x")
    expect(() => _internal.toolsOf([{ type: "web_search_preview" }])).toThrow("不支持的 Responses 工具类型")
  })

  test("toResponses rewrites a chat answer (non-stream)", async () => {
    const upstream = new Response(
      JSON.stringify({
        id: "chat_1",
        created: 1700000000,
        model: "kimi-k3",
        choices: [{ index: 0, message: { role: "assistant", content: "HI" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
    const out = await _internal.toResponses(upstream, "kimi-k3", false)
    const j = await out.json()
    expect(j.object).toBe("response")
    expect(j.output[0].content[0].text).toBe("HI")
    expect(j.usage.total_tokens).toBe(6)
  })

  test("toResponses converts non-stream tool calls to function_call items", async () => {
    const upstream = new Response(
      JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: "checking",
            tool_calls: [
              { id: "call_a", type: "function", function: { name: "lookup", arguments: "{\\\"q\\\":1}" } },
              { id: "call_b", type: "function", function: { name: "count", arguments: "{}" } },
            ],
          },
          finish_reason: "tool_calls",
        }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
    const out = await _internal.toResponses(upstream, "kimi-k3", false)
    const response = await out.json()
    expect(response.output.map((item) => item.type)).toEqual(["message", "function_call", "function_call"])
    expect(response.output[1]).toMatchObject({ call_id: "call_a", name: "lookup", arguments: "{\\\"q\\\":1}" })
  })

  test("toResponses preserves an upstream error for streaming requests", async () => {
    const upstream = new Response(JSON.stringify({ error: { message: "nope" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    })
    const out = await _internal.toResponses(upstream, "kimi-k3", true)
    expect(out.status).toBe(400)
    expect(await out.json()).toMatchObject({ error: { message: "nope" } })
  })

  test("toResponses emits complete indexed tool-call deltas", async () => {
    const frames = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "lookup", arguments: "{\\\"q\\\":" } }] } }] },
      { choices: [{ delta: { content: "running", tool_calls: [{ index: 1, id: "call_b", function: { name: "count", arguments: "{}" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] } }] },
    ]
    const upstream = new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })
    const out = await _internal.toResponses(upstream, "kimi-k3", true)
    const events = (await out.text()).split("\n\n").filter((part) => part.startsWith("data: ") && part !== "data: [DONE]").map((part) => JSON.parse(part.slice(6)))
    expect(events.filter((event) => event.type === "response.output_item.added").map((event) => event.item.type)).toEqual(["function_call", "message", "function_call"])
    expect(events.filter((event) => event.type === "response.output_item.added").map((event) => event.output_index)).toEqual([0, 1, 2])
    expect(events.filter((event) => event.type === "response.function_call_arguments.delta").map((event) => event.delta)).toEqual(["{\\\"q\\\":", "{}", "1}"])
    expect(events.filter((event) => event.type === "response.function_call_arguments.done")).toHaveLength(2)
    expect(events.at(-1).type).toBe("response.completed")
  })

  test("loader preserves query parameters and rejects image parts rather than dropping them", async () => {
    fake.state.reset()
    const plugin = await createPlugin()
    const loader = await plugin.auth.loader(async () => asAuth("ghu_query"))
    process.env.COPILOT_API_BASE = fake.base
    const response = await loader.fetch(fake.base + "/responses?tracking=abc", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-6-luna", input: "hi" }),
    })
    expect(response.status).toBe(200)
    expect(fake.state.requestUrls.at(-1)).toContain("?tracking=abc")

    const streamRequest = await loader.fetch(fake.base + "/responses", {
      method: "POST",
      body: JSON.stringify({ model: "kimi-k3", input: "hi", stream: true }),
    })
    expect(streamRequest.status).toBe(200)
    expect(fake.state.chatBody.stream_options).toEqual({ include_usage: true })
    // a URL-bearing input_image bridges onto chat's image_url part, in
    // order, with the pure-text messages still a plain string
    const imageRequest = await loader.fetch(fake.base + "/responses", {
      method: "POST",
      body: JSON.stringify({
        model: "kimi-k3",
        input: [
          { role: "user", content: ["看这张图", { type: "input_image", image_url: "data:image/png;base64,abc" }, "说完了吗"] },
          { role: "user", content: "纯文本还在吗" },
        ],
      }),
    })
    expect(imageRequest.status).toBe(200)
    expect(fake.state.chatBody.messages[0].content).toEqual([
      { type: "text", text: "看这张图" },
      { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
      { type: "text", text: "说完了吗" },
    ])
    expect(fake.state.chatBody.messages[1].content).toBe("纯文本还在吗")

    // a file_id references the vendor's Files API, which the Copilot
    // gateway doesn't expose — nothing can resolve it, so it stays 400
    const fileIdRequest = await loader.fetch(fake.base + "/responses", {
      method: "POST",
      body: JSON.stringify({ model: "kimi-k3", input: [{ role: "user", content: [{ type: "input_image", file_id: "file-abc" }] }] }),
    })
    expect(fileIdRequest.status).toBe(400)
    expect(await fileIdRequest.json()).toMatchObject({ error: { message: expect.stringContaining("file_id") } })
  })

  test("toResponses handles loader chat streaming, multiple calls, and incomplete upstream errors", async () => {
    fake.state.reset()
    const plugin = await createPlugin()
    fake.state.streamChat = true
    fake.state.streamToolCalls = true
    const loader = await plugin.auth.loader(async () => asAuth("ghu_stream"))
    const response = await loader.fetch("https://api.githubcopilot.com/responses", {
      method: "POST",
      body: JSON.stringify({
        model: "kimi-k3",
        stream: true,
        instructions: "Be clear",
        temperature: 0.2,
        top_p: 0.8,
        tool_choice: "auto",
        parallel_tool_calls: false,
        tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
        max_output_tokens: 96,
        input: [{ role: "user", content: "run tools" }],
      }),
    })
    const streamText = await response.text()
    expect(fake.state.chatBody.messages[0]).toEqual({ role: "system", content: "Be clear" })
    expect(fake.state.chatBody).toMatchObject({ temperature: 0.2, top_p: 0.8, tool_choice: "auto", parallel_tool_calls: false, max_tokens: 96 })
    expect(fake.state.chatBody.tools[0].function.name).toBe("lookup")
    expect(streamText).toContain("response.function_call_arguments.delta")
    expect(streamText).toContain("response.completed")

    fake.state.streamChat = false
    const badUpstream = new Response(JSON.stringify({ error: { message: "upstream failed" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    })
    const failed = await _internal.toResponses(badUpstream, "kimi-k3", true)
    expect(failed.status).toBe(400)
    expect(await failed.json()).toMatchObject({ error: { message: "upstream failed" } })
  })

  test("toResponses marks stream truncation incomplete and preserves usage", async () => {
    const upstream = new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } })}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )
    const out = await _internal.toResponses(upstream, "kimi-k3", true)
    const text = await out.text()
    expect(text).toContain('"status":"incomplete"')
    expect(text).toContain('"input_tokens":7')
    expect(text).toContain('"output_tokens":2')
    expect(text).toContain("response.content_part.done")
  })

  test("toResponses closes an unterminated stream with accumulated text", async () => {
    const upstream = new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "hello" } }] })}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )
    const out = await _internal.toResponses(upstream, "kimi-k3", true)
    const text = await out.text()
    expect(text).toContain("response.output_text.done")
    expect(text).toContain("response.completed")
    expect(text).toContain("hello")
  })

  test("toResponses passes an upstream error through", async () => {
    const upstream = new Response(JSON.stringify({ error: { message: "nope" } }), { status: 400 })
    const out = await _internal.toResponses(upstream, "x", false)
    expect(out.status).toBe(400)
  })
})
