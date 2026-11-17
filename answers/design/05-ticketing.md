# Rubric: Concert ticketing with no overselling (SPOILERS)

## Strong answer covers
- Inventory is the strongly consistent core. Use `UPDATE seats SET status='held', hold_until=now()+10m, holder=$u WHERE id=$s AND (status='free' OR hold_until<now())`, which is an atomic conditional update (compare-and-set). Or SELECT ... FOR UPDATE. Avoid read-then-write (lost update / write skew, `lab.html#isolation`).
- Partition inventory by show (one show fits on one DB primary). 50k rows is small. The problem is contention + traffic, not data size.
- **Virtual waiting room / queue**: admit users at a controlled rate (token-based admission). This turns a thundering herd into a steady stream, with fairness by queue position. Serve the seat map from cache/CDN (eventually consistent, slightly stale is fine). Only the hold operation hits the DB.
- Hold expiry: lazy (`hold_until < now()` in the condition) + a background sweeper. No timers per seat.
- Payments: idempotency keys. Order state machine (held → paying → confirmed / released). Transactional outbox. If payment succeeds and confirm fails, retry the confirm idempotently. The hold must not expire during an in-flight payment (extend it), else refund.
- Bot/abuse protection and per-user limits.

## Scoring (10 pts)
- 2 pts: Atomic conditional update / correct concurrency control
- 2 pts: Hold-with-expiry design
- 2 pts: Admission control / waiting room for spike
- 2 pts: Idempotent payment + order state machine
- 1 pts: Consistency boundaries identified
- 1 pts: Abuse & fairness

Push back in follow-ups on any number given without a derivation.
