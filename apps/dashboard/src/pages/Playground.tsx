import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { Model } from '../lib/types';
import {
  DEFAULT_CONFIG, buildSnippets, chatEndpoint, isCrossOrigin, modelsEndpoint,
  normalizeBaseUrl, parseConfig, serializeConfig, type PlaygroundConfig,
} from '../lib/playground';
import { useToast } from '../components/Toast';
import { Alert, Button, Card, Field, Icons, Input, Select, Textarea } from '../components/ui';

const STORAGE_KEY = 'synzo.playground';

/**
 * The API Playground: a place to paste a base URL and a key and see the
 * platform answer, plus ready-made client snippets for using the API
 * directly.
 *
 * The base URL and key are editable on purpose. Someone evaluating the
 * platform may have a key issued elsewhere or want to point at a different
 * deployment, and a playground that can only talk to the origin it was served
 * from cannot demonstrate either.
 */
export default function Playground() {
  const toast = useToast();
  const [config, setConfig] = useState<PlaygroundConfig>(DEFAULT_CONFIG);
  const [loaded, setLoaded] = useState(false);

  // The base URL defaults to wherever this page was served from, so the common
  // case needs no typing. The page origin is only a default: it stays editable.
  useEffect(() => {
    const stored = parseConfig(window.localStorage.getItem(STORAGE_KEY));
    setConfig({
      ...DEFAULT_CONFIG,
      baseUrl: window.location.origin,
      ...stored,
    });
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, serializeConfig(config));
    } catch {
      // A browser with storage disabled is a normal state, not a failure to
      // report: the playground still works for this page view.
    }
  }, [config, loaded]);

  const baseUrlError = config.baseUrl.trim() && !normalizeBaseUrl(config.baseUrl)
    ? 'Enter a valid http(s) URL, for example https://api.example.com'
    : undefined;

  const resolvedBase = normalizeBaseUrl(config.baseUrl) ?? '';
  const snippets = useMemo(
    () => buildSnippets(resolvedBase || config.baseUrl, config.apiKey, config.model),
    [resolvedBase, config.baseUrl, config.apiKey, config.model],
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>API Playground</h1>
          <p>
            Send a request with your own base URL and API key, then copy a ready-made
            client to use the API from your own code.
          </p>
        </div>
      </div>

      <ConnectionPanel
        config={config}
        onChange={setConfig}
        error={baseUrlError}
        baseUrl={resolvedBase}
        toast={toast}
      />

      <div className="grid grid-2 mt-3">
        <PlaygroundChat
          config={config}
          baseUrl={resolvedBase}
          error={baseUrlError}
          onModelChange={(model) => setConfig((c) => ({ ...c, model }))}
        />
        <Snippets snippets={snippets} />
      </div>
    </>
  );
}

/* ------------------------------------------------------------ connection */

