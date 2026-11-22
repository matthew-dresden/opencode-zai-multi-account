// Tunables and path derivation for the zai-multi-account plugin.
//
// Every behavior knob is environment-driven with a documented default - no
// behavioral literals at call sites. All values are read lazily at use time
// (getter functions), so operators and tests can retune the process env
// without restarting or re-importing the module.
import { homedir } from "node:os"
import { join } from "node:path"

// The plugin owns auth for every provider whose id starts with this prefix
// (today: zai-max-brim, zai-max-accordion; tomorrow: any zai-max-*).
export const PROVIDER_PREFIX = "zai-max-"

// Secrets broker root: each provider's key is minted into
// /brimcapitalgroup/<providerID>/api-key and operators derive the pool file
// from it. The error contract names this command (see failFastMessage).
export const SSM_PARAM_ROOT = "/brimcapitalgroup"

function num(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

// ZAI_ACCOUNTS_DIR: base directory for pool files. Override exists for tests
// and for operators who keep pools outside the opencode data dir.
export function accountsDir() {
  return process.env.ZAI_ACCOUNTS_DIR || join(homedir(), ".local/share/opencode")
}

// Pool file for one provider: <dir>/zai-accounts-<providerID>.json
export function poolPath(providerID) {
  return join(accountsDir(), `zai-accounts-${providerID}.json`)
}

// Remediation command named by the fail-fast error (the key lives in SSM;
// the pool file is derived from it - see README's re-derive recipe).
export function ssmCommand(providerID) {
  return `aws ssm get-parameter --name ${SSM_PARAM_ROOT}/${providerID}/api-key --with-decryption`
}

// ZAI_QUOTA_WAIT_DISABLED=1: hold-and-resume off; a 429 then surfaces to the
// host default retry policy instead of being held.
export function quotaWaitEnabled() {
  return process.env.ZAI_QUOTA_WAIT_DISABLED !== "1"
}

// ZAI_QUOTA_WAIT_MAX_MS: total hold cap per request across all hold episodes
// (default 6h).
export function quotaWaitMaxMs() {
  return num(process.env.ZAI_QUOTA_WAIT_MAX_MS, 21600000)
}

// ZAI_QUOTA_POLL_MS: retry interval for a quota hold when the server sent no
// Retry-After (default 5 minutes).
export function quotaPollMs() {
  return num(process.env.ZAI_QUOTA_POLL_MS, 300000)
}

// ZAI_MAX_RETRY_ATTEMPTS: total attempt bound per request before the error
// surfaces (default 24).
export function maxRetryAttempts() {
  return num(process.env.ZAI_MAX_RETRY_ATTEMPTS, 24)
}

// ZAI_ROTATE_COOLDOWN_MS: how long a rate-limited (429) key is skipped during
// rotation (default 60s).
export function cooldownMs() {
  return num(process.env.ZAI_ROTATE_COOLDOWN_MS, 60000)
}

// ZAI_MULTI_ACCOUNT_LOG: JSONL log destination; stderr when unset.
export function logPath() {
  return process.env.ZAI_MULTI_ACCOUNT_LOG || null
}

// The plugin-attributed error text for a pool that cannot serve a request.
// The message names the provider, the expected pool path, and the SSM
// remediation command - the complete fail-fast contract (replaces the v1
// fail-soft empty-pool passthrough; no silent unauthenticated requests, ever).
export function failFastMessage(providerID, path, detail) {
  return (
    `provider "${providerID}" has no usable keys: pool file ${path} ${detail}. ` +
    `Provision a key with: ${ssmCommand(providerID)} ` +
    `then write the pool file ${path} as {"accounts":[{"label":"<plan>","type":"plan","apiKey":"<key from SSM>"}]} (chmod 600)`
  )
}
