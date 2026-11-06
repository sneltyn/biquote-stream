/**
 * The timestamp we publish for one biquote tick.
 *
 * biquote stamps ticks in WHOLE SECONDS (`2026-11-04T20:40:19Z`), and coins
 * drops every tick whose stamp is not strictly greater than the previous one of
 * that symbol — so the vendor's own stamp alone would keep the first tick of
 * each second and throw the rest away. Three rules, in this order:
 *
 *   1. ARRIVAL TIME, but never past the end of the vendor's second. A fresh
 *      tick (the normal case, ~0.1-0.2 s in transit) gets its real arrival
 *      millisecond. A tick that arrives LATE stays pinned to its own second, so
 *      its age remains measurable downstream — stamping it "now" would make a
 *      stale price look fresh, which is precisely the failure that sent us
 *      looking for a second vendor (Capital's stream ran ~10 s behind with
 *      correct-looking ticks).
 *   2. Never in the future: a vendor clock ahead of ours yields our clock, and
 *      coins' future-stamp guard rejects anything ahead of it anyway.
 *   3. Strictly increasing per symbol (+1 ms), so two ticks of one millisecond,
 *      or several late ticks pinned to one second, all survive coins'
 *      monotonic guard.
 */
export function tickStamp(
  vendorMs: number,
  nowMs: number,
  lastMs: number | undefined
): number {
  const secondEnd = Math.floor(vendorMs / 1000) * 1000 + 999
  const stamp = Math.min(nowMs, secondEnd)
  return lastMs !== undefined && stamp <= lastMs ? lastMs + 1 : stamp
}