function ConnectionPanel({ config, onChange, error, baseUrl, toast }: {
  config: PlaygroundConfig;
  onChange: (next: PlaygroundConfig) => void;
  error: string | undefined;
  baseUrl: string;
  toast: ReturnType<typeof useToast>;
}) {
  const set = (patch: Partial<PlaygroundConfig>) => onChange({ ...config, ...patch });

  function copy(text: string, what: string) {
    void navigator.clipboard
      .writeText(text)
      .then(() => toast.push('success', `${what} copied`))
      .catch(() => toast.push('error', 'Copy failed', 'Select the text and copy it manually.'));
  }

  const models = useQuery({
    // Only fetch once there is somewhere to fetch from, and re-run whenever the
    // key changes: a list fetched with one key is not valid for another.
    queryKey: ['playground-models', baseUrl, config.apiKey],
    enabled: Boolean(baseUrl) && Boolean(config.apiKey.trim()) && !error,
    queryFn: () =>
      fetch(modelsEndpoint(baseUrl), { headers: { Authorization: `Bearer ${config.apiKey.trim()}` } })
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return (await res.json()) as { data?: Array<{ id: string }> };
        }),
    retry: false,
  });

  const crossOrigin = baseUrl && isCrossOrigin(baseUrl, window.location.origin);

  return (
    <Card title="Connection">
      <div className="grid grid-2">
        <Field
          label="Base URL"
          id="pg-base"
          error={error}
          hint="Origin only. A trailing /v1 is added for you."
        >
          <Input
            id="pg-base"
            className="input-mono"
            value={config.baseUrl}
            onChange={(e) => set({ baseUrl: e.target.value })}
            placeholder="https://api.example.com"
            spellCheck={false}
          />
        </Field>

        <Field
          label="API key"
          id="pg-key"
          hint="Sent as a bearer token. Never stored unless you choose to remember it."
        >
          <Input
            id="pg-key"
            className="input-mono"
            type="password"
            value={config.apiKey}
            onChange={(e) => set({ apiKey: e.target.value })}
            placeholder="sk_test_…"
            spellCheck={false}
            autoComplete="off"
          />
        </Field>
      </div>

      <div className="row wrap mt-2" style={{ gap: 16 }}>
        <label className="row small" style={{ gap: 6, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={config.rememberKey}
            onChange={(e) => set({ rememberKey: e.target.checked, ...(e.target.checked ? {} : { apiKey: '' }) })}
          />
          Remember this key on this device
        </label>

        {config.apiKey.trim() && (
          <Button size="sm" variant="ghost" icon={<Icons.copy size={13} />}
            onClick={() => copy(config.apiKey.trim(), 'API key')}>
            Copy key
          </Button>
        )}

        {baseUrl && (
          <span className="small muted mono">{chatEndpoint(baseUrl)}</span>
        )}
      </div>

      {config.rememberKey && (
        <Alert kind="warning">
          This key is being written to this browser&apos;s local storage. Anything that
          can read local storage on this origin can read the key. Use it on a device
          you trust, and revoke the key from the API Keys page when you are done.
        </Alert>
      )}

      {crossOrigin && (
        <Alert kind="info">
          This base URL is on a different origin from the page. The browser will only
          reach it if that server sends permissive CORS headers; a server that does
          not will refuse the request in the browser while working fine from a
          terminal.
        </Alert>
      )}

      {models.isError && (
        <Alert kind="error">
          The key was refused by {modelsEndpoint(baseUrl)} (HTTP{' '}
          {(models.error as Error).message.replace('HTTP ', '')}). Check the key and the base URL.
        </Alert>
      )}
      {models.isSuccess && (
        <Alert kind="success">
          Key accepted. {models.data?.data?.length ?? 0} model(s) available on this key.
        </Alert>
      )}
    </Card>
  );
}

/* ----------------------------------------------------------------- chat */

interface ChatTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

function PlaygroundChat({ config, baseUrl, error, onModelChange }: {
  config: PlaygroundConfig;
  baseUrl: string;
  error: string | undefined;
  onModelChange: (model: string) => void;
}) {
  const [prompt, setPrompt] = useState('Say hi in one short sentence.');
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const abort = useRef<AbortController | null>(null);

  // The picker offers this account's models. `addressable` is the value the
  // API accepts and `label` is the friendly name shown beside it; for every
  // catalogue tier the addressable form is the label, but the two are kept
  // apart so a model that is only addressable by a branded name never
  // suggests sending the internal id it replaces.
  const catalogue = useQuery({ queryKey: ['models'], queryFn: api.models });
  const knownModels = (catalogue.data?.models ?? []) as Model[];
  useEffect(() => {
    // Preselect the strongest tier so the form is sendable immediately, but
    // never overwrite a model the person chose or typed themselves.
    if (!config.model && knownModels.length > 0) onModelChange(knownModels[0].addressable);
  }, [knownModels, config.model, onModelChange]);
  useEffect(() => () => abort.current?.abort(), []);

  const ready = Boolean(baseUrl) && Boolean(config.apiKey.trim()) && Boolean(config.model.trim()) && !error;

  async function send() {
    if (!ready || busy) return;
    const outgoing: ChatTurn[] = [...turns, { role: 'user', content: prompt }];
    setTurns(outgoing);
    setBusy(true);
    setResult('');
    const controller = new AbortController();
    abort.current = controller;

    try {
      const res = await fetch(chatEndpoint(baseUrl), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey.trim()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.model.trim(),
          messages: outgoing.map((t) => ({ role: t.role, content: t.content })),
        }),
        signal: controller.signal,
      });

      const text = await res.text();
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = null;
      }

      if (!res.ok) {
        const err = (parsed as { error?: { message?: string } } | null)?.error;
        setResult(err?.message ?? `HTTP ${res.status}`);
        setTurns(outgoing.slice(0, -1));
        return;
      }

      const choices = (parsed?.choices ?? []) as Array<{
        message?: { content?: string | null };
      }>;
      const content = choices[0]?.message?.content ?? '';
      setTurns([...outgoing, { role: 'assistant', content: content || '(no text returned)' }]);
      setResult(text);
    } catch (err) {
      // An abort is the user changing their mind, not a failure worth a toast.
      if ((err as Error).name !== 'AbortError') {
        setResult(
          `Could not reach ${baseUrl}. If this is a different origin, the server must allow cross-origin requests from this page.`,
        );
        setTurns(outgoing.slice(0, -1));
      }
    } finally {
      setBusy(false);
      abort.current = null;
    }
  }

  return (
    <Card
      title="Try a request"
      actions={busy ? (
        <Button size="sm" variant="ghost" onClick={() => abort.current?.abort()}>Stop</Button>
      ) : undefined}
    >
      <Field label="Model" id="pg-model">
        {knownModels.length > 0 ? (
          <Select id="pg-model" value={config.model}
            onChange={(e) => onModelChange(e.target.value)}>
            <option value="">Select a model…</option>
            {knownModels.map((m) => (
              <option key={m.id} value={m.addressable}>{m.label}</option>
            ))}
          </Select>
        ) : (
          <Input id="pg-model" className="input-mono" value={config.model}
            onChange={(e) => onModelChange(e.target.value)} placeholder="GPT-6 Astra" />
        )}
      </Field>

      <Field label="Message" id="pg-prompt">
        <Textarea id="pg-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} />
      </Field>

      <div className="row mt-1">
        <Button variant="primary" onClick={() => void send()} disabled={!ready || busy || !prompt.trim()}>
          {busy ? 'Sending…' : 'Send request'}
        </Button>
        {turns.length > 0 && (
          <Button variant="ghost" onClick={() => { setTurns([]); setResult(''); }}>Clear</Button>
        )}
      </div>

      {!config.apiKey.trim() && (
        <p className="small muted mt-2 mb-0">Enter an API key above to send a request.</p>
      )}

      {turns.length > 0 && (
        <div className="playground-turns mt-2">
          {turns.map((t, i) => (
            <div key={i} className={`playground-turn ${t.role}`}>
              <div className="playground-turn-role">{t.role}</div>
              <div className="playground-turn-body">{t.content}</div>
            </div>
          ))}
        </div>
      )}

      {result && (
        <Field label="Raw response" id="pg-raw">
          <pre className="playground-raw" id="pg-raw">{result}</pre>
        </Field>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------- snippets */

function Snippets({ snippets }: { snippets: ReturnType<typeof buildSnippets> }) {
  const toast = useToast();
  const [active, setActive] = useState(snippets[0]?.id ?? 'curl');
  const current = snippets.find((s) => s.id === active) ?? snippets[0];

  function copy() {
    if (!current) return;
    void navigator.clipboard
      .writeText(current.code)
      .then(() => toast.push('success', `${current.label} snippet copied`, 'Paste it into a terminal and run.'))
      .catch(() => toast.push('error', 'Copy failed', 'Select the text and copy it manually.'));
  }

  if (!current) return null;

  return (
    <Card
      title="Use the API directly"
      actions={
        <Button size="sm" variant="ghost" icon={<Icons.copy size={13} />} onClick={copy}>
          Copy
        </Button>
      }
    >
      <p className="small muted">
        Generated from the base URL and key above, so they already match what you entered.
      </p>

      <div className="tabs" role="tablist">
        {snippets.map((s) => (
          <button
            key={s.id}
            role="tab"
            aria-selected={s.id === current.id}
            className={`tab ${s.id === current.id ? 'active' : ''}`}
            onClick={() => setActive(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>

      <pre className="playground-raw"><code>{current.code}</code></pre>
    </Card>
  );
}
