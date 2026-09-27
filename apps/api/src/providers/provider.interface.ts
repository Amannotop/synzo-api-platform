import type { ChatMessage, ToolCall } from '@synzo/types';

/**
 * One tool the customer has offered the model, in OpenAI's wire format.
 *
 * Kept structurally loose on the parameters: a JSON Schema object is the norm
 * but rejecting anything else would break SDK clients that add vendor keys
 * (`strict`, `$schema`, ...). The edge validates the shape we depend on —
 * `type: "function"` and a function name — and the rest is the customer's.
 */
export interface ChatTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** How the model must pick a tool: nothing, its own judgement, or a named one. */
export type ToolChoice =
  | 'none'
  | 'auto'
  | 'required'
  | { type: 'function'; function: { name: string } };

export interface ChatRequestPayload {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  max_tokens?: number;
  /**
   * Forwarded verbatim. Agent clients send their whole toolset on every
   * request; dropping it made the model claim it had no tools while the call
   * still returned 200, so the failure looked like a model limitation rather
   * than a silently dropped field.
   */
  tools?: ChatTool[];
  tool_choice?: ToolChoice;
}

export type { ToolCall };

export interface NormalizedUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  /**
   * Upstream cost exactly as reported. OpenCode returns the STRING "0" here,
   * verified empirically, so parsing must accept string | number | null.
   * Stored verbatim-as-number and never converted into a customer price (§19).
   */
  upstreamCost: number | null;
  currency: string | null;
}

export interface ProviderCompletion {
  /** Raw upstream body, passed through with minimal reshaping (§18). */
  body: Record<string, unknown>;
  usage: NormalizedUsage;
  latencyMs: number;
}

export interface UpstreamError {
  httpStatus: number;
  /** Normalized, client-safe message. */
  message: string;
  code: string;
  type: string;
  retryable: boolean;
}

export interface ProviderHealth {
  healthy: boolean;
  latencyMs: number | null;
  checkedAt: string;
  detail?: string;
}

/**
 * A health result attributed to the provider that produced it.
 *
 * `ProviderHealth` on its own says nothing about which provider it describes,
 * so the monitor pairs the two. The name is a label, not a routing decision, and
 * the set of providers is small and fixed.
 */
export interface ProviderHealthEntry extends ProviderHealth {
  provider: string;
}

/**
 * The contract every upstream must satisfy. Adding OpenAI or Anthropic later
 * means implementing this interface and registering it — no changes to routing,
 * auth, rate limiting or usage recording (§11, §39).
 */
export interface AIProvider {
  readonly name: string;
  chat(payload: ChatRequestPayload, signal: AbortSignal): Promise<ProviderCompletion>;
  streamChat(
    payload: ChatRequestPayload,
    signal: AbortSignal,
  ): AsyncGenerator<string, NormalizedUsage | null, void>;
  healthCheck(signal: AbortSignal): Promise<ProviderHealth>;
}
