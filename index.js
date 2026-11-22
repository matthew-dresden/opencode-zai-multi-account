// Z.AI multi-account key rotation plugin for OpenCode (coding-plan endpoint),
// v2: native opencode v2 plugin serving EVERY provider whose id starts with
// "zai-max-" (today: zai-max-brim, zai-max-accordion), each with an isolated
// key pool, rotation, cooldown, and quota hold-and-resume.
//
// Responsibilities:
//   - per-provider key pools (~/.local/share/opencode/zai-accounts-<providerID>.json,
//     chmod 600; ZAI_ACCOUNTS_DIR overrides the base dir), reloaded
//     event-driven via fs.watch plus an mtime re-check on every read - no
//     periodic timers
//   - fail-fast on missing/empty/exhausted pools: a request to any
//     zai-max-* provider without a usable key raises a plugin-attributed
//     error naming the provider, the expected pool path, and the SSM
//     remediation command (this REPLACES the v1 empty-pool fail-soft
//     passthrough and the getAuth() fallback - no silent unauthenticated
//     requests, ever)
//   - key rotation on auth errors (401/403: disable, rotate, retry with
//     delay 0) and rate limits (429: cooldown, rotate)
//   - quota hold-and-resume: a 429 on a /coding/ subscription endpoint
//     stashes the server-derived wait (Retry-After header, else the
//     configured poll interval) per providerID+sessionID; the retry hook
//     decides { retry: true, delay } and the host applies the delay, so a
//     quota window surfaces as latency. A hold on one provider or session
//     can never delay another.
//   - attempt/hold budgets: total hold per request <= ZAI_QUOTA_WAIT_MAX_MS,
//     total attempts <= ZAI_MAX_RETRY_ATTEMPTS; past either bound the retry
//     decision is { retry: false } with a loud log naming the state and the
//     next key-usable time
//   - model profile enforcement on the wire body (bundled profiles get the
//     final word on temperature/thinking/reasoning fields)
//   - structured JSONL logging of EVERY state transition, provider-tagged,
//     keys masked to first4/last4 - never a full key
//
// Hook registration is unscoped and filtered internally on the provider-id
// prefix: scoping would require enumerating provider ids at setup time,
// while the filter serves every current and future zai-max-* provider.
// Verified on host 2.3.2 (see SPIKE-RESULTS.md): events carry
// model.providerID; request identity is preserved across the
// http.request -> http.response pair; retry decisions (including
// { retry: true, delay } overrides of the host default) are honored.
//
// The quota-wait, request-body, model-profile, pool, rotation, hold, config,
// and log helpers live in src/ as dependency-free modules.
import { PROVIDER_PREFIX, failFastMessage, quotaWaitEnabled, quotaWaitMaxMs, quotaPollMs, maxRetryAttempts, cooldownMs } from "./src/config.js"
import { logLine, maskKey, pluginError, errText, isSubscriptionEndpoint, requestUrl } from "./src/log.js"
import { discoverPoolProviders, getPool, loadPool, watchPool, disposeWatchers, pathOf } from "./src/pool.js"
import { activeUsableIndex, advanceActive, cooldown, disable, earliestCoolingExpiry } from "./src/rotation.js"
import { HoldStash, stashWaitMs, decideRetry } from "./src/holds.js"
import { withProfileBody } from "./src/request-body.js"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function owns(providerID) {
  return typeof providerID === "string" && providerID.startsWith(PROVIDER_PREFIX)
}

