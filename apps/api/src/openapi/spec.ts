import { MODEL_TIERS, modelDisplayName } from '@synzo/config';

/**
 * The OpenAPI 3.1 description of this API, written as code rather than kept as
 * a hand-maintained JSON file.
 *
 * A checked-in spec file drifts: routes change, the file does not, and the
 * documentation confidently describes endpoints that no longer exist. Building
 * the document from the same tier catalogue the runtime validates against
 * means a tier that is renamed cannot leave a stale label behind, and a route
 * that is deleted stops being advertised.
 */
export interface OpenApiDocument {
  openapi: string;
  info: {
    title: string;
    version: string;
    description: string;
  };
  servers: { url: string; description: string }[];
  tags: { name: string; description: string }[];
  paths: Record<string, Record<string, unknown>>;
  components: {
    securitySchemes: Record<string, unknown>;
    schemas: Record<string, unknown>;
  };
  security: { apiKeyAuth: never[] }[];
}

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
});

const json = (schema: unknown) => ({
  content: { 'application/json': { schema } },
});

/** Dashboard routes, authenticated by the session cookie from sign-in. */
const SESSION_SECURITY = [{ sessionCookie: [] }];
/** Inference routes, authenticated by an API key as a bearer token. */
const API_KEY_SECURITY = [{ apiKeyAuth: [] }];

const uuidParam = (name: string) => ({
  name,
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
});

const rangeParam = {
  name: 'range',
  in: 'query',
  schema: { type: 'string', enum: ['today', '7d', '30d', '90d', 'custom'], default: '30d' },
};

