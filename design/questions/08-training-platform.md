# Large-scale training platform (and keeping 4,096 GPUs busy)

_difficulty: hard · ML systems_

Your company will pretrain a 70B-parameter LLM on 15T tokens using **4,096 H100s** (512 nodes × 8, 8×400 Gb/s InfiniBand per node).
Leadership asks: how long will it take, what will break, and how do we keep "goodput" (useful training time) above 90%?

## Address in your answer
1. **Back-of-envelope:** total FLOPs (6·N·D), expected MFU, wall-clock days. What's the cost of 1% lower MFU?
2. **Parallelism:** how you split the model (data / tensor / pipeline / FSDP-ZeRO / sequence parallelism), what goes over NVLink vs InfiniBand, and why. Memory per GPU.
3. **Failures:** at this scale, what's the expected rate of GPU/node/link failures? Checkpointing strategy (frequency, async, where to), restart time, hot spares. Compute the optimal checkpoint interval.
4. **Stragglers and silent degradation:** how do you detect one slow GPU or link among 4,096 (scenarios 007 and 009)? Silent data corruption?
5. **Data pipeline:** tokenized shards, deterministic resumption, mixture changes mid-run.
6. **Observability:** what you graph per step / per rank / per node, and what pages a human.

Useful Lab widgets: `lab.html#training`, `#roofline`.

## How to submit
Paste your design to Claude with `grade design 08-training-platform`.
