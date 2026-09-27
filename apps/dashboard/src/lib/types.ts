/** Shapes returned by the Synzo API. Kept in one place so pages agree. */

export interface User {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'customer';
  status: 'active' | 'suspended';
  emailVerified: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  unlimitedMode: boolean;
  allowLiveKeys: boolean;
}

export interface Limits {
  userId?: string;
  requestsPerMinute: number;
  requestsPerDay: number;
  tokensPerDay: number;
  maxConcurrentRequests: number;
  /** null = every enabled model. Otherwise an array of public model names. */
  allowedModels: string[] | null;
}

export interface Project {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  environment: 'live' | 'test';
  projectId: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  status: 'active' | 'disabled' | 'revoked';
  requestCount?: number;
}

export interface Model {
  id: string;
  /**
   * The routing key, sent to admins only.
   *
   * The allowlist editor stores and compares these values verbatim, so a
   * customer who edited their own limits without it would have their change
   * silently ignored. Absent for non-admins, where it would only ever be a
   * place for the internal upstream id to sit in a response body.
   */
  publicName?: string;
  /** Friendly name shown in the dashboard, e.g. "GPT-6 Astra". */
  label: string;
  /**
   * The name to send as `model`. Equal to `label` for catalogue tiers.
   * Kept separate because a row whose public name is an internal id is
   * addressable by its display name only.
   */
  addressable: string;
  /** One-line description of what the tier is for. */
  description: string;
  provider: string;
  enabled: boolean;
  createdAt: string;
}

export interface Provider {
  id: string;
  name: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Stats {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
  maxLatencyMs: number;
}

export interface UsagePoint {
  date: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  errors: number;
  avgLatencyMs: number;
}

export interface ModelUsage {
  model: string;
  requests: number;
  totalTokens: number;
  upstreamCost: number | null;
}

export interface RequestLogRow {
  requestId: string;
  createdAt: string;
  model: string;
  status: 'success' | 'error' | 'cancelled';
  httpStatus: number;
  latencyMs: number;
  totalTokens: number | null;
  stream: boolean;
  errorCode: string | null;
}

export interface Overview {
  stats: Stats;
  activeKeys: number;
  totalKeys: number;
  projects: number;
  models: string[];
}

export interface Usage {
  range: { from: string; to: string };
  stats: Stats;
  series: UsagePoint[];
  byModel: ModelUsage[];
}

export type Range = 'today' | '7d' | '30d' | '90d' | 'custom';

/* ------------------------------------------------------------------ metrics */

export interface ModelTraffic {
  model: string;
  total: number;
  errors: number;
}

/** Mirrors MetricsSummary in apps/api/src/metrics/summary.ts. */
export interface MetricsSummary {
  httpRequestsTotal: number;
  errorRate: number;
  upstreamErrors: { kind: string; count: number }[];
  upstreamErrorsTotal: number;
  rateLimitRejections: { scope: string; count: number }[];
  rateLimitRejectionsTotal: number;
  byModel: ModelTraffic[];
  /** Seconds. Null when nothing has been observed yet. */
  latency: { p50: number | null; p95: number | null; p99: number | null; count: number };
  processUptimeSeconds: number;
}

export interface ProviderHealthEntry {
  provider: string;
  healthy: boolean;
  latencyMs: number | null;
  checkedAt: string;
  detail?: string;
}