const schemas: Record<string, unknown> = {
  Error: {
    type: 'object',
    properties: {
      error: {
        type: 'object',
        required: ['message', 'type', 'code'],
        properties: {
          message: { type: 'string' },
          type: { type: 'string' },
          code: { type: 'string' },
          param: { type: ['string', 'null'] },
        },
      },
    },
  },

  User: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      email: { type: 'string', format: 'email' },
      name: { type: 'string' },
      role: { type: 'string', enum: ['customer', 'admin'] },
      status: { type: 'string', enum: ['active', 'suspended', 'pending'] },
      emailVerified: { type: 'boolean' },
      unlimitedMode: { type: 'boolean' },
      allowLiveKeys: { type: 'boolean' },
      createdAt: { type: 'string', format: 'date-time' },
      lastLoginAt: { type: ['string', 'null'], format: 'date-time' },
    },
  },

  Limits: {
    type: 'object',
    properties: {
      userId: { type: 'string', format: 'uuid' },
      requestsPerMinute: { type: 'integer' },
      requestsPerDay: { type: 'integer' },
      tokensPerDay: { type: 'integer' },
      maxConcurrentRequests: { type: 'integer' },
      allowedModels: {
        type: ['array', 'null'],
        items: { type: 'string' },
        description: 'Null means every enabled model is allowed.',
      },
    },
  },

  Project: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      userId: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      description: { type: ['string', 'null'] },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },

  ApiKey: {
    type: 'object',
    description: 'Key metadata. The secret is returned exactly once, on creation.',
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      keyPrefix: { type: 'string', description: 'First 12 characters, for display only.' },
      environment: { type: 'string', enum: ['test', 'live'] },
      projectId: { type: 'string', format: 'uuid' },
      status: { type: 'string', enum: ['active', 'disabled', 'revoked'] },
      expiresAt: { type: ['string', 'null'], format: 'date-time' },
      lastUsedAt: { type: ['string', 'null'], format: 'date-time' },
      requestCount: { type: 'integer' },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },

  Model: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      publicName: { type: 'string', description: 'What a customer sends as `model`.' },
      label: { type: 'string', description: 'Display name, e.g. "GPT-6 Astra".' },
      description: { type: 'string' },
      provider: { type: 'string' },
      enabled: { type: 'boolean' },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },

  ChatMessage: {
    type: 'object',
    required: ['role'],
    properties: {
      role: { type: 'string', enum: ['system', 'user', 'assistant', 'tool'] },
      content: {
        type: ['string', 'null'],
        description:
          'Null on an assistant turn that only requests tool calls, which is what ' +
          'OpenAI clients send and expect back.',
      },
      name: { type: 'string' },
      tool_call_id: {
        type: 'string',
        description: 'Required on a `role: "tool"` message, to match the earlier tool call.',
      },
      tool_calls: {
        type: 'array',
        items: { $ref: '#/components/schemas/ToolCall' },
        description: 'Present on an assistant turn that requests tools.',
      },
    },
  },

  ToolCall: {
    type: 'object',
    required: ['id', 'type', 'function'],
    properties: {
      index: { type: 'integer' },
      id: { type: 'string' },
      type: { type: 'string', const: 'function' },
      function: {
        type: 'object',
        required: ['name', 'arguments'],
        properties: {
          name: { type: 'string' },
          arguments: {
            type: 'string',
            description: 'A JSON-encoded string. You decode it, then run the tool.',
          },
        },
      },
    },
  },

  FunctionTool: {
    type: 'object',
    required: ['type', 'function'],
    properties: {
      type: { type: 'string', const: 'function' },
      function: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          parameters: { type: 'object', description: 'A JSON Schema object.', additionalProperties: true },
        },
      },
    },
  },

  ToolChoice: {
    description: 'How the model must choose a tool.',
    oneOf: [
      { type: 'string', enum: ['none', 'auto', 'required'] },
      {
        type: 'object',
        required: ['type', 'function'],
        properties: {
          type: { type: 'string', const: 'function' },
          function: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
        },
      },
    ],
  },

  ChatCompletionRequest: {
    type: 'object',
    required: ['model', 'messages'],
    properties: {
      model: {
        type: 'string',
        description:
          'A model name. Use the display name returned by `/v1/models` (e.g. "GPT-6 Astra"); ' +
          'the tier name (' + MODEL_TIERS.map((t) => `\`${t.tier}\``).join(', ') + ') is accepted as an alias for the same model.',
        examples: ['GPT-6 Astra', 'max'],
      },
      messages: { type: 'array', items: { $ref: '#/components/schemas/ChatMessage' } },
      stream: { type: 'boolean', default: false },
      max_tokens: { type: 'integer', minimum: 1 },
      tools: {
        type: 'array',
        items: { $ref: '#/components/schemas/FunctionTool' },
        description:
          'Tools the model may call. Supported on both the streaming and non-streaming ' +
          'paths. Send a `role: "tool"` message carrying `tool_call_id` to return a result.',
      },
      tool_choice: { $ref: '#/components/schemas/ToolChoice' },
    },
  },

  ChatCompletion: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      object: { type: 'string', const: 'chat.completion' },
      created: { type: 'integer' },
      model: { type: 'string', description: 'Echoes the tier name you requested.' },
      choices: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer' },
            message: { $ref: '#/components/schemas/ChatMessage' },
            finish_reason: { type: ['string', 'null'] },
          },
        },
      },
      usage: {
        type: 'object',
        properties: {
          prompt_tokens: { type: 'integer' },
          completion_tokens: { type: 'integer' },
          total_tokens: { type: 'integer' },
        },
      },
    },
  },

  RequestLogEntry: {
    type: 'object',
    properties: {
      requestId: { type: 'string' },
      modelName: { type: 'string' },
      provider: { type: 'string' },
      status: { type: 'string', enum: ['success', 'error', 'cancelled'] },
      httpStatus: { type: 'integer' },
      stream: { type: 'boolean' },
      promptTokens: { type: ['integer', 'null'] },
      completionTokens: { type: ['integer', 'null'] },
      totalTokens: { type: ['integer', 'null'] },
      latencyMs: { type: 'integer' },
      errorType: { type: ['string', 'null'] },
      errorCode: { type: ['string', 'null'] },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },

  ProviderHealth: {
    type: 'object',
    properties: {
      provider: { type: 'string' },
      healthy: { type: 'boolean' },
      latencyMs: { type: ['integer', 'null'] },
      checkedAt: { type: 'string', format: 'date-time' },
      detail: { type: ['string', 'null'] },
    },
  },

  UsageStats: {
    type: 'object',
    properties: {
      requests: { type: 'integer' },
      successfulRequests: { type: 'integer' },
      failedRequests: { type: 'integer' },
      promptTokens: { type: 'integer' },
      completionTokens: { type: 'integer' },
      totalTokens: { type: 'integer' },
      avgLatencyMs: { type: 'number' },
    },
  },
};

const TIER_LIST = MODEL_TIERS.map((t) => `\`${modelDisplayName(t.tier)}\` (alias \`${t.tier}\`)`).join(', ');

