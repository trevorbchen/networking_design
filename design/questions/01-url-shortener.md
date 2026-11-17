# URL shortener (warm-up)

_difficulty: easy_

Design a service like bit.ly: `POST /shorten {url} → short code`, `GET /{code} → 301 redirect`.

**Scale:** 100M new URLs/month, 10B redirects/month, links live 5 years, custom aliases optional, basic click analytics.

## Address in your answer
1. How do you generate short codes? (counter + base62 vs. hash vs. random; collisions; predictability)
2. Estimate QPS (avg and peak) and storage over 5 years.
3. Pick a datastore and justify it from the access pattern.
4. How do redirects stay < 10 ms p99 globally?
5. How do you count clicks without slowing redirects?

## How to submit
Write your design (bullets plus an ASCII diagram is fine) and paste it to Claude with `grade design 01-url-shortener`. Claude may ask follow-up questions like an interviewer.
