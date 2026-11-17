# Answer key — 005-stale-reads (SPOILERS)

## Root cause
At 09:20 the scheduled analytics report `weekly_cohort_retention` started a ~29-minute query on
**pg-replica-2**. The replicas run with `max_standby_streaming_delay = -1`, so when WAL replay
conflicts with a running query (e.g. vacuum cleanup of rows the query's snapshot still needs), Postgres **pauses replay
indefinitely** instead of cancelling the query. Replica-2 kept *receiving* WAL (receive lag ≈ 0) but stopped
*applying* it. **Replay lag grew linearly at 1 s/s**, up to ~29 minutes.

pg-read (pgbouncer) round-robins reads across both replicas with no lag awareness, so ~50% of reads went
to a replica serving data up to 29 minutes old. A user writes to the primary, then reads from replica-2 and sees
the old value: a **read-your-writes violation**. That's intermittent because the next read may land on replica-1.
It stopped at 09:48:50 when the report finished and replay caught up in ~2 min.

No latency/error alerts fired because stale reads are **fast and successful**. This is a correctness failure,
invisible to RED metrics.

## Key evidence
- `pg-replica/replica-2:replay_lag_s` is a **linear ramp** from 09:20 to 09:48:50 (slope 1 s/s means replay is fully stopped). replica-1 stays at ~0.3 s.
- `receive_lag_b` ≈ 0 on both: the primary and network are fine, and the stall is in replay.
- `replica-2:longest_query_s` ramps with the same slope from the same instant. replica-2 CPU and disk IOPS are up (the report).
- Logs on replica-2: `recovery is waiting: WAL replay blocked by conflicting query pid=48121 (bi_reader)`, plus the 28-min `duration:` log line at the end.
- Cron events: report started 09:20 / finished 09:48:50, which bracket the lag exactly.
- `client:version_regressions` and support tickets follow the lag. api logs: `version regression ... db=replica-2`.
- Traces: the stale GETs all have `db.host=replica-2` with a large `replica_lag_s` tag.

## Red herrings
- **profile-api v5.2.0 deploy (09:15)**: 5 min before onset, and only a 1-min latency blip. PATCH vs PUT doesn't change
  where reads go. Regressions are tied to replica-2, not to pods/versions.
- **CDN rule change (09:25)**: API responses are `no-store`, and the change only affects static assets and /blog.
  The hit ratio going up is expected. The timing (09:25) doesn't match onset (09:20+), and the stale reads trace to the DB host.
- pg-primary CPU/connections are normal.

## Mitigation (now)
- **Remove replica-2 from the pg-read pool** (or route all profile reads to the primary/replica-1).
- Cancel the report query (`pg_cancel_backend(48121)`) so replay resumes. Rerun it on a dedicated analytics replica.

## Durable fixes
- **Separate analytics replica** (or a warehouse fed by CDC). Never share OLTP read replicas with long BI queries.
- Set `max_standby_streaming_delay` to a bounded value (e.g. 30 s) on OLTP replicas, and/or use
  `hot_standby_feedback` (with its bloat trade-off) on the analytics replica only.
- **Lag-aware routing**: health-check replicas on replay lag and eject them past N seconds.
- **Read-your-writes guarantees**: read from the primary for a short window after a user's write (sticky by
  user/session), or pass the commit LSN in a token and only read from replicas that have replayed ≥ that LSN
  (`pg_last_wal_replay_lsn()`), or use synchronous replication with `remote_apply` for critical paths.
- Alerts: **replica replay lag > 30 s**, **longest query on OLTP replicas > N min**, and the client
  version-regression telemetry as an SLI for correctness.

## Grading rubric (10 pts)
| pts | criterion |
|----|-----------|
| 2 | Identifies replica-2 replay lag as the source of stale reads (not CDN, not the deploy) |
| 2 | Explains *why* the lag: long analytics query + `max_standby_streaming_delay=-1` pausing replay (linear ramp, receive lag ~0) |
| 1 | Explains intermittency (round-robin across a fresh and a stale replica) |
| 1 | Explains why no latency/error alert fired (correctness failure, fast and successful responses) |
| 1 | Rules out the CDN change and the deploy with evidence |
| 1 | Immediate mitigation (eject replica-2 / cancel query) |
| 2 | Durable: separate analytics replica + lag-aware routing + a read-your-writes mechanism + lag alert |
