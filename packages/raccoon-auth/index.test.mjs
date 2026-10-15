import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { rmSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RaccoonAuthPlugin, _internal } from "./index.mjs"
import { fakeRaccoon } from "./fake.mjs"

// every test runs against the fake upstream in fake.mjs: no network, no real
// token ever leaves this process

let fake
let plugin
let saved = {}
const client = { auth: { set: async ({ body }) => (saved = body) } }
const getAuth = async () => saved
let tmpDir

beforeAll(async () => {
  fake = fakeRaccoon()
  tmpDir = mkdtempSync(join(tmpdir(), "raccoon-auth-test-"))
  const dbPath = join(tmpDir, "agent2api.db")
  const db = new Database(dbPath)
  db.run("CREATE TABLE accounts (id TEXT PRIMARY KEY, provider TEXT, enabled INTEGER, data TEXT)")
  db.run("INSERT INTO accounts VALUES (?, ?, 1, ?)", [
    "user-1",
    "raccoon",
    JSON.stringify({ id: "user-1", provider: "raccoon", accessToken: "access-1", refreshToken: "refresh-1", expiresAt: Date.now() + 3600e3, userId: "u1", name: "Tester" }),
  ])
  db.close()
  process.env.RACCOON_LLM_BASE_URL = `${fake.url}/api/web/llm/v2`
  process.env.RACCOON_MAIN_SITE_URL = fake.url
  process.env.RACCOON_AUTH_API_BASE = `${fake.url}/api/web/auth/v1`
  process.env.AGENT2API_DB = dbPath
})

afterAll(() => {
  fake.server.stop(true)
  rmSync(tmpDir, { recursive: true, force: true })
})

// a fresh plugin each test: its spent-token memory starts empty, as a fresh
// host process would see it
beforeEach(async () => {
  fake.state.reset()
  saved = { type: "oauth", access: "access-1", refresh: "refresh-1", expires: Date.now() + 3600e3, accountId: "Tester", userId: "u1", name: "Tester" }
  plugin = await RaccoonAuthPlugin({ client })
})

describe("config", () => {
  test("lists the five fallback models", async () => {
    const cfg = {}
    await plugin.config(cfg)
    expect(cfg.provider.raccoon.name).toBe("小浣熊 Raccoon")
    expect(cfg.provider.raccoon.npm).toBe("@ai-sdk/openai-compatible")
    expect(Object.keys(cfg.provider.raccoon.models).sort()).toEqual(Object.keys(_internal.FALLBACK_MODELS).sort())
  })
})

describe("sign-in methods", () => {
  test("imports the agent2api account, read-only", async () => {
    const method = plugin.auth.methods.find((m) => m.label.includes("agent2api"))
    expect(method).toBeTruthy()
    expect(method.prompts).toBeUndefined() // exactly one account: nothing to pick
    const flow = method.authorize()
    expect(flow.method).toBe("auto")
    const result = await flow.callback()
    expect(result.type).toBe("success")
    expect(result.access).toBe("access-1")
    expect(result.refresh).toBe("refresh-1")
    expect(result.source).toBe("agent2api")
  })

  test("pasted tokens are stripped and dated", async () => {
    const method = plugin.auth.methods.find((m) => m.label.includes("Paste"))
    const jwt = "eyJhbGciOiJub25lIn0.eyJleHAiOjk5OTk5OTk5OTl9.x"
    const result = await method.authorize({ access: `Bearer ${jwt}`, refresh: "r" })
    expect(result.type).toBe("success")
    expect(result.access).toBe(jwt)
    expect(result.expires).toBe(9999999999 * 1000)
    expect(await method.authorize({ access: "  " })).toMatchObject({ type: "failed" })
  })
})

