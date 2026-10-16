// v2 plugin hook tests: mock Request/Response sequences driven through the
// session hooks the plugin registers in setup(ctx). Real assertions over
// real rotation state transitions - no stubbed assertions.
//
// Env is captured at module import time, so each scenario imports a fresh
// module instance (query-busted specifier) after arranging its pool file.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const work = mkdtempSync(join(tmpdir(), "zma-plugin-test-"))
const POOL = join(work, "zai-accounts.json")
const KEYS = ["alpha-key-0001", "bravo-key-0002", "charlie-key-0003"]
const URL = "https://api.z.ai/api/coding/paas/v4/chat/completions"

process.env.ZAI_ACCOUNTS_PATH = POOL
process.env.ZAI_QUOTA_WAIT_POLL_MS = "5"
process.env.ZAI_QUOTA_WAIT_MAX_MS = "100000"
process.env.ZAI_ROTATE_COOLDOWN_MS = "5000"
delete process.env.ZAI_QUOTA_WAIT_DISABLED
delete process.env.ZAI_MAX_RETRY_ATTEMPTS
delete process.env.ZAI_MULTI_ACCOUNT_LOG

function writePool(accounts) {
  writeFileSync(POOL, JSON.stringify({ accounts }))
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
  return {
    kind: "primary",
    request: new Request(url, { method: "POST", body: JSON.stringify(body) }),
  }
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
    error: { type: status === 401 ? "provider.auth" : "provider.rate_limit", message: "x", status },
    attempt,
    decision: undefined,
  }
}

async function load(scenario) {
  return import(`../index.js?scenario=${scenario}`)
}

test("http.request injects the active pool key as Bearer auth", async () => {
  writePool(KEYS.map((apiKey) => ({ label: `k-${apiKey.slice(0, 5)}`, apiKey })))
  const mod = await load("inject")
  const hooks = await boot(mod)
  const event = reqEvent({ model: "glm-5.3-flash", messages: [] })
  await hooks.get("http.request").cb(event)
  assert.equal(event.request.headers.get("authorization"), `Bearer ${KEYS[0]}`)
})

test("body rewrite injects the model profile fields at the wire boundary", async () => {
  writePool(KEYS.map((apiKey) => ({ label: `k-${apiKey.slice(0, 5)}`, apiKey })))
  const mod = await load("rewrite")
  const hooks = await boot(mod)
  const event = reqEvent({ model: "glm-5.3-flash", messages: [], reasoning_effort: "low" })
  const before = event.request
  await hooks.get("http.request").cb(event)
  assert.notEqual(event.request, before, "rewritten request must be a replacement Request")
  const body = JSON.parse(await event.request.clone().text())
  assert.equal(body.reasoning_effort, "high")
  assert.equal(body.temperature, 1.0)
  assert.deepEqual(body.thinking, { type: "enabled" })
  assert.equal(event.request.headers.get("authorization"), `Bearer ${KEYS[0]}`)
})

test("unknown-model body passes through untouched (same request object)", async () => {
  writePool(KEYS.map((apiKey) => ({ label: `k-${apiKey.slice(0, 5)}`, apiKey })))
  const mod = await load("passthrough-body")
  const hooks = await boot(mod)
  const event = reqEvent({ model: "kimi-k2-thinking", messages: [], temperature: 0.2 })
  const before = event.request
  await hooks.get("http.request").cb(event)
  assert.equal(event.request, before)
  const body = JSON.parse(await event.request.clone().text())
  assert.equal(body.temperature, 0.2)
  assert.equal(body.reasoning_effort, undefined)
})

test("401 rotates to the next pool key in order and forces an immediate retry", async () => {
  writePool(KEYS.map((apiKey) => ({ label: `k-${apiKey.slice(0, 5)}`, apiKey })))
  const mod = await load("rotate-401")
  const hooks = await boot(mod)
  const event = reqEvent({ model: "glm-5.3-flash", messages: [] })
  await hooks.get("http.request").cb(event)
  assert.equal(event.request.headers.get("authorization"), `Bearer ${KEYS[0]}`)

  await hooks.get("http.response").cb(resEvent(event.request, 401))
  const retry = retryEvent(401, 2)
  await hooks.get("retry").cb(retry)
  assert.deepEqual(retry.decision, { retry: true, delay: 0 })

  const next = reqEvent({ model: "glm-5.3-flash", messages: [] })
  await hooks.get("http.request").cb(next)
  assert.equal(next.request.headers.get("authorization"), `Bearer ${KEYS[1]}`)
})

