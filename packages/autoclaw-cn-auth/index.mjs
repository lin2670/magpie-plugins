// magpie-autoclaw-cn-auth — the AutoClaw 国内版 (智谱 autoglm) provider
// plugin for magpie.
//
// Signs in with an AutoClaw account (domestic phone + SMS code, an agent2api
// import, or pasted tokens), forwards chat completions to its zhipuai
// acceleration proxy, lists its models, reads its point wallets, and presses
// the daily sign-in (the 「每日签到」 banner's task). Request shapes are ported
// from aimod-cc/agent2api (MIT), providers/autoclaw, rewritten for magpie's
// plugin API.
//
// Two things about this vendor are load-bearing and easy to get wrong:
//   1. the account domain (login / refresh / points / check-in / model
//      catalog) signs every request with a client fingerprint
//      (`X-Auth-Sign = md5(appId&ts&appKey)`, appId/appKey baked into the
//      client), while the LLM proxy uses `X-Authorization` instead of
//      `Authorization`;
//   2. the upstream gates the LLM proxy on the request's *shape*: `X-Harness-Type:
//      zcode` is refused there (403/406) though the account domain tolerates
//      it, `max_tokens` below 10000 is pre-refused (406), and the first system
//      message must open with the OpenClaw identity line (see the system
//      normalizer below).

import { createHash, randomBytes, randomUUID } from "node:crypto"

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

const ID = "autoclaw"
const NAME = "AutoClaw 国内版"

// renew the token this long before its end (agent2api's proactive margin)
const REFRESH_LEAD = 5 * 60_000

// the two sites, each overridable through the same env vars agent2api reads.
// The LLM proxy base *includes* the trailing `/autoclaw`; the catalog hangs
// off the same host one level up (`.../proxy/autoclaw-model-config`).
const env = (name, fallback) => {
  const v = process.env[name]?.trim()
  return v ? v.replace(/\/+$/, "") : fallback
}
const CN_HOST = "https://autoglm-acceleration-api.zhipuai.cn"
const userapiBase = () => env("AUTOCLAW_USERAPI_BASE_URL", CN_HOST)
const upstreamBase = () => env("AUTOCLAW_UPSTREAM_BASE_URL", `${CN_HOST}/autoclaw-proxy/proxy/autoclaw`)

// the config base: the desktop client slices the proxy base at its last
// `/proxy/` and re-appends it, dropping the tail `/autoclaw` (agent2api
// catalog::config_base_url)
function configBase() {
  const base = upstreamBase()
  const at = base.lastIndexOf("/proxy/")
  return at < 0 ? `${base}/` : base.slice(0, at + "/proxy/".length)
}

// the client fingerprint the account domain signs with (appId/appKey are
// baked into the AutoClaw client, not user secrets)
const AUTH_APP_ID = "100003"
const AUTH_APP_KEY = "38d2391985e2369a5fb8227d8e6cd5e5"
// `X-Version` on account-domain requests: the upstream version-gates the model
// catalog on it (a stale value silently shrinks the list)
const CLIENT_VERSION = "1.18.5"
// `X-Version` on the LLM proxy (the desktop app version the client reports)
const DESKTOP_APP_VERSION = "1.17.8"
const CLIENT_LANG = "zh-CN"
const CLIENT_CHANNEL = "official"
const platformTm = () => (process.platform === "darwin" ? "mac" : "win")

// login business codes (agent2api login.rs describe_login_error)
const AUTH_EXPIRED_CODES = new Set([410_000, 400_000])
const REFRESH_FALLBACK_CODE = 400_002

const REQUEST_TIMEOUT = 20_000
const LLM_TIMEOUT = 900_000

// the daily sign-in is a task in the client's generic task system
const DAILY_SIGNIN_TASK_ID = "daily_signin"
const TASK_COMPLETE_PATH = "/autoclaw-proxy/proxy/autoclaw-task-complete"
const TASK_LIST_PATH = "/autoclaw-proxy/proxy/autoclaw-task-list"

// ── small helpers ──────────────────────────────────────────────────────────

const stripBearer = (token) => String(token ?? "").replace(/^Bearer\s+/i, "").trim()

const toNum = (v) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

// a JWT's end in ms (0 when it carries none)
function jwtEnd(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8"))
    return typeof payload?.exp === "number" ? payload.exp * 1000 : 0
  } catch {
    return 0
  }
}

// a device id: 32 random bytes as 64 hex chars. The client derives it from an
// ed25519 key's hash, but the server only treats it as an opaque string; it is
// *required* by send-code / login / refresh, so a real one is generated.
const newDeviceId = () => randomBytes(32).toString("hex")

class SignedOut extends Error {}
const expired = (message) => Object.assign(new Error(message), { signIn: "expired" })
const errorResponse = (status, message) =>
  new Response(JSON.stringify({ error: { message } }), { status, headers: { "content-type": "application/json" } })

