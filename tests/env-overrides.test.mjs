// Env-override behavior tests. Each scenario arranges its environment BEFORE
// importing a fresh (query-busted) module instance, then drives the hooks and
// asserts observable behavior.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const work = mkdtempSync(join(tmpdir(), "zma-env-test-"))
const POOL = join(work, "zai-accounts.json")
const LOG = join(work, "plugin.log")
const URL = "https://api.z.ai/api/coding/paas/v4/chat/completions"

function setEnv(overrides = {}) {
  process.env.ZAI_ACCOUNTS_PATH = overrides.ZAI_ACCOUNTS_PATH ?? POOL
  if (overrides.ZAI_ROTATE_COOLDOWN_MS === undefined) delete process.env.ZAI_ROTATE_COOLDOWN_MS
  else process.env.ZAI_ROTATE_COOLDOWN_MS = String(overrides.ZAI_ROTATE_COOLDOWN_MS)
  if (overrides.ZAI_QUOTA_WAIT_DISABLED === undefined) delete process.env.ZAI_QUOTA_WAIT_DISABLED
  else process.env.ZAI_QUOTA_WAIT_DISABLED = overrides.ZAI_QUOTA_WAIT_DISABLED
  if (overrides.ZAI_QUOTA_WAIT_MAX_MS === undefined) delete process.env.ZAI_QUOTA_WAIT_MAX_MS
  else process.env.ZAI_QUOTA_WAIT_MAX_MS = String(overrides.ZAI_QUOTA_WAIT_MAX_MS)
  if (overrides.ZAI_QUOTA_WAIT_POLL_MS === undefined) delete process.env.ZAI_QUOTA_WAIT_POLL_MS
  else process.env.ZAI_QUOTA_WAIT_POLL_MS = String(overrides.ZAI_QUOTA_WAIT_POLL_MS)
  if (overrides.ZAI_MAX_RETRY_ATTEMPTS === undefined) delete process.env.ZAI_MAX_RETRY_ATTEMPTS
  else process.env.ZAI_MAX_RETRY_ATTEMPTS = String(overrides.ZAI_MAX_RETRY_ATTEMPTS)
  if (overrides.ZAI_MULTI_ACCOUNT_LOG === undefined) delete process.env.ZAI_MULTI_ACCOUNT_LOG
  else process.env.ZAI_MULTI_ACCOUNT_LOG = overrides.ZAI_MULTI_ACCOUNT_LOG
}

function makeCtx() {
  const hooks = new Map()
  return {
    ctx: { session: { hook: async (name, cb, opts) => { hooks.set(name, { cb, opts }) } } },
    hooks,
  }
}

// Every setup() starts a 30s pool-reload interval; track its cleanup so the
// test process can exit.
const cleanups = []
async function boot(mod) {
  const { ctx, hooks } = makeCtx()
  cleanups.push(await mod.default.setup(ctx))
  return hooks
}
after(() => {
  for (const cleanup of cleanups) cleanup()
})

function reqEvent(body) {
  return { kind: "primary", request: new Request(URL, { method: "POST", body: JSON.stringify(body) }) }
}

function resEvent(request, status, headers = {}) {
  return {
    sessionID: "s1",
    agent: "build",
    model: { providerID: "zai-max", id: "glm-5.3-flash" },
    kind: "primary",
    request,
    response: new Response("{}", { status, headers }),
  }
}

function retryEvent(status, attempt, sessionID = "s1") {
  return {
    sessionID,
    agent: "build",
    model: { providerID: "zai-max", id: "glm-5.3-flash" },
    error: { type: "provider.rate_limit", message: "x", status },
    attempt,
    decision: undefined,
  }
}

async function load(scenario) {
  return import(`../index.js?env=${scenario}`)
}

test("ZAI_ACCOUNTS_PATH with a single-key pool: passthrough auth + body enforcement still apply", async () => {
  const single = join(work, "single.json")
  const key = "solo-key-0001"
  writeFileSync(single, JSON.stringify({ accounts: [{ label: "only", apiKey: key }] }))
  setEnv({ ZAI_ACCOUNTS_PATH: single })
  const mod = await load("single-key")
  const hooks = await boot(mod)
  const event = reqEvent({ model: "glm-5.3-flash", messages: [] })
  await hooks.get("http.request").cb(event)
  assert.equal(event.request.headers.get("authorization"), `Bearer ${key}`)
  const body = JSON.parse(await event.request.clone().text())
  assert.equal(body.reasoning_effort, "high", "single-key pool must still enforce the profile registry")
})

test("ZAI_QUOTA_WAIT_DISABLED=1: 429 no longer forces a retry", async () => {
  writeFileSync(POOL, JSON.stringify({ accounts: [{ label: "a", apiKey: "wait-key-0001" }] }))
  setEnv({ ZAI_QUOTA_WAIT_DISABLED: "1" })
  const mod = await load("wait-disabled")
  const hooks = await boot(mod)
  const event = reqEvent({ model: "glm-5.3-flash", messages: [] })
  await hooks.get("http.request").cb(event)
  await hooks.get("http.response").cb(resEvent(event.request, 429, { "retry-after": "0.01" }))
  const retry = retryEvent(429, 2)
  await hooks.get("retry").cb(retry)
  assert.equal(retry.decision, undefined, "hold-and-resume disabled: the hook must not set a decision")
})

