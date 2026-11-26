import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fakeAutoClaw } from "./fake.mjs"
import { _internal } from "./index.mjs"
import { runWeb, authFilePath, withAuthLock } from "./web.mjs"

// Every case runs against fake.mjs and a mkdtemp credentials file: no network,
// no real browser, and never the real ~/.config/magpie/plugin-auth.json.

let fake
let root
let authFile

// captured when this file starts, so another test file's env is restored too
let previousEnv = {}

const restoreEnv = (name) => {
  if (previousEnv[name] === undefined) delete process.env[name]
  else process.env[name] = previousEnv[name]
}

const nowSec = () => Math.floor(Date.now() / 1000)

const writeAuth = (entries) => writeFileSync(authFile, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 })
const readAuth = () => JSON.parse(readFileSync(authFile, "utf8"))

// one account record in magpie's storage shape
const entry = (over = {}) => ({
  type: "oauth",
  access: fake.state.access,
  refresh: fake.state.refresh,
  deviceId: fake.state.deviceId,
  expires: Date.now() + 3600e3,
  accountId: "185****9906",
  ...over,
})

// stub streams + a fake opener: nothing here ever touches a real browser
function harness({ now, opener } = {}) {
  const out = []
  const err = []
  const opened = []
  const open = opener ?? (async (url) => {
    opened.push(url)
    return true
  })
  const run = (argv) =>
    runWeb(argv, {
      ...(now ? { now } : {}),
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      opener: open,
    })
  return { run, stdout: () => out.join(""), stderr: () => err.join(""), opened }
}

const linesOf = (text) => text.replace(/\n+$/, "").split("\n")

beforeAll(() => {
  previousEnv = {
    AUTOCLAW_AUTH_FILE: process.env.AUTOCLAW_AUTH_FILE,
    AUTOCLAW_USERAPI_BASE_URL: process.env.AUTOCLAW_USERAPI_BASE_URL,
    AUTOCLAW_WEB_BASE_URL: process.env.AUTOCLAW_WEB_BASE_URL,
  }
  fake = fakeAutoClaw()
  root = mkdtempSync(join(tmpdir(), "autoclaw-web-test-"))
  authFile = join(root, "magpie", "plugin-auth.json")
  mkdirSync(dirname(authFile), { recursive: true })
  process.env.AUTOCLAW_AUTH_FILE = authFile
  process.env.AUTOCLAW_USERAPI_BASE_URL = fake.base
})

afterAll(() => {
  fake.server.stop(true)
  rmSync(root, { recursive: true, force: true })
  restoreEnv("AUTOCLAW_AUTH_FILE")
  restoreEnv("AUTOCLAW_USERAPI_BASE_URL")
  restoreEnv("AUTOCLAW_WEB_BASE_URL")
})

beforeEach(() => {
  fake.state.reset()
  fake.state.access = fake.jwt(nowSec() + 3600, fake.state.userId, fake.state.deviceId)
  fake.state.refresh = "refresh-1"
  process.env.AUTOCLAW_AUTH_FILE = authFile
  process.env.AUTOCLAW_USERAPI_BASE_URL = fake.base
  delete process.env.AUTOCLAW_WEB_BASE_URL
  rmSync(authFile, { force: true })
  rmSync(`${authFile}.lock`, { force: true })
  rmSync(`${authFile}.${process.pid}.tmp`, { recursive: true, force: true })
})