async function bodyText(input, init) {
  const b = init.body ?? (input instanceof Request ? await input.clone().text() : undefined)
  return typeof b === "string" ? b : new TextDecoder().decode(b)
}

// ── the account domain's signed requests ───────────────────────────────────
//
// `X-Auth-Sign = md5("{appId}&{seconds}&{appKey}")`, lowercase hex. The account
// domain keeps `X-Harness-Type: zcode` (measured 200 there); only the LLM proxy
// must drop it.
function userapiHeaders(token) {
  const timestamp = String(Math.max(0, Math.floor(Date.now() / 1000)))
  const sign = createHash("md5").update(`${AUTH_APP_ID}&${timestamp}&${AUTH_APP_KEY}`).digest("hex")
  const headers = {
    "Content-Type": "application/json",
    Accept: "*/*",
    "X-Version": CLIENT_VERSION,
    "X-Product": "autoclaw",
    "X-Client-Type": "pc",
    "X-Harness-Type": "zcode",
    "X-Tm": platformTm(),
    "X-Lang": CLIENT_LANG,
    "X-Channel": CLIENT_CHANNEL,
    "X-Auth-Appid": AUTH_APP_ID,
    "X-Auth-TimeStamp": timestamp,
    "X-Auth-Sign": sign,
    "X-Trace-Id": randomUUID(),
  }
  if (token) headers.authorization = `Bearer ${stripBearer(token)}`
  return headers
}

// the LLM proxy's headers: the client's brand headers + `X-Authorization`
// (not `Authorization`), and **no** `X-Harness-Type`.
function proxyHeaders(token, routeId) {
  return {
    "Content-Type": "application/json",
    Accept: "*/*",
    "X-Product": "autoclaw",
    "X-Client-Type": "pc",
    "X-Tm": platformTm(),
    "X-Version": DESKTOP_APP_VERSION,
    "X-Lang": CLIENT_LANG,
    "X-Channel": CLIENT_CHANNEL,
    x_trace_id: "autoclaw-desktop",
    "X-Authorization": `Bearer ${stripBearer(token)}`,
    "X-Request-Id": randomUUID(),
    "X-Request-Model": routeId,
  }
}

// one signed request on the account domain (login / refresh / points /
// check-in / catalog). Returns the parsed payload; throws on a transport or
// HTTP-level failure.
async function userapiRequest(method, path, { token = "", body, timeoutMs = REQUEST_TIMEOUT } = {}) {
  const init = { method, headers: userapiHeaders(token), signal: AbortSignal.timeout(timeoutMs) }
  if (body !== undefined) init.body = JSON.stringify(body)
  let res
  try {
    res = await fetch(`${userapiBase()}${path}`, init)
  } catch (e) {
    throw new Error(`AutoClaw 请求失败：${e?.message ?? e}`)
  }
  if (res.status === 401) throw expired("AutoClaw 登录态已失效，请重新登录")
  const payload = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`AutoClaw 接口返回 HTTP ${res.status}${payload?.msg ? `：${payload.msg}` : ""}`)
  if (!payload || typeof payload !== "object") throw new Error("AutoClaw 接口返回了无法解析的内容")
  return payload
}

// the account-domain payload's business code as a number (or null)
const codeOf = (payload) => {
  const n = payload?.code
  if (typeof n === "number") return n
  if (typeof n === "string" && n.trim() !== "" && Number.isFinite(Number(n))) return Number(n)
  return null
}

// ── token renewal ──────────────────────────────────────────────────────────
//
// POST {userapi}/userapi/v1/refresh with the signed headers and
// `{refresh_token, source_id:"autoclaw", device_id?}`. A `400002` (bad
// signature) degrades to `/userapi/v1/agent-refresh` and is retried once.
// The reply's `data.access_token` is the new token; `data.refresh_token`
// replaces the old when non-empty.
async function renewTokens(a) {
  const access = stripBearer(a?.access)
  const refresh = String(a?.refresh ?? "").trim()
  if (!refresh) throw expired("AutoClaw 登录态没有 refreshToken，无法续期（请重新登录）")
  const body = { refresh_token: refresh, source_id: "autoclaw" }
  if (a?.deviceId) body.device_id = a.deviceId
  let payload = await userapiRequest("POST", "/userapi/v1/refresh", { token: access, body })
  if (codeOf(payload) === REFRESH_FALLBACK_CODE) {
    payload = await userapiRequest("POST", "/userapi/v1/agent-refresh", { token: access, body })
  }
  const code = codeOf(payload)
  const data = payload?.data ?? {}
  const nextAccess = stripBearer(data.access_token)
  if (code !== 0 || !nextAccess) {
    const unauthorized = code === 401 || code === 410_000
    const reason = String(payload?.msg ?? payload?.message ?? "服务器未返回新 token")
    throw unauthorized
      ? expired(`AutoClaw 登录态已失效，请重新登录（${reason}）`)
      : new Error(`AutoClaw token 刷新失败 code=${code ?? "null"} msg=${reason}`)
  }
  return {
    access: nextAccess,
    refresh: stripBearer(data.refresh_token) || refresh,
    expires: jwtEnd(nextAccess) || toNum(a?.expires) || 0,
  }
}

