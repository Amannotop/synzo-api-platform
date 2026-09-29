import { describe, expect, it } from 'vitest';
import { filterByAllowedModels, parseAllowedModels, unionAllowedModels } from '../../apps/api/src/lib/allowed-models.js';

/**
 * The allowlist is the per-customer model gate, so the three states it can be
 * in are worth pinning separately: `null` is every model, `[]` is none, and an
 * array is exactly what it says. A parser that confuses any two of those either
 * locks a paying customer out or hands a locked-out customer the platform.
 */
describe('parseAllowedModels', () => {
  it('treats an absent or empty value as every model', () => {
    expect(parseAllowedModels(null)).toBeNull();
    expect(parseAllowedModels(undefined)).toBeNull();
    expect(parseAllowedModels('')).toBeNull();
    expect(parseAllowedModels('   ')).toBeNull();
  });

  it('keeps an empty array distinct from "all"', () => {
    // The bug this guards: an admin who saved an empty allowlist saw "all
    // models" in the dashboard while every chat request was rejected.
    expect(parseAllowedModels('[]')).toEqual([]);
  });

  it('parses a list, coercing entries to strings', () => {
    expect(parseAllowedModels('["low","max"]')).toEqual(['low', 'max']);
  });

  it('fails closed on a value that is not a JSON array', () => {
    expect(parseAllowedModels('"max"')).toEqual([]);
    expect(parseAllowedModels('{')).toEqual([]);
    expect(parseAllowedModels('not json at all')).toEqual([]);
  });
});

/**
 * A purchase only ever adds access. Overwriting instead would mean a customer
 * who bought the top tier and later bought the cheapest one was silently
 * downgraded to two models, with nothing recorded.
 */
describe('unionAllowedModels', () => {
  const merged = (a: string | null, b: string | null) => {
    const out = unionAllowedModels(a, b);
    return out === null ? null : (JSON.parse(out) as string[]);
  };

  it('keeps "all" absorbing: anything plus all is all', () => {
    expect(merged(null, '["low"]')).toBeNull();
    expect(merged('["low"]', null)).toBeNull();
    expect(merged(null, null)).toBeNull();
  });

  it('unions two explicit lists without duplicating', () => {
    expect(merged('["low"]', '["low","max"]')).toEqual(['low', 'max']);
  });

  it('promotes a locked-out customer who buys their first package', () => {
    expect(merged('[]', '["low","high"]')).toEqual(['high', 'low']);
  });

  it('leaves a deliberate lockout intact when the package grants nothing', () => {
    expect(merged('[]', '[]')).toEqual([]);
  });

  it('is stable, so an unchanged union does not churn the stored value', () => {
    // Same set, different order: the value written must be identical or every
    // purchase would rewrite the row and touch updatedAt for no reason.
    expect(unionAllowedModels('["max","low"]', '["low","max"]')).toBe(
      unionAllowedModels('["low","max"]', '["max","low"]'),
    );
  });

  it('unions a corrupt stored value as nothing, so it fails closed', () => {
    // Current is unreadable. Treating it as "everything" would be a silent
    // grant; treating it as nothing only costs the new package's models.
    expect(merged('not json', '["low"]')).toEqual(['low']);
  });
});

describe('filterByAllowedModels', () => {
  const items = [{ n: 'low' }, { n: 'max' }];
  const nameOf = (i: { n: string }) => i.n;

  it('passes everything through for an all-model customer', () => {
    expect(filterByAllowedModels(items, null, nameOf)).toHaveLength(2);
  });

  it('filters to exact membership', () => {
    expect(filterByAllowedModels(items, ['low'], nameOf)).toEqual([{ n: 'low' }]);
  });

  it('yields nothing for a deliberate lockout', () => {
    expect(filterByAllowedModels(items, [], nameOf)).toEqual([]);
  });
});
