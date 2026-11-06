import {
  HttpTransportType,
  type HubConnection,
  HubConnectionBuilder,
  HubConnectionState,
  LogLevel,
} from '@microsoft/signalr'

import {
  BIQUOTE_HUB_URL,
  FOREX_PAIRS,
  LAG_WARN_MS,
  NATS_SUBJECT_FOREX,
  RECONNECT_MAX_MS,
  RECONNECT_MIN_MS,
  STALE_CHECK_INTERVAL_MS,
  STALE_TIMEOUT_MS,
  STATS_INTERVAL_MS,
  SYMBOL_OVERRIDES,
} from '@config/env'
import { logger } from '@config/logger'
import { nats } from '@config/nats'

import { tickStamp } from './stamp'

/**
 * One frame of the hub's `ReceiveTick` event, as observed 2026-11-04:
 *
 *   {"symbol":"EURUSD","bid":1.12298,"ask":1.12304,"last":0,"volume":0,
 *    "timestamp":"2026-11-04T20:40:19Z","source":"MetaTrader 5 (Broker 1)",
 *    "high":1.12729,"low":1.11987,"direction":"FLAT","dayDiffPercent":0.3413,
 *    "description":"Euro vs US Dollar","time":"2026.11.04 20:40:19",
 *    "exchange":"FOREX","spread":0.00006,"mid":1.12301}
 *
 * `timestamp` is WHOLE SECONDS (see stamp.ts). `time` is MetaTrader's own
 * string and biquote's docs say not to parse it.
 */
interface VendorTick {
  symbol?: string
  bid?: number
  ask?: number
  timestamp?: string
  source?: string
}

/** What goes onto the bus — the same shape capital-stream publishes. */
interface PriceTick {
  symbol: string
  price: number
  bid: number
  ask: number
  timestamp: number
}

export class BiquoteForex {
  private static instance: BiquoteForex | null = null

  public static init(): void {
    if (BiquoteForex.instance !== null) return
    BiquoteForex.instance = new BiquoteForex()
    void BiquoteForex.instance.start()
  }

  public static async shutdownAll(): Promise<void> {
    await BiquoteForex.instance?.shutdown()
  }

  private readonly label = 'forex'
  private conn: HubConnection | null = null
  private stopped = false
  private reconnectTimer: NodeJS.Timeout | null = null
  private staleTimer: NodeJS.Timeout | null = null
  private statsTimer: NodeJS.Timeout | null = null
  private reconnectDelay = RECONNECT_MIN_MS
  private lastMessageAt = 0
  private connectedAt = 0
  private tickedSinceConnect = false

  /** vendor symbol → ours */
  private readonly symbolByVendor = new Map<string, string>()
  private readonly lastTickAt = new Map<string, number>()
  private readonly lastStamp = new Map<string, number>()
  private readonly sourcesBySymbol = new Map<string, Set<string>>()
  private readonly tickedSinceConnectSet = new Set<string>()
  private stats = { published: 0, invalid: 0, rejected: 0 }
  private ages: number[] = []

  private constructor() {
    for (const pair of FOREX_PAIRS) {
      this.symbolByVendor.set(this.vendorFor(pair), pair)
    }
  }

  /** Forex is the six letters without the slash — until it is not. */
  private vendorFor(pair: string): string {
    return SYMBOL_OVERRIDES[pair] ?? pair.replace('/', '')
  }

  private async start(): Promise<void> {
    this.staleTimer = setInterval(
      () => this.checkStale(),
      STALE_CHECK_INTERVAL_MS
    )
    this.statsTimer = setInterval(() => this.reportStats(), STATS_INTERVAL_MS)
    await this.connect()
  }