// ── login (domestic: phone + SMS code) ─────────────────────────────────────

// the client's normalizePhone: 11-digit mainland numbers, tolerating +86/86
// and spaces/hyphens
function normalizePhone(raw) {
  const trimmed = String(raw ?? "").replace(/[\s-]/g, "")
  let digits = trimmed.replace(/^\+86/, "")
  if (digits.length === 13 && digits.startsWith("86")) digits = digits.slice(2)
  return /^1[2-9]\d{9}$/.test(digits) ? digits : null
}

// the code must be a JSON *number*: a string gets `400001 参数错误`, nothing to
// do with a wrong code (agent2api hit this)
const normalizeCode = (raw) => {
  const t = String(raw ?? "").trim()
  return /^\d{6}$/.test(t) ? Number(t) : null
}

const maskPhone = (phone) => {
  const s = String(phone ?? "")
  return s.length < 11 ? s : `${s.slice(0, 3)}****${s.slice(-4)}`
}

// upstream business code → a message that says what to do (the raw texts are
// misleading: 400001 is "参数错误", 631002 means a risk check was demanded)
function describeLoginError(code, upstreamMsg) {
  switch (code) {
    case 400_001:
      return "请求参数有误，请检查手机号与验证码格式后重试"
    case 630_202:
      return "验证码不正确，请检查后重试"
    case 630_101:
      return "获取验证码过于频繁，请稍后再试"
    case 410_000:
    case 400_000:
      return "登录态已失效，请重新登录"
    case 400_002:
      return "请求签名校验失败（本机时钟可能有偏差），请校准系统时间后重试"
    case 631_002:
      return "上游要求过风控验证，本次登录无法在此完成；请改用「填写凭证」（可从 AutoClaw 客户端登录态里取）"
    case 630_014:
      return "风控验证未通过，请稍后重试；若持续失败请改用「填写凭证」"
    default:
      return upstreamMsg?.trim() ? `登录失败：${upstreamMsg.trim()}` : `登录失败（上游 code=${code}）`
  }
}

async function sendCode(phone) {
  const deviceId = newDeviceId()
  const payload = await userapiRequest("POST", "/userapi/v1/agent-send-code", {
    body: { phone, source_id: "autoclaw", device_id: deviceId },
  })
  const code = codeOf(payload) ?? 0
  if (code !== 0) throw new Error(describeLoginError(code, payload?.msg))
  if (payload?.data?.result !== true) throw new Error("验证码发送失败，请稍后重试")
  return deviceId
}

async function loginWithCode(phone, code, deviceId) {
  const payload = await userapiRequest("POST", "/userapi/v1/agent-login/", {
    body: {
      phone,
      code: normalizeCode(code),
      platform: "web",
      source_id: "autoclaw",
      device_id: deviceId || newDeviceId(),
    },
  })
  const status = codeOf(payload) ?? 0
  if (status !== 0) throw new Error(describeLoginError(status, payload?.msg))
  const data = payload?.data ?? {}
  const access = stripBearer(data.access_token)
  if (!access) throw new Error("登录成功但上游没有返回 access_token")
  return { access, refresh: stripBearer(data.refresh_token), phone }
}

// ── model routing ──────────────────────────────────────────────────────────
//
// The proxy locates a model by *two* identifiers: `X-Request-Model` carries the
// full route id (its prefix picks the billing channel: `zai_` = pay-as-you-go,
// `zaicoding_` = Coding Plan, `zai_auto` = server-picked), and `body.model`
// carries the id with that prefix stripped.
const DEFAULT_ROUTE = "zai_auto"
const KNOWN_ROUTE_PREFIXES = ["zaicoding_", "zai_"]

// the client's shipped list (agent2api MODELS), for before the catalog answers
const STATIC_MODELS = [
  { id: "glm-5.3", name: "GLM-5.3", routeId: "zaicoding_glm-5.3", reasoning: true, image: false, context: 1_048_576, output: 307_200 },
  { id: "glm-5.3-flash", name: "GLM-5.3-Flash", routeId: "zai_glm-5.3-flash", reasoning: true, image: true, context: 1_048_576, output: 131_072 },
]

const stripRoutePrefix = (routeId) => {
  for (const prefix of KNOWN_ROUTE_PREFIXES) if (routeId.startsWith(prefix)) return routeId.slice(prefix.length)
  return routeId
}

