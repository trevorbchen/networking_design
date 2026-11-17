# Rubric: URL shortener (warm-up) (SPOILERS)

## Strong answer covers
- Estimates: ~40 writes/s avg, ~4k redirects/s avg (×3–5 peak). 6B rows × ~500 B ≈ 3 TB → fits a sharded KV or even a single big DB plus replicas.
- Code generation: base62 of 7 chars = 3.5T codes. Options: a distributed counter / ticket server / range allocation per server (no collisions, but predictable, so maybe shuffle/encrypt), or random + uniqueness check. Hash(url) gives dedup, but collisions must be handled.
- Store: KV by code (DynamoDB/Cassandra/Redis+DB). Read-heavy (100:1). Cache hot codes (Zipf), CDN/edge caching of 301s (or 302 if analytics needed per click).
- Analytics: async. The redirect path emits an event to a queue (Kafka), and a stream aggregator writes counters. Never write to the DB synchronously on redirect.
- Extras: abuse/malware scanning, rate limiting creation, custom alias uniqueness (conditional put), expiry.
- Strong answers discuss 301 vs 302 trade-off, cache hit ratio math, and how code allocation survives node failures.

## Scoring (10 pts)
- 2 pts: Correct order-of-magnitude estimates
- 2 pts: Sound code-generation scheme with collision handling
- 2 pts: Datastore justified by access pattern
- 2 pts: Caching/CDN for read path with hit-ratio reasoning
- 1 pts: Async analytics pipeline
- 1 pts: Failure/abuse considerations

Push back in follow-ups on any number given without a derivation.
