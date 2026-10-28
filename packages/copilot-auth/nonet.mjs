const originalFetch = globalThis.fetch

if (typeof originalFetch !== "function") throw new Error("network guard: fetch is unavailable")

const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"])

globalThis.fetch = (input, init = {}) => {
  const rawUrl = typeof input === "string" || input instanceof URL ? input : input.url
  const url = new URL(rawUrl)
  if (!localHosts.has(url.hostname)) {
    throw new Error(`network guard blocked ${url.protocol}//${url.host}`)
  }
  if (init.redirect && init.redirect !== "manual") {
    throw new Error("network guard requires redirect: manual")
  }
  return originalFetch(input, { ...init, redirect: "manual" })
}