  private async connect(): Promise<void> {
    if (this.stopped) return
    const conn = new HubConnectionBuilder()
      .withUrl(BIQUOTE_HUB_URL, { transport: HttpTransportType.WebSockets })
      .configureLogging(LogLevel.Warning)
      .build()
    this.conn = conn

    conn.on('ReceiveTick', (tick: VendorTick) => this.onTick(tick))
    // The hub confirms each Subscribe with its own view of the subscription.
    // Logged rather than parsed: its shape is undocumented, and the authority
    // on what is subscribed stays `GetSubscriptions` + what actually ticks.
    conn.on('ReceiveSubscriptionState', (state: unknown) => {
      logger.info(
        `[${this.label}] hub subscription state: ${JSON.stringify(state).slice(0, 300)}`
      )
    })
    conn.onclose((err) => {
      if (this.conn === conn) this.conn = null
      if (this.stopped) return
      logger.warn(
        `[${this.label}] hub closed${err ? `: ${String(err)}` : ''} — reconnecting in ${this.reconnectDelay}ms`
      )
      this.scheduleReconnect()
    })

    try {
      logger.info(`[${this.label}] connecting to ${BIQUOTE_HUB_URL}`)
      await conn.start()
      this.connectedAt = Date.now()
      this.lastMessageAt = this.connectedAt
      this.tickedSinceConnect = false
      this.tickedSinceConnectSet.clear()
      await this.subscribe(conn)
    } catch (err) {
      logger.error(`[${this.label}] connect failed: ${String(err)}`)
      if (this.conn === conn) this.conn = null
      void conn.stop().catch(() => undefined)
      this.scheduleReconnect()
    }
  }

  /**
   * Subscribe, then ask the hub what it actually holds. The hub does not refuse
   * an unknown name — it just never ticks it — so the only check available at
   * subscribe time is the hub's own list; the stats line names whatever still
   * never ticks.
   */
  private async subscribe(conn: HubConnection): Promise<void> {
    const wanted = [...this.symbolByVendor.keys()]
    await conn.invoke('Subscribe', wanted)
    let held: string[] = []
    try {
      const res: unknown = await conn.invoke('GetSubscriptions')
      if (Array.isArray(res))
        held = res.filter((s): s is string => typeof s === 'string')
    } catch (err) {
      logger.warn(`[${this.label}] GetSubscriptions failed: ${String(err)}`)
    }
    const heldSet = new Set(held.map((s) => s.toUpperCase()))
    const missing = wanted.filter((s) => !heldSet.has(s.toUpperCase()))
    logger.info(
      `[${this.label}] subscribed ${wanted.length} symbol(s), hub holds ${held.length}`
    )
    if (held.length > 0 && missing.length > 0) {
      logger.error(
        `[${this.label}] hub did not take ${missing.length} symbol(s): ${missing.join(',')} — ` +
          `check the name with GET https://biquote.io/api/symbols/search?q= and set SYMBOL_OVERRIDES`
      )
    }
  }

  private onTick(t: VendorTick): void {
    const now = Date.now()
    this.lastMessageAt = now
    const symbol = t.symbol ? this.symbolByVendor.get(t.symbol) : undefined
    if (symbol === undefined) return

    const bid = Number(t.bid)
    const ask = Number(t.ask)
    const vendorMs = Date.parse(t.timestamp ?? '')
    if (
      !Number.isFinite(bid) ||
      !Number.isFinite(ask) ||
      bid <= 0 ||
      ask <= 0 ||
      bid > ask ||
      !Number.isFinite(vendorMs)
    ) {
      this.stats.invalid += 1
      return
    }

    if (!this.tickedSinceConnect) {
      this.tickedSinceConnect = true
      this.reconnectDelay = RECONNECT_MIN_MS // the feed is alive — reset backoff
    }
    this.tickedSinceConnectSet.add(symbol)
    this.lastTickAt.set(symbol, now)
    this.ages.push(now - vendorMs)
    if (t.source) {
      let set = this.sourcesBySymbol.get(symbol)
      if (set === undefined) this.sourcesBySymbol.set(symbol, (set = new Set()))
      set.add(t.source)
    }

    const timestamp = tickStamp(vendorMs, now, this.lastStamp.get(symbol))
    this.lastStamp.set(symbol, timestamp)
    this.publish({ symbol, price: (bid + ask) / 2, bid, ask, timestamp }).catch(
      (err) => {
        logger.error(
          `[${this.label}] publish failed symbol=${symbol} ts=${timestamp}: ${String(err)}`
        )
      }
    )
  }

