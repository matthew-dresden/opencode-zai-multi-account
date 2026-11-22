# opencode-zai-multi-account

opencode v2 plugin: multi-provider Z.AI coding-plan key-pool auth, rotation,
and quota hold-and-resume. Original work extracted from the author's private
configuration repository (`matthew-dresden/opencode-config`, branch
`v2-migration` at commit `1857c39`) and ported to the opencode v2 plugin API.
Version 2.0.0 is a native v2 plugin: the v1 `auth: { provider, loader }`
export and the `server()` compat shape are gone.

## What it does

The plugin owns auth at the HTTP boundary for **every provider whose id
starts with `zai-max-`** (today: `zai-max-brim`, `zai-max-accordion`; any
future `zai-max-*` provider is picked up automatically - no plugin change
needed). Each provider draws from the GLM Coding Max subscription endpoint
(`https://api.z.ai/api/coding/paas/v4`) with its own isolated key pool:

- **Per-provider key pools** - `~/.local/share/opencode/zai-accounts-<providerID>.json`
  (chmod 600). Pool state (accounts, active key, disabled set, cooldowns,
  hold stashes) is fully isolated per provider: a quota hold on one provider
  can never delay another.
- **Key pool rotation** - requests carry `Authorization: Bearer <active key>`.
  A `401`/`403` disables the key, rotates, and retries immediately
  (verified: the host honors a plugin `{ retry: true, delay: 0 }` decision on
  auth errors). A `429` puts the key on cooldown and rotates.
- **Never unauthenticated** - a request to any `zai-max-*` provider without a
  usable key raises a loud plugin-attributed error (see the error contract
  below). This replaces the v1 empty-pool fail-soft passthrough and the
  `getAuth()` fallback: no silent unauthenticated requests, ever.
- **Quota hold-and-resume** - when the subscription quota is exhausted (`429`
  on a `/coding/` subscription endpoint), the server-derived wait
  (`Retry-After` header, else the configured poll interval) is stashed per
  provider+session and the `retry` hook decides `{ retry: true, delay }`.
  The host applies the delay (verified on opencode 2.3.2: the plugin delay
  replaces the host default backoff), so a quota window surfaces as latency
  instead of a hard error. Concurrent sessions and providers hold
  independently. A `429` from any other endpoint surfaces to the host
  default (the v1 `/coding/` gate).
- **Attempt and hold budgets** - total hold per request is capped at
  `ZAI_QUOTA_WAIT_MAX_MS` and total attempts at `ZAI_MAX_RETRY_ATTEMPTS`
  (default 24); the built-in host max-attempt count remains a hard limit.
  Past either bound the retry decision is `{ retry: false }` with a loud log
  naming the state and the next key-usable time. The rotation breadth per
  request is bounded by `min(pool size, ZAI_MAX_RETRY_ATTEMPTS)`.
- **Model profile enforcement** - the wire body is rewritten so the bundled
  model profile registry (temperature, thinking, reasoning effort per model)
  gets the final word over synthesized reasoning fields.
- **Guarded hooks** - every hook callback is wrapped: non-essential failures
  (logging, body rewrite, classification bookkeeping) are logged and the
  request proceeds; auth-path failures (key resolution, header injection)
  fail loudly with a plugin-attributed error instead of degrading silently.
- **Event-driven pool reload** - pool files are re-read when `fs.watch`
  fires (editors save atomically, so the parent directory is watched) plus
  an mtime re-check on every read. No periodic timers.

## Verified host behavior (opencode 2.3.2)

The v2 hook integration is empirically verified on the installed host; the
full evidence is in [SPIKE-RESULTS.md](SPIKE-RESULTS.md). Highlights:

| Question | Finding |
| --- | --- |
| Provider id exposure | `event.model.providerID` on all three hooks; hooks are registered unscoped and filtered on the `zai-max-` prefix, which serves future providers without re-registration |
| Zero-credential dispatch | A custom openai-compatible provider with no apiKey dispatches normally; the plugin-injected `Authorization` header reaches the wire |
| Throw from `http.request` | The run fails, the plugin error surfaces verbatim, and no request is dispatched (fail-fast is safe) |
| Retry decisions | `decision` arrives pre-filled with the host default; the plugin override (including delay) is honored for 429 and 401/403 |
| Request correlation | `http.response` carries the identical `Request` object - per-key classification is exact |

## The error contract (fail fast)

When a request reaches any `zai-max-*` provider whose pool cannot serve it -
missing file, empty pool, all keys hard-disabled, or the all-cooling hold
budget exhausted - the plugin raises:

```
zai-multi-account: provider "<providerID>" has no usable keys: pool file
<path> is missing or empty. Provision a key with: aws ssm get-parameter
--name /brimcapitalgroup/<providerID>/api-key --with-decryption then write
the pool file <path> as {"accounts":[{"label":"<plan>","type":"plan","apiKey":"<key from SSM>"}]} (chmod 600)
```

The all-hard-disabled and all-cooling-exhausted variants name their state
and the next key-usable time instead of "is missing or empty". In every
case the request is never issued without credentials.

### SSM re-derive recipe

1. Fetch the key (the parameter name is exactly what the error says):

   ```sh
   aws ssm get-parameter --name /brimcapitalgroup/<providerID>/api-key --with-decryption
   ```

2. Write the pool file (never commit it; it lives outside every repo):

   ```sh
   umask 177
   cat > ~/.local/share/opencode/zai-accounts-<providerID>.json <<EOF
   {
     "accounts": [
       { "label": "<plan name>", "type": "plan", "apiKey": "<key from SSM>" }
     ]
   }
   EOF
   chmod 600 ~/.local/share/opencode/zai-accounts-<providerID>.json
   ```

