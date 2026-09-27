/** Platform-standard error envelope (§6, §21, §33). */
export interface ApiErrorBody {
  error: {
    message: string;
    type: ApiErrorType;
    code: string;
    param?: string | null;
  };
}

export const API_ERROR_TYPES = [
  'invalid_request_error',
  'authentication_error',
  'permission_error',
  'not_found_error',
  'rate_limit_error',
  'quota_exceeded_error',
  'api_error',
  'timeout_error',
  'upstream_error',
] as const;
export type ApiErrorType = (typeof API_ERROR_TYPES)[number];

export interface RequestStats {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
}

export interface UsageBucket {
  bucket: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  upstreamCost: number;
}

export interface RequestLogEntry {
  requestId: string;
  createdAt: string;
  model: string;
  status: string;
  httpStatus: number;
  latencyMs: number;
  totalTokens: number | null;
  stream: boolean;
  errorCode: string | null;
}

export interface ApiKeyMetadata {
  id: string;
  name: string;
  keyPrefix: string;
  environment: 'live' | 'test';
  status: string;
  projectId: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  requestCount: number;
}
