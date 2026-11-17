# Concert ticketing with no overselling

_difficulty: hard_

Design ticket sales for big concerts: 50k seats per show, seats are specific (section/row/seat), and sale opens at 10:00 with 2M users waiting.

**Requirements:** never oversell, hold a seat for 10 min during checkout, fair-ish ordering, stay up under the 10:00 spike.

## Address in your answer
1. How do you prevent overselling? Which isolation/locking approach?
2. Seat holds with expiry: data model and mechanics.
3. Surviving the 10:00 spike (2M users in seconds).
4. Payments: what happens if payment succeeds but your confirm write fails?
5. Which parts can be eventually consistent and which can't?

## How to submit
Write your design (bullets plus an ASCII diagram is fine) and paste it to Claude with `grade design 05-ticketing`. Claude may ask follow-up questions like an interviewer.
