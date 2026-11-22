// Structured JSONL logging + plugin-attributed errors.
//
// Every state transition the plugin makes is logged as one JSON line with a
// provider tag. Key material appears ONLY masked (first 4 + last 4
// characters); a key shorter than 8 characters is masked entirely. The log
// sink is ZAI_MULTI_ACCOUNT_LOG (append) or stderr when unset. Log-write
// failures are swallowed by design: observability must never break a request.
import { appendFileSync } from "node:fs"
import { logPath } from "./config.js"

export function maskKey(key) {
  if (typeof key !== "string" || key.length < 8) return "****"
  return `${key.slice(0, 4)}...${key.slice(-4)}`
}

export function logLine(obj) {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n"
    const sink = logPath()
    if (sink) appendFileSync(sink, line)
    else process.stderr.write(line)
  } catch {}
}

// Auth-path failures surface with this prefix so a live-session failure is
// unmistakably the plugin's.
export function pluginError(message) {
  return new Error(`zai-multi-account: ${message}`)
}

export function errText(err) {
  return err?.message || String(err)
}

// The /coding/ gate: quota hold-and-resume applies only to the subscription
// endpoint family (same gate as v1), so a 429 from any other endpoint
// surfaces to the host default.
export function isSubscriptionEndpoint(url) {
  return typeof url === "string" && url.includes("/coding/")
}

export function requestUrl(input) {
  try {
    return input instanceof Request ? input.url : new URL(String(input)).href
  } catch {
    return ""
  }
}
