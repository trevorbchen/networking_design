# News feed / timeline

_difficulty: medium_

Design the home timeline for a social network: users follow others, and the home feed shows recent posts from followees, newest first (ranking optional).

**Scale:** 300M DAU, each opens the feed 10×/day, 500M posts/day, average 200 followees, some celebrities have 50M followers.

## Address in your answer
1. Fan-out on write (push) vs. fan-out on read (pull)? Hybrid?
2. Data model and storage for posts, follow graph, and timelines.
3. Estimate feed read QPS and fan-out write volume.
4. How do you handle celebrities?
5. How do you keep p99 feed latency < 200 ms?

## How to submit
Write your design (bullets plus an ASCII diagram is fine) and paste it to Claude with `grade design 03-news-feed`. Claude may ask follow-up questions like an interviewer.
