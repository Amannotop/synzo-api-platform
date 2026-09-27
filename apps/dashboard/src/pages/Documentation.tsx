import { useEffect, useState } from 'react';
import { Alert, Card } from '../components/ui';
import { useAuth } from '../lib/AuthContext';

/**
 * Quickstart, plus a pointer to the real reference.
 *
 * The API serves its own OpenAPI document at /openapi.json with a browsable
 * rendering at /docs, generated from the code that serves the requests. The
 * previous version of this page described the endpoints, the tiers and the
 * error codes by hand, which is exactly the arrangement that drifts: routes
 * change, the prose does not, and it goes on confidently describing endpoints
 * that no longer exist.
 *
 * So the hand-written part is now only what a reference cannot say well — a
 * first request, and what the numbers mean — and the exhaustive list lives in
 * the spec, where it cannot disagree with the server.
 */

/** The base URL customers point their SDKs at, read from the live origin. */
function useBaseUrl(): string {
  const [base, setBase] = useState('');
  useEffect(() => setBase(window.location.origin), []);
  return base;
}

const LANG_TABS = [
  { id: 'curl', label: 'cURL' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'python', label: 'Python' },
] as const;
type Lang = (typeof LANG_TABS)[number]['id'];

export default function Documentation() {
  const base = useBaseUrl();
  const { user } = useAuth();
  const [lang, setLang] = useState<Lang>('curl');

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Documentation</h1>
          <p>
            Everything you need to call the platform. The endpoint is OpenAI-compatible.
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <a className="btn btn-ghost" href="/playground">
            Try it live
          </a>
          <a className="btn btn-primary" href="/docs" target="_blank" rel="noreferrer">
            Full API reference
          </a>
          <a className="btn btn-ghost" href="/openapi.json" target="_blank" rel="noreferrer">
            openapi.json
          </a>
        </div>
      </div>

      <div className="docs">
        <Card>
          <div className="card-body docs">
            <Alert kind="info">
              The exhaustive reference — every endpoint, request body, response shape and error
              code — is generated from the running server and lives at <a href="/docs" target="_blank" rel="noreferrer"><code>/docs</code></a>.
              This page is the short version.
            </Alert>

            <h2>Authentication</h2>
            <p>
              Send your key as a bearer token. Keys are environment-prefixed:{' '}
              <code>sk_test_</code> for test, <code>sk_live_</code> for live. The secret is shown
              once, when you create the key.
            </p>
            <pre><code>{`curl ${base}/v1/models \\
  -H "Authorization: Bearer sk_test_YOUR_KEY"`}</code></pre>

            <h2>Chat completions</h2>
            <p>
              <code>model</code>, <code>messages</code>, <code>stream</code> and{' '}
              <code>max_tokens</code> are forwarded to the provider. Other OpenAI parameters are
              accepted for SDK compatibility but do not change the response, so the platform does
              not claim to support them.
            </p>
            <pre><code>{`curl ${base}/v1/chat/completions \\
  -H "Authorization: Bearer sk_test_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "max",
    "messages": [{ "role": "user", "content": "say hi" }]
  }'`}</code></pre>

            <h3>Models</h3>
            <p>
              Pick a tier by name. The platform resolves it to the underlying model for you, so the
              name you send is the whole model surface. <code>GET /v1/models</code> returns the
              current list, and the Models page shows the same thing.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Tier</th><th>Use it for</th></tr>
                </thead>
                <tbody>
                  <tr><td><span className="mono strong">max</span></td>
                    <td className="small">Maximum capability. Hardest reasoning and the most thorough answers.</td></tr>
                  <tr><td><span className="mono strong">xhigh</span></td>
                    <td className="small">Extra high. Near-maximum capability at lower cost and latency.</td></tr>
                  <tr><td><span className="mono strong">high</span></td>
                    <td className="small">High. Strong general capability for complex work.</td></tr>
                  <tr><td><span className="mono strong">medium</span></td>
                    <td className="small">Medium. Balanced quality and speed for everyday tasks.</td></tr>
                  <tr><td><span className="mono strong">low</span></td>
                    <td className="small">Low. Fastest and cheapest. Best for simple, high-volume work.</td></tr>
                </tbody>
              </table>
            </div>
            <p className="small">
              The labels behind each tier are listed on the <a href="/models">Models</a> page.
            </p>

            <h3>Response</h3>
            <pre><code>{`{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1758000000,
  "model": "max",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "Hi! 👋" },
    "finish_reason": "stop"
  }],
  "usage": { "total_tokens": 163 }
}`}</code></pre>
            <p className="small">
              Usage values come from the provider. If a field is not reported, the platform omits
              it rather than inventing a number.
            </p>

            <h2>Streaming</h2>
            <p>
              Set <code>stream: true</code> for Server-Sent Events. Chunks are forwarded as they
              arrive and the stream ends with <code>data: [DONE]</code>. If the client
              disconnects, the upstream request is aborted.
            </p>

            <div className="tabs" style={{ maxWidth: 340 }}>
              {LANG_TABS.map((t) => (
                <button key={t.id} className={`tab ${lang === t.id ? 'active' : ''}`}
                  onClick={() => setLang(t.id)}>{t.label}</button>
              ))}
            </div>

            {lang === 'curl' && (
              <pre><code>{`curl -N ${base}/v1/chat/completions \\
  -H "Authorization: Bearer sk_test_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "max",
    "stream": true,
    "messages": [{ "role": "user", "content": "Count 1 to 5, digits only." }]
  }'`}</code></pre>
            )}

            {lang === 'javascript' && (
              <pre><code>{`const response = await fetch("${base}/v1/chat/completions", {
  method: "POST",
  headers: {
    "Authorization": "Bearer sk_test_YOUR_KEY",
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    model: "max",
    messages: [{ role: "user", content: "Hello" }]
  })
});

const data = await response.json();
console.log(data.choices[0].message.content);`}</code></pre>
            )}

            {lang === 'python' && (
              <pre><code>{`from openai import OpenAI

client = OpenAI(
    api_key="sk_test_YOUR_KEY",
    base_url="${base}/v1"
)

response = client.chat.completions.create(
    model="max",
    messages=[{"role": "user", "content": "Hello"}]
)
print(response.choices[0].message.content)`}</code></pre>
            )}

            <h2>OpenAI SDK</h2>
            <p>
              Point the official SDK at <code>{base}/v1</code>. Compatibility covers chat
              completions, streaming, model listing and error shapes — it is not a complete
              reproduction of every OpenAI endpoint.
            </p>

            <h2>Errors</h2>
            <p>Errors use an OpenAI-compatible envelope:</p>
            <pre><code>{`{
  "error": {
    "message": "Invalid API key",
    "type": "authentication_error",
    "code": "invalid_api_key"
  }
}`}</code></pre>
            <p className="small">
              The full list, with the exact code for each condition, is in the{' '}
              <a href="/docs" target="_blank" rel="noreferrer">API reference</a>. The ones worth
              knowing before they surprise you:
            </p>
            <ul>
              <li><code>401 invalid_api_key</code> — missing, unknown, revoked, disabled or expired key</li>
              <li><code>404 invalid_model</code> — model does not exist or is disabled</li>
              <li><code>429 rate_limit_exceeded</code> — rate or quota limit reached; see <code>Retry-After</code></li>
              <li><code>502 upstream_authentication_failed</code> — the server's own upstream credential was rejected. This is our misconfiguration, not your request, and retrying will not help.</li>
              <li><code>502 upstream_error</code> — the provider failed</li>
              <li><code>504 upstream_timeout</code> — the provider did not respond in time</li>
            </ul>
            <p className="small">
              An upstream error message never contains the provider's own text, keys or stack
              traces. A customer sees that the service failed and nothing more.
            </p>

            <h2>Rate limits</h2>
            <p>Limits are applied per API key and come from your account configuration:</p>
            <ul>
              <li><strong>Requests per minute</strong> — sliding window</li>
              <li><strong>Requests per day</strong> — resets at midnight UTC</li>
              <li><strong>Tokens per day</strong> — counted from real usage</li>
              <li><strong>Max concurrent requests</strong> — in-flight requests per key</li>
            </ul>
            <p>
              Your current limits are shown on the <a href="/settings">Settings</a> page
              {user ? '' : ' once you are signed in'}.
            </p>

            <h2>Usage and privacy</h2>
            <p>
              Every request is recorded with its model, status, latency and token counts. Prompts
              and completions are not stored unless content logging is explicitly enabled on the
              server. Your API key secrets are never shown after creation.
            </p>
            <p className="small">
              Request history is pruned by a retention job. Daily usage totals are kept, so a
              number you were billed for does not change when the underlying rows are removed.
            </p>
          </div>
        </Card>
      </div>
    </>
  );
}
