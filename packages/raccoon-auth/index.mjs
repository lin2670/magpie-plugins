// magpie-raccoon-auth — the 小浣熊 (Raccoon) provider plugin for magpie.
//
// Signs in with a Raccoon (商汤小浣熊, xiaohuanxiong.com) account, forwards
// chat completions to its OpenAI-compatible gateway, lists its models, reads
// its points balance, and presses its daily point grant (the desktop login
// credits). Every request shape is ported from aimod-cc/agent2api (MIT),
// providers/raccoon, rewritten for magpie's plugin API.

import { randomUUID } from "node:crypto"

// agent2apiAccounts reads the accounts agent2api (aimod-cc) keeps on this
// machine, to import a sign-in from it: nothing is written there. Returns
// null off the Bun host (no import to offer), [] when agent2api has no data,
// else the enabled rows that carry an accessToken.
async function agent2apiAccounts(providerId) {
  let Database
  try {
    ;({ Database } = await import("bun:sqlite"))
  } catch {
    return null // not on the Bun host: no import to offer
  }
  const os = await import("node:os")
  const path = await import("node:path")
  const fs = await import("node:fs")
  const dbPath = process.env.AGENT2API_DB || path.join(os.homedir(), ".agent2api", "agent2api.db")
  if (!fs.existsSync(dbPath)) return []
  let db
  try {
    db = new Database(dbPath, { readonly: true })
    const rows = db.query("SELECT data FROM accounts WHERE provider = ? AND enabled = 1").all(providerId)
    return rows.map((r) => JSON.parse(r.data)).filter((a) => a?.accessToken)
  } catch {
    return []
  } finally {
    try {
      db?.close()
    } catch {}
  }
}

const ID = "raccoon"
const NAME = "小浣熊 Raccoon"

// how long before its end an access token is renewed (agent2api's window)
const REFRESH_LEAD = 5 * 60_000

// the three sites, each overridable through the same env vars agent2api reads
const env = (name, fallback) => {
  const v = process.env[name]?.trim()
  return v ? v.replace(/\/+$/, "") : fallback
}
const llmBase = () => env("RACCOON_LLM_BASE_URL", "https://xiaohuanxiong.com/api/web/llm/v2")
const mainOrigin = () => env("RACCOON_MAIN_SITE_URL", "https://xiaohuanxiong.com")
const authBase = () => env("RACCOON_AUTH_API_BASE", `${mainOrigin()}/api/web/auth/v1`)

// ── small helpers ──────────────────────────────────────────────────────────

const stripBearer = (token) => String(token ?? "").replace(/^Bearer\s+/i, "").trim()

// a JWT's end, as magpie keeps it (ms); 0 when it carries no exp
function jwtEnd(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8"))
    return typeof payload?.exp === "number" ? payload.exp * 1000 : 0
  } catch {
    return 0
  }
}

const toInt = (v) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? Math.floor(n) : null
}

// the vendor's day runs on Beijing time (agent2api core::beijing)
const beijingToday = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
const beijingMidnight = () => Math.floor((Date.now() + 8 * 3600e3) / 86400e3) * 86400e3 + 86400e3 - 8 * 3600e3

class SignedOut extends Error {}
const expired = (message) => Object.assign(new Error(message), { signIn: "expired" })
const errorResponse = (status, message) =>
  new Response(JSON.stringify({ error: { message } }), { status, headers: { "content-type": "application/json" } })

async function bodyText(input, init) {
  const b = init.body ?? (input instanceof Request ? await input.clone().text() : undefined)
  return typeof b === "string" ? b : new TextDecoder().decode(b)
}

