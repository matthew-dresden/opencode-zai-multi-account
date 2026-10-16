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
//     window surfaces as latency instead of a hard error (subscription
//     /coding/ endpoints only, in both halves)
//   - never unauthenticated: with a non-empty pool, a request whose keys are
//     all merely cooling down (429) is held until the earliest cooldown
//     expiry and issued authenticated; it fails loudly only when the
//     hold/attempt budget is exhausted or every key is hard-disabled
//   - attempt budget: holds and forced retries are bounded (total hold per
//     request <= ZAI_QUOTA_WAIT_MAX_MS; total attempts <=
//     ZAI_MAX_RETRY_ATTEMPTS, default 24); beyond either bound the provider
//     error surfaces instead of retrying forever
//   - guarded hooks: non-essential hook failures log and proceed; auth-path
//     failures throw plugin-attributed errors (never a silent degrade)
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

// Rotation bookkeeping is index-keyed (positions in state.accounts), the same
// shape V1 used. Decision (recorded per amendment 12): this index-keying is
// inherited across pool hot-reloads deliberately. A reload that reorders the
// pool file can land a stale disable/cooldown on the wrong slot; the cost is
// bounded (one bad response on the mislabeled slot) and self-healing, since
// the key actually failing gets re-classified at its current index on the
// next 401/403/429. Key-string keying was rejected: it would diverge the
// shared state shape from the preserved-verbatim V1 server() half.
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

// Plugin-attributed error: auth-path failures surface with this prefix so a
// live-session failure is unmistakably the plugin's (amendment 9).
function pluginError(message) {
  return new Error(`zai-multi-account: ${message}`)
}

function errText(err) {
  return err?.message || String(err)
}

