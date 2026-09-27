import type {
  ApiKey,
  Limits,
  MetricsSummary,
  Model,
  Overview,
  Project,
  Provider,
  ProviderHealthEntry,
  Range,
  RequestLogRow,
  Stats,
  Usage,
  User,
} from './types';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

/**
 * All calls are same-origin and cookie-authenticated, so credentials are always
 * included. A 401 means the session expired and the app should return to the
 * sign-in screen rather than retrying.
 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });

  const text = await res.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!res.ok) {
    const err = (payload as { error?: { message?: string; code?: string } } | null)?.error;
    throw new ApiRequestError(
      res.status,
      err?.code ?? 'unknown_error',
      err?.message ?? `Request failed with status ${res.status}`,
    );
  }
  return payload as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });

export const api = {
  // --- auth ---
  register: (input: { email: string; name: string; password: string }) =>
    post<{ user: User }>('/api/auth/register', input),
  login: (input: { email: string; password: string }) =>
    post<{ user: User }>('/api/auth/login', input),
  logout: () => post<{ ok: boolean }>('/api/auth/logout', {}),
  me: () => request<{ user: User; limits: Limits; usage: { tokensToday: number } }>('/api/me'),
  /**
   * Changing the password invalidates every session server-side, so the caller
   * must treat the local session as gone and send the user back to sign-in.
   */
  changePassword: (input: { currentPassword: string; newPassword: string }) =>
    post<{ ok: boolean; reauthenticate: true }>('/api/me/password', input),

  // --- account recovery / verification (§8) ---
  // `forgotPassword` always resolves the same way whether or not the address
  // exists, so the UI must not imply that it did.
  forgotPassword: (email: string) =>
    post<{ ok: boolean; message: string }>('/api/auth/password/forgot', { email }),
  resetPassword: (token: string, password: string) =>
    post<{ ok: boolean; reauthenticate: true }>('/api/auth/password/reset', { token, password }),
  verifyEmail: (token: string) => post<{ ok: boolean; emailVerified: boolean }>('/api/auth/email/verify', { token }),
  resendVerification: () =>
    post<{ ok: boolean; emailVerified: boolean; resent: boolean }>('/api/auth/email/resend', {}),

  // --- dashboard data ---
  overview: () => request<Overview>('/api/overview'),
  models: () => request<{ models: Model[]; providers: Provider[] }>('/api/models'),

  // --- projects ---
  projects: () => request<{ projects: Project[] }>('/api/projects'),
  createProject: (input: { name: string; description?: string }) =>
    post<{ project: Project }>('/api/projects', input),
  updateProject: (id: string, input: { name?: string; description?: string }) =>
    request<{ project: Project }>(`/api/projects/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  deleteProject: (id: string) => request<void>(`/api/projects/${id}`, { method: 'DELETE' }),

  // --- api keys ---
  keys: () => request<{ keys: ApiKey[]; canCreateLiveKeys: boolean }>('/api/keys'),
  createKey: (input: { name: string; projectId: string; environment: 'live' | 'test'; expiresAt?: string }) =>
    post<{ key: ApiKey; secret: string; warning: string }>('/api/keys', input),
  revokeKey: (id: string) => post<{ key: ApiKey }>(`/api/keys/${id}/revoke`, {}),
  setKeyStatus: (id: string, status: 'active' | 'disabled') =>
    post<{ key: ApiKey }>(`/api/keys/${id}/status`, { status }),
  deleteKey: (id: string) => request<void>(`/api/keys/${id}`, { method: 'DELETE' }),

  // --- usage / requests ---
  usage: (range: Range, from?: string, to?: string) => {
    const q = new URLSearchParams({ range });
    if (range === 'custom' && from && to) {
      q.set('from', from);
      q.set('to', to);
    }
    return request<Usage>(`/api/usage?${q.toString()}`);
  },
  requests: (params: { range: Range; limit: number; offset: number; status?: string; model?: string }) => {
    const q = new URLSearchParams({
      range: params.range,
      limit: String(params.limit),
      offset: String(params.offset),
    });
    if (params.status) q.set('status', params.status);
    if (params.model) q.set('model', params.model);
    return request<{ requests: RequestLogRow[]; total: number; limit: number; offset: number }>(
      `/api/requests?${q.toString()}`,
    );
  },

  // --- admin ---
  admin: {
    /**
     * The live operational summary.
     *
     * This reads the JSON summary rather than the Prometheus text at
     * /metrics, which is for a scraper. Parsing the exposition format in the
     * browser would mean re-implementing it here and having two definitions of
     * what p95 means.
     */
    metrics: () =>
      request<{ summary: MetricsSummary; providers: ProviderHealthEntry[] }>('/api/admin/metrics'),
    /**
     * `q` is the admin's name-or-email search term. Passing undefined omits the
     * parameter entirely, which keeps the unfiltered request byte-identical to
     * what it was before search existed.
     */
    customers: (q?: string) =>
      request<{ customers: User[]; total: number; matched: number; query: string }>(
        `/api/admin/customers${q ? `?q=${encodeURIComponent(q)}` : ''}`,
      ),
    customerLimits: (id: string) => request<{ limits: Limits }>(`/api/admin/customers/${id}/limits`),
    setCustomerLimits: (id: string, input: Partial<Limits>) =>
      request<{ limits: Limits }>(`/api/admin/customers/${id}/limits`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    setCustomer: (
      id: string,
      input: { status?: 'active' | 'suspended'; unlimitedMode?: boolean; allowLiveKeys?: boolean; role?: 'admin' | 'customer' },
    ) =>
      request<{ customer: User }>(`/api/admin/customers/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    setModelEnabled: (id: string, enabled: boolean) =>
      request<{ ok: boolean }>(`/api/admin/models/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      }),
    systemUsage: () => request<{ totals: Stats; customers: number; modelCount: number }>('/api/admin/system/usage'),
    errors: () => request<{ errors: unknown[] }>('/api/admin/errors'),
    providerHealth: () => request<{ health: unknown[] }>('/api/admin/providers/health'),
    audit: () => request<{ entries: unknown[] }>('/api/admin/audit'),
  },
};
