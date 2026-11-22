// Unit tests: pool loading, shape parsing, permissions audit, mtime
// re-check, event-driven (fs.watch) reload, and discovery. Per-scenario
// provider ids isolate pool state inside one module instance; files run in
// separate processes so file-level env is safe.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, rmSync, utimesSync, mkdirSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const work = mkdtempSync(join(tmpdir(), "zma-pool-test-"))
const LOG = join(work, "pool.log")

process.env.ZAI_ACCOUNTS_DIR = work
process.env.ZAI_MULTI_ACCOUNT_LOG = LOG

const { parsePool, getPool, loadPool, watchPool, disposeWatchers, discoverPoolProviders, pathOf } = await import("../src/pool.js")
const { cooldown, disable } = await import("../src/rotation.js")
const { poolPath, ssmCommand } = await import("../src/config.js")

function readLog() {
  try {
    return readFileSync(LOG, "utf-8").trim().split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

function writePool(providerID, accounts, mode) {
  const path = poolPath(providerID)
  writeFileSync(path, JSON.stringify({ accounts }))
  if (mode !== undefined) utimesSync(path, new Date(), new Date(Date.now() + 1000))
}

after(() => {
  disposeWatchers()
})

// --- parsePool shape ---

test("parsePool accepts the documented {accounts:[...]} envelope and keeps labeled entries", () => {
  const parsed = parsePool({ accounts: [{ label: "plan-a", type: "plan", apiKey: "key-a-0001" }] })
  assert.deepEqual(parsed, [{ label: "plan-a", type: "plan", apiKey: "key-a-0001" }])
})

test("parsePool accepts a bare array", () => {
  const parsed = parsePool([{ label: "b", apiKey: "key-b-0001" }])
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].apiKey, "key-b-0001")
})

test("parsePool drops entries without non-empty string apiKey material", () => {
  const parsed = parsePool({
    accounts: [{ label: "ok", apiKey: "key-ok-0001" }, { label: "empty", apiKey: "" }, { label: "wrong", apiKey: 42 }, null, { label: "no-key" }],
  })
  assert.deepEqual(parsed.map((a) => a.apiKey), ["key-ok-0001"])
})

test("parsePool defaults missing label/type and returns [] for junk shapes", () => {
  const parsed = parsePool([{ apiKey: "key-c-0001" }])
  assert.equal(parsed[0].label, "key-1")
  assert.equal(parsed[0].type, "plan")
  assert.deepEqual(parsePool("nope"), [])
  assert.deepEqual(parsePool(null), [])
  assert.deepEqual(parsePool({ accounts: "nope" }), [])
})

// --- loadPool: missing file, first load, announce ---

test("loadPool on a missing file: empty pool, no throw", () => {
  const pool = loadPool("zai-max-pool-missing")
  assert.deepEqual(pool.accounts, [])
  assert.equal(getPool("zai-max-pool-missing"), pool)
})

test("loadPool reads the pool, announces plugin_loaded with provider, poolSize, path", () => {
  writePool("zai-max-pool-a", [{ label: "a1", type: "plan", apiKey: "brim-key-0000001" }, { label: "a2", type: "plan", apiKey: "brim-key-0000002" }])
  loadPool("zai-max-pool-a")
  const line = readLog().find((l) => l.event === "plugin_loaded" && l.providerID === "zai-max-pool-a")
  assert.ok(line, `plugin_loaded must be logged, saw: ${JSON.stringify(readLog().map((l) => l.event))}`)
  assert.equal(line.poolSize, 2)
  assert.equal(line.path, poolPath("zai-max-pool-a"))
})

test("loadPool does not re-announce on subsequent loads", () => {
  writePool("zai-max-pool-a", [{ label: "a1", type: "plan", apiKey: "brim-key-0000001" }], 1) // bump mtime
  loadPool("zai-max-pool-a")
  const announces = readLog().filter((l) => l.event === "plugin_loaded" && l.providerID === "zai-max-pool-a")
  assert.equal(announces.length, 1, "plugin_loaded must fire exactly once per provider")
})

// --- permissions audit ---

