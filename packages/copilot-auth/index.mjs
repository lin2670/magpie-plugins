// magpie-copilot-auth — the GitHub Copilot provider plugin for magpie.
//
// Signs in the way VS Code's Copilot Chat does: a GitHub device flow (the
// public client id), then the GitHub user token trades for a Copilot api
// token at copilot_internal/v2/token, which is what model calls carry.
// That api token lasts ~30 minutes, so the plugin refreshes it in the
// loader before each request when it is close to expiring, and hands
// magpie an auth.refresh so the renewal also happens while idle.
//
// Model calls go straight to api.githubcopilot.com. Which endpoint a model
// takes is the one its /models catalog entry names (supported_endpoints):
// the GPT-5.x/6.x family only answers on /responses (a /chat/completions
// request is refused with unsupported_api_for_model), while kimi-k3 and
// gpt-4o only answer on /chat/completions. The catalog is fetched through
// the same api token and cached for an hour.
//
// Identity headers: Copilot gates its model catalog on the client the
// request claims to be (Copilot-Integration-Id). This plugin claims
// visualstudio-chat — the identity Visual Studio itself sends. The
// developer-cli identity that OmniRoute ships as its default is granted
// almost nothing on free accounts (400 model_not_supported on every model
// but gpt-4o); the VS Code identity (vscode-chat) also misses the 6.x
// models. visualstudio-chat is the widest catalog we measured, and it is
// the one real Visual Studio uses, so its wire shape is what we copy.

const ID = "copilot"
const NAME = "GitHub Copilot"

// the GitHub API host is overridable apart from the chat gateway
const GITHUB_API_BASE = () => process.env.COPILOT_GITHUB_API_BASE || "https://api.github.com"
// the device flow lives on github.com's own host, not the API host
// (api.github.com/login/device/code answers 404), so it has its own base
const GITHUB_WEB_BASE = () => process.env.COPILOT_GITHUB_WEB_BASE || "https://github.com"
const GITHUB_DEVICE_URL = () => GITHUB_WEB_BASE() + "/login/device/code"
const GITHUB_TOKEN_URL = () => GITHUB_WEB_BASE() + "/login/oauth/access_token"
const COPILOT_TOKEN_URL = () => GITHUB_API_BASE() + "/copilot_internal/v2/token"
const API_BASE = () => process.env.COPILOT_API_BASE || "https://api.githubcopilot.com"

// the public device-flow client id of Copilot Chat (public by design, the
// same one every Copilot client ships; also embedded in OmniRoute and 9router)
const CLIENT_ID = process.env.COPILOT_CLIENT_ID || "Iv1.b507a08c87ecfe98"

// the client identity model calls claim. VS (visualstudio-chat) has the
// widest entitled catalog on free accounts — see the file header.
const INTEGRATION_ID = process.env.COPILOT_INTEGRATION_ID || "visualstudio-chat"
const EDITOR_VERSION = "VisualStudio/18.9.3"
const PLUGIN_VERSION = "copilot-chat/18.9.1329"
const USER_AGENT = "GitHubCopilotChat/18.9.1329"
const API_VERSION = "2025-04-01"

// the api token is refreshed this long before its expires_at (the real
// clients refresh much later; earlier is safer and refresh is cheap)
const REFRESH_LEAD_MS = 5 * 60_000

// how long the /models catalog (endpoint routing) is trusted
const CATALOG_TTL_MS = 60 * 60_000

// ── small helpers ──────────────────────────────────────────────────────────

const errorResponse = (status, message) =>
  new Response(JSON.stringify({ error: { message } }), { status, headers: { "content-type": "application/json" } })

async function bodyText(input, init) {
  const b = init.body ?? (input instanceof Request ? await input.clone().text() : undefined)
  return typeof b === "string" ? b : new TextDecoder().decode(b)
}

const jsonHeaders = {
  "Content-Type": "application/json",
  Accept: "application/json",
  "User-Agent": USER_AGENT,
  "Editor-Version": EDITOR_VERSION,
  "Editor-Plugin-Version": PLUGIN_VERSION,
  "Copilot-Integration-Id": INTEGRATION_ID,
  "X-GitHub-Api-Version": API_VERSION,
}

// the identity headers a model call carries. openai-intent etc. are what the
// Copilot CLI sends; VS's chat doesn't, and the catalog gates only on the
// integration id — the extras measured 200 either way, so we send the plain
// VS set (fewer invented fields is the smaller lie).
function apiHeaders(token, extra = {}) {
  return {
    ...jsonHeaders,
    Authorization: `Bearer ${token}`,
    ...extra,
  }
}

