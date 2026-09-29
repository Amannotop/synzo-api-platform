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
 * Combines a customer's current access with a package's, keeping the union.
 *
 * A purchase only ever ADDS access, so this has to be a union rather than an
 * overwrite in all three states:
 *
 *   null + null            = null  (all)
 *   null + [a, b]          = null  (already everything, stays everything)
 *   [a, b] + null          = null  (the new package grants everything)
 *   [a, b] + [b, c]        = [a, b, c]
 *
 * Overwriting instead would mean a customer who bought the top tier and later
 * bought the cheapest one was silently downgraded to two models, with nothing
 * recorded and no way for them to tell that is what happened.
 *
 * The current value is read through `parseAllowedModels`, so a corrupt stored
 * value unions as "nothing" and therefore fails closed.
 */
export function unionAllowedModels(
  current: string | null | undefined,
  incoming: string | null | undefined,
): string | null {
  const a = parseAllowedModels(current);
  const b = parseAllowedModels(incoming);
  if (a === null || b === null) return null;
  // The column holds a JSON array STRING, not an array, so the union is
  // re-encoded on the way out. Order is not meaningful for membership, but
  // sorting keeps the stored value stable so an unchanged union does not churn
  // the row's bytes and its updatedAt on every purchase.
  return JSON.stringify([...new Set([...a, ...b])].sort());
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
