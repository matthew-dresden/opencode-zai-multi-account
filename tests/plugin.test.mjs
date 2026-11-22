// Integration tests: real hook sequences through setup(ctx), mock
// Request/Response surfaces, two providers (zai-max-brim, zai-max-accordion)
// with isolated pools. Covers per-provider auth injection, 401/403 disable +
// rotation, 429 cooldown + Retry-After hold-and-resume, CONCURRENT provider
// isolation, empty-pool fail-fast error contract, budgets, the /coding/
// gate, guarded hooks, and correlation.
//
// All waits are condition-polled or asserted as decision delay VALUES; the
// only real-time hold is the all-cooling request hold, budgeted to a few
// tens of milliseconds. No sleeps.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, rmSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const work = mkdtempSync(join(tmpdir(), "zma-plugin-test-"))
const LOG = join(work, "plugin.log")
const CODING_URL = "https://api.z.ai/api/coding/paas/v4/chat/completions"
const NON_CODING_URL = "https://api.z.ai/api/paas/v4/chat/completions"

process.env.ZAI_ACCOUNTS_DIR = work
process.env.ZAI_MULTI_ACCOUNT_LOG = LOG
process.env.ZAI_QUOTA_POLL_MS = "10"
process.env.ZAI_QUOTA_WAIT_MAX_MS = "100000"
process.env.ZAI_MAX_RETRY_ATTEMPTS = "24"
process.env.ZAI_ROTATE_COOLDOWN_MS = "40"
delete process.env.ZAI_QUOTA_WAIT_DISABLED

const { pathOf } = await import("../src/pool.js")
const mod = await import("../index.js")

function writePool(providerID, accounts) {
  const path = pathOf(providerID)
  writeFileSync(path, JSON.stringify({ accounts }))
  utimesSync(path, new Date(), new Date(Date.now() + 60000)) // deterministic mtime bump
}

function makeCtx() {
  const hooks = new Map()
  return {
    ctx: {
      session: {
        hook: async (name, cb, opts) => {
          hooks.set(name, { cb, opts })
          return { dispose: async () => hooks.delete(name) }
        },
      },
    },
    hooks,
  }
}

const cleanups = []
const { ctx, hooks } = makeCtx()
cleanups.push(await mod.default.setup(ctx))
after(() => {
  for (const cleanup of cleanups) {
    try {
      cleanup()
    } catch {}
  }
  rmSync(work, { recursive: true, force: true })
})

