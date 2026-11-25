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
let usageSeq = 0
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
  // the user-info fallback host: a closed loopback port, so a failed login
  // event never reaches the real vendor in a test
  process.env.AUTOCLAW_USERINFO_ALT_BASE_URL = "http://127.0.0.1:1"
})

afterAll(() => {
  fake.server.stop(true)
  rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.AUTOCLAW_USERINFO_ALT_BASE_URL
})

beforeEach(async () => {
  fake.state.reset()
  saved = { type: "oauth", access: fake.state.access, refresh: fake.state.refresh, deviceId: fake.state.deviceId, expires: Date.now() + 3600e3, accountId: "138****8000", name: "138****8000", source: "agent2api" }
  plugin = await AutoClawAuthPlugin({ client })
  // never touch the real ~/.config/magpie: every test gets its own state file
  _internal.setUsageStatePath(join(tmpDir, `usage-${++usageSeq}.json`))
  _internal.campaignCache.clear()
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

  test("a 403 quota refusal becomes a 429 with the sign-in kept", async () => {
    fake.state.chatRefusal = "quota"
    const res = await call({ model: "glm-5.3", stream: false, messages: [] })
    expect(res.status).toBe(429)
    expect(res.headers.get("x-magpie-sign-in")).toBe("kept")
    const body = await res.json()
    expect(body.error.message).toContain("额度已用完")
    expect(body.error.type).toBe("rate_limit_error")
  })

  test("a 403 banned account stays a 403 with the sign-in kept", async () => {
    fake.state.chatRefusal = "banned"
    const res = await call({ model: "glm-5.3", stream: false, messages: [] })
    expect(res.status).toBe(403)
    expect(res.headers.get("x-magpie-sign-in")).toBe("kept")
    const body = await res.json()
    expect(body.error.message).toContain("banned")
    expect(body.error.type).toBe("permission_error")
  })

  test("a plain 401 is still an expired sign-in", async () => {
    fake.state.proxyStatus = 401
    const res = await call({ model: "glm-5.3", stream: false, messages: [] })
    expect(res.status).toBe(401)
    expect(res.headers.get("x-magpie-sign-in")).toBe("expired")
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
  // the two daily tasks, in press order
  const pressed = () => fake.state.taskCalls.map((c) => c.task_id)

  test("user-info runs first, then both daily tasks, and the message has no miss note", async () => {
    const result = await plugin.auth.checkin(getAuth)
    expect(result.outcome).toBe("claimed")
    expect(result.credit).toBe(400)
    expect(result.message).toContain("签到成功，获得 200 积分")
    expect(result.message).toContain("灵感中心已领取 200 积分")
    expect(result.message).not.toContain("活动奖励未触发")

    // the official desktop fingerprint reached the fake
    expect(fake.state.userInfoCalls.length).toBe(1)
    expect(fake.state.userInfoCalls[0]).toMatchObject({ source_id: "autoclaw", device_id: fake.state.deviceId })
    const h = fake.state.lastUserInfoHeaders
    expect(h["user-agent"]).toBe("AutoClaw/2.2.0 (win-x64)")
    expect(h["x-version"]).toBe("2.2.0")
    expect(h["x-tm"]).toBe("win-x64")
    expect(h["x-channel"]).toBe("AutoClaw20")
    expect(h["x-product"]).toBe("autoclaw")
    expect(h["x-lang"]).toBe("zh-CN")
    expect(h["authorization"]).toBe(`Bearer ${fake.state.access}`)
    expect(h["x-auth-sign"]).toBe(
      createHash("md5").update(`100003&${h["x-auth-timestamp"]}&38d2391985e2369a5fb8227d8e6cd5e5`).digest("hex"),
    )

    expect(pressed()).toEqual(["daily_signin", "daily_inspiration_center"])
    expect(fake.state.taskListCalls).toBe(1)
  })

  test("a second press the same day is 'done' for both", async () => {
    await plugin.auth.checkin(getAuth)
    const again = await plugin.auth.checkin(getAuth)
    expect(again.outcome).toBe("done")
    expect(again.credit).toBe(0)
    expect(again.message).toContain("已签到")
    expect(again.message).toContain("灵感中心")
    // the task list reports both completed: neither task is pressed again
    expect(pressed()).toEqual(["daily_signin", "daily_inspiration_center"])
  })

  test("user-info failure is reported but never blocks the check-in", async () => {
    fake.state.userInfoCode = 500_001
    const result = await plugin.auth.checkin(getAuth)
    expect(result.outcome).toBe("claimed")
    expect(result.credit).toBe(400)
    expect(result.message).toContain("签到成功，获得 200 积分")
    expect(result.message.endsWith("活动奖励未触发（登录未上报）")).toBe(true)
  })

  test("a completed daily_signin in the task list is skipped, the inspiration center is still pressed", async () => {
    fake.state.signinDone = true
    const result = await plugin.auth.checkin(getAuth)
    expect(result.outcome).toBe("claimed")
    expect(result.credit).toBe(200)
    expect(pressed()).toEqual(["daily_inspiration_center"])
    expect(result.message).toContain("今天已签到")
    expect(result.message).toContain("灵感中心已领取 200 积分")
  })

  test("an empty task list is 'inactive' with nothing pressed", async () => {
    fake.state.taskListMode = "empty"
    const result = await plugin.auth.checkin(getAuth)
    expect(result.outcome).toBe("inactive")
    expect(result.message).toBe("当前没有签到活动")
    expect(pressed()).toEqual([])
  })

  test("an unanswered task list falls back to pressing both tasks", async () => {
    fake.state.taskListMode = "error"
    const result = await plugin.auth.checkin(getAuth)
    expect(result.outcome).toBe("claimed")
    expect(result.credit).toBe(400)
    expect(pressed()).toEqual(["daily_signin", "daily_inspiration_center"])
  })

  test("a 403 quota on the task list throws {quota, signIn:kept} without renewing", async () => {
    fake.state.taskListMode = "quota"
    await expect(plugin.auth.checkin(getAuth)).rejects.toMatchObject({ quota: true, signIn: "kept" })
    expect(fake.state.refreshCalls.length).toBe(0)
    expect(pressed()).toEqual([])
  })

  test("a 403 ban on the task list throws {banned, signIn:kept} without renewing", async () => {
    fake.state.taskListMode = "banned"
    await expect(plugin.auth.checkin(getAuth)).rejects.toMatchObject({ banned: true, signIn: "kept" })
    expect(fake.state.refreshCalls.length).toBe(0)
    expect(pressed()).toEqual([])
  })

  test("a failing inspiration task does not block the sign-in credit", async () => {
    fake.state.inspirationError = 400_001
    const result = await plugin.auth.checkin(getAuth)
    expect(result.outcome).toBe("claimed")
    expect(result.credit).toBe(200)
    expect(result.message).toContain("签到成功，获得 200 积分")
    // the upstream's own reason is passed through, not guessed
    expect(result.message).toContain("灵感中心任务暂不可用")
    // the second task was still pressed
    expect(pressed()).toEqual(["daily_signin", "daily_inspiration_center"])
  })

  test("a failing sign-in task does not block the inspiration credit", async () => {
    fake.state.signinError = 500_001
    const result = await plugin.auth.checkin(getAuth)
    expect(result.outcome).toBe("claimed")
    expect(result.credit).toBe(200)
    expect(result.message).toContain("签到失败")
    expect(result.message).toContain("灵感中心已领取 200 积分")
  })

  test("both tasks failing is 'failed'", async () => {
    fake.state.signinError = 500_001
    fake.state.inspirationError = 400_001
    const result = await plugin.auth.checkin(getAuth)
    expect(result.outcome).toBe("failed")
    expect(result.credit).toBe(0)
    expect(result.message).toContain("签到失败")
    expect(result.message).toContain("灵感中心任务暂不可用")
  })

  test("an auth business code on the second task ends the check-in as expired", async () => {
    fake.state.inspirationError = 410_000
    await expect(plugin.auth.checkin(getAuth)).rejects.toThrow(/失效/)
    // the expired press stops there: nothing more is attempted
    expect(pressed()).toEqual(["daily_signin", "daily_inspiration_center"])
  })

  test("an expired sign-in says so", async () => {
    // a spent refresh token: the near-expiry renewal is what fails
    saved = { type: "oauth", access: "stale", refresh: "wrong", expires: Date.now() + 1_000 }
    await expect(plugin.auth.checkin(getAuth)).rejects.toThrow(/失效/)
  })
})

describe("checkin activity reward", () => {
  const pressed = () => fake.state.taskCalls.map((c) => c.task_id)
  // the vendor's ledger timestamp shape (+08:00), so the Beijing day is clear
  const beijingIso = (ms = Date.now()) => new Date(ms + 8 * 3600e3).toISOString().replace(/\.\d+Z$/, "+08:00")
  const activityEntry = (over = {}, md = {}) => ({
    wallet_id: "w-login",
    wallet_scope: "campaign",
    mutation_type: "credit",
    amount: 10000,
    occurred_at: beijingIso(),
    metadata: {
      event_type: "autoclaw_user_active",
      activity_id: "autoclaw_user_active_reward_202611",
      description: "每周限时激励",
      ...md,
    },
    ...over,
  })

  test("a payout already in today's ledger skips user-info and is reported", async () => {
    fake.state.campaignEntries = [activityEntry()]
    const result = await plugin.auth.checkin(getAuth)
    // the login event is not fired: the desktop client already paid it
    expect(fake.state.userInfoCalls.length).toBe(0)
    expect(fake.state.lastUserInfoHeaders).toBeNull()
    expect(result.outcome).toBe("claimed")
    expect(result.credit).toBe(400) // the activity payout never counts as credit
    expect(result.message).toContain("活动奖励已到账 +10,000（每周限时激励）")
    expect(result.message).not.toContain("活动奖励未触发")
    // both tasks still run
    expect(pressed()).toEqual(["daily_signin", "daily_inspiration_center"])
  })

  test("no payout yet: user-info pays it, the read-back reports it and the cache drops", async () => {
    fake.state.creditOnUserInfo = { amount: 10000, description: "每周限时激励" }
    // prime the display cache with the (still empty) ledger
    await plugin.auth.usage(getAuth)
    expect(fake.state.ledgerCalls).toBe(1)
    const result = await plugin.auth.checkin(getAuth)
    expect(fake.state.userInfoCalls.length).toBe(1)
    expect(result.outcome).toBe("claimed")
    expect(result.credit).toBe(400)
    expect(result.message).toContain("活动奖励已到账 +10,000（每周限时激励）")
    // live read before the trigger + one read-back after it
    expect(fake.state.ledgerCalls).toBe(3)
    // the login event may have just paid: the display cache is dropped
    await plugin.auth.usage(getAuth)
    expect(fake.state.ledgerCalls).toBe(4)
  })

  test("no payout and a failed login event: the miss note is appended, tasks unaffected", async () => {
    fake.state.userInfoCode = 500_001
    const result = await plugin.auth.checkin(getAuth)
    expect(result.outcome).toBe("claimed")
    expect(result.credit).toBe(400)
    expect(result.message).toContain("签到成功，获得 200 积分")
    expect(result.message.endsWith("活动奖励未触发（登录未上报）")).toBe(true)
    expect(pressed()).toEqual(["daily_signin", "daily_inspiration_center"])
    // no read-back after a failed trigger
    expect(fake.state.ledgerCalls).toBe(1)
  })

  test("a failed ledger read leaves the message clean and the check-in intact", async () => {
    fake.state.ledgerStatus = 500
    const result = await plugin.auth.checkin(getAuth)
    expect(result.outcome).toBe("claimed")
    expect(result.credit).toBe(400)
    // the login event is still attempted, the tasks still run
    expect(fake.state.userInfoCalls.length).toBe(1)
    expect(pressed()).toEqual(["daily_signin", "daily_inspiration_center"])
    // unknown is not 「未触发」: the activity segment is absent entirely
    expect(result.message).not.toContain("活动奖励")
  })

  test("two activities pay out: labels collapse to a count and the amounts sum", async () => {
    fake.state.campaignEntries = [
      activityEntry({ wallet_id: "w-a", amount: 10000 }, { description: "每周限时激励" }),
      activityEntry({ wallet_id: "w-b", amount: 500 }, { description: "新手 Day 1/7" }),
    ]
    const result = await plugin.auth.checkin(getAuth)
    expect(fake.state.userInfoCalls.length).toBe(0)
    expect(result.message).toContain("活动奖励已到账 +10,500（2 个活动）")
    expect(result.credit).toBe(400)
  })
})

describe("todayActivityReward", () => {
  const now = Date.parse("2026-11-25T04:00:00Z") // Beijing 2026-11-25 12:00
  const row = (over = {}, md = {}) => ({
    wallet_scope: "campaign",
    mutation_type: "credit",
    amount: 500,
    occurred_at: "2026-11-25T11:52:16.804+08:00",
    metadata: { event_type: "autoclaw_user_active", description: "每周限时激励", ...md },
    ...over,
  })

  test("only today's matching campaign credits are counted", () => {
    const entries = [
      row(),
      // the same activity, but yesterday's Beijing day
      row({ occurred_at: "2026-11-24T23:59:59+08:00" }),
      // another family: the check-in task itself is not a login payout
      row({}, { event_type: "autoclaw_checkin_daily" }),
      // not a credit
      row({ mutation_type: "debit" }),
      // not the campaign wallet (the server may ignore the filter)
      row({ wallet_scope: "daily" }),
      // no readable timestamp: conservatively skipped
      row({ occurred_at: null }),
    ]
    expect(_internal.todayActivityReward(entries, now)).toEqual({ amount: 500, labels: ["每周限时激励"], count: 1 })
    expect(_internal.todayActivityReward([], now)).toBeNull()
    expect(_internal.todayActivityReward(null, now)).toBeNull()
  })

  test("activity_id is the fallback without event_type, and the signup-day family counts", () => {
    const entries = [
      row(
        { amount: 20000 },
        { event_type: undefined, activity_id: "autoclaw_user_active_bonus_20261125", description: "一次性大礼包" },
      ),
      row(
        { amount: 10000 },
        { event_type: "autoclaw_user_signup_day_2", activity_id: "autoclaw_new_user_day_1_to_7_bonus", description: "新手 Day 2/7" },
      ),
      // no event_type and an unknown activity_id: not a payout
      row({ amount: 5000 }, { event_type: undefined, activity_id: "autoclaw_checkin_daily_202611" }),
    ]
    const reward = _internal.todayActivityReward(entries, now)
    expect(reward.amount).toBe(30000)
    expect(reward.count).toBe(2)
    expect(reward.labels.length).toBe(2)
  })

  test("a payout with no description still counts, without a label", () => {
    expect(_internal.todayActivityReward([row({}, { description: "" })], now)).toEqual({ amount: 500, labels: [], count: 1 })
  })

  test("labels are de-duplicated, truncated to 40 chars and stripped of the credit suffix", () => {
    const description = `${"超长活动名".repeat(12)} +12,345 credits`
    const reward = _internal.todayActivityReward([row({}, { description }), row({}, { description })], now)
    expect(reward.labels.length).toBe(1)
    expect(reward.labels[0].length).toBe(40)
    expect(reward.labels[0]).not.toContain("credits")
  })
})

describe("usage", () => {
  const webWindow = (usage) => usage.windows.find((w) => w.name === "网页版快捷登录")
  const balanceWindow = (usage) => usage.windows.find((w) => w.name === "积分余额")
  const campaignWindow = (usage) => usage.windows.find((w) => w.name === "活动积分")

  test("windows are ordered check-in → balance → campaign → web, with a wallet breakdown", async () => {
    const usage = await plugin.auth.usage(getAuth)
    expect(usage.signIn).toBe("kept")
    expect(usage.windows.map((w) => w.name)).toEqual(["每日签到", "积分余额", "网页版快捷登录"])
    expect(usage.windows[0].display).toBe("今日未签（+200）")
    const balance = balanceWindow(usage)
    expect(balance.balance).toBe(12700)
    expect(balance.unit).toBe("积分")
    // a pure balance reads `balance`, never `used`
    expect(balance.used).toBeUndefined()
    expect(usage.balance).toBe("12,700 积分（赠送积分 200 · 通用积分 12,500）")
    // the hidden wallet (display:false) contributes nothing
    expect(usage.balance).not.toContain("999")
    expect(fake.state.walletCalls).toBe(1)
  })

  test("the web entry carries the access token and only whitelisted fields", async () => {
    const usage = await plugin.auth.usage(getAuth)
    const web = webWindow(usage)
    expect(web.aside).toBe(true)
    expect(web.used).toBeUndefined()
    expect(web.display).toBe(`https://autoglm.zhipuai.cn/?autoglm_token=${encodeURIComponent(fake.state.access)}`)
    // host.js drops unknown window fields: nothing invented
    expect(Object.keys(web).sort()).toEqual(["aside", "display", "name"])
  })

  test("a near-expiry token renews first, and the link carries the renewed one", async () => {
    saved = { type: "oauth", access: "stale-token", refresh: fake.state.refresh, deviceId: fake.state.deviceId, expires: Date.now() + 30_000 }
    const usage = await plugin.auth.usage(getAuth)
    expect(fake.state.refreshCalls.length).toBe(1)
    expect(saved.access).toBe(fake.state.access)
    const web = webWindow(usage)
    expect(web.display).toContain(`autoglm_token=${encodeURIComponent(fake.state.access)}`)
    expect(web.display).not.toContain("stale-token")
  })

  test("AUTOCLAW_WEB_BASE_URL overrides the web host", async () => {
    process.env.AUTOCLAW_WEB_BASE_URL = "https://web.example.test/"
    try {
      const usage = await plugin.auth.usage(getAuth)
      expect(webWindow(usage).display.startsWith("https://web.example.test/?autoglm_token=")).toBe(true)
    } finally {
      delete process.env.AUTOCLAW_WEB_BASE_URL
    }
  })

  test("the campaign ledger reconciles per wallet instance and filters non-campaign rows", async () => {
    const now = Math.floor(Date.now() / 1000)
    fake.state.campaignEntries = [
      { wallet_id: "w1", wallet_scope: "campaign", mutation_type: "credit", amount: 5000, wallet_expires_at: now + 3 * 86400, metadata: { description: "AutoClaw 用户登录奖励 +5000 credits" } },
      { wallet_id: "w1", wallet_scope: "campaign", mutation_type: "debit", amount: 1000, wallet_expires_at: now + 3 * 86400 },
      // an instance whose credit row fell out of the window: 0 left, expiry still counts
      { wallet_id: "w2", wallet_scope: "campaign", mutation_type: "expire", amount: 7711, wallet_expires_at: now - 86400 },
      // the server ignores the scope filter: a non-campaign row must be dropped
      { wallet_id: "w3", wallet_scope: "daily", mutation_type: "credit", amount: 9999, metadata: { description: "非活动" } },
    ]
    const usage = await plugin.auth.usage(getAuth)
    expect(usage.windows.map((w) => w.name)).toEqual(["每日签到", "积分余额", "活动积分", "网页版快捷登录"])
    const campaign = campaignWindow(usage)
    expect(campaign.display).toBe("剩 4,000（AutoClaw 用户登录奖励） · 已领 5,000 · 过期 7,711（近期）")
    // never a second balance-bearing window
    expect(campaign.balance).toBeUndefined()
    expect(Object.keys(campaign).sort()).toEqual(["aside", "display", "name", "used"])
    // the soonest lapse is marked on the balance window, capped at the total
    const balance = balanceWindow(usage)
    expect(balance.runsOutAt).toBe(new Date((now + 3 * 86400) * 1000).toISOString())
    expect(balance.runsOut).toBe(4000)
    expect(fake.state.ledgerCalls).toBe(1)
  })

  test("an empty ledger adds no activity row", async () => {
    fake.state.campaignEntries = []
    const usage = await plugin.auth.usage(getAuth)
    expect(campaignWindow(usage)).toBeUndefined()
    expect(balanceWindow(usage).balance).toBe(12700)
  })

  test("a failing ledger omits the row without caching the failure", async () => {
    fake.state.ledgerStatus = 500
    const first = await plugin.auth.usage(getAuth)
    expect(campaignWindow(first)).toBeUndefined()
    expect(balanceWindow(first).balance).toBe(12700)
    expect(fake.state.ledgerCalls).toBe(1)
    // not cached: the next usage retries at once
    await plugin.auth.usage(getAuth)
    expect(fake.state.ledgerCalls).toBe(2)
    // once it answers, the row appears
    fake.state.ledgerStatus = 0
    const now = Math.floor(Date.now() / 1000)
    fake.state.campaignEntries = [
      { wallet_id: "w1", wallet_scope: "campaign", mutation_type: "credit", amount: 5000, wallet_expires_at: now + 86400, metadata: { description: "AutoClaw 用户登录奖励" } },
    ]
    const third = await plugin.auth.usage(getAuth)
    expect(campaignWindow(third).display).toContain("剩 5,000")
    expect(fake.state.ledgerCalls).toBe(3)
  })

  test("a successful ledger read is cached for 10 minutes and user-info clears it", async () => {
    const now = Math.floor(Date.now() / 1000)
    fake.state.campaignEntries = [
      { wallet_id: "w1", wallet_scope: "campaign", mutation_type: "credit", amount: 5000, wallet_expires_at: now + 86400, metadata: { description: "AutoClaw 用户登录奖励" } },
    ]
    await plugin.auth.usage(getAuth)
    await plugin.auth.usage(getAuth)
    expect(fake.state.ledgerCalls).toBe(1)
    // a successful login event may have just paid a reward: the cache goes
    // (the check-in's own reads are live: pre-payout + read-back)
    await plugin.auth.checkin(getAuth)
    expect(fake.state.ledgerCalls).toBe(3)
    await plugin.auth.usage(getAuth)
    expect(fake.state.ledgerCalls).toBe(4)
  })

  test("an invalid total_balance is an error, never recorded as 0", async () => {
    fake.state.walletTotal = null
    const usage = await plugin.auth.usage(getAuth)
    expect(usage).toEqual({ error: "积分响应异常", windows: [] })
  })

  test("this round's spend: nothing on the first read, a new round on a rise, spent on a fall", async () => {
    const first = await plugin.auth.usage(getAuth)
    expect(first.windows.map((w) => w.name)).not.toContain("本轮消耗")

    fake.state.walletTotal = 13000
    const risen = await plugin.auth.usage(getAuth)
    // any rise starts a new round: peak = total, used = 0
    expect(risen.windows.map((w) => w.name)).not.toContain("本轮消耗")

    fake.state.walletTotal = 12000
    const spent = await plugin.auth.usage(getAuth)
    const row = spent.windows.find((w) => w.name === "本轮消耗")
    expect(row).toBeTruthy()
    expect(row.used).toBe(7.7) // 1000 / 13000
    expect(row.amount).toBe(1000)
    expect(row.limit).toBe(13000)
    expect(row.aside).toBe(true)
    expect(row.display).toBe("1,000 / 13,000 积分 · 今日 -1,000 · 今日 +300")
    expect(Object.keys(row).sort()).toEqual(["amount", "aside", "display", "limit", "name", "used"])
    // the balance window still carries the live total
    expect(balanceWindow(spent).balance).toBe(12000)
  })

  test("a failing usage keeps {error, signIn} and adds no window", async () => {
    saved = { type: "oauth", access: "gone", refresh: "wrong", expires: Date.now() + 3600e3 }
    const usage = await plugin.auth.usage(getAuth)
    expect(usage.error).toBeTruthy()
    expect(usage.signIn).toBe("expired")
    expect(usage.windows).toBeUndefined()
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

  test("the web entry URL is the web host plus an encoded token", () => {
    expect(_internal.webBase()).toBe("https://autoglm.zhipuai.cn")
    expect(_internal.webEntryUrl("a+b/c=")).toBe(`https://autoglm.zhipuai.cn/?autoglm_token=${encodeURIComponent("a+b/c=")}`)
    // a pasted "Bearer " prefix never reaches the link
    expect(_internal.webEntryUrl("Bearer tok")).toBe("https://autoglm.zhipuai.cn/?autoglm_token=tok")
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

  test("fmtPoints groups thousands without a locale", () => {
    expect(_internal.fmtPoints(0)).toBe("0")
    expect(_internal.fmtPoints(200)).toBe("200")
    expect(_internal.fmtPoints(4000)).toBe("4,000")
    expect(_internal.fmtPoints(12700)).toBe("12,700")
    expect(_internal.fmtPoints(1234567)).toBe("1,234,567")
  })

  test("campaign labels drop the trailing credit amount", () => {
    expect(_internal.campaignLabel({}, { description: "AutoClaw 用户登录奖励 +5000 credits" })).toBe("AutoClaw 用户登录奖励")
    expect(_internal.campaignLabel({}, { description: "AutoClaw Weekly Perks +4,000 积分" })).toBe("AutoClaw Weekly Perks")
    expect(_internal.campaignLabel({ description: "纯活动名" }, {})).toBe("纯活动名")
  })

  test("campaign breakdown counts a window-out instance as 0 and its expiry as expired", () => {
    const now = 1_000_000
    const camp = _internal.campaignBreakdown(
      [
        { wallet_id: "a", wallet_scope: "campaign", mutation_type: "credit", amount: 5000, wallet_expires_at: now / 1000 + 100, metadata: { description: "活动 A +5000 credits" } },
        { wallet_id: "a", wallet_scope: "campaign", mutation_type: "debit", amount: 1000 },
        { wallet_id: "b", wallet_scope: "campaign", mutation_type: "expire", amount: 700 },
        { wallet_id: "c", wallet_scope: "monthly", mutation_type: "credit", amount: 9000 },
        { wallet_id: "d", wallet_scope: "campaign", mutation_type: "hold", amount: 50 },
      ],
      now,
    )
    expect(camp).toEqual({ claimed: 5000, expired: 700, remaining: 4000, labels: ["活动 A"], lapseAt: (now / 1000 + 100) * 1000, lapsing: 4000 })
    expect(_internal.campaignBreakdown([])).toBeNull()
  })

  test("the device id prefers the stored one, then the access/refresh JWT claims", () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const access = fake.jwt(exp, "u", "dev-access")
    const refresh = fake.jwt(exp, "u", "dev-refresh")
    expect(_internal.accountDeviceId({ deviceId: "stored" }, access, refresh)).toBe("stored")
    expect(_internal.accountDeviceId({}, access, refresh)).toBe("dev-access")
    expect(_internal.accountDeviceId({}, "", refresh)).toBe("dev-refresh")
    expect(_internal.accountDeviceId({}, "", "")).toBe("")
  })

  test("the Beijing day boundary rolls over at 16:00Z", () => {
    expect(_internal.beijingDayOf(new Date("2026-01-01T15:59:00Z"))).toBe("2026-01-01")
    expect(_internal.beijingDayOf(new Date("2026-01-01T16:30:00Z"))).toBe("2026-01-02")
  })

  test("the state key prefers the uid, else the token hash", () => {
    expect(_internal.accountKey("autoclaw", { uid: "20260001" })).toBe("autoclaw|uid:20260001")
    expect(_internal.accountKey("autoclaw", { userId: "20260001" })).toBe("autoclaw|uid:20260001")
    const key = _internal.accountKey("autoclaw", { refresh: "refresh-1" })
    expect(key).toMatch(/^autoclaw\|tok:[0-9a-f]{16}$/)
    expect(key).toBe(_internal.accountKey("autoclaw", { access: "refresh-1" }))
  })

  test("the default state path lives under XDG or the home config dir", () => {
    const prevXdg = process.env.XDG_CONFIG_HOME
    const prevFile = process.env.AUTOCLAW_USAGE_STATE_FILE
    const prevHome = process.env.HOME
    const prevProfile = process.env.USERPROFILE
    delete process.env.AUTOCLAW_USAGE_STATE_FILE
    process.env.XDG_CONFIG_HOME = "C:/tmp/xdg"
    try {
      expect(_internal.usageStatePathDefault()).toBe("C:/tmp/xdg/magpie/autoclaw-usage.json")
      delete process.env.XDG_CONFIG_HOME
      process.env.HOME = ""
      process.env.USERPROFILE = "C:/Users/example"
      expect(_internal.usageStatePathDefault()).toBe("C:/Users/example/.config/magpie/autoclaw-usage.json")
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = prevXdg
      if (prevFile === undefined) delete process.env.AUTOCLAW_USAGE_STATE_FILE
      else process.env.AUTOCLAW_USAGE_STATE_FILE = prevFile
      if (prevHome === undefined) delete process.env.HOME
      else process.env.HOME = prevHome
      if (prevProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = prevProfile
    }
  })

  test("setUsageStatePath keeps reads and writes inside the temp dir", async () => {
    _internal.setUsageStatePath(join(tmpDir, "isolated.json"))
    _internal.balanceObserve(`autoclaw|uid:isolated-${usageSeq}`, 1000)
    expect(_internal.usageStatePath()).toBe(join(tmpDir, "isolated.json"))
  })
})
