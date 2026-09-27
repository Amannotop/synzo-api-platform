import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * A real HTTP server standing in for the upstream AI provider.
 *
 * Integration tests need deterministic control over responses the live
 * OpenCode endpoint cannot be made to produce on demand: a slow response that
 * trips the timeout, a socket destroyed mid-stream, a malformed SSE frame, a
 * non-JSON error body. Scripts/smoke.sh covers the real upstream; this covers
 * the mechanics, and does so over a genuine socket so the fetch/AbortSignal
 * and ReadableStream paths are exercised rather than mocked.
 */
export interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  rawBody: string;
}

export type Responder = (req: CapturedRequest, res: ServerResponse) => void | Promise<void>;

export class LocalUpstream {
  private server: Server | null = null;
  private _responder: Responder = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'ok', choices: [{ message: { role: 'assistant', content: 'hi' } }] }));
  };
  /** Every request the server has received, in order. */
  readonly requests: CapturedRequest[] = [];

  get port(): number {
    const addr = this.server?.address() as AddressInfo | null;
    if (!addr) throw new Error('LocalUpstream is not listening');
    return addr.port;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Swaps the handler. Each test sets its own behaviour. */
  respondWith(responder: Responder): void {
    this._responder = responder;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        let body: unknown = rawBody;
        try {
          body = rawBody ? JSON.parse(rawBody) : undefined;
        } catch {
          // Left as the raw string so a test can assert on what was sent.
        }
        const captured: CapturedRequest = {
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers,
          body,
          rawBody,
        };
        this.requests.push(captured);
        Promise.resolve(this._responder(captured, res)).catch((err: unknown) => {
          if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: String(err) } }));
        });
      });
    });

    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    // close() waits for keep-alive sockets to drain, which an aborted stream
    // may never do; destroy them so a test cannot hang the suite.
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  }
}

/** Writes an SSE response from a list of pre-framed chunks. */
export function sse(res: ServerResponse, chunks: string[]): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  for (const c of chunks) res.write(c);
  res.end();
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** A minimal OpenAI-shaped non-streaming success body. */
export function completionBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'chatcmpl-local',
    object: 'chat.completion',
    model: 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Hello there' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    cost: '0',
    ...overrides,
  };
}