test("loadPool loudly warns when pool perms are looser than 0600, and stays quiet at 0600", () => {
  const path = poolPath("zai-max-pool-perms")
  writePool("zai-max-pool-perms", [{ label: "p", apiKey: "perm-key-000001" }])
  chmodSync(path, 0o644)
  loadPool("zai-max-pool-perms", { force: true })
  const warns = readLog().filter((l) => l.event === "pool_perms_warning" && l.providerID === "zai-max-pool-perms")
  assert.equal(warns.length, 1, `perms warning must be logged once, saw: ${JSON.stringify(readLog().map((l) => l.event))}`)
  assert.equal(warns[0].mode, "0644")
  assert.match(warns[0].detail, /chmod 600/)

  chmodSync(path, 0o600)
  loadPool("zai-max-pool-perms", { force: true })
  assert.equal(
    readLog().filter((l) => l.event === "pool_perms_warning" && l.providerID === "zai-max-pool-perms").length,
    1,
    "a 0600 pool must not produce a perms warning",
  )
})

// --- mtime re-check on read ---

test("loadPool short-circuits on unchanged mtime and re-reads when mtime moves", () => {
  const id = "zai-max-pool-mtime"
  // Same-Date mtime pinning: an identical Date input stores identical
  // nanoseconds on every platform, so statSync returns the identical value
  // both times (stat-to-stat equality is what the plugin's short-circuit
  // compares). Assertions are behavioral: content and logs, never raw
  // mtime floats (Linux ns storage makes Date round-trips float-inexact).
  const T = Date.now() + 60000
  writePool(id, [{ label: "one", apiKey: "mtime-key-000001" }])
  utimesSync(poolPath(id), new Date(T), new Date(T))
  const pool = loadPool(id)
  assert.equal(pool.accounts.length, 1)
  assert.equal(pool.accounts[0].apiKey, "mtime-key-000001")
  const announceCount = readLog().filter((l) => l.event === "plugin_loaded" && l.providerID === id).length

  // Swap the content while restoring the exact same mtime: the read path
  // must NOT re-parse (the cache still holds the old key).
  writeFileSync(poolPath(id), JSON.stringify({ accounts: [{ label: "two", apiKey: "mtime-key-000002" }] }))
  utimesSync(poolPath(id), new Date(T), new Date(T))
  loadPool(id)
  assert.equal(pool.accounts.length, 1, "unchanged mtime must short-circuit the re-read")
  assert.equal(pool.accounts[0].apiKey, "mtime-key-000001", "the cached key must be the pre-change one")
  assert.equal(
    readLog().filter((l) => l.event === "pool_reloaded" && l.providerID === id).length,
    0,
    "no pool_reloaded may be logged when the mtime is unchanged",
  )
  assert.ok(
    readLog().filter((l) => l.event === "plugin_loaded" && l.providerID === id).length === announceCount,
    "no re-announce on short-circuit",
  )

  // Move the mtime forward: the read path re-parses and logs pool_reloaded.
  utimesSync(poolPath(id), new Date(T + 5000), new Date(T + 5000))
  loadPool(id)
  assert.equal(pool.accounts.length, 1)
  assert.equal(pool.accounts[0].apiKey, "mtime-key-000002", "moved mtime must trigger the re-read")
  const reloads = readLog().filter((l) => l.event === "pool_reloaded" && l.providerID === id)
  assert.equal(reloads.length, 1)
  assert.equal(reloads[0].poolSize, 1)
  assert.ok(readLog().filter((l) => l.event === "plugin_loaded" && l.providerID === id).length === announceCount, "no re-announce on reload")
})

// --- fs.watch driven reload (condition-polled; no sleeps) ---

test("watchPool reloads the pool when the file changes on disk", async () => {
  const id = "zai-max-pool-watch"
  writePool(id, [{ label: "w1", apiKey: "watch-key-000001" }])
  loadPool(id)
  watchPool(id)

  writePool(id, [{ label: "w1", apiKey: "watch-key-000001" }, { label: "w2", apiKey: "watch-key-000002" }], 1)

  // Condition polling with periodic rewrites: macOS FSEvents can drop or
  // delay the FIRST change event after a watcher installs, so each rewrite
  // during the poll gives the watcher a fresh event; the mtime re-check on
  // read (the plugin's safety net) makes every forced reload cheap. The
  // contract under test is event-driven reload - a reloaded pool within a
  // bounded window, no restart, no periodic timers in the plugin.
  let pool
  for (let i = 0; i < 3000; i++) {
    pool = getPool(id)
    if (pool.accounts.length === 2) break
    if (i % 200 === 0) writePool(id, [{ label: "w1", apiKey: "watch-key-000001" }, { label: "w2", apiKey: "watch-key-000002" }], 1)
    await new Promise((r) => setTimeout(r, 1))
  }
  assert.equal(pool.accounts.length, 2, "fs.watch must trigger the reload")
  const reload = readLog().filter((l) => l.event === "pool_reloaded" && l.providerID === id)
  assert.ok(reload.length >= 1, `pool_reloaded must be logged, saw: ${JSON.stringify(readLog().map((l) => l.event))}`)
})