test("ZAI_ROTATE_COOLDOWN_MS=150: the key is skipped during cooldown and reused after expiry", async () => {
  writeFileSync(POOL, JSON.stringify({
    accounts: [{ label: "a", apiKey: "cool-key-0001" }, { label: "b", apiKey: "cool-key-0002" }],
  }))
  setEnv({ ZAI_ROTATE_COOLDOWN_MS: 150 })
  const mod = await load("cooldown")
  const hooks = await boot(mod)

  const event = reqEvent({ model: "glm-5.3-flash", messages: [] })
  await hooks.get("http.request").cb(event)
  assert.equal(event.request.headers.get("authorization"), "Bearer cool-key-0001")
  await hooks.get("http.response").cb(resEvent(event.request, 429))

  const during = reqEvent({ model: "glm-5.3-flash", messages: [] })
  await hooks.get("http.request").cb(during)
  assert.equal(during.request.headers.get("authorization"), "Bearer cool-key-0002", "limited key must be skipped")
  await hooks.get("http.response").cb(resEvent(during.request, 429))

  // Cooldown expiry re-admits key 0001 (150ms window; poll at 250ms). The
  // active key is sticky, so re-admission shows when the NEXT 429 rotates
  // past key 0002 back to key 0001.
  await new Promise((r) => setTimeout(r, 250))
  const still = reqEvent({ model: "glm-5.3-flash", messages: [] })
  await hooks.get("http.request").cb(still)
  assert.equal(still.request.headers.get("authorization"), "Bearer cool-key-0002")
  await hooks.get("http.response").cb(resEvent(still.request, 429))

  const reAdmitted = reqEvent({ model: "glm-5.3-flash", messages: [] })
  await hooks.get("http.request").cb(reAdmitted)
  assert.equal(reAdmitted.request.headers.get("authorization"), "Bearer cool-key-0001", "cooldown expiry must re-admit the key")
})

test("ZAI_QUOTA_WAIT_MAX_MS caps total hold per request, then the error surfaces", async () => {
  writeFileSync(POOL, JSON.stringify({ accounts: [{ label: "a", apiKey: "cap-key-0001" }] }))
  // cap 30ms, poll 10ms: holds of 10+10+10 = 30, then the cap binds.
  setEnv({ ZAI_QUOTA_WAIT_MAX_MS: 30, ZAI_QUOTA_WAIT_POLL_MS: 10 })
  const mod = await load("hold-cap")
  const hooks = await boot(mod)

  const seq = []
  for (let i = 0; i < 4; i++) {
    const t0 = Date.now()
    const retry = retryEvent(429, i + 2, "cap-session")
    await hooks.get("retry").cb(retry)
    seq.push({ decision: retry.decision, elapsed: Date.now() - t0 })
  }
  assert.deepEqual(seq[0].decision, { retry: true, delay: 0 })
  assert.deepEqual(seq[1].decision, { retry: true, delay: 0 })
  assert.deepEqual(seq[2].decision, { retry: true, delay: 0 })
  assert.ok(seq[0].elapsed >= 8 && seq[0].elapsed < 1000, `hold 1 should be ~10ms, saw ${seq[0].elapsed}ms`)
  assert.deepEqual(seq[3].decision, { retry: false }, "cap reached (30ms held): the error must surface")
})

test("ZAI_MAX_RETRY_ATTEMPTS=2 tightens the attempt bound below the default", async () => {
  writeFileSync(POOL, JSON.stringify({ accounts: [{ label: "a", apiKey: "bound-key-0001" }] }))
  setEnv({ ZAI_MAX_RETRY_ATTEMPTS: 2, ZAI_QUOTA_WAIT_POLL_MS: 5 })
  const mod = await load("attempt-bound")
  const hooks = await boot(mod)

  const r2 = retryEvent(429, 2, "bound-session")
  await hooks.get("retry").cb(r2)
  assert.deepEqual(r2.decision, { retry: true, delay: 0 }, "attempt 2 is within the bound of 2")

  const r3 = retryEvent(429, 3, "bound-session")
  await hooks.get("retry").cb(r3)
  assert.deepEqual(r3.decision, { retry: false }, "attempt 3 exceeds the bound: the error must surface")
})

test("ZAI_MULTI_ACCOUNT_LOG: JSON lines land in the file with keys masked to 8 chars", async () => {
  const secret = "supersecret-key-material-9999"
  writeFileSync(POOL, JSON.stringify({ accounts: [{ label: "a", apiKey: secret }] }))
  rmSync(LOG, { force: true })
  setEnv({ ZAI_MULTI_ACCOUNT_LOG: LOG })
  const mod = await load("log-file")
  const hooks = await boot(mod)

  const event = reqEvent({ model: "glm-5.3-flash", messages: [] })
  await hooks.get("http.request").cb(event)
  await hooks.get("http.response").cb(resEvent(event.request, 401))

  const lines = readFileSync(LOG, "utf-8").trim().split("\n").map((l) => JSON.parse(l))
  const events = lines.map((l) => l.event)
  assert.ok(events.includes("plugin_loaded"), `log must contain plugin_loaded, saw: ${events}`)
  assert.ok(events.includes("http.request"), `log must contain http.request, saw: ${events}`)
  assert.ok(events.includes("key_rejected"), `log must contain key_rejected, saw: ${events}`)
  const raw = readFileSync(LOG, "utf-8")
  assert.ok(!raw.includes(secret), "full key material must never reach the log")
  assert.ok(raw.includes("supersec…"), "masked prefix (8 chars + ellipsis) must be present")
})