// one GET on the points domain, unwrapping {code, message, data} the way
// agent2api's request_json does (code != 0 is a failure; data null falls back
// to the payload itself)
async function getJSON(url, token, timeoutMs, extraHeaders) {
  const res = await fetch(url, {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}`, ...extraHeaders },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (res.status === 401) throw expired("小浣熊登录态已过期，请重新登录")
  if (!res.ok) throw new Error(`小浣熊接口返回 HTTP ${res.status}`)
  const payload = await res.json().catch(() => null)
  if (!payload || typeof payload !== "object") throw new Error("小浣熊接口返回了无法解析的内容")
  if (typeof payload.code === "number" && payload.code !== 0)
    throw new Error(String(payload.message || `小浣熊接口返回异常 code=${payload.code}`))
  return payload.data ?? payload
}

// one renewal of the token pair: POST {authBase}/refresh with the refresh
// token. The reply's data.access_token (any Bearer prefix stripped) is the
// new access token, and an empty data.refresh_token keeps the old one
// (agent2api call_refresh_api). A 429 starts a cooldown: the rate-limited
// refresh endpoint is left alone until it passes (agent2api cools the
// account; here a single shared flag is enough since renewals serialize).
let refreshCooldownUntil = 0
const REFRESH_COOLDOWN_MS = 10 * 60e3
async function renewToken(refreshToken) {
  if (!refreshToken) throw expired("小浣熊登录态已过期且没有 refreshToken，请重新登录")
  if (Date.now() < refreshCooldownUntil)
    throw new Error(`小浣熊刷新被限流，冷却中（${Math.ceil((refreshCooldownUntil - Date.now()) / 60e3)} 分钟后重试）`)
  const res = await fetch(`${authBase()}/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
    signal: AbortSignal.timeout(30_000),
  })
  if (res.status === 429) {
    refreshCooldownUntil = Date.now() + REFRESH_COOLDOWN_MS
    throw new Error("小浣熊刷新被限流（HTTP 429），10 分钟内不再尝试刷新")
  }
  const payload = await res.json().catch(() => null)
  if (res.status === 401) throw expired("小浣熊登录态已过期，请重新登录")
  if (!res.ok) throw new Error(`小浣熊刷新失败（HTTP ${res.status}）: ${payload?.message || "无错误说明"}`)
  const data = payload?.data
  const access = stripBearer(data?.access_token)
  if (!access) throw new Error(`小浣熊 token 刷新失败 code=${payload?.code ?? "null"} msg=${payload?.message ?? ""}`)
  return {
    access,
    refresh: String(data?.refresh_token ?? "").trim() || refreshToken,
    expires: jwtEnd(access) || Date.now() + 3600e3,
  }
}

// ── the web sign-in (the official /code/authorize page) ───────────────────
// The vendor's desktop login: open the authorize page, the user signs in,
// the official page redirects to `office-raccoon://auth/callback?code=…&state=…`
// (with the client installed that deep-link is handed to the OS; without it
// the address still shows the full callback URL). The plugin never sees the
// callback itself — the user pastes the whole office-raccoon:// URL back —
// so the state round-trip is the only proof this code came from a sign-in
// this plugin started; it is compared verbatim before any exchange
// (agent2api oauth.rs / parse_callback_code).

const AUTHORIZE_PATH = "/code/authorize"
const LOGIN_SOURCE = "desktop"
const APP_NAME = "办公小浣熊客户端"
const CODE_EXPIRED = 200035 // the authorization code has been spent

const newLoginState = () => crypto.randomUUID().replace(/-/g, "")

// parse the pasted callback URL (or a bare code) into its authorization code,
// checking scheme/host/path and the state verbatim
function parseCallback(raw, expectedState) {
  const text = String(raw ?? "").trim()
  if (!text) return { error: "请粘贴登录后跳转的 office-raccoon:// 回调地址" }
  // a bare code is accepted when the user copied just the code parameter
  if (!text.includes("://")) return { code: text }
  let url
  try {
    url = new URL(text)
  } catch {
    return { error: "回调地址无法解析，请完整复制地址栏里的 office-raccoon:// 链接" }
  }
  const ok =
    url.protocol === "office-raccoon:" &&
    url.hostname.toLowerCase() === "auth" &&
    url.pathname.replace(/\/+$/, "") === "/callback"
  if (!ok) return { error: "这不是小浣熊的登录回调地址（应为 office-raccoon://auth/callback?…）" }
  const code = (url.searchParams.get("code") ?? "").trim()
  const state = (url.searchParams.get("state") ?? "").trim()
  if (!code) return { error: "回调地址里没有授权码，请重新发起网页登录" }
  if (!state) return { error: "回调地址里没有 state，无法确认这次登录由本机发起，请重新发起网页登录" }
  if (state !== expectedState) return { error: "回调 state 校验失败，请重新发起网页登录" }
  return { code }
}