// Resolves a usable pool index for an outgoing request. Fails fast (throws
// plugin-attributed errors) when the pool is empty, every key is
// hard-disabled, or the all-cooling hold budget is exhausted - the request
// is never issued without credentials. When keys are merely cooling down,
// the cooldown window surfaces as latency: the hold waits until the
// earliest expiry, bounded by the budgets.
async function resolveUsableIndex(providerID) {
  loadPool(providerID) // mtime re-check on every read
  watchPool(providerID) // no-op once watching; starts if the dir now exists
  const pool = getPool(providerID)
  if (pool.accounts.length === 0) {
    throw pluginError(failFastMessage(providerID, pathOf(providerID), "is missing or empty"))
  }
  const from = pool.active
  let idx = activeUsableIndex(pool)
  if (idx >= 0) {
    if (idx !== from) {
      logLine({ event: "key_rotated", providerID, from, to: idx, keyPrefix: maskKey(pool.accounts[idx].apiKey), reason: "active-key-unusable" })
    }
    return idx
  }

  let heldMs = 0
  let holdAttempts = 0
  for (;;) {
    const now = Date.now()
    idx = activeUsableIndex(pool, now)
    if (idx >= 0) {
      logLine({ event: "hold_resume", providerID, reason: "cooldown-expired", heldMs, keyPrefix: maskKey(pool.accounts[idx].apiKey) })
      return idx
    }
    holdAttempts += 1
    const earliest = earliestCoolingExpiry(pool, now)
    if (!Number.isFinite(earliest)) {
      // Every key hard-disabled (401/403): waiting is futile, and issuing
      // unauthenticated is forbidden - fail loudly with the remediation.
      logLine({ event: "hold_exhausted", providerID, reason: "all-keys-disabled", poolSize: pool.accounts.length })
      throw pluginError(failFastMessage(providerID, pathOf(providerID), `: all ${pool.accounts.length} keys are hard-disabled (401/403)`))
    }
    const budgetLeft = quotaWaitMaxMs() - heldMs
    const wait = Math.min(earliest - now, budgetLeft)
    if (holdAttempts > maxRetryAttempts() || wait <= 0) {
      const at = new Date(earliest).toISOString()
      logLine({ event: "hold_exhausted", providerID, reason: "all-keys-cooling", heldMs, holdAttempts, maxAttempts: maxRetryAttempts(), capMs: quotaWaitMaxMs(), nextUsableAt: at })
      throw pluginError(
        `provider "${providerID}": all keys cooling down; next key usable at ${at}; ` +
        `held ${heldMs}ms of the ${quotaWaitMaxMs()}ms cap across ${holdAttempts} hold attempts ` +
        `(max ${maxRetryAttempts()}); refusing to issue an unauthenticated request`,
      )
    }
    logLine({ event: "hold_start", providerID, reason: "all-keys-cooling", waitMs: wait, heldMs, holdAttempts, nextUsableAt: new Date(earliest).toISOString() })
    await sleep(wait) // hold-and-resume: the cooldown window surfaces as latency
    heldMs += wait
  }
}

