// Z.AI multi-account key rotation plugin for OpenCode (coding-plan endpoint).
//
// Owns auth for the `zai-max` provider, which targets
// https://api.z.ai/api/coding/paas/v4 and draws the GLM Coding Max
// subscription quota rather than per-token credit.
//
// Dual-shape plugin (loads clean under the opencode v2 plugin API):
//   - `setup(ctx)`: the v2 port. Session HTTP-boundary hooks inject the
//     rotating Authorization header, enforce the model profile registry on
//     the wire body, classify statuses, and drive rotation + quota
//     hold-and-resume through the `retry` hook.
//   - `server()` (also exported as `ZaiMultiAccount`): the original v1
//     auth-loader implementation, preserved verbatim as the compat shape.
//
// Responsibilities:
//   - key pool rotation on auth errors (401/403) and rate limits (429)
//   - quota hold-and-resume: when the subscription quota is exhausted (429),
//     the request is held and retried until the quota resets, so a quota
//     window surfaces as latency instead of a hard error
//   - attempt budget: holds and forced retries are bounded (total hold per
//     request <= ZAI_QUOTA_WAIT_MAX_MS; total attempts <=
//     ZAI_MAX_RETRY_ATTEMPTS, default 24); beyond either bound the provider
//     error surfaces instead of retrying forever
//
// The quota-wait, request-body, and model-profile helpers live in src/ as
// verbatim ports of the config repo's lib/ modules.
//
// Key pool file: ~/.local/share/opencode/zai-accounts.json (chmod 600)
//   { "accounts": [ { "label": "max-plan-1", "type": "plan", "apiKey": "..." } ] }
// The pool file is read from disk only (read-only access; it lives outside
// every repo). The pool is re-read every 30s and on startup - no restart
// needed. An empty or missing pool is the only fail-soft path: the plugin
// then leaves provider auth untouched (config/env auth applies).
//
// Env overrides:
//   ZAI_ACCOUNTS_PATH           custom pool file path
//   ZAI_ROTATE_COOLDOWN_MS      how long a rate-limited key is skipped (default 60000)
//   ZAI_QUOTA_WAIT_DISABLED=1   disable hold-and-resume (429 fails immediately)
//   ZAI_QUOTA_WAIT_MAX_MS       total hold cap per request (default 21600000, 6h)
//   ZAI_QUOTA_WAIT_POLL_MS      retry interval when no reset hint (default 300000, 5min)
//   ZAI_MAX_RETRY_ATTEMPTS      total attempt bound before surfacing the error (default 24)
//   ZAI_MULTI_ACCOUNT_LOG       log file path (JSON lines, keys masked); stderr when unset
import { appendFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { quotaWaitMs } from "./src/zai-quota.js"
import { withProfileBody } from "./src/request-body.js"

const PROVIDER_ID = "zai-max"
const POOL_PATH = process.env.ZAI_ACCOUNTS_PATH || join(homedir(), ".local/share/opencode/zai-accounts.json")
const COOLDOWN_MS = Number(process.env.ZAI_ROTATE_COOLDOWN_MS || 60000)
const POOL_RELOAD_MS = 30000
const QUOTA_WAIT_ENABLED = process.env.ZAI_QUOTA_WAIT_DISABLED !== "1"
const QUOTA_WAIT_MAX_MS = Number(process.env.ZAI_QUOTA_WAIT_MAX_MS || 21600000)
const QUOTA_WAIT_POLL_MS = Number(process.env.ZAI_QUOTA_WAIT_POLL_MS || 300000)
// Attempt-budget amendment: a configurable hard bound on total attempts per
// request. When exceeded (or when the built-in host budget binds first), the
// error surfaces instead of retrying forever.
const MAX_RETRY_ATTEMPTS = Number(process.env.ZAI_MAX_RETRY_ATTEMPTS || 24)
const LOG_PATH = process.env.ZAI_MULTI_ACCOUNT_LOG || null

const state = { accounts: [], loadedAt: 0, active: 0, limitedUntil: new Map(), disabled: new Set(), log: null }

function loadPool(force = false) {
  const now = Date.now()
  if (!force && state.loadedAt > 0 && now - state.loadedAt < POOL_RELOAD_MS) return
  try {
    const raw = JSON.parse(readFileSync(POOL_PATH, "utf-8"))
    const accounts = Array.isArray(raw) ? raw : raw.accounts || []
    state.accounts = accounts.filter((a) => a && typeof a.apiKey === "string" && a.apiKey.length > 0)
  } catch {
    state.accounts = []
  }
  if (state.active >= state.accounts.length) state.active = 0
  state.loadedAt = now
}

function usable(i, now = Date.now()) {
  if (state.disabled.has(i)) return false
  if ((state.limitedUntil.get(i) || 0) > now) return false
  return true
}

function nextUsable(from, now = Date.now()) {
  const n = state.accounts.length
  for (let k = 1; k <= n; k++) {
    const i = (from + k) % n
    if (usable(i, now)) return i
  }
  return -1
}

function activeIndex() {
  loadPool()
  if (state.accounts.length === 0) return -1
  if (usable(state.active)) return state.active
  const next = nextUsable(state.active)
  if (next !== -1) state.active = next
  return next
}

async function log(message, extra = {}) {
  try {
    if (state.log) await state.log({ body: { service: "zai-multi-account", level: "info", message, extra } })
  } catch {}
}

// v2 logging: file via ZAI_MULTI_ACCOUNT_LOG (appendFileSync, JSON lines) or
// stderr when unset. Key material is masked to the first 8 characters plus an
// ellipsis - never a full key.
function maskKey(key) {
  return typeof key === "string" ? key.slice(0, 8) + "…" : "none"
}

function logLine(obj) {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n"
    if (LOG_PATH) appendFileSync(LOG_PATH, line)
    else process.stderr.write(line)
  } catch {}
}

