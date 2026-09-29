-- Model-access tiers: sell access to models instead of a bag of tokens.
--
-- The packages already existed and already worked; what they sold was a token
-- count. The product decision is that what a customer buys is *which models
-- they can call*, and the token balance becomes a background abuse guard
-- rather than the headline. So the package gains the entitlement it actually
-- grants, and approving a customer or a payment applies it.
--
-- ----
-- 1. `credit_packages.allowed_models`
--
-- Deliberately an explicit list of public model names rather than a count like
-- "the two cheapest tiers". A count would have to be re-evaluated against the
-- catalogue every time an operator enabled, disabled or renamed a model, so
-- the meaning of a package already sold to someone could change underneath
-- them. A stored list is what was actually promised, and it is auditable.
--
-- NULL means every model, and is the same value that
-- `customer_limits.allowed_models` already uses for that meaning. Reusing the
-- one existing convention means `parseAllowedModels` reads both without a
-- second interpretation: null = all, [] = none, [a, b] = exactly those.
--
-- 2. `credit_packages.image_support`
--
-- A separate boolean rather than a model name, because image input is a
-- capability of a request rather than of a model. Two customers with the same
-- model list can differ in whether they may attach an image, and folding that
-- into the list would make the list mean two things at once.
--
-- 3. `customer_limits.image_support`
--
-- The granted half of the same entitlement, on the row the API path already
-- reads for `allowed_models`. It lives here rather than on `users` because it
-- is a per-customer limit like the rest of that row, and because this is the
-- row `apiKeyAuth` already loads, so enforcement needs no extra query.
--
-- ----
-- Defaults are the conservative ones, so an existing row keeps exactly the
-- access it has today: a NULL allowlist and image support off. Nobody gains
-- access to anything by this migration, and the operator opts each existing
-- package in deliberately.

ALTER TABLE credit_packages
  ADD COLUMN IF NOT EXISTS allowed_models text,
  ADD COLUMN IF NOT EXISTS image_support boolean NOT NULL DEFAULT false;

ALTER TABLE customer_limits
  ADD COLUMN IF NOT EXISTS image_support boolean NOT NULL DEFAULT false;

-- No balance data changes. The trial grant still lands in the ledger exactly as
-- 0004 defined it, because the token count is now the abuse guard rather than
-- the product, and zeroing it would void a promise already made to customers
-- who have been approved.
--
-- No constraint is added either. The invariant worth stating is "an approved
-- account has a balance", and that is a workflow fact enforced by the approve
-- transaction in 0004 rather than a table-level one.
