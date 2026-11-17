# Distributed rate limiter

_difficulty: medium_

Design a rate-limiting service used by an API gateway fleet (200 gateway nodes) to enforce per-API-key limits like "1000 req/min, bursts of 100".

**Scale:** 2M requests/s total across all gateways, 5M API keys, limits must be roughly accurate (±5%), and the limiter must add < 1 ms p99.

## Address in your answer
1. Which algorithm (token bucket, leaky bucket, fixed window, sliding window log/counter) and why?
2. Where does the state live? Centralized (Redis) vs. local vs. hybrid?
3. How do you stay < 1 ms with 200 nodes?
4. What happens when the limiter's store is down? (fail open vs. closed)
5. How do you handle a single very hot key?

## How to submit
Write your design (bullets plus an ASCII diagram is fine) and paste it to Claude with `grade design 02-rate-limiter`. Claude may ask follow-up questions like an interviewer.