test("403 disables the key and rotation continues until the pool is exhausted", async () => {
  writePool(KEYS.map((apiKey) => ({ label: `k-${apiKey.slice(0, 5)}`, apiKey })))
  const mod = await load("rotate-403")
  const hooks = await boot(mod)

  // key0 -> 403 -> key1
  const e1 = reqEvent({ model: "glm-5.3-flash", messages: [] })
  await hooks.get("http.request").cb(e1)
  assert.equal(e1.request.headers.get("authorization"), `Bearer ${KEYS[0]}`)
  await hooks.get("http.response").cb(resEvent(e1.request, 403))
  const r1 = retryEvent(403, 2)
  await hooks.get("retry").cb(r1)
  assert.deepEqual(r1.decision, { retry: true, delay: 0 })

  // key1 -> 403 -> key2
  const e2 = reqEvent({ model: "glm-5.3-flash", messages: [] })
  await hooks.get("http.request").cb(e2)
  assert.equal(e2.request.headers.get("authorization"), `Bearer ${KEYS[1]}`)
  await hooks.get("http.response").cb(resEvent(e2.request, 403))
  const r2 = retryEvent(403, 3)
  await hooks.get("retry").cb(r2)
  assert.deepEqual(r2.decision, { retry: true, delay: 0 })

  // key2 -> 403 -> all keys disabled: surface the error
  const e3 = reqEvent({ model: "glm-5.3-flash", messages: [] })
  await hooks.get("http.request").cb(e3)
  assert.equal(e3.request.headers.get("authorization"), `Bearer ${KEYS[2]}`)
  await hooks.get("http.response").cb(resEvent(e3.request, 403))
  const r3 = retryEvent(403, 4)
  await hooks.get("retry").cb(r3)
  assert.deepEqual(r3.decision, { retry: false })
})

test("429 sets cooldown rotation and holds for the Retry-After duration", async () => {
  writePool(KEYS.map((apiKey) => ({ label: `k-${apiKey.slice(0, 5)}`, apiKey })))
  const mod = await load("rotate-429")
  const hooks = await boot(mod)

  const event = reqEvent({ model: "glm-5.3-flash", messages: [] })
  await hooks.get("http.request").cb(event)
  assert.equal(event.request.headers.get("authorization"), `Bearer ${KEYS[0]}`)

  // Retry-After 0.03s = 30ms hold (distinct from the 5ms poll fallback).
  const t0 = Date.now()
  await hooks.get("http.response").cb(resEvent(event.request, 429, { "retry-after": "0.03" }))
  const retry = retryEvent(429, 2)
  await hooks.get("retry").cb(retry)
  const elapsed = Date.now() - t0
  assert.deepEqual(retry.decision, { retry: true, delay: 0 })
  assert.ok(elapsed >= 25, `hold must last ~30ms (Retry-After), saw ${elapsed}ms`)
  assert.ok(elapsed < 2000, `hold must not run past the Retry-After window, saw ${elapsed}ms`)

  // The 429'd key is on cooldown: the next request carries the next key.
  const after = reqEvent({ model: "glm-5.3-flash", messages: [] })
  await hooks.get("http.request").cb(after)
  assert.equal(after.request.headers.get("authorization"), `Bearer ${KEYS[1]}`)
})

