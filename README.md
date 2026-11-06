# biquote-stream

biquote.io forex + CFDs → NATS. One SignalR hub in, one JetStream subject out.

```
https://biquote.io/hubs/tick   →   prices.forex.biquote
```

Nothing else. No HTTP surface, no database, no dependency on any other
producer: consumers reach it by subscribing to the subject.

## Why this vendor, beside the others

Added 2026-11-06 because Capital.com's **stream** ran ~10 s behind its own
timestamps for hours at a time (measured from our server and from a laptop, on a
fresh session, while Capital's REST snapshot was 0.2–0.9 s fresh). In the same
windows biquote's hub matched Capital's REST to within ~0.25 s.

biquote re-publishes a broker's MetaTrader 5 feed (`source: "MetaTrader 5
(Broker 1)"`): real bid/ask, forex + metals + energy + indices + stocks.

**Know what it is before relying on it** (https://biquote.io/terms.html):

- free and anonymous — **no SLA**, no notice of changes, access can be
  withdrawn at any time;
- commercial use is allowed only "to the extent we are able to grant it", and
  **exposing biquote quotes through your own public API is forbidden** — which
  is what our Broker API price streams do.

Which vendor an environment prices off is decided in coins
(`NONOTC_PRICE_PROVIDER`), never here.

## Published payload

```jsonc
{
  "symbol": "EUR/USD",   // OUR slash form
  "price": 1.12301,      // mid
  "bid": 1.12298,
  "ask": 1.12304,
  "timestamp": 1793959863999
}
```

Same shape capital-stream publishes, so coins consumes both through one path.

## The timestamp is ours, and why

biquote stamps ticks in **whole seconds**, and coins drops any tick whose stamp
is not strictly greater than the previous one of that symbol — the vendor stamp
alone would keep one tick per second. So (`src/apps/sockets/stamp.ts`):

1. the **arrival** millisecond, but never past the end of the vendor's second —
   a fresh tick gets its real time, a LATE tick stays pinned to its own second so
   its age remains visible downstream instead of looking fresh;
2. never in the future;
3. strictly increasing per symbol (+1 ms).

## Symbols

Our names, slash form, in `pairs.forex.json` (the deploy mounts the real list).
A forex pair is the six letters without the slash; everything else needs an
entry in `SYMBOL_OVERRIDES` (biquote's MT5 names):

```json
{"XAU/USD":"XAUUSD","NAS100/USD":"USTEC","GER40/EUR":"DE30","NGAS/USD":"XNGUSD"}
```

A wrong name does not throw — the hub just never ticks it. The socket compares
the request with `GetSubscriptions`, and the stats line lists `never_ticked`.
Find a name with `GET https://biquote.io/api/symbols/search?q=`.

## Stats line (every `STATS_INTERVAL_MS`)

```
[forex] stats published=754 invalid=0 rejected=0 ticking=37/37 age_p50=571ms age_p90=1064ms age_max=6311ms
```

`age` = arrival − the vendor's stamp. The stamp is whole seconds, so a healthy
feed reads ~0.1–1.0 s. Past `LAG_WARN_MS` (3 s) the line is a WARN ending in
`FEED LAGGING` — the measurement capital-stream did not have.

`MULTI_SOURCE=[…]` would mean biquote is mixing two upstream sources into one
symbol. It should never appear for the symbols we use.

## Running

```sh
yarn install
yarn test        # node:test, stamp rules
yarn build
NATS_SERVERS=nats://127.0.0.1:4222 node dist/server.js
```

## Deploy order (binodex)

**coins first, in BOTH environments, then this service.** coins treats an
unknown subject token as "not provider-tagged" and lets it through, so a coins
that has never heard of `biquote` would INTERLEAVE these ticks with the selected
vendor's in prod.
