# Answer key — 004-cache-stampede (SPOILERS)

## Root cause
**catalog v3.8.0** (17:45) was deployed with strategy **Recreate**: all 12 pods replaced at once.
Every pod started with a **cold in-process cache** at the same moment and loaded its hot products in the same ~25 s.
With `expireAfterWrite=300s`, those entries **all expire together 300 s later**. The pods refill them in the same few
seconds, so they expire together again, and so on. The deploy **synchronized** 12 caches that used to be naturally
desynchronized (rolling deploys + organic access patterns spread out load times).

Every 5 minutes, ~a third of hot keys miss on every pod simultaneously. There's no request coalescing, so many
concurrent requests for the same product each issue the same query (**dogpile**). products-db gets a burst of
~2× its normal QPS for ~10–30 s, CPU hits 100%, connections hit 300, and requests get `too many clients` / loader timeouts → 500s.

**Why it's getting worse:** the burst size ∝ traffic. Evening traffic climbs 1.5k → 2.6k rps, so the bursts
crossed DB capacity around 18:10 and keep growing. The width also spreads slightly over time (the waves diffuse),
which lengthens each burst.

**Average DB load is fine** (~25–40% CPU between bursts). The problem is **peak**, not mean.

## Key evidence
- Bursts are exactly **300 s apart**, matching the cache TTL in the architecture notes.
- Heatmap of `catalog/*:cache_hit_ratio`: **vertical stripes**. All 12 pods dip at the same moments. `cache_entries` drops in lockstep.
- First dip: the cold start right at the 17:45 Recreate deploy (all pods log `(cold)` within 10 s). There are no periodic dips before it.
- `products-db:identical_inflight_queries` spikes in each burst (dogpile). DB slow-query log shows the same `id` repeated.
- `products-db:cpu` / `connections` saturate only during bursts. Burst peaks grow with `web:rps`.
- Traces in a burst: many `cache.get (MISS → load)` spans with slow `SELECT product`.

## Red herrings
- **jackson upgrade** (same deploy): slightly higher catalog CPU, but no relation to periodic misses. The *deploy strategy*
  in that deploy is what matters.
- **Nightly price import (18:20–18:27)**: raises write IOPS and adds a few % of DB CPU, but bursts happen before, during, and after it with the same period.
- "We need a bigger DB": a ~25–50% bigger DB postpones the problem (bursts grow with traffic, and Black Friday traffic will exceed it)
  and wastes money, since the DB idles at 25–40% between bursts. Fix the herd, not the DB.

## Mitigation (now)
- **Rolling restart of catalog with staggered starts** (e.g. one pod per 30–60 s). This de-synchronizes the pods' caches.
  It's a partial fix: within a pod the keys are still loaded together.
- Or ship a quick config change: add **TTL jitter** (e.g. 300 s ± 20%), then do a rolling deploy.

## Durable fixes
- **TTL jitter / randomized expiry**, so entries don't expire in sync.
- **Request coalescing (singleflight)**: one in-flight load per key per pod (Caffeine `AsyncLoadingCache` does this). Across pods, use a shared cache layer or a lock lease.
- **Stale-while-revalidate / refreshAfterWrite**: serve the stale value while refreshing in the background. Or use
  **probabilistic early expiration** (XFetch): refresh slightly before expiry with a probability that rises as expiry approaches.
- Shared cache tier (Redis/memcached) in front of the DB, so 12 pods don't each refill separately.
- Never use **Recreate** for cache-heavy services. Use rolling/canary with warm-up and a slow start.
- DB-side protection: connection pooler (PgBouncer), load-shed cache loads past N concurrent.
- Alerts on **burst-level** metrics (max over 10 s windows), not 1-minute averages, plus hit ratio and identical-inflight queries.

## Grading rubric (10 pts)
| pts | criterion |
|----|-----------|
| 2 | Identifies the 300 s period = cache TTL; synchronized expiry → cache stampede |
| 2 | Explains *why* synchronized: Recreate deploy cold-started all pods at once (cold start at 17:45) |
| 1 | Explains dogpile (no coalescing → duplicate concurrent loads) |
| 1 | Explains growth over time (burst ∝ traffic, crossing DB capacity) |
| 1 | Peak vs average argument; argues against "just buy a bigger DB" |
| 1 | Rules out price import and/or jackson upgrade |
| 2 | Fixes: TTL jitter + coalescing/stale-while-revalidate (+ rolling deploy as immediate) |