test("attempt-budget amendment: forced retries stop at the bound and surface the error", async () => {
  writePool(KEYS.map((apiKey) => ({ label: `k-${apiKey.slice(0, 5)}`, apiKey })))
  const mod = await load("budget")
  const hooks = await boot(mod)

  // Seed a stashed subscription-endpoint 429 for the session: since the
  // /coding/ gate was restored (amendment 11), the hold-and-resume machinery
  // only runs for a stashed 429 hold.
  const seed = reqEvent({ model: "glm-5.3-flash", messages: [] })
  await hooks.get("http.request").cb(seed)
  await hooks.get("http.response").cb(resEvent(seed.request, 429, {}, "budget-session"))

  // Attempts 2..24 (bound default 24) force retries with hold-and-resume;
  // attempt 25 exceeds the bound and must surface the error.
  const decisions = []
  for (let attempt = 2; attempt <= 26; attempt++) {
    const retry = retryEvent(429, attempt, `budget-session`)
    await hooks.get("retry").cb(retry)
    decisions.push({ attempt, decision: retry.decision })
  }
  for (const { attempt, decision } of decisions.filter((d) => d.attempt <= 24)) {
    assert.deepEqual(decision, { retry: true, delay: 0 }, `attempt ${attempt} must force retry`)
  }
  assert.deepEqual(decisions.find((d) => d.attempt === 25).decision, { retry: false })
  assert.deepEqual(decisions.find((d) => d.attempt === 26).decision, { retry: false })
})

test("setup returns a cleanup function that stops the pool reload timer", async () => {
  writePool(KEYS.map((apiKey) => ({ label: `k-${apiKey.slice(0, 5)}`, apiKey })))
  const mod = await load("cleanup")
  const { ctx } = makeCtx()
  const cleanup = await mod.default.setup(ctx)
  assert.equal(typeof cleanup, "function")
  assert.doesNotThrow(() => cleanup())
  // Note: this instance was set up outside boot(); after() never saw it, and
  // clearInterval is idempotent for the boot()-tracked ones.
})

test("empty pool: hooks leave the request untouched so config/env auth applies", async () => {
  rmSync(POOL)
  const mod = await load("empty-pool")
  const hooks = await boot(mod)
  const event = reqEvent({ model: "glm-5.3-flash", messages: [] })
  const before = event.request
  await hooks.get("http.request").cb(event)
  assert.equal(event.request, before)
  assert.equal(event.request.headers.get("authorization"), null)

  const retry = retryEvent(401, 2)
  await hooks.get("retry").cb(retry)
  assert.deepEqual(retry.decision, { retry: false })

  writePool(KEYS.map((apiKey) => ({ label: `k-${apiKey.slice(0, 5)}`, apiKey })))
})

// --- Review-round additions (findings 1, 2, 3, 5, 6) ---

test("all keys hard-disabled: request fails loudly instead of going out unauthenticated", async () => {
  writePool([{ label: "only", apiKey: "solo-key-0001" }])
  const mod = await load("hard-disabled")
  const hooks = await boot(mod)

  const event = reqEvent({ model: "glm-5.3-flash", messages: [] })
  await hooks.get("http.request").cb(event)
  await hooks.get("http.response").cb(resEvent(event.request, 403))
  const retry = retryEvent(403, 2)
  await hooks.get("retry").cb(retry)
  assert.deepEqual(retry.decision, { retry: false })

  // Re-issue with every key hard-disabled: loud plugin-attributed failure,
  // never a silent unauthenticated passthrough.
  const reissue = reqEvent({ model: "glm-5.3-flash", messages: [] })
  await assert.rejects(
    hooks.get("http.request").cb(reissue),
    (err) => {
      assert.match(err.message, /zai-multi-account/)
      assert.match(err.message, /hard-disabled/)
      assert.match(err.message, /unauthenticated/)
      return true
    },
  )
  assert.equal(reissue.request.headers.get("authorization"), null, "no request may go out without credentials")
})

test("retry on 401 while keys are merely cooling must not answer retry:false (amendment 4)", async () => {
  writePool([{ label: "only", apiKey: "cool401-key-01" }])
  const mod = await load("cooling-401")
  const hooks = await boot(mod)

  const event = reqEvent({ model: "glm-5.3-flash", messages: [] })
  await hooks.get("http.request").cb(event)
  // 429 puts the only key on cooldown - merely rate-limited, not disabled.
  await hooks.get("http.response").cb(resEvent(event.request, 429))

  const retry = retryEvent(401, 2)
  await hooks.get("retry").cb(retry)
  assert.deepEqual(retry.decision, { retry: true, delay: 0 }, "a merely-cooling pool must never surface retry:false")
})

