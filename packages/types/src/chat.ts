/**
 * OpenAI-compatible chat types.
 *
 * These mirror the wire shape the platform accepts from customers and emits
 * back. They are intentionally permissive about unknown upstream fields —
 * §18 says to preserve useful upstream fields rather than reshape them.
 */

export const CHAT_ROLES = ['system', 'user', 'assistant', 'tool'] as const;
export type ChatRole = (typeof CHAT_ROLES)[number];

/**
 * A tool call the model asked us to make.
 *
 * `arguments` is a JSON-encoded string, not an object, because that is the
 * wire format OpenAI clients emit and parse. Decoding it is the caller's job.
 */
export interface ToolCall {
  index?: number;
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/**
 * One piece of a multi-part message.
 *
 * OpenAI clients send `content` as a bare string for text-only turns and as an
 * array of these when an image is attached. Both forms stay valid: the
 * union keeps a text-only client byte-for-byte unchanged, and only a client
 * that actually sends an image pays for the extra shape.
 */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | {
      type: 'image_url';
      image_url: {
        /**
         * A `data:` URL or an `https://` URL. Plain `http` is refused for a
         * remote image for the same reason a payment QR over http is: a URL
         * swapped in transit sends the model something else entirely.
         */
        url: string;
        /** Client hint forwarded to the provider. */
        detail?: 'auto' | 'low' | 'high';
      };
    };

export interface ChatMessage {
  role: ChatRole;
  /**
   * Empty for an assistant turn that only requests tool calls. OpenAI clients
   * send `content: null` there, so the type admits null for round-tripping.
   *
   * An array of parts is only ever produced by a request that carried an
   * image, and is normalised back to a plain string whenever it did not.
   */
  content: string | ChatContentPart[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

/**
 * How many images a request carries, across the whole conversation.
 *
 * Counted over every message rather than the last turn, because a client
 * replaying history would otherwise get a fresh budget each turn and smuggle an
 * unbounded number of images into one billed request. Matches how the request
 * schema counts them, so the number a customer is told they exceeded is the same
 * one that was counted against their plan.
 */
export function countImageParts(messages: readonly ChatMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content) if (part.type === 'image_url') n += 1;
  }
  return n;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  presence_penalty?: number;
  frequency_penalty?: number;
  user?: string;
}

export interface ChatCompletionUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

export interface ChatCompletionChoice {
  index: number;
  message?: {
    role: string;
    /**
     * Null when the turn only requests tool calls, which is how OpenAI
     * represents it and what agent clients expect back.
     */
    content: string | null;
    name?: string;
    reasoning_content?: string;
    tool_calls?: ToolCall[];
  };
  /** Streaming deltas carry a partial tool call rather than a whole message. */
  delta?: {
    role?: string;
    content?: string | null;
    reasoning_content?: string;
    tool_calls?: Array<Partial<ToolCall> & { index: number }>;
  };
  finish_reason?: string | null;
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion' | string;
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: ChatCompletionUsage | null;
  /** Upstream reports this as a STRING (e.g. "0"), not a number. Verified. */
  cost?: string | number;
  [key: string]: unknown;
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk' | string;
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: ChatCompletionUsage | null;
  [key: string]: unknown;
}

export interface ModelListResponse {
  object: 'list';
  data: Array<{ id: string; object: 'model'; created?: number; owned_by?: string }>;
}
