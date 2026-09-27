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
   *
   * `tools` and `tool_choice` ARE forwarded: verified live against
   * opencode.ai/zen, a request carrying `tools` comes back with
   * finish_reason "tool_calls" and a populated message.tool_calls. They are
   * spread in rather than nested, and both paths (streaming and not) go through
   * this one function, so neither can drift.
   */
  private toUpstreamBody(payload: ChatRequestPayload): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: payload.model,
      messages: payload.messages,
      stream: payload.stream,
    };
    if (payload.max_tokens !== undefined) body.max_tokens = payload.max_tokens;
    // Only set when the customer actually supplied them. An empty `tools: []`
    // is forwarded as sent rather than dropped, so a caller that deliberately
    // removes its tools is not silently overruled.
    if (payload.tools !== undefined) body.tools = payload.tools;
    if (payload.tool_choice !== undefined) body.tool_choice = payload.tool_choice;
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
      let bodyError: unknown = null;

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
      } catch (err) {
        // An upstream that hard-closes the socket mid-body surfaces here as a
        // TypeError from undici, NOT as a clean end-of-stream. It has to be
        // handled explicitly, or the client sees a broken response instead of
        // a well-formed one.
        //
        // Our own timeout and the client's own abort are different: those must
        // keep rejecting, because the caller has to turn them into a 504 or a
        // cancellation record rather than pretend the stream completed.
        if (combined.aborted) throw err;
        bodyError = err;
      } finally {
        // Client disconnect or timeout aborts the upstream fetch rather than
        // letting it keep streaming into a dead socket (§16).
        reader.cancel().catch(() => {});
        reader.releaseLock();
      }

      // Stream ended without [DONE], either cleanly or because the upstream
      // dropped the connection. Upstream ended without a terminator; synthesize
      // one so the client still sees a well-formed stream (§55).
      if (!sawDoneFrame) {
        collector.markDone();
        yield 'data: [DONE]\n\n';
      }
      // A truncated body is reported through the usage it did produce. The
      // customer can see the token cost of the part they received, which is
      // more useful than discarding an accurate count.
      if (bodyError) {
        this.logStreamTruncation(bodyError);
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
    const retryable = res.status >= 500 || res.status === 429;

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
      /**
       * A 401/403 with no ModelError body is a credential rejection, and the
       * upstream's own text is not echoed: it routinely contains the rejected
       * token. The status alone is enough for the caller to classify it, and
       * keeping the message generic here is what makes "never echo upstream
       * text" a property of this function rather than of each caller.
       */
      if (res.status === 401 || res.status === 403) {
        message = 'The upstream provider rejected our credentials';
        code = 'upstream_authentication_failed';
        type = 'upstream_error';
      } else {
        if (upstreamMsg) message = upstreamMsg;
        code = `upstream_${res.status}`;
        type = res.status === 429 ? 'rate_limit_error' : 'upstream_error';
      }
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
    /**
     * `httpStatus` is what the ChatService branches on, so it carries the
     * UPSTREAM status: 401 stays 401 so it is recognised as an auth failure,
     * not flattened into 400 where it would look like a bad customer request.
     * The 5xx the customer actually sees is decided in normalizeProviderError.
     */
    safe.httpStatus =
      res.status === 429
        ? 429
        : res.status === 401 || res.status === 403
          ? res.status
          : res.status >= 500
            ? 502
            : 400;
    safe.code = code;
    safe.type = type;
    // A rejected credential will not fix itself on retry, so anything that
    // treats retryable as "try again" is wasting the customer's time.
    safe.retryable = res.status === 401 || res.status === 403 ? false : retryable;
    return safe;
  }

  /** A truncated stream is worth an operational signal, not a customer error. */
  private logStreamTruncation(err: unknown): void {
    // Deliberately not a throw: the customer's stream is already well-formed.
    // Surfaced on stderr rather than through the logger, which this provider
    // does not take, so the failure is still visible in container logs.
    const message = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(
      `${JSON.stringify({ level: 'warn', msg: 'Upstream stream ended early', error: message })}\n`,
    );
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
