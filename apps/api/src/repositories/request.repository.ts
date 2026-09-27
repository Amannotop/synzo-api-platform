import { and, count, desc, eq, gte, lte, sql, sum } from 'drizzle-orm';
import type { Database } from '@synzo/database';
import { models, requests, usageDaily } from '@synzo/database';

export interface RecordRequestInput {
  requestId: string;
  userId: string;
  projectId: string;
  apiKeyId: string | null;
  modelId: string | null;
  modelName: string;
  provider: string;
  status: 'success' | 'error' | 'cancelled';
  httpStatus: number;
  stream: boolean;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  upstreamCost: number | null;
  currency: string | null;
  latencyMs: number;
  errorType?: string | null;
  errorCode?: string | null;
  requestContent?: string | null;
}

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export class RequestRepository {
  constructor(private readonly db: Database) {}

  /**
   * Persists one request plus its daily rollup in a single transaction, so a
   * dashboard chart can never disagree with the request log.
   */
  async record(input: RecordRequestInput): Promise<void> {
    const created = new Date();
    const day = utcDay(created);
    const prompt = input.promptTokens ?? 0;
    const completion = input.completionTokens ?? 0;
    const total = input.totalTokens ?? 0;

    await this.db.transaction(async (tx) => {
      await tx.insert(requests).values({
        requestId: input.requestId,
        userId: input.userId,
        projectId: input.projectId,
        apiKeyId: input.apiKeyId,
        modelId: input.modelId,
        modelName: input.modelName,
        provider: input.provider,
        status: input.status,
        httpStatus: input.httpStatus,
        stream: input.stream,
        promptTokens: input.promptTokens,
        completionTokens: input.completionTokens,
        totalTokens: input.totalTokens,
        upstreamCost: input.upstreamCost === null ? null : String(input.upstreamCost),
        currency: input.currency,
        latencyMs: input.latencyMs,
        errorType: input.errorType ?? null,
        errorCode: input.errorCode ?? null,
        requestContent: input.requestContent ?? null,
        createdAt: created,
      });

      await tx
        .insert(usageDaily)
        .values({
          userId: input.userId,
          projectId: input.projectId,
          modelName: input.modelName,
          day,
          requests: 1,
          successfulRequests: input.status === 'success' ? 1 : 0,
          failedRequests: input.status === 'error' ? 1 : 0,
          promptTokens: prompt,
          completionTokens: completion,
          totalTokens: total,
          upstreamCost: String(input.upstreamCost ?? 0),
          totalLatencyMs: input.latencyMs,
        })
        .onConflictDoUpdate({
          target: [usageDaily.userId, usageDaily.projectId, usageDaily.modelName, usageDaily.day],
          set: {
            requests: sql`${usageDaily.requests} + 1`,
            successfulRequests: sql`${usageDaily.successfulRequests} + ${input.status === 'success' ? 1 : 0}`,
            failedRequests: sql`${usageDaily.failedRequests} + ${input.status === 'error' ? 1 : 0}`,
            promptTokens: sql`${usageDaily.promptTokens} + ${prompt}`,
            completionTokens: sql`${usageDaily.completionTokens} + ${completion}`,
            totalTokens: sql`${usageDaily.totalTokens} + ${total}`,
            upstreamCost: sql`${usageDaily.upstreamCost} + ${input.upstreamCost ?? 0}`,
            totalLatencyMs: sql`${usageDaily.totalLatencyMs} + ${input.latencyMs}`,
            updatedAt: new Date(),
          },
        });
    });
  }

  /** Tenant-scoped request log (§28). */
  async listForUser(
    userId: string,
    opts: {
      from?: Date;
      to?: Date;
      status?: 'success' | 'error';
      model?: string;
      projectId?: string;
      limit: number;
      offset: number;
    },
  ) {
    const conds = [eq(requests.userId, userId)];
    if (opts.from) conds.push(gte(requests.createdAt, opts.from));
    if (opts.to) conds.push(lte(requests.createdAt, opts.to));
    if (opts.status) conds.push(eq(requests.status, opts.status));
    if (opts.model) conds.push(eq(requests.modelName, opts.model));
    if (opts.projectId) conds.push(eq(requests.projectId, opts.projectId));

    return this.db
      .select({
        requestId: requests.requestId,
        createdAt: requests.createdAt,
        model: requests.modelName,
        status: requests.status,
        httpStatus: requests.httpStatus,
        latencyMs: requests.latencyMs,
        totalTokens: requests.totalTokens,
        stream: requests.stream,
        errorCode: requests.errorCode,
      })
      .from(requests)
      .where(and(...conds))
      .orderBy(desc(requests.createdAt))
      .limit(opts.limit)
      .offset(opts.offset);
  }

  async countForUser(userId: string, opts: { from?: Date; to?: Date }): Promise<number> {
    const conds = [eq(requests.userId, userId)];
    if (opts.from) conds.push(gte(requests.createdAt, opts.from));
    if (opts.to) conds.push(lte(requests.createdAt, opts.to));
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(requests)
      .where(and(...conds));
    return rows[0]?.n ?? 0;
  }

  /** Headline dashboard statistics (§25). All real data; zeros stay zeros. */
  async statsForUser(userId: string, from?: Date, to?: Date) {
    const conds = [eq(requests.userId, userId)];
    if (from) conds.push(gte(requests.createdAt, from));
    if (to) conds.push(lte(requests.createdAt, to));

    const rows = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        successful: sql<number>`count(*) filter (where ${requests.status} = 'success')::int`,
        failed: sql<number>`count(*) filter (where ${requests.status} = 'error')::int`,
        promptTokens: sql<number>`coalesce(sum(${requests.promptTokens}), 0)::int`,
        completionTokens: sql<number>`coalesce(sum(${requests.completionTokens}), 0)::int`,
        totalTokens: sql<number>`coalesce(sum(${requests.totalTokens}), 0)::int`,
        avgLatency: sql<number>`coalesce(avg(${requests.latencyMs}), 0)::int`,
        maxLatency: sql<number>`coalesce(max(${requests.latencyMs}), 0)::int`,
      })
      .from(requests)
      .where(and(...conds));

    const r = rows[0];
    return {
      totalRequests: r?.total ?? 0,
      successfulRequests: r?.successful ?? 0,
      failedRequests: r?.failed ?? 0,
      promptTokens: r?.promptTokens ?? 0,
      completionTokens: r?.completionTokens ?? 0,
      totalTokens: r?.totalTokens ?? 0,
      avgLatencyMs: r?.avgLatency ?? 0,
      maxLatencyMs: r?.maxLatency ?? 0,
    };
  }

  /** Per-day series for the usage charts (§25, §27). */
  async dailySeries(userId: string, from: Date, to: Date) {
    return this.db
      .select({
        day: usageDaily.day,
        requests: sql<number>`sum(${usageDaily.requests})::int`,
        successful: sql<number>`sum(${usageDaily.successfulRequests})::int`,
        failed: sql<number>`sum(${usageDaily.failedRequests})::int`,
        promptTokens: sql<number>`sum(${usageDaily.promptTokens})::int`,
        completionTokens: sql<number>`sum(${usageDaily.completionTokens})::int`,
        totalTokens: sql<number>`sum(${usageDaily.totalTokens})::int`,
        avgLatency: sql<number>`coalesce(
          (sum(${usageDaily.totalLatencyMs}) / nullif(sum(${usageDaily.requests}), 0))::int, 0
        )`,
      })
      .from(usageDaily)
      .where(
        and(
          eq(usageDaily.userId, userId),
          gte(usageDaily.day, utcDay(from)),
          lte(usageDaily.day, utcDay(to)),
        ),
      )
      .groupBy(usageDaily.day)
      .orderBy(usageDaily.day);
  }

  /** Usage split by model, for the "model usage" chart. */
  async usageByModel(userId: string, from: Date, to: Date) {
    return this.db
      .select({
        model: usageDaily.modelName,
        requests: sql<number>`sum(${usageDaily.requests})::int`,
        totalTokens: sql<number>`sum(${usageDaily.totalTokens})::int`,
        upstreamCost: sql<string>`coalesce(sum(${usageDaily.upstreamCost}), 0)::text`,
      })
      .from(usageDaily)
      .where(
        and(
          eq(usageDaily.userId, userId),
          gte(usageDaily.day, utcDay(from)),
          lte(usageDaily.day, utcDay(to)),
        ),
      )
      .groupBy(usageDaily.modelName)
      .orderBy(desc(sql`sum(${usageDaily.requests})`));
  }
}
