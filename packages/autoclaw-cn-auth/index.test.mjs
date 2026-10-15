import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { rmSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AutoClawAuthPlugin, _internal } from "./index.mjs"
import { fakeAutoClaw } from "./fake.mjs"

// every test runs against the fake upstream in fake.mjs: no network, no real
// token ever leaves this process

let fake
let plugin
let saved = {}
let tmpDir
const client = { auth: { set: async ({ body }) => (saved = body) } }
const getAuth = async () => saved

beforeAll(async () => {
  fake = fakeAutoClaw()
  tmpDir = mkdtempSync(join(tmpdir(), "autoclaw-auth-test-"))
  const dbPath = join(tmpDir, "agent2api.db")
  const db = new Database(dbPath)
  db.run("CREATE TABLE accounts (id TEXT PRIMARY KEY, provider TEXT, enabled INTEGER, data TEXT)")
  db.run("INSERT INTO accounts VALUES (?, ?, 1, ?)", [
    "user-20260001",
    "autoclaw",
    JSON.stringify({
      id: "user-20260001",
      provider: "autoclaw",
      accessToken: fake.state.access,
      refreshToken: fake.state.refresh,
      deviceId: fake.state.deviceId,
      expiresAt: Date.now() + 3600e3,
      name: "138****8000",
      userId: "20260001",
    }),
  ])
  db.close()
  process.env.AUTOCLAW_USERAPI_BASE_URL = fake.base
  process.env.AUTOCLAW_UPSTREAM_BASE_URL = fake.proxyBase
  process.env.AGENT2API_DB = dbPath
})

afterAll(() => {
  fake.server.stop(true)
  rmSync(tmpDir, { recursive: true, force: true })
})

beforeEach(async () => {
  fake.state.reset()
  saved = { type: "oauth", access: fake.state.access, refresh: fake.state.refresh, deviceId: fake.state.deviceId, expires: Date.now() + 3600e3, accountId: "138****8000", name: "138****8000", source: "agent2api" }
  plugin = await AutoClawAuthPlugin({ client })
})

describe("sign-in methods", () => {
  test("imports the agent2api account, read-only", async () => {
    const method = plugin.auth.methods.find((m) => m.label.includes("agent2api"))
    expect(method).toBeTruthy()
    const flow = method.authorize()
    const result = await flow.callback()
    expect(result.type).toBe("success")
    expect(result.access).toBe(fake.state.access)
    expect(result.refresh).toBe(fake.state.refresh)
    expect(result.deviceId).toBe(fake.state.deviceId)
    expect(result.source).toBe("agent2api")
  })

  test("SMS: sends the code, then trades it for a token pair", async () => {
    const method = plugin.auth.methods.find((m) => m.label.includes("SMS"))
    const flow = await method.authorize({ phone: "138 0013 8000" }) // spaces tolerated
    expect(flow.method).toBe("code")
    expect(flow.instructions).toContain("已发送")
    expect(fake.state.sendCodeCalls.length).toBe(1)
    expect(fake.state.sendCodeCalls[0].source_id).toBe("autoclaw")
    // a wrong code fails with a readable reason
    const wrong = await flow.callback("000000")
    expect(wrong.type).toBe("failed")
    const result = await flow.callback("123456")
    expect(result.type).toBe("success")
    expect(result.access).toBe(fake.state.access)
    expect(result.expires).toBeGreaterThan(Date.now() + 3000e3)
    expect(result.accountId).toBe("138****8000")
    // the code goes up as a number, not a string (the vendor rejects strings)
    const ok = fake.state.loginCalls[fake.state.loginCalls.length - 1]
    expect(ok.code).toBe(123456)
    expect(ok.platform).toBe("web")
    expect(ok.source_id).toBe("autoclaw")
  })

  test("SMS: an invalid phone is refused before anything is sent", async () => {
    const method = plugin.auth.methods.find((m) => m.label.includes("SMS"))
    const bad = await method.authorize({ phone: "12345" })
    expect(bad.type).toBe("failed")
    expect(fake.state.sendCodeCalls.length).toBe(0)
  })

  test("manual paste works, and the access token is Bearer-stripped", async () => {
    const method = plugin.auth.methods.find((m) => m.label.includes("Paste"))
    const result = await method.authorize({ access: "Bearer pasted", refresh: "r", deviceId: "d" })
    expect(result.type).toBe("success")
    expect(result.access).toBe("pasted")
    expect(result.refresh).toBe("r")
    expect(result.deviceId).toBe("d")
  })
})