// Earliest future cooldown expiry among keys that are merely rate-limited
// (429) - hard-disabled (401/403) keys are excluded because waiting for them
// is futile. Infinity when no key is cooling.
function earliestCoolingExpiry(now = Date.now()) {
  let earliest = Infinity
  for (const [i, until] of state.limitedUntil) {
    if (!state.disabled.has(i) && until > now && until < earliest) earliest = until
  }
  return earliest
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
//
// Amendment 9 guarding: every hook callback body is wrapped. Non-essential
// failures (logging, body-rewrite enhancement, classification bookkeeping)
// are logged and the request proceeds; auth-path failures (key resolution,
// header injection) are logged loudly and rethrown as plugin-attributed
// errors - never a silent skip, never an unauthenticated request.
//
// Amendment 4: a non-empty pool never lets a request through without auth.
// When every key is merely cooling down (429), the request is held (surfaces
// as latency, as in V1) until the earliest cooldown expiry; it fails loudly
// only when the hold/attempt budget is exhausted or every key is
// hard-disabled.
// ---------------------------------------------------------------------------

// Resolves the active pool index for an outgoing request. Returns -1 only for
// an empty pool (the documented fail-soft passthrough). For a non-empty pool
// it holds while keys are merely cooling down, bounded by the amendment
// budget (hold <= ZAI_QUOTA_WAIT_MAX_MS, hold attempts <=
// ZAI_MAX_RETRY_ATTEMPTS), and throws plugin-attributed errors on exhaustion.
async function resolveUsableIndex() {
  loadPool()
  if (state.accounts.length === 0) return -1
  let idx = activeIndex()
  let heldMs = 0
  let holdAttempts = 0
  while (idx === -1) {
    holdAttempts++
    const now = Date.now()
    const earliest = earliestCoolingExpiry(now)
    if (!Number.isFinite(earliest)) {
      // Every key hard-disabled: waiting is futile, and issuing
      // unauthenticated is forbidden - fail loudly.
      throw pluginError(
        `all ${state.accounts.length} pool keys are hard-disabled (401/403); ` +
        "refusing to issue an unauthenticated request",
      )
    }
    const budgetLeft = QUOTA_WAIT_MAX_MS - heldMs
    const wait = Math.min(earliest - now, budgetLeft)
    if (holdAttempts > MAX_RETRY_ATTEMPTS || wait <= 0) {
      throw pluginError(
        `all keys cooling down: next key usable at ${new Date(earliest).toISOString()}; ` +
        `held ${heldMs}ms of the ${QUOTA_WAIT_MAX_MS}ms cap across ${holdAttempts} hold attempts ` +
        `(max ${MAX_RETRY_ATTEMPTS}); refusing to issue an unauthenticated request`,
      )
    }
    logLine({
      event: "all_keys_cooling_hold",
      waitMs: wait,
      heldMs,
      holdAttempts,
      maxAttempts: MAX_RETRY_ATTEMPTS,
      nextUsableAt: new Date(earliest).toISOString(),
    })
    await sleep(wait) // hold-and-resume: the cooldown window surfaces as latency
    heldMs += wait
    idx = activeIndex()
  }
  return idx
}

export default {
  id: "zai-multi-account",
  async setup(ctx) {
    loadPool(true)
    logLine({ event: "plugin_loaded", poolSize: state.accounts.length })
    const timer = setInterval(() => loadPool(), POOL_RELOAD_MS)

    // Correlates an http.request event to its http.response event by request
    // object (the response event carries the same request reference). Holds
    // the key index and the request start time. If the host does not preserve
    // request identity across the body-rewrite replacement, the miss is
    // logged loudly (correlation_miss) and observable at the 2.3b live gate.
    const pending = new WeakMap()
    // Per-session quota-hold records: { heldMs, holdMs }. The retry hook has
    // no request reference, so per-session is the closest available
    // correlation. holdMs is the per-429 stash (Retry-After-derived wait) and
    // is session-keyed per amendment 5 - a session's stash can no longer be
    // overwritten by another session's 429 (the earlier module-global
    // pendingHoldMs bled across sessions and over-held). heldMs accumulates
    // the hold actually spent, so accounting is bounded in both directions:
    // each wait is capped by the stashed holdMs and the total by
    // ZAI_QUOTA_WAIT_MAX_MS. Known limitation: parallel `title` and `primary`
    // requests share one sessionID and therefore one record (the retry event
    // carries no request/kind reference - an event-surface limit); the max
    // in-hook sleep is measured at the 2.3b live gate.
    const holds = new Map()

    await ctx.session.hook("http.request", async (event) => {
      // --- auth path: failures here are loud, never silent, and the request
      // --- is never issued without credentials.
      let idx
      try {
        idx = await resolveUsableIndex()
      } catch (err) {
        logLine({ event: "hook_auth_failure", hook: "http.request", error: errText(err) })
        throw err
      }
      if (idx === -1) return // empty pool: let config/env auth apply (v1 fail-soft, unchanged; request untouched)
      let key
      try {
        key = state.accounts[idx].apiKey
        // Malformed key material from the pool file throws here (invalid
        // header value) - it must surface loudly, not degrade silently.
        event.request.headers.set("authorization", `Bearer ${key}`)
      } catch (err) {
        const wrapped = pluginError(`http.request auth failed: ${errText(err)}`)
        logLine({ event: "hook_auth_failure", hook: "http.request", error: errText(wrapped) })
        throw wrapped
      }

      // --- non-essential: body-rewrite enhancement + correlation bookkeeping
      // --- + logging. A failure here logs and proceeds with the
      // --- (already authenticated) request.
      try {
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
      } catch (err) {
        logLine({ event: "hook_non_essential_failure", hook: "http.request", error: errText(err) })
      }
    }, { providerID: PROVIDER_ID })

    await ctx.session.hook("http.response", (event) => {
      // --- classification bookkeeping: entirely non-essential. Any failure
      // --- (e.g. a hostile response surface) is logged and the response
      // --- proceeds to the provider/host untouched.
      try {
        const { status } = event.response
        const meta = pending.get(event.request) ?? {}
        if (meta.idx === undefined && state.accounts.length > 0) {
          // Amendment 7: a correlation miss is never silent. If the host does
          // not preserve request identity across the body-rewrite
          // replacement, this line makes it observable (2.3b live gate);
          // cooldowns/401-403 disables would be lost in that case, while
          // holds still work via the session-keyed stash and rotation still
          // advances (bounded by the attempt cap).
          logLine({
            event: "correlation_miss",
            kind: event.kind,
            status,
            sessionID: event.sessionID,
            url: requestUrl(event.request),
          })
        }
        const durationMs = meta.t0 !== undefined ? Date.now() - meta.t0 : null
        logLine({
          event: "http.response",
          kind: event.kind,
          status,
          durationMs,
          keyPrefix: meta.idx !== undefined ? maskKey(state.accounts[meta.idx]?.apiKey) : undefined,
        })

        if (status === 429) {
          // Rate-limited key: cooldown, then stash the Retry-After-derived
          // hold for the retry hook. Rotation to the next usable key happens
          // on the next http.request via activeIndex().
          if (meta.idx !== undefined) state.limitedUntil.set(meta.idx, Date.now() + COOLDOWN_MS)
          const holdMs = quotaWaitMs(event.response, QUOTA_WAIT_POLL_MS)
          // Amendment 11: the V1 /coding/ endpoint gate is restored - only
          // subscription-endpoint 429s drive the hold-and-resume machinery,
          // keeping both halves of this file behavior-aligned under any
          // provider baseURL configuration. The stash is session-keyed
          // (amendment 5), not module-global.
          let stashed = false
          if (isSubscriptionEndpoint(requestUrl(event.request))) {
            const hold = holds.get(event.sessionID) ?? { heldMs: 0 }
            hold.holdMs = holdMs
            holds.set(event.sessionID, hold)
            stashed = true
          }
          logLine({
            event: "quota_429",
            keyIndex: meta.idx,
            holdMs,
            stashed,
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
      } catch (err) {
        logLine({ event: "hook_non_essential_failure", hook: "http.response", error: errText(err) })
      }
    }, { providerID: PROVIDER_ID })

    await ctx.session.hook("retry", async (event) => {
      // --- retry decisions are classification/rotation bookkeeping: a
      // --- failure here logs and proceeds without a decision (the host's
      // --- default retry behavior applies). The authoritative auth path is
      // --- http.request, which fails loudly on key trouble.
      try {
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
            const earliest = earliestCoolingExpiry()
            if (Number.isFinite(earliest)) {
              // Amendment 4: some keys are merely cooling down (429), none is
              // hard-disabled - never answer retry:false while any key is
              // only rate-limited. Force the retry; http.request holds until
              // a key is usable and issues authenticated, so the cooldown
              // surfaces as latency (V1 semantics).
              event.decision = { retry: true, delay: 0 }
              logLine({
                event: "all_keys_cooling_retry",
                status,
                nextUsableAt: new Date(earliest).toISOString(),
              })
              return
            }
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
          //
          // Amendment 11: the hold only runs for a stashed
          // subscription-endpoint 429 (the /coding/ gate is applied when the
          // response stashes). No stash for this session (non-coding URL, or
          // no 429 response seen) means no forced retry - the host default
          // applies, matching the V1 half under any configuration.
          const hold = holds.get(event.sessionID)
          if (hold === undefined || !Number.isFinite(hold.holdMs)) {
            logLine({ event: "quota_429_no_hold", sessionID: event.sessionID, status })
            return
          }
          const wait = Math.min(hold.holdMs, QUOTA_WAIT_MAX_MS - hold.heldMs)
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
      } catch (err) {
        logLine({ event: "hook_non_essential_failure", hook: "retry", error: errText(err) })
      }
    }, { providerID: PROVIDER_ID })

    return () => {
      clearInterval(timer)
      logLine({ event: "unloaded" })
    }
  },
  server: ZaiMultiAccount,
}
