// Ported unit tests for the subscription quota hold-and-resume helper
// (src/zai-quota.js, verbatim port of the config repo's lib/zai-quota.js).
import { test } from "node:test"
import assert from "node:assert/strict"

const { quotaWaitMs } = await import("../src/zai-quota.js")

const mkRes = (headers = {}) => ({ headers: { get: (k) => headers[k] } })

test("Retry-After seconds are honored as milliseconds", () => {
  assert.equal(quotaWaitMs(mkRes({ "retry-after": "120" }), 999), 120000)
})

test("no header falls back to the poll interval", () => {
  assert.equal(quotaWaitMs(mkRes(), 300000), 300000)
})

test("garbage header falls back to the poll interval", () => {
  assert.equal(quotaWaitMs(mkRes({ "retry-after": "soon" }), 300000), 300000)
})

test("zero header falls back to the poll interval", () => {
  assert.equal(quotaWaitMs(mkRes({ "retry-after": "0" }), 300000), 300000)
})

test("fractional header is honored with millisecond rounding", () => {
  assert.equal(quotaWaitMs(mkRes({ "retry-after": "1.5" }), 999), 1500)
})
