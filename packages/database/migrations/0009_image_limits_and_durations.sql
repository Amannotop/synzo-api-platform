-- Per-tier image caps, and plans that expire.
--
-- 0007 gave every package a boolean "includes image support". That answers the
-- wrong question now that the tiers differ by how much they include: 3 images,
-- 20 images, unlimited. A boolean cannot separate those, so it is replaced by a
-- limit.
--
-- ----
-- 1. `image_limit`, and the three states it has to carry
--
--     0    -> no image input at all
--     n    -> at most n images per request
--     NULL -> unlimited
--
-- NULL is genuinely different from a large number, so it is kept rather than
-- collapsed into one: it is the only encoding that means "no plan-level cap".
-- The same three states appear on the granted side, on
-- `customer_limits.max_images`.
--
-- `image_support` is dropped rather than left alongside. Two columns that both
-- answer "can this customer send an image" is one too many, and a row where they
-- disagree has no defined meaning.
--
-- 2. Durations, and why the grant is no longer a pure union
--
-- 0007 made purchases additive: buying a cheaper tier never narrows access. That
-- is right for access that does not expire. These tiers do expire, so an
-- unbounded union is no longer sufficient — a tier bought in March must not
-- still be granting `max` in June.
--
-- `duration_days` on the package is the term. `plan_expires_at` on the customer
-- is when the paid grant lapses; NULL means it never does, which is what a trial
-- and any admin-set row get.
--
-- 3. `base_*`: what the customer falls back to on expiry
--
-- Reverting to "the entry tier" has to be exact and must not cost a query on
-- the request path, so the base grant is stored alongside the active one. The
-- entry package is derived from package data, which the operator can edit, and
-- so is a poor thing to re-derive per request.
--
-- On expiry the API serves the base values and keeps the paid ones on disk, so
-- a renewal restores access without re-purchasing.
--
-- ----
-- Expiry is evaluated at request time rather than by a sweep. A 7-day tier swept
-- daily would keep working for up to a day past what the customer paid for, and
-- the only row the hot path already reads is this one.

ALTER TABLE credit_packages
  ADD COLUMN IF NOT EXISTS image_limit integer,
  ADD COLUMN IF NOT EXISTS duration_days integer;

ALTER TABLE customer_limits
  ADD COLUMN IF NOT EXISTS max_images integer,
  ADD COLUMN IF NOT EXISTS base_allowed_models text,
  ADD COLUMN IF NOT EXISTS base_max_images integer,
  ADD COLUMN IF NOT EXISTS plan_expires_at timestamp with time zone;

-- Seed the new columns from what 0007 recorded, so nothing that was already
-- granted changes meaning during the upgrade. image_support true becomes
-- "unlimited" (NULL) rather than a number, because that is what it actually
-- promised: yes, images, with no number attached to it.
UPDATE credit_packages
   SET image_limit = CASE WHEN image_support THEN NULL ELSE 0 END
 WHERE image_limit IS NULL AND image_support = false;

UPDATE customer_limits
   SET max_images = CASE WHEN image_support THEN NULL ELSE 0 END
 WHERE max_images IS NULL;

-- The base grant is the access the customer holds independently of any purchase.
-- Before this migration that was simply the current value, which is right: the
-- additive union in 0007 means a paid grant is a superset of the base.
UPDATE customer_limits
   SET base_allowed_models = allowed_models
 WHERE base_allowed_models IS NULL;

UPDATE customer_limits
   SET base_max_images = max_images
 WHERE base_max_images IS NULL;

ALTER TABLE credit_packages DROP COLUMN IF EXISTS image_support;
ALTER TABLE customer_limits DROP COLUMN IF EXISTS image_support;

-- A duration is only meaningful as a positive number of days. NULL means the
-- package never expires, which an operator may genuinely want for a
-- non-expiring purchase.
ALTER TABLE credit_packages
  ADD CONSTRAINT credit_packages_duration_positive
    CHECK (duration_days IS NULL OR duration_days > 0) NOT VALID;

ALTER TABLE credit_packages
  VALIDATE CONSTRAINT credit_packages_duration_positive;
