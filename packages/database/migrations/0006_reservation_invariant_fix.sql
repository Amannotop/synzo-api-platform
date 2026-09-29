-- Correct the reservation invariant introduced by 0005.
--
-- ----
-- What 0005 asserted, and why it was wrong:
--
--     free_used + free_remaining + free_reserved <= free_granted
--
-- That treats a reservation as if it had already LEFT the remaining pool. It
-- has not. A reservation is an earmark: it is tokens that are still counted as
-- remaining, but which the customer cannot spend because a request in flight
-- has claimed them. `CreditRepository.reserve` raises `free_reserved` and
-- leaves `free_remaining` alone, and `settle` then lowers `free_remaining` by
-- the amount actually charged while lowering `free_reserved` by the full amount
-- held.
--
-- The consequence of getting this backwards is not subtle. The first
-- reservation against a fresh account violated it:
--
--     free_granted = 500000   (the free trial, granted at approval)
--     free_used    =      0
--     free_remaining = 500000
--     free_reserved  =  32000  (the worst-case claim for one request)
--
--     0 + 500000 + 32000 = 532000 > 500000   -> CHECK violation -> HTTP 500
--
-- So every single API call failed for every approved customer, and the failure
-- looked like a server fault rather than a schema mistake. The account held
-- half a million tokens and could not spend any of them.
--
-- ----
-- The correct invariant:
--
--     reserved <= remaining
--
-- A reservation may only earmark tokens that are still in the remaining pool.
-- It can never claim tokens that were already spent, and it can never claim
-- more than the pool holds. That is precisely the property that makes
-- concurrent reservations safe: the second writer's WHERE clause cannot match
-- once the first has claimed the tokens, so its transaction rolls back rather
-- than double-spending the balance.
--
-- The `granted` arithmetic is already covered, and correctly, by the two
-- constraints 0004 put on this table:
--
--     free_used + free_remaining <= free_granted
--
-- which is a conservation law ("you cannot spend more than you were given"),
-- and which reservations do not affect, because a reservation moves no token
-- between the columns. This migration therefore restores the database to
-- exactly that invariant plus the new one, with no double counting.
--
-- ----
-- The existing rows are not merely valid under the new constraint, they are
-- also trivially so: every account has free_reserved = 0 and paid_reserved = 0,
-- because the broken constraint meant no reservation was ever successfully
-- recorded. VALIDATE therefore succeeds without touching a single row.

ALTER TABLE credit_balances
  DROP CONSTRAINT IF EXISTS credit_balances_reservation_consistent;

-- ADD ... NOT VALID first, then VALIDATE: taking the lock without a scan, and
-- scanning without the lock. On a large table this is the difference between a
-- brief ACCESS EXCLUSIVE lock and a long one that blocks writes.
ALTER TABLE credit_balances
  ADD CONSTRAINT credit_balances_reservation_consistent
    CHECK (
      free_reserved <= free_remaining
      AND paid_reserved <= paid_remaining
    ) NOT VALID;

ALTER TABLE credit_balances
  VALIDATE CONSTRAINT credit_balances_reservation_consistent;
