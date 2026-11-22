// Regression suite: the v2 plugin export shape, hook registration surface,
// setup announce/cleanup lifecycle, lazy env tunables, the fail-fast message
// contract, and key masking. Ported scenarios from the v1 suites that still
// apply under the multi-provider v2 architecture (the v1 auth-loader shape
// tests are obsolete: v2 has no auth export and no getAuth() fallback).
import { test, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, rmSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const work = mkdtempSync(join(tmpdir(), "zma-regression-test-"))
const LOG = join(work, "regression.log")

process.env.ZAI_ACCOUNTS_DIR = work
process.env.ZAI_MULTI_ACCOUNT_LOG = LOG

const mod = await import("../index.js")
const { pathOf, disposeWatchers } = await import("../src/pool.js")
const config = await import("../src/config.js")
const { maskKey, pluginError } = await import("../src/log.js")

function makeCtx() {
  const hooks = new Map()
  const opts = []
  return {
    ctx: {
      session: {
        hook: async (name, cb, o) => {
          hooks.set(name, cb)
          opts.push({ name, opts: o })
          return { dispose: async () => hooks.delete(name) }
        },
      },
    },
    hooks,
    opts,
  }
}

function writePool(providerID, accounts) {
  const path = pathOf(providerID)
  writeFileSync(path, JSON.stringify({ accounts }))
  utimesSync(path, new Date(), new Date(Date.now() + 60000))
}

function readLog() {
  try {
    return readFileSync(LOG, "utf-8").trim().split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

after(() => {
  disposeWatchers()
  rmSync(work, { recursive: true, force: true })
})

// --- v2 export shape (replaces the v1 dual-shape/compat tests) ---

test("default export is the v2 plugin: { id, setup } and nothing else", () => {
  assert.equal(mod.default.id, "zai-multi-account")
  assert.equal(typeof mod.default.setup, "function")
  assert.equal(mod.default.server, undefined, "the v1 server() compat shape must be gone")
  assert.equal(mod.default.auth, undefined, "v2 has no auth export: hooks own auth")
  assert.equal(mod.ZaiMultiAccount, undefined, "the v1 entrypoint must be gone")
  assert.equal(Object.keys(mod.default).length, 2, "exactly id and setup are exported")
})

test("the package stays dependency-free: no runtime dependencies declared", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"))
  assert.deepEqual(pkg.dependencies, undefined)
  assert.deepEqual(pkg.peerDependencies, undefined)
})

// --- hook registration surface ---

test("setup registers http.request, http.response, and retry, all unscoped, and returns a cleanup", async () => {
  const { ctx, opts } = makeCtx()
  const cleanup = await mod.default.setup(ctx)
  assert.equal(typeof cleanup, "function")
  assert.deepEqual(opts.map((o) => o.name).sort(), ["http.request", "http.response", "retry"])
  for (const o of opts) {
    assert.equal(o.opts, undefined, "hooks are registered unscoped: the provider prefix filter lives in the callbacks")
  }
  assert.doesNotThrow(() => cleanup())
  assert.doesNotThrow(() => cleanup(), "cleanup must be idempotent")
})

test("setup announces every provisioned pool once with provider, poolSize, path", async () => {
  writePool("zai-max-reg-brim", [{ label: "b", type: "plan", apiKey: "regB-key-alpha-1" }])
  writePool("zai-max-reg-acc", [{ label: "a", type: "plan", apiKey: "regA-key-alpha-1" }, { label: "a2", apiKey: "regA-key-beta-02" }])
  const { ctx } = makeCtx()
  await mod.default.setup(ctx)
  const announces = readLog().filter((l) => l.event === "plugin_loaded" && (l.providerID === "zai-max-reg-brim" || l.providerID === "zai-max-reg-acc"))
  assert.equal(announces.length, 2, `each pool announces once, saw: ${JSON.stringify(readLog().map((l) => l.event))}`)
  const brim = announces.find((l) => l.providerID === "zai-max-reg-brim")
  assert.equal(brim.poolSize, 1)
  assert.equal(brim.path, pathOf("zai-max-reg-brim"))
  const acc = announces.find((l) => l.providerID === "zai-max-reg-acc")
  assert.equal(acc.poolSize, 2)
})

// --- lazy env tunables ---

test("tunables are read lazily from env at use time", () => {
  const prev = { ...process.env }
  try {
    process.env.ZAI_QUOTA_WAIT_DISABLED = "1"
    assert.equal(config.quotaWaitEnabled(), false)
    delete process.env.ZAI_QUOTA_WAIT_DISABLED
    assert.equal(config.quotaWaitEnabled(), true)

    process.env.ZAI_QUOTA_POLL_MS = "777"
    assert.equal(config.quotaPollMs(), 777)
    delete process.env.ZAI_QUOTA_POLL_MS
    assert.equal(config.quotaPollMs(), 300000)

    process.env.ZAI_QUOTA_WAIT_MAX_MS = "12345"
    assert.equal(config.quotaWaitMaxMs(), 12345)
    delete process.env.ZAI_QUOTA_WAIT_MAX_MS
    assert.equal(config.quotaWaitMaxMs(), 21600000)

    process.env.ZAI_MAX_RETRY_ATTEMPTS = "3"
    assert.equal(config.maxRetryAttempts(), 3)
    delete process.env.ZAI_MAX_RETRY_ATTEMPTS
    assert.equal(config.maxRetryAttempts(), 24)

    process.env.ZAI_ROTATE_COOLDOWN_MS = "987"
    assert.equal(config.cooldownMs(), 987)
    delete process.env.ZAI_ROTATE_COOLDOWN_MS
    assert.equal(config.cooldownMs(), 60000)

    process.env.ZAI_MULTI_ACCOUNT_LOG = join(work, "redirected.log")
    assert.equal(config.logPath(), join(work, "redirected.log"))
    delete process.env.ZAI_MULTI_ACCOUNT_LOG
    assert.equal(config.logPath(), null)
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in prev)) delete process.env[key]
    }
  }
})

