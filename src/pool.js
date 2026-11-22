// Per-provider key-pool registry.
//
// One isolated pool per provider id (state lives in the pool object):
//   { providerID, accounts, active, disabled, limitedUntil, ... }
// There is no shared or global pool state - a quota hold, cooldown, or
// disable on one provider can never touch another.
//
// Reload is event-driven only: an fs.watch on the pool file's parent
// directory (editors save atomically, so the directory is the reliable
// watch target) plus an mtime re-check on every read. No periodic timers.
// Pool files are never written by this plugin; permissions looser than 0600
// are logged loudly on every load.
import { readFileSync, readdirSync, statSync, watch } from "node:fs"
import { basename, dirname } from "node:path"
import { accountsDir, poolPath as poolPathFor } from "./config.js"
import { logLine } from "./log.js"

const pools = new Map() // providerID -> pool state
const watchers = new Map() // providerID -> { watcher, debounce }

// The pool file path is derived lazily on every use so a ZAI_ACCOUNTS_DIR
// retune applies without a restart.
export function pathOf(providerID) {
  return poolPathFor(providerID)
}

export function allPools() {
  return [...pools.values()]
}

export function getPool(providerID) {
  let pool = pools.get(providerID)
  if (!pool) {
    pool = {
      providerID,
      accounts: [],
      active: 0,
      disabled: new Set(),
      limitedUntil: new Map(),
      mtimeMs: 0,
      announced: false,
      loadedAt: 0,
    }
    pools.set(providerID, pool)
  }
  return pool
}

// Pure shape parse: accepts the documented {"accounts":[...]} envelope or a
// bare array; keeps only entries with non-empty string apiKey material.
export function parsePool(raw) {
  const accounts = Array.isArray(raw) ? raw : raw?.accounts
  if (!Array.isArray(accounts)) return []
  return accounts
    .filter((a) => a && typeof a.apiKey === "string" && a.apiKey.length > 0)
    .map((a, i) => ({ label: typeof a.label === "string" ? a.label : `key-${i + 1}`, type: typeof a.type === "string" ? a.type : "plan", apiKey: a.apiKey }))
}

function statPool(path) {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

// Load (or re-load) the pool for a provider. Reads only when the file mtime
// moved past the last load, so the per-request read path is cheap. Force
// bypasses the mtime short-circuit (first touch, watch events).
export function loadPool(providerID, { force = false, announce = true } = {}) {
  const pool = getPool(providerID)
  const path = pathOf(providerID)
  const stat = statPool(path)
  if (!stat) {
    if (pool.accounts.length > 0 || force) {
      pool.accounts = []
      pool.mtimeMs = 0
      logLine({ event: "pool_reloaded", providerID, poolSize: 0, path, reason: "file missing" })
    }
    return pool
  }
  const mtimeMs = stat.mtimeMs
  if (!force && pool.loadedAt > 0 && mtimeMs === pool.mtimeMs) return pool

  let accounts = []
  try {
    accounts = parsePool(JSON.parse(readFileSync(path, "utf-8")))
  } catch (err) {
    accounts = []
    logLine({ event: "request_error", providerID, scope: "pool_load", error: err?.message || String(err), path })
  }
  const perms = stat.mode & 0o777
  if ((perms & 0o077) !== 0) {
    logLine({
      event: "pool_perms_warning",
      providerID,
      path,
      mode: `0${perms.toString(8)}`,
      detail: "pool file permissions are looser than 0600; tighten with chmod 600",
    })
  }
  pool.accounts = accounts
  pool.mtimeMs = mtimeMs
  pool.loadedAt = Date.now()
  if (pool.active >= pool.accounts.length) pool.active = 0
  if (!pool.announced) {
    pool.announced = true
    if (announce) logLine({ event: "plugin_loaded", providerID, poolSize: accounts.length, path })
  } else {
    logLine({ event: "pool_reloaded", providerID, poolSize: accounts.length, path })
  }
  return pool
}

// Event-driven reload: watch the pool's parent directory and re-read on any
// event touching the pool file (filename can be null on some platforms - in
// that case re-read unconditionally; the mtime check makes it free). The
// debounce collapses edit bursts into one reload. On macOS the first change
// event after install can be dropped or delayed by FSEvents batching; the
// mtime re-check on read is the safety net that keeps edits applying
// without a restart.
export function watchPool(providerID) {
  if (watchers.has(providerID)) return
  const dir = dirname(pathOf(providerID))
  const file = basename(pathOf(providerID))
  try {
    const watcher = watch(dir, (_event, filename) => {
      if (filename !== null && filename !== file) return
      const existing = watchers.get(providerID)
      if (existing?.debounce) clearTimeout(existing.debounce)
      const debounce = setTimeout(() => {
        const w = watchers.get(providerID)
        if (w) w.debounce = null
        loadPool(providerID, { force: true })
      }, 50)
      watchers.set(providerID, { watcher, debounce })
    })
    watcher.unref?.()
    watchers.set(providerID, { watcher, debounce: null })
  } catch {
    // The directory does not exist (no pool provisioned yet). The fail-fast
    // path at request time names the expected path; watching stays off until
    // a pool exists there.
  }
}

export function disposeWatchers() {
  for (const [, w] of watchers) {
    if (w.debounce) clearTimeout(w.debounce)
    try {
      w.watcher.close()
    } catch {}
  }
  watchers.clear()
}

// Discover provisioned pools on disk at setup time (zai-accounts-<prefix>*.json)
// so plugin_loaded is emitted per provider without waiting for first traffic.
export function discoverPoolProviders(prefix) {
  let entries = []
  try {
    entries = readdirSync(accountsDir())
  } catch {
    return []
  }
  return entries
    .filter((name) => name.startsWith(`zai-accounts-${prefix}`) && name.endsWith(".json"))
    .map((name) => name.slice("zai-accounts-".length, -".json".length))
}