export default {
  id: "zai-multi-account",
  async setup(ctx) {
    // Announce every provisioned pool at startup and watch it for edits.
    // Pools provisioned later announce on first use (lazy plugin_loaded).
    for (const providerID of discoverPoolProviders(PROVIDER_PREFIX)) {
      loadPool(providerID)
      watchPool(providerID)
    }

    // Correlates an http.request event to its http.response event by request
    // object (verified on 2.3.2: identity is preserved). Holds the key index
    // and request start time so per-key classification and durations work.
    const pending = new WeakMap()
    // Quota-hold stash: keyed [providerID, sessionID] - strict isolation.
    const holds = new HoldStash()

    await ctx.session.hook("http.request", async (event) => {
      const providerID = event.model?.providerID
      if (!owns(providerID)) return

      // --- auth path: failures here are loud, never silent, and the
      // --- request is never issued without credentials.
      let idx
      try {
        idx = await resolveUsableIndex(providerID)
      } catch (err) {
        logLine({ event: "request_error", providerID, scope: "resolve", sessionID: event.sessionID, error: errText(err) })
        throw err
      }
      const pool = getPool(providerID)
      const key = pool.accounts[idx].apiKey
      try {
        // Malformed key material from the pool file throws here (invalid
        // header value) - it must surface loudly, not degrade silently.
        event.request.headers.set("authorization", `Bearer ${key}`)
      } catch (err) {
        const wrapped = pluginError(`http.request auth failed for provider "${providerID}": ${errText(err)}`)
        logLine({ event: "request_error", providerID, scope: "auth", sessionID: event.sessionID, error: errText(wrapped) })
        throw wrapped
      }

      // --- non-essential: body-rewrite enhancement + correlation
      // --- bookkeeping. A failure here logs and proceeds with the
      // --- (already authenticated) request.
      try {
        const enforced = await withProfileBody(event.request, undefined, (message) =>
          logLine({ event: "body", providerID, message }),
        )
        if (enforced.input instanceof Request && enforced.input !== event.request) {
          event.request = enforced.input
        }
        pending.set(event.request, { idx, t0: Date.now() })
        logLine({ event: "http.request", providerID, kind: event.kind, sessionID: event.sessionID, keyPrefix: maskKey(key), url: event.request.url })
      } catch (err) {
        logLine({ event: "hook_non_essential_failure", hook: "http.request", providerID, error: errText(err) })
      }
    })

    await ctx.session.hook("http.response", (event) => {
      const providerID = event.model?.providerID
      if (!owns(providerID)) return
      // --- classification bookkeeping: entirely non-essential. Any failure
      // --- is logged and the response proceeds untouched.
      try {
        const { status } = event.response
        const url = requestUrl(event.request)
        const meta = pending.get(event.request) ?? {}
        const pool = getPool(providerID)
        const keyPrefix = meta.idx !== undefined ? maskKey(pool.accounts[meta.idx]?.apiKey) : undefined
        if (meta.idx === undefined && pool.accounts.length > 0) {
          // Never silent: an uncorrelated response means cooldown/disable
          // bookkeeping was lost for this response (holds still work via the
          // session-keyed stash; rotation still advances, bounded by the
          // attempt cap).
          logLine({ event: "correlation_miss", providerID, kind: event.kind, status, sessionID: event.sessionID, url })
        }
        const durationMs = meta.t0 !== undefined ? Date.now() - meta.t0 : null
        if (status >= 400) {
          logLine({ event: "request_error", providerID, status, kind: event.kind, sessionID: event.sessionID, keyPrefix, durationMs, url })
        } else {
          logLine({ event: "http.response", providerID, status, kind: event.kind, sessionID: event.sessionID, keyPrefix, durationMs, url })
          holds.clear(providerID, event.sessionID)
        }

        if (status === 429) {
          // Rate-limited key: cooldown (rotation to the next usable key
          // happens on the next http.request resolution), then stash the
          // server-derived hold for the retry hook - subscription /coding/
          // endpoints only (the v1 gate).
          if (meta.idx !== undefined) {
            cooldown(pool, meta.idx, cooldownMs())
            logLine({ event: "key_cooldown", providerID, keyIndex: meta.idx, keyPrefix, cooldownMs: cooldownMs(), url })
          }
          if (isSubscriptionEndpoint(url)) {
            const holdMs = stashWaitMs(event.response, quotaPollMs())
            holds.start(providerID, event.sessionID, holdMs)
            logLine({
              event: "hold_start",
              providerID,
              reason: "quota-429",
              sessionID: event.sessionID,
              holdMs,
              source: event.response.headers.get("retry-after") !== null ? "retry-after" : "poll",
              url,
            })
          } else {
            logLine({ event: "quota_429_no_hold", providerID, reason: "non-subscription-endpoint", sessionID: event.sessionID, url })
          }
          return
        }

        if ((status === 401 || status === 403) && meta.idx !== undefined) {
          // Rejected key: hard-disable it; the retry hook advances the
          // active key and forces the immediate retry.
          disable(pool, meta.idx)
          logLine({ event: "key_disabled", providerID, status, keyIndex: meta.idx, keyPrefix, url })
        }
      } catch (err) {
        logLine({ event: "hook_non_essential_failure", hook: "http.response", providerID, error: errText(err) })
      }
    })

    await ctx.session.hook("retry", (event) => {
      const providerID = event.model?.providerID
      if (!owns(providerID)) return
      // --- retry decisions are classification/rotation bookkeeping: a
      // --- failure here logs and leaves the host default in place. The
      // --- authoritative auth path is http.request, which fails loudly on
      // --- key trouble.
      try {
        const pool = loadPool(providerID)
        const status = event.error?.status

        // Auth errors: rotate the active key now (the failed key was already
        // hard-disabled by the correlated http.response) so the re-issued
        // request carries the next key with delay 0.
        let hasUsable = false
        if (status === 401 || status === 403) {
          const next = advanceActive(pool)
          hasUsable = next !== -1
          if (hasUsable) {
            logLine({ event: "key_rotated", providerID, to: maskKey(pool.accounts[next]?.apiKey), reason: `status ${status}`, sessionID: event.sessionID })
          }
        }

        const hold = holds.get(providerID, event.sessionID)
        const { decision, log } = decideRetry({
          status,
          attempt: event.attempt,
          hold,
          hasUsable,
          earliestCoolingAt: earliestCoolingExpiry(pool),
          quotaWaitEnabled: quotaWaitEnabled(),
          maxWaitMs: quotaWaitMaxMs(),
          maxAttempts: maxRetryAttempts(),
        })
        if (decision) event.decision = decision
        if (decision?.retry && status === 429 && decision.delay > 0) {
          holds.accumulate(providerID, event.sessionID, decision.delay)
        }
        logLine({ ...log, providerID, sessionID: event.sessionID, attempt: event.attempt })
      } catch (err) {
        logLine({ event: "hook_non_essential_failure", hook: "retry", providerID, error: errText(err) })
      }
    })

    return () => {
      disposeWatchers()
      logLine({ event: "unloaded" })
    }
  },
}
