// magpie-autoclaw-cn-auth — the AutoClaw 国内版 (智谱 autoglm) provider
// plugin for magpie.
//
// Signs in with an AutoClaw account (domestic phone + SMS code, an agent2api
// import, or pasted tokens), forwards chat completions to its zhipuai
// acceleration proxy, lists its models, reads its point wallets, presses both
// of the client's daily tasks (「每日签到」 and the inspiration center), and
// offers the web app's `?autoglm_token=` shortcut as a usage window. Request shapes are ported
// from aimod-cc/agent2api (MIT), providers/autoclaw, rewritten for magpie's
// plugin API.
//
// Since 0.3.0 it also mirrors the community plugin's activity-points work:
// a check-in reports the desktop client's login event (`/userapi/v1/user-info`
// with the official fingerprint headers, which is what makes the vendor pay
// the login campaign reward), the usage card reconciles the campaign ledger
// into an「活动积分」row, and a 403 that is a spent quota or a banned account
// no longer reads as an expired sign-in.
//
// Since 0.4.0 the check-in confirms that reward instead of firing blindly:
// today's campaign ledger is read first (a payout already there means the
// login event is skipped), the trigger is followed by a read-back, and what
// landed is appended to the check-in message as「活动奖励已到账 +N（…）」.
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
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname } from "node:path"

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

// the web app. The browser's checkToken() reads `?autoglm_token=`, Bearer-izes
// it and stores it as the web session, so the access token this plugin keeps is
// already a password-less web entry (the vendor's own invite links carry it).
const CN_WEB_HOST = "https://autoglm.zhipuai.cn"
const webBase = () => env("AUTOCLAW_WEB_BASE_URL", CN_WEB_HOST)
const webEntryUrl = (access) => `${webBase()}/?autoglm_token=${encodeURIComponent(stripBearer(access))}`
// the usage window that carries the link (host.js has no url field: `display`
// is the only always-visible slot, and `aside` keeps it out of availability)
const WEB_ENTRY_WINDOW = "网页版快捷登录"

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

// both daily rewards are tasks in the client's generic task system: the
// 「每日签到」 banner and the inspiration center's entry trigger press the same
// `task-complete` endpoint (one idempotent state per task per day)
const DAILY_SIGNIN_TASK_ID = "daily_signin"
const INSPIRATION_TASK_ID = "daily_inspiration_center"
const TASK_COMPLETE_PATH = "/autoclaw-proxy/proxy/autoclaw-task-complete"
const TASK_LIST_PATH = "/autoclaw-proxy/proxy/autoclaw-task-list"

// the points routes: v2 wallets (the primary read), its v1 fallback, and the
// campaign ledger (activity points, display only)
const WALLETS_PATH = "/agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw"
const LEGACY_WALLETS_PATH = "/agent-assetmgr/api/v1/wallet-instances?wallet_type=all&wallet_scope=all"
const CAMPAIGN_LEDGER_PATH = "/agent-assetmgr/api/v1/ledgers_std?biz_app_id=autoclaw&page_size=200&wallet_scope=campaign"

// the login event: the vendor only records `autoclaw_user_active` (and pays the
// 「用户登录奖励」campaign) when this request carries the official desktop
// client's fingerprint. Measured 2026-11-06 over five accounts: the plugin's
// own account headers answer code 0 but pay nothing, the AutoClaw20/2.2.0 set
// pays the reward on every account.
const USER_INFO_PATH = "/userapi/v1/user-info"
const DESKTOP_UA = "AutoClaw/2.2.0 (win-x64)"
const DESKTOP_VERSION = "2.2.0"
const DESKTOP_TM = "win-x64"
const DESKTOP_CHANNEL = "AutoClaw20"
// the domestic account domain, tried after the configured userapi base fails
const USER_INFO_ALT_HOST = "https://autoglm-api.zhipuai.cn"
const userInfoAltBase = () => env("AUTOCLAW_USERINFO_ALT_BASE_URL", USER_INFO_ALT_HOST)

// ── small helpers ──────────────────────────────────────────────────────────

const stripBearer = (token) => String(token ?? "").replace(/^Bearer\s+/i, "").trim()

const toNum = (v) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

// a JWT claim (used for device_id and exp)
function jwtClaim(token, key) {
  const part = stripBearer(token).split(".")[1]
  if (!part) return undefined
  try {
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
    return JSON.parse(json)[key]
  } catch {
    return undefined
  }
}