test("invalid numeric env falls back to the documented default", () => {
  process.env.ZAI_QUOTA_POLL_MS = "soon"
  assert.equal(config.quotaPollMs(), 300000)
  process.env.ZAI_MAX_RETRY_ATTEMPTS = "-5"
  assert.equal(config.maxRetryAttempts(), 24)
  delete process.env.ZAI_QUOTA_POLL_MS
  delete process.env.ZAI_MAX_RETRY_ATTEMPTS
})

// --- fail-fast message contract ---

test("failFastMessage names provider, pool path, the SSM command, and the pool shape", () => {
  const providerID = "zai-max-brim"
  const thrown = pluginError(config.failFastMessage(providerID, pathOf(providerID), "is missing or empty"))
  const msg = thrown.message
  assert.match(msg, /zai-multi-account: provider "zai-max-brim" has no usable keys/)
  assert.match(msg, /zai-accounts-zai-max-brim\.json is missing or empty/)
  assert.match(msg, /aws ssm get-parameter --name \/brimcapitalgroup\/zai-max-brim\/api-key --with-decryption/)
  assert.match(msg, /\{"accounts":\[\{"label":"<plan>","type":"plan","apiKey":"<key from SSM>"\}\]\}/)
  assert.match(msg, /chmod 600/)
})

// --- key masking ---

test("maskKey shows first4/last4 for normal keys and fully masks short or non-string material", () => {
  assert.equal(maskKey("supersecret-key-material-9999"), "supe...9999")
  assert.equal(maskKey("abcdefghijkl"), "abcd...ijkl")
  assert.equal(maskKey("abcd"), "****", "keys shorter than 8 characters must be fully masked")
  assert.equal(maskKey("12345678"), "1234...5678")
  assert.equal(maskKey(undefined), "****")
  assert.equal(maskKey(null), "****")
  assert.equal(maskKey(42), "****")
})

// --- superseded v1 surfaces stay gone ---

test("no legacy env names remain: ZAI_ACCOUNTS_PATH and ZAI_QUOTA_WAIT_POLL_MS are retired", async () => {
  const indexSource = readFileSync(new URL("../index.js", import.meta.url), "utf-8")
  const src = await import("../src/config.js")
  assert.ok(!indexSource.includes("ZAI_ACCOUNTS_PATH"), "the v1 pool-path env is retired")
  assert.ok(!indexSource.includes("ZAI_QUOTA_WAIT_POLL_MS"), "the v1 poll env is retired (renamed ZAI_QUOTA_POLL_MS)")
  assert.equal(typeof src.accountsDir, "function")
})

test("the ported helpers remain importable (zai-quota, request-body, model-profiles)", async () => {
  const quota = await import("../src/zai-quota.js")
  const body = await import("../src/request-body.js")
  const profiles = await import("../src/model-profiles.js")
  assert.equal(typeof quota.quotaWaitMs, "function")
  assert.equal(typeof body.withProfileBody, "function")
  assert.equal(typeof profiles.applyProfileToBody, "function")
  assert.equal(typeof profiles.resolveProfile, "function")
})
