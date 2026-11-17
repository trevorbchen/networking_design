# Answer key — 001-checkout-pool (SPOILERS)

## Root cause
**checkout v4.12.0** (11:50) added "loyalty points per line item". It is implemented as an
**N+1 query**: one `SELECT ... FROM loyalty_rules WHERE sku = $1` per cart item. That takes queries per checkout from
**3 → ~9**. Each query is still fast, but the checkout code holds its DB connection for the
whole transaction, including the inventory HTTP call. The extra queries raise the **connection hold time**
(~48 ms → ~70 ms at normal load, ~100 ms at peak as the DB gets busier).

Pool demand follows Little's law: `connections in use ≈ arrival rate × hold time`. At normal traffic, the
new hold time used ~55% of the 20-connection pool (before: ~37%). When lunch traffic ramped
+44% (12:00–12:10), demand passed the pool's capacity. **HikariCP pools pinned at 20/20**,
threads queued for connections (`db_pool_pending`), acquire wait rose to the **3000 ms timeout**, and requests
failed with `SQLTransientConnectionException`. The gateway's 5 s timeout produced 504s.

**The bottleneck is the client-side connection pool, not the database.**

## Proof the DB is not overloaded
- `orders-db:cpu` peaks around 70–75% (busier, but not saturated). `query_latency_p99` is ~7 → 14 ms.
- `orders-db:connections` is flat at ~150 of 500. The DB isn't refusing connections.
- In traces, DB spans are a few ms each. The dominant self-time is `hikari.getConnection` (waiting).
- A bigger DB instance would barely help, because queue wait is on the app side.

## Why GET /cart is fine
It's served from redis by a different service and never touches the checkout pool.

## Key evidence
- `checkout/*:db_pool_active` flat-topped at 20 from ~12:05. `db_pool_pending` and `db_pool_wait_ms` climb with it.
- `checkout:db_queries_per_request` steps from 3 → ~9 exactly at the 11:50 deploy.
- Traces → Breakdown: `orders-db · SELECT loyalty_rules` shows ~6 calls/trace after the deploy and 0 before.
  `hikari.getConnection` has the largest share of self time in the incident window.
- Logs: `HikariPool-1 - Connection is not available, request timed out after 3000ms`,
  `Pool stats (total=20, active=20, idle=0, waiting=…)`, startup log `loyalty-line-items=ON`.
- The deploy came 15+ min **before** symptoms. The trigger was the daily traffic peak. The deploy cut the headroom.

## Red herrings
- **Payments/PSP latency blip (12:12–12:14)**: short, after the alert fired, and it doesn't hold a DB
  connection (the charge happens after commit). It doesn't explain sustained pool saturation.
- **orders-db CPU rising**: it's a consequence of 3× queries, but not saturated.
- **search flag change at 12:15** and **autovacuum at 12:19**: unrelated, and both after onset.
- **checkout CPU** is up slightly. The threads are mostly waiting, not computing.

## Mitigation (minutes)
1. **Disable the `loyalty-line-items` feature flag** (or roll back to 4.11.3). This removes the N+1 queries.
2. Scale out checkout pods. Each pod adds a 20-connection pool and DB connections have headroom (150/500),
   so this buys capacity. Watch DB CPU, though: more concurrency on a hot DB can make it worse.
3. Possibly raise `maximumPoolSize` moderately. This has the same caveat, and it doesn't address hold time.

## Durable fixes
- Batch the lookup: `WHERE sku = ANY($1)`, a join, or cache loyalty rules (they rarely change).
- Don't hold a DB transaction/connection across remote calls (inventory). Shrink transaction scope.
- Load-test / canary at **peak** traffic. Track queries-per-request as a regression metric in CI/canary.
- Alerts: **pool utilization > 80% for 5m**, **connection acquire wait p99 > 50ms**, and
  saturation alerts based on USE, not just latency.
- Capacity math in the design review: `pods × pool ≥ peak_rps × hold_time × safety factor`.

## Grading rubric (10 pts)
| pts | criterion |
|----|-----------|
| 3 | Identifies the app-side DB connection pool as the saturated resource (pool 20/20, waits, timeouts) |
| 2 | Connects it to the v4.12.0 N+1 query (queries/request 3→9 or loyalty spans in traces) |
| 1 | Explains the trigger: daily lunch peak + reduced headroom (Little's law / hold time) |
| 1 | Correctly argues the DB is NOT the bottleneck, with numbers |
| 1 | Dismisses payments blip and/or other red herrings with reasoning |
| 1 | Mitigation: flag off / rollback (scaling is a partial credit addition) |
| 1 | Durable fix: batch query or cache + no connection held across remote calls + saturation alert |
