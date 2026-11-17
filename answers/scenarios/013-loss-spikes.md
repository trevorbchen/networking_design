# Answer key: 013-loss-spikes (SPOILERS)

## Root cause
At 14:15 the data mixture v8 added a new source, **crawl-2026-10** (5% of tokens). Its build **skipped the quality-filter
stage** (missing `filters` key in the source config). Shards **crawl-2026-10-08810..08863** contain junk: base64 blobs,
minified code, megabytes of repeated strings. The dataloader streams shards sequentially, so when one of those shards comes up,
~40 s of batches contain 4–16% garbage tokens. Loss on those tokens is huge, gradients spike (grad norm 7–34, clipped to 1.0),
and each spike damages the weights a little (residual loss elevation, rising update RMS). The 6th bad shard (14:48:55) causes
an attention-logit overflow → **NaN** and the guard halts the run.

**Data, not hardware:** spikes follow the *batch*. They reproduce exactly when replayed on a different node (event at 14:41),
spike in **all nodes' local grad norms at once**, coincide with shard IDs 088xx, and show only in `loss_by_source/crawl-2026-10`.

## Key evidence
- First spike at 14:21:50, 7 min after the mixture change (14:15). None in the 9 days before.
- `loss_by_source/crawl-2026-10` jumps by ~9 during spikes. Other sources barely move.
- `data:garbage_token_frac`, `max_repeat_ngram_frac` up and `batch_entropy` down, exactly during spikes.
- rank0 logs: spiking steps list `crawl-2026-10-088xx` shards. `dq-sampler: ... 97% non-alphabetic, longest repeated substring 31,402 chars`.
  `data-pipeline: build crawl-2026-10: quality_filter stage SKIPPED`.
- Replay on spare node-99 reproduced the loss (4.12 vs 4.13). `cluster/*:local_grad_norm` spikes on **every** node simultaneously.

## Red herrings
- **fp8**: enabled 3 days ago with no spikes. The spikes have a data signature. (fp8 can lower the threshold for overflow, so you can
  mention it as an amplifier, but it isn't the cause.)
- **node-7 ECC**: corrected single-bit errors at a steady rate for 6 days. SDC would hit *one* node's gradients and not reproduce elsewhere.
- **Learning rate**: constant 2.4e-4 for days (stable WSD phase). Halving it would make spikes smaller but not remove the cause.

## Restart plan
- Restart from **checkpoint step 61000 (14:00)**, before the first spike, or from 62125 (14:30) only if you accept the
  accumulated damage (residual loss is elevated; safest is 61000, which loses ~50 min).
- Remove crawl-2026-10 from the mixture (or blocklist shards 08810–08863 and run the quality filter on the whole source before re-adding it).
- Verify: replay the spiking steps' batches from the cleaned mixture and confirm no spike.

## Guards for the future
- **Data**: quality filters mandatory in the pipeline (fail the build if skipped). Per-source stats at build time (entropy,
  non-alpha ratio, repetition). Canary a new source at low weight with per-source loss monitoring.
- **Training**: per-source loss dashboards. A **spike detector** that skips the batch (or rolls back N steps and skips the shard) when
  loss or grad norm > k × EMA. Log batch/shard IDs per step (already done, which made this debuggable). Optionally z-loss / QK-norm
  for logit stability.
- Keep more frequent and longer-retained checkpoints so you can roll back to before damage.

## Real-world commands (how you'd confirm this in production)
- Re-run the exact batch: load checkpoint 62125, seek the dataloader to step 62497, run forward/backward on a different node and compare loss (deterministic data → reproduces).
- Decode the offending sample: `tokenizer.decode(batch['input_ids'][i])` for the highest-loss sequences, or per-sequence loss sorted descending.
- `zcat shard-08817.jsonl.gz | head -c 2000`, and quick stats (non-alpha ratio, max repeated substring) over the source.
- W&B/TensorBoard: plot per-source loss and grad norm, then zoom to the spike steps.

## Grading rubric (10 pts)
| pts | criterion |
|----|-----------|
| 2 | Root cause: new crawl-2026-10 source with unfiltered junk shards (quality filter skipped) |
| 2 | Evidence: per-source loss, garbage/entropy metrics, shard IDs in spiking steps, dq-sampler / pipeline logs |
| 2 | Distinguishes data from hardware SDC (replay reproduced, all nodes spike together, ECC steady) |
| 1 | Rules out fp8 and LR (with timing/reasoning) |
| 1 | Explains cumulative damage (residual loss) and the NaN as the final spike |
| 1 | Restart plan: checkpoint before the first spike (61000), remove/blocklist/filter the source |
| 1 | Guards: mandatory filters + per-source monitoring + automatic spike skip/rollback |
