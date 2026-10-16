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
- **Quota hold-and-resume** - when the subscription quota is exhausted
  (`429`), the request is held (honoring `Retry-After` when present, else the
  configured poll interval) and retried until the quota resets, so a quota
  window surfaces as latency instead of a hard error.
- **Attempt budget** - no infinite retry: total hold per request is capped at
  `ZAI_QUOTA_WAIT_MAX_MS` and total attempts at `ZAI_MAX_RETRY_ATTEMPTS`
  (default 24). Beyond either bound the provider error surfaces. (Note: with
  the default 5-minute poll interval, the 24-attempt bound binds before the
  6-hour hold cap; raise `ZAI_MAX_RETRY_ATTEMPTS` or lower the poll interval
  to reach longer holds.)
- **Model profile enforcement** - the wire body is rewritten so the bundled
  model profile registry (temperature, thinking, reasoning effort per model)
  gets the final word over synthesized reasoning fields.

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