describe("chat", () => {
  const call = async (body) => {
    const loader = await plugin.auth.loader(getAuth)
    return loader.fetch(`${fake.proxyBase}/chat/completions`, { method: "POST", body: JSON.stringify(body) })
  }

  test("forwards with X-Authorization, the route header and a stripped body model", async () => {
    const res = await call({ model: "glm-5.3-flash", stream: true, messages: [{ role: "user", content: "hi" }] })
    expect(res.status).toBe(200)
    const text = await res.text()
    // the proxy's own model name in every frame is rewritten to the asked one
    expect(text).toContain('"model":"glm-5.3-flash"')
    expect(text).toContain("data: [DONE]")
    const h = fake.state.lastProxyHeaders
    expect(h["x-authorization"]).toBe(`Bearer ${fake.state.access}`)
    expect(h["x-request-model"]).toBe("zai_glm-5.3-flash")
    // the proxy refuses `zcode` on this path: the harness header must be gone
    expect(h["x-harness-type"]).toBeUndefined()
    expect(h["x-product"]).toBe("autoclaw")
    expect(h["x-tm"]).toBe("win")
    // body.model is the route id with its prefix stripped
    expect(fake.state.chatCalls[0].model).toBe("glm-5.3-flash")
  })

  test("a known prefix is passed through as the route id", async () => {
    await call({ model: "zaicoding_glm-5.3", stream: false, messages: [] })
    expect(fake.state.lastProxyHeaders["x-request-model"]).toBe("zaicoding_glm-5.3")
    expect(fake.state.chatCalls[0].model).toBe("glm-5.3")
  })

  test("an unknown model falls back to the default route", async () => {
    const res = await call({ model: "claude-sonnet-4", stream: false, messages: [] })
    expect(res.status).toBe(200)
    expect(fake.state.lastProxyHeaders["x-request-model"]).toBe("zai_auto")
    expect(fake.state.chatCalls[0].model).toBe("auto")
  })

  test("a remote-only model (auto-fast) resolves through the catalog", async () => {
    const p = { models: {} }
    await plugin.provider.models(p, { auth: saved }) // learns zai_auto-fast
    await call({ model: "auto-fast", stream: false, messages: [] })
    expect(fake.state.lastProxyHeaders["x-request-model"]).toBe("zai_auto-fast")
    expect(fake.state.chatCalls[0].model).toBe("auto-fast")
  })

  test("a small max_tokens is lifted to 10000", async () => {
    await call({ model: "glm-5.3", stream: false, max_tokens: 1024, messages: [] })
    expect(fake.state.chatCalls[0].max_tokens).toBe(10_000)
    // an absent max_tokens is not injected
    await call({ model: "glm-5.3", stream: false, messages: [] })
    expect(fake.state.chatCalls[1].max_tokens).toBeUndefined()
  })

  test("the first system message is opened with the OpenClaw identity line", async () => {
    await call({ model: "glm-5.3", stream: false, messages: [{ role: "system", content: "You are ZCode, an interactive coding agent" }, { role: "user", content: "hi" }] })
    const first = fake.state.chatCalls[0].messages[0]
    expect(first.role).toBe("system")
    expect(first.content.startsWith(_internal.IDENTITY_LINE)).toBe(true)
    expect(first.content).toContain("## Tooling")
    // the foreign identity is rewritten so the literal gate doesn't match
    expect(first.content).not.toContain("You are ZCode")
    expect(first.content).toContain("You are an interactive coding agent")
  })

  test("the pi preamble identity line is rewritten (upstream 406 fingerprint, 2026-10-15)", async () => {
    const preamble =
      "You are an expert coding assistant operating inside pi, a coding agent harness. " +
      "You help users by reading files, executing commands, editing code, and writing new files."
    await call({ model: "glm-5.3", stream: false, messages: [{ role: "system", content: preamble }, { role: "user", content: "hi" }] })
    const first = fake.state.chatCalls[0].messages[0]
    expect(first.content).not.toContain("inside pi")
    expect(first.content).toContain("You are an expert coding assistant")
  })

  test("the pi short-form fingerprint (no appositive) is rewritten too", async () => {
    await call({ model: "glm-5.3", stream: false, messages: [{ role: "system", content: "You are an expert coding assistant operating inside pi. Check files." }, { role: "user", content: "hi" }] })
    const first = fake.state.chatCalls[0].messages[0]
    expect(first.content).not.toContain("inside pi")
    expect(first.content).toContain("You are an expert coding assistant")
  })

  test("no system message: a prefix-only one is inserted, others untouched", async () => {
    await call({ model: "glm-5.3", stream: false, messages: [{ role: "user", content: "hi" }] })
    const messages = fake.state.chatCalls[0].messages
    expect(messages[0].role).toBe("system")
    expect(messages[0].content).toBe(_internal.IDENTITY_PREFIX)
    expect(messages[1].content).toBe("hi")
  })

  test("a 401 on a fresh token is renewed once and retried", async () => {
    saved = { type: "oauth", access: "stale", refresh: fake.state.refresh, deviceId: fake.state.deviceId, expires: Date.now() + 3600e3 }
    const res = await call({ model: "glm-5.3", stream: false, messages: [] })
    expect(res.status).toBe(200)
    expect(fake.state.refreshCalls.length).toBe(1)
    expect(saved.access).toBe(fake.state.access)
  })

  test("only chat completions are served", async () => {
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch(`${fake.proxyBase}/embeddings`, { method: "POST", body: "{}" })
    expect(res.status).toBe(404)
  })
})