// ---------------------------------------------------------------------------
// v1 shape (compat): preserved verbatim from the config repo's
// plugins/zai-multi-account.js (imports and shared constants adjusted only).
// ---------------------------------------------------------------------------

function allKeysExhaustedResponse() {
  return new Response(
    JSON.stringify({ error: { type: "rate_limit_error", message: "zai-multi-account: all Z.AI API keys are rate-limited; retry after cooldown" } }),
    { status: 429, headers: { "content-type": "application/json" } },
  )
}

function requestUrl(input) {
  try {
    return input instanceof Request ? input.url : new URL(String(input)).href
  } catch {
    return ""
  }
}

function isSubscriptionEndpoint(url) {
  return url.includes("/coding/")
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Pool attach + rotation, without peak gating or quota hold.
async function coreFetch(input, init) {
  if (state.accounts.length <= 1) {
    // Single key (or none): behave exactly like the default provider auth.
    if (state.accounts.length === 1) {
      const h = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined))
      h.set("Authorization", `Bearer ${state.accounts[0].apiKey}`)
      const enforced = await withProfileBody(input, init ? { ...init, headers: h } : init, (m) => log(`body:${m}`, {}))
      if (enforced.input instanceof Request) return fetch(new Request(enforced.input, { headers: h }))
      return fetch(enforced.input, { ...enforced.init, headers: h })
    }
    return fetch(input, init)
  }

  const originalRequest = input instanceof Request ? input.clone() : null

  const attempt = async (key) => {
    const h = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined))
    h.set("Authorization", `Bearer ${key}`)
    const enforced = await withProfileBody(
      originalRequest ? originalRequest.clone() : input,
      init ? { ...init, headers: h } : init,
      (m) => log(`body:${m}`, {}),
    )
    if (enforced.input instanceof Request) return fetch(new Request(enforced.input, { headers: h }))
    return fetch(enforced.input, { ...enforced.init, headers: h })
  }

  let idx = activeIndex()
  if (idx === -1) {
    await log("all_keys_rate_limited", { cooldownMs: COOLDOWN_MS })
    return allKeysExhaustedResponse()
  }

  const tried = new Set()
  let res
  while (!tried.has(idx)) {
    tried.add(idx)
    const acct = state.accounts[idx]
    res = await attempt(acct.apiKey)
    if (res.status === 429) {
      state.limitedUntil.set(idx, Date.now() + COOLDOWN_MS)
      const next = nextUsable(idx)
      await log("key_rate_limited_rotating", { label: acct.label || `key-${idx + 1}`, hasNext: next !== -1 })
      if (next === -1) return res
      idx = next
      state.active = next
      continue
    }
    if (res.status === 401 || res.status === 403) {
      const next = nextUsable(idx)
      if (next === -1) return res
      state.disabled.add(idx)
      await log("key_rejected_rotating", { label: acct.label || `key-${idx + 1}`, status: res.status })
      idx = next
      state.active = next
      continue
    }
    return res
  }
  return res
}

