import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CatPawAuthPlugin, _internal } from "./index.mjs"
import { fakeCatPaw } from "./fake.mjs"

// every test runs against the fake upstream in fake.mjs: no network, no real
// token ever leaves this process. The upstream base is monkey-patched because
// CatPaw's is a module constant (the origin is fixed by the vendor).

let fake
let plugin
let saved = {}
let tmpDir
const client = { auth: { set: async ({ body }) => (saved = body) } }
const getAuth = async () => saved

beforeAll(async () => {
  fake = fakeCatPaw()
  tmpDir = mkdtempSync(join(tmpdir(), "catpaw-auth-test-"))
  // point the desktop auth path at a fake auth.json
  const authPath = join(tmpDir, "auth.json")
  writeFileSync(authPath, JSON.stringify({ auth: { accessToken: fake.state.token }, account: { uid: "u1", name: "Tester" } }))
  process.env.CATPAW_AUTH_PATH = authPath
  // the credit balance is a separate host in the vendor; point it at the fake
  process.env.CATPAW_BALANCE_URL = `${fake.url}/api/gateway/credit/balance`
  // replace the origin with the fake server
  // the plugin reads ORIGIN at call time only inside gatewayHeaders/fetch, so
  // monkey-patching the global fetch to route to the fake works: we swap the
  // global fetch for one that rewrites the URL host to the fake server
  const realFetch = globalThis.fetch
  globalThis.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const patched = url.replace("https://ai.catpaw.meituan.com", fake.url)
    return realFetch(patched, init)
  }
  plugin = await CatPawAuthPlugin({ client })
})

afterAll(() => {
  fake.server.stop(true)
  rmSync(tmpDir, { recursive: true, force: true })
})

beforeEach(() => {
  fake.state.reset()
  saved = { type: "oauth", access: fake.state.token, expires: 0, source: "desktop", accountId: "Tester" }
})

describe("config", () => {
  test("lists the desktop client's models", async () => {
    const cfg = {}
    await plugin.config(cfg)
    expect(cfg.provider.catpaw.name).toBe("妙手 CatPaw")
    const ids = Object.keys(cfg.provider.catpaw.models)
    expect(ids).toContain("longcat-2.0")
    expect(ids).toContain("kimi-k3")
    expect(ids).toContain("glm-5.3-flash")
    expect(cfg.provider.catpaw.models["longcat-2.0"].modalities).toEqual({ input: ["text", "image"], output: ["text"] })
  })
})

describe("sign-in methods", () => {
  test("reads the desktop client's auth.json live", async () => {
    const method = plugin.auth.methods.find((m) => m.label.includes("桌面端"))
    expect(method).toBeTruthy()
    const flow = method.authorize()
    expect(flow.method).toBe("auto")
    const result = await flow.callback()
    expect(result.type).toBe("success")
    expect(result.access).toBe(fake.state.token)
    expect(result.source).toBe("desktop")
    expect(result.uid).toBe("u1")
  })

  test("manual paste works", async () => {
    const method = plugin.auth.methods.find((m) => m.label.includes("Paste"))
    const result = await method.authorize({ token: "pasted-token" })
    expect(result.type).toBe("success")
    expect(result.access).toBe("pasted-token")
    expect(await method.authorize({ token: "" })).toMatchObject({ type: "failed" })
  })
})

