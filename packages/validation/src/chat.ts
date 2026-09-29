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

  /**
   * The image types accepted anywhere in the platform. Deliberately the same
   * three `lib/upload.ts` verifies by magic bytes for payment images: SVG is
   * excluded because it is the one image format that can carry script.
   */
  const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

  /**
   * A data: URL's payload is base64, which inflates by 4/3. The cap is derived
   * from the real byte limit so the two cannot drift: a string long enough to
   * exceed the decoded limit is rejected before anything allocates it.
   */
  const maxImageUrlChars = Math.ceil((limits.maxImageBytes * 4) / 3) + 1024;

  /**
   * Decoded size of a base64 data: URL, computed arithithmetically.
   *
   * The alternative is decoding the payload to measure it, which allocates a
   * buffer the size of the attacker's input inside a schema that runs on every
   * request. Every 4 base64 characters carry 3 bytes, and '=' is padding, so the
   * size is known without touching the bytes. It is an upper bound on the
   * decoded length, which is the direction that matters for a limit.
   */
  function decodedImageBytes(url: string): number | null {
    const comma = url.indexOf(',');
    if (comma === -1) return null;
    const payload = url.slice(comma + 1);
    const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
    const bytes = Math.floor((payload.length * 3) / 4) - padding;
    return Number.isFinite(bytes) && bytes >= 0 ? bytes : null;
  }

  const imageUrlSchema = z
    .object({
      url: z
        .string()
        .min(1)
        .max(maxImageUrlChars, `image_url.url exceeds the ${limits.maxImageBytes} byte image limit`),
      detail: z.enum(['auto', 'low', 'high']).optional(),
    })
    .passthrough()
    .superRefine((val, ctx) => {
      const { url } = val;

      if (url.startsWith('data:')) {
        const header = url.slice(5, url.indexOf(',') === -1 ? undefined : url.indexOf(','));
        const mime = header.split(';')[0]?.trim().toLowerCase() ?? '';
        if (!(ALLOWED_IMAGE_TYPES as readonly string[]).includes(mime)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['url'],
            message: `image_url.url must be a data: URL of ${ALLOWED_IMAGE_TYPES.join(', ')}`,
          });
          return;
        }
        if (!header.toLowerCase().includes('base64')) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['url'],
            message: 'image_url.url data: URLs must be base64 encoded',
          });
          return;
        }
        const bytes = decodedImageBytes(url);
        if (bytes === null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['url'],
            message: 'image_url.url is not a well-formed data: URL',
          });
          return;
        }
        if (bytes > limits.maxImageBytes) {
          ctx.addIssue({
            code: z.ZodIssueCode.too_big,
            path: ['url'],
            maximum: limits.maxImageBytes,
            inclusive: true,
            type: 'number',
            message: `image_url.url decodes to ${bytes} bytes, over the ${limits.maxImageBytes} byte limit`,
          });
        }
        return;
      }

      /**
       * A remote image is only ever fetched over https. Plain http is refused
       * for the same reason a payment QR over http is: the URL can be swapped in
       * transit, so the model is shown something the customer never chose. Any
       * other scheme (file:, ftp:, data-without-base64 already handled above) is
       * rejected outright rather than repaired.
       */
      if (!/^https:\/\//i.test(url)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['url'],
          message: 'image_url.url must be an https URL or a base64 data: URL',
        });
      }
    });

  const contentPartSchema = z.union([
    z.object({ type: z.literal('text'), text: z.string() }).passthrough(),
    z.object({ type: z.literal('image_url'), image_url: imageUrlSchema }).passthrough(),
  ]);

  const messageSchema = z
    .object({
      role: z.enum(CHAT_ROLES, {
        errorMap: () => ({ message: 'role must be one of: system, user, assistant, tool' }),
      }),
      /**
       * A bare string is what every text-only client sends and is left exactly
       * as it arrived. The array form is only reachable by a client that
       * actually attached an image.
       */
      content: z.union([z.string(), z.array(contentPartSchema)]).nullable(),
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
      let imageCount = 0;

      for (const [i, m] of val.messages.entries()) {
        // Null content is legal on an assistant turn that only requests tool
        // calls, so there is no length to check.
        if (typeof m.content === 'string') {
          if (m.content.length > limits.maxMessageChars) {
            ctx.addIssue({
              code: z.ZodIssueCode.too_big,
              path: ['messages', i, 'content'],
              maximum: limits.maxMessageChars,
              inclusive: true,
              type: 'string',
              message: `messages[${i}].content exceeds ${limits.maxMessageChars} characters`,
            });
          }
          continue;
        }

        if (!Array.isArray(m.content)) continue;

        for (const [j, part] of m.content.entries()) {
          if (part.type === 'image_url') {
            imageCount += 1;
            continue;
          }
          // Only the text of a text part is length-capped. An image part's size
          // is bounded by the decoded-byte check on its url above, and a cap on
          // the whole array's length would reject a request for the wrong reason.
          if (part.text.length > limits.maxMessageChars) {
            ctx.addIssue({
              code: z.ZodIssueCode.too_big,
              path: ['messages', i, 'content', j, 'text'],
              maximum: limits.maxMessageChars,
              inclusive: true,
              type: 'string',
              message: `messages[${i}].content[${j}].text exceeds ${limits.maxMessageChars} characters`,
            });
          }
        }
      }

      /**
       * Counted across the whole conversation, not per message: a client
       * replaying history would otherwise get a fresh budget on every turn and
       * smuggle an unbounded number of images into one billed request.
       */
      if (imageCount > limits.maxImagesPerRequest) {
        ctx.addIssue({
          code: z.ZodIssueCode.too_big,
          path: ['messages'],
          maximum: limits.maxImagesPerRequest,
          inclusive: true,
          type: 'number',
          message:
            limits.maxImagesPerRequest === 0
              ? 'Image input is not enabled on this platform'
              : `a request may contain at most ${limits.maxImagesPerRequest} images`,
        });
      }
    });
}

export type ChatRequestInput = z.input<ReturnType<typeof buildChatRequestSchema>>;
export type ChatRequest = z.output<ReturnType<typeof buildChatRequestSchema>>;
