# opencode-zai-multi-account

opencode v2 plugin: Z.AI coding-plan key-pool auth, rotation, and quota
hold-and-resume. Original work extracted from the author's private
configuration repository (`matthew-dresden/opencode-config`, branch
`v2-migration` at commit `1857c39`) and ported to the opencode v2 plugin API.

**Status: bootstrap + port pending review.** Version `0.0.0` is a placeholder;
the release pipeline owns versioning (merging the port PR seeds `v1.0.0` via
the `feat!` major bump). Nothing is published to any registry.

## What it does

The `zai-max` provider targets `https://api.z.ai/api/coding/paas/v4` (the GLM
Coding Max subscription endpoint). This plugin owns its auth at the HTTP
boundary:

- **Key pool rotation** - requests carry `Authorization: Bearer <active key>`
  from a local pool file. A `401`/`403` disables the key and rotates to the
  next usable one; a `429` puts the key on cooldown and rotates.
- **Never unauthenticated** - with a non-empty pool, a request whose keys are
  all merely cooling down (`429`) is never issued without credentials: it is
  held until the earliest cooldown expiry and sent authenticated, so the
  cooldown window surfaces as latency. A loud plugin-attributed error is
  raised only when every key is hard-disabled (`401`/`403`) or the
  hold/attempt budget is exhausted (the error names the state and the next
  key-usable time). An empty pool remains the only fail-soft passthrough.
- **Quota hold-and-resume** - when the subscription quota is exhausted
  (`429` on a `/coding/` subscription endpoint), the request is held (honoring
  `Retry-After` when present, else the configured poll interval) and retried
  until the quota resets, so a quota window surfaces as latency instead of a
  hard error. The per-429 hold stash is keyed by session ID, so concurrent
  sessions hold independently. The hold applies to the `/coding/`
  subscription endpoint only (same gate as the v1 implementation), so a
  `429` from any other endpoint surfaces to the host default.
- **Attempt budget** - no infinite retry: total hold per request is capped at
  `ZAI_QUOTA_WAIT_MAX_MS` and total attempts at `ZAI_MAX_RETRY_ATTEMPTS`
  (default 24). Beyond either bound the provider error surfaces. (Note: with
  the default 5-minute poll interval, the 24-attempt bound binds before the
  6-hour hold cap; raise `ZAI_MAX_RETRY_ATTEMPTS` or lower the poll interval
  to reach longer holds.) The rotation breadth per request is bounded by
  `min(pool size, ZAI_MAX_RETRY_ATTEMPTS)` - a pool of N keys visits at most
  N distinct keys before the attempt cap binds.
- **Model profile enforcement** - the wire body is rewritten so the bundled
  model profile registry (temperature, thinking, reasoning effort per model)
  gets the final word over synthesized reasoning fields.
- **Guarded hooks** - every hook callback is wrapped: non-essential failures
  (logging, body-rewrite enhancement, classification bookkeeping) are logged
  and the request proceeds; auth-path failures (key resolution, header
  injection - e.g. malformed key material from the pool file) fail loudly
  with a plugin-attributed error instead of degrading silently.
- **Correlation observability** - if a response event cannot be correlated to
  its request context (for instance when a host does not preserve request
  identity across the body-rewrite replacement), a loud `correlation_miss`
  log line is emitted rather than degrading silently.

### Recorded design decisions

- **Stale-disable across pool reloads (inherited, deliberately).** Rotation
  bookkeeping (`disabled`, `limitedUntil`) is index-keyed, the same shape the
  v1 implementation used, and is inherited across the 30-second pool
  hot-reload. A reload that reorders the pool file can therefore land a stale
  disable/cooldown on the wrong slot. This is accepted because the cost is
  bounded (one mislabeled request) and self-healing: the key actually failing
  is re-classified at its current index on the next `401`/`403`/`429`.
  Key-string keying was rejected because it would diverge the state shape
  shared with the preserved-verbatim v1 `server()` half.
- **`/coding/` endpoint gate (restored, not removed).** The v1
  `isSubscriptionEndpoint` gate is applied to the 429 hold-and-resume
  machinery in the v2 hooks, so both halves of the plugin behave identically
  even if an operator repoints the `zai-max` provider `baseURL` away from the
  subscription endpoint.
- **Intra-session parallel holds (known limitation).** Parallel `title` and
  `primary` requests share one session ID and therefore one hold record (the
  `retry` event carries no request/kind reference - an event-surface limit).
  Hold accounting is still bounded in both directions: each wait is capped by
  the session's stashed per-429 hold, and the total by
  `ZAI_QUOTA_WAIT_MAX_MS`.