function readLog() {
  try {
    return readFileSync(LOG, "utf-8").trim().split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

function reqEvent(providerID, url = CODING_URL, body = { model: "glm-5.3-flash", messages: [] }, sessionID = "s1") {
  return {
    sessionID,
    agent: "build",
    model: { providerID, id: "glm-5.3-flash", variant: "default" },
    kind: "primary",
    request: new Request(url, { method: "POST", body: JSON.stringify(body) }),
  }
}

function resEvent(event, status, headers = {}) {
  return {
    sessionID: event.sessionID,
    agent: "build",
    model: event.model,
    kind: event.kind,
    request: event.request,
    response: new Response("{}", { status, headers }),
  }
}

function retryEvent(event, status, attempt) {
  return {
    sessionID: event.sessionID,
    agent: "build",
    model: event.model,
    error: {
      type: status === 401 || status === 403 ? "provider.auth" : "provider.rate-limit",
      message: "x",
      status,
    },
    attempt,
    decision: undefined,
  }
}

// --- auth injection per provider ---

test("each provider injects its own pool key; pools are isolated per provider id", async () => {
  writePool("zai-max-brim", [{ label: "b1", type: "plan", apiKey: "brim-key-alpha-001" }, { label: "b2", type: "plan", apiKey: "brim-key-beta-0002" }])
  writePool("zai-max-accordion", [{ label: "a1", type: "plan", apiKey: "acco-key-alpha-001" }])

  const brim = reqEvent("zai-max-brim")
  await hooks.get("http.request").cb(brim)
  assert.equal(brim.request.headers.get("authorization"), "Bearer brim-key-alpha-001")

  const accordion = reqEvent("zai-max-accordion")
  await hooks.get("http.request").cb(accordion)
  assert.equal(accordion.request.headers.get("authorization"), "Bearer acco-key-alpha-001")

  const brimAgain = reqEvent("zai-max-brim")
  await hooks.get("http.request").cb(brimAgain)
  assert.equal(brimAgain.request.headers.get("authorization"), "Bearer brim-key-alpha-001", "brim's active key is unaffected by accordion traffic")
})

test("body rewrite runs through the hook: bundled profiles get the final word", async () => {
  const event = reqEvent("zai-max-brim", CODING_URL, { model: "glm-5.3-flash", messages: [], reasoning_effort: "low", temperature: 0.2 })
  const before = event.request
  await hooks.get("http.request").cb(event)
  assert.notEqual(event.request, before, "rewritten body must replace the request")
  const body = JSON.parse(await event.request.clone().text())
  assert.equal(body.reasoning_effort, "high")
  assert.equal(body.temperature, 1.0)
  assert.deepEqual(body.thinking, { type: "enabled" })
  assert.equal(event.request.headers.get("authorization"), "Bearer brim-key-alpha-001")
})

// --- empty pool fail-fast (the error contract) ---

test("empty pool fails fast: error names provider, pool path, and the SSM command; nothing goes out", async () => {
  const event = reqEvent("zai-max-nosuch")
  await assert.rejects(
    hooks.get("http.request").cb(event),
    (err) => {
      assert.match(err.message, /zai-multi-account:/)
      assert.match(err.message, /provider "zai-max-nosuch" has no usable keys/)
      assert.match(err.message, /zai-accounts-zai-max-nosuch\.json/)
      assert.match(err.message, /aws ssm get-parameter --name \/brimcapitalgroup\/zai-max-nosuch\/api-key --with-decryption/)
      return true
    },
  )
  assert.equal(event.request.headers.get("authorization"), null, "no request may escape without credentials")
  const logged = readLog().find((l) => l.event === "request_error" && l.providerID === "zai-max-nosuch" && l.scope === "resolve")
  assert.ok(logged, "the fail-fast must be logged loudly")
})

// --- 401/403 disable + rotation ---

test("401 disables the key, rotates, retries with delay 0; the next request carries the next key", async () => {
  writePool("zai-max-rot401", [{ label: "r1", apiKey: "rot1-key-alpha-001" }, { label: "r2", apiKey: "rot1-key-beta-0002" }])
  const event = reqEvent("zai-max-rot401")
  await hooks.get("http.request").cb(event)
  assert.equal(event.request.headers.get("authorization"), "Bearer rot1-key-alpha-001")

  await hooks.get("http.response").cb(resEvent(event, 401))
  const disabled = readLog().find((l) => l.event === "key_disabled" && l.providerID === "zai-max-rot401")
  assert.ok(disabled, "key_disabled must be logged")
  assert.equal(disabled.keyIndex, 0)

  const retry = retryEvent(event, 401, 2)
  await hooks.get("retry").cb(retry)
  assert.deepEqual(retry.decision, { retry: true, delay: 0 })
  const rotated = readLog().find((l) => l.event === "key_rotated" && l.providerID === "zai-max-rot401" && l.reason === "status 401")
  assert.ok(rotated, "key_rotated must be logged on the auth-error rotation")

  const next = reqEvent("zai-max-rot401")
  await hooks.get("http.request").cb(next)
  assert.equal(next.request.headers.get("authorization"), "Bearer rot1-key-beta-0002")
})

test("403 across the whole pool: retry surfaces the error, then the request path fails fast naming hard-disabled", async () => {
  writePool("zai-max-rot403", [{ label: "s1", apiKey: "rot3-key-alpha-001" }])
  const event = reqEvent("zai-max-rot403")
  await hooks.get("http.request").cb(event)
  await hooks.get("http.response").cb(resEvent(event, 403))
  const retry = retryEvent(event, 403, 2)
  await hooks.get("retry").cb(retry)
  assert.deepEqual(retry.decision, { retry: false })
  const exhausted = readLog().find((l) => l.event === "hold_exhausted" && l.providerID === "zai-max-rot403" && l.reason === "all-keys-disabled")
  assert.ok(exhausted, "hold_exhausted(all-keys-disabled) must be logged")

  const reissue = reqEvent("zai-max-rot403")
  await assert.rejects(
    hooks.get("http.request").cb(reissue),
    (err) => {
      assert.match(err.message, /zai-max-rot403/)
      assert.match(err.message, /all 1 keys are hard-disabled \(401\/403\)/)
      assert.match(err.message, /aws ssm get-parameter --name \/brimcapitalgroup\/zai-max-rot403\/api-key --with-decryption/)
      return true
    },
  )
  assert.equal(reissue.request.headers.get("authorization"), null)
})

// --- 429 cooldown + Retry-After hold-and-resume ---

test("429 on a coding endpoint: cooldown, stash hold from Retry-After, decision delay, then rotation", async () => {
  writePool("zai-max-rot429", [{ label: "t1", apiKey: "rot4-key-alpha-001" }, { label: "t2", apiKey: "rot4-key-beta-0002" }])
  const event = reqEvent("zai-max-rot429")
  await hooks.get("http.request").cb(event)
  assert.equal(event.request.headers.get("authorization"), "Bearer rot4-key-alpha-001")

  await hooks.get("http.response").cb(resEvent(event, 429, { "retry-after": "0.03" }))
  const cooled = readLog().find((l) => l.event === "key_cooldown" && l.providerID === "zai-max-rot429")
  assert.ok(cooled, "key_cooldown must be logged")
  const started = readLog().find((l) => l.event === "hold_start" && l.providerID === "zai-max-rot429")
  assert.ok(started, "hold_start must be logged")
  assert.equal(started.holdMs, 30, "Retry-After 0.03s must stash a 30ms hold")
  assert.equal(started.source, "retry-after")

  const retry = retryEvent(event, 429, 2)
  await hooks.get("retry").cb(retry)
  assert.deepEqual(retry.decision, { retry: true, delay: 30 }, "the decision delay is the server-derived hold")
  const resumed = readLog().filter((l) => l.event === "hold_resume" && l.providerID === "zai-max-rot429" && l.reason === "quota-hold")
  assert.equal(resumed.length, 1)
  assert.equal(resumed[0].heldMs, 30)

  const next = reqEvent("zai-max-rot429")
  await hooks.get("http.request").cb(next)
  assert.equal(next.request.headers.get("authorization"), "Bearer rot4-key-beta-0002", "cooled key rotates on the next request")
})

test("429 with no Retry-After stashes the configured poll interval", async () => {
  writePool("zai-max-poll429", [{ label: "p1", apiKey: "poll-key-alpha-01" }])
  const event = reqEvent("zai-max-poll429")
  await hooks.get("http.request").cb(event)
  await hooks.get("http.response").cb(resEvent(event, 429))
  const started = readLog().filter((l) => l.event === "hold_start" && l.providerID === "zai-max-poll429").pop()
  assert.equal(started.holdMs, 10, "no Retry-After: the ZAI_QUOTA_POLL_MS interval is stashed")
  assert.equal(started.source, "poll")
})

test("non-coding 429: key cooldowns and rotates but the hold machinery stays out (host default)", async () => {
  writePool("zai-max-gate", [{ label: "g1", apiKey: "gate-key-alpha-01" }, { label: "g2", apiKey: "gate-key-beta-0002" }])
  const event = reqEvent("zai-max-gate", NON_CODING_URL)
  await hooks.get("http.request").cb(event)
  await hooks.get("http.response").cb(resEvent(event, 429))
  const cooled = readLog().find((l) => l.event === "key_cooldown" && l.providerID === "zai-max-gate")
  assert.ok(cooled, "cooldown bookkeeping still applies to any endpoint")
  const noHold = readLog().find((l) => l.event === "quota_429_no_hold" && l.providerID === "zai-max-gate")
  assert.ok(noHold, "the non-subscription gate must be logged")
  assert.equal(noHold.reason, "non-subscription-endpoint")

  const retry = retryEvent(event, 429, 2)
  await hooks.get("retry").cb(retry)
  assert.equal(retry.decision, undefined, "no stash means no forced retry: the host default applies")

  const next = reqEvent("zai-max-gate", NON_CODING_URL)
  await hooks.get("http.request").cb(next)
  assert.equal(next.request.headers.get("authorization"), "Bearer gate-key-beta-0002")
})

// --- CONCURRENT isolation: a hold on one provider must never delay another ---

test("concurrent holds: provider A's 80ms hold never leaks into provider B's 10ms hold (either order)", async () => {
  writePool("zai-max-iso-brim", [{ label: "i1", apiKey: "isoB-key-alpha-01" }])
  writePool("zai-max-iso-acc", [{ label: "i2", apiKey: "isoA-key-alpha-01" }])

  const brim = reqEvent("zai-max-iso-brim", CODING_URL, { model: "glm-5.3-flash", messages: [] }, "iso-sess")
  await hooks.get("http.request").cb(brim)
  await hooks.get("http.response").cb(resEvent(brim, 429, { "retry-after": "0.08" }))
  const startedBrim = readLog().filter((l) => l.event === "hold_start" && l.providerID === "zai-max-iso-brim").pop()
  assert.equal(startedBrim.holdMs, 80)

  const accordion = reqEvent("zai-max-iso-acc", CODING_URL, { model: "glm-5.3-flash", messages: [] }, "iso-sess")
  await hooks.get("http.request").cb(accordion)
  await hooks.get("http.response").cb(resEvent(accordion, 429))
  const startedAcc = readLog().filter((l) => l.event === "hold_start" && l.providerID === "zai-max-iso-acc").pop()
  assert.equal(startedAcc.holdMs, 10, "accordion's hold falls back to the poll interval")

  // Accordion (the smaller hold) retries FIRST: its decision must use its
  // own 10ms stash - and brim's retry afterwards must still carry the full
  // 80ms (the v1 module-global stash would have been overwritten).
  const retryAcc = retryEvent(accordion, 429, 2)
  await hooks.get("retry").cb(retryAcc)
  assert.deepEqual(retryAcc.decision, { retry: true, delay: 10 })

  const retryBrim = retryEvent(brim, 429, 2)
  await hooks.get("retry").cb(retryBrim)
  assert.deepEqual(retryBrim.decision, { retry: true, delay: 80 }, "brim's hold must be untouched by accordion's earlier retry")

  // Accumulation stays per provider too.
  const retryBrim2 = retryEvent(brim, 429, 3)
  await hooks.get("retry").cb(retryBrim2)
  assert.deepEqual(retryBrim2.decision, { retry: true, delay: 80 })
  const resumed = readLog().filter((l) => l.event === "hold_resume" && l.providerID === "zai-max-iso-brim" && l.reason === "quota-hold")
  assert.equal(resumed[1].heldMs, 160, "brim accumulates its own heldMs across retries")

  const resumedAcc = readLog().filter((l) => l.event === "hold_resume" && l.providerID === "zai-max-iso-acc" && l.reason === "quota-hold")
  assert.equal(resumedAcc[0].heldMs, 10, "accordion accumulates independently")
})

// --- budgets ---

test("ZAI_QUOTA_WAIT_MAX_MS caps total hold: retries shrink, then the error surfaces", async () => {
  writePool("zai-max-cap", [{ label: "c1", apiKey: "cap-key-alpha-001" }])
  process.env.ZAI_QUOTA_WAIT_MAX_MS = "30"
  try {
    const event = reqEvent("zai-max-cap", CODING_URL, { model: "glm-5.3-flash", messages: [] }, "cap-sess")
    await hooks.get("http.request").cb(event)
    await hooks.get("http.response").cb(resEvent(event, 429)) // no header: poll 10ms

    const decisions = []
    for (let attempt = 2; attempt <= 6; attempt++) {
      const retry = retryEvent(event, 429, attempt)
      await hooks.get("retry").cb(retry)
      decisions.push({ attempt, decision: retry.decision })
    }
    assert.deepEqual(decisions[0].decision, { retry: true, delay: 10 })
    assert.deepEqual(decisions[1].decision, { retry: true, delay: 10 })
    assert.deepEqual(decisions[2].decision, { retry: true, delay: 10 }, "30ms held exactly at the cap boundary")
    assert.deepEqual(decisions[3].decision, { retry: false }, "past the cap the error surfaces")
    assert.deepEqual(decisions[4].decision, { retry: false })
    const exhausted = readLog().filter((l) => l.event === "hold_exhausted" && l.providerID === "zai-max-cap" && l.reason === "wait-cap")
    assert.ok(exhausted.length >= 1)
    assert.equal(exhausted[0].capMs, 30)
  } finally {
    process.env.ZAI_QUOTA_WAIT_MAX_MS = "100000"
  }
})

test("ZAI_MAX_RETRY_ATTEMPTS tightens the attempt bound", async () => {
  writePool("zai-max-attempts", [{ label: "m1", apiKey: "att-key-alpha-001" }])
  process.env.ZAI_MAX_RETRY_ATTEMPTS = "2"
  try {
    const event = reqEvent("zai-max-attempts", CODING_URL, { model: "glm-5.3-flash", messages: [] }, "att-sess")
    await hooks.get("http.request").cb(event)
    await hooks.get("http.response").cb(resEvent(event, 429, { "retry-after": "0.01" }))

    const retry2 = retryEvent(event, 429, 2)
    await hooks.get("retry").cb(retry2)
    assert.deepEqual(retry2.decision, { retry: true, delay: 10 }, "attempt 2 is within the bound")

    const retry3 = retryEvent(event, 429, 3)
    await hooks.get("retry").cb(retry3)
    assert.deepEqual(retry3.decision, { retry: false }, "attempt 3 exceeds the bound")
    const exhausted = readLog().filter((l) => l.event === "hold_exhausted" && l.providerID === "zai-max-attempts" && l.reason === "attempt-bound")
    assert.ok(exhausted.length >= 1)
    assert.equal(exhausted[exhausted.length - 1].maxAttempts, 2)
  } finally {
    process.env.ZAI_MAX_RETRY_ATTEMPTS = "24"
  }
})

// --- all-keys-cooling request hold (real, tiny) ---

test("all keys cooling: the request holds until cooldown expiry and never goes out unauthenticated", async () => {
  writePool("zai-max-coolhold", [{ label: "h1", apiKey: "cool-key-alpha-01" }])
  process.env.ZAI_ROTATE_COOLDOWN_MS = "60"
  process.env.ZAI_QUOTA_POLL_MS = "5"
  try {
    const event = reqEvent("zai-max-coolhold", CODING_URL, { model: "glm-5.3-flash", messages: [] }, "cool-sess")
    await hooks.get("http.request").cb(event)
    assert.equal(event.request.headers.get("authorization"), "Bearer cool-key-alpha-01")
    await hooks.get("http.response").cb(resEvent(event, 429, { "retry-after": "0.005" }))
    const retry = retryEvent(event, 429, 2)
    await hooks.get("retry").cb(retry)
    assert.deepEqual(retry.decision, { retry: true, delay: 5 })

    // The re-issue arrives while the only key is still cooling (60ms
    // cooldown): the hook must hold (latency) and then go out authenticated.
    const reissue = reqEvent("zai-max-coolhold", CODING_URL, { model: "glm-5.3-flash", messages: [] }, "cool-sess")
    const t0 = Date.now()
    await hooks.get("http.request").cb(reissue)
    const elapsed = Date.now() - t0
    assert.ok(elapsed >= 25, `all-cooling request must hold past the 5ms stash (cooldown 60ms), saw ${elapsed}ms`)
    assert.ok(elapsed < 5000, "hold must not run away")
    assert.equal(reissue.request.headers.get("authorization"), "Bearer cool-key-alpha-01")
    const holdStart = readLog().filter((l) => l.event === "hold_start" && l.providerID === "zai-max-coolhold" && l.reason === "all-keys-cooling")
    assert.ok(holdStart.length >= 1, "the in-request hold must be logged")
    const resumed = readLog().filter((l) => l.event === "hold_resume" && l.providerID === "zai-max-coolhold" && l.reason === "cooldown-expired")
    assert.ok(resumed.length >= 1, "the hold resume must be logged")
  } finally {
    process.env.ZAI_ROTATE_COOLDOWN_MS = "40"
    process.env.ZAI_QUOTA_POLL_MS = "10"
  }
})

test("all keys cooling past the budget: the request fails fast naming the state and next usable time", async () => {
  writePool("zai-max-coolcap", [{ label: "x1", apiKey: "coolcap-key-alph" }])
  process.env.ZAI_ROTATE_COOLDOWN_MS = "60000"
  process.env.ZAI_QUOTA_WAIT_MAX_MS = "25"
  try {
    const event = reqEvent("zai-max-coolcap", CODING_URL, { model: "glm-5.3-flash", messages: [] }, "cap2-sess")
    await hooks.get("http.request").cb(event)
    await hooks.get("http.response").cb(resEvent(event, 429))

    const reissue = reqEvent("zai-max-coolcap", CODING_URL, { model: "glm-5.3-flash", messages: [] }, "cap2-sess")
    const t0 = Date.now()
    await assert.rejects(
      hooks.get("http.request").cb(reissue),
      (err) => {
        assert.match(err.message, /zai-multi-account:/)
        assert.match(err.message, /all keys cooling down/)
        assert.match(err.message, /next key usable at \d{4}-/)
        assert.match(err.message, /refusing to issue an unauthenticated request/)
        return true
      },
    )
    assert.ok(Date.now() - t0 < 2000, "budget exhaustion must bind near the 25ms cap")
    assert.equal(reissue.request.headers.get("authorization"), null)
  } finally {
    process.env.ZAI_ROTATE_COOLDOWN_MS = "40"
    process.env.ZAI_QUOTA_WAIT_MAX_MS = "100000"
  }
})

// --- guarded hooks + observability ---

test("malformed retry event: no throw, no decision (host default preserved)", async () => {
  const event = reqEvent("zai-max-brim")
  const retry = retryEvent(event, 429, 2)
  delete retry.error
  assert.doesNotThrow(() => hooks.get("retry").cb(retry), "guarded classification must never throw")
  assert.equal(retry.decision, undefined)
})

test("hostile response surface: logged as non-essential failure, flow proceeds", async () => {
  writePool("zai-max-hostile", [{ label: "z1", apiKey: "host-key-alpha-01" }])
  const event = reqEvent("zai-max-hostile")
  await hooks.get("http.request").cb(event)
  const hostile = resEvent(event, 429)
  hostile.response = { status: 429, headers: { get: () => { throw new Error("boom-sink") } } }
  assert.doesNotThrow(() => hooks.get("http.response").cb(hostile))
  const guard = readLog().find((l) => l.event === "hook_non_essential_failure" && l.hook === "http.response")
  assert.ok(guard, "the guard must log the failure")
  assert.match(guard.error, /boom-sink/)
  const next = reqEvent("zai-max-hostile")
  await hooks.get("http.request").cb(next)
  assert.equal(next.request.headers.get("authorization"), "Bearer host-key-alpha-01", "the auth path is unharmed")
})

test("correlation miss: an uncorrelated response logs loudly and does not crash", async () => {
  writePool("zai-max-miss", [{ label: "w1", apiKey: "miss-key-alpha-01" }])
  // A real request first (so the pool is loaded), then a response whose
  // request was never seen by http.request - the miss must be loud.
  const seen = reqEvent("zai-max-miss")
  await hooks.get("http.request").cb(seen)
  const stranger = reqEvent("zai-max-miss", CODING_URL, { model: "glm-5.3-flash", messages: [] }, "stranger-sess")
  assert.notEqual(stranger.request, seen.request)
  assert.doesNotThrow(() => hooks.get("http.response").cb(resEvent(stranger, 429)))
  const miss = readLog().find((l) => l.event === "correlation_miss" && l.providerID === "zai-max-miss" && l.sessionID === "stranger-sess")
  assert.ok(miss, "correlation_miss must be logged")
  assert.equal(miss.status, 429)
})

test("server errors log request_error with provider tag and status", async () => {
  writePool("zai-max-500", [{ label: "e1", apiKey: "err-key-alpha-001" }])
  const event = reqEvent("zai-max-500")
  await hooks.get("http.request").cb(event)
  await hooks.get("http.response").cb(resEvent(event, 500))
  const line = readLog().find((l) => l.event === "request_error" && l.providerID === "zai-max-500" && l.status === 500)
  assert.ok(line, "request_error must be logged for 5xx")
  assert.equal(line.keyPrefix, "err-...-001", "the key prefix mask must be present")
})

test("non-zai-max provider events are untouched: no auth injection, no retry decision", async () => {
  const foreign = reqEvent("openrouter", CODING_URL, { model: "glm-5.3", messages: [] })
  await hooks.get("http.request").cb(foreign)
  assert.equal(foreign.request.headers.get("authorization"), null, "foreign providers must not be touched")

  const foreignRetry = retryEvent(foreign, 429, 2)
  await hooks.get("retry").cb(foreignRetry)
  assert.equal(foreignRetry.decision, undefined)

  const foreignRes = resEvent(foreign, 429)
  assert.doesNotThrow(() => hooks.get("http.response").cb(foreignRes))
  assert.ok(!readLog().some((l) => l.providerID === "openrouter" && l.event === "key_cooldown"), "no classification for foreign providers")
})

// --- logging hygiene ---

test("log lines mask keys to first4/last4 and never carry full key material", async () => {
  const secret = "supersecret-key-material-9999"
  writePool("zai-max-mask", [{ label: "k", apiKey: secret }])
  const event = reqEvent("zai-max-mask")
  await hooks.get("http.request").cb(event)
  await hooks.get("http.response").cb(resEvent(event, 401))

  const raw = readFileSync(LOG, "utf-8")
  assert.ok(!raw.includes(secret), "full key material must never reach the log")
  assert.ok(raw.includes("supe...9999"), "first4/last4 mask must be present")
  const disabled = readLog().find((l) => l.event === "key_disabled" && l.providerID === "zai-max-mask")
  assert.equal(disabled.keyPrefix, "supe...9999")
})
