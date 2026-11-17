# Answer key — 003-retry-storm (SPOILERS)

## Summary
**Trigger:** a 45 s user-db failover (03:25:00–03:25:45).
**Sustaining mechanism:** a **retry storm → metastable failure**. During the outage, retries at two layers
multiplied load on `profile` ~**10×**. Profile has an unbounded queue and doesn't drop work for callers
who have already given up, so its queue latency went way past the api's 1 s timeout. As a result, **almost
every request it completed was for a caller that had already timed out**. That produced more timeouts, which produced more retries,
which kept offered load above capacity indefinitely. The system has two stable states (healthy and
overloaded), and a 45 s blip knocked it into the bad one.

## Amplification math
- Users: ~900 actions/s (`edge:user_requests`).
- Mobile retries (3 tries) → `edge:rps` ≈ 2,300–2,400/s (~2.6×).
- api → profile retries (4 attempts, no backoff) → `profile:rps_received` ≈ **8,600/s** (~3.8× more).
- **Total ≈ 9.5–10× amplification** vs. a profile capacity of 8 × 250 = 2,000/s.
- So `profile:rps_completed` was capped at ~2,000/s, but `responses_to_closed_conn` ≈ 90% of that:
  **goodput collapsed** even though throughput was at max. Success rate ≈ 12%.

## Why scaling 8 → 12 pods didn't help
Capacity went 2,000 → 3,000/s, but offered load was ~8,600/s. Still far over capacity, so the queue
stayed huge and latency stayed > 1 s. Every completion was still too late, and retries kept the load up.
(It also pushed more connections onto the DB.) You can't scale your way out of a 10× multiplier.

## Why the 03:45 config fixed it
`api.profile.retries 3 → 0` removed the api multiplier (~3.8× → 1×), so offered load fell to ~2,300/s,
about at the new 3,000/s capacity. `profile.shed_queue_age_ms=500` **dropped requests that had been queued too long**
instead of uselessly processing them. The queue drained, latency fell below the timeout,
successes resumed, client retries stopped, and the loop unwound. It wasn't luck: it cut the feedback loop.

## Key evidence
- `profile:rps_received` ≫ `edge:user_requests` during the incident. They're 1:1 before and after.
- `edge:user_requests` actually **dropped ~15% around 03:35** with no recovery, which shows the problem wasn't user load.
- user-db healthy from 03:25:45 on: qps flowing, CPU ~35–40%, query p99 low. The DB is not the sustaining cause.
- `profile:latency_p99` ≈ 8–9 s (queueing) vs. api timeout 1 s. `queue_depth` in the thousands.
- `profile:responses_to_closed_conn` ≈ `rps_completed`. Logs: `write response failed: broken pipe ... queued 6.3s`.
- api logs `retrying (attempt 3/4)`. Traces show 2–4 sequential 1000 ms timed-out attempts.
- Recovery within ~1–2 min of the config change. Load-shed WARNs briefly, then silence.

## Red herrings
- **user-db** is the trigger, not the cause of the 20-minute outage. "Make the DB failover faster" helps less than
  fixing the feedback loop.
- **Scaling profile** looked like it helped a little (CPU per pod dropped) but didn't change the outcome.
- **pg_dump on replica at 03:38**: it's on a replica, it isn't in the request path, and nothing changed when it started.

## Prevention (should name ≥3)
1. **Retry budgets / adaptive retries**: e.g. retries ≤ 10% of requests (gRPC/Finagle style), and **retry at
   one layer only**, not at every hop.
2. **Exponential backoff with jitter** at clients, plus server-sent `Retry-After`.
3. **Deadline propagation**: pass the caller's deadline downstream and drop work whose deadline has passed.
4. **Load shedding / bounded queues**: LIFO or CoDel-style queue management, admission control, rejecting early (cheap) instead of
   timing out late (expensive).
5. **Circuit breakers** on api → profile so a failing dependency gets fast-failed instead of hammered.
6. Alert on the **amplification ratio** (downstream rps / user rps) and on **goodput**, not just throughput.
7. Game days: inject a 60 s DB outage and verify the system recovers on its own.

## Grading rubric (10 pts)
| pts | criterion |
|----|-----------|
| 2 | Distinguishes trigger (DB failover) from sustaining cause (retry feedback loop / metastability) |
| 2 | Quantifies amplification (~2.5× client × ~3.8× api ≈ 10×) with metrics |
| 1 | Explains wasted work: completions for timed-out callers (goodput ≪ throughput, queue latency ≫ timeout) |
| 1 | Explains why scaling 8→12 didn't help |
| 1 | Explains why disabling retries + load shedding fixed it |
| 1 | Rules out DB as sustaining cause with evidence (DB healthy after 03:25:45) |
| 2 | ≥3 solid prevention mechanisms (retry budget/backoff+jitter, deadlines, shedding/bounded queues, circuit breaker) |
