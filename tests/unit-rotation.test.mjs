// Unit tests: the per-provider rotation state machine (usable / rotate /
// cooldown / disable / earliest-cooling) and the pure retry decision math
// (decideRetry + holdWaitMs + HoldStash isolation).
import { test } from "node:test"
import assert from "node:assert/strict"

const { usable, nextUsable, activeUsableIndex, advanceActive, cooldown, disable, earliestCoolingExpiry } = await import("../src/rotation.js")
const { HoldStash, holdWaitMs, decideRetry } = await import("../src/holds.js")

function makePool(accounts, overrides = {}) {
  return {
    providerID: overrides.providerID || "zai-max-test",
    accounts: accounts.map((apiKey) => ({ label: apiKey.slice(0, 4), type: "plan", apiKey })),
    active: overrides.active || 0,
    disabled: new Set(),
    limitedUntil: new Map(),
  }
}

// --- usable / nextUsable / activeUsableIndex ---

test("usable is true for a fresh index, false for disabled or cooling indexes", () => {
  const pool = makePool(["k1-00000001", "k2-00000001"])
  assert.equal(usable(pool, 0), true)
  disable(pool, 0)
  assert.equal(usable(pool, 0), false)
  cooldown(pool, 1, 60000, 1000)
  assert.equal(usable(pool, 1, 2000), false, "cooling key is unusable inside its window")
  assert.equal(usable(pool, 1, 61000), true, "cooling key re-admits after expiry")
})

test("nextUsable walks forward and wraps; -1 when nobody is usable", () => {
  const pool = makePool(["a1-00000001", "a2-00000001", "a3-00000001"])
  disable(pool, 0)
  assert.equal(nextUsable(pool, 0), 1)
  disable(pool, 1)
  assert.equal(nextUsable(pool, 1), 2)
  disable(pool, 2)
  assert.equal(nextUsable(pool, 2), -1)
})

test("activeUsableIndex returns the active slot when usable, rotates when not, -1 on empty pool", () => {
  const empty = makePool([])
  assert.equal(activeUsableIndex(empty), -1)

  const pool = makePool(["a1-00000001", "a2-00000001"])
  assert.equal(activeUsableIndex(pool), 0)
  cooldown(pool, 0, 60000, 1000)
  assert.equal(activeUsableIndex(pool, 2000), 1, "cooling active key rotates forward")
  assert.equal(pool.active, 1, "rotation advances the active pointer")
})

test("advanceActive moves one step per call and never lands on a disabled slot", () => {
  const pool = makePool(["a1-00000001", "a2-00000001", "a3-00000001"])
  assert.equal(advanceActive(pool), 1)
  assert.equal(advanceActive(pool), 2)
  assert.equal(advanceActive(pool), 0, "rotation wraps around the pool")
  disable(pool, 0)
  assert.equal(advanceActive(pool), 1, "disabled slot is skipped")
})

// --- cooldown / disable / earliestCoolingExpiry ---

test("cooldown records only the rate-limited key; expiry re-admits it", () => {
  const pool = makePool(["a1-00000001", "a2-00000001"])
  cooldown(pool, 0, 60000, 1000)
  assert.equal(pool.limitedUntil.get(0), 60000 + 1000)
  assert.equal(usable(pool, 0, 60001), false)
  assert.equal(usable(pool, 0, 61000), true)
})

test("disable is permanent for the pool lifetime; earliestCoolingExpiry excludes disabled keys", () => {
  const pool = makePool(["a1-00000001", "a2-00000001"])
  disable(pool, 0)
  cooldown(pool, 1, 60000, 1000)
  assert.equal(earliestCoolingExpiry(pool, 2000), 61000, "only the cooling, non-disabled key counts")
  assert.equal(usable(pool, 0, 999999), false, "disabled keys never come back")
})

test("earliestCoolingExpiry is Infinity when nothing is cooling", () => {
  const pool = makePool(["a1-00000001"])
  assert.equal(earliestCoolingExpiry(pool), Infinity)
  cooldown(pool, 0, 100, 1000)
  assert.equal(earliestCoolingExpiry(pool, 2000), Infinity, "expired cooldowns no longer count")
})