async function rotationFetch(input, init) {
  loadPool()
  const url = requestUrl(input)
  // Snapshot the request before any body consumption so quota retries can
  // rebuild it with a fresh body stream.
  const originalRequest = input instanceof Request ? input.clone() : null

  let res = await coreFetch(input, init)

  if (!QUOTA_WAIT_ENABLED || res.status !== 429 || !isSubscriptionEndpoint(url)) return res

  // Subscription quota exhausted: hold and retry until the quota resets or
  // the configured cap is reached, then surface the original 429.
  let held = 0
  while (res.status === 429 && held < QUOTA_WAIT_MAX_MS) {
    const w = Math.min(quotaWaitMs(res, QUOTA_WAIT_POLL_MS), QUOTA_WAIT_MAX_MS - held)
    if (w <= 0) break
    await log("quota_hold_retry", { waitMs: w, heldMs: held, capMs: QUOTA_WAIT_MAX_MS })
    await sleep(w)
    held += w
    const retry = originalRequest ? new Request(originalRequest.clone()) : input
    res = await coreFetch(retry, init)
  }
  if (res.status === 429) {
    await log("quota_wait_cap_reached", { heldMs: held, capMs: QUOTA_WAIT_MAX_MS })
  }
  return res
}

export const ZaiMultiAccount = async ({ client }) => {
  state.log = client?.app?.log?.bind(client.app) || null
  loadPool(true)
  await log("plugin_loaded", { poolSize: state.accounts.length, poolPath: POOL_PATH })
  return {
    auth: {
      provider: PROVIDER_ID,
      loader: async (getAuth, provider) => {
        loadPool(true)
        if (state.accounts.length === 0) {
          const stored = await getAuth()
          return { apiKey: stored?.key }
        }
        const idx = activeIndex()
        const apiKey = idx >= 0 ? state.accounts[idx].apiKey : state.accounts[0].apiKey
        return { apiKey, fetch: rotationFetch }
      },
    },
  }
}

// ---------------------------------------------------------------------------
// v2 shape: session HTTP-boundary hooks per the ratified spike design
// (SPIKE-2.2-zai-auth.md, verdict (e): PORT VIABLE via http.request /
// http.response / retry) plus the attempt-budget amendment.
// ---------------------------------------------------------------------------

