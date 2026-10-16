// V1 auth-loader shape tests: the compat server() entrypoint must behave
// exactly like the original plugins/zai-multi-account.js entrypoint, with a
// fake client.app.log standing in for the structured log service.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const work = mkdtempSync(join(tmpdir(), "zma-v1-test-"))
const URL_POOL = join(work, "zai-accounts.json")

function setPoolPath(path) {
  process.env.ZAI_ACCOUNTS_PATH = path
  delete process.env.ZAI_QUOTA_WAIT_DISABLED
  delete process.env.ZAI_MULTI_ACCOUNT_LOG
}

function fakeClient() {
  const calls = []
  return {
    calls,
    app: { log: async (entry) => { calls.push(entry) } },
  }
}

async function load(scenario) {
  return import(`../index.js?v1=${scenario}`)
}

test("dual-shape export: default carries id, setup, and server; ZaiMultiAccount is the v1 entry", async () => {
  setPoolPath(join(work, "missing-empty.json"))
  const mod = await load("shape")
  assert.equal(mod.default.id, "zai-multi-account")
  assert.equal(typeof mod.default.setup, "function")
  assert.equal(typeof mod.default.server, "function")
  assert.equal(mod.default.server, mod.ZaiMultiAccount)
})

test("server() wires client.app.log and logs plugin_loaded with the pool size", async () => {
  writeFileSync(URL_POOL, JSON.stringify({
    accounts: [{ label: "max-plan-1", type: "plan", apiKey: "v1alpha-key-1" }, { label: "max-plan-2", type: "plan", apiKey: "v1bravo-key-2" }],
  }))
  setPoolPath(URL_POOL)
  const mod = await load("log")
  const client = fakeClient()
  const hooks = await mod.default.server({ client })
  assert.ok(hooks.auth, "server() must return an auth hook object")
  assert.equal(hooks.auth.provider, "zai-max")
  assert.equal(typeof hooks.auth.loader, "function")
  const loaded = client.calls.find((c) => c.body?.message === "plugin_loaded")
  assert.ok(loaded, "plugin_loaded must be logged through client.app.log")
  assert.equal(loaded.body.service, "zai-multi-account")
  assert.equal(loaded.body.extra.poolSize, 2)
})

test("loader with an empty pool falls back to stored auth (no custom fetch)", async () => {
  setPoolPath(join(work, "definitely-missing.json"))
  const mod = await load("empty-pool")
  const hooks = await mod.default.server({ client: fakeClient() })
  const stored = { key: "stored-config-key" }
  const auth = await hooks.auth.loader(async () => stored)
  assert.deepEqual(auth, { apiKey: "stored-config-key" })
  assert.equal(auth.fetch, undefined)
})

test("loader with a pool returns the active key plus the rotation fetch wrapper", async () => {
  writeFileSync(URL_POOL, JSON.stringify({
    accounts: [{ label: "max-plan-1", type: "plan", apiKey: "v1pool-first-key" }, { label: "max-plan-2", type: "plan", apiKey: "v1pool-second" }],
  }))
  setPoolPath(URL_POOL)
  const mod = await load("pool")
  const hooks = await mod.default.server({ client: fakeClient() })
  const auth = await hooks.auth.loader(async () => { throw new Error("getAuth must not be called when the pool has keys") })
  assert.equal(auth.apiKey, "v1pool-first-key")
  assert.equal(typeof auth.fetch, "function")
})