describe("chat", () => {
  test("the body passes through and every SSE frame carries the asked model name", async () => {
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch(`${fake.url}/api/web/llm/v2/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "sn-test-1", stream: true, messages: [{ role: "user", content: "hi" }] }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('"model":"sn-test-1"')
    expect(text).not.toContain("internal-1")
    expect(text).toContain("data: [DONE]")
    expect(fake.state.chatCalls.length).toBe(1)
    expect(fake.state.chatCalls[0].body.model).toBe("sn-test-1")
    expect(fake.state.chatCalls[0].auth).toBe("access-1")
  })

  test("a non-stream JSON answer is rewritten too", async () => {
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch(`${fake.url}/api/web/llm/v2/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "sn-test-2", stream: false, messages: [] }),
    })
    const answer = await res.json()
    expect(answer.model).toBe("sn-test-2")
    expect(answer.choices[0].message.content).toBe("你好")
  })

  test("a 401 renews once and asks again", async () => {
    saved = { type: "oauth", access: "stale-access", refresh: "refresh-1", expires: Date.now() + 3600e3, name: "Tester" }
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch(`${fake.url}/api/web/llm/v2/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "sn-test-1", messages: [] }),
    })
    expect(res.status).toBe(200)
    expect(fake.state.refreshCalls).toBe(1)
    expect(saved.access).toBe("access-2")
    expect(saved.refresh).toBe("refresh-2")
  })

  test("only chat completions are served", async () => {
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch(`${fake.url}/api/web/llm/v2/embeddings`, { method: "POST", body: "{}" })
    expect(res.status).toBe(404)
  })

  test("nothing is served before a sign-in", async () => {
    saved = {}
    const loader = await plugin.auth.loader(getAuth)
    expect(loader).toEqual({})
  })
})

describe("refresh", () => {
  test("the same spent refresh token is not renewed twice", async () => {
    const auth = { type: "oauth", access: "access-1", refresh: "refresh-1", expires: 1 }
    const got1 = await plugin.auth.refresh(auth)
    const got2 = await plugin.auth.refresh(auth)
    expect(got1.access).toBe("access-2")
    expect(got2.access).toBe(got1.access)
    expect(fake.state.refreshCalls).toBe(1)
  })

  test("an account without a refresh token is left alone", async () => {
    expect(await plugin.auth.refresh({ type: "oauth", access: "x" })).toBeUndefined()
    expect(await plugin.auth.refresh({ type: "api", key: "k" })).toBeUndefined()
  })

  test("a refused refresh token says the sign-in expired", async () => {
    await expect(plugin.auth.refresh({ type: "oauth", access: "x", refresh: "wrong" })).rejects.toThrow(/过期|refused|失败/)
  })
})

describe("checkin", () => {
  test("triggers the grant and reads it back as claimed", async () => {
    const result = await plugin.auth.checkin(getAuth)
    expect(result.outcome).toBe("claimed")
    expect(result.credit).toBe(6000)
    expect(result.message).toContain("+6000")
    expect(fake.state.settingCalls).toBe(1)
  })

  test("no grant today reads as done", async () => {
    fake.state.grantAfterSetting = false
    const result = await plugin.auth.checkin(getAuth)
    expect(result.outcome).toBe("done")
  })

  test("a refused token says the sign-in expired", async () => {
    saved = { type: "oauth", access: "gone", refresh: "refresh-1", expires: Date.now() + 3600e3 }
    await expect(plugin.auth.checkin(getAuth)).rejects.toThrow(/过期/)
  })
})

describe("models", () => {
  test("the account's catalog is registered into the provider table", async () => {
    const p = { models: { ..._internal.FALLBACK_MODELS } }
    const list = await plugin.provider.models(p, { auth: saved })
    // new catalog models are added into p.models (so the gateway sees them),
    // and the return is p.models itself
    expect(list).toBe(p.models)
    expect(Object.keys(list)).toContain("sn-test-1")
    expect(Object.keys(list)).toContain("sn-test-2")
    expect(list["sn-test-1"].name).toBe("Test One")
    expect(list["sn-test-1"].limit).toEqual({ context: 1000, output: 100 })
    expect(list["sn-test-2"].name).toBe("A codename standing in as the display name")
    expect(list["sn-test-2"].modalities).toEqual({ input: ["text", "image"], output: ["text"] })
    // the original fallback models are kept
    expect(Object.keys(list)).toContain("raccoon-8c4485")
  })

  test("a refused catalog keeps the configured list", async () => {
    saved = { type: "oauth", access: "gone", refresh: "refresh-1", expires: Date.now() + 3600e3 }
    const p = { models: { ..._internal.FALLBACK_MODELS } }
    const list = await plugin.provider.models(p, { auth: saved })
    expect(list).toEqual(_internal.FALLBACK_MODELS)
  })
})

describe("usage", () => {
  test("the points balance as windows", async () => {
    const usage = await plugin.auth.usage(getAuth)
    expect(usage.plan).toBe("pro")
    expect(usage.user).toBe("Tester")
    const daily = usage.windows.find((w) => w.name === "每日积分")
    expect(daily.amount).toBe(6000)
    expect(daily.resetsAt).toBeGreaterThan(Date.now())
    const total = usage.windows.find((w) => w.name === "可用积分")
    expect(total.display).toBe("6300 credits")
  })
})

describe("helpers", () => {
  test("dates and tokens", () => {
    expect(_internal.jwtEnd("x.eyJleHAiOjE3OTk5OTk5OTl9.y")).toBe(1799999999 * 1000)
    expect(_internal.jwtEnd("not-a-jwt")).toBe(0)
    expect(_internal.stripBearer("Bearer abc")).toBe("abc")
    expect(_internal.beijingToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(_internal.beijingMidnight()).toBeGreaterThan(Date.now())
  })
})
