import { z } from 'zod';
import { CHAT_ROLES } from '@synzo/types';
import type { ValidationLimits } from './limits.js';

/**
 * Only `model`, `messages`, `stream` and `max_tokens` are forwarded upstream.
 *
 * `temperature`, `top_p`, `stop`, `presence_penalty`, `frequency_penalty` and
 * `user` are accepted at the edge (so OpenAI SDK clients don't break) but
 * STRIPPED before the upstream call. Verified against opencode.ai: they return
 * 200 but produce no observable change in output. §12 requires we not claim
 * support for parameters the upstream does not actually support.
 */
export const FORWARDED_CHAT_FIELDS = ['model', 'messages', 'stream', 'max_tokens'] as const;

export const STRIPPED_CHAT_FIELDS = [
  'temperature',
  'top_p',
  'stop',
  'presence_penalty',
  'frequency_penalty',
  'user',
] as const;

export function buildChatRequestSchema(limits: ValidationLimits) {
  const messageSchema = z
    .object({
      role: z.enum(CHAT_ROLES, {
        errorMap: () => ({ message: 'role must be one of: system, user, assistant, tool' }),
      }),
      content: z.string(),
      name: z.string().max(256).optional(),
      tool_call_id: z.string().max(256).optional(),
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
    })
    .passthrough()
    .superRefine((val, ctx) => {
      for (const [i, m] of val.messages.entries()) {
        if (m.content.length > limits.maxMessageChars) {
          ctx.addIssue({
            code: z.ZodIssueCode.too_big,
            path: ['messages', i, 'content'],
            maximum: limits.maxMessageChars,
            type: 'string',
            message: `messages[${i}].content exceeds ${limits.maxMessageChars} characters`,
          });
        }
      }
    });
}

export type ChatRequestInput = z.input<ReturnType<typeof buildChatRequestSchema>>;
export type ChatRequest = z.output<ReturnType<typeof buildChatRequestSchema>>;