// the client's ROUTE_ID_PATTERN: `[a-z][a-z0-9]*_` then 1..127 route chars
function isRouteId(value) {
  if (typeof value !== "string" || !value) return false
  const at = value.indexOf("_")
  if (at <= 0) return false
  if (!/^[a-z][a-z0-9]*$/.test(value.slice(0, at))) return false
  const tail = value.slice(at + 1)
  return tail.length > 0 && tail.length <= 127 && /^[A-Za-z0-9._:-]+$/.test(tail)
}

const sameName = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase()

// resolve a requested model name to its route (agent2api resolve_model_route,
// non-strict): catalog entry (static, then the remote one) → known prefix →
// route-id shape → the default route.
function resolveRoute(raw, remoteEntries) {
  const name = String(raw ?? "").trim().replace(/^autoclaw\//, "")
  const fallback = { routeId: DEFAULT_ROUTE, bodyModel: stripRoutePrefix(DEFAULT_ROUTE), requested: name || DEFAULT_ROUTE }
  if (!name) return fallback
  const catalog = [...STATIC_MODELS, ...(remoteEntries ?? [])]
  const hit = catalog.find((e) => sameName(e.id, name) || sameName(e.name, name) || sameName(e.routeId, name))
  if (hit) return { routeId: hit.routeId, bodyModel: stripRoutePrefix(hit.routeId), requested: name }
  for (const prefix of KNOWN_ROUTE_PREFIXES) {
    if (name.startsWith(prefix)) return { routeId: name, bodyModel: stripRoutePrefix(name), requested: name }
  }
  if (isRouteId(name)) return { routeId: name, bodyModel: stripRoutePrefix(name), requested: name }
  return { ...fallback, requested: name }
}

// ── the outbound body's shape gates ────────────────────────────────────────

// the proxy pre-refuses a small positive `max_tokens` (30..8192 → 406 with an
// empty body); >= 10000 passes, and an absent field passes. Only the small
// positive window is touched.
function normalizeMaxTokens(body) {
  const n = body?.max_tokens
  if (typeof n === "number" && Number.isInteger(n) && n > 0 && n < 10_000) body.max_tokens = 10_000
}

// the identity line the proxy requires the first system message to open with
const IDENTITY_LINE = "You are a personal assistant running inside OpenClaw."
const IDENTITY_PREFIX =
  "You are a personal assistant running inside OpenClaw.\n\n" +
  "## Tooling\n" +
  "Available tools are policy-filtered. Names are case-sensitive; call exactly as listed.\n"

// foreign harness identity lines the gate refuses, and their neutral rewrites
// (longest first within each family: a shorter rule would shred a longer match
// — the whole table is not in length order, each entry just must not be
// shadowed by a shorter one above it)
const FOREIGN_IDENTITIES = [
  ["You are ZCode, an interactive coding agent", "You are an interactive coding agent"],
  ["You are a coding agent running in the Codex CLI tool", "You are a coding agent running in a terminal CLI tool"],
  ["You are a coding agent running in the Codex CLI", "You are a coding agent running in a terminal CLI"],
  ["You are running as a coding agent in the Codex CLI", "You are running as a coding agent in a terminal CLI"],
  ["You are Claude Code", "You are a coding assistant"],
  ["You are ZCode", "You are an interactive coding agent"],
  ["You are an AI agent powered by DeepSeek Harness", "You are an AI agent powered by a local coding harness"],
  // pi (earendil-works) preamble, a 2026-10-15 upstream 406 fingerprint: the
  // gate matches the full sentence. The first rule drops the appositive tail
  // (", a coding agent harness") and keeps the rest verbatim; the second
  // covers the short form without that tail. Both tested through the real
  // upstream: pre-rewrite 406, post-rewrite 200.
  [
    "You are an expert coding assistant operating inside pi, a coding agent harness",
    "You are an expert coding assistant operating inside pi",
  ],
  ["You are an expert coding assistant operating inside pi", "You are an expert coding assistant"],
  ["You are Codex", "You are a coding agent"],
]

// find `from` in `text`, folding ASCII case only (index arithmetic stays on
// byte boundaries, so slicing is safe)
function findIgnoreAsciiCase(text, from) {
  const haystack = Buffer.from(text, "utf8")
  const needle = Buffer.from(from, "utf8")
  if (!needle.length || haystack.length < needle.length) return null
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let ok = true
    for (let j = 0; j < needle.length; j++) {
      let a = haystack[i + j]
      let b = needle[j]
      if (a >= 0x41 && a <= 0x5a) a += 0x20
      if (b >= 0x41 && b <= 0x5a) b += 0x20
      if (a !== b) {
        ok = false
        break
      }
    }
    if (ok) return i
  }
  return null
}

