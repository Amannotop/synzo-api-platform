import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().email('a valid email is required').max(320).toLowerCase().trim(),
  password: z.string().min(10, 'password must be at least 10 characters'),
  name: z.string().min(1, 'name is required').max(120),
});

export const loginSchema = z.object({
  email: z.string().email().max(320).toLowerCase().trim(),
  password: z.string().min(1, 'password is required'),
});

export const createApiKeySchema = z
  .object({
    name: z.string().min(1, 'name is required').max(100),
    projectId: z.string().uuid('projectId must be a valid id'),
    environment: z.enum(['live', 'test']).default('test'),
    expiresInDays: z.coerce.number().int().min(1).max(3650).optional(),
  })
  .strict();

export const createProjectSchema = z.object({
  name: z.string().min(1, 'name is required').max(100),
  description: z.string().max(500).optional(),
});

export const updateProjectSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    description: z.string().max(500).nullable().optional(),
  })
  .refine((v) => v.name !== undefined || v.description !== undefined, {
    message: 'at least one field must be provided',
  });

export const updateKeyStatusSchema = z.object({
  status: z.enum(['active', 'disabled']),
});

export const usageQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  range: z.enum(['today', '7d', '30d', '90d', 'custom']).default('30d'),
  projectId: z.string().uuid().optional(),
  model: z.string().max(200).optional(),
});

export const requestsQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  range: z.enum(['today', '7d', '30d', '90d', 'custom']).default('7d'),
  status: z.enum(['success', 'error']).optional(),
  model: z.string().max(200).optional(),
  projectId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const adminUpdateLimitsSchema = z
  .object({
    requestsPerMinute: z.coerce.number().int().min(1).max(1_000_000).optional(),
    requestsPerDay: z.coerce.number().int().min(1).max(1_000_000_000).optional(),
    tokensPerDay: z.coerce.number().int().min(1).max(10_000_000_000).optional(),
    maxConcurrentRequests: z.coerce.number().int().min(1).max(10_000).optional(),
    unlimitedMode: z.boolean().optional(),
    allowLiveKeys: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'at least one limit must be provided',
  });

export const adminUpdateUserSchema = z.object({
  status: z.enum(['active', 'suspended']).optional(),
  unlimitedMode: z.boolean().optional(),
  allowLiveKeys: z.boolean().optional(),
  role: z.enum(['customer', 'admin']).optional(),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;
export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UsageQuery = z.infer<typeof usageQuerySchema>;
export type RequestsQuery = z.infer<typeof requestsQuerySchema>;