/**
 * Builds the document. `serverUrl` is the origin the customer reached us on, so
 * "Try it out" in Swagger UI targets the domain they are actually using rather
 * than localhost.
 */
export interface OpenApiOptions {
  /** Origin the customer reached the API on, used by "Try it out". */
  serverUrl: string;
  /** Reported as `info.version`. */
  version: string;
  /**
   * The session cookie's real name, from config.
   *
   * Passed in rather than written down, because a spec that names a cookie the
   * server does not read is worse than no spec: a customer following it is
   * told their sign-in silently does not carry.
   */
  sessionCookieName: string;
}

export function buildOpenApiSpec(options: OpenApiOptions): OpenApiDocument {
  const { serverUrl, version, sessionCookieName } = options;
  const paths: Record<string, Record<string, unknown>> = {
    /* ------------------------------------------------ OpenAI-compatible */
    '/v1/chat/completions': {
      post: {
        tags: ['Inference'],
        summary: 'Create a chat completion',
        description:
          'OpenAI-compatible. Send `stream: true` for Server-Sent Events: the response is ' +
          'a sequence of `chat.completion.chunk` frames terminated by `data: [DONE]`.',
        security: API_KEY_SECURITY,
        requestBody: {
          required: true,
          ...json({ $ref: '#/components/schemas/ChatCompletionRequest' }),
        },
        responses: {
          200: {
            description: 'A completion, or an SSE stream when `stream` is true.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ChatCompletion' } },
              'text/event-stream': { schema: { type: 'string' } },
            },
          },
          400: errorResponse('The request failed validation.'),
          401: errorResponse('The API key is missing, unknown, revoked or expired.'),
          404: errorResponse('The model does not exist, or is not available on this key.'),
          429: errorResponse('A rate limit or quota was exceeded.'),
          502: {
            description:
              'The upstream provider failed. The `code` distinguishes an unavailable ' +
              'provider from a credential rejection (`upstream_authentication_failed`), ' +
              'which is a server configuration issue rather than a customer error.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
          504: errorResponse('The upstream provider timed out.'),
        },
      },
    },

    '/v1/models': {
      get: {
        tags: ['Inference'],
        summary: 'List the models this key may call',
        security: API_KEY_SECURITY,
        responses: {
          200: {
            description: 'An OpenAI-shaped model list.',
            ...json({
              type: 'object',
              properties: {
                object: { type: 'string', const: 'list' },
                data: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string', description: 'Display name, e.g. "GPT-6 Astra". Accepted verbatim as `model`.' },
                      object: { type: 'string' },
                      created: { type: 'integer' },
                      owned_by: { type: 'string' },
                      sinki_tier: {
                        type: 'string',
                        description: 'Tier alias for the same model, e.g. "max". Also accepted as `model`.',
                      },
                    },
                  },
                },
              },
            }),
          },
          401: errorResponse('The API key is missing or invalid.'),
        },
      },
    },

    '/v1/models/{model}': {
      get: {
        tags: ['Inference'],
        summary: 'Retrieve one model',
        security: API_KEY_SECURITY,
        parameters: [{ name: 'model', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'The model.', ...json({ type: 'object' }) },
          404: errorResponse('The model does not exist.'),
        },
      },
    },

    /* ------------------------------------------------------------ system */
    '/health': {
      get: {
        tags: ['System'],
        summary: 'Liveness probe',
        description:
          'Never touches a dependency, so a brief database blip does not make an ' +
          'orchestrator restart a healthy process.',
        responses: { 200: { description: 'The process is alive.', ...json({ type: 'object' }) } },
      },
    },
    '/ready': {
      get: {
        tags: ['System'],
        summary: 'Readiness probe',
        description: 'Checks PostgreSQL, Redis and the provider. Answers 503 when one is down.',
        responses: {
          200: { description: 'Every dependency is reachable.', ...json({ type: 'object' }) },
          503: { description: 'A dependency is unavailable.', ...json({ type: 'object' }) },
        },
      },
    },
    '/version': {
      get: {
        tags: ['System'],
        summary: 'Build information',
        responses: { 200: { description: 'Version and environment.', ...json({ type: 'object' }) } },
      },
    },
    '/metrics': {
      get: {
        tags: ['System'],
        summary: 'Prometheus metrics',
        description:
          'Prometheus text exposition format. Restricted to loopback callers, an admin ' +
          'session, or a bearer token matching `METRICS_TOKEN`: the public tunnel makes ' +
          'this port reachable from anywhere, so it is never world-readable by default.',
        security: [],
        responses: {
          200: {
            description: 'Metrics in the Prometheus text format.',
            content: { 'text/plain': { schema: { type: 'string' } } },
          },
          401: errorResponse('Not loopback, not an admin, and no valid token.'),
        },
      },
    },
    '/openapi.json': {
      get: {
        tags: ['System'],
        summary: 'This document',
        security: [],
        responses: {
          200: { description: 'The OpenAPI 3.1 description.', ...json({ type: 'object' }) },
        },
      },
    },

    /* -------------------------------------------------------------- auth */
    '/api/auth/register': {
      post: {
        tags: ['Auth'],
        summary: 'Create an account',
        security: [],
        requestBody: {
          required: true,
          ...json({
            type: 'object',
            required: ['email', 'name', 'password'],
            properties: {
              email: { type: 'string', format: 'email' },
              name: { type: 'string' },
              password: { type: 'string', minLength: 8 },
            },
          }),
        },
        responses: {
          201: { description: 'Created, and a session was issued.', ...json({ type: 'object' }) },
          409: errorResponse('That email is already registered.'),
        },
      },
    },
    '/api/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Sign in',
        security: [],
        requestBody: {
          required: true,
          ...json({
            type: 'object',
            required: ['email', 'password'],
            properties: { email: { type: 'string', format: 'email' }, password: { type: 'string' } },
          }),
        },
        responses: {
          200: { description: 'Signed in; a session cookie is set.', ...json({ type: 'object' }) },
          401: errorResponse('The email or password is wrong.'),
          429: errorResponse('Too many attempts from this address.'),
        },
      },
    },
    '/api/auth/logout': {
      post: {
        tags: ['Auth'],
        summary: 'Sign out',
        security: SESSION_SECURITY,
        responses: { 200: { description: 'The session was revoked.', ...json({ type: 'object' }) } },
      },
    },
    '/api/me': {
      get: {
        tags: ['Auth'],
        summary: 'The signed-in account, its limits, and today’s token usage',
        security: SESSION_SECURITY,
        responses: {
          200: { description: 'Current account.', ...json({ type: 'object' }) },
          401: errorResponse('Not signed in.'),
        },
      },
    },
    '/api/me/password': {
      post: {
        tags: ['Auth'],
        summary: 'Change the password',
        description: 'Invalidates every session, including this one.',
        security: SESSION_SECURITY,
        requestBody: {
          required: true,
          ...json({
            type: 'object',
            required: ['currentPassword', 'newPassword'],
            properties: {
              currentPassword: { type: 'string' },
              newPassword: { type: 'string', minLength: 8 },
            },
          }),
        },
        responses: {
          200: { description: 'Password changed.', ...json({ type: 'object' }) },
          401: errorResponse('The current password is wrong.'),
        },
      },
    },
    '/api/auth/password/forgot': {
      post: {
        tags: ['Auth'],
        summary: 'Request a password-reset link',
        description:
          'Responds identically whether or not the address exists, so it cannot be used to ' +
          'enumerate accounts.',
        security: [],
        requestBody: {
          required: true,
          ...json({ type: 'object', properties: { email: { type: 'string', format: 'email' } } }),
        },
        responses: {
          200: { description: 'If the address exists, a link has been sent.', ...json({ type: 'object' }) },
        },
      },
    },
    '/api/auth/password/reset': {
      post: {
        tags: ['Auth'],
        summary: 'Complete a password reset',
        security: [],
        requestBody: {
          required: true,
          ...json({
            type: 'object',
            properties: { token: { type: 'string' }, password: { type: 'string', minLength: 8 } },
          }),
        },
        responses: {
          200: { description: 'Password reset.', ...json({ type: 'object' }) },
          400: errorResponse('The token is invalid or has expired.'),
        },
      },
    },
    '/api/auth/email/verify': {
      post: {
        tags: ['Auth'],
        summary: 'Verify an email address',
        security: [],
        requestBody: {
          required: true,
          ...json({ type: 'object', properties: { token: { type: 'string' } } }),
        },
        responses: {
          200: { description: 'Email verified.', ...json({ type: 'object' }) },
          400: errorResponse('The token is invalid or has expired.'),
        },
      },
    },
    '/api/auth/email/resend': {
      post: {
        tags: ['Auth'],
        summary: 'Resend the verification email',
        security: SESSION_SECURITY,
        responses: {
          200: { description: 'Sent if the address is still unverified.', ...json({ type: 'object' }) },
        },
      },
    },

    /* ---------------------------------------------------------- projects */
    '/api/projects': {
      get: {
        tags: ['Projects'],
        summary: 'List your projects',
        security: SESSION_SECURITY,
        responses: { 200: { description: 'Your projects.', ...json({ type: 'object' }) } },
      },
      post: {
        tags: ['Projects'],
        summary: 'Create a project',
        security: SESSION_SECURITY,
        requestBody: {
          required: true,
          ...json({
            type: 'object',
            required: ['name'],
            properties: { name: { type: 'string' }, description: { type: 'string' } },
          }),
        },
        responses: { 201: { description: 'Created.', ...json({ type: 'object' }) } },
      },
    },
    '/api/projects/{id}': {
      get: {
        tags: ['Projects'],
        summary: 'Retrieve a project',
        security: SESSION_SECURITY,
        parameters: [uuidParam('id')],
        responses: {
          200: { description: 'The project.', ...json({ $ref: '#/components/schemas/Project' }) },
          404: errorResponse('Not found, or not yours. The two are deliberately indistinguishable.'),
        },
      },
      patch: {
        tags: ['Projects'],
        summary: 'Update a project',
        security: SESSION_SECURITY,
        parameters: [uuidParam('id')],
        requestBody: {
          required: true,
          ...json({
            type: 'object',
            properties: { name: { type: 'string' }, description: { type: ['string', 'null'] } },
          }),
        },
        responses: {
          200: { description: 'Updated.', ...json({ type: 'object' }) },
          404: errorResponse('Not found, or not yours.'),
        },
      },
      delete: {
        tags: ['Projects'],
        summary: 'Delete a project',
        security: SESSION_SECURITY,
        parameters: [uuidParam('id')],
        responses: {
          204: { description: 'Deleted.' },
          404: errorResponse('Not found, or not yours.'),
        },
      },
    },

    /* --------------------------------------------------------- api keys */
    '/api/keys': {
      get: {
        tags: ['API keys'],
        summary: 'List your keys',
        security: SESSION_SECURITY,
        responses: {
          200: {
            description: 'Key metadata, plus whether you may create live keys.',
            ...json({ type: 'object' }),
          },
        },
      },
      post: {
        tags: ['API keys'],
        summary: 'Create a key',
        description:
          'The secret is in this response and nowhere else. It is not recoverable ' +
          'afterwards, so store it when it is issued.',
        security: SESSION_SECURITY,
        requestBody: {
          required: true,
          ...json({
            type: 'object',
            required: ['projectId', 'name', 'environment'],
            properties: {
              projectId: { type: 'string', format: 'uuid' },
              name: { type: 'string' },
              environment: { type: 'string', enum: ['test', 'live'] },
              expiresInDays: { type: 'integer', minimum: 1 },
            },
          }),
        },
        responses: {
          201: { description: 'The key, and its secret, once.', ...json({ type: 'object' }) },
          403: errorResponse('Live keys require admin approval.'),
          404: errorResponse('The project does not exist, or is not yours.'),
        },
      },
    },
    '/api/keys/{id}': {
      delete: {
        tags: ['API keys'],
        summary: 'Delete a key',
        security: SESSION_SECURITY,
        parameters: [uuidParam('id')],
        responses: {
          204: { description: 'Deleted.' },
          404: errorResponse('Not found, or not yours.'),
        },
      },
    },
    '/api/keys/{id}/revoke': {
      post: {
        tags: ['API keys'],
        summary: 'Revoke a key permanently',
        description: 'A revoked key cannot be re-enabled; a new one must be created.',
        security: SESSION_SECURITY,
        parameters: [uuidParam('id')],
        responses: { 200: { description: 'Revoked.', ...json({ type: 'object' }) } },
      },
    },
    '/api/keys/{id}/status': {
      post: {
        tags: ['API keys'],
        summary: 'Enable or disable a key',
        security: SESSION_SECURITY,
        parameters: [uuidParam('id')],
        requestBody: {
          required: true,
          ...json({ type: 'object', properties: { status: { type: 'string', enum: ['active', 'disabled'] } } }),
        },
        responses: {
          200: { description: 'Updated.', ...json({ type: 'object' }) },
          409: errorResponse('A revoked key cannot be re-enabled.'),
        },
      },
    },

    /* ---------------------------------------------------- models, usage */
    '/api/models': {
      get: {
        tags: ['Models'],
        summary: 'The models you may call',
        description: 'Admins additionally receive the full registry, including disabled entries.',
        security: SESSION_SECURITY,
        responses: { 200: { description: 'Your catalogue.', ...json({ type: 'object' }) } },
      },
    },
    '/api/usage': {
      get: {
        tags: ['Usage'],
        summary: 'Token and request usage over a range',
        security: SESSION_SECURITY,
        parameters: [rangeParam],
        responses: {
          200: {
            description: 'Totals, a daily series, and a per-model breakdown.',
            ...json({ type: 'object' }),
          },
        },
      },
    },
    '/api/requests': {
      get: {
        tags: ['Usage'],
        summary: 'Request log',
        security: SESSION_SECURITY,
        parameters: [
          rangeParam,
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['success', 'error', 'cancelled'] } },
          { name: 'model', in: 'query', schema: { type: 'string' } },
          { name: 'projectId', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 200 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
        ],
        responses: {
          200: { description: 'Matching requests, newest first.', ...json({ type: 'object' }) },
        },
      },
    },
    '/api/overview': {
      get: {
        tags: ['Usage'],
        summary: 'Headline counters for the dashboard landing page',
        security: SESSION_SECURITY,
        responses: {
          200: {
            description: 'Stats, key counts, project count and enabled models.',
            ...json({ type: 'object' }),
          },
        },
      },
    },

    /* ------------------------------------------------------------- admin */
    '/api/admin/customers': {
      get: {
        tags: ['Admin'],
        summary: 'List customers',
        security: SESSION_SECURITY,
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 100, maximum: 500 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
        ],
        responses: {
          200: { description: 'Customers.', ...json({ type: 'object' }) },
          403: errorResponse('Admin only.'),
        },
      },
    },
    '/api/admin/customers/{id}': {
      patch: {
        tags: ['Admin'],
        summary: 'Update a customer',
        description:
          'An admin cannot demote or suspend themselves, which would leave the platform ' +
          'with nobody able to administer it.',
        security: SESSION_SECURITY,
        parameters: [uuidParam('id')],
        requestBody: {
          required: true,
          ...json({
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['active', 'suspended'] },
              unlimitedMode: { type: 'boolean', description: 'Bypasses rate limits and quotas.' },
              allowLiveKeys: { type: 'boolean' },
              role: { type: 'string', enum: ['customer', 'admin'] },
            },
          }),
        },
        responses: {
          200: { description: 'Updated.', ...json({ type: 'object' }) },
          403: errorResponse('Admin only.'),
        },
      },
    },
    '/api/admin/customers/{id}/limits': {
      get: {
        tags: ['Admin'],
        summary: 'Read a customer’s limits',
        security: SESSION_SECURITY,
        parameters: [uuidParam('id')],
        responses: {
          200: { description: 'Limits.', ...json({ type: 'object' }) },
          403: errorResponse('Admin only.'),
        },
      },
      patch: {
        tags: ['Admin'],
        summary: 'Change a customer’s limits',
        security: SESSION_SECURITY,
        parameters: [uuidParam('id')],
        requestBody: {
          required: true,
          ...json({
            type: 'object',
            properties: {
              requestsPerMinute: { type: 'integer', minimum: 1 },
              requestsPerDay: { type: 'integer', minimum: 1 },
              tokensPerDay: { type: 'integer', minimum: 1 },
              maxConcurrentRequests: { type: 'integer', minimum: 1 },
              allowedModels: { type: ['array', 'null'], items: { type: 'string' } },
            },
          }),
        },
        responses: {
          200: { description: 'Updated.', ...json({ type: 'object' }) },
          403: errorResponse('Admin only.'),
        },
      },
    },
    '/api/admin/models': {
      get: {
        tags: ['Admin'],
        summary: 'The full model registry',
        security: SESSION_SECURITY,
        responses: {
          200: { description: 'Models and providers.', ...json({ type: 'object' }) },
          403: errorResponse('Admin only.'),
        },
      },
    },
    '/api/admin/models/{id}': {
      patch: {
        tags: ['Admin'],
        summary: 'Enable or disable a model',
        security: SESSION_SECURITY,
        parameters: [uuidParam('id')],
        requestBody: {
          required: true,
          ...json({ type: 'object', properties: { enabled: { type: 'boolean' } } }),
        },
        responses: {
          200: { description: 'Updated.', ...json({ type: 'object' }) },
          403: errorResponse('Admin only.'),
        },
      },
    },
    '/api/admin/system/usage': {
      get: {
        tags: ['Admin'],
        summary: 'Platform-wide totals',
        security: SESSION_SECURITY,
        responses: {
          200: { description: 'Totals across every customer.', ...json({ type: 'object' }) },
          403: errorResponse('Admin only.'),
        },
      },
    },
    '/api/admin/errors': {
      get: {
        tags: ['Admin'],
        summary: 'Recent failures',
        security: SESSION_SECURITY,
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 200 } }],
        responses: {
          200: { description: 'Failed requests, newest first.', ...json({ type: 'object' }) },
          403: errorResponse('Admin only.'),
        },
      },
    },
    '/api/admin/providers/health': {
      get: {
        tags: ['Admin'],
        summary: 'Provider health',
        security: SESSION_SECURITY,
        responses: {
          200: {
            description: 'The last observation for each provider.',
            ...json({
              type: 'object',
              properties: {
                health: { type: 'array', items: { $ref: '#/components/schemas/ProviderHealth' } },
              },
            }),
          },
          403: errorResponse('Admin only.'),
        },
      },
    },
    '/api/admin/audit': {
      get: {
        tags: ['Admin'],
        summary: 'Audit log',
        security: SESSION_SECURITY,
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 200, maximum: 1000 } }],
        responses: {
          200: { description: 'Audit entries, newest first.', ...json({ type: 'object' }) },
          403: errorResponse('Admin only.'),
        },
      },
    },
    '/api/admin/metrics': {
      get: {
        tags: ['Admin'],
        summary: 'Live operational metrics, pre-parsed for the dashboard',
        description: 'The same registry `GET /metrics` exposes, summarised as JSON.',
        security: SESSION_SECURITY,
        responses: {
          200: {
            description: 'Request counts, error rate, latency quantiles and provider status.',
            ...json({ type: 'object' }),
          },
          403: errorResponse('Admin only.'),
        },
      },
    },
  };

  return {
    openapi: '3.1.0',
    info: {
      title: 'Synzo API',
      version,
      description:
        'An OpenAI-compatible AI API with per-customer keys, projects, usage reporting ' +
        'and rate limits.\n\n' +
        '**Authentication.** Two schemes, for two surfaces. Dashboard routes use the ' +
        'session cookie set at sign-in. Inference routes use an API key as a bearer ' +
        'token.\n\n' +
        '**Tiers.** Send `model` as one of: ' + TIER_LIST + '. The tier you ask for is ' +
        'the tier that is served and the name that comes back; the provider’s own ' +
        'model naming is not part of this contract.',
    },
    servers: [{ url: serverUrl, description: 'This deployment' }],
    tags: [
      { name: 'Inference', description: 'OpenAI-compatible endpoints, authenticated with an API key.' },
      { name: 'Auth', description: 'Accounts and sessions, authenticated with a session cookie.' },
      { name: 'Projects', description: 'Grouping for keys and reporting.' },
      { name: 'API keys', description: 'Key lifecycle. Secrets are shown once, on creation.' },
      { name: 'Models', description: 'The catalogue a key may call.' },
      { name: 'Usage', description: 'Token and request reporting.' },
      { name: 'Admin', description: 'Operator surface. Admin role required.' },
      { name: 'System', description: 'Health, version and metrics.' },
    ],
    paths,
    components: {
      securitySchemes: {
        apiKeyAuth: {
          type: 'http',
          scheme: 'bearer',
          description:
            'An API key, `sk_test_…` or `sk_live_…`. The key cannot be recovered ' +
            'after creation, so store it when it is issued.',
        },
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: sessionCookieName,
          description: 'The session cookie set by `POST /api/auth/login`.',
        },
      },
      schemas,
    },
    security: [{ apiKeyAuth: [] }],
  };
}
