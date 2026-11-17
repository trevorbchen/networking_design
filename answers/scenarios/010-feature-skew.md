# Answer key: 010-feature-skew (SPOILERS)

## Root cause
**Training-serving skew from a unit change.** At 19:25 feature-svc switched the source of the user watch-stats features
from the nightly Spark job (`avg_watch_s`, **seconds**) to the new Flink streaming job `watch-stats-rt`. That job aggregates
`player.heartbeat.position_ms` and writes **milliseconds** into the same feature name. Ranker v41 was trained on seconds.
It now sees returning users with "average watch time" of 8,000–140,000, i.e. hours to days, far outside its training range [0, 7200].

The model doesn't crash. It extrapolates: it thinks everyone is a binge-watcher, so it pushes **long-form content**
(long_form_share 18% → ~34%) with **inflated confidence** (pred CTR 8.8% → 13.5%, calibration 1.0 → 2.2) while users click
less. The bad values spread gradually as Redis entries expire (**TTL 30 min**), so CTR declines as a **30-minute ramp** starting
at 19:25, not as a step.

**New users are unaffected** (no history → feature default 0, CTR flat ~7.1%). That segment split rules out anything
global (model, thumbnails, CDN, serving infra) and points at per-user history features.

## Key evidence
- `feed:ctr_returning_users` 8.9 → 5.8% while `feed:ctr_new_users` stays ~7.1%.
- `ranker:calibration` rises from 1.0 to 2.2. `pred_ctr_mean` goes **up** while observed CTR goes down: the model is fed out-of-distribution inputs.
- `features/user_avg_watch_s:psi` goes from ~0.03 to > 9 (anything > 0.25 is a major shift), and `online_mean` 37 → ~37,000 (≈1000×: a units bug). All
  other features are stable except `item_duration_min` (a *consequence*: the model now recommends longer items).
- `ranker:out_of_range_inputs` ramps from 0 starting at 19:25.
- Logs: ranker `input validation: feature user_avg_watch_s=47112.0 outside training range [0.0, 7200.0] (not clipped)`. flink
  `schema avg_watch_duration: long (source: player.heartbeat.position_ms aggregate)`. Spark: `avg_watch_s p50=38.1 ... (seconds)`.
  feature-svc: `source switch ... Keys refresh as cache entries expire (TTL 1800s)`.
- Traces: affected requests have `source: flink:watch-stats-rt`, `user_avg_watch_s` in the 10⁴–10⁵ range, and top items of 70–180 min.

## Red herrings
- **thumb-v3 experiment (19:15)**: control and treatment CTR move together, so the experiment isn't causing it. It started 10 min before the decline.
- **CDN eu-west (19:36–19:43)**: playback start errors, a different funnel step (plays, not clicks), short and regional. The CTR decline continues after it resolves.
- **Model v41**: in production since yesterday with good metrics. `model_version` unchanged. The model is fine. Its *inputs* changed.
- Latency/errors/GPU: all normal. This is a correctness/quality failure, invisible to RED metrics.

## Mitigation (now)
- **Roll back the feature source** to the Spark features (or hotfix the Flink job to divide by 1000), then **flush/invalidate the
  affected cache keys** rather than waiting 30 min for TTL.
- Optionally, as a stopgap: **clip** the input to the training range in the ranker, or fall back to the default value for out-of-range inputs.

## Durable fixes
- **Feature contracts**: typed schemas with units (`avg_watch_s: float, unit=s, range=[0, 7200]`). Validate at write (pipeline)
  and read (serving). Block or alert on violations instead of only logging.
- **Train/serve parity**: one feature definition shared by offline and online paths (feature store with a single transformation),
  and backfill-and-compare (shadow the new pipeline and diff against the old one before switching).
- **Model monitoring alerts**: PSI/drift per feature, calibration (pred/obs), prediction distribution, and segment-level business KPIs,
  not just latency/errors. These would have fired by ~19:30.
- Treat feature-source changes like model deploys: canary to a % of users with automatic rollback on KPI/calibration regressions.

## Real-world commands (how you'd confirm this in production)
- Feature-store sample: `SELECT user_id, avg_watch_s FROM online_features ORDER BY updated_at DESC LIMIT 20` vs the same users in the offline table.
- Drift dashboard (Evidently/Arize/WhyLabs): PSI per feature. Calibration plot (predicted vs observed CTR by bucket).
- Diff the Flink job schema against the training feature spec. Look for a unit field (ms vs s).
- `redis-cli --scan --pattern 'uf:*' | head | xargs -n1 redis-cli hget ... avg_watch_s` to see the bad values live.

## Grading rubric (10 pts)
| pts | criterion |
|----|-----------|
| 2 | Identifies training-serving skew: user_avg_watch_s switched to ms from the Flink pipeline (19:25), model trained on seconds |
| 2 | Proves it with feature monitoring (PSI / online_mean ~1000×) and/or validation logs / trace feature values |
| 1 | Uses segments: returning users affected, new users not (no history → default) |
| 1 | Notes calibration breaking (pred CTR up while observed CTR down) / long-form shift as the model's response to OOD input |
| 1 | Explains the gradual ramp (cache TTL 30 min) |
| 1 | Rules out thumbnail experiment (both arms equal), CDN (different funnel, timing), v41 model itself |
| 1 | Mitigation: revert source / fix units + invalidate cache (or clip inputs) |
| 1 | Prevention: feature schemas with units/ranges enforced, train/serve parity, drift + calibration alerting, canary feature changes |
