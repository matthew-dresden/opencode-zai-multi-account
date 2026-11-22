# Changelog

## [2.0.0] - 2026-11-22

### Breaking Changes

- feat!: serve every `zai-max-*` provider with isolated per-provider key pools, rotation, cooldown, and quota hold-and-resume
- feat!: remove the v1 `auth: { provider, loader }` export and the `server()` compat shape; the plugin is now a native v2 `{ id, setup }` plugin and never falls back to stored auth - an unusable pool fails fast
- feat!: rename `ZAI_ACCOUNTS_PATH` to `ZAI_ACCOUNTS_DIR` (per-provider pool files `zai-accounts-<providerID>.json`) and `ZAI_QUOTA_WAIT_POLL_MS` to `ZAI_QUOTA_POLL_MS`

### Added

- fail-fast error contract naming the provider, pool path, and the SSM re-derive command
- 429 hold stash keyed by provider+session, so a hold on one provider never delays another
- event-driven pool reload via fs.watch plus mtime re-check on read (no periodic timers)
- structured JSONL logs for every state transition, provider-tagged, keys masked to first4/last4
- SPIKE-RESULTS.md recording the empirical opencode 2.3.2 hook API verification (provider id exposure, zero-credential dispatch, fail-fast throw semantics, retry decision override)

### Maintenance

- CI lint step runs `npm run lint` (node --check over all shipped sources, local-CI 1:1); tarball allowlist covers the new src modules