// the account's own device id: the one the login sent (and the server wrote
// into the token's device_id claim), never a fixed string
function accountDeviceId(auth, ...tokens) {
  const given = String(auth?.deviceId ?? "").trim()
  if (given) return given
  for (const token of tokens) {
    const claim = String(jwtClaim(token, "device_id") ?? "").trim()
    if (claim) return claim
  }
  return ""
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

// ── a 403 that is not the sign-in ──────────────────────────────────────────
//
// The gateway answers a spent quota with 403 {"code":810000,…} and a banned
// account with 403 {"code":410004,…}. Neither means the token is gone: signing
// in again returns the same account and the same refusal, so magpie must keep
// the sign-in and show the vendor's own words instead of dropping it.
const QUOTA_CODES = new Set(["810000", "810001"])
const QUOTA_WORDS = /额度|余额不足|余额已用完|用完|用尽|系统繁忙|升级会员|quota|insufficient[_ ]?(balance|credit)|exhausted/i
const BANNED_CODES = new Set(["410004"])
const BANNED_WORDS =
  /\bbanned\b|封禁|封号|账号异常|账户异常|account (has been |is |was )?(suspended|frozen|disabled|blocked|restricted)|账[号户](已|已被|被)?(冻结|停用|禁用)/i

// the code and message of a refusal body (only those fields, never the whole body)
function refusalFields(text) {
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {}
  return {
    code: parsed?.code ?? parsed?.error?.code ?? null,
    message: String(parsed?.message ?? parsed?.msg ?? parsed?.error?.message ?? "").trim(),
  }
}

// a 403 read as the account's own state (quota / ban), or null when it is not
function readRefusal(status, text) {
  if (status !== 403) return null
  const { code, message } = refusalFields(text)
  if (BANNED_CODES.has(String(code)) || (message && BANNED_WORDS.test(message)))
    return { kind: "banned", code, message: message || `account refused (code ${code})` }
  if (QUOTA_CODES.has(String(code)) || (message && QUOTA_WORDS.test(message))) return { kind: "quota", code, message }
  return null
}

// an error response that also carries magpie's sign-in verdict
const refusalResponse = (status, message, signIn, type) =>
  new Response(JSON.stringify({ error: { message, ...(type ? { type } : {}) } }), {
    status,
    headers: { "content-type": "application/json", "X-Magpie-Sign-In": signIn },
  })

// ── the login event (activity reward) ──────────────────────────────────────
//
// POST /userapi/v1/user-info with the official desktop fingerprint. The reply's
// `daily_check_in_completed_on_request` is always false on the live service, so
// it is not read: the daily check-in is still the task-complete call below.
// Returns null on a transport failure; otherwise { ok, code, msg } so a 401
// carrying code 0 never counts as reached.
async function callUserInfo(access, deviceId, base) {
  const timestamp = String(Math.max(0, Math.floor(Date.now() / 1000)))
  const sign = createHash("md5").update(`${AUTH_APP_ID}&${timestamp}&${AUTH_APP_KEY}`).digest("hex")
  let res
  try {
    res = await fetch(`${base}${USER_INFO_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "*/*",
        "User-Agent": DESKTOP_UA,
        "X-Version": DESKTOP_VERSION,
        "X-Tm": DESKTOP_TM,
        "X-Product": "autoclaw",
        "X-Auth-Appid": AUTH_APP_ID,
        "X-Auth-TimeStamp": timestamp,
        "X-Auth-Sign": sign,
        "X-Trace-Id": randomBytes(8).toString("hex"),
        "X-Lang": CLIENT_LANG,
        "X-Channel": DESKTOP_CHANNEL,
        Authorization: `Bearer ${stripBearer(access)}`,
      },
      body: JSON.stringify({ source_id: "autoclaw", device_id: deviceId }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    return null
  }
  const parsed = await res.json().catch(() => null)
  return { ok: res.ok, code: codeOf(parsed), msg: parsed?.msg ?? parsed?.message }
}

// the hosts user-info is tried on: the configured account base first, then the
// domestic account domain (the one the community implementation measured)
const userInfoBases = () => [...new Set([userapiBase(), userInfoAltBase()])]

// GET the task list. Resolves an array (possibly empty) when the host answered,
// null when it answered something unusable (5xx / non-envelope). 401/403 throw:
// quota and ban carry signIn "kept", anything else is the sign-in (expired).
async function callTaskList(access) {
  let res
  try {
    res = await fetch(`${userapiBase()}${TASK_LIST_PATH}`, {
      headers: userapiHeaders(access),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (e) {
    throw new Error(`AutoClaw task-list 请求失败：${e?.message ?? e}`)
  }
  if (res.status === 401 || res.status === 403) {
    const text = await res.text().catch(() => "")
    const refusal = readRefusal(res.status, text)
    if (refusal)
      throw Object.assign(new Error(`AutoClaw：${refusal.message || refusal.kind}`), {
        ...(refusal.kind === "banned" ? { banned: true } : { quota: true }),
        signIn: "kept",
      })
    throw expired(`登录已失效（HTTP ${res.status}）`)
  }
  if (!res.ok) return null
  const payload = await res.json().catch(() => null)
  const code = codeOf(payload)
  if (code != null && AUTH_EXPIRED_CODES.has(code)) throw expired("AutoClaw 登录态已失效，无法签到（请重新登录）")
  if (code != null && code !== 0) return null
  return Array.isArray(payload?.data) ? payload.data : null
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

// ── the campaign ledger (activity points) ──────────────────────────────────
//
// The server opens one wallet instance per activity; every credit / debit /
// expire ledger row carries the instance's `wallet_id` and `wallet_scope`, so
// "how much of the activity is left" is exact: credit − debit − expire per
// instance. The window holds only the most recent ~151 rows (page_size tops out
// at 200, paging is a no-op) and activities live at most 7 days, so a live
// activity's whole lifecycle is inside it. The server may ignore the
// `wallet_scope` filter: campaignBreakdown filters again. Everything here is
// display-only and never throws into the balance rows.

// deterministic thousands grouping (no toLocaleString: CI/locale independent)
const fmtPoints = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")

// "AutoClaw 用户登录奖励 +5000 credits" → "AutoClaw 用户登录奖励"
function campaignLabel(entry, md) {
  const raw = String(md?.description ?? entry?.description ?? "").trim()
  return raw.replace(/\s*\+\s*[\d.,]+\s*(?:credits?|积分)?\s*$/i, "").trim()
}

// the ledger rows → { claimed, expired, remaining, labels, lapseAt, lapsing }
// (facts within the window), or null when there is no activity history.
function campaignBreakdown(entries, now = Date.now()) {
  const instances = new Map() // wallet_id → { credit, debit, expire, label, expires }
  let claimed = 0
  let expired = 0
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== "object") continue
    const md = entry.metadata && typeof entry.metadata === "object" ? entry.metadata : {}
    const scope = String(entry.wallet_scope ?? md.wallet_scope ?? "").trim().toLowerCase()
    if (scope !== "campaign") continue // the server may ignore the filter
    const type = String(entry.mutation_type ?? "").trim().toLowerCase()
    if (type !== "credit" && type !== "debit" && type !== "expire") continue
    const amount = Number(entry.amount)
    if (!Number.isFinite(amount)) continue
    const id = String(entry.wallet_id ?? "?")
    let inst = instances.get(id)
    if (!inst) {
      inst = { credit: 0, debit: 0, expire: 0, label: "", expires: 0 }
      instances.set(id, inst)
    }
    const expires = Number(entry.wallet_expires_at)
    if (Number.isFinite(expires) && expires > 0) inst.expires = expires * 1000
    if (type === "credit") {
      inst.credit += amount
      claimed += amount
      const label = campaignLabel(entry, md)
      if (label) inst.label = label
    } else if (type === "debit") {
      inst.debit += Math.abs(amount)
    } else {
      inst.expire += Math.abs(amount)
      expired += Math.abs(amount)
    }
  }
  if (instances.size === 0) return null
  let remaining = 0
  let lapseAt = 0
  let lapsing = 0
  const labels = []
  for (const inst of instances.values()) {
    const left = inst.credit - inst.debit - inst.expire
    if (left > 0) {
      remaining += left
      if (inst.label) labels.push(inst.label)
    }
    // an instance whose credit row fell out of the window counts as 0 spent,
    // yet its expire row still counts in 「过期」
    if (!(left > 0 && inst.expires > now)) continue
    if (!lapseAt || inst.expires < lapseAt) (lapseAt = inst.expires), (lapsing = left)
    else if (inst.expires === lapseAt) lapsing += left
  }
  return { claimed, expired, remaining, labels: [...new Set(labels)], lapseAt, lapsing }
}

// one request, no paging. Resolves the entries array (possibly empty: really no
// activity history) or null (protocol change: entries not an array). Throws on
// a transport/HTTP/envelope failure so the cache treats it as "not cached".
async function fetchCampaignLedger(access) {
  let res
  try {
    res = await fetch(`${userapiBase()}${CAMPAIGN_LEDGER_PATH}`, {
      headers: userapiHeaders(access),
      signal: AbortSignal.timeout(8_000),
    })
  } catch (e) {
    throw new Error(`AutoClaw 活动流水请求失败：${e?.message ?? e}`)
  }
  if (!res.ok) throw new Error(`AutoClaw 活动流水 HTTP ${res.status}`)
  const payload = await res.json().catch(() => null)
  const code = codeOf(payload)
  if (!payload || code !== 0 || !payload.data) throw new Error(`AutoClaw 活动流水异常 code=${code ?? "null"}`)
  return Array.isArray(payload.data.entries) ? payload.data.entries : null
}

// ── today's login-activity payout (the check-in's confirm step) ────────────
//
// The vendor pays 「登录即发」 activities (Weekly Perks, the new-user Day 1-7
// bonus) from the login hook; there is no claim endpoint. So a check-in reads
// the campaign ledger first: a payout already there today means the desktop
// client opening already paid it and user-info is skipped; otherwise the
// trigger runs and the ledger is read back to confirm what just landed.
//
// Same judgement as agent2api's promotion.rs: `metadata.event_type` prefixes
// are the primary key (activity_id suffixes change every period, and one
// period can pay two different prefixes), activity_id prefixes only cover rows
// that carry no event_type.
const ACTIVITY_EVENT_PREFIXES = ["autoclaw_user_active", "autoclaw_user_signup_day"]
const ACTIVITY_ID_PREFIXES = ["autoclaw_user_active_reward", "autoclaw_user_active_bonus"]

// the ledger rows that are today's activity payout → { amount, labels, count },
// or null when nothing landed. Campaign credits only; `occurred_at` must fall
// on the Beijing day of `now` (a missing / broken timestamp is skipped: an
// unreadable date must never turn into a false 「已到账」).
function todayActivityReward(entries, now = Date.now()) {
  const today = beijingDayOf(new Date(now))
  let amount = 0
  let count = 0
  const labels = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== "object") continue
    const md = entry.metadata && typeof entry.metadata === "object" ? entry.metadata : {}
    const scope = String(entry.wallet_scope ?? md.wallet_scope ?? "").trim().toLowerCase()
    if (scope !== "campaign") continue // the server may ignore the filter
    if (String(entry.mutation_type ?? "").trim().toLowerCase() !== "credit") continue
    const when = new Date(entry.occurred_at ?? md.occurred_at ?? NaN)
    if (!Number.isFinite(when.getTime()) || beijingDayOf(when) !== today) continue
    const event = String(md.event_type ?? "")
    const activityId = String(entry.activity_id ?? md.activity_id ?? "")
    const matched =
      ACTIVITY_EVENT_PREFIXES.some((prefix) => event.startsWith(prefix)) ||
      (!event && ACTIVITY_ID_PREFIXES.some((prefix) => activityId.startsWith(prefix)))
    if (!matched) continue
    const value = toNum(entry.amount)
    if (value == null) continue
    amount += value
    count++
    const label = campaignLabel(entry, md)
    if (label) labels.push(label.slice(0, 40))
  }
  if (!count) return null
  return { amount, labels: [...new Set(labels)], count }
}

// the check-in's live read: a check-in happens once a day, so the ledger must
// be fresh (the display cache would answer with a pre-payout snapshot). A
// failed read is null = unknown — never a failed check-in.
async function readCampaignForCheckin(access) {
  try {
    return await fetchCampaignLedger(access)
  } catch {
    return null
  }
}

// the cache: 10 minutes per account key; failures are not cached (the next
// usage retries at once), null (protocol change) is; checkin clears it when
// user-info reached the server (the reward may have just landed). An in-flight
// read that finishes after an invalidation does not write itself back.
const CAMPAIGN_TTL_MS = 10 * 60 * 1000
const CAMPAIGN_CACHE_MAX = 100
const campaignCache = new Map() // accountKey → { at, value, promise }

function campaignCached(key, loader) {
  const held = campaignCache.get(key)
  if (held?.promise) return held.promise
  if (held && Date.now() - held.at < CAMPAIGN_TTL_MS) return Promise.resolve(held.value)
  while (campaignCache.size >= CAMPAIGN_CACHE_MAX) {
    let evicted = false
    for (const [k, gate] of campaignCache) {
      if (!gate.promise) {
        campaignCache.delete(k)
        evicted = true
        break
      }
    }
    if (!evicted) break
  }
  const gate = { at: 0, value: null, promise: null }
  gate.promise = loader().then(
    (value) => {
      gate.promise = null
      gate.at = Date.now()
      gate.value = value
      if (campaignCache.get(key) === gate) campaignCache.set(key, gate)
      return value
    },
    () => {
      if (campaignCache.get(key) === gate) campaignCache.delete(key)
      return null
    },
  )
  campaignCache.set(key, gate)
  return gate.promise
}

// the per-account key for the local ledgers (usage state + campaign cache):
// a display name can repeat, so key on the uid, else on the token's hash
function accountKey(providerId, auth) {
  const uid = String(auth?.uid ?? auth?.userId ?? "").trim()
  if (uid) return `${providerId}|uid:${uid}`
  const token = stripBearer(String(auth?.refresh ?? auth?.access ?? ""))
  return `${providerId}|tok:${createHash("sha256").update(token).digest("hex").slice(0, 16)}`
}

// ── the local usage state (this round's spend) ─────────────────────────────
//
// A file under magpie's config dir (survives plugin updates, isolated in CI by
// HOME): `AUTOCLAW_USAGE_STATE_FILE` → `$XDG_CONFIG_HOME/magpie` →
// `$HOME/.config/magpie` (Windows falls back to USERPROFILE: a bare
// `${HOME ?? ""}` would write to C:\.config, readable by any local user).
// Writes go tmp+rename (a concurrent write never leaves half a file), mode
// 0600; entries untouched for 30 days are dropped.
let usageStatePath = null
let usageState = null

function magpieCfgDir() {
  if (process.env.XDG_CONFIG_HOME) return `${process.env.XDG_CONFIG_HOME.replace(/\/+$/, "")}/magpie`
  const home =
    String(process.env.HOME ?? "").trim() || String(process.env.USERPROFILE ?? "").trim() || homedir()
  return `${home.replace(/[\\/]+$/, "")}/.config/magpie`
}

function usageStatePathDefault() {
  if (process.env.AUTOCLAW_USAGE_STATE_FILE) return process.env.AUTOCLAW_USAGE_STATE_FILE
  return `${magpieCfgDir()}/autoclaw-usage.json`
}

// tests point this at a temp file; the in-memory copy is dropped so runs don't
// leak into each other
function setUsageStatePath(path) {
  usageStatePath = path || null
  usageState = null
}

const currentUsageStatePath = () => usageStatePath ?? usageStatePathDefault()

function usageStateLoad() {
  if (usageState) return usageState
  try {
    usageState = JSON.parse(readFileSync(currentUsageStatePath(), "utf8"))
    if (!usageState || typeof usageState !== "object" || typeof usageState.accts !== "object") usageState = { accts: {} }
  } catch {
    usageState = { accts: {} }
  }
  return usageState
}

const USAGE_STATE_TTL_MS = 30 * 86400 * 1000

function usageStateSave() {
  try {
    const now = Date.now()
    for (const [key, value] of Object.entries(usageState.accts)) {
      const at = Date.parse(value?.at ?? "")
      if (!Number.isFinite(at) || now - at > USAGE_STATE_TTL_MS) delete usageState.accts[key]
    }
    const path = currentUsageStatePath()
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(usageState), { mode: 0o600 })
    renameSync(tmp, path)
  } catch {}
}

// the vendor's day runs on Beijing time
const beijingDayOf = (d = new Date()) => new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 10)

// one balance observation → { peak, used, daySpent, dayGained }. Any rise
// (total > last balance, including from 0) starts a new round: peak = total,
// used = 0. Not waiting to pass the old peak matters because the daily reward
// often lands after the spending. daySpent/dayGained are Beijing-day sums.
function balanceObserve(key, total) {
  const state = usageStateLoad()
  const day = beijingDayOf()
  const prev = state.accts[key] ?? {}
  const last = Number(prev.balance)
  const sameDay = prev.day === day
  let daySpent = sameDay ? Number(prev.daySpent) || 0 : 0
  let dayGained = sameDay ? Number(prev.dayGained) || 0 : 0
  let peak
  if (Number.isFinite(last) && total > last) {
    dayGained += total - last
    peak = total
  } else {
    peak = Number(prev.peak)
    if (!Number.isFinite(peak) || peak <= 0 || total > peak) peak = total
    if (Number.isFinite(last) && total < last) daySpent += last - total
  }
  const used = Math.max(0, peak - total)
  state.accts[key] = { peak, balance: total, day, daySpent, dayGained, at: new Date().toISOString() }
  usageStateSave()
  return { peak, used, daySpent, dayGained }
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
              const message = String(e?.message ?? e)
              return e instanceof SignedOut || e?.signIn === "expired"
                ? refusalResponse(401, message, "expired")
                : errorResponse(502, message)
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
                const message = String(e?.message ?? e)
                return e instanceof SignedOut || e?.signIn === "expired"
                  ? refusalResponse(401, message, "expired")
                  : errorResponse(502, message)
              }
            }
            if (!res.ok) {
              const body = await res.text().catch(() => "")
              // a 403 that is a spent quota or a banned account is not the
              // sign-in: keep it, pass the vendor's words on (quota → 429)
              const refusal = readRefusal(res.status, body)
              if (refusal?.kind === "quota")
                return refusalResponse(429, `AutoClaw: ${refusal.message || "额度已用完"}`, "kept", "rate_limit_error")
              if (refusal?.kind === "banned")
                return refusalResponse(403, `AutoClaw: ${refusal.message || "账号被封禁"}`, "kept", "permission_error")
              const message = `AutoClaw 上游返回 ${res.status}: ${body.slice(0, 4096) || "无错误说明"}`
              return res.status === 401 || res.status === 403
                ? refusalResponse(res.status, message, "expired")
                : errorResponse(res.status, message)
            }
            return rewriteModel(res, route.requested)
          },
        }
      },
      async usage(getAuth) {
        try {
          const a = await fresh(getAuth)
          const token = a.access

          // the wallets: v2 first, the v1 instances as fallback (as before)
          let walletsPayload = null
          let isV2 = false
          try {
            const v2 = await userapiRequest("GET", WALLETS_PATH, { token })
            if (codeOf(v2) === 0 && Array.isArray(v2?.data?.wallets)) {
              walletsPayload = v2
              isV2 = true
            }
          } catch (e) {
            if (e?.signIn === "expired") throw e
          }
          if (!walletsPayload) {
            const legacy = await userapiRequest("GET", LEGACY_WALLETS_PATH, { token })
            if (codeOf(legacy) !== 0) throw new Error(`积分查询返回异常 code=${codeOf(legacy) ?? "null"}`)
            walletsPayload = legacy
          }
          const data = walletsPayload?.data ?? {}
          // null / "" / non-numeric total is unknown, not 0: Number(null)===0
          // would record the whole pool as spent (100% used)
          const rawTotal = data.total_balance
          if (rawTotal == null || rawTotal === "" || !Number.isFinite(Number(rawTotal)))
            return { error: "积分响应异常", windows: [] }
          const total = Number(rawTotal)
          const named = (isV2 ? normalizeWallets(walletsPayload).wallets : normalizeLegacyWallets(walletsPayload).wallets)
            .filter((w) => w.balance != null && w.balance > 0 && Math.round(w.balance) !== Math.round(total))
            .slice(0, 3)

          // the daily check-in's state (a task-list read; unreadable = no row)
          let signin = null
          try {
            const tasks = await callTaskList(token)
            const task = Array.isArray(tasks) ? tasks.find((t) => t?.task_id === DAILY_SIGNIN_TASK_ID) : null
            if (task) signin = { status: String(task.status ?? ""), reward: toNum(task.reward_points) ?? 0 }
          } catch {}

          const track = balanceObserve(accountKey(ID, a), total)

          const windows = []
          // this round's spend: `used` is a percentage since the balance last
          // rose; amount/limit are raw points. aside: display-only, routing
          // reads the balance window below.
          if (track.used > 0) {
            const pct = track.peak > 0 ? Math.min(100, Math.round((track.used / track.peak) * 1000) / 10) : 0
            windows.push({
              name: "本轮消耗",
              aside: true,
              used: pct,
              amount: Math.round(track.used),
              limit: Math.round(track.peak),
              display:
                `${fmtPoints(track.used)} / ${fmtPoints(track.peak)} 积分` +
                (track.daySpent > 0 ? ` · 今日 -${fmtPoints(track.daySpent)}` : "") +
                (track.dayGained > 0 ? ` · 今日 +${fmtPoints(track.dayGained)}` : ""),
            })
          }
          // the check-in row only expresses state (used stays 0)
          if (signin) {
            windows.push({
              name: "每日签到",
              used: 0,
              aside: true,
              display:
                signin.status === "completed"
                  ? `今日已签 ✓${signin.reward ? ` +${fmtPoints(signin.reward)}` : ""}`
                  : `今日未签${signin.reward ? `（+${fmtPoints(signin.reward)}）` : ""}`,
            })
          }
          // points are a pure balance: no total/no used. This window is the one
          // routing reads (magpie >= v0.1.1790).
          const balanceWindow = { name: "积分余额", balance: total, unit: "积分" }
          windows.push(balanceWindow)

          // the campaign row: display-only, any failure omits it
          let campaignRow = null
          try {
            const entries = await campaignCached(accountKey(ID, a), () => fetchCampaignLedger(token))
            const camp = campaignBreakdown(entries)
            // when part of the activity stock lapses soon, mark the moment on
            // the balance window (never a second balance-bearing window)
            if (camp?.lapseAt && camp.lapsing > 0 && total > 0)
              Object.assign(balanceWindow, {
                runsOutAt: new Date(camp.lapseAt).toISOString(),
                runsOut: Math.min(total, camp.lapsing),
              })
            if (camp && (camp.claimed > 0 || camp.expired > 0)) {
              const label =
                camp.labels.length === 1
                  ? `（${camp.labels[0].slice(0, 40)}）`
                  : camp.labels.length > 1
                    ? `（${camp.labels.length} 个活动）`
                    : ""
              const text = [`剩 ${fmtPoints(camp.remaining)}${label}`, `已领 ${fmtPoints(camp.claimed)}`, `过期 ${fmtPoints(camp.expired)}`].join(" · ")
              campaignRow = { name: "活动积分", used: 0, aside: true, display: `${text}（近期）` }
            }
          } catch {}
          if (campaignRow) windows.push(campaignRow)

          // the web shortcut last: `used` is omitted on purpose (unreported =
          // no share, not 0%). The token is the post-fresh() one, so the link
          // stays valid for at least REFRESH_LEAD.
          windows.push({ name: WEB_ENTRY_WINDOW, display: webEntryUrl(token), aside: true })

          const parts = named.map((w) => `${w.displayName} ${fmtPoints(w.balance)}`)
          return {
            plan: NAME,
            user: a.name || a.accountId,
            balance: `${fmtPoints(total)} 积分${parts.length ? `（${parts.join(" · ")}）` : ""}`,
            windows,
            signIn: "kept",
          }
        } catch (e) {
          return { error: String(e?.message ?? e), signIn: e?.signIn === "expired" ? "expired" : "kept" }
        }
      },
      // the daily flow: campaign ledger (today's payout already in? read
      // before, confirm after) → user-info (the login event that pays the
      // activity reward, best effort, skipped when already paid) → task-list
      // (skip what is already done) → press the remaining task(s). The two
      // tasks are independent — a non-auth failure of one never blocks the
      // other — while an auth failure (401 / 410000 / SignedOut) ends the whole
      // check-in as expired. A 403 that is a spent quota or a banned account is
      // thrown as-is with signIn "kept".
      async checkin(getAuth) {
        // via fresh(): a near-expiry token renews itself here instead of
        // failing the check-in with "请重新登录" (same shape as raccoon's)
        let a
        try {
          a = await fresh(getAuth)
        } catch (e) {
          // a renewal failure keeps its own 「失效」 wording (and signIn)
          if (e instanceof SignedOut) throw expired("AutoClaw：未登录")
          throw e
        }

        // ① the activity payout, confirmed instead of assumed: read today's
        // campaign ledger first (live, not the display cache). A payout
        // already there means the desktop client opening paid it — the login
        // event is skipped. Otherwise it is triggered on the configured base
        // then the domestic account domain, and the ledger is read back so the
        // message reports what actually landed. Never blocks the check-in.
        let ledger = await readCampaignForCheckin(a.access)
        let reward = todayActivityReward(ledger)
        let uiReached = false
        if (!reward) {
          const deviceId = accountDeviceId(a, a.access, a.refresh)
          for (const base of userInfoBases()) {
            const ui = await callUserInfo(a.access, deviceId, base)
            if (ui?.ok && ui.code === 0) {
              uiReached = true
              break
            }
          }
          // the reward may have just landed: drop the cached campaign ledger
          // (usage re-reads it) and read it back to confirm the payout
          if (uiReached) {
            campaignCache.delete(accountKey(ID, a))
            ledger = await readCampaignForCheckin(a.access)
            reward = todayActivityReward(ledger)
          }
        }
        // the activity segment appended after the task results: a payout with
        // its labels, the miss note only for a readable ledger with no payout
        // and an unreached login event (unknown is not 「未触发」), nothing
        // when it landed or could not be read
        const rewardText = reward
          ? `活动奖励已到账 +${fmtPoints(reward.amount)}${
              reward.labels.length === 1
                ? `（${reward.labels[0]}）`
                : reward.labels.length > 1
                  ? `（${reward.labels.length} 个活动）`
                  : ""
            }`
          : !uiReached && ledger !== null
            ? "活动奖励未触发（登录未上报）"
            : ""
        const note = (result) => {
          if (!rewardText) return result
          return { ...result, message: result.message ? `${result.message}；${rewardText}` : rewardText }
        }

        // one task's press → { kind:"claimed", reward } | { kind:"done" } |
        // { kind:"failed", reason }; auth failures throw expired
        const press = async (taskId) => {
          let payload
          try {
            payload = await userapiRequest("POST", TASK_COMPLETE_PATH, { token: a.access, body: { task_id: taskId } })
          } catch (e) {
            if (e?.signIn === "expired" || e instanceof SignedOut) throw expired("AutoClaw 登录态已失效，无法签到（请重新登录）")
            return { kind: "failed", reason: String(e?.message ?? e) }
          }
          const code = codeOf(payload)
          if (code != null && AUTH_EXPIRED_CODES.has(code)) throw expired("AutoClaw 登录态已失效，无法签到（请重新登录）")
          // a business error is passed through as-is (task not started/offline):
          // no guessing, no retry
          if (code != null && code !== 0) return { kind: "failed", reason: String(payload?.msg ?? `code=${code}`) }
          const data = payload?.data ?? {}
          const already = data.already_completed === true
          const reward = toNum(data.reward_points) ?? 0
          if (reward > 0 || (data.success === true && !already)) return { kind: "claimed", reward }
          return { kind: "done" }
        }

        // ② the task list: an answered list drives which tasks to press; an
        // unanswered one (network / 5xx / non-envelope) falls back to pressing
        // both, as before (the endpoint is idempotent). 401/403 throw.
        let tasks = null
        try {
          tasks = await callTaskList(a.access)
        } catch (e) {
          if (e?.signIn === "kept" || e?.banned || e?.quota || e?.signIn === "expired") throw e
          tasks = null
        }

        let signin
        let inspiration
        if (Array.isArray(tasks)) {
          if (!tasks.length) return note({ outcome: "inactive", message: "当前没有签到活动" })
          const signinTask = tasks.find((t) => t?.task_id === DAILY_SIGNIN_TASK_ID)
          const inspirationTask = tasks.find((t) => t?.task_id === INSPIRATION_TASK_ID)
          if (!signinTask && !inspirationTask) return note({ outcome: "inactive", message: "当前没有签到活动" })
          const skipped = { kind: "done" }
          signin = !signinTask || String(signinTask.status ?? "") === "completed" ? skipped : await press(DAILY_SIGNIN_TASK_ID)
          inspiration =
            !inspirationTask || String(inspirationTask.status ?? "") === "completed" ? skipped : await press(INSPIRATION_TASK_ID)
        } else {
          signin = await press(DAILY_SIGNIN_TASK_ID)
          inspiration = await press(INSPIRATION_TASK_ID)
        }

        const credit = (signin.reward ?? 0) + (inspiration.reward ?? 0)
        const signinText =
          signin.kind === "claimed"
            ? signin.reward > 0
              ? `签到成功，获得 ${signin.reward} 积分`
              : "签到成功"
            : signin.kind === "done"
              ? "今天已签到"
              : `签到失败：${signin.reason}`
        const inspirationText =
          inspiration.kind === "claimed"
            ? inspiration.reward > 0
              ? `灵感中心已领取 ${inspiration.reward} 积分`
              : "灵感中心已领取"
            : inspiration.kind === "done"
              ? "灵感中心今日已领"
              : `灵感中心：${inspiration.reason}`
        const outcome =
          signin.kind === "claimed" || inspiration.kind === "claimed"
            ? "claimed"
            : signin.kind === "failed" || inspiration.kind === "failed"
              ? "failed"
              : "done"
        return note({ outcome, credit, message: `${signinText}；${inspirationText}` })
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
  webBase,
  webEntryUrl,
  INSPIRATION_TASK_ID,
  WEB_ENTRY_WINDOW,
  TASK_LIST_PATH,
  WALLETS_PATH,
  LEGACY_WALLETS_PATH,
  CAMPAIGN_LEDGER_PATH,
  DESKTOP_UA,
  DESKTOP_VERSION,
  DESKTOP_TM,
  DESKTOP_CHANNEL,
  QUOTA_CODES,
  QUOTA_WORDS,
  BANNED_CODES,
  BANNED_WORDS,
  readRefusal,
  refusalFields,
  refusalResponse,
  callUserInfo,
  userInfoBases,
  userInfoAltBase,
  callTaskList,
  jwtClaim,
  jwtEnd,
  accountDeviceId,
  accountKey,
  campaignLabel,
  campaignBreakdown,
  fetchCampaignLedger,
  ACTIVITY_EVENT_PREFIXES,
  ACTIVITY_ID_PREFIXES,
  todayActivityReward,
  readCampaignForCheckin,
  campaignCached,
  campaignCache,
  fmtPoints,
  setUsageStatePath,
  usageStatePath: currentUsageStatePath,
  usageStatePathDefault,
  magpieCfgDir,
  balanceObserve,
  beijingDayOf,
  stripBearer,
  toNum,
  beijingMidnight,
  agent2apiAccounts,
  newDeviceId,
}
