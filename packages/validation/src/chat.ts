import { z } from 'zod';
import { CHAT_ROLES } from '@synzo/types';
import type { ValidationLimits } from './limits.js';

/**
 * `model`, `messages`, `stream`, `max_tokens`, `tools` and `tool_choice` are
 * forwarded upstream.
 *
 * `temperature`, `top_p`, `stop`, `presence_penalty`, `frequency_penalty` and
 * `user` are accepted at the edge (so OpenAI SDK clients don't break) but
 * STRIPPED before the upstream call. Verified against opencode.ai: they return
 * 200 but produce no observable change in output. §12 requires we not claim
 * support for parameters the upstream does not actually support.
 *
 * `tools` was added after the platform silently dropped it. An agent client
 * sends its tools on every request; because the field was stripped rather than
 * rejected, the request still returned 200 and the model simply had no tools,
 * so the agent had nothing to call and said so in prose instead. Verified
 * upstream returns finish_reason "tool_calls".
 */
export const FORWARDED_CHAT_FIELDS = [
  'model',
  'messages',
  'stream',
  'max_tokens',
  'tools',
  'tool_choice',
] as const;

export const STRIPPED_CHAT_FIELDS = [
  'temperature',
  'top_p',
  'stop',
  'presence_penalty',
  'frequency_penalty',
  'user',
] as const;

export function buildChatRequestSchema(limits: ValidationLimits) {
  const toolCallSchema = z
    .object({
      index: z.number().int().optional(),
      id: z.string().max(256),
      type: z.literal('function'),
      function: z.object({
        name: z.string().min(1).max(256),
        // A JSON-encoded string on the wire, so it is passed through without
        // being parsed here: a model can emit invalid JSON, and rejecting the
        // whole turn over that would lose an otherwise usable response.
        arguments: z.string().max(limits.maxMessageChars),
      }),
    })
    .passthrough();

  const messageSchema = z
    .object({
      role: z.enum(CHAT_ROLES, {
        errorMap: () => ({ message: 'role must be one of: system, user, assistant, tool' }),
      }),
      content: z.string().nullable(),
      name: z.string().max(256).optional(),
      tool_call_id: z.string().max(256).optional(),
      // Uncapped for the same reason as `tools`: a client replaying history
      // echoes every tool call the model ever made, so this grows with the
      // conversation rather than with one request. MAX_REQUEST_BODY_BYTES is
      // the real bound.
      tool_calls: z.array(toolCallSchema).optional(),
    })
    .passthrough();

  return z
    .object({
      model: z.string().min(1, 'model is required').max(200),
      messages: z
        .array(messageSchema)
        .min(1, 'messages must not be empty')
        .max(limits.maxMessages, `messages must contain at most ${limits.maxMessages} items`),
      stream: z.boolean().optional(),
      max_tokens: z.coerce
        .number()
        .int()
        .min(1, 'max_tokens must be at least 1')
        .max(limits.maxContentTokensHardCap)
        .optional(),
      temperature: z.number().min(0).max(2).optional(),
      top_p: z.number().min(0).max(1).optional(),
      stop: z.union([z.string().max(200), z.array(z.string().max(200)).max(4)]).optional(),
      presence_penalty: z.number().min(-2).max(2).optional(),
      frequency_penalty: z.number().min(-2).max(2).optional(),
      user: z.string().max(256).optional(),
      tools: z
        .array(
          z
            .object({
              type: z.literal('function'),
              /**
               * passthrough() on BOTH levels is load-bearing. Zod strips unknown
               * keys from a plain object, so a nested `function` without this
               * would silently delete `strict` and any other vendor extension
               * an SDK client sends — a tool whose definition quietly differs
               * from the one the caller registered.
               */
              function: z
                .object({
                  name: z.string().min(1).max(256),
                  /**
                   * Uncapped, and the reasoning is the same as for the tool
                   * count: a tighter, invented limit on top of
                   * MAX_REQUEST_BODY_BYTES only rejects requests that were
                   * already well within it. Real agent clients ship long tool
                   * descriptions — the file-reading and shell tools an IDE
                   * registers routinely run past 4,000 characters, and
                   * rejecting one of those takes down the whole session with a
                   * message that names a field the caller never set.
                   *
                   * `parameters` is where the real cost of a tool lives, and it
                   * is passed through with no inspection at all, so a
                   * description cap bought no meaningful protection.
                   */
                  description: z.string().optional(),
                  parameters: z.record(z.unknown()).optional(),
                })
                .passthrough(),
            })
            .passthrough(),
        )
        // No count cap. An earlier 128 limit was a guess, and it rejected
        // real agent clients: 140 ordinary tool definitions is only ~30KB,
        // while MAX_REQUEST_BODY_BYTES already admits 1MB. The body limit is
        // enforced by Fastify before this schema runs, so it is the actual
        // resource bound, and a second, tighter, made-up one on top only
        // rejected requests that were well within it.
        .optional(),
      tool_choice: z
        .union([
          z.enum(['none', 'auto', 'required']),
          z.object({ type: z.literal('function'), function: z.object({ name: z.string().min(1) }) }),
        ])
        .optional(),
    })
    .passthrough()
    .superRefine((val, ctx) => {
      for (const [i, m] of val.messages.entries()) {
        // Null content is legal on an assistant turn that only requests tool
        // calls, so there is no length to check.
        if (m.content !== null && m.content.length > limits.maxMessageChars) {
          ctx.addIssue({
            code: z.ZodIssueCode.too_big,
            path: ['messages', i, 'content'],
            maximum: limits.maxMessageChars,
            inclusive: true,
            type: 'string',
            message: `messages[${i}].content exceeds ${limits.maxMessageChars} characters`,
          });
        }
      }
    });
}

export type ChatRequestInput = z.input<ReturnType<typeof buildChatRequestSchema>>;
export type ChatRequest = z.output<ReturnType<typeof buildChatRequestSchema>>;