// trade the one-time code for a token pair
// (POST {authBase}/login_with_authorization_code; agent2api exchange_code —
// a spent/expired code answers code 200035 and must restart the sign-in)
async function exchangeWebCode(code) {
  const res = await fetch(`${authBase()}/login_with_authorization_code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ authorization_code: code }),
    signal: AbortSignal.timeout(30_000),
  })
  const payload = await res.json().catch(() => null)
  const data = payload && typeof payload.data === "object" && payload.data !== null ? payload.data : {}
  const access = stripBearer(data.access_token)
  const refresh = stripBearer(data.refresh_token)
  if (payload?.code === CODE_EXPIRED)
    throw new Error("授权码已失效（可能已被使用或放置太久），请重新发起网页登录")
  if (!res.ok || !access || !refresh)
    throw new Error(`网页登录换取凭证失败（HTTP ${res.status}）: ${payload?.message || payload?.msg || "无错误说明"}`)
  const extra = {}
  for (const key of ["office_identity", "office_org_name", "office_org_role"]) {
    const v = String(data[key] ?? "").trim()
    if (v) extra[key] = v
  }
  return { access, refresh, expires: jwtEnd(access) || Date.now() + 3600e3, ...extra }
}


// the vendor's /model_catalog: { code, data: { categories: [{ models }] } },
// each entry named by `name` (its model id); the first of a name wins
// (agent2api parse_catalog)
function parseCatalog(payload) {
  const data = payload && typeof payload.data === "object" && payload.data !== null ? payload.data : payload
  const categories = Array.isArray(data?.categories) ? data.categories : []
  const seen = new Set()
  const out = []
  for (const category of categories) {
    for (const entry of category?.models ?? []) {
      const id = String(entry?.name ?? entry?.model_name ?? "").trim()
      if (!id || seen.has(id)) continue
      seen.add(id)
      out.push(catalogModel(id, entry))
    }
  }
  return out
}

// one catalog entry as magpie lists a model (agent2api normalize_catalog_entry
// + listing_entry: display_name wins, else the codename in `description` when
// short enough; window sizes live at the top or in `params`; the catalog says
// nothing about thinking, so every model is listed as able to)
function catalogModel(id, entry) {
  const codename = String(entry?.description ?? "").trim()
  const display = String(entry?.display_name ?? "").trim()
  const name = display || (codename && codename.length <= 64 ? codename : id)
  const pick = (keys) => {
    for (const key of keys) {
      const top = toInt(entry?.[key])
      if (top != null) return top
      const nested = toInt(entry?.params?.[key])
      if (nested != null) return nested
    }
    return undefined
  }
  const context = pick(["context_window", "contextWindow"])
  const output = pick(["max_tokens", "maxTokens"])
  const tags = Array.isArray(entry?.tags) ? entry.tags.map(String) : []
  const image = ["vision", "image", "image-understanding"].some((t) => tags.includes(t))
  const mult = toInt(entry?.billing_multiplier ?? entry?.billing_effective_multiplier ?? entry?.credits)
  const rate = mult != null && mult > 0 ? `x${mult}` : undefined
  const limit = {}
  if (context != null) limit.context = context
  if (output != null) limit.output = output
  const config = { name, reasoning: true }
  if (Object.keys(limit).length) config.limit = limit
  if (image) config.modalities = { input: ["text", "image"], output: ["text"] }
  if (rate) config.rate = rate
  return { id, config }
}

// the static list the client ships (agent2api FALLBACK_MODELS), for before
// the catalog answers
const FALLBACK_MODELS = {
  "raccoon-8c4485": { name: "Raccoon-Work", limit: { context: 1_000_000, output: 100_000 }, modalities: { input: ["text", "image"], output: ["text"] }, rate: "x1" },
  "raccoon-19b265": { name: "Raccoon-Work-260817-A", limit: { context: 1_000_000, output: 100_000 }, rate: "x1" },
  "raccoon-405a1c": { name: "Raccoon-Work-260817-B", limit: { context: 1_000_000, output: 100_000 }, rate: "x1" },
  "raccoon-chat-ml-5-5": { name: "Raccoon Chat (默认)", reasoning: true, limit: { context: 180_000, output: 80_000 } },
  "sn-sensenova-6-8-flash-lite": { name: "SenseNova 6.8 Flash Lite", reasoning: true, limit: { context: 256_000, output: 63_999 }, rate: "x0.5" },
}

// ── the plugin ─────────────────────────────────────────────────────────────

export async function RaccoonAuthPlugin({ client } = {}) {
  // the model catalog's 10-minute cache (agent2api's refresh cadence), per
  // plugin instance so tests and multiple accounts don't share entries
  const CATALOG_TTL_MS = 10 * 60e3
  let catalogCache = null
  let catalogCacheUntil = 0
  // a refresh token is spent once: renewals serialize, and what a renewal
  // gave is remembered by the token it spent, so a caller holding an older
  // snapshot follows it instead of spending the token again
  let lock = Promise.resolve()
  const locked = (fn) => {
    const run = lock.then(fn, fn)
    lock = run.catch(() => {})
    return run
  }
  const given = new Map()
  const renewOf = async (a) => {
    if (given.has(a.refresh)) return given.get(a.refresh)
    const got = await renewToken(a.refresh)
    if (given.size > 32) given.delete(given.keys().next().value)
    given.set(a.refresh, got)
    return got
  }

  // fresh is the account with a live access token, renewed near its end and
  // saved back
  const fresh = (getAuth) =>
    locked(async () => {
      const a = await getAuth()
      if (a?.type !== "oauth" || !a.access) throw new SignedOut("小浣熊：未登录")
      if (a.expires && a.expires - Date.now() > REFRESH_LEAD) return a
      const next = { ...a, ...(await renewOf(a)) }
      await client.auth.set({ path: { id: ID }, body: next })
      return next
    })

  // ask forwards one chat completion as the client wrote it: the body passes
  // through untouched (agent2api build_chat_request)
  const ask = (access, raw, signal) =>
    fetch(`${llmBase()}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "*/*", Authorization: `Bearer ${access}` },
      body: raw,
      signal,
    })

  // the vendor's gateway writes its own model name into every reply; each is
  // rewritten to the name the client asked by (agent2api
  // pipeSseWithModelRewrite)
  const rewriteModel = (res, model) => {
    const type = res.headers.get("content-type") ?? ""
    if (!res.body) return res
    if (!/event-stream/i.test(type)) {
      return res.text().then((text) => {
        try {
          const answer = JSON.parse(text)
          if (answer && typeof answer === "object" && "model" in answer) answer.model = model
          return new Response(JSON.stringify(answer), { status: res.status, headers: { "content-type": type || "application/json" } })
        } catch {
          return new Response(text, { status: res.status, headers: { "content-type": type } })
        }
      })
    }
    const decoder = new TextDecoder()
    const encoder = new TextEncoder()
    let buffered = ""
    const line = (text) => {
      if (!text.startsWith("data:")) return text
      const data = text.slice(5).trim()
      if (!data || data === "[DONE]") return text
      try {
        const frame = JSON.parse(data)
        if (frame && typeof frame === "object" && "model" in frame) {
          frame.model = model
          return "data: " + JSON.stringify(frame)
        }
      } catch {}
      return text
    }
    const stream = new ReadableStream({
      async start(controller) {
        const reader = res.body.getReader()
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buffered += decoder.decode(value, { stream: true })
            const lines = buffered.split("\n")
            buffered = lines.pop() ?? ""
            for (const l of lines) controller.enqueue(encoder.encode(line(l) + "\n"))
          }
          if (buffered) controller.enqueue(encoder.encode(line(buffered)))
        } catch (e) {
          controller.error(e)
          return
        }
        controller.close()
      },
    })
    return new Response(stream, { status: res.status, headers: { "content-type": "text/event-stream" } })
  }

  // the daily point grant: the desktop client's settings page triggers it
  // (idempotent for the day), and the bills say whether today's arrived
  // (agent2api claim_daily_grant)
  const checkin = async (getAuth) => {
    const a = await fresh(getAuth)
    const token = stripBearer(a.access)
    let triggerError = null
    try {
      await getJSON(`${mainOrigin()}/api/web/office/v3/setting_info`, token, 20_000, {
        "X-Client-Platform": "desktop-windows",
        "X-Client-Version": "v1.0.0",
        "X-Raccoon-Language": "zh",
      })
    } catch (e) {
      if (e?.signIn === "expired") throw e
      triggerError = e?.message ?? String(e)
    }
    let bills = null
    let billsError = null
    try {
      bills = await getJSON(`${mainOrigin()}/api/web/points/v1/bills?paging.limit=20&paging.offset=0`, token, 25_000)
    } catch (e) {
      if (e?.signIn === "expired") throw e
      billsError = e?.message ?? String(e)
    }
    const today = beijingToday()
    const granted = (Array.isArray(bills?.items) ? bills.items : [])
      .map((item) => ({ points: toInt(item?.points), at: String(item?.created_at ?? "") }))
      .filter((g) => g.points != null && g.points > 0 && g.at.slice(0, 10) === today)
      .reduce((sum, g) => sum + g.points, 0)
    if (granted > 0) return { outcome: "claimed", credit: granted, message: `今日积分 +${granted}` }
    if (triggerError) return { outcome: "failed", message: `签到触发失败：${triggerError}` }
    if (billsError) return { outcome: "failed", message: `未能核对今日入账：${billsError}` }
    return { outcome: "done", message: "今日未见积分入账（可能已领取）" }
  }

  const importable = await agent2apiAccounts(ID)
  const methods = []
  if (importable && importable.length) {
    methods.push({
      type: "oauth",
      label:
        importable.length === 1
          ? `从 agent2api 导入 ${importable[0].name || "账号"}（Import from agent2api）`
          : "从 agent2api 导入账号（Import from agent2api）",
      ...(importable.length > 1
        ? {
            prompts: [
              {
                type: "select",
                key: "which",
                message: "导入哪个账号？",
                options: importable.map((a) => ({ label: `${a.name ?? a.userId ?? a.id}（${a.userId ?? a.id}）`, value: a.id })),
              },
            ],
          }
        : {}),
      authorize: (inputs) => ({
        url: "",
        instructions: "读取本机 agent2api 的小浣熊登录态（只读，不写回）。",
        method: "auto",
        callback: async () => {
          const acct = importable.length === 1 ? importable[0] : importable.find((a) => a.id === inputs?.which)
          if (!acct) return { type: "failed", error: "没有匹配的 agent2api 账号" }
          return {
            type: "success",
            access: stripBearer(acct.accessToken),
            refresh: String(acct.refreshToken ?? "").trim(),
            expires: toInt(acct.expiresAt) ?? jwtEnd(acct.accessToken),
            accountId: acct.name || acct.userId || acct.id,
            userId: acct.userId,
            name: acct.name,
            source: "agent2api",
          }
        },
      }),
    })
  }
  methods.push({
    type: "oauth",
    label: "网页登录（小浣熊官方授权页，Web sign-in）",
    authorize: async () => {
      const state = newLoginState()
      const authorizeUrl = `${mainOrigin()}${AUTHORIZE_PATH}?login_source=${LOGIN_SOURCE}&appname=${encodeURIComponent(APP_NAME)}&state=${state}`
      return {
        url: authorizeUrl,
        instructions:
          "浏览器打开上面的授权页并登录小浣熊。登录成功后页面会跳转 office-raccoon://auth/callback?code=…&state=…——" +
          "装了小浣熊客户端时会提示打开客户端（取消即可），回调地址始终留在浏览器地址栏。把整条 office-raccoon:// 地址复制粘贴到下一步的输入框里。",
        method: "code",
        callback: async (pasted) => {
          const { code, error } = parseCallback(pasted, state)
          if (error) return { type: "failed", error }
          try {
            const { access, refresh, expires, ...office } = await exchangeWebCode(code)
            return { type: "success", access, refresh, expires, source: "web", ...office }
          } catch (e) {
            return { type: "failed", error: String(e?.message ?? e) }
          }
        },
      }
    },
  })
  methods.push({
    type: "oauth",
    label: "手动粘贴 token（Paste tokens）",
    prompts: [
      { type: "text", key: "access", message: "accessToken（eyJ… 的 JWT）", validate: (v) => (v && v.trim() ? undefined : "必填") },
      { type: "text", key: "refresh", message: "refreshToken（可留空；留空则无法自动续期）" },
    ],
    authorize: async (inputs) => {
      const access = stripBearer(String(inputs?.access ?? ""))
      if (!access) return { type: "failed", error: "accessToken 必填" }
      return { type: "success", access, refresh: String(inputs?.refresh ?? "").trim(), expires: jwtEnd(access), source: "manual" }
    },
  })

  return {
    auth: {
      provider: ID,
      refreshLead: REFRESH_LEAD,
      async refresh(auth) {
        if (auth?.type !== "oauth" || !auth.refresh) return undefined
        return locked(() => renewOf(auth))
      },
      async loader(getAuth) {
        const a = await getAuth()
        if (a?.type !== "oauth") return {}
        return {
          baseURL: llmBase(),
          apiKey: "raccoon",
          async fetch(input, init = {}) {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
            if (!/\/chat\/completions$/.test(new URL(url).pathname))
              return errorResponse(404, "only chat completions are served")
            const raw = await bodyText(input, init)
            let chat
            try {
              chat = JSON.parse(raw)
            } catch {
              return errorResponse(400, "a request that isn't JSON")
            }
            let cred
            try {
              cred = await fresh(getAuth)
            } catch (e) {
              return errorResponse(e instanceof SignedOut || e?.signIn === "expired" ? 401 : 502, String(e?.message ?? e))
            }
            let res
            try {
              res = await ask(stripBearer(cred.access), raw, init.signal)
            } catch (e) {
              return errorResponse(502, e?.message ?? String(e))
            }
            // a 401 on a time-wise fresh token: renewed once, whatever it
            // was, and asked again (agent2api refresh_access_token's force)
            if (res.status === 401) {
              try {
                cred = await locked(async () => {
                  const cur = await getAuth()
                  const next = { ...cur, ...(await renewOf(cur)) }
                  await client.auth.set({ path: { id: ID }, body: next })
                  return next
                })
                res = await ask(stripBearer(cred.access), raw, init.signal)
              } catch (e) {
                return errorResponse(e instanceof SignedOut || e?.signIn === "expired" ? 401 : 502, String(e?.message ?? e))
              }
            }
            if (!res.ok)
              return errorResponse(res.status, `小浣熊上游返回 ${res.status}: ${(await res.text().catch(() => "")).slice(0, 4096) || "无错误说明"}`)
            return rewriteModel(res, chat.model)
          },
        }
      },
      async usage(getAuth) {
        try {
          const a = await fresh(getAuth)
          const token = stripBearer(a.access)
          const [points, entitlement] = await Promise.all([
            getJSON(`${mainOrigin()}/api/web/points/v1/balance`, token, 20_000),
            getJSON(`${mainOrigin()}/api/web/auth/v1/entitlement_info`, token, 20_000).catch(() => null),
          ])
          const daily = toInt(points?.daily_points)
          const available = toInt(points?.available_points)
          const office = entitlement?.office ?? entitlement?.code
          const windows = []
          if (daily != null && daily >= 0)
            windows.push({ name: "每日积分", used: 0, amount: daily, limit: daily, unit: "credits", resetsAt: beijingMidnight(), span: 86400 })
          if (available != null) windows.push({ name: "可用积分", used: 0, display: `${available} credits`, aside: true })
          return {
            plan: office?.active_plan?.type || (office?.pro_enable ? "Pro" : NAME),
            user: a.name || a.accountId,
            windows,
            signIn: "kept",
          }
        } catch (e) {
          return { error: String(e?.message ?? e), signIn: e?.signIn === "expired" ? "expired" : "kept" }
        }
      },
      checkin,
      methods,
    },
    async config(config) {
      config.provider ??= {}
      const was = config.provider[ID] ?? {}
      config.provider[ID] = {
        name: NAME,
        npm: "@ai-sdk/openai-compatible",
        api: llmBase(),
        ...was,
        models: { ...FALLBACK_MODELS, ...(was.models ?? {}) },
      }
    },
    provider: {
      id: ID,
      async models(p, { auth } = {}) {
        if (auth?.type !== "oauth" || !auth.access) return p.models
        // the catalog has a 10-minute TTL (agent2api's refresh cadence):
        // a serve from cache instead of re-pulling on every models() call
        if (catalogCache && Date.now() < catalogCacheUntil) {
          for (const m of catalogCache) {
            if (!(m.id in p.models)) p.models[m.id] = m.config
            else p.models[m.id] = { ...p.models[m.id], ...m.config }
          }
          return p.models
        }
        try {
          const res = await fetch(`${llmBase()}/model_catalog`, {
            headers: { Accept: "application/json", Authorization: `Bearer ${stripBearer(auth.access)}` },
            signal: AbortSignal.timeout(10_000),
          })
          if (!res.ok) return p.models
          const payload = await res.json().catch(() => null)
          if (!payload || (typeof payload.code === "number" && payload.code !== 0)) return p.models
          const list = parseCatalog(payload)
          if (!list.length) return p.models
          catalogCache = list
          catalogCacheUntil = Date.now() + CATALOG_TTL_MS
          // register new models into the provider's table too, so the gateway
          // sees them: magpie filters pp.Models (the static/config table) by
          // the account's list, so a model only in the dynamic return but not
          // in the table is invisible at /v1/models (fake/index.js does this)
          for (const m of list) {
            if (!(m.id in p.models)) p.models[m.id] = m.config
            else p.models[m.id] = { ...p.models[m.id], ...m.config }
          }
          return p.models
        } catch {
          return p.models
        }
      },
    },
  }
}

// for tests
export const _internal = {
  ID,
  NAME,
  REFRESH_LEAD,
  FALLBACK_MODELS,
  parseCatalog,
  catalogModel,
  renewToken,
  agent2apiAccounts,
  parseCallback,
  exchangeWebCode,
  jwtEnd,
  stripBearer,
  toInt,
  beijingToday,
  beijingMidnight,
}