test("watchPool handles a missing directory (no pool provisioned yet) without throwing", () => {
  process.env.ZAI_ACCOUNTS_DIR = join(work, "does-not-exist")
  assert.doesNotThrow(() => watchPool("zai-max-pool-nowhere"))
  process.env.ZAI_ACCOUNTS_DIR = work
})

// --- discovery ---

test("discoverPoolProviders finds zai-accounts-<provider>.json files and derives provider ids", () => {
  mkdirSync(join(work, "discovery"), { recursive: true })
  process.env.ZAI_ACCOUNTS_DIR = join(work, "discovery")
  writePool("zai-max-disc-1", [{ label: "d", apiKey: "disc-key-000001" }])
  writePool("zai-max-disc-2", [{ label: "d", apiKey: "disc-key-000002" }])
  writeFileSync(join(work, "discovery", "zai-accounts.json"), "{}") // legacy v1 file: not a v2 pool
  writeFileSync(join(work, "discovery", "unrelated.json"), "{}")
  const found = discoverPoolProviders("zai-max-")
  assert.deepEqual(found.sort(), ["zai-max-disc-1", "zai-max-disc-2"])
  process.env.ZAI_ACCOUNTS_DIR = work
})

test("discoverPoolProviders on a missing directory returns []", () => {
  process.env.ZAI_ACCOUNTS_DIR = join(work, "never-created")
  assert.deepEqual(discoverPoolProviders("zai-max-"), [])
  process.env.ZAI_ACCOUNTS_DIR = work
})

// --- path derivation ---

test("poolPath derives <dir>/zai-accounts-<providerID>.json", () => {
  assert.equal(poolPath("zai-max-brim"), join(work, "zai-accounts-zai-max-brim.json"))
  assert.equal(pathOf("zai-max-brim"), poolPath("zai-max-brim"))
})

test("ssmCommand names the provider-specific parameter", () => {
  assert.equal(ssmCommand("zai-max-brim"), "aws ssm get-parameter --name /brimcapitalgroup/zai-max-brim/api-key --with-decryption")
})

// --- per-provider isolation of pool state ---

test("pool state is isolated per provider: cooldowns and disables in one never touch another", () => {
  const a = getPool("zai-max-iso-a")
  const b = getPool("zai-max-iso-b")
  a.accounts = [{ apiKey: "iso-a-key-000001" }, { apiKey: "iso-a-key-000002" }]
  b.accounts = [{ apiKey: "iso-b-key-000001" }]
  cooldown(a, 0, 60000)
  disable(a, 1)
  assert.deepEqual([...b.disabled], [], "provider B disabled set must stay empty")
  assert.equal(b.limitedUntil.size, 0, "provider B cooldowns must stay empty")
  assert.equal(b.active, 0)
})

test("malformed pool JSON: loud request_error line and empty pool (fail-fast at use)", () => {
  const id = "zai-max-pool-broken"
  const path = poolPath(id)
  writeFileSync(path, "{not json")
  chmodSync(path, 0o600)
  utimesSync(path, new Date(), new Date(Date.now() + 90000))
  const pool = loadPool(id, { force: true })
  assert.deepEqual(pool.accounts, [])
  const line = readLog().find((l) => l.event === "request_error" && l.scope === "pool_load" && l.providerID === id)
  assert.ok(line, `pool_load failure must be logged, saw: ${JSON.stringify(readLog().map((l) => l.event))}`)
})

test("teardown removes temp work dir", () => {
  rmSync(work, { recursive: true, force: true })
})