// --- per-provider isolation of the state machine ---

test("two providers' machines are fully isolated: rotation in A never moves B", () => {
  const a = makePool(["a1-00000001", "a2-00000001"], { providerID: "zai-max-brim" })
  const b = makePool(["b1-00000001"], { providerID: "zai-max-accordion" })
  disable(a, 0)
  cooldown(a, 1, 60000)
  advanceActive(a)
  assert.equal(b.active, 0)
  assert.equal(b.disabled.size, 0)
  assert.equal(b.limitedUntil.size, 0)
  assert.equal(activeUsableIndex(b), 0, "provider B keeps serving its own key")
})

// --- HoldStash: providerID+sessionID keyed isolation ---

test("HoldStash isolates holds across providers and sessions", () => {
  const stash = new HoldStash()
  stash.start("zai-max-brim", "sess-1", 30000)
  stash.start("zai-max-accordion", "sess-1", 5000)
  stash.start("zai-max-brim", "sess-2", 1000)
  assert.equal(stash.get("zai-max-brim", "sess-1").holdMs, 30000)
  assert.equal(stash.get("zai-max-accordion", "sess-1").holdMs, 5000)
  assert.equal(stash.get("zai-max-brim", "sess-2").holdMs, 1000)

  stash.accumulate("zai-max-brim", "sess-1", 100)
  assert.equal(stash.get("zai-max-brim", "sess-1").heldMs, 100)
  assert.equal(stash.get("zai-max-accordion", "sess-1").heldMs, 0, "accumulation in one provider never bleeds into another")

  stash.clear("zai-max-brim", "sess-1")
  assert.equal(stash.get("zai-max-brim", "sess-1"), undefined)
  assert.ok(stash.get("zai-max-accordion", "sess-1"), "clearing one key leaves the others")
})

// --- holdWaitMs ---

test("holdWaitMs: no stash is exhausted", () => {
  assert.deepEqual(holdWaitMs(undefined, 6000), { wait: 0, exhausted: true, reason: "no-stash" })
})

test("holdWaitMs: wait is the stashed hold until the cap binds", () => {
  assert.deepEqual(holdWaitMs({ holdMs: 500, heldMs: 0 }, 6000), { wait: 500, exhausted: false, reason: null })
  assert.deepEqual(holdWaitMs({ holdMs: 500, heldMs: 5600 }, 6000), { wait: 400, exhausted: false, reason: null }, "wait shrinks to the remaining cap")
  assert.equal(holdWaitMs({ holdMs: 500, heldMs: 6000 }, 6000).exhausted, true, "cap already reached")
  assert.equal(holdWaitMs({ holdMs: 500, heldMs: 6100 }, 6000).exhausted, true, "over the cap")
})

test("holdWaitMs: garbage stash is exhausted", () => {
  assert.equal(holdWaitMs({ holdMs: "soon" }, 6000).exhausted, true)
})

// --- decideRetry ---

const BASE = { maxWaitMs: 6000, maxAttempts: 24, quotaWaitEnabled: true }

test("decideRetry: attempt beyond the bound surfaces the error regardless of status", () => {
  const { decision, log } = decideRetry({ ...BASE, status: 401, attempt: 25, hasUsable: true, earliestCoolingAt: Infinity })
  assert.deepEqual(decision, { retry: false })
  assert.equal(log.event, "hold_exhausted")
  assert.equal(log.reason, "attempt-bound")
  assert.equal(log.maxAttempts, 24)
})

test("decideRetry: 401 with a usable key rotates and retries immediately", () => {
  const { decision, log } = decideRetry({ ...BASE, status: 401, attempt: 2, hasUsable: true, earliestCoolingAt: Infinity })
  assert.deepEqual(decision, { retry: true, delay: 0 })
  assert.equal(log.event, "key_rotated")
})