3. The plugin picks the change up event-driven (fs.watch) - no restart.

Multiple keys: repeat the fetch per key (or per provider account) and list
one `accounts` entry per key.

## Key pool file

One file per provider: `~/.local/share/opencode/zai-accounts-<providerID>.json`
(chmod 600). The plugin reads it only; it never writes it, and it must never
be committed anywhere.

```json
{
  "accounts": [
    { "label": "plan-a", "type": "plan", "apiKey": "YOUR_KEY_A" },
    { "label": "plan-b", "type": "plan", "apiKey": "YOUR_KEY_B" }
  ]
}
```

Entries without non-empty string `apiKey` material are dropped. A bare JSON
array of accounts is also accepted. Permissions looser than 0600 are logged
loudly on every load (`pool_perms_warning`).

## Logging

Structured JSONL (the `ZAI_MULTI_ACCOUNT_LOG` file, or stderr when unset),
one line per state transition, provider-tagged:

`plugin_loaded` (providerID, poolSize, path), `pool_reloaded`,
`key_rotated`, `key_disabled`, `key_cooldown`, `hold_start`, `hold_resume`,
`hold_exhausted`, `request_error`, plus `correlation_miss`,
`pool_perms_warning`, `hook_non_essential_failure`, and `body` lines.
Key material appears ONLY masked to its first 4 and last 4 characters
(`supe...9999`); shorter material is fully masked. Never a full key.

## How it plugs in (opencode v2)

The plugin default-exports `{ id, setup }` (the structural object pattern -
no runtime dependency on any opencode package). `setup(ctx)` registers
unscoped session hooks; callbacks filter on the `zai-max-` provider prefix:

| Hook | Behavior |
| --- | --- |
| `http.request` | resolves the active pool key (holding while keys merely cool down, bounded), injects the `Authorization` header, rewrites the JSON body through the profile registry |
| `http.response` | classifies `401`/`403` (disable key) and `429` (cooldown + Retry-After hold stash, `/coding/` endpoints only) |
| `retry` | rotates on auth errors and forces an immediate retry; holds and resumes on quota errors within the attempt and hold budgets; past bounds decides `{ retry: false }` |

Consumption is the standard opencode `plugins` config entry. For local
development note that this host version requires a plugin config entry to
point at a directory, not a single file.

## Provider config (v2 schema)

One provider entry per pool; the id must start with `zai-max-`:

```jsonc
{
  "providers": {
    "zai-max-brim": {
      "name": "ZAI Max (brim)",
      "package": "aisdk:@ai-sdk/openai-compatible",
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

No `apiKey` belongs in the provider config: the plugin injects it. Multiple
providers (`zai-max-brim`, `zai-max-accordion`, ...) each get their own pool
file and hold independently.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `ZAI_ACCOUNTS_DIR` | `~/.local/share/opencode` | base directory holding the per-provider pool files (`zai-accounts-<providerID>.json`) |
| `ZAI_QUOTA_WAIT_MAX_MS` | `21600000` (6h) | total hold cap per request across all hold episodes |
| `ZAI_MAX_RETRY_ATTEMPTS` | `24` | total attempt bound per request before the error surfaces |
| `ZAI_QUOTA_POLL_MS` | `300000` (5min) | retry interval for a quota hold when the server sent no `Retry-After` |
| `ZAI_ROTATE_COOLDOWN_MS` | `60000` | how long a rate-limited (429) key is skipped during rotation |
| `ZAI_QUOTA_WAIT_DISABLED` | unset (`1` disables) | disable hold-and-resume; a 429 surfaces to the host default retry policy |
| `ZAI_MULTI_ACCOUNT_LOG` | unset | log file path (JSON lines, keys masked first4/last4); stderr when unset |

All values are read lazily at use time, so retuning applies without a
restart or re-import.

## Design notes

- **Unscoped hooks + prefix filter** (deliberate, over `{providerID}`
  scoping): scoping requires enumerating provider ids at setup time; the
  filter serves every current and future `zai-max-*` provider with one
  registration. Non-zai-max events are returned untouched.
- **Index-keyed rotation bookkeeping** (inherited from v1, deliberately):
  `disabled` and cooldowns are keyed by pool position, so a reload that
  reorders the file can land a stale state on the wrong slot. The cost is
  bounded (one mislabeled request) and self-healing: the failing key is
  re-classified on its next 401/403/429.
- **`/coding/` endpoint gate**: only subscription-endpoint 429s drive
  hold-and-resume, so a provider `baseURL` repoint away from the
  subscription endpoint degrades to plain rotation, exactly like v1.
- **In-request hold for the all-cooling case**: when a fresh request
  arrives while every key is merely rate-limited, the `http.request` hook
  holds until the earliest cooldown expiry (bounded by the budgets) so the
  cooldown surfaces as latency, never as an unauthenticated request. The
  quota path itself holds via host-applied retry delays, not in-hook sleeps.

## Development

```sh
npm test            # node --test over all suites (runs concurrently, wall time well under 60s)
npm run lint        # node --check over every shipped source (same as CI)
npm run check:tarball
npm run check:license
```

Zero runtime dependencies. Node >= 20.

## Provenance and disclosure

- Original work by Matthew Dresden; Apache-2.0 (see `LICENSE` and `NOTICE`).
- Extracted from the private `opencode-config` repository; pool files live
  outside every repository and keys are only ever held in memory.
- Publishing this plugin discloses the rotation/hold strategy, not any
  credential material.

## License

Apache-2.0
