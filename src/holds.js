// Quota hold stash and retry decision math.
//
// The stash is keyed by [providerID, sessionID] (JSON-encoded pair): a quota
// hold on one provider or session can never delay another - the isolation
// requirement behind v2's multi-provider design. Each record is
// { holdMs, heldMs }: holdMs is the per-429 server-derived wait (Retry-After
// captured in http.response, else the configured poll interval), heldMs
// accumulates the delay actually issued, bounded by ZAI_QUOTA_WAIT_MAX_MS.
//
// decideRetry is pure: given the classification inputs it returns the retry
// decision and the log event describing the state transition. The host
// applies the delay from { retry: true, delay } (verified on 2.3.2: the
// plugin delay replaces the host's default backoff), so holding surfaces as
// latency with no in-hook sleep on the quota path.
import { quotaWaitMs } from "./zai-quota.js"

const key = (providerID, sessionID) => JSON.stringify([providerID, sessionID])

export class HoldStash {
  constructor() {
    this.holds = new Map()
  }

  start(providerID, sessionID, holdMs) {
    const hold = { holdMs, heldMs: 0 }
    this.holds.set(key(providerID, sessionID), hold)
    return hold
  }

  get(providerID, sessionID) {
    return this.holds.get(key(providerID, sessionID))
  }

  accumulate(providerID, sessionID, waitMs) {
    const hold = this.get(providerID, sessionID)
    if (hold) hold.heldMs += waitMs
    return hold
  }

  clear(providerID, sessionID) {
    this.holds.delete(key(providerID, sessionID))
  }
}

// Server-derived wait for a 429: Retry-After header when present, else the
// configured poll interval.
export function stashWaitMs(response, pollMs) {
  return quotaWaitMs(response, pollMs)
}

// Pure hold math: how much delay the next hold-and-resume retry may take.
// wait 0 (or exhausted) means the budget bound has been reached.
export function holdWaitMs(hold, maxWaitMs) {
  if (!hold || !Number.isFinite(hold.holdMs)) return { wait: 0, exhausted: true, reason: "no-stash" }
  const wait = Math.min(hold.holdMs, maxWaitMs - hold.heldMs)
  if (wait <= 0) return { wait: 0, exhausted: true, reason: "wait-cap" }
  return { wait, exhausted: false, reason: null }
}

// Pure retry decision. Inputs:
//   status            - error.status from the retry event (number)
//   attempt           - event.attempt (the attempt number just failed)
//   hold              - stashed hold for providerID+sessionID, or undefined
//   hasUsable         - whether the pool has a usable key after rotation
//   earliestCoolingAt - earliestCoolingExpiry(pool) at decision time
//   quotaWaitEnabled  - ZAI_QUOTA_WAIT_DISABLED !== "1"
//   maxWaitMs         - ZAI_QUOTA_WAIT_MAX_MS
//   maxAttempts       - ZAI_MAX_RETRY_ATTEMPTS
// Returns { decision, log } where decision is undefined (host default
// applies), { retry: false }, or { retry: true, delay }. `log` carries the
// event name and fields for every state transition.
export function decideRetry({ status, attempt, hold, hasUsable, earliestCoolingAt, quotaWaitEnabled, maxWaitMs, maxAttempts, now = Date.now() }) {
  if (attempt > maxAttempts) {
    return {
      decision: { retry: false },
      log: {
        event: "hold_exhausted",
        reason: "attempt-bound",
        attempt,
        maxAttempts,
        status,
        nextUsableAt: Number.isFinite(earliestCoolingAt) ? new Date(earliestCoolingAt).toISOString() : null,
      },
    }
  }

  if (status === 401 || status === 403) {
    if (hasUsable) {
      // Rotation continues: the retry hook advances the active key and the
      // re-issued request carries it immediately.
      return { decision: { retry: true, delay: 0 }, log: { event: "key_rotated", reason: `status ${status}` } }
    }
    if (Number.isFinite(earliestCoolingAt)) {
      // Some keys are merely rate-limited - never surface retry:false while
      // waiting would help (v1 amendment 4 semantics).
      return {
        decision: { retry: true, delay: Math.max(earliestCoolingAt - now, 0) },
        log: {
          event: "hold_resume",
          reason: "all-keys-cooling",
          status,
          nextUsableAt: new Date(earliestCoolingAt).toISOString(),
        },
      }
    }
    return {
      decision: { retry: false },
      log: { event: "hold_exhausted", reason: "all-keys-disabled", status },
    }
  }

  if (status === 429) {
    if (!quotaWaitEnabled) {
      return { decision: undefined, log: { event: "quota_429_no_hold", reason: "quota-wait-disabled" } }
    }
    if (!hold || !Number.isFinite(hold.holdMs)) {
      // No stashed hold: a non-subscription-endpoint 429 (the /coding/ gate)
      // or a 429 whose response event was never correlated. The host default
      // retry policy applies - the hold machinery never guesses.
      return { decision: undefined, log: { event: "quota_429_no_hold", reason: "no-stash" } }
    }
    const { wait, exhausted, reason } = holdWaitMs(hold, maxWaitMs)
    if (exhausted) {
      return {
        decision: { retry: false },
        log: {
          event: "hold_exhausted",
          reason,
          heldMs: hold.heldMs,
          capMs: maxWaitMs,
          status,
          nextUsableAt: Number.isFinite(earliestCoolingAt) ? new Date(earliestCoolingAt).toISOString() : null,
        },
      }
    }
    return {
      decision: { retry: true, delay: wait },
      log: { event: "hold_resume", reason: "quota-hold", waitMs: wait, heldMs: hold.heldMs + wait, capMs: maxWaitMs },
    }
  }

  return { decision: undefined, log: { event: "request_error", status } }
}