test("decideRetry: 401 with only cooling keys retries with the cooldown delay (never retry:false)", () => {
  const { decision, log } = decideRetry({ ...BASE, status: 401, attempt: 2, hasUsable: false, earliestCoolingAt: 5000, now: 1000 })
  assert.deepEqual(decision, { retry: true, delay: 4000 })
  assert.equal(log.event, "hold_resume")
  assert.equal(log.reason, "all-keys-cooling")
  assert.equal(log.nextUsableAt, new Date(5000).toISOString())
})

test("decideRetry: 403 with every key hard-disabled surfaces the error", () => {
  const { decision, log } = decideRetry({ ...BASE, status: 403, attempt: 2, hasUsable: false, earliestCoolingAt: Infinity })
  assert.deepEqual(decision, { retry: false })
  assert.equal(log.event, "hold_exhausted")
  assert.equal(log.reason, "all-keys-disabled")
})

test("decideRetry: 429 with no stash leaves the host default in place", () => {
  const { decision, log } = decideRetry({ ...BASE, status: 429, attempt: 2, hold: undefined, hasUsable: false, earliestCoolingAt: Infinity })
  assert.equal(decision, undefined)
  assert.equal(log.event, "quota_429_no_hold")
  assert.equal(log.reason, "no-stash")
})

test("decideRetry: 429 with a stashed Retry-After hold resumes with that delay", () => {
  const hold = { holdMs: 30000, heldMs: 0 }
  const { decision, log } = decideRetry({ ...BASE, maxWaitMs: 600000, status: 429, attempt: 2, hold, hasUsable: false, earliestCoolingAt: Infinity })
  assert.deepEqual(decision, { retry: true, delay: 30000 })
  assert.equal(log.event, "hold_resume")
  assert.equal(log.reason, "quota-hold")
  assert.equal(log.waitMs, 30000)
  assert.equal(log.heldMs, 30000)
})

test("decideRetry: 429 hold accumulates heldMs across retries until the cap binds", () => {
  const hold = { holdMs: 1000, heldMs: 5500 }
  const second = decideRetry({ ...BASE, maxWaitMs: 6000, status: 429, attempt: 3, hold, hasUsable: false, earliestCoolingAt: Infinity })
  assert.deepEqual(second.decision, { retry: true, delay: 500 }, "wait shrinks to the remaining budget")
  const third = decideRetry({ ...BASE, maxWaitMs: 6000, status: 429, attempt: 4, hold: { holdMs: 1000, heldMs: 6000 }, hasUsable: false, earliestCoolingAt: Infinity })
  assert.deepEqual(third.decision, { retry: false })
  assert.equal(third.log.event, "hold_exhausted")
  assert.equal(third.log.reason, "wait-cap")
  assert.equal(third.log.heldMs, 6000)
  assert.equal(third.log.capMs, 6000)
})

test("decideRetry: 429 hold_exhausted names the next key-usable time when keys are cooling", () => {
  const hold = { holdMs: 500, heldMs: 6000 }
  const { log } = decideRetry({ ...BASE, status: 429, attempt: 2, hold, hasUsable: false, earliestCoolingAt: 9000, now: 1000 })
  assert.equal(log.nextUsableAt, new Date(9000).toISOString())
})

test("decideRetry: hold-and-resume disabled leaves the 429 to the host default", () => {
  const { decision, log } = decideRetry({ ...BASE, quotaWaitEnabled: false, status: 429, attempt: 2, hold: { holdMs: 1000, heldMs: 0 }, hasUsable: false, earliestCoolingAt: Infinity })
  assert.equal(decision, undefined)
  assert.equal(log.event, "quota_429_no_hold")
  assert.equal(log.reason, "quota-wait-disabled")
})

test("decideRetry: unknown statuses leave the host default in place", () => {
  const { decision, log } = decideRetry({ ...BASE, status: 500, attempt: 2, hasUsable: true, earliestCoolingAt: Infinity })
  assert.equal(decision, undefined)
  assert.equal(log.event, "request_error")
  assert.equal(log.status, 500)
})
