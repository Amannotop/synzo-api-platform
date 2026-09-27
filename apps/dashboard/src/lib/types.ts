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
  /** What a customer sends as `model` in the API. */
  publicName: string;
  /** Friendly name shown in the dashboard, e.g. "GPT-6 Astra". */
  label: string;
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