export default {
  id: "zai-multi-account",
  async setup(ctx) {
    loadPool(true)
    logLine({ event: "plugin_loaded", poolSize: state.accounts.length })
    const timer = setInterval(() => loadPool(), POOL_RELOAD_MS)

    // Correlates an http.request event to its http.response event by request
    // object (the response event carries the same request reference). Holds
    // the key index and the request start time.
    const pending = new WeakMap()
    // Cumulative quota-hold milliseconds, keyed by sessionID. The retry hook
    // has no request reference, so per-session is the closest available
    // correlation; the accumulator resets on every non-429 response in the
    // session, so it can only ever under-hold (cap engages early), never
    // over-hold past the amendment cap.
    const holds = new Map()

    await ctx.session.hook("http.request", async (event) => {
      const idx = activeIndex()
      if (idx === -1) return // empty pool: let config/env auth apply (v1 fail-soft, unchanged)
      const key = state.accounts[idx].apiKey
      event.request.headers.set("authorization", `Bearer ${key}`)

      // Registry enforcement at the wire boundary, same position as the v1
      // fetch wrapper. withProfileBody returns the same request when nothing
      // needed rewriting; a rewritten request arrives as a new Request.
      const enforced = await withProfileBody(event.request, undefined, (message) =>
        logLine({ event: "body", message }),
      )
      if (enforced.input instanceof Request && enforced.input !== event.request) {
        event.request = enforced.input
      }
      pending.set(event.request, { idx, t0: Date.now() })
      logLine({ event: "http.request", kind: event.kind, url: event.request.url, keyPrefix: maskKey(key) })
    }, { providerID: PROVIDER_ID })

    await ctx.session.hook("http.response", (event) => {
      const { status } = event.response
      const meta = pending.get(event.request) ?? {}
      const durationMs = meta.t0 !== undefined ? Date.now() - meta.t0 : null
      logLine({
        event: "http.response",
        kind: event.kind,
        status,
        durationMs,
        keyPrefix: meta.idx !== undefined ? maskKey(state.accounts[meta.idx]?.apiKey) : undefined,
      })

      if (status === 429) {
        // Rate-limited key: cooldown, then stash the Retry-After-derived hold
        // for the retry hook. Rotation to the next usable key happens on the
        // next http.request via activeIndex().
        if (meta.idx !== undefined) state.limitedUntil.set(meta.idx, Date.now() + COOLDOWN_MS)
        const holdMs = quotaWaitMs(event.response, QUOTA_WAIT_POLL_MS)
        state.pendingHoldMs = holdMs
        logLine({
          event: "quota_429",
          keyIndex: meta.idx,
          holdMs,
          retryAfter: event.response.headers.get("retry-after"),
          cooldownMs: COOLDOWN_MS,
        })
        return
      }

      // Any non-429 terminal response ends hold accounting for this session.
      holds.delete(event.sessionID)

      if ((status === 401 || status === 403) && meta.idx !== undefined) {
        // Rejected key: disable it; the retry hook advances the active key.
        state.disabled.add(meta.idx)
        logLine({ event: "key_rejected", status, keyIndex: meta.idx, keyPrefix: maskKey(state.accounts[meta.idx]?.apiKey) })
      }
    }, { providerID: PROVIDER_ID })

    await ctx.session.hook("retry", async (event) => {
      const { status } = event.error

      // Attempt-budget amendment: no infinite retry. Beyond the configured
      // total attempt bound, surface the error.
      if (event.attempt > MAX_RETRY_ATTEMPTS) {
        event.decision = { retry: false }
        logLine({ event: "retry_budget_exhausted", attempt: event.attempt, maxAttempts: MAX_RETRY_ATTEMPTS, status })
        return
      }

      if (status === 401 || status === 403) {
        const next = nextUsable(state.active)
        if (next === -1) {
          event.decision = { retry: false }
          logLine({ event: "all_keys_rejected", status })
          return
        }
        state.active = next
        event.decision = { retry: true, delay: 0 }
        logLine({
          event: "rotation",
          from: event.attempt,
          to: maskKey(state.accounts[next].apiKey),
          reason: `status ${status}`,
        })
        return
      }

      if (status === 429 && QUOTA_WAIT_ENABLED) {
        // Quota hold-and-resume: hold inside this hook invocation (the
        // faithful shape per the spike - the host's built-in attempt budget
        // is a hard limit, so holding in one logical retry preserves the v1
        // "quota window surfaces as latency" semantics), bounded by the
        // amendment: total hold <= ZAI_QUOTA_WAIT_MAX_MS and total attempts
        // <= ZAI_MAX_RETRY_ATTEMPTS, else the error surfaces.
        const hold = holds.get(event.sessionID) ?? { heldMs: 0 }
        const wait = Math.min(state.pendingHoldMs || QUOTA_WAIT_POLL_MS, QUOTA_WAIT_MAX_MS - hold.heldMs)
        if (wait <= 0) {
          event.decision = { retry: false }
          holds.delete(event.sessionID)
          logLine({ event: "quota_wait_cap_reached", heldMs: hold.heldMs, capMs: QUOTA_WAIT_MAX_MS })
          return
        }
        logLine({ event: "quota_hold_retry", waitMs: wait, heldMs: hold.heldMs, capMs: QUOTA_WAIT_MAX_MS })
        await sleep(wait) // hold-and-resume: the quota window surfaces as latency
        hold.heldMs += wait
        holds.set(event.sessionID, hold)
        event.decision = { retry: true, delay: 0 }
      }
    }, { providerID: PROVIDER_ID })

    return () => {
      clearInterval(timer)
      logLine({ event: "unloaded" })
    }
  },
  server: ZaiMultiAccount,
}