## Pre-cutover live gate (story 2.3b)

Before the v2 shape cuts over as the live auth path, the following must be
verified against a real multi-key deployment:

1. **Pool shape** - re-run the port validation against a real N-key pool (per
   spike risk 7): rotation order, cooldowns, and disables observed live.
2. **Parallel kinds** - a live run with parallel `title` + `primary` traffic
   sharing a session, confirming the intra-session hold limitation above
   behaves as documented.
3. **Max in-hook sleep** - measure the longest actual in-hook hold under live
   429s (transferred from the hold-bookkeeping amendment) and confirm it
   stays within `ZAI_QUOTA_WAIT_MAX_MS`.
4. **Correlation survives replacement** - confirm live that `http.response`
   events carry the post-rewrite request identity (zero `correlation_miss`
   lines with a non-empty pool), closing the host-propagation question the
   unit tests cannot answer.
5. **Dual-shape load** - confirm the default export `{ id, setup, server }`
   loads on the target opencode version (the spike proved a bare
   `{ id, setup }`).

## How it plugs in (opencode v2)

The plugin default-exports `{ id, setup, server }`. `setup(ctx)` registers
session hooks scoped to `providerID: "zai-max"`:

| Hook | Behavior |
| --- | --- |
| `http.request` | injects the active pool key; rewrites the JSON body through the profile registry |
| `http.response` | classifies `401`/`403` (disable key) and `429` (cooldown + Retry-After hold stash) |
| `retry` | rotates on auth errors; holds and resumes on quota errors within the attempt budget |

`server` preserves the original v1 auth-loader implementation (compat shape).
Consumption is via the standard opencode `plugins` config entry once
released; see the repository README of `opencode-config` for the live
configuration.

## Key pool file

`~/.local/share/opencode/zai-accounts.json` (chmod 600). The plugin reads
this file only; it never writes it, and it must never be committed anywhere.

```json
{
  "accounts": [
    { "label": "plan-a", "type": "plan", "apiKey": "YOUR_KEY_A" },
    { "label": "plan-b", "type": "plan", "apiKey": "YOUR_KEY_B" }
  ]
}
```

The pool is read at startup and re-read every 30 seconds - edits apply
without a restart. A missing, unreadable, or empty pool is the only fail-soft
path: the plugin then leaves provider auth untouched so configured or
environment auth applies.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `ZAI_ACCOUNTS_PATH` | `~/.local/share/opencode/zai-accounts.json` | pool file path |
| `ZAI_ROTATE_COOLDOWN_MS` | `60000` | how long a rate-limited key is skipped |
| `ZAI_QUOTA_WAIT_DISABLED` | unset (`1` disables) | disable hold-and-resume; `429` fails immediately |
| `ZAI_QUOTA_WAIT_MAX_MS` | `21600000` (6h) | total hold cap per request |
| `ZAI_QUOTA_WAIT_POLL_MS` | `300000` (5min) | retry interval when no `Retry-After` hint |
| `ZAI_MAX_RETRY_ATTEMPTS` | `24` | total attempt bound before the error surfaces |
| `ZAI_MULTI_ACCOUNT_LOG` | unset | log file path (JSON lines, keys masked to 8 chars); stderr when unset |

## Provider config (v2 schema)

```jsonc
{
  "providers": {
    "zai-max": {
      "name": "ZAI Max",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "https://api.z.ai/api/coding/paas/v4",
        "timeout": false,
        "headerTimeout": false,
        "chunkTimeout": 21600000
      },
      "models": {
        "glm-5.3": { "name": "GLM 5.3", "limit": { "context": 200000, "output": 8192 } },
        "glm-5.3-flash": { "name": "GLM 5.3 Flash", "limit": { "context": 200000, "output": 8192 } }
      }
    }
  }
}
```

## Development

```sh
node --test tests/zai-quota.test.mjs tests/plugin.test.mjs tests/env-overrides.test.mjs tests/v1-server.test.mjs
node scripts/check-tarball.mjs
```

Zero runtime dependencies. Node >= 20.

## Provenance and disclosure

- Original work by Matthew Dresden; Apache-2.0 (see `LICENSE` and `NOTICE`).
- Extracted from the private `opencode-config` repository; the key pool file
  lives outside every repository and keys are only ever held in memory.
- Publishing this plugin discloses the rotation/hold strategy, not any
  credential material. Log output masks keys to their first 8 characters.

## License

Apache-2.0