  private async publish(tick: PriceTick): Promise<void> {
    if (!nats.isConnected()) {
      // Counted, not hidden: these ticks are gone for good.
      this.stats.rejected += 1
      return
    }
    const ack = await nats.publishJSON(
      NATS_SUBJECT_FOREX,
      tick,
      `${tick.symbol}:${tick.timestamp}`
    )
    if (!ack.duplicate) this.stats.published += 1
  }

  /** Whole-feed silence on a "connected" hub is a dead stream, not a quiet one. */
  private checkStale(): void {
    const conn = this.conn
    if (this.stopped || conn === null) return
    if (conn.state !== HubConnectionState.Connected) return
    const idle = Date.now() - this.lastMessageAt
    if (idle < STALE_TIMEOUT_MS) return
    logger.warn(
      `[${this.label}] no tick for ${idle}ms on a connected hub — reconnecting`
    )
    // A reconnect that brings nothing back (weekend close) stretches the next.
    if (!this.tickedSinceConnect) {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS)
    }
    void conn.stop().catch(() => undefined) // onclose schedules the reconnect
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, this.reconnectDelay)
  }

  // One line per interval, always emitted — including all-zero. AGE is the
  // point of it: arrival − the vendor's own stamp (whole seconds, so a fresh
  // feed reads ~0.1-1.0 s). Escalated to WARN past LAG_WARN_MS.
  private reportStats(): void {
    const now = Date.now()
    const ages = this.ages.sort((a, b) => a - b)
    this.ages = []
    const p = (q: number): number | null =>
      ages.length === 0
        ? null
        : ages[Math.min(ages.length - 1, Math.floor(q * ages.length))]
    const p50 = p(0.5)

    const silent: string[] = []
    for (const [symbol, at] of this.lastTickAt) {
      if (now - at > STATS_INTERVAL_MS)
        silent.push(`${symbol}:${Math.round((now - at) / 1000)}s`)
    }
    const neverTicked =
      this.conn !== null && now - this.connectedAt > STATS_INTERVAL_MS
        ? FOREX_PAIRS.filter((s) => !this.tickedSinceConnectSet.has(s))
        : []
    const multiSource = [...this.sourcesBySymbol]
      .filter(([, set]) => set.size > 1)
      .map(([s, set]) => `${s}(${[...set].join('|')})`)
    this.sourcesBySymbol.clear()

    const { published, invalid, rejected } = this.stats
    this.stats = { published: 0, invalid: 0, rejected: 0 }
    const line =
      `[${this.label}] stats published=${published} invalid=${invalid} rejected=${rejected} ` +
      `ticking=${this.tickedSinceConnectSet.size}/${FOREX_PAIRS.length} ` +
      `age_p50=${p50 ?? '-'}ms age_p90=${p(0.9) ?? '-'}ms age_max=${p(1) ?? '-'}ms` +
      (silent.length > 0 ? ` silent=[${silent.join(' ')}]` : '') +
      (neverTicked.length > 0
        ? ` never_ticked=[${neverTicked.join(',')}]`
        : '') +
      (multiSource.length > 0 ? ` MULTI_SOURCE=[${multiSource.join(' ')}]` : '')

    if (p50 !== null && p50 > LAG_WARN_MS) {
      logger.warn(`${line} — FEED LAGGING (p50 age > ${LAG_WARN_MS}ms)`)
    } else {
      logger.info(line)
    }
  }

  private async shutdown(): Promise<void> {
    this.stopped = true
    for (const t of [this.reconnectTimer, this.staleTimer, this.statsTimer]) {
      if (t !== null) clearTimeout(t)
    }
    const conn = this.conn
    this.conn = null
    if (conn !== null) await conn.stop().catch(() => undefined)
  }
}
