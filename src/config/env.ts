import 'dotenv/config'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import * as process from 'process'

// node env
export const NODE_ENV = process.env.NODE_ENV ?? 'development'
export const APP_NAME = process.env.APP_NAME ?? 'biquote-stream'

// ── biquote ──────────────────────────────────────────────────────────────
/**
 * SignalR hub. No key, no login — the service is anonymous and free, which is
 * also its whole risk: no SLA, and access can be withdrawn without notice
 * (https://biquote.io/terms.html). Their terms also forbid exposing biquote
 * quotes through OUR public API (the Broker API's price streams are exactly
 * that) — which vendor an environment prices off is decided in coins
 * (`NONOTC_PRICE_PROVIDER`), not here.
 */
export const BIQUOTE_HUB_URL =
  process.env.BIQUOTE_HUB_URL ?? 'https://biquote.io/hubs/tick'

// ── Subscription set ─────────────────────────────────────────────────────
// Slash form here and in `Pair.symbol`; biquote names a forex pair by its six
// letters and everything else by its own MT5 name (XAUUSD, USTEC, DE30…). The
// socket converts both ways and nothing outside it has to know.
const DEFAULT_FOREX_PAIRS = [
  'EUR/USD',
  'USD/JPY',
  'GBP/USD',
  'USD/CHF',
  'AUD/USD',
  'USD/CAD',
  'NZD/USD',
  'EUR/GBP',
  'EUR/JPY',
  'GBP/JPY',
]

function loadPairs(file: string, fallback: string[]): string[] {
  const path = resolve(process.cwd(), file)
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!Array.isArray(parsed) || parsed.length === 0) return fallback
    return parsed.filter(
      (s): s is string => typeof s === 'string' && s.length > 0
    )
  } catch {
    // Absent file is the normal local case; the deploy mounts the real list.
    return fallback
  }
}

export const FOREX_PAIRS = loadPairs(
  process.env.FOREX_PAIRS_FILE ?? 'pairs.forex.json',
  DEFAULT_FOREX_PAIRS
)

/**
 * Our symbol → biquote's, for every symbol that is NOT the six letters without
 * the slash — JSON object, `{"XAU/USD": "XAUUSD", "NAS100/USD": "USTEC"}`.
 *
 * A wrong name does not throw: the hub accepts the subscription and simply
 * never ticks it. That is why the socket compares what it asked for against
 * `GetSubscriptions` and later against what actually ticked, and names the
 * difference.
 */
export const SYMBOL_OVERRIDES: Record<string, string> = (() => {
  const raw = process.env.SYMBOL_OVERRIDES ?? ''
  if (!raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    // eslint-disable-next-line no-console
    console.warn('[env] SYMBOL_OVERRIDES is not valid JSON — ignoring')
    return {}
  }
})()

// ── NATS ─────────────────────────────────────────────────────────────────
export const NATS_SERVERS = (
  process.env.NATS_SERVERS ?? 'nats://127.0.0.1:4222'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
export const NATS_NAME = process.env.NATS_NAME ?? APP_NAME
export const NATS_USER = process.env.NATS_USER || undefined
export const NATS_PASSWORD = process.env.NATS_PASSWORD || undefined
export const NATS_TOKEN = process.env.NATS_TOKEN || undefined
export const NATS_CREDS_FILE = process.env.NATS_CREDS_FILE || undefined
export const NATS_RECONNECT_WAIT_MS = process.env.NATS_RECONNECT_WAIT_MS
  ? Number(process.env.NATS_RECONNECT_WAIT_MS)
  : 2_000
export const NATS_RECONNECT_JITTER_MS = process.env.NATS_RECONNECT_JITTER_MS
  ? Number(process.env.NATS_RECONNECT_JITTER_MS)
  : 500
export const NATS_PUBLISH_TIMEOUT_MS = process.env.NATS_PUBLISH_TIMEOUT_MS
  ? Number(process.env.NATS_PUBLISH_TIMEOUT_MS)
  : 5_000

// THE LAST TOKEN NAMES THE VENDOR and is load-bearing: coins ingests everything
// matching `prices.*.>` into one durable and picks a forex vendor by this token
// (`NONOTC_PRICE_PROVIDER`). An UNKNOWN token is not filtered — coins treats it
// as "not provider-tagged" and lets it through — so a token coins has never
// heard of does not go unused, it INTERLEAVES with whatever provider is
// selected, in prod too. coins must know `biquote` BEFORE this service starts.
export const NATS_SUBJECT_FOREX =
  process.env.NATS_SUBJECT_FOREX ?? 'prices.forex.biquote'

export const NATS_STREAM_NAME = process.env.NATS_STREAM_NAME ?? 'PRICES'
export const NATS_STREAM_SUBJECTS = (
  process.env.NATS_STREAM_SUBJECTS ?? 'prices.>'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
export const NATS_STREAM_MAX_AGE_MS = process.env.NATS_STREAM_MAX_AGE_MS
  ? Number(process.env.NATS_STREAM_MAX_AGE_MS)
  : 300_000
export const NATS_STREAM_MAX_BYTES = process.env.NATS_STREAM_MAX_BYTES
  ? Number(process.env.NATS_STREAM_MAX_BYTES)
  : 1024 * 1024 * 1024
export const NATS_STREAM_REPLICAS = process.env.NATS_STREAM_REPLICAS
  ? Number(process.env.NATS_STREAM_REPLICAS)
  : 1

// ── Liveness ─────────────────────────────────────────────────────────────
// A whole-feed silence this long while the hub reports connected → reconnect.
// Forex closes for the weekend, so a reconnect that brings nothing back backs
// off (doubling up to RECONNECT_MAX_MS) instead of spinning.
export const STALE_TIMEOUT_MS = process.env.STALE_TIMEOUT_MS
  ? Number(process.env.STALE_TIMEOUT_MS)
  : 60_000
export const STALE_CHECK_INTERVAL_MS = process.env.STALE_CHECK_INTERVAL_MS
  ? Number(process.env.STALE_CHECK_INTERVAL_MS)
  : 15_000
export const RECONNECT_MIN_MS = process.env.RECONNECT_MIN_MS
  ? Number(process.env.RECONNECT_MIN_MS)
  : 5_000
export const RECONNECT_MAX_MS = process.env.RECONNECT_MAX_MS
  ? Number(process.env.RECONNECT_MAX_MS)
  : 600_000
export const STATS_INTERVAL_MS = process.env.STATS_INTERVAL_MS
  ? Number(process.env.STATS_INTERVAL_MS)
  : 60_000

/**
 * Feed AGE, i.e. arrival − the vendor's own stamp, at which the stats line is
 * escalated to a warning. The stamp is whole seconds, so a perfectly fresh feed
 * reads ~0.1-1.0 s; 3 s is unambiguous lag. This is the measurement capital-
 * stream lacked when its vendor ran ~10 s behind for hours unnoticed.
 */
export const LAG_WARN_MS = process.env.LAG_WARN_MS
  ? Number(process.env.LAG_WARN_MS)
  : 3_000