describe("renewal", () => {
  test("a 400002 on /refresh degrades to /agent-refresh", async () => {
    fake.state.refreshNeedsFallback = true
    const next = await _internal.renewTokens({ access: fake.state.access, refresh: fake.state.refresh, deviceId: fake.state.deviceId })
    expect(fake.state.refreshCalls.length).toBe(1)
    expect(fake.state.agentRefreshCalls.length).toBe(1)
    expect(next.access).toBe(fake.state.access)
    expect(next.refresh).toBe(fake.state.refresh)
  })

  test("the refresh hook renews and reports the new pair", async () => {
    const next = await plugin.auth.refresh({ type: "oauth", access: fake.state.access, refresh: fake.state.refresh, deviceId: fake.state.deviceId })
    expect(next.access).toBe(fake.state.access)
    expect(next.expires).toBeGreaterThan(Date.now() + 3000e3)
  })

  test("a refused refresh token says the sign-in is gone", async () => {
    await expect(plugin.auth.refresh({ type: "oauth", access: "x", refresh: "wrong" })).rejects.toThrow(/失效|刷新失败/)
  })
})

describe("checkin", () => {
  test("the first press of the day earns the points", async () => {
    const result = await plugin.auth.checkin(getAuth)
    expect(result.outcome).toBe("claimed")
    expect(result.credit).toBe(200)
    expect(result.message).toContain("200")
    expect(fake.state.taskCalls[0].task_id).toBe("daily_signin")
  })

  test("a second press is 'done', not 'claimed'", async () => {
    await plugin.auth.checkin(getAuth)
    const again = await plugin.auth.checkin(getAuth)
    expect(again.outcome).toBe("done")
    expect(again.message).toContain("已签到")
  })

  test("an expired sign-in says so", async () => {
    saved = { type: "oauth", access: "gone", refresh: "wrong", expires: Date.now() + 3600e3 }
    await expect(plugin.auth.checkin(getAuth)).rejects.toThrow(/失效/)
  })
})

describe("usage", () => {
  test("the point wallets, hidden ones dropped", async () => {
    const usage = await plugin.auth.usage(getAuth)
    expect(usage.signIn).toBe("kept")
    expect(usage.windows.map((w) => w.name)).toEqual(["赠送积分", "通用积分"])
    expect(usage.windows[0].display).toBe("200 积分")
    expect(usage.windows[1].display).toBe("12500 积分")
    expect(fake.state.walletCalls).toBe(1)
  })
})

