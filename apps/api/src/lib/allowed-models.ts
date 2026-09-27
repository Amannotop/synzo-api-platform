/**
 * Single source of truth for the per-customer model allowlist (§50).
 *
 * The value is stored as a JSON array string in `customer_limits.allowed_models`
 * and travels as `string[] | null` on the wire. The two states are distinct and
 * mean different things:
 *
 *   null → every enabled model is allowed
 *   []   → no model is allowed (an intentional lockout)
 *   [a]  → exactly the listed models are allowed
 *
 * Three separate call sites (model listing, dashboard listing, and chat
 * resolution) previously parsed this independently and disagreed about `[]`,
 * so an admin who saved an empty allowlist saw "all models" in the dashboard
 * while chat requests were rejected. One parser, one meaning.
 *
 * A stored value that is not a JSON array is treated as corrupt rather than as
 * "all models": failing closed keeps an unexpected write from silently
 * granting access, and the admin's own save path always writes a well-formed
 * value.
 */
export function parseAllowedModels(raw: string | null | undefined): string[] | null {
  if (raw === null || raw === undefined || raw.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(String);
  } catch {
    return [];
  }
}

/**
 * Applies an allowlist to a set of models.
 *
 * `null` passes everything through; an array is an exact-membership filter, so
 * an empty array correctly yields no models.
 */
export function filterByAllowedModels<T>(
  items: T[],
  allowed: string[] | null,
  nameOf: (item: T) => string,
): T[] {
  if (allowed === null) return items;
  return items.filter((item) => allowed.includes(nameOf(item)));
}
