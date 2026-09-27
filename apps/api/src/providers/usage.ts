import type { NormalizedUsage } from './provider.interface.js';

/**
 * Usage is recorded exactly as the upstream reports it (§18/§19/§20).
 * Missing fields stay null. Nothing is invented or back-filled.
 */
export const EMPTY_USAGE: NormalizedUsage = Object.freeze({
  promptTokens: null,
  completionTokens: null,
  totalTokens: null,
  upstreamCost: null,
  currency: null,
});

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    // Upstream returns cost as the STRING "0" — verified against opencode.ai.
    const parsed = Number(value);
    if (value.trim() !== '' && Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function nonNegativeInt(value: unknown): number | null {
  const n = asFiniteNumber(value);
  return n === null ? null : Math.max(0, Math.round(n));
}

/**
 * Extracts usage + cost from a non-streaming response body.
 * Every field is independently nullable: a partial upstream response yields a
 * partial record rather than a fabricated one.
 */
export function parseUsage(body: unknown): NormalizedUsage {
  if (!body || typeof body !== 'object') return { ...EMPTY_USAGE };
  const obj = body as Record<string, unknown>;

  const rawUsage = obj.usage;
  const usage = rawUsage && typeof rawUsage === 'object' ? (rawUsage as Record<string, unknown>) : {};

  const promptTokens = nonNegativeInt(usage.prompt_tokens);
  const completionTokens = nonNegativeInt(usage.completion_tokens);
  let totalTokens = nonNegativeInt(usage.total_tokens);

  // Only derive the sum when upstream gave us both parts and no total.
  // We never invent a total from nothing.
  if (totalTokens === null && promptTokens !== null && completionTokens !== null) {
    totalTokens = promptTokens + completionTokens;
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    upstreamCost: asFiniteNumber(obj.cost),
    currency: typeof obj.currency === 'string' ? obj.currency : null,
  };
}

/**
 * Streaming usage arrives in a dedicated final chunk whose `choices` array is
 * empty and whose `usage` is populated. Cost arrives in a separate frame.
 * Each is applied only if the other is genuinely absent.
 */
export class StreamingUsageCollector {
  private usage: NormalizedUsage = { ...EMPTY_USAGE };
  private sawDone = false;

  /** Call for every parsed SSE frame. */
  observe(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const obj = payload as Record<string, unknown>;

    const cost = asFiniteNumber(obj.cost);
    if (cost !== null) {
      this.usage.upstreamCost = cost;
      const cur = typeof obj.currency === 'string' ? obj.currency : null;
      if (cur) this.usage.currency = cur;
    }

    const rawUsage = obj.usage;
    if (rawUsage && typeof rawUsage === 'object') {
      const u = rawUsage as Record<string, unknown>;
      const p = nonNegativeInt(u.prompt_tokens);
      const c = nonNegativeInt(u.completion_tokens);
      const t = nonNegativeInt(u.total_tokens);
      if (p !== null) this.usage.promptTokens = p;
      if (c !== null) this.usage.completionTokens = c;
      if (t !== null) this.usage.totalTokens = t;
      else if (p !== null && c !== null) this.usage.totalTokens = p + c;
    }
  }

  markDone(): void {
    this.sawDone = true;
  }

  get sawDoneFrame(): boolean {
    return this.sawDone;
  }

  result(): NormalizedUsage {
    return { ...this.usage };
  }
}