function replaceAllIgnoreAsciiCase(text, from, to) {
  if (findIgnoreAsciiCase(text, from) == null) return text
  let out = ""
  let rest = text
  for (;;) {
    const at = findIgnoreAsciiCase(rest, from)
    if (at == null) break
    out += rest.slice(0, at) + to
    rest = rest.slice(at + from.length)
  }
  return out + rest
}

const isSystemRole = (m) => m?.role === "system" || m?.role === "developer"

const joinPrefix = (original) =>
  original ? `${IDENTITY_PREFIX}\n${original}` : IDENTITY_PREFIX

// content is a string / an array of parts / anything else
function prependPrefix(message) {
  const content = message?.content
  if (typeof content === "string") {
    if (!content.startsWith(IDENTITY_LINE)) message.content = joinPrefix(content)
    return
  }
  if (Array.isArray(content)) {
    const index = content.findIndex((part) => typeof part?.text === "string")
    if (index < 0) {
      content.unshift({ type: "text", text: IDENTITY_PREFIX })
      return
    }
    if (!content[index].text.startsWith(IDENTITY_LINE)) content[index].text = joinPrefix(content[index].text)
    return
  }
  message.content = IDENTITY_PREFIX
}

// the proxy demands the first system message open with the identity line, and
// refuses foreign harness identity lines anywhere in system/developer content
function normalizeSystemPrompt(body) {
  const messages = body?.messages
  if (!Array.isArray(messages)) return
  for (const message of messages) {
    if (!isSystemRole(message)) continue
    const content = message.content
    if (typeof content === "string") message.content = rewriteIdentities(content)
    else if (Array.isArray(content))
      for (const part of content) if (typeof part?.text === "string") part.text = rewriteIdentities(part.text)
  }
  if (messages.length && isSystemRole(messages[0])) prependPrefix(messages[0])
  else messages.unshift({ role: "system", content: IDENTITY_PREFIX })
}

function rewriteIdentities(text) {
  for (const [from, to] of FOREIGN_IDENTITIES) text = replaceAllIgnoreAsciiCase(text, from, to)
  return text
}

// ── the model catalog ──────────────────────────────────────────────────────

// `GET {configBase}autoclaw-model-config` → `{models:[...]}` (no `{code,data}`
// envelope). Each entry's `id` is the *full* route id; the advertised id is
// that with the prefix stripped.
function catalogEntries(payload) {
  const raw = Array.isArray(payload?.models) ? payload.models : []
  const out = []
  for (const item of raw) {
    if (typeof item === "string") {
      const routeId = item.trim()
      if (!routeId) continue
      const id = stripRoutePrefix(routeId)
      out.push({ id, name: id.toUpperCase(), routeId })
      continue
    }
    const routeId = String(item?.id ?? "").trim()
    if (!routeId) continue
    const id = stripRoutePrefix(routeId)
    const name = String(item?.name ?? "").trim() || id.toUpperCase()
    const input = Array.isArray(item?.input) ? item.input : []
    out.push({
      id,
      name,
      routeId,
      image: input.includes("image"),
      reasoning: item?.reasoning === undefined ? true : item.reasoning === true,
      context: toNum(item?.contextWindow) ?? undefined,
      output: toNum(item?.maxTokens) ?? undefined,
      credits: typeof item?.creditConsumptionLevel === "string" ? item.creditConsumptionLevel.trim() : undefined,
    })
  }
  return out
}

// one catalog entry as magpie lists a model
function catalogModel(entry) {
  const config = { name: entry.name || entry.id }
  const limit = {}
  if (entry.context != null) limit.context = entry.context
  if (entry.output != null) limit.output = entry.output
  if (Object.keys(limit).length) config.limit = limit
  if (entry.reasoning) config.reasoning = true
  // the proxy is OpenAI-compatible and does take tools (agent2api states it)
  config.tool_call = true
  if (entry.image) config.modalities = { input: ["text", "image"], output: ["text"] }
  // creditConsumptionLevel is a word (低/中/高), not a number: pass it through
  if (entry.credits) config.rate = entry.credits
  return { id: entry.id, config }
}

// the static list magpie shows before (or without) the remote catalog
const FALLBACK_MODELS = Object.fromEntries(
  STATIC_MODELS.map((m) => [
    m.id,
    {
      name: m.name,
      reasoning: true,
      tool_call: true,
      limit: { context: m.context, output: m.output },
      ...(m.image ? { modalities: { input: ["text", "image"], output: ["text"] } } : {}),
    },
  ]),
)

