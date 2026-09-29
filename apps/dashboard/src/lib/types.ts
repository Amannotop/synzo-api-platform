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

/* ------------------------------------------------------------------ credits */

export type AccountStatus = 'active' | 'suspended' | 'pending' | 'rejected';
export type PaymentStatus = 'pending' | 'approved' | 'rejected';

/**
 * Why API access is currently unavailable.
 *
 * `null` means access is allowed. The dashboard renders a different call to
 * action per reason, because "waiting for review" and "buy more credits" are
 * different problems and showing the paywall to an unapproved account is
 * worse than showing them nothing.
 */
export type AccessReason = 'awaiting_approval' | 'account_rejected' | 'account_suspended' | 'credits_exhausted' | null;

/**
 * The two credit pools, kept separate on purpose. `totalRemaining` is what the
 * customer can actually spend: the balance minus anything held by requests
 * currently in flight.
 */
export interface CreditBalance {
  freeGranted: number;
  freeUsed: number;
  freeRemaining: number;
  freeReserved: number;
  paidGranted: number;
  paidUsed: number;
  paidRemaining: number;
  paidReserved: number;
  totalRemaining: number;
  freeTrialGrantedAt: string | null;
  hasFreeTrial: boolean;
}

export interface CreditPackage {
  id: string;
  name: string;
  description: string | null;
  /** The token abuse guard behind the package. Not the headline any more. */
  credits: number;
  /**
   * Which models the package grants. `null` means every model; an array is an
   * exact list, so `[]` would be a deliberate lockout.
   */
  allowedModels: string[] | null;
  /**
   * Images this package includes, as a TOTAL for the subscription period rather
   * than a per-request cap. 0 = none, a number = that many, null = unlimited.
   */
  imageLimit: number | null;
  /** Term in days. null means the purchase does not expire. */
  durationDays: number | null;
  /** Minor units, so money stays integral: 89900 is 899.00. */
  priceMinor: number;
  currency: string;
  sortOrder: number;
  active: boolean;
}

export interface BillingSettings {
  configured: boolean;
  paymentInstructions: string | null;
  qrCodeUrl: string | null;
  paymentMethodLabel: string | null;
  currency: string;
}

export interface PaymentRequest {
  id: string;
  packageId: string | null;
  packageName: string;
  credits: number;
  amountMinor: number;
  currency: string;
  reference: string;
  email: string;
  status: PaymentStatus | string;
  reviewNote: string | null;
  receiptMime: string | null;
  receiptBytes: number | null;
  hasReceipt?: boolean;
  createdAt: string;
  reviewedAt: string | null;
  telegramStatus?: string | null;
}

export interface CreditAccount {
  id: string;
  name: string;
  email: string;
  status: AccountStatus | string;
  role: string;
  apiAccess: { allowed: boolean; reason: AccessReason };
}

export interface LedgerEntry {
  id: string;
  bucket: 'free' | 'paid' | string;
  kind: string;
  /** Always positive; `bucket` and the entry's direction say which way it moved. */
  amount: number;
  balanceAfter: number;
  reason: string;
  referenceType: string | null;
  referenceId: string | null;
  actorUserId: string | null;
  createdAt: string;
}

export interface CreditsOverview {
  account: CreditAccount;
  balance: CreditBalance;
  packages: CreditPackage[];
  billing: BillingSettings;
  payments: PaymentRequest[];
}

export interface AdminCreditCustomer {
  id: string;
  name: string;
  email: string;
  role: string;
  status: AccountStatus | string;
  createdAt: string;
  balance: CreditBalance;
  recentLedger: { id: string; bucket: string; kind: string; amount: number; createdAt: string }[];
}

export interface AdminCustomerList {
  customers: AdminCreditCustomer[];
  /** Every account on the platform. */
  total: number;
  /** How many accounts the current search found; equals `total` when idle. */
  matched: number;
  query: string;
  limit: number;
  offset: number;
}

export interface AdminPaymentRow {
  payment: PaymentRequest;
  customer: { id: string; name: string; email: string };
}
