#!/usr/bin/env node
// magpie-autoclaw-cn-auth — the `web` CLI.
//
// Prints (and by default opens) the AutoClaw web app's password-less entry
// link `{AUTOCLAW_WEB_BASE_URL}/?autoglm_token=<access>`. Since 0.5.0 this is
// the only way to read the link: the usage window shows a fixed hint because
// magpie's GUI truncates long `display` text and offers no copy action.
//
// It reads magpie's `plugin-auth.json` (never writes anything else), renews a
// near-expiry access token through the plugin's own `renewTokens`, and writes
// the result back under the host's lock protocol (`plugin-auth.json.lock`,
// `wx` create, 10s stale threshold, 20s wait cap, re-read under lock, atomic
// tmp+rename). Runs on Node >= 18 and Bun: node: builtins plus global fetch.

import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { spawn } from "node:child_process"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { _internal } from "./index.mjs"

const { ID, REFRESH_LEAD, renewTokens, webEntryUrl, jwtEnd, stripBearer, toNum, maskPhone } = _internal

// the host's lock contract (host.js lockAuth/writeAuth)
const LOCK_SUFFIX = ".lock"
const LOCK_STALE_MS = 10_000
const LOCK_TIMEOUT_MS = 20_000
const LOCK_RETRY_MIN_MS = 5
const LOCK_RETRY_MAX_MS = 50

const HELP = `用法：bun web.mjs [--account <key>] [--print] [--no-open] [--base <url>]
      bunx magpie-autoclaw-cn-auth web [--account <key>] [--print]

打印 AutoClaw 网页版免密登录链接（与 magpie 的「网页版快捷登录」窗口同源）。

  --account <key>  plugin-auth.json 中的账号键，默认 autoclaw
  --print          只打印链接，不打开浏览器
  --no-open        同 --print
  --base <url>     覆盖网页站点（等价 AUTOCLAW_WEB_BASE_URL）
  -h, --help       显示本帮助

注意：链接等同于实时登录凭证，不要贴到聊天、文档或日志里。
`

// a credentials problem the user can fix by signing in again: exit code 2.
// Everything else (I/O, bad args) exits 1.
class NotSignedIn extends Error {}

// ── credential file location ───────────────────────────────────────────────
//
// AUTOCLAW_AUTH_FILE (explicit file) → AUTOCLAW_CONFIG_DIR → $XDG_CONFIG_HOME →
// $HOME → %USERPROFILE% → os.homedir(). On Windows a bare `${HOME ?? ""}` would
// resolve to C:\.config, so an empty variable never becomes the base.
export function authFilePath() {
  const explicit = String(process.env.AUTOCLAW_AUTH_FILE ?? "").trim()
  if (explicit) return explicit
  const fileIn = (dir) => join(dir, "plugin-auth.json")
  const configured = String(process.env.AUTOCLAW_CONFIG_DIR ?? "").trim()
  if (configured) return fileIn(configured)
  const xdg = String(process.env.XDG_CONFIG_HOME ?? "").trim()
  if (xdg) return fileIn(join(xdg, "magpie"))
  const home =
    String(process.env.HOME ?? "").trim() ||
    String(process.env.USERPROFILE ?? "").trim() ||
    homedir()
  if (!home) throw new Error("无法确定 magpie 配置目录（HOME / USERPROFILE 均为空）")
  return fileIn(join(home, ".config", "magpie"))
}

function readAuthFile(path) {
  let raw
  try {
    raw = readFileSync(path, "utf8")
  } catch (e) {
    if (e?.code === "ENOENT") throw new NotSignedIn(`未登录：找不到凭据文件 ${path}（先在 magpie 里登录）`)
    throw new NotSignedIn(`未登录：凭据文件无法读取（${path}）：${e?.message ?? e}`)
  }
  try {
    const all = JSON.parse(raw)
    if (!all || typeof all !== "object" || Array.isArray(all)) throw new Error("不是对象")
    return all
  } catch (e) {
    throw new NotSignedIn(`未登录：凭据文件格式异常（${path}）：${e?.message ?? e}`)
  }
}