describe("credential location", () => {
  test("follows AUTOCLAW_AUTH_FILE → AUTOCLAW_CONFIG_DIR → XDG → HOME → USERPROFILE", () => {
    const saved = {
      auth: process.env.AUTOCLAW_AUTH_FILE,
      dir: process.env.AUTOCLAW_CONFIG_DIR,
      xdg: process.env.XDG_CONFIG_HOME,
      home: process.env.HOME,
      profile: process.env.USERPROFILE,
    }
    try {
      delete process.env.AUTOCLAW_AUTH_FILE
      delete process.env.AUTOCLAW_CONFIG_DIR
      delete process.env.XDG_CONFIG_HOME
      process.env.HOME = "C:/tmp/home"
      process.env.USERPROFILE = "C:/Users/example"
      expect(authFilePath()).toBe(join("C:/tmp/home", ".config", "magpie", "plugin-auth.json"))

      process.env.XDG_CONFIG_HOME = "C:/tmp/xdg"
      expect(authFilePath()).toBe(join("C:/tmp/xdg", "magpie", "plugin-auth.json"))

      process.env.AUTOCLAW_CONFIG_DIR = "C:/tmp/cfg"
      expect(authFilePath()).toBe(join("C:/tmp/cfg", "plugin-auth.json"))

      process.env.AUTOCLAW_AUTH_FILE = "C:/tmp/explicit.json"
      expect(authFilePath()).toBe("C:/tmp/explicit.json")

      // an empty HOME must not become a drive root (C:\.config)
      delete process.env.AUTOCLAW_AUTH_FILE
      delete process.env.AUTOCLAW_CONFIG_DIR
      delete process.env.XDG_CONFIG_HOME
      process.env.HOME = ""
      expect(authFilePath()).toBe(join("C:/Users/example", ".config", "magpie", "plugin-auth.json"))
      expect(authFilePath().startsWith("C:/.config")).toBe(false)
    } finally {
      for (const [name, value] of [
        ["AUTOCLAW_AUTH_FILE", saved.auth],
        ["AUTOCLAW_CONFIG_DIR", saved.dir],
        ["XDG_CONFIG_HOME", saved.xdg],
        ["HOME", saved.home],
        ["USERPROFILE", saved.profile],
      ]) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })
})

describe("printing the link", () => {
  test("a token outside REFRESH_LEAD prints the link without renewing or writing", async () => {
    const access = fake.state.access
    writeAuth({ autoclaw: entry() })
    const before = statSync(authFile).mtimeMs

    const h = harness()
    expect(await h.run(["--print"])).toBe(0)

    expect(fake.state.refreshCalls.length).toBe(0)
    const lines = linesOf(h.stdout())
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe("账号：185****9906（autoclaw）")
    expect(lines[1]).toBe(`链接：${_internal.webEntryUrl(access)}`)
    expect(lines[1]).toContain(encodeURIComponent(access))
    expect(lines[2].startsWith("有效至：")).toBe(true)
    expect(lines[2].endsWith("（北京时间）")).toBe(true)
    // no write-back happened, and no lock was left behind
    expect(statSync(authFile).mtimeMs).toBe(before)
    expect(existsSync(`${authFile}.lock`)).toBe(false)
    expect(h.opened.length).toBe(0)
  })

  test("a near-expiry token renews, prints the new link and is written back", async () => {
    // a distinct stale JWT (the fake would mint the same token for the same second)
    const stale = fake.jwt(nowSec() + 120, fake.state.userId, fake.state.deviceId)
    writeAuth({ autoclaw: entry({ access: stale, expires: Date.now() + 60_000 }) })

    const h = harness()
    expect(await h.run(["--print"])).toBe(0)

    expect(fake.state.refreshCalls.length).toBe(1)
    expect(h.stdout()).toContain(`链接：${_internal.webEntryUrl(fake.state.access)}`)
    expect(h.stdout()).not.toContain(`链接：${_internal.webEntryUrl(stale)}`)

    const saved = readAuth().autoclaw
    expect(saved.access).toBe(fake.state.access)
    expect(saved.refresh).toBe(fake.state.refresh)
    expect(saved.expires).toBe(_internal.jwtEnd(fake.state.access))
    // only the three token fields change: the display label survives
    expect(saved.accountId).toBe("185****9906")
    expect(existsSync(`${authFile}.lock`)).toBe(false)
  })

  test("a failed renewal keeps printing while the token is alive, and exits 2 once it is gone", async () => {
    const access = fake.jwt(nowSec() + 120, fake.state.userId, fake.state.deviceId)
    // a refresh the fake rejects (401): the renewal throws, the access still lives
    writeAuth({ autoclaw: entry({ access, refresh: "wrong-refresh", expires: Date.now() + 120_000 }) })
    let h = harness()
    expect(await h.run(["--print"])).toBe(0)
    expect(fake.state.refreshCalls.length).toBe(1)
    expect(h.stdout()).toContain(`链接：${_internal.webEntryUrl(access)}`)
    expect(h.stderr()).toContain("续期失败")

    // the same failure with an already-expired access is a sign-in problem
    writeAuth({ autoclaw: entry({ access, refresh: "wrong-refresh", expires: Date.now() - 1000 }) })
    h = harness()
    expect(await h.run(["--print"])).toBe(2)
    expect(h.stderr()).toContain("登录态已失效")
    expect(h.stdout()).toBe("")
  })

  test("--base overrides the web host for this run only", async () => {
    writeAuth({ autoclaw: entry() })
    const h = harness()
    expect(await h.run(["--print", "--base", "https://web.example.test/"])).toBe(0)
    expect(h.stdout()).toContain(`链接：https://web.example.test/?autoglm_token=`)
    // the override never leaks into the process (or the next call)
    expect(process.env.AUTOCLAW_WEB_BASE_URL).toBeUndefined()
    expect(_internal.webEntryUrl(fake.state.access).startsWith("https://autoglm.zhipuai.cn/")).toBe(true)
  })

  test("a token with no refresh and no exp claim is printed as-is", async () => {
    const access = "opaque-token-without-jwt"
    writeAuth({ autoclaw: entry({ access, refresh: "", expires: 0 }) })
    const h = harness()
    expect(await h.run(["--print"])).toBe(0)
    expect(fake.state.refreshCalls.length).toBe(0)
    expect(h.stdout()).toContain(`链接：${_internal.webEntryUrl(access)}`)
    expect(h.stdout()).toContain("有效至：未知")
  })

  test("a token with no refresh and inside REFRESH_LEAD warns about the remaining minutes", async () => {
    const access = fake.state.access
    const expires = Date.now() + 120_000
    writeAuth({ autoclaw: entry({ refresh: "", expires }) })
    // a fixed clock, so the printed remainder is exact
    const h = harness({ now: () => expires - 120_000 })
    expect(await h.run(["--print"])).toBe(0)
    expect(fake.state.refreshCalls.length).toBe(0)
    expect(h.stdout()).toContain(`链接：${_internal.webEntryUrl(access)}`)
    expect(h.stderr()).toContain("剩余 2 分钟，链接即将失效")
  })
})

describe("write-back under the host lock", () => {
  test("another account's record survives a renewal write-back", async () => {
    const other = { type: "oauth", access: "other-access", refresh: "other-refresh", expires: Date.now() + 3600e3, accountId: "138****8000" }
    writeAuth({ "autoclaw#9q9l5x": other, autoclaw: entry({ expires: Date.now() + 60_000 }) })

    const h = harness()
    expect(await h.run(["--print"])).toBe(0)

    const after = readAuth()
    expect(after["autoclaw#9q9l5x"]).toEqual(other)
    expect(after.autoclaw.access).toBe(fake.state.access)
  })

  test("the lock file exists for the whole critical section and is removed after", async () => {
    writeAuth({ autoclaw: entry() })
    let held = false
    let content = ""
    await withAuthLock(authFile, async () => {
      held = existsSync(`${authFile}.lock`)
      content = readFileSync(authFile, "utf8")
    })
    expect(held).toBe(true)
    expect(content.length).toBeGreaterThan(0)
    expect(existsSync(`${authFile}.lock`)).toBe(false)
  })

  test("waits for a lock another writer holds", async () => {
    writeAuth({ autoclaw: entry({ expires: Date.now() + 60_000 }) })
    const lockPath = `${authFile}.lock`
    writeFileSync(lockPath, "")
    const release = setTimeout(() => rmSync(lockPath, { force: true }), 300)

    const startedAt = Date.now()
    try {
      const h = harness()
      expect(await h.run(["--print"])).toBe(0)
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200)
      expect(fake.state.refreshCalls.length).toBe(1)
      expect(readAuth().autoclaw.access).toBe(fake.state.access)
      expect(existsSync(lockPath)).toBe(false)
    } finally {
      clearTimeout(release)
      rmSync(lockPath, { force: true })
    }
  })

  test("removes a stale lock (mtime older than 10s) and continues", async () => {
    writeAuth({ autoclaw: entry({ expires: Date.now() + 60_000 }) })
    const lockPath = `${authFile}.lock`
    writeFileSync(lockPath, "")
    const old = new Date(Date.now() - 11_000)
    utimesSync(lockPath, old, old)

    const h = harness()
    expect(await h.run(["--print"])).toBe(0)
    expect(fake.state.refreshCalls.length).toBe(1)
    expect(readAuth().autoclaw.access).toBe(fake.state.access)
    expect(existsSync(lockPath)).toBe(false)
  })

  test("a failed write-back still prints the link, warns on stderr and exits 0", async () => {
    const stale = fake.state.access
    writeAuth({ autoclaw: entry({ expires: Date.now() + 60_000 }) })
    // occupy the atomic-write temp path with a directory: the rename cannot land
    const tmpPath = `${authFile}.${process.pid}.tmp`
    mkdirSync(tmpPath)

    try {
      const h = harness()
      expect(await h.run(["--print"])).toBe(0)
      expect(h.stderr()).toContain("写回失败")
      expect(h.stdout()).toContain(`链接：${_internal.webEntryUrl(fake.state.access)}`)
      // the on-disk record is untouched, so a retry can still renew
      expect(readAuth().autoclaw.access).toBe(stale)
      expect(existsSync(`${authFile}.lock`)).toBe(false)
    } finally {
      rmSync(tmpPath, { recursive: true, force: true })
    }
  })
})

