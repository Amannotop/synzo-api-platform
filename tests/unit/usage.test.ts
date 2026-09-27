import { describe, expect, it } from 'vitest';
import { EMPTY_USAGE, StreamingUsageCollector, parseUsage } from '../../apps/api/src/providers/usage.js';

describe('parseUsage (spec 18, 19, 20)', () => {
  it('returns every field null for a body with no usage at all', () => {
    expect(parseUsage({})).toEqual(EMPTY_USAGE);
  });

  it('returns every field null for a non-object body', () => {
    for (const bad of [null, undefined, 'text', 42, true]) {
      expect(parseUsage(bad)).toEqual(EMPTY_USAGE);
    }
  });

  it('reads a complete OpenAI-shaped usage block', () => {
    const usage = parseUsage({
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    });
    expect(usage.promptTokens).toBe(11);
    expect(usage.completionTokens).toBe(7);
    expect(usage.totalTokens).toBe(18);
  });

  it('derives a total only when both parts are present', () => {
    expect(parseUsage({ usage: { prompt_tokens: 4, completion_tokens: 6 } }).totalTokens).toBe(10);
    // Only prompt is known: a total would be a fabrication, so it stays null.
    expect(parseUsage({ usage: { prompt_tokens: 4 } }).totalTokens).toBeNull();
    expect(parseUsage({ usage: { completion_tokens: 6 } }).totalTokens).toBeNull();
  });

  it('prefers an upstream total over the derived sum', () => {
    const usage = parseUsage({ usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 999 } });
    expect(usage.totalTokens).toBe(999);
  });

  it('parses cost from a numeric 0', () => {
    expect(parseUsage({ cost: 0 }).upstreamCost).toBe(0);
  });

  it('parses cost from the string "0" that OpenCode actually returns', () => {
    // Verified against opencode.ai: cost arrives as a STRING, not a number.
    const usage = parseUsage({ cost: '0' });
    expect(usage.upstreamCost).toBe(0);
    expect(typeof usage.upstreamCost).toBe('number');
  });

  it('parses a decimal cost string', () => {
    expect(parseUsage({ cost: '0.00125' }).upstreamCost).toBe(0.00125);
  });

  it('leaves cost null rather than inventing a zero', () => {
    expect(parseUsage({ cost: null }).upstreamCost).toBeNull();
    expect(parseUsage({ cost: '' }).upstreamCost).toBeNull();
    expect(parseUsage({ cost: 'free' }).upstreamCost).toBeNull();
    expect(parseUsage({ cost: Number.NaN }).upstreamCost).toBeNull();
    expect(parseUsage({ cost: Infinity }).upstreamCost).toBeNull();
  });

  it('rejects a non-numeric cost object', () => {
    expect(parseUsage({ cost: { amount: 1 } }).upstreamCost).toBeNull();
  });

  it('reads currency only when it is a string', () => {
    expect(parseUsage({ currency: 'USD' }).currency).toBe('USD');
    expect(parseUsage({ currency: 42 }).currency).toBeNull();
    expect(parseUsage({ currency: 'USD' }).upstreamCost).toBeNull();
  });

  it('rounds fractional token counts and clamps negatives to zero', () => {
    const usage = parseUsage({
      usage: { prompt_tokens: 10.6, completion_tokens: -5, total_tokens: 5.5 },
    });
    expect(usage.promptTokens).toBe(11);
    expect(usage.completionTokens).toBe(0);
    expect(usage.totalTokens).toBe(6);
  });

  it('coerces numeric strings, which some upstreams send', () => {
    const usage = parseUsage({ usage: { prompt_tokens: '12', completion_tokens: '3' } });
    expect(usage.promptTokens).toBe(12);
    expect(usage.completionTokens).toBe(3);
  });

  it('ignores a non-object usage field', () => {
    expect(parseUsage({ usage: 'lots' })).toEqual(EMPTY_USAGE);
  });
});

describe('StreamingUsageCollector (spec 15, 20)', () => {
  it('starts empty and never invents a total', () => {
    expect(new StreamingUsageCollector().result()).toEqual(EMPTY_USAGE);
  });

  it('collects usage from the final chunk', () => {
    const c = new StreamingUsageCollector();
    c.observe({ choices: [] });
    c.observe({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 4 } });
    const r = c.result();
    expect(r.promptTokens).toBe(9);
    expect(r.completionTokens).toBe(4);
    expect(r.totalTokens).toBe(13);
  });

  it('collects cost from a frame that carries no usage', () => {
    const c = new StreamingUsageCollector();
    c.observe({ usage: { prompt_tokens: 1, completion_tokens: 1 } });
    c.observe({ choices: [], cost: '0' });
    const r = c.result();
    expect(r.upstreamCost).toBe(0);
    expect(r.promptTokens).toBe(1);
  });

  it('lets a later frame refine an earlier partial value', () => {
    const c = new StreamingUsageCollector();
    c.observe({ usage: { prompt_tokens: 5 } });
    c.observe({ usage: { prompt_tokens: 5, completion_tokens: 8, total_tokens: 13 } });
    const r = c.result();
    expect(r.completionTokens).toBe(8);
    expect(r.totalTokens).toBe(13);
  });

  it('does not let a frame with no usage erase what it already knows', () => {
    const c = new StreamingUsageCollector();
    c.observe({ usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } });
    c.observe({ choices: [{ delta: { content: 'hi' } }] });
    expect(c.result().totalTokens).toBe(10);
  });

  it('ignores non-object frames', () => {
    const c = new StreamingUsageCollector();
    c.observe(null);
    c.observe('data');
    c.observe(7);
    expect(c.result()).toEqual(EMPTY_USAGE);
  });

  it('records currency alongside cost', () => {
    const c = new StreamingUsageCollector();
    c.observe({ cost: '1.5', currency: 'USD' });
    expect(c.result()).toMatchObject({ upstreamCost: 1.5, currency: 'USD' });
  });

  it('tracks whether a [DONE] terminator was seen', () => {
    const c = new StreamingUsageCollector();
    expect(c.sawDoneFrame).toBe(false);
    c.markDone();
    expect(c.sawDoneFrame).toBe(true);
  });

  it('returns a copy, so callers cannot mutate internal state', () => {
    const c = new StreamingUsageCollector();
    c.observe({ cost: 2 });
    const first = c.result();
    first.upstreamCost = 999;
    expect(c.result().upstreamCost).toBe(2);
  });
});