test("broken key entry (invalid header material) fails loudly on the auth path", async () => {
  writePool([{ label: "bad", apiKey: "bad\nkey-0001" }])
  const mod = await load("broken-key")
  const hooks = await boot(mod)

  const event = reqEvent({ model: "glm-5.3-flash", messages: [] })
  await assert.rejects(
    hooks.get("http.request").cb(event),
    (err) => {
      assert.match(err.message, /zai-multi-account/)
      assert.match(err.message, /auth failed/)
      return true
    },
  )
  assert.equal(event.request.headers.get("authorization"), null, "no partial auth may leak onto the request")
})

test("retry hook non-essential failure: malformed error event is logged and yields no decision", async () => {
  writePool(KEYS.map((apiKey) => ({ label: `k-${apiKey.slice(0, 5)}`, apiKey })))
  const mod = await load("retry-guard")
  const hooks = await boot(mod)

  const event = retryEvent(429, 2)
  delete event.error // malformed: classification cannot even read the status
  await assert.doesNotReject(hooks.get("retry").cb(event))
  assert.equal(event.decision, undefined, "guarded non-essential failure must leave the host default in place")
})

test("pendingHoldMs is session-keyed: two concurrent sessions hold independently", async () => {
  writePool(KEYS.map((apiKey) => ({ label: `k-${apiKey.slice(0, 5)}`, apiKey })))
  const mod = await load("session-holds")
  const hooks = await boot(mod)

  // Session A: 429 with Retry-After 30ms. Session B: 429 with no header, so
  // its stash falls back to the 5ms poll interval. With the old module-global
  // pendingHoldMs, B's stash overwrote A's and A under-held (5ms); with
  // session-keyed holds, A must hold its own ~30ms.
  const a = reqEvent({ model: "glm-5.3-flash", messages: [] })
  await hooks.get("http.request").cb(a)
  await hooks.get("http.response").cb(resEvent(a.request, 429, { "retry-after": "0.03" }, "sess-a"))

  const b = reqEvent({ model: "glm-5.3-flash", messages: [] })
  await hooks.get("http.request").cb(b)
  await hooks.get("http.response").cb(resEvent(b.request, 429, {}, "sess-b"))

  const ta = Date.now()
  const retryA = retryEvent(429, 2, "sess-a")
  await hooks.get("retry").cb(retryA)
  const elapsedA = Date.now() - ta
  assert.deepEqual(retryA.decision, { retry: true, delay: 0 })
  assert.ok(elapsedA >= 25, `session A must hold its own ~30ms Retry-After, saw ${elapsedA}ms`)

  const retryB = retryEvent(429, 2, "sess-b")
  await hooks.get("retry").cb(retryB)
  assert.deepEqual(retryB.decision, { retry: true, delay: 0 })
  // The discriminator is session A's lower bound: under the old module-global
  // stash, B's 5ms poll stash overwrote A's 30ms and A's hold dropped to ~5ms,
  // failing the >= 25ms assertion above. B's own hold is not asserted against
  // a tight upper bound (timer scheduling jitter must not flake the suite).
})

test("non-coding 429 is not held: the V1 /coding/ endpoint gate applies to the hold", async () => {
  writePool(KEYS.map((apiKey) => ({ label: `k-${apiKey.slice(0, 5)}`, apiKey })))
  const mod = await load("coding-gate")
  const hooks = await boot(mod)

  const NON_CODING = "https://api.z.ai/api/paas/v4/chat/completions"
  const event = reqEvent({ model: "glm-5.3-flash", messages: [] }, NON_CODING)
  await hooks.get("http.request").cb(event)
  assert.equal(event.request.headers.get("authorization"), `Bearer ${KEYS[0]}`, "auth still applies to any URL")

  await hooks.get("http.response").cb(resEvent(event.request, 429))
  const retry = retryEvent(429, 2)
  await hooks.get("retry").cb(retry)
  assert.equal(retry.decision, undefined, "non-subscription 429 must not be force-retried by the hold machinery")
})