describe("sign-in state", () => {
  test("an unknown account key is a sign-in problem (exit 2)", async () => {
    writeAuth({ autoclaw: entry() })
    const h = harness()
    expect(await h.run(["--print", "--account", "autoclaw#missing"])).toBe(2)
    expect(h.stderr()).toContain("未登录")
    expect(h.stdout()).toBe("")
  })

  test("a non-oauth record and an oauth record without access both exit 2", async () => {
    writeAuth({ autoclaw: { type: "api", key: "sk-x" } })
    let h = harness()
    expect(await h.run(["--print"])).toBe(2)
    expect(h.stderr()).toContain("未登录")

    writeAuth({ autoclaw: { type: "oauth", refresh: "r" } })
    h = harness()
    expect(await h.run(["--print"])).toBe(2)
    expect(h.stderr()).toContain("未登录")
  })

  test("a missing or unreadable credentials file never reaches the network", async () => {
    const h = harness()
    expect(await h.run(["--print"])).toBe(2)
    expect(h.stderr()).toContain("未登录")

    writeFileSync(authFile, "{not json")
    const h2 = harness()
    expect(await h2.run(["--print"])).toBe(2)
    expect(h2.stderr()).toContain("未登录")
    expect(fake.state.refreshCalls.length).toBe(0)
  })
})

