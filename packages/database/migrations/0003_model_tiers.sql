-- Tiered model catalogue: friendly public names mapped to upstream model ids.
--
-- The models table already separates `public_name` (what a customer types) from
-- `upstream_model` (what the provider is asked for), so a tier is a data row
-- rather than a code change. Public names are the five effort tiers; the tier a
-- customer picks is the entire model surface they need to know about.
--
-- Every upstream id below was verified to exist in the provider's /v1/models
-- listing at the time this migration was written. A name that does not exist
-- upstream is a 404 from the provider, not a silently wrong answer.

INSERT INTO providers (name, enabled)
VALUES ('opencode', true)
ON CONFLICT (name) DO NOTHING;

INSERT INTO models (public_name, provider_id, upstream_model, enabled)
SELECT
  t.public_name,
  p.id,
  t.upstream_model,
  true
FROM (VALUES
  ('max',     'gpt-6-astra'),
  ('xhigh',   'gpt-5.6-sol'),
  ('high',    'gpt-5.6-terra'),
  ('medium',  'claude-opus-4-8'),
  ('low',     'claude-sonnet-4-6')
) AS t(public_name, upstream_model)
CROSS JOIN providers p
WHERE p.name = 'opencode'
ON CONFLICT (public_name) DO UPDATE
  SET upstream_model = EXCLUDED.upstream_model,
      enabled = true,
      updated_at = now();

-- The old free model is retired rather than left enabled. Existing customers
-- who pinned it keep their row so historical usage still resolves, but it is
-- no longer advertised to anyone calling /v1/models.
UPDATE models SET enabled = false, updated_at = now() WHERE public_name = 'space-bunny-free';
