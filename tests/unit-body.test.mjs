// Unit tests: transport-level model profile enforcement (withProfileBody).
// The bundled profile registry gets the final word on temperature, thinking,
// and reasoning_effort for known models; everything else passes through.
import { test } from "node:test"
import assert from "node:assert/strict"

const { withProfileBody } = await import("../src/request-body.js")

async function readBody(request) {
  return JSON.parse(await request.clone().text())
}

test("profile gets the final word over host-synthesized reasoning fields", async () => {
  const request = new Request("https://api.z.ai/api/coding/paas/v4/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "glm-5.3-flash", messages: [], temperature: 0.2, reasoning_effort: "low" }),
    headers: { "content-type": "application/json", authorization: "Bearer k" },
  })
  const messages = []
  const { input, init } = await withProfileBody(request, undefined, (m) => messages.push(m))
  assert.ok(input instanceof Request, "rewritten requests arrive as a new Request")
  const body = await readBody(input)
  assert.equal(body.temperature, 1.0)
  assert.equal(body.reasoning_effort, "high")
  assert.deepEqual(body.thinking, { type: "enabled" })
  assert.equal(input.headers.get("authorization"), "Bearer k", "rewritten request preserves headers")
  assert.ok(messages.some((m) => m.includes("profile enforced")), "rewrite is logged")
})

test("glm-5.3 profile enforces temperature 1.0, thinking enabled, effort max", async () => {
  const request = new Request("https://api.z.ai/api/coding/paas/v4/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "glm-5.3", messages: [], reasoning_effort: "low" }),
  })
  const { input } = await withProfileBody(request, undefined)
  const body = await readBody(input)
  assert.equal(body.temperature, 1.0)
  assert.equal(body.reasoning_effort, "max")
  assert.deepEqual(body.thinking, { type: "enabled" })
})

test("unknown model passes through untouched (same object, no rewrite log)", async () => {
  const request = new Request("https://api.z.ai/api/coding/paas/v4/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "kimi-k2-thinking", messages: [], temperature: 0.2 }),
  })
  const messages = []
  const { input, init } = await withProfileBody(request, undefined, (m) => messages.push(m))
  assert.equal(input, request, "same request object must be returned")
  assert.equal(init, undefined)
  const body = await readBody(input)
  assert.equal(body.temperature, 0.2)
  assert.equal(body.reasoning_effort, undefined)
  assert.ok(!messages.some((m) => m.includes("profile enforced")))
})

test("identical profile values produce no replacement request", async () => {
  const request = new Request("https://api.z.ai/api/coding/paas/v4/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "glm-5.3-flash", messages: [], temperature: 1.0, reasoning_effort: "high", thinking: { type: "enabled" } }),
  })
  const { input } = await withProfileBody(request, undefined)
  assert.equal(input, request, "no-change bodies must not spawn a replacement Request")
})

test("non-JSON and absent bodies pass through untouched", async () => {
  const empty = new Request("https://api.z.ai/api/coding/paas/v4/models")
  const r1 = await withProfileBody(empty, undefined)
  assert.equal(r1.input, empty)

  const text = new Request("https://api.z.ai/api/coding/paas/v4/chat/completions", { method: "POST", body: "not json at all" })
  const r2 = await withProfileBody(text, undefined)
  assert.equal(r2.input, text)
})

test("malformed JSON body passes through with a logged reason (provider surfaces the error)", async () => {
  const request = new Request("https://api.z.ai/api/coding/paas/v4/chat/completions", {
    method: "POST",
    body: '{"model": "glm-5.3-flash", truncated',
  })
  const messages = []
  const { input } = await withProfileBody(request, undefined, (m) => messages.push(m))
  assert.equal(input, request)
  assert.ok(messages.some((m) => m.includes("malformed JSON")))
})

test("string init.body path is rewritten through init", async () => {
  const messages = []
  const { input, init } = await withProfileBody(
    "https://api.z.ai/api/coding/paas/v4/chat/completions",
    { method: "POST", body: JSON.stringify({ model: "glm-5.3-flash", messages: [], reasoning_effort: "low" }) },
    (m) => messages.push(m),
  )
  assert.equal(input, "https://api.z.ai/api/coding/paas/v4/chat/completions")
  const body = JSON.parse(init.body)
  assert.equal(body.reasoning_effort, "high")
  assert.ok(messages.some((m) => m.includes("profile enforced")))
})

test("non-string init.body is skipped with a log line", async () => {
  const messages = []
  const raw = new Uint8Array(1)
  const { init } = await withProfileBody("https://api.z.ai/api/coding/paas/v4/chat/completions", { body: raw }, (m) => messages.push(m))
  assert.equal(init.body, raw, "init must stay untouched when it has no string body")
  assert.ok(messages.some((m) => m.includes("non-string init.body")))
})