describe("accounts", () => {
  test("--account selects a second account's token", async () => {
    const second = fake.jwt(nowSec() + 3600, fake.state.userId, "second-device")
    writeAuth({ autoclaw: entry(), "autoclaw#9q9l5x": entry({ access: second }) })

    const h = harness()
    expect(await h.run(["--print", "--account", "autoclaw#9q9l5x"])).toBe(0)
    const lines = linesOf(h.stdout())
    expect(lines[0]).toContain("autoclaw#9q9l5x")
    expect(lines[1]).toBe(`链接：${_internal.webEntryUrl(second)}`)
    expect(lines[1]).not.toContain(encodeURIComponent(fake.state.access))
  })
})

describe("opening the browser", () => {
  test("--print and --no-open skip the opener", async () => {
    writeAuth({ autoclaw: entry() })
    let h = harness()
    expect(await h.run(["--print"])).toBe(0)
    expect(h.opened.length).toBe(0)
    h = harness()
    expect(await h.run(["--no-open"])).toBe(0)
    expect(h.opened.length).toBe(0)
  })

  test("the default mode hands the printed URL to the opener", async () => {
    const access = fake.state.access
    writeAuth({ autoclaw: entry() })
    const h = harness()
    expect(await h.run([])).toBe(0)
    expect(h.opened).toEqual([_internal.webEntryUrl(access)])
  })

  test("a failing opener falls back to printing the link", async () => {
    writeAuth({ autoclaw: entry() })
    const h = harness({ opener: async () => false })
    expect(await h.run([])).toBe(0)
    expect(h.stdout()).toContain("链接：")
    expect(h.stderr()).toContain("无法自动打开浏览器")
  })
})

describe("arguments", () => {
  test("--help prints the usage and exits 0", async () => {
    const h = harness()
    expect(await h.run(["--help"])).toBe(0)
    expect(h.stdout()).toContain("--account")
    expect(h.stdout()).toContain("--no-open")
  })

  test("the bin accepts the `web` subcommand bunx passes", async () => {
    writeAuth({ autoclaw: entry() })
    const h = harness()
    // `bunx magpie-autoclaw-cn-auth web --print` → argv ["web", "--print"]
    expect(await h.run(["web", "--print"])).toBe(0)
    expect(h.stdout()).toContain(`链接：${_internal.webEntryUrl(fake.state.access)}`)
    expect(h.opened.length).toBe(0)
  })

  test("an unknown argument exits 1 with the usage", async () => {
    const h = harness()
    expect(await h.run(["--nope"])).toBe(1)
    expect(h.stderr()).toContain("未知参数")
    expect(h.stdout()).toBe("")
  })
})
