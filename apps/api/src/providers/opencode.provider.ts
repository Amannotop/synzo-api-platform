import type { AppConfig } from '@synzo/config';
import type {
  AIProvider,
  ChatRequestPayload,
  NormalizedUsage,
  ProviderCompletion,
  ProviderHealth,
} from './provider.interface.js';
import { StreamingUsageCollector, parseUsage } from './usage.js';

/**
 * OpenCode Zen provider.
 *
 * Verified behaviour against https://opencode.ai/zen/v1 (live probes):
 *  - Success body is OpenAI-compatible, with `cost` as the STRING "0".
 *  - Streaming emits SSE; usage lands in a final chunk, then `data: [DONE]`,
 *    then a trailing `data: {"choices":[],"cost":"0"}` AFTER [DONE].
 *  - Sending ANY Authorization header — even a bogus one — yields 401.
 *    So the header is omitted entirely unless UPSTREAM_API_KEY is set.
 *  - An unsupported model returns 401 with a ModelError body, which we must
 *    translate into a 404 invalid_model for the customer, not a 401.
 */
export class OpenCodeProvider implements AIProvider {
  readonly name = 'opencode';

  constructor(private readonly config: AppConfig) {}

  /**
   * Headers are built explicitly. Customer headers are never forwarded (§17):
   * no Authorization, Cookie, Host, Connection or Content-Length passthrough.
   */
  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    // Omitted when unset — required, since a bogus header causes an upstream 401.
    if (this.config.upstream.apiKey) {
      headers.Authorization = `Bearer ${this.config.upstream.apiKey}`;
    }
    return headers;
  }

  private endpoint(path: string): string {
    return `${this.config.upstream.baseUrl}${path}`;
  }

  /** Combines the caller's signal with our own timeout. */
  private withTimeout(signal: AbortSignal, timeoutMs: number): { signal: AbortSignal; done: () => void } {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('upstream_timeout')), timeoutMs);
    const onAbort = () => controller.abort(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    return {
      signal: controller.signal,
      done: () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      },
    };
  }

  /**
   * Only the parameters verified to work upstream are sent. temperature, top_p,
   * stop, presence_penalty, frequency_penalty and user are accepted at the edge
   * for SDK compatibility but deliberately dropped here (§12).
   */
  private toUpstreamBody(payload: ChatRequestPayload): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: payload.model,
      messages: payload.messages,
      stream: payload.stream,
    };
    if (payload.max_tokens !== undefined) body.max_tokens = payload.max_tokens;
    return body;
  }

  async chat(payload: ChatRequestPayload, signal: AbortSignal): Promise<ProviderCompletion> {
    const started = Date.now();
    const { signal: combined, done } = this.withTimeout(
      signal,
      this.config.upstream.requestTimeoutMs,
    );
    try {
      const res = await fetch(this.endpoint(this.config.upstream.chatPath), {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(this.toUpstreamBody({ ...payload, stream: false })),
        signal: combined,
      });

      if (!res.ok) {
        throw await this.toUpstreamError(res);
      }
      const body = (await res.json()) as Record<string, unknown>;
      return { body, usage: parseUsage(body), latencyMs: Date.now() - started };
    } finally {
      done();
    }
  }

  /**
   * Streams SSE frames one at a time with no buffering (§15).
   *
   * The trailing post-[DONE] cost frame is consumed internally for accounting
   * and NOT yielded, so the client always sees a clean stream that terminates
   * at `data: [DONE]` (§55).
   */
  async *streamChat(
    payload: ChatRequestPayload,
    signal: AbortSignal,
  ): AsyncGenerator<string, NormalizedUsage | null, void> {
    const { signal: combined, done } = this.withTimeout(
      signal,
      this.config.upstream.streamTimeoutMs,
    );
    const collector = new StreamingUsageCollector();
    let sawDoneFrame = false;

    try {
      const res = await fetch(this.endpoint(this.config.upstream.chatPath), {
        method: 'POST',
        headers: { ...this.buildHeaders(), Accept: 'text/event-stream' },
        body: JSON.stringify(this.toUpstreamBody({ ...payload, stream: true })),
        signal: combined,
      });

      if (!res.ok || !res.body) {
        throw await this.toUpstreamError(res);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        for (;;) {
          const { done: streamDone, value } = await reader.read();
          if (streamDone) break;

          buffer += decoder.decode(value, { stream: true });

          // SSE events are separated by a blank line.
          let sepIdx: number;
          while ((sepIdx = buffer.indexOf('\n\n')) !== -1) {
            const rawEvent = buffer.slice(0, sepIdx);
            buffer = buffer.slice(sepIdx + 2);

            const dataLines = rawEvent
              .split('\n')
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).trimStart());

            if (dataLines.length === 0) continue;
            const data = dataLines.join('\n');

            if (data === '[DONE]') {
              sawDoneFrame = true;
              collector.markDone();
              yield `data: [DONE]\n\n`;
              // Do NOT return here. Upstream sends the cost frame *after*
              // [DONE]; we keep reading to capture it for accounting, but
              // suppress every subsequent frame so the client's stream still
              // terminates cleanly at [DONE].
              continue;
            }

            try {
              collector.observe(JSON.parse(data));
            } catch {
              // A non-JSON frame is not fatal.
            }
            // Suppress anything the client has already been told is the end.
            if (!sawDoneFrame) {
              yield `data: ${data}\n\n`;
            }
          }
        }
      } finally {
        // Client disconnect or timeout aborts the upstream fetch rather than
        // letting it keep streaming into a dead socket (§16).
        reader.cancel().catch(() => {});
        reader.releaseLock();
      }

      // Stream ended without [DONE] (upstream disconnect).
      if (!sawDoneFrame) {
        // Upstream ended without a terminator; synthesize one so the client
        // still sees a well-formed stream.
        collector.markDone();
        yield 'data: [DONE]\n\n';
      }
      return collector.result();
    } finally {
      done();
    }
  }

  /**
   * Translates a non-2xx upstream response into a client-safe error.
   *
   * OpenCode returns 401 for an unknown model with a ModelError body. That must
   * surface to the customer as a 404 invalid_model, otherwise a model typo
   * looks like an auth failure.
   */
  private async toUpstreamError(res: Response): Promise<Error & { httpStatus: number; code: string; type: string }> {
    let message = 'The upstream provider returned an error';
    let code = 'upstream_error';
    let type = 'upstream_error';
    let retryable = res.status >= 500 || res.status === 429;

    try {
      const body = (await res.json()) as Record<string, unknown>;
      const errObj =
        body && typeof body.error === 'object' ? (body.error as Record<string, unknown>) : undefined;
      const upstreamMsg =
        (errObj && typeof errObj.message === 'string' && errObj.message) ||
        (typeof body.message === 'string' ? body.message : '');
      const upstreamType =
        (errObj && typeof errObj.type === 'string' && errObj.type) ||
        (typeof body.type === 'string' ? body.type : '');

      if (upstreamType === 'ModelError' || /not supported/i.test(upstreamMsg)) {
        return Object.assign(new Error('The requested model does not exist or is not available'), {
          httpStatus: 404,
          code: 'invalid_model',
          type: 'not_found_error',
        });
      }
      if (upstreamMsg) message = upstreamMsg;
      code = `upstream_${res.status}`;
      type = res.status === 429 ? 'rate_limit_error' : 'upstream_error';
    } catch {
      // Upstream returned a non-JSON error body; keep the generic message.
    }

    // Never echo provider internals to the customer.
    const safe = new Error(message) as Error & {
      httpStatus: number;
      code: string;
      type: string;
      retryable: boolean;
    };
    safe.httpStatus = res.status === 429 ? 429 : res.status >= 500 ? 502 : 400;
    safe.code = code;
    safe.type = type;
    safe.retryable = retryable;
    return safe;
  }

  async healthCheck(signal: AbortSignal): Promise<ProviderHealth> {
    const started = Date.now();
    try {
      const res = await fetch(this.endpoint(this.config.upstream.modelsPath), {
        method: 'GET',
        headers: this.buildHeaders(),
        signal,
      });
      const latencyMs = Date.now() - started;
      return {
        healthy: res.ok,
        latencyMs,
        checkedAt: new Date().toISOString(),
        detail: res.ok ? undefined : `status ${res.status}`,
      };
    } catch (err) {
      return {
        healthy: false,
        latencyMs: null,
        checkedAt: new Date().toISOString(),
        detail: err instanceof Error ? err.message : 'unreachable',
      };
    }
  }
}
