# SPIKE RESULTS: opencode v2.3.2 hook API verification for zai-multi-account v2

Date: 2026-11-22. Host: opencode v2.3.2 (`~/.opencode/bin/opencode`, macOS arm64).
Method: empirical fixture run. Fixture (temp dir outside the repo, preserved at
`/private/var/folders/q8/mnrpd2ps7vqgxk5mf4qjj92r0000gn/T/opencode/zai-v2-spike/`):

- `mock-server.mjs` - OpenAI-compatible upstream on `127.0.0.1:39977`, logs every
  request's headers/body to `spike-upstream.jsonl`, streams SSE completions,
  optional fail-mode (`MOCK_FAIL_COUNT` x `MOCK_FAIL_STATUS` with `Retry-After: 1` on 429).
- `spike-plugin/index.js` - structural `{ id, setup(ctx) }` plugin registering
  `http.request` / `http.response` / `retry` hooks three ways: unscoped,
  scoped `{ providerID: "zai-max-spike" }`, and negative-control scoped
  `{ providerID: "other-provider" }`. Logs raw event JSON (keys, model, request
  constructor, header names) to `spike-plugin.jsonl`; injects
  `Authorization: Bearer spike-injected-key-0001` + marker header in http.request.
- `opencode.jsonc` - fixture project config defining TWO zero-credential custom
  providers (`zai-max-spike`, `zai-max-spike-throw`, both `aisdk:@ai-sdk/openai-compatible`
  pointing at the mock) and `plugins: ["./spike-plugin"]`.
- Runs: `opencode run --standalone --model <provider>/spike-model "Reply with the single word OK"`.

## Verdicts

| Question | Verdict | Evidence |
| --- | --- | --- |
| (b) zero-credential provider dispatch | **YES - PROCEED.** Host dispatches both catalog and completion requests for a custom openai-compatible provider with no apiKey configured anywhere; plugin-injected Authorization reaches the wire. | Mock saw `POST /v1/chat/completions` with `authorization: null` when the plugin was disabled, and `authorization: "Bearer spike-injected-key-0001"` once the http.request hook injected it (`spike-upstream.jsonl` lines 1-2 vs 5-6). Run stdout: `Spike OK` (the mock's canned reply), exit 0. |
| (a) provider id exposure | **`event.model.providerID`** on all three hooks. There is no top-level `event.providerID`. `{providerID}` scoping works and gates delivery. | http.request keys: `["sessionID","agent","model","kind","request"]`; http.response: `["sessionID","agent","model","kind","request","response"]`; retry: `["sessionID","agent","model","error","attempt","decision"]`. `model: {"id":"spike-model","providerID":"zai-max-spike","variant":"default"}`. Negative-control scope never fired; both unscoped and matching-scoped callbacks fired, in registration order, each seeing the previous callback's header mutation. |
| throw from http.request | **Hard failure, no dispatch.** The host fails the run and surfaces the plugin error verbatim; no request leaves. | Throw-provider run: exit 1, stderr shows `Error: zai-multi-account spike: deliberate fail-fast throw (empty pool probe)`, mock request count unchanged (4 lines before and after). Fail-fast-by-throw is a safe contract. |
| request identity across hooks | **Preserved.** `http.response` carries the identical `Request` object the http.request hook saw (post-mutation). | `requestIdentityMatch: true` logged from the http.response handler (strict `===` against a reference stashed in http.request). v1-style WeakMap correlation is valid. |
| retry event semantics | Fires for 429 AND 401. `decision` is PRE-FILLED with the host default; the plugin mutates it. `error.status` is numeric. | 429: `error: {"type":"provider.rate-limit","message":...,"status":429,"response":{"body":...},"retryAfterMs":1000}`, `decision` prefilled `{"retry":true,"delay":1602}`; plugin override `{"retry":true,"delay":100}` was honored (second POST observed ~120ms after the first, not ~1600ms). 401: `error: {"type":"provider.auth","status":401,...}` (no `retryAfterMs`), `decision` prefilled `{"retry":false}`; plugin override `{"retry":true,"delay":0}` was honored (second POST ~12ms later, run succeeded). |
| registration/dispose | `await ctx.session.hook(name, cb, opts)` returns `{ dispose: fn }`; multiple registrations of the same hook name allowed. | `regKeys: ["dispose"]`, `hasDispose: "function"` for every registration; both unscoped and scoped callbacks fired per event. |
| `ctx` shape | `ctx.session` exists with `hook`; domains include app, location, options, agent, aisdk, command, credential, event, experimental, generate, model, provider, integration, mcp, permission, plugin, reference, rpc, skill, storage, tool, vcs, websearch, worktree, session, shell. | `setup` line in `spike-plugin.jsonl`. |

## Host-behavior notes (fixture-specific)

- **Local plugin config entries must be directories.** `"plugins": ["./spike-plugin.mjs"]`
  was rejected with `configured plugin path must be a directory` (WARN); `["./spike-plugin"]`
  with `index.js` inside loads. Shipped/git plugin entries are unaffected.
- The host probes custom openai-compatible providers with `GET <baseURL>/models`
  (catalog) at startup - a mock must answer it; no Authorization header is sent on that probe.
- Config normalization WARNs for `$.update: "disabled"` (invalid) and the
  per-server `{"disabled": true}` MCP shapes (fixture cosmetics, no impact).
- Project `opencode.jsonc` IS read for `opencode run` in a non-git directory, but
  the global `default_agent` overrides the project `model` default - select the
  fixture provider explicitly with `--model provider/model`.

## Design consequences for v2 implementation

1. Hooks are registered **unscoped** and filtered internally on
   `event.model.providerID.startsWith("zai-max-")` - this serves every current and
   future `zai-max-*` provider without re-registration (scoping requires knowing
   provider ids at setup time).
2. Auth ownership via http.request header injection is viable and total: the
   zero-credential provider sends nothing otherwise.
3. Fail-fast on empty pool = throw from http.request (verified: surfaces, never dispatches).
4. 429 hold-and-resume: stash Retry-After in http.response (request correlation
   holds), decide `{ retry: true, delay }` in the retry hook; the host applies the
   delay (plugin delay replaces the host default backoff).
5. 401/403: disable key in http.response; rotate + `{ retry: true, delay: 0 }`
   override in the retry hook (verified honored).
6. No periodic timers anywhere: pool reload via fs.watch + mtime re-check on read.
