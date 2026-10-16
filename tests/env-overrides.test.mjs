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

function reqEvent(body, url = URL) {
  return { kind: "primary", request: new Request(url, { method: "POST", body: JSON.stringify(body) }) }
}

function resEvent(request, status, headers = {}, sessionID = "s1") {
  return {
    sessionID,
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

  // Seed a stashed subscription-endpoint 429 for the session (the /coding/
  // gate restored per amendment 11: only a stashed 429 hold drives retries).
  const seed = reqEvent({ model: "glm-5.3-flash", messages: [] })
  await hooks.get("http.request").cb(seed)
  await hooks.get("http.response").cb(resEvent(seed.request, 429, {}, "cap-session"))

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

  // Seed a stashed subscription-endpoint 429 for the session (see hold-cap).
  const seed = reqEvent({ model: "glm-5.3-flash", messages: [] })
  await hooks.get("http.request").cb(seed)
  await hooks.get("http.response").cb(resEvent(seed.request, 429, {}, "bound-session"))

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

// --- Review-round additions (findings 1, 2, 6) ---

test("all keys cooling down: request holds until cooldown expiry and never goes out unauthenticated", async () => {
  const key = "solo-cool-key-01"
  writeFileSync(POOL, JSON.stringify({ accounts: [{ label: "a", apiKey: key }] }))
  // Cooldown 200ms >> Retry-After 10ms: the re-issued request arrives while
  // the only key is still cooling - it must hold (latency, V1 semantics),
  // never go out unauthenticated.
  setEnv({ ZAI_ROTATE_COOLDOWN_MS: 200, ZAI_QUOTA_WAIT_POLL_MS: 5 })
  const mod = await load("all-cooling-hold")
  const hooks = await boot(mod)

  const first = reqEvent({ model: "glm-5.3-flash", messages: [] })
  await hooks.get("http.request").cb(first)
  assert.equal(first.request.headers.get("authorization"), `Bearer ${key}`, "every issued request carries auth (1/2)")

  await hooks.get("http.response").cb(resEvent(first.request, 429, { "retry-after": "0.01" }, "cool-sess"))
  const retry = retryEvent(429, 2, "cool-sess")
  await hooks.get("retry").cb(retry)
  assert.deepEqual(retry.decision, { retry: true, delay: 0 })

  const t0 = Date.now()
  const reissue = reqEvent({ model: "glm-5.3-flash", messages: [] })
  await hooks.get("http.request").cb(reissue)
  const elapsed = Date.now() - t0
  assert.ok(elapsed >= 120, `all-cooling request must hold past the Retry-After window (~190ms), saw ${elapsed}ms`)
  assert.ok(elapsed < 5000, `hold must not run past the cooldown window, saw ${elapsed}ms`)
  assert.equal(
    reissue.request.headers.get("authorization"),
    `Bearer ${key}`,
    "every issued request carries auth (2/2): the held re-issue goes out authenticated once a key is usable",
  )
})

test("all keys cooling down: budget exhaustion surfaces a loud error naming the state and next retry time", async () => {
  const key = "coolcap-key-001"
  writeFileSync(POOL, JSON.stringify({ accounts: [{ label: "a", apiKey: key }] }))
  // Cooldown 5000ms >> hold cap 40ms: the all-cooling hold must exhaust its
  // budget and fail loudly instead of waiting out the full cooldown.
  setEnv({ ZAI_ROTATE_COOLDOWN_MS: 5000, ZAI_QUOTA_WAIT_MAX_MS: 40, ZAI_QUOTA_WAIT_POLL_MS: 5, ZAI_MAX_RETRY_ATTEMPTS: 50 })
  const mod = await load("all-cooling-cap")
  const hooks = await boot(mod)

  const first = reqEvent({ model: "glm-5.3-flash", messages: [] })
  await hooks.get("http.request").cb(first)
  await hooks.get("http.response").cb(resEvent(first.request, 429))

  const reissue = reqEvent({ model: "glm-5.3-flash", messages: [] })
  const t0 = Date.now()
  await assert.rejects(
    hooks.get("http.request").cb(reissue),
    (err) => {
      assert.match(err.message, /zai-multi-account/)
      assert.match(err.message, /all keys cooling down/)
      assert.match(err.message, /next key usable at /)
      const iso = err.message.match(/next key usable at ([^;]+);/)[1]
      assert.ok(!Number.isNaN(Date.parse(iso)), `next retry time must be a timestamp, saw: ${iso}`)
      assert.match(err.message, /unauthenticated/)
      return true
    },
  )
  const elapsed = Date.now() - t0
  assert.ok(elapsed < 1000, `budget exhaustion must bind at the 40ms cap, saw ${elapsed}ms`)
  assert.equal(reissue.request.headers.get("authorization"), null, "no unauthenticated request may escape")
})

test("non-essential hook failure: a throwing response surface is logged and the request flow proceeds", async () => {
  const key = "guard-key-0001"
  writeFileSync(POOL, JSON.stringify({ accounts: [{ label: "a", apiKey: key }] }))
  rmSync(LOG, { force: true })
  setEnv({ ZAI_MULTI_ACCOUNT_LOG: LOG })
  const mod = await load("response-guard")
  const hooks = await boot(mod)

  const event = reqEvent({ model: "glm-5.3-flash", messages: [] })
  await hooks.get("http.request").cb(event)

  // A hostile response surface: quotaWaitMs reads headers via .get, which
  // throws. Classification bookkeeping is non-essential - the guard must log
  // and let the response proceed, never fail the request.
  const hostile = resEvent(event.request, 429)
  hostile.response = { status: 429, headers: { get: () => { throw new Error("boom-sink") } } }
  // The http.response callback is synchronous: an unguarded throw here would
  // fail the test outright - which is exactly the assertion.
  hooks.get("http.response").cb(hostile)

  const lines = readFileSync(LOG, "utf-8").trim().split("\n").map((l) => JSON.parse(l))
  const guardLine = lines.find((l) => l.event === "hook_non_essential_failure")
  assert.ok(guardLine, `guard must log the non-essential failure, saw: ${lines.map((l) => l.event)}`)
  assert.equal(guardLine.hook, "http.response")
  assert.match(guardLine.error, /boom-sink/)

  // The request flow is unharmed: the next request still injects auth.
  const next = reqEvent({ model: "glm-5.3-flash", messages: [] })
  await hooks.get("http.request").cb(next)
  assert.equal(next.request.headers.get("authorization"), `Bearer ${key}`)
})

test("correlation miss: an uncorrelated response event logs loudly and does not crash", async () => {
  writeFileSync(POOL, JSON.stringify({ accounts: [{ label: "a", apiKey: "miss-key-0001" }] }))
  rmSync(LOG, { force: true })
  setEnv({ ZAI_MULTI_ACCOUNT_LOG: LOG })
  const mod = await load("correlation-miss")
  const hooks = await boot(mod)

  // A response whose request was never seen by http.request (e.g. the host
  // did not preserve identity across the body-rewrite replacement): the miss
  // must be logged loudly and must not crash the hook (sync callback - an
  // unguarded throw would fail the test outright).
  const stranger = reqEvent({ model: "glm-5.3-flash", messages: [] })
  hooks.get("http.response").cb(resEvent(stranger.request, 429))

  const lines = readFileSync(LOG, "utf-8").trim().split("\n").map((l) => JSON.parse(l))
  const miss = lines.find((l) => l.event === "correlation_miss")
  assert.ok(miss, `uncorrelated response must log correlation_miss, saw: ${lines.map((l) => l.event)}`)
  assert.equal(miss.status, 429)
  assert.equal(miss.sessionID, "s1")
})
