import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { rmSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LoomyAuthPlugin, _internal } from "./index.mjs"
import { fakeLoomy } from "./fake.mjs"

// every test runs against the fake upstream in fake.mjs: no network, no real
// token ever leaves this process

let fake
let plugin
let saved = {}
let tmpDir
const client = { auth: { set: async ({ body }) => (saved = body) } }
const getAuth = async () => saved

beforeAll(async () => {
  fake = fakeLoomy()
  tmpDir = mkdtempSync(join(tmpdir(), "loomy-auth-test-"))
  const dbPath = join(tmpDir, "agent2api.db")
  const db = new Database(dbPath)
  db.run("CREATE TABLE accounts (id TEXT PRIMARY KEY, provider TEXT, enabled INTEGER, data TEXT)")
  db.run("INSERT INTO accounts VALUES (?, ?, 1, ?)", [
    "loomy-1",
    "loomy",
    JSON.stringify({ id: "loomy-1", provider: "loomy", accessToken: "sess-1", name: "138****8000", userId: "u9" }),
  ])
  db.close()
  process.env.LOOMY_POINTS_BASE_URL = fake.gatewayUrl
  process.env.LOOMY_XFYUN_BASE_URL = fake.accountUrl
  process.env.AGENT2API_DB = dbPath
})

afterAll(() => {
  fake.account.stop(true)
  fake.gateway.stop(true)
  rmSync(tmpDir, { recursive: true, force: true })
})

beforeEach(async () => {
  fake.state.reset()
  saved = { type: "oauth", access: fake.state.session, expires: 0, accountId: "138****8000", name: "138****8000", source: "agent2api" }
  plugin = await LoomyAuthPlugin({ client })
})

describe("sign-in methods", () => {
  test("imports the agent2api account, read-only", async () => {
    const method = plugin.auth.methods.find((m) => m.label.includes("agent2api"))
    expect(method).toBeTruthy()
    const flow = method.authorize()
    const result = await flow.callback()
    expect(result.type).toBe("success")
    expect(result.access).toBe("sess-1")
    expect(result.source).toBe("agent2api")
  })

  test("SMS: sends the code, then trades it for a 14-day session", async () => {
    const method = plugin.auth.methods.find((m) => m.label.includes("SMS"))
    const flow = await method.authorize({ phone: "138 0013 8000" }) // spaces tolerated
    expect(flow.method).toBe("code")
    expect(flow.instructions).toContain("已发送")
    expect(fake.state.smsSent).toBeTruthy()
    // wrong code fails with a reason
    expect((await flow.callback("000000")).type).toBe("failed")
    const result = await flow.callback("123456")
    expect(result.type).toBe("success")
    expect(result.access).toBe("sess-1")
    expect(result.expires).toBeGreaterThan(Date.now() + 13 * 86400e3)
    expect(result.accountId).toBe("138****8000")
  })

  test("SMS: an invalid phone is refused before anything is sent", async () => {
    const method = plugin.auth.methods.find((m) => m.label.includes("SMS"))
    const bad = await method.authorize({ phone: "12345" })
    expect(bad.type).toBe("failed")
    expect(fake.state.smsSent).toBeNull()
  })

  test("manual paste works", async () => {
    const method = plugin.auth.methods.find((m) => m.label.includes("Paste"))
    const result = await method.authorize({ session: "pasted" })
    expect(result.type).toBe("success")
    expect(result.access).toBe("pasted")
  })
})