// ── the host's lock protocol ───────────────────────────────────────────────
//
// Hold `plugin-auth.json.lock` (open with `wx`), re-read the file, change only
// the target account, write tmp+rename. A lock whose mtime is older than 10s
// belongs to a crashed writer and is removed; total wait is capped at 20s.
export async function withAuthLock(authPath, fn, { now = Date.now, sleep = defaultSleep } = {}) {
  const lockPath = `${authPath}${LOCK_SUFFIX}`
  mkdirSync(dirname(authPath), { recursive: true })
  const startedAt = now()
  let fd = null
  while (fd == null) {
    try {
      fd = openSync(lockPath, "wx", 0o600)
    } catch (e) {
      if (e?.code !== "EEXIST") throw e
      let mtimeMs = 0
      try {
        mtimeMs = statSync(lockPath).mtimeMs
      } catch {}
      if (mtimeMs && now() - mtimeMs > LOCK_STALE_MS) {
        // a crashed writer left it behind: removing is the documented recovery
        try {
          rmSync(lockPath, { force: true })
        } catch {}
        continue
      }
      if (now() - startedAt >= LOCK_TIMEOUT_MS)
        throw new Error(`等待 plugin-auth 锁超时（${LOCK_TIMEOUT_MS / 1000} 秒）`)
      await sleep(LOCK_RETRY_MIN_MS + Math.floor(Math.random() * (LOCK_RETRY_MAX_MS - LOCK_RETRY_MIN_MS + 1)))
    }
  }
  try {
    return await fn()
  } finally {
    try {
      closeSync(fd)
    } catch {}
    try {
      rmSync(lockPath, { force: true })
    } catch {}
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// re-read under the lock so another writer's keys survive; only this account's
// fields change. tmp+rename keeps a reader from seeing half a file.
function writeAuthFile(authPath, account, next) {
  const all = readAuthFile(authPath)
  const prev = all[account] && typeof all[account] === "object" ? all[account] : {}
  all[account] = { ...prev, ...next }
  const tmp = `${authPath}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, authPath)
  } catch (e) {
    try {
      unlinkSync(tmp)
    } catch {}
    throw e
  }
}

// ── output helpers ─────────────────────────────────────────────────────────

// Beijing wall-clock: the vendor's day runs on UTC+8, and the link is a local
// convenience, so print the time the user will compare against their watch
function beijingStamp(ms) {
  const d = new Date(ms + 8 * 3600e3)
  const p = (n) => String(n).padStart(2, "0")
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

const accountLabel = (acct) => {
  const raw = String(acct?.name || acct?.accountId || "").trim()
  return raw ? maskPhone(raw) : ""
}

// win32: `cmd /c start "" <url>`; darwin: `open`; linux: `xdg-open`. Resolves
// false when the helper cannot be spawned, so the caller can fall back to
// printing the link only.
export function openBrowser(url) {
  return new Promise((resolve) => {
    const platform = process.platform
    const cmd = platform === "win32" ? "cmd" : platform === "darwin" ? "open" : "xdg-open"
    const args = platform === "win32" ? ["/c", "start", "", url] : [url]
    let child
    try {
      child = spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true })
    } catch {
      resolve(false)
      return
    }
    child.once("error", () => resolve(false))
    child.once("spawn", () => {
      child.unref()
      resolve(true)
    })
  })
}

// ── args ───────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  // `bunx magpie-autoclaw-cn-auth web` hands the bin a `web` subcommand; the
  // bin is this script, so it is accepted and dropped
  const args = argv[0] === "web" ? argv.slice(1) : argv
  const opts = { account: ID, open: true, base: "", help: false }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--account" || arg === "--base") {
      const value = args[++i]
      if (value == null || value.startsWith("--")) throw new Error(`${arg} 缺少参数值`)
      if (arg === "--account") opts.account = value.trim()
      else opts.base = value.trim()
    } else if (arg === "--print" || arg === "--no-open") opts.open = false
    else if (arg === "-h" || arg === "--help") opts.help = true
    else throw new Error(`未知参数：${arg}`)
  }
  if (!opts.account) throw new Error("--account 不能为空")
  return opts
}

// ── the flow ───────────────────────────────────────────────────────────────

// Resolve a live access token for `account`, renewing + writing back when the
// token is inside REFRESH_LEAD. Returns { url, account, label, expires,
// notices } where notices are stderr-only warnings.
export async function resolveLink({ account, base = "", now = Date.now, authPath = authFilePath() } = {}) {
  const all = readAuthFile(authPath)
  const acct = all[account]
  if (!acct || typeof acct !== "object") throw new NotSignedIn(`未登录：凭据文件里没有账号 ${account}（先在 magpie 里登录）`)
  if (acct.type !== "oauth" || !acct.access) throw new NotSignedIn(`未登录：账号 ${account} 没有可用的 access token（先在 magpie 里重新登录）`)

  const notices = []
  let access = stripBearer(acct.access)
  let expires = toNum(acct.expires) || jwtEnd(access) || 0

  // 0 (no exp claim) is unknown, not "already expired": never renew blindly
  if (expires > 0 && expires - now() < REFRESH_LEAD) {
    if (!acct.refresh) {
      const minutes = Math.max(0, Math.floor((expires - now()) / 60_000))
      notices.push(`警告：没有 refresh token，无法自动续期，剩余 ${minutes} 分钟，链接即将失效`)
    } else {
      try {
        const got = await renewTokens({ access, refresh: acct.refresh, deviceId: acct.deviceId, expires })
        access = got.access
        expires = got.expires || jwtEnd(access) || 0
        try {
          await withAuthLock(authPath, () =>
            writeAuthFile(authPath, account, { access: got.access, refresh: got.refresh, expires }),
          )
        } catch (e) {
          notices.push(`警告：续期成功但写回失败（${e?.message ?? e}），magpie 中的 refresh 已失效，请重新登录`)
        }
      } catch (e) {
        // a renewal failure is not fatal while the current token still lives
        if (expires > now())
          notices.push(`警告：续期失败（${e?.message ?? e}），仍使用当前 token，链接即将失效`)
        else throw new NotSignedIn(`登录态已失效，请重新登录：${e?.message ?? e}`)
      }
    }
  }

  let url
  const prevBase = process.env.AUTOCLAW_WEB_BASE_URL
  if (base) process.env.AUTOCLAW_WEB_BASE_URL = base
  try {
    url = webEntryUrl(access)
  } finally {
    if (base) {
      if (prevBase === undefined) delete process.env.AUTOCLAW_WEB_BASE_URL
      else process.env.AUTOCLAW_WEB_BASE_URL = prevBase
    }
  }

  return { url, account, label: accountLabel(acct), expires, notices }
}

const writeLine = (stream) => (text) => stream.write(text)

// The CLI entry point. `opener` and `now` are injectable so tests never spawn a
// browser and never depend on the wall clock.
export async function runWeb(
  argv,
  { opener = openBrowser, now = Date.now, out = writeLine(process.stdout), err = writeLine(process.stderr) } = {},
) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (e) {
    err(`错误：${e?.message ?? e}\n\n${HELP}`)
    return 1
  }
  if (opts.help) {
    out(HELP)
    return 0
  }

  let link
  try {
    link = await resolveLink({ account: opts.account, base: opts.base, now })
  } catch (e) {
    if (e instanceof NotSignedIn) {
      err(`${e.message}\n`)
      return 2
    }
    err(`错误：${e?.message ?? e}\n`)
    return 1
  }

  for (const notice of link.notices) err(`${notice}\n`)

  const who = link.label ? `${link.label}（${link.account}）` : link.account
  out(`账号：${who}\n`)
  out(`链接：${link.url}\n`)
  out(
    link.expires
      ? `有效至：${beijingStamp(link.expires)}（北京时间）\n`
      : "有效至：未知（token 未携带过期时间）\n",
  )

  if (!opts.open) return 0
  const opened = await opener(link.url)
  if (opened === false) err("警告：无法自动打开浏览器，请手动复制上面的链接\n")
  return 0
}

// only run when executed directly (`node web.mjs` / `bun web.mjs`), not when
// imported by the tests
function invokedDirectly() {
  const arg = process.argv[1]
  if (!arg) return false
  try {
    const self = realpathSync(fileURLToPath(import.meta.url))
    const entry = realpathSync(arg)
    return process.platform === "win32" ? self.toLowerCase() === entry.toLowerCase() : self === entry
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  // `--print | head` is a legitimate pipe: a reader that closes early must not
  // crash the CLI with an unhandled EPIPE
  const stopOnEpipe = (e) => {
    if (e?.code === "EPIPE") process.exit(0)
    throw e
  }
  process.stdout.on("error", stopOnEpipe)
  process.stderr.on("error", stopOnEpipe)
  runWeb(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (e) => {
      process.stderr.write(`错误：${e?.message ?? e}\n`)
      process.exitCode = 1
    },
  )
}