// ── the wire: sign-in, token exchange, catalog ─────────────────────────────

// requestDeviceCode starts the GitHub device flow: a code the user types at
// github.com/login/device, polled until they approve.
async function requestDeviceCode() {
  const res = await fetch(GITHUB_DEVICE_URL(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify({ client_id: CLIENT_ID, scope: "read:user" }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`GitHub device/code 失败：HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
  return res.json() // { device_code, user_code, verification_uri, interval, expires_in }
}

// pollDeviceToken finishes the device flow. GitHub answers
// authorization_pending until the user approves; slow_down asks for a
// longer interval.
async function pollDeviceToken(device) {
  const deadline = Date.now() + (device.expires_in ?? 899) * 1000
  let interval = (device.interval ?? 5) * 1000
  for (;;) {
    if (Date.now() > deadline) throw new Error("设备码已过期（15 分钟），请重新发起登录")
    await new Promise((r) => setTimeout(r, interval))
    let j
    try {
      const res = await fetch(GITHUB_TOKEN_URL(), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": USER_AGENT },
        body: JSON.stringify({
          client_id: CLIENT_ID,
          device_code: device.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
        signal: AbortSignal.timeout(20_000),
      })
      j = await res.json()
    } catch {
      continue // a single failed poll is skipped, as the real clients do
    }
    if (j.access_token) return j.access_token
    if (j.error === "authorization_pending") continue
    if (j.error === "slow_down") {
      interval += 5000
      continue
    }
    throw new Error(`GitHub 设备流失败：${j.error ?? "?"} ${j.error_description ?? ""}`)
  }
}

// exchangeCopilotToken trades the GitHub user token for the Copilot api
// token model calls carry (copilot_internal/v2/token). The api token lasts
// ~30 minutes; refresh_in says when to come back.
async function exchangeCopilotToken(githubToken, base) {
  const res = await fetch((base ?? GITHUB_API_BASE()) + "/copilot_internal/v2/token", {
    headers: {
      Authorization: `token ${githubToken}`,
      "User-Agent": USER_AGENT,
      "Editor-Version": EDITOR_VERSION,
      "Editor-Plugin-Version": PLUGIN_VERSION,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(30_000),
  })
  if (res.status === 401)
    throw Object.assign(new Error("GitHub token 已失效，请重新登录 Copilot"), { signIn: "expired" })
  if (!res.ok) throw new Error(`copilot_internal/v2/token 失败：HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
  const j = await res.json()
  if (!j.token) throw new Error("copilot_internal/v2/token 响应缺少 token 字段")
  // expires_at is unix seconds; magpie's auth.expires is unix ms
  return {
    access: j.token,
    refresh: githubToken, // the GitHub user token IS the refresh credential
    expires: (j.expires_at ?? Math.floor(Date.now() / 1000) + 1500) * 1000,
    sku: j.sku,
    limited_user_quotas: j.limited_user_quotas,
    limited_user_reset_date: j.limited_user_reset_date,
    trackingId: j.tracking_id,
    endpoints: j.endpoints,
  }
}

// fetchCatalog reads /models with the api token and returns id → entry.
// The entry's supported_endpoints decides which wire the model takes.
async function fetchCatalog(token, base) {
  const res = await fetch((base ?? API_BASE()) + "/models", {
    headers: apiHeaders(token, { Accept: "application/json" }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`Copilot /models 失败：HTTP ${res.status}`)
  const j = await res.json()
  const out = new Map()
  for (const m of j.data ?? []) {
    if (!m?.id) continue
    out.set(m.id, m)
  }
  return out
}

// ── model table ────────────────────────────────────────────────────────────

// The static floor: models that exist and, on a free account with the VS
// identity, are known-usable. The catalog gate (which models show at all)
// is the account's entitlement — kimi-k3 is present in the catalog but a
// given account may not be allowed it — so models() intersects this table
// with what /models names. Entries here only supply display metadata.
const SAFE_FALLBACK_MODELS = {
  "gpt-4o": { name: "GPT-4o" },
  "gpt-4o-mini": { name: "GPT-4o mini" },
  "gpt-4o-2024-11-20": { name: "GPT-4o (2024-11-20)" },
  "gpt-4o-2024-08-06": { name: "GPT-4o (2024-08-06)" },
  "gpt-4o-2024-05-13": { name: "GPT-4o (2024-05-13)" },
  "gpt-4o-mini-2024-07-18": { name: "GPT-4o mini (2024-07-18)" },
}

const KNOWN_MODELS = {
  "gpt-6.1-sol": { name: "GPT-6.1 Sol" },
  "gpt-6-luna": { name: "GPT-6 Luna" },
  "gpt-6-sol": { name: "GPT-6 Sol" },
  "gpt-6-astra": { name: "GPT-6 Astra" },
  "gpt-5.6-luna": { name: "GPT-5.6 Luna" },
  "gpt-5.6-luna-utility": { name: "GPT-5.6 Luna Utility" },
  "gpt-5.6-sol": { name: "GPT-5.6 Sol" },
  "gpt-5.6-terra": { name: "GPT-5.6 Terra" },
  "gpt-5.5": { name: "GPT-5.5" },
  "gpt-5.4": { name: "GPT-5.4" },
  "gpt-5.4-mini": { name: "GPT-5.4 Mini" },
  "gpt-5.3-codex": { name: "GPT-5.3 Codex" },
  "gpt-5-mini": { name: "GPT-5 mini" },
  "gpt-4.1": { name: "GPT-4.1" },
  "gpt-4.1-2025-04-14": { name: "GPT-4.1 (2025-04-14)" },
  "gpt-4o": { name: "GPT-4o" },
  "gpt-4o-mini": { name: "GPT-4o mini" },
  "gpt-4o-2024-11-20": { name: "GPT-4o (2024-11-20)" },
  "gpt-4o-2024-08-06": { name: "GPT-4o (2024-08-06)" },
  "gpt-4o-2024-05-13": { name: "GPT-4o (2024-05-13)" },
  "gpt-4o-mini-2024-07-18": { name: "GPT-4o mini (2024-07-18)" },
  "gpt-4": { name: "GPT-4" },
  "gpt-4-0613": { name: "GPT-4 (0613)" },
  "gpt-4-0125-preview": { name: "GPT-4 (0125 preview)" },
  "gpt-3.5-turbo": { name: "GPT-3.5 Turbo" },
  "gpt-3.5-turbo-0613": { name: "GPT-3.5 Turbo (0613)" },
  "kimi-k3": { name: "Kimi K3" },
  "kimi-k2.7-code": { name: "Kimi K2.7 Code" },
  "mai-code-1.1-flash": { name: "MAI-Code-1.1 Flash" },
  "mai-code-1-flash-4th": { name: "MAI-Code-1 Flash (4th)" },
  "mai-code-1-flash-secondary": { name: "MAI-Code-1 Flash (secondary)" },
  "mai-code-1-flash-tertiary": { name: "MAI-Code-1 Flash (tertiary)" },
  "gemini-3.8-flash": { name: "Gemini 3.8 Flash" },
  "gemini-3.7-flash": { name: "Gemini 3.7 Flash" },
  "gemini-3.6-flash": { name: "Gemini 3.6 Flash" },
  "gemini-3.5-flash": { name: "Gemini 3.5 Flash" },
  "gemini-4-argon": { name: "Gemini 4 Argon" },
}

// models the catalog exposes but a free account can never call (measured
// 2026-10: the -auto id answers model_not_supported at every identity).
const NEVER_CALLABLE = /^gpt-5\.6-luna-free-auto$/

// ── the plugin ─────────────────────────────────────────────────────────────

export async function CopilotAuthPlugin({ client } = {}) {
  const catalogs = new Map()
  const tokenCache = new Map()
  const renewing = new Map()
  const CACHE_LIMIT = 16

  const remember = (cache, key, value) => {
    cache.delete(key)
    cache.set(key, value)
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value)
  }

  async function getCatalog(githubToken, apiToken) {
    const cached = catalogs.get(githubToken)
    if (cached && Date.now() - cached.at < CATALOG_TTL_MS) {
      remember(catalogs, githubToken, cached)
      return cached.value
    }
    const value = await fetchCatalog(apiToken)
    remember(catalogs, githubToken, { value, at: Date.now() })
    return value
  }

  async function renewOf(githubToken, force = false) {
    const cached = tokenCache.get(githubToken)
    if (!force && cached && cached.expires - Date.now() > REFRESH_LEAD_MS) {
      remember(tokenCache, githubToken, cached)
      return cached
    }
    let run = renewing.get(githubToken)
    if (!run) {
      run = exchangeCopilotToken(githubToken)
        .then((next) => {
          remember(tokenCache, githubToken, next)
          return next
        })
        .finally(() => renewing.delete(githubToken))
      renewing.set(githubToken, run)
    }
    return run
  }

  // The GitHub user token is the stable per-account key; API tokens are
  // short-lived and must never be reused across account snapshots.
  async function freshAccess(auth) {
    const githubToken = auth?.refresh || auth?.access
    if (!githubToken) throw Object.assign(new Error("缺少登录态：请先登录 Copilot"), { signIn: "expired" })
    const cached = tokenCache.get(githubToken)
    if (cached && cached.expires - Date.now() > REFRESH_LEAD_MS) {
      if (!auth?.expires || cached.expires > auth.expires || cached.access !== auth.access) {
        remember(tokenCache, githubToken, cached)
        return cached.access
      }
    }
    if (auth?.access && auth.expires && auth.expires - Date.now() > REFRESH_LEAD_MS) {
      if (!cached || auth.expires > cached.expires) {
        remember(tokenCache, githubToken, { access: auth.access, expires: auth.expires, refresh: githubToken })
      }
      return tokenCache.get(githubToken)?.access ?? auth.access
    }
    return (await renewOf(githubToken)).access
  }

  const infoOf = (githubToken) => renewOf(githubToken, true)

  return {
    auth: {
      provider: ID,
      async loader(getAuth) {
        return {
          baseURL: API_BASE(),
          apiKey: "copilot",
          async fetch(input, init = {}) {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
            const requestUrl = new URL(url)
            const pathname = requestUrl.pathname
            const requestPath = pathname.replace(/\/+$/, "")

            let auth
            try {
              auth = await getAuth()
            } catch (e) {
              return errorResponse(401, String(e?.message ?? e))
            }
            if (!auth?.access && !auth?.refresh) return errorResponse(401, "缺少登录态：请先登录 Copilot")
            const githubToken = auth.refresh || auth.access

            let token
            try {
              token = await freshAccess(auth)
            } catch (e) {
              return errorResponse(e?.signIn === "expired" ? 401 : 502, String(e?.message ?? e))
            }

            let entry
            if (requestPath !== "/chat/completions") {
              try {
                entry = (await getCatalog(githubToken, token)).get(pathModelName(pathname, await bodyText(input, init)))
              } catch {
                entry = undefined
              }
            }

            return forward(input, init, token, entry)
          },
        }
      },

      // magpie's idle renewal: re-exchange the api token ahead of expiry.
      // The GitHub user token never expires (device-flow user tokens don't
      // until revoked), so this always succeeds while the sign-in lives.
      async refresh(auth) {
        if (auth?.type !== "oauth" || !auth.refresh) return undefined
        const next = await renewOf(auth.refresh, true)
        return { access: next.access, refresh: auth.refresh, expires: next.expires }
      },
      refreshLead: REFRESH_LEAD_MS,

      async usage(getAuth) {
        let auth
        try {
          auth = await getAuth()
        } catch {
          return { error: "缺少登录态", signIn: "kept" }
        }
        const githubToken = auth?.refresh || auth?.access
        if (!githubToken) return { error: "缺少登录态", signIn: "kept" }
        try {
          // the token exchange IS the quota read: free accounts carry
          // limited_user_quotas ({ chat: 199, completions: 2000 }) and
          // limited_user_reset_date (unix seconds) on the same response —
          // the counts are what is LEFT of the free monthly allowance
          // (200 chats / 2000 completions; measured 2026-10-28: the value
          // fell 200 → 199 as the account was used), and paid accounts
          // carry neither field. One call, then; a second fetch would be
          // the same JSON for another exchange's worth of rate limit.
          let info
          try {
            info = await renewOf(githubToken, true)
          } catch (error) {
            return {
              error: String(error?.message ?? error),
              signIn: error?.signIn === "expired" ? "expired" : "kept",
            }
          }
          const j = {
            token: info.access,
            expires_at: info.expires / 1000,
            sku: info.sku,
            limited_user_quotas: info.limited_user_quotas,
            limited_user_reset_date: info.limited_user_reset_date,
          }
          remember(tokenCache, githubToken, info)

          const plan = j.sku === "free_limited_copilot" ? "Copilot Free" : NAME
          const left = j.limited_user_quotas ?? null
          const resetSec = j.limited_user_reset_date ?? 0
          if (!left) {
            // paid SKU: no metered window to show
            return { plan, user: auth.accountId || auth.uid || "Copilot 账号", windows: [] }
          }
          // the free allowance's full size, by window key
          const FULL = { chat: 200, completions: 2000 }
          const windows = []
          const names = { chat: "Chat 额度", completions: "补全额度" }
          for (const key of Object.keys(FULL)) {
            if (typeof left[key] !== "number") continue
            const remaining = left[key]
            const total = FULL[key]
            const used = Math.max(0, total - remaining)
            const w = {
              name: names[key],
              used: (100 * used) / total,
              amount: used,
              limit: total,
              display: `${remaining} / ${total}`,
              aside: true,
            }
            if (resetSec > 0) w.resetsAt = new Date(resetSec * 1000).toISOString()
            windows.push(w)
          }
          return {
            plan,
            user: auth.accountId || auth.uid || "Copilot 账号",
            windows,
          }
        } catch (e) {
          return { error: String(e?.message ?? e), signIn: "kept" }
        }
      },

      methods: [
        {
          type: "oauth",
          label: "GitHub 设备流登录（Device sign-in）",
          authorize: async () => {
            // authorize failures throw: magpie stores authorize's return as
            // the sign-in session and calls its callback() verbatim, so a
            // {type:"failed"} without a callback crashes the sign-in with
            // "s.a.callback is not a function" instead of showing the error
            const device = await requestDeviceCode()
            return {
              url: device.verification_uri ?? "https://github.com/login/device",
              instructions: `在浏览器打开上面的地址并输入代码 ${device.user_code} 完成授权（约 15 分钟内有效）。授权后本插件自动继续，无需手动输入。`,
              method: "auto",
              callback: async () => {
                const githubToken = await pollDeviceToken(device)
                // trade for the api token right away: a failed exchange
                // should fail the sign-in, not the first chat
                const first = await exchangeCopilotToken(githubToken)
                remember(tokenCache, githubToken, first)
                // the GitHub login name for the account card; failing it
                // does not fail the sign-in
                let accountId = "GitHub 账号"
                try {
                  const res = await fetch(GITHUB_API_BASE() + "/user", {
                    headers: { Authorization: `token ${githubToken}`, Accept: "application/json", "User-Agent": USER_AGENT },
                    signal: AbortSignal.timeout(15_000),
                  })
                  const j = await res.json()
                  if (j?.login) accountId = j.login
                } catch {}
                return {
                  type: "success",
                  refresh: githubToken,
                  access: first.access,
                  expires: first.expires,
                  accountId,
                  sku: first.sku,
                }
              },
            }
          },
        },
        {
          type: "oauth",
          label: "手动粘贴 GitHub token（Paste GitHub token）",
          prompts: [
            {
              type: "text",
              key: "token",
              message: "GitHub user access token（需要 Copilot 权益；gho_/ghp_ 开头）",
              validate: (v) => (v && v.trim() ? undefined : "必填"),
            },
          ],
          authorize: async (inputs) => {
            const githubToken = String(inputs?.token ?? "").trim()
            if (!githubToken) throw new Error("token 必填")
            // the exchange runs here so its error is this method's error;
            // the success is handed back through a callback, which magpie's
            // sign-in flow always calls (authorize's return is the session)
            const first = await exchangeCopilotToken(githubToken)
            remember(tokenCache, githubToken, first)
            return {
              url: "",
              instructions: "",
              method: "auto",
              callback: async () => ({
                type: "success",
                refresh: githubToken,
                access: first.access,
                expires: first.expires,
                accountId: "手动粘贴",
                sku: first.sku,
              }),
            }
          },
        },
      ],
    },

    // the account's own list from /models, as magpie's provider.models hook
    // expects it: a top-level provider block, an id → model dictionary
    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        const githubToken = auth?.refresh || auth?.access
        if (!githubToken) return provider.models ?? {}
        let cat
        try {
          const token = await freshAccess(auth)
          cat = await getCatalog(githubToken, token)
        } catch {
          cat = catalogs.get(githubToken)?.value
          if (!cat) return { ...SAFE_FALLBACK_MODELS }
        }
        const out = {}
        for (const [id, m] of cat) {
          if (NEVER_CALLABLE.test(id) || m.policy?.state === "disabled") continue
          if ((m.capabilities?.type ?? "chat") !== "chat") continue
          if (id.startsWith("copilot-search") || id.startsWith("exec-agent") || id.startsWith("trajectory")) continue
          out[id] = { name: KNOWN_MODELS[id]?.name ?? m.display_name ?? id }
        }
        return out
      },
    },

    async config(config) {
      config.provider ??= {}
      const was = config.provider[ID] ?? {}
      config.provider[ID] = {
        name: NAME,
        // Responses wire: magpie sends /responses shapes, which the luna/sol
        // family speaks natively; chat-completions-only models are rewritten
        // inside fetch() below.
        npm: "@ai-sdk/openai",
        api: API_BASE(),
        ...was,
        // the static floor. The dynamic probe (provider.models) refines this
        // to the account's own catalog when it can; magpie's own SDK list
        // fetch (GET /models without the Copilot identity headers) answers
        // 400 at the gateway, so without these the provider shows nothing.
        models: { ...Object.fromEntries(Object.entries(KNOWN_MODELS).map(([id, m]) => [id, { name: m.name }])), ...(was.models ?? {}) },
      }
    },
  }
}

// pathModelName picks the model a request is for: /responses and
// /chat/completions both carry it in the body.
function pathModelName(pathname, body) {
  try {
    const j = JSON.parse(body || "{}")
    return typeof j.model === "string" ? j.model.replace(/^.*\//, "") : ""
  } catch {
    return ""
  }
}

// forward sends the request upstream with the fresh token, rewriting the
// wire for models whose catalog entry says /chat/completions.
async function forward(input, init, token, entry) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const u = new URL(url)
  const raw = await bodyText(input, init)
  const requestPath = u.pathname.replace(/\/+$/, "")
  if (requestPath === "/chat/completions") {
    return fetch(API_BASE() + u.pathname + u.search, {
      method: init.method ?? "POST",
      headers: apiHeaders(token),
      body: raw,
      signal: init.signal,
    })
  }
  const endpoints = entry?.supported_endpoints ?? entry?.endpoints
  // An entry naming /responses is sent directly. Chat-only or unknown entries
  // use the Responses→Chat bridge; a missing catalog falls back to /responses.
  const wantsChat = entry !== undefined && !(Array.isArray(endpoints) && endpoints.includes("/responses"))

  let upstream
  if (wantsChat) {
    // Responses-shape → chat-completions shape, minimal: input items carry
    // role/content; tools pass through as functions.
    let body
    try {
      body = JSON.parse(raw || "{}")
    } catch {
      return errorResponse(400, "请求体不是 JSON")
    }
    let messages
    let tools
    try {
      messages = messagesOf(body)
      tools = Array.isArray(body.tools) && body.tools.length ? toolsOf(body.tools) : undefined
    } catch (error) {
      return errorResponse(400, String(error?.message ?? error))
    }
    const chat = {
      model: body.model,
      messages,
      stream: body.stream ?? false,
    }
    if (tools) chat.tools = tools
    if (body.stream) chat.stream_options = { include_usage: true }
    if (body.max_output_tokens != null) chat.max_tokens = body.max_output_tokens
    for (const key of ["temperature", "top_p", "tool_choice", "parallel_tool_calls"]) {
      if (body[key] !== undefined) chat[key] = body[key]
    }
    upstream = await fetch(API_BASE() + "/chat/completions", {
      method: "POST",
      headers: apiHeaders(token),
      body: JSON.stringify(chat),
      signal: init.signal,
    })
    // chat → Responses response, so magpie's Responses parser sees one shape
    return toResponses(upstream, body.model, body.stream, init.signal)
  }

  upstream = await fetch(API_BASE() + u.pathname + u.search, {
    method: init.method ?? "POST",
    headers: apiHeaders(token),
    body: raw,
    signal: init.signal,
  })
  return upstream
}

// messagesOf flattens Responses input items into chat messages.
function messagesOf(body) {
  if (!Array.isArray(body.input) && Array.isArray(body.messages)) {
    return body.instructions ? [{ role: "system", content: body.instructions }, ...body.messages] : body.messages
  }
  const items = Array.isArray(body.input) ? body.input : typeof body.input === "string" ? [{ role: "user", content: body.input }] : []
  const out = []
  if (body.instructions) out.push({ role: "system", content: body.instructions })
  for (const it of items) {
    if (!it || typeof it !== "object") continue
    if (it.type === "reasoning") continue
    if (it.type === "function_call") {
      const call = {
        id: it.call_id ?? it.id,
        type: "function",
        function: { name: it.name ?? "", arguments: typeof it.arguments === "string" ? it.arguments : JSON.stringify(it.arguments ?? {}) },
      }
      const previous = out.at(-1)
      if (previous?.role === "assistant" && Array.isArray(previous.tool_calls)) previous.tool_calls.push(call)
      else out.push({ role: "assistant", tool_calls: [call] })
      continue
    }
    if (it.type === "function_call_output") {
      const content = typeof it.output === "string" ? it.output : JSON.stringify(it.output ?? "")
      out.push({ role: "tool", tool_call_id: it.call_id ?? it.id, content })
      continue
    }
    const role = it.role ?? "user"
    let content = ""
    if (typeof it.content === "string") content = it.content
    else if (Array.isArray(it.content)) {
      const unsupported = it.content.find((part) => typeof part === "object" && part !== null && part.type !== "input_text" && part.type !== "text")
      if (unsupported) throw new Error(`聊天端点不支持 Responses 内容类型：${unsupported.type ?? "unknown"}`)
      content = it.content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("")
    }
    else if (it.content != null) content = String(it.content)
    out.push({ role, content })
  }
  return out
}

// toolsOf turns Responses function tools into chat function tools.
function toolsOf(tools) {
  const unsupported = tools.find((tool) => tool.type !== "function")
  if (unsupported) throw new Error(`不支持的 Responses 工具类型：${unsupported.type ?? "unknown"}`)
  return tools.map((tool) =>
    tool.function
      ? tool
      : { type: "function", function: { name: tool.name, description: tool.description ?? "", parameters: tool.parameters ?? { type: "object", properties: {} } } },
  )
}

// toResponses rewrites a chat-completions answer into a Responses answer
// (non-streaming) or passes a stream through with its frames translated.
async function toResponses(upstream, model, stream, signal) {
  if (!stream) {
    const j = await upstream.json().catch(() => null)
    if (!upstream.ok || !j)
      return new Response(JSON.stringify(j ?? { error: { message: `Copilot HTTP ${upstream.status}` } }), {
        status: upstream.status,
        headers: { "content-type": "application/json" },
      })
    const choice = j.choices?.[0] ?? {}
    const msg = choice.message ?? {}
    const output = []
    if (msg.content != null && msg.content !== "") {
      output.push({
        type: "message",
        id: "msg_" + crypto.randomUUID(),
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: msg.content, annotations: [] }],
      })
    }
    for (const call of msg.tool_calls ?? []) {
      output.push({
        type: "function_call",
        id: "fc_" + crypto.randomUUID(),
        call_id: call.id,
        name: call.function?.name ?? "",
        arguments: call.function?.arguments ?? "{}",
        status: "completed",
      })
    }
    const incomplete = choice.finish_reason === "length"
    const out = {
      id: j.id ?? "resp_" + crypto.randomUUID(),
      object: "response",
      created_at: Math.floor(j.created ?? Date.now() / 1000),
      status: incomplete ? "incomplete" : "completed",
      model: j.model ?? model,
      output,
      ...(incomplete ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
      usage: j.usage
        ? {
            input_tokens: j.usage.prompt_tokens ?? 0,
            output_tokens: j.usage.completion_tokens ?? 0,
            total_tokens: j.usage.total_tokens ?? 0,
          }
        : undefined,
    }
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } })
  }
  const contentType = upstream.headers.get("content-type") ?? ""
  if (!upstream.ok || !contentType.includes("text/event-stream")) {
    const text = await upstream.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {
      body = { error: { message: text || `Copilot HTTP ${upstream.status}` } }
    }
    return new Response(JSON.stringify(body), {
      status: upstream.status,
      headers: { "content-type": "application/json" },
    })
  }

  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const reader = upstream.body.getReader()
  const id = "resp_" + crypto.randomUUID().replace(/-/g, "").slice(0, 24)
  const output = []
  const toolCalls = new Map()
  const textItemId = "msg_" + crypto.randomUUID()
  let textOutputIndex = -1
  let textStarted = false
  let text = ""
  let usage
  let terminalStatus = "completed"
  let completed = false
  let sequence = 0
  const streamOut = new ReadableStream({
    async start(controller) {
      const send = (obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify({ sequence_number: sequence++, ...obj })}\n\n`))
      const begin = () => send({
        type: "response.created",
        response: { id, object: "response", status: "in_progress", model, output: [] },
      })
      const finish = (status = terminalStatus, finalUsage = usage) => {
        if (completed) return
        if (textStarted) {
          const textItem = output.find((item) => item.id === textItemId)
          textItem.status = status === "incomplete" ? "incomplete" : "completed"
          send({ type: "response.output_text.done", item_id: textItemId, output_index: textOutputIndex, content_index: 0, text })
          send({ type: "response.content_part.done", item_id: textItemId, output_index: textOutputIndex, content_index: 0, part: { type: "output_text", text, annotations: [] } })
          const msg = output.find((item) => item.id === textItemId)
          msg.content = [{ type: "output_text", text, annotations: [] }]
          send({ type: "response.output_item.done", output_index: textOutputIndex, item: msg })
        }
        for (const call of toolCalls.values()) {
          send({ type: "response.function_call_arguments.done", item_id: call.item.id, output_index: call.outputIndex, arguments: call.arguments })
          call.item.arguments = call.arguments
          call.item.status = status === "incomplete" ? "incomplete" : "completed"
          send({ type: "response.output_item.done", output_index: call.outputIndex, item: call.item })
        }
        send({
          type: status === "incomplete" ? "response.incomplete" : "response.completed",
          response: {
            id,
            object: "response",
            status,
            model,
            output,
            ...(status === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
            ...(finalUsage ? { usage: { input_tokens: finalUsage.prompt_tokens ?? 0, output_tokens: finalUsage.completion_tokens ?? 0, total_tokens: finalUsage.total_tokens ?? 0 } } : {}),
          },
        })
        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        completed = true
        controller.close()
      }
      const processLine = (line) => {
        if (!line.startsWith("data:")) return
        const data = line.slice(5).trim()
        if (data === "[DONE]") {
          finish()
          return
        }
        let chunk
        try {
          chunk = JSON.parse(data)
        } catch {
          return
        }
        const choice = chunk.choices?.[0]
        if (chunk.usage) usage = chunk.usage
        if (!choice) return
        const delta = choice.delta ?? {}
        if (choice.finish_reason === "length") terminalStatus = "incomplete"
        if (completed) return
        if (delta.content) {
          if (!textStarted) {
            textStarted = true
            const item = { type: "message", id: textItemId, role: "assistant", status: "in_progress", content: [] }
            textOutputIndex = output.length
            item.outputIndex = textOutputIndex
            output.push(item)
            send({ type: "response.output_item.added", output_index: textOutputIndex, item })
            send({ type: "response.content_part.added", item_id: textItemId, output_index: textOutputIndex, content_index: 0, part: { type: "output_text", text: "", annotations: [] } })
          }
          text += delta.content
          send({ type: "response.output_text.delta", item_id: textItemId, output_index: textOutputIndex, content_index: 0, delta: delta.content })
        }
        for (const toolDelta of delta.tool_calls ?? []) {
          const index = toolDelta.index ?? 0
          let call = toolCalls.get(index)
          if (!call) {
            const item = {
              type: "function_call",
              id: "fc_" + crypto.randomUUID(),
              call_id: toolDelta.id ?? "call_" + crypto.randomUUID(),
              name: toolDelta.function?.name ?? "",
              arguments: "",
              status: "in_progress",
            }
            call = { item, arguments: "", outputIndex: output.length }
            toolCalls.set(index, call)
            output.splice(call.outputIndex, 0, item)
            for (const other of toolCalls.values()) {
              if (other !== call && other.outputIndex >= call.outputIndex) other.outputIndex += 1
            }
            send({ type: "response.output_item.added", output_index: call.outputIndex, item })
          }
          if (toolDelta.id) call.item.call_id = toolDelta.id
          if (toolDelta.function?.name) call.item.name = toolDelta.function.name
          if (toolDelta.function?.arguments) {
            call.arguments += toolDelta.function.arguments
            send({ type: "response.function_call_arguments.delta", item_id: call.item.id, output_index: call.outputIndex, delta: toolDelta.function.arguments })
          }
        }
      }

      try {
        begin()
        let buffered = ""
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffered += decoder.decode(value, { stream: true })
          const lines = buffered.split("\n")
          buffered = lines.pop() ?? ""
          for (const line of lines) processLine(line)
          if (completed) {
            await reader.cancel()
            return
          }
        }
        buffered += decoder.decode()
        if (buffered.trim()) processLine(buffered)
        if (!completed) finish(terminalStatus, usage)
      } catch (e) {
        if (!signal?.aborted) send({ type: "response.failed", response: { id, status: "failed", error: { message: String(e?.message ?? e) } } })
        controller.error(e)
      }
    },
  })
  return new Response(streamOut, { status: upstream.status, headers: { "content-type": "text/event-stream" } })
}

// for tests
export const _internal = {
  ID,
  NAME,
  CLIENT_ID,
  INTEGRATION_ID,
  KNOWN_MODELS,
  NEVER_CALLABLE,
  requestDeviceCode,
  pollDeviceToken,
  exchangeCopilotToken,
  fetchCatalog,
  messagesOf,
  toolsOf,
  toResponses,
}