describe("chat", () => {
  test("forwards with the double auth headers and streams through", async () => {
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch(`${fake.gatewayUrl}/api/v1/v1/chat/completions`.replace("/v1/v1/", "/api/v1/"), {
      method: "POST",
      body: JSON.stringify({ model: "spark-x", stream: true, messages: [{ role: "user", content: "hi" }] }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('"content":"你"')
    expect(text).toContain("data: [DONE]")
    expect(fake.state.chatCalls.length).toBe(1)
    expect(fake.state.chatCalls[0].body.model).toBe("spark-x")
  })

  test("reasoning effort folds to low/medium/high", async () => {
    const loader = await plugin.auth.loader(getAuth)
    await loader.fetch(`${fake.gatewayUrl}/api/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "spark-x", stream: false, reasoning_effort: "minimal", messages: [] }),
    })
    await loader.fetch(`${fake.gatewayUrl}/api/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "spark-x", stream: false, reasoning_effort: "max", messages: [] }),
    })
    await loader.fetch(`${fake.gatewayUrl}/api/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "spark-x", stream: false, reasoning_effort: "none", messages: [] }),
    })
    expect(fake.state.chatCalls[0].body.reasoning_effort).toBe("low")
    expect(fake.state.chatCalls[1].body.reasoning_effort).toBe("high")
    expect(fake.state.chatCalls[2].body.reasoning_effort).toBeUndefined()
  })

  test("deepseek images become base64 markers merged into the text", async () => {
    const loader = await plugin.auth.loader(getAuth)
    await loader.fetch(`${fake.gatewayUrl}/api/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        stream: false,
        messages: [
          { role: "user", content: [
            { type: "text", text: "看这张图" },
            { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
            { type: "image_url", image_url: { url: "https://example.com/x.png" } },
          ] },
        ],
      }),
    })
    const content = fake.state.chatCalls[0].body.messages[0].content
    expect(content).toHaveLength(2)
    expect(content[0].text).toContain("看这张图")
    expect(content[0].text).toContain("<image_base64>data:image/png;base64,QUJD</image_base64>")
    // an http(s) URL stays as it was (no evidence the marker accepts URLs)
    expect(content[1].type).toBe("image_url")
  })

  test("a refused session says 401", async () => {
    saved = { type: "oauth", access: "gone", expires: 0 }
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch(`${fake.gatewayUrl}/api/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "spark-x", stream: false, messages: [] }),
    })
    expect(res.status).toBe(401)
  })

  test("only chat completions are served", async () => {
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch(`${fake.gatewayUrl}/api/v1/embeddings`, { method: "POST", body: "{}" })
    expect(res.status).toBe(404)
  })
})

describe("checkin", () => {
  test("first-login is pressed and the daily balance reported", async () => {
    const result = await plugin.auth.checkin(getAuth)
    expect(result.outcome).toBe("claimed")
    // dailyBalance is the refreshed balance, not a grant amount: no credit
    expect(result.credit).toBeUndefined()
    expect(result.message).toContain("5000")
    expect(fake.state.firstLoginCalls).toBe(1)
  })

  test("a refused session says the sign-in expired", async () => {
    saved = { type: "oauth", access: "gone", expires: 0 }
    await expect(plugin.auth.checkin(getAuth)).rejects.toThrow(/失效/)
  })
})

describe("models", () => {
  test("the catalog, with rates split out of the names", async () => {
    const p = { models: {} }
    const list = await plugin.provider.models(p, { auth: saved })
    expect(Object.keys(list)).toEqual(["spark-x", "deepseek-v4-flash", "glm-5.3-flash", "plain"])
    expect(list["spark-x"].rate).toBe("x0.1")
    expect(list["spark-x"].name).toBe("Spark X2.5")
    expect(list["spark-x"].reasoning).toBe(true)
    expect(list["spark-x"].tool_call).toBe(true)
    expect(list["deepseek-v4-flash"].rate).toBe("x3.0")
    expect(list["glm-5.3-flash"].modalities).toEqual({ input: ["text", "image"], output: ["text"] })
    expect(list["plain"].rate).toBeUndefined()
    expect(list["plain"].name).toBe("No Suffix At All")
  })
})

describe("usage", () => {
  test("the two wallets as windows", async () => {
    const usage = await plugin.auth.usage(getAuth)
    // a clean read says nothing about the sign-in, so magpie can clear a lapse
    expect(usage.signIn).toBeUndefined()
    const daily = usage.windows.find((w) => w.name === "每日赠送积分")
    expect(daily.amount).toBe(5000)
    expect(daily.resetsAt).toBeGreaterThan(Date.now())
    const permanent = usage.windows.find((w) => w.name === "永久积分")
    expect(permanent.display).toBe("5000 credits")
  })
})

describe("signature", () => {
  test("the 9-part HMAC string matches the client's shape", () => {
    const headers = _internal.signHeaders("POST", "/login/phone/sendMsgCode", '{"a":1}')
    expect(headers.Authorization).toMatch(/^account 2thryby66wxi53sk:[A-Za-z0-9+/=]+$/)
    expect(headers.Date).toMatch(/GMT$/)
    expect(headers.Nonce).toMatch(/^[0-9a-f-]{36}$/)
    expect(headers["Content-MD5"]).toBe(_internal.contentMD5('{"a":1}'))
    // no body: no MD5 header, and the empty part sits in the string
    const empty = _internal.signHeaders("GET", "/x", "")
    expect(empty["Content-MD5"]).toBeUndefined()
  })

  test("paths are escaped and trailing slashes dropped", () => {
    expect(_internal.escapedPath("/login/phone/sendMsgCode")).toBe("/login/phone/sendMsgCode")
    expect(_internal.escapedPath("a/b/")).toBe("/a/b")
    expect(_internal.escapedPath("/带中文/段")).toBe(`/${encodeURIComponent("带中文")}/${encodeURIComponent("段")}`)
  })
})

describe("helpers", () => {
  test("phone normalization", () => {
    expect(_internal.normalizePhone("13800138000")).toBe("13800138000")
    expect(_internal.normalizePhone("+86 138-0013-8000")).toBe("13800138000")
    expect(_internal.normalizePhone("8613800138000")).toBe("13800138000")
    expect(_internal.normalizePhone("12345")).toBeNull()
    expect(_internal.normalizePhone("12800138000")).toBeNull() // second digit not 3-9
  })

  test("rate suffix split", () => {
    expect(_internal.splitRateSuffix("DeepSeek V4 Flash 0731 (x3.0)")).toEqual({ name: "DeepSeek V4 Flash 0731", rate: "x3.0" })
    expect(_internal.splitRateSuffix("GLM 5.3 Flash(x0.8)")).toEqual({ name: "GLM 5.3 Flash", rate: "x0.8" })
    expect(_internal.splitRateSuffix("Spark X2.5 （x0.1）")).toEqual({ name: "Spark X2.5", rate: "x0.1" })
    expect(_internal.splitRateSuffix("限时免费")).toEqual({ name: "限时免费", rate: undefined })
    expect(_internal.splitRateSuffix("Model (free)")).toEqual({ name: "Model (free)", rate: undefined })
  })
})