describe("chat", () => {
  test("round → event → turn, cumulative frames diffed to deltas", async () => {
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch("https://ai.catpaw.meituan.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "longcat-2.0", stream: true, messages: [{ role: "user", content: "hi" }] }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    // the deltas build up the answer
    expect(text).toContain('"content":"你"')
    expect(text).toContain('"content":"好"')
    expect(text).toContain('"content":"，"')
    expect(text).toContain('"content":"收到"')
    // reasoning is diffed too
    expect(text).toContain('"reasoning_content":"思"')
    expect(text).toContain('"reasoning_content":"考"')
    // the stream ends with stop + [DONE]
    expect(text).toContain('"finish_reason":"stop"')
    expect(text).toContain("data: [DONE]")
    // the conversation machine ran all three steps in order
    expect(fake.state.rounds).toBe(1)
    expect(fake.state.events).toBe(1)
    expect(fake.state.turns).toBe(1)
    expect(fake.state.conversations[0].prompt).toBe("hi")
    expect(fake.state.conversations[0].modelType).toBe(77)
  })

  test("non-stream returns the full answer", async () => {
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch("https://ai.catpaw.meituan.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "kimi-k3", stream: false, messages: [{ role: "user", content: "hi" }] }),
    })
    const answer = await res.json()
    expect(answer.model).toBe("kimi-k3")
    expect(answer.choices[0].message.content).toBe("你好，收到")
    expect(answer.choices[0].message.reasoning_content).toBe("思考")
    expect(answer.choices[0].finish_reason).toBe("stop")
    expect(fake.state.conversations[0].modelType).toBe(83)
  })

  test("multi-turn messages flatten into one prompt", async () => {
    const loader = await plugin.auth.loader(getAuth)
    await loader.fetch("https://ai.catpaw.meituan.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "longcat-2.0",
        stream: false,
        messages: [
          { role: "system", content: "be terse" },
          { role: "user", content: "q1" },
          { role: "assistant", content: "a1" },
          { role: "user", content: "q2" },
        ],
      }),
    })
    expect(fake.state.conversations[0].prompt).toContain("[System Instructions]\nbe terse")
    expect(fake.state.conversations[0].prompt).toContain("[User]\nq1")
    expect(fake.state.conversations[0].prompt).toContain("[Assistant]\na1")
    expect(fake.state.conversations[0].prompt).toContain("[User]\nq2")
  })

  test("a single user message passes as-is", async () => {
    const loader = await plugin.auth.loader(getAuth)
    await loader.fetch("https://ai.catpaw.meituan.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "auto", stream: false, messages: [{ role: "user", content: "just this" }] }),
    })
    expect(fake.state.conversations[0].prompt).toBe("just this")
    expect(fake.state.conversations[0].modelType).toBe(0)
  })

  test("an SSE error frame surfaces as an error chunk", async () => {
    fake.state.turnError = "sse-error"
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch("https://ai.catpaw.meituan.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "longcat-2.0", stream: true, messages: [{ role: "user", content: "hi" }] }),
    })
    const text = await res.text()
    expect(text).toContain('"error"')
    expect(text).toContain("vendor broke")
  })

  test("unknown model is rejected", async () => {
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch("https://ai.catpaw.meituan.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "not-a-model", stream: false, messages: [{ role: "user", content: "hi" }] }),
    })
    expect(res.status).toBe(400)
  })

  test("a refused token says 401", async () => {
    saved = { type: "oauth", access: "gone", expires: 0, source: "manual" }
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch("https://ai.catpaw.meituan.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "longcat-2.0", stream: false, messages: [{ role: "user", content: "hi" }] }),
    })
    expect(res.status).toBe(401)
    const answer = await res.json().catch(() => null)
    expect(answer?.error?.message ?? "").toMatch(/round 失败/)
  })

  test("only chat completions are served", async () => {
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch("https://ai.catpaw.meituan.com/v1/embeddings", { method: "POST", body: "{}" })
    expect(res.status).toBe(404)
  })
})

describe("usage", () => {
  // the credit endpoint takes `X-Auth-Token`, not the conversation gateway's
  // `Cookie: X-Passport-Token`: sending the cookie there answers 401 / code
  // 4010, which magpie reads as the sign-in having expired
  test("reads the credit balance with X-Auth-Token", async () => {
    const usage = await plugin.auth.usage(getAuth)
    // a clean read says nothing about the sign-in: that absence is what lets
    // magpie clear a lapse (a "kept" here would leave the mark on forever)
    expect(usage.signIn).toBeUndefined()
    expect(usage.windows[0].display).toBe("1134.67 credit")
    expect(usage.plan).toBe("体验版")
    expect(fake.state.balanceCalls).toBe(1)
  })

  test("a refused token says the sign-in expired", async () => {
    saved = { type: "oauth", access: "not-the-token", expires: 0, source: "manual" }
    const usage = await plugin.auth.usage(getAuth)
    expect(usage.signIn).toBe("expired")
    expect(usage.error).toContain("重新登录")
  })

  test("a missing desktop file is not the sign-in expiring", async () => {
    const was = process.env.CATPAW_AUTH_PATH
    process.env.CATPAW_AUTH_PATH = join(tmpDir, "absent.json")
    try {
      const usage = await plugin.auth.usage(getAuth)
      expect(usage.signIn).toBe("kept")
      expect(usage.error).toContain("未找到妙手登录态文件")
    } finally {
      process.env.CATPAW_AUTH_PATH = was
    }
  })
})

describe("helpers", () => {
  test("model type mapping", () => {
    expect(_internal.modelTypeOf("longcat-2.0")).toBe(77)
    expect(_internal.modelTypeOf("kimi-k3")).toBe(83)
    expect(_internal.modelTypeOf("unknown")).toBe(77)
  })
})
