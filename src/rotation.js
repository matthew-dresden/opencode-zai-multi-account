// Per-provider rotation state machine over a pool object (src/pool.js shape).
//
// Index-keyed bookkeeping (disabled / limitedUntil) is inherited from v1
// deliberately: a reload that reorders the pool file can land a stale
// disable/cooldown on the wrong slot, but the cost is bounded (one
// mislabeled request) and self-healing - the key actually failing is
// re-classified at its current index on the next 401/403/429.

export function usable(pool, i, now = Date.now()) {
  if (pool.disabled.has(i)) return false
  if ((pool.limitedUntil.get(i) || 0) > now) return false
  return true
}

export function nextUsable(pool, from, now = Date.now()) {
  const n = pool.accounts.length
  for (let k = 1; k <= n; k++) {
    const i = (from + k) % n
    if (usable(pool, i, now)) return i
  }
  return -1
}

// The usable active index: the active slot if usable, else the next usable
// one (rotation forward). -1 when no key is usable right now.
export function activeUsableIndex(pool, now = Date.now()) {
  if (pool.accounts.length === 0) return -1
  if (usable(pool, pool.active, now)) return pool.active
  const next = nextUsable(pool, pool.active, now)
  if (next !== -1) pool.active = next
  return next
}

// Explicit rotation (retry hook on auth errors): advance the active pointer
// to the next usable key. -1 when none is usable.
export function advanceActive(pool, now = Date.now()) {
  const next = nextUsable(pool, pool.active, now)
  if (next !== -1) pool.active = next
  return next
}

// Rate-limited key: cooldown only. Rotation to the next usable key happens
// at the next request resolution (activeUsableIndex) - never here, so each
// 429 advances rotation exactly one step.
export function cooldown(pool, i, cooldownMs, now = Date.now()) {
  pool.limitedUntil.set(i, now + cooldownMs)
}

// Rejected key (401/403): hard-disable only. The retry hook performs the
// single rotation advance so the re-issued request carries the next key.
export function disable(pool, i) {
  pool.disabled.add(i)
}

// Earliest future cooldown expiry among keys that are merely rate-limited -
// hard-disabled keys are excluded because waiting for them is futile.
// Infinity when no key is cooling.
export function earliestCoolingExpiry(pool, now = Date.now()) {
  let earliest = Infinity
  for (const [i, until] of pool.limitedUntil) {
    if (!pool.disabled.has(i) && until > now && until < earliest) earliest = until
  }
  return earliest
}
