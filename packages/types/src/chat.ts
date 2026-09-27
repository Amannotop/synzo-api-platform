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

export interface ChatMessage {
  role: ChatRole;
  /**
   * Empty for an assistant turn that only requests tool calls. OpenAI clients
   * send `content: null` there, so the type admits null for round-tripping.
   */
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
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
