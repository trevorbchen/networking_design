# Rubric: Distributed rate limiter (SPOILERS)

## Strong answer covers
- Token bucket or sliding-window counter (good accuracy/memory trade-off). Fixed window lets 2× through at boundaries (`lab.html#ratelimit`).
- A pure central Redis `INCR` per request = 2M ops/s plus a network RTT (~0.5 ms) on the hot path. That's borderline. Better: **local token buckets with periodic sync** (each node gets a share or leases tokens in batches from central state), giving approximate global accuracy with zero per-request remote calls.
- State size: 5M keys × ~50 B = small. Shard Redis by key (consistent hashing). Lua scripts for atomic check-and-decrement.
- Failure: usually **fail open** with local conservative limits (availability of the API > strict limiting), and alert. Fail closed only for abuse-critical limits.
- Hot key: one key's traffic hits one Redis shard. Use local buckets / batching of token leases, so the hot key doesn't cause per-request central traffic.
- Return 429 with `Retry-After` and rate-limit headers. Clients should back off with jitter.

## Scoring (10 pts)
- 2 pts: Algorithm choice with boundary/burst reasoning
- 2 pts: State placement with latency budget math
- 2 pts: Approximate/leased-token or hybrid design
- 2 pts: Failure mode choice (fail open/closed) justified
- 1 pts: Hot key handling
- 1 pts: Client contract (429, Retry-After)

Push back in follow-ups on any number given without a derivation.
