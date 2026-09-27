import type { ChatMessage } from '@synzo/types';

export interface ChatRequestPayload {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  max_tokens?: number;
}

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