describe("models", () => {
  test("the remote catalog is registered into the provider table", async () => {
    const p = { models: {} }
    const list = await plugin.provider.models(p, { auth: saved })
    expect(Object.keys(list)).toEqual(["glm-5.3", "glm-5.3-flash", "auto", "auto-fast"])
    expect(list["glm-5.3"].name).toBe("GLM-5.3")
    expect(list["glm-5.3"].reasoning).toBe(true)
    expect(list["glm-5.3"].tool_call).toBe(true)
    expect(list["glm-5.3"].limit).toEqual({ context: 1048576, output: 307200 })
    // creditConsumptionLevel passes through as a word, not a number
    expect(list["glm-5.3"].rate).toBe("低")
    expect(list["glm-5.3-flash"].modalities).toEqual({ input: ["text", "image"], output: ["text"] })
    expect(fake.state.catalogCalls).toBe(1)
  })

  test("without a sign-in the table is left as it was", async () => {
    const p = { models: { x: { name: "X" } } }
    const list = await plugin.provider.models(p, { auth: { type: "oauth", access: "" } })
    expect(list).toBe(p.models)
    expect(fake.state.catalogCalls).toBe(0)
  })

  test("the config hook advertises the static fallback", async () => {
    const config = {}
    await plugin.config(config)
    expect(config.provider.autoclaw.name).toBe("AutoClaw 国内版")
    expect(config.provider.autoclaw.api).toBe(fake.proxyBase)
    expect(Object.keys(config.provider.autoclaw.models)).toEqual(["glm-5.3", "glm-5.3-flash"])
  })
})

describe("signature", () => {
  test("X-Auth-Sign is md5(appId&ts&appKey), lowercase hex", () => {
    const h = _internal.userapiHeaders("tok")
    expect(h["X-Auth-Appid"]).toBe("100003")
    expect(h["X-Auth-TimeStamp"]).toMatch(/^\d{10}$/)
    expect(h["X-Auth-Sign"]).toBe(
      createHash("md5").update(`100003&${h["X-Auth-TimeStamp"]}&38d2391985e2369a5fb8227d8e6cd5e5`).digest("hex"),
    )
    expect(h.authorization).toBe("Bearer tok")
    // the account domain keeps the harness header
    expect(h["X-Harness-Type"]).toBe("zcode")
  })

  test("an empty token drops the Authorization header", () => {
    expect(_internal.userapiHeaders("").authorization).toBeUndefined()
  })
})

describe("helpers", () => {
  test("phone normalization", () => {
    expect(_internal.normalizePhone("13800138000")).toBe("13800138000")
    expect(_internal.normalizePhone("+86 138-0013-8000")).toBe("13800138000")
    expect(_internal.normalizePhone("8613800138000")).toBe("13800138000")
    expect(_internal.normalizePhone("12345")).toBeNull()
    expect(_internal.normalizePhone("12800138000")).toBe("12800138000") // second digit 2-9 is allowed by this vendor
    expect(_internal.normalizePhone("1080013800")).toBeNull()
  })

  test("code normalization requires six digits", () => {
    expect(_internal.normalizeCode("123456")).toBe(123456)
    expect(_internal.normalizeCode("000123")).toBe(123)
    expect(_internal.normalizeCode("12345")).toBeNull()
    expect(_internal.normalizeCode("abcdef")).toBeNull()
  })

  test("route id shape", () => {
    expect(_internal.isRouteId("zai_glm-5.3")).toBe(true)
    expect(_internal.isRouteId("auto-fast")).toBe(false)
    expect(_internal.isRouteId("ZAI_x")).toBe(false)
    expect(_internal.stripRoutePrefix("zaicoding_glm-5.3")).toBe("glm-5.3")
    expect(_internal.stripRoutePrefix("zai_glm-5.3-flash")).toBe("glm-5.3-flash")
    expect(_internal.stripRoutePrefix("glm-5.3")).toBe("glm-5.3")
  })

  test("catalog base sits one level above the chat proxy", () => {
    expect(_internal.configBase()).toBe(`${fake.base}/autoclaw-proxy/proxy/`)
  })

  test("foreign identities rewrite case-insensitively, longest first", () => {
    expect(_internal.rewriteIdentities("You are ZCode, an interactive coding agent")).toBe("You are an interactive coding agent")
    // the whole matched span is replaced, so the rewrite's own casing shows
    expect(_internal.rewriteIdentities("you are codex, based on GPT-5")).toBe("You are a coding agent, based on GPT-5")
    expect(_internal.rewriteIdentities("nothing to change")).toBe("nothing to change")
  })

  test("a number user_id in JWT claims still yields an end time", () => {
    const tok = fake.jwt(Math.floor(Date.now() / 1000) + 60, "20260001", "d")
    expect(_internal.jwtEnd(tok)).toBeGreaterThan(Date.now() + 50_000)
    expect(_internal.jwtEnd("not-a-jwt")).toBe(0)
  })
})