// ── chat reply model rewrite ───────────────────────────────────────────────
//
// The proxy answers with its own route/internal name; each reply frame is
// rewritten to the name the client asked by (agent2api pipeSseWithModelRewrite).
function rewriteModel(res, model) {
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
  let buffered = ""
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

// ── the point wallets (usage) ──────────────────────────────────────────────

const WALLET_SCOPE_LABELS = {
  daily: "赠送积分",
  monthly: "订阅积分",
  long_term: "通用积分",
  annual: "通用积分",
  campaign: "活动积分",
}

const jsTruthy = (v) => {
  if (v == null) return false
  if (typeof v === "boolean") return v
  if (typeof v === "number") return v !== 0
  if (typeof v === "string") return v.length > 0
  if (Array.isArray(v)) return v.length > 0
  return true
}

// the v2 wallets payload → { total, wallets }
function normalizeWallets(payload) {
  const data = payload?.data ?? {}
  const list = Array.isArray(data.wallets) ? data.wallets : []
  const wallets = list
    .filter((w) => jsTruthy(w?.display))
    .map((w, index) => ({
      priority: toNum(w?.priority) ?? Number.MAX_SAFE_INTEGER,
      index,
      type: w?.public_wallet_type ?? null,
      displayName: String(w?.display_name ?? "").trim() || String(w?.public_wallet_type ?? "").trim() || "积分",
      balance: toNum(w?.balance),
    }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
  return { total: toNum(data.total_balance), wallets }
}

// the v1 wallet-instances fallback → the same shape
function normalizeLegacyWallets(payload) {
  const data = payload?.data ?? {}
  const instances = Array.isArray(data.wallet_instances) ? data.wallet_instances : []
  const merged = new Map()
  for (const it of instances) {
    if (String(it?.status ?? "").toLowerCase() !== "active" || !jsTruthy(it?.display)) continue
    const scope = String(it?.wallet_scope ?? "").toLowerCase().replace("wallet_scope_", "") || "other"
    merged.set(scope, (merged.get(scope) ?? 0) + (toNum(it?.balance) ?? 0))
  }
  const wallets = [...merged.entries()].map(([kind, balance]) => ({
    type: kind,
    displayName: WALLET_SCOPE_LABELS[kind] ?? "其他积分",
    balance,
  }))
  return { total: toNum(data.total_balance), wallets }
}

// ── the plugin ─────────────────────────────────────────────────────────────

export async function AutoClawAuthPlugin({ client } = {}) {
  // a refresh token is spent once: renewals serialize, and a renewal's result
  // is remembered by the token it spent so a stale snapshot follows it
  let lock = Promise.resolve()
  const locked = (fn) => {
    const run = lock.then(fn, fn)
    lock = run.catch(() => {})
    return run
  }
  const given = new Map()
  const renewOf = async (a) => {
    if (a?.refresh && given.has(a.refresh)) return given.get(a.refresh)
    const got = await renewTokens(a)
    if (a?.refresh) {
      if (given.size > 32) given.delete(given.keys().next().value)
      given.set(a.refresh, got)
    }
    return got
  }

  const save = (next) => client?.auth?.set({ path: { id: ID }, body: next })

  // fresh is the account with a live access token, renewed near its end
  const fresh = (getAuth) =>
    locked(async () => {
      const a = await getAuth()
      if (a?.type !== "oauth" || !a.access) throw new SignedOut("AutoClaw：未登录")
      if (a.expires && a.expires - Date.now() > REFRESH_LEAD) return a
      const next = { ...a, ...(await renewOf(a)) }
      await save(next)
      return next
    })

  // the model list's route ids, learned from the last catalog read (used to
  // resolve names the static table doesn't know, e.g. `auto-fast`)
  let remoteEntries = []

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
        instructions: "读取本机 agent2api 的 AutoClaw 登录态（只读，不写回）。",
        method: "auto",
        callback: async () => {
          const acct = importable.length === 1 ? importable[0] : importable.find((a) => a.id === inputs?.which)
          if (!acct) return { type: "failed", error: "没有匹配的 agent2api 账号" }
          return {
            type: "success",
            // `refresh` must be present for magpie to persist the sign-in
            refresh: String(acct.refreshToken ?? "").trim(),
            access: stripBearer(acct.accessToken),
            expires: toNum(acct.expiresAt) ?? jwtEnd(acct.accessToken),
            deviceId: String(acct.deviceId ?? "").trim(),
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
    label: "手机验证码登录（SMS sign-in）",
    prompts: [{ type: "text", key: "phone", message: "手机号（中国大陆 11 位）", validate: (v) => (normalizePhone(v) ? undefined : "请填写 11 位中国大陆手机号") }],
    authorize: async (inputs) => {
      const phone = normalizePhone(inputs?.phone)
      if (!phone) return { type: "failed", error: "请填写 11 位中国大陆手机号" }
      let deviceId
      try {
        deviceId = await sendCode(phone)
      } catch (e) {
        return { type: "failed", error: String(e?.message ?? e) }
      }
      return {
        url: "",
        instructions: `验证码已发送到 ${maskPhone(phone)}，请输入收到的 6 位验证码。`,
        method: "code",
        callback: async (code) => {
          if (normalizeCode(code) == null) return { type: "failed", error: "请输入 6 位数字验证码" }
          try {
            const got = await loginWithCode(phone, code, deviceId)
            return {
              type: "success",
              refresh: got.refresh,
              access: got.access,
              expires: jwtEnd(got.access) || Date.now() + 86400e3,
              deviceId,
              accountId: maskPhone(phone),
              source: "sms",
            }
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
      { type: "text", key: "deviceId", message: "deviceId（可留空，通常从导入得到）" },
    ],
    authorize: async (inputs) => {
      const access = stripBearer(inputs?.access)
      if (!access) return { type: "failed", error: "accessToken 必填" }
      return {
        type: "success",
        refresh: String(inputs?.refresh ?? "").trim(),
        access,
        expires: jwtEnd(access),
        deviceId: String(inputs?.deviceId ?? "").trim(),
        source: "manual",
      }
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
          baseURL: upstreamBase(),
          apiKey: "autoclaw",
          async fetch(input, init = {}) {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
            if (!/\/chat\/completions$/.test(new URL(url).pathname))
              return errorResponse(404, "only chat completions are served")
            let chat
            try {
              chat = JSON.parse(await bodyText(input, init))
            } catch {
              return errorResponse(400, "a request that isn't JSON")
            }
            const route = resolveRoute(chat.model, remoteEntries)
            chat.model = route.bodyModel
            normalizeMaxTokens(chat)
            normalizeSystemPrompt(chat)
            let cred
            try {
              cred = await fresh(getAuth)
            } catch (e) {
              return errorResponse(e instanceof SignedOut || e?.signIn === "expired" ? 401 : 502, String(e?.message ?? e))
            }
            const ask = (token) =>
              fetch(`${upstreamBase()}/chat/completions`, {
                method: "POST",
                headers: proxyHeaders(token, route.routeId),
                body: JSON.stringify(chat),
                signal: init.signal ?? AbortSignal.timeout(LLM_TIMEOUT),
              })
            let res
            try {
              res = await ask(cred.access)
            } catch (e) {
              return errorResponse(502, e?.message ?? String(e))
            }
            // a 401 on a time-wise fresh token: renew once and ask again
            if (res.status === 401) {
              try {
                cred = await locked(async () => {
                  const cur = await getAuth()
                  const next = { ...cur, ...(await renewOf(cur)) }
                  await save(next)
                  return next
                })
                res = await ask(cred.access)
              } catch (e) {
                return errorResponse(e instanceof SignedOut || e?.signIn === "expired" ? 401 : 502, String(e?.message ?? e))
              }
            }
            if (!res.ok)
              return errorResponse(res.status, `AutoClaw 上游返回 ${res.status}: ${(await res.text().catch(() => "")).slice(0, 4096) || "无错误说明"}`)
            return rewriteModel(res, route.requested)
          },
        }
      },
      async usage(getAuth) {
        try {
          const a = await fresh(getAuth)
          const token = a.access
          let points
          try {
            points = await userapiRequest("GET", "/agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw", { token })
          } catch (e) {
            if (e?.signIn === "expired") throw e
            points = null
          }
          let normalized
          if (points && codeOf(points) === 0 && Array.isArray(points?.data?.wallets)) {
            normalized = normalizeWallets(points)
          } else {
            const legacy = await userapiRequest("GET", "/agent-assetmgr/api/v1/wallet-instances?wallet_type=all&wallet_scope=all", { token })
            if (codeOf(legacy) !== 0) throw new Error(`积分查询返回异常 code=${codeOf(legacy) ?? "null"}`)
            normalized = normalizeLegacyWallets(legacy)
          }
          const windows = normalized.wallets.map((w) => ({
            name: w.displayName,
            used: 0,
            display: w.balance != null ? `${w.balance} 积分` : "—",
            aside: true,
            ...(normalized.wallets.length === 1 ? { amount: w.balance ?? 0, limit: w.balance ?? 0, unit: "积分", resetsAt: beijingMidnight(), span: 86400 } : {}),
          }))
          return { plan: NAME, user: a.name || a.accountId, windows, signIn: "kept" }
        } catch (e) {
          return { error: String(e?.message ?? e), signIn: e?.signIn === "expired" ? "expired" : "kept" }
        }
      },
      // the daily sign-in: the client's 「每日签到」 banner presses
      // `autoclaw-task-complete` with `task_id: daily_signin`; the reply's
      // `reward_points > 0` (or an explicit success) means this press earned
      // something, while `already_completed` means today was already taken.
      async checkin(getAuth) {
        // via fresh(): a near-expiry token renews itself here instead of
        // failing the check-in with "请重新登录" (same shape as raccoon's)
        let a
        try {
          a = await fresh(getAuth)
        } catch (e) {
          throw e instanceof SignedOut || e?.signIn === "expired" ? expired("AutoClaw：未登录") : e
        }
        let payload
        try {
          payload = await userapiRequest("POST", TASK_COMPLETE_PATH, { token: a.access, body: { task_id: DAILY_SIGNIN_TASK_ID } })
        } catch (e) {
          if (e?.signIn === "expired" || e instanceof SignedOut) throw expired("AutoClaw 登录态已失效，无法签到（请重新登录）")
          return { outcome: "failed", message: `签到失败：${e?.message ?? e}` }
        }
        const code = codeOf(payload)
        if (code != null && AUTH_EXPIRED_CODES.has(code)) throw expired("AutoClaw 登录态已失效，无法签到（请重新登录）")
        if (code != null && code !== 0) {
          // not an auth problem: ask the task list why (未开始/不在时段/任务下线…)
          let why = ""
          try {
            const list = await userapiRequest("GET", TASK_LIST_PATH, { token: a.access })
            const tasks = list?.data?.taskList ?? list?.data?.tasks ?? list?.data ?? []
            const mine = Array.isArray(tasks) ? tasks.find((t) => t?.task_id === DAILY_SIGNIN_TASK_ID || t?.taskId === DAILY_SIGNIN_TASK_ID || t?.id === DAILY_SIGNIN_TASK_ID) : null
            const status = mine?.status ?? mine?.state
            if (status != null) why = `（任务状态 ${status}${mine?.statusDesc || mine?.description ? `：${mine.statusDesc || mine.description}` : ""}）`
          } catch {}
          return { outcome: "failed", message: `签到失败：${payload?.msg ?? `code=${code}`}${why}` }
        }
        const data = payload?.data ?? {}
        const already = data.already_completed === true
        const saidSuccess = data.success === true
        const reward = toNum(data.reward_points) ?? 0
        if (reward > 0 || (saidSuccess && !already)) {
          return {
            outcome: "claimed",
            credit: reward || undefined,
            message: reward > 0 ? `签到成功，获得 ${reward} 积分` : "签到成功",
          }
        }
        return {
          outcome: "done",
          credit: reward || undefined,
          message: already ? "今天已签到" : "签到未领取（上游未发放积分）",
        }
      },
      methods,
    },
    async config(config) {
      config.provider ??= {}
      const was = config.provider[ID] ?? {}
      config.provider[ID] = {
        name: NAME,
        npm: "@ai-sdk/openai-compatible",
        api: upstreamBase(),
        ...was,
        models: { ...FALLBACK_MODELS, ...(was.models ?? {}) },
      }
    },
    provider: {
      id: ID,
      async models(p, { auth } = {}) {
        if (auth?.type !== "oauth" || !auth.access) return p.models
        try {
          const res = await fetch(`${configBase()}autoclaw-model-config`, {
            headers: userapiHeaders(auth.access),
            signal: AbortSignal.timeout(15_000),
          })
          if (!res.ok) return p.models
          const payload = await res.json().catch(() => null)
          const entries = catalogEntries(payload)
          if (!entries.length) return p.models
          // remember the route ids for the forwarder's resolver
          remoteEntries = entries
          // register into the provider's table too: magpie filters its static
          // model table by the account's list, so a model only in the dynamic
          // return is invisible at /v1/models
          for (const entry of entries) {
            const m = catalogModel(entry)
            p.models[m.id] = { ...(p.models[m.id] ?? {}), ...m.config }
          }
          return p.models
        } catch {
          return p.models
        }
      },
    },
  }
}

// the vendor's day runs on Beijing time
const beijingMidnight = () => Math.floor((Date.now() + 8 * 3600e3) / 86400e3) * 86400e3 + 86400e3 - 8 * 3600e3


// for tests
export const _internal = {
  ID,
  NAME,
  REFRESH_LEAD,
  AUTH_APP_ID,
  AUTH_APP_KEY,
  CLIENT_VERSION,
  DEFAULT_ROUTE,
  STATIC_MODELS,
  FALLBACK_MODELS,
  IDENTITY_LINE,
  IDENTITY_PREFIX,
  FOREIGN_IDENTITIES,
  userapiHeaders,
  proxyHeaders,
  userapiRequest,
  renewTokens,
  resolveRoute,
  stripRoutePrefix,
  isRouteId,
  normalizeMaxTokens,
  normalizeSystemPrompt,
  rewriteIdentities,
  findIgnoreAsciiCase,
  replaceAllIgnoreAsciiCase,
  catalogEntries,
  catalogModel,
  normalizeWallets,
  normalizeLegacyWallets,
  normalizePhone,
  normalizeCode,
  maskPhone,
  describeLoginError,
  sendCode,
  loginWithCode,
  configBase,
  userapiBase,
  upstreamBase,
  jwtEnd,
  stripBearer,
  toNum,
  beijingMidnight,
  agent2apiAccounts,
  newDeviceId,
}
