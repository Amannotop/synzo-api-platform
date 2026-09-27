/**
 * Works out the public origin a customer actually reached us on.
 *
 * Reset and verification emails embed a link with a one-time token in it. A
 * link built from `http://localhost:5173` is dead on arrival for anyone who is
 * not sitting at the developer's desk, so the origin is derived from the
 * incoming request instead of being a fixed string in the environment.
 *
 * Deriving it from the request introduces a security question, because a
 * caller fully controls the headers used to build the answer. Two rules keep
 * that safe:
 *
 *  1. An explicitly configured PUBLIC_BASE_URL always wins. An operator who
 *     knows their own domain should never have it guessed at, and this is the
 *     escape hatch when detection is wrong.
 *  2. Detection only trusts `X-Forwarded-Proto` / `X-Forwarded-Host` when the
 *     deployment says it sits behind a proxy (TRUST_PROXY=true). Without that,
 *     a client could set the header itself and have a password-reset link
 *     minted for a domain they control.
 *
 * The forwarded values themselves are still client-influenced on a proxied
 * deployment, which is inherent to any host-based link generation. What
 * protects the token is that it is single-use, hashed at rest, and short-lived,
 * so a link minted for a hostile host is useless to anyone but its recipient.
 */

/** Hosts that are never a customer's public domain. */
const NON_PUBLIC_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '[::1]']);

/** Lowercased, trimmed. Rejects an empty or absurdly long value. */
function normalizeHost(raw: string | undefined): string | null {
  if (!raw) return null;
  const host = raw.trim().toLowerCase();
  if (!host || host.length > 255) return null;
  // A host must not contain whitespace, a slash, or an @. Those indicate a
  // mangled or hostile value rather than a real Host header.
  if (/[\s/@\\]/.test(host)) return null;
  return host;
}

function isPublicHost(host: string | null): host is string {
  if (!host) return false;
  const withoutPort = host.startsWith('[')
    ? host.slice(0, host.indexOf(']') + 1)
    : (host.split(':')[0] ?? '');
  if (NON_PUBLIC_HOSTS.has(host) || NON_PUBLIC_HOSTS.has(withoutPort)) return false;
  // A bare hostname with no dot is not a public domain (except IPv6 literals,
  // which are bracketed and handled above).
  if (!withoutPort.startsWith('[') && !withoutPort.includes('.')) return false;
  return true;
}

/**
 * Reads the first value from a comma-separated forwarded header.
 *
 * Proxies append to these headers as a request passes through each hop, so the
 * left-most entry is the one closest to the client.
 *
 * Node types a repeated header as string[], so the first element is taken.
 * Joining would be wrong here: it would splice unrelated values into one host.
 */
function firstForwardedValue(raw: string | string[] | undefined): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return undefined;
  const first = value.split(',')[0];
  return first?.trim() || undefined;
}

export interface OriginContext {
  /** True when the app is configured to sit behind a reverse proxy. */
  trustProxy: boolean;
  /** Operator-configured base URL. Wins outright when set. */
  configuredBaseUrl: string | undefined;
  /** A path prefix the deployment mounts the app under, e.g. "/app". */
  basePath?: string;
}

/**
 * The request fields this reads. Structurally typed so a Fastify request, a
 * plain test object, or anything else with these three properties works.
 */
export interface OriginRequestLike {
  protocol: string;
  hostname: string;
  /** Raw `X-Forwarded-Proto`, only consulted when trustProxy is true. */
  headers: Record<string, string | string[] | undefined>;
}

export interface ResolvedOrigin {
  origin: string;
  /** Where this answer came from, for logging and for the config endpoint. */
  source: 'configured' | 'request';
}

/**
 * Resolves the public origin for a request.
 *
 * Returns the configured value when there is one, and otherwise derives an
 * origin from the request. `fallback` is used when the request carries no
 * usable public host, which is the normal case in local development.
 */
export function resolvePublicOrigin(
  request: OriginRequestLike,
  ctx: OriginContext,
  fallback: string,
): ResolvedOrigin {
  if (ctx.configuredBaseUrl) {
    return { origin: stripTrailingSlash(ctx.configuredBaseUrl), source: 'configured' };
  }

  const forwardedProto = ctx.trustProxy
    ? firstForwardedValue(request.headers['x-forwarded-proto'])
    : undefined;
  // A proxied TLS connection arrives as http on the socket, so the forwarded
  // protocol is the only accurate signal for whether to mint an https link.
  const proto =
    forwardedProto === 'https' || forwardedProto === 'http'
      ? forwardedProto
      : request.protocol === 'https'
        ? 'https'
        : 'http';

  // request.hostname already accounts for X-Forwarded-Host when Fastify's
  // trustProxy is on, so it is the right source in both modes and the header
  // does not need to be read separately here.
  const host = normalizeHost(request.hostname);

  if (!isPublicHost(host)) return { origin: stripTrailingSlash(fallback), source: 'request' };

  const path = ctx.basePath ? `/${ctx.basePath.replace(/^\/+|\/+$/g, '')}` : '';
  return { origin: `${proto}://${host}${path}`, source: 'request' };
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * The origin used when a request carries no usable public host, which is the
 * normal case in local development. Kept as a localhost value on purpose: a
 * fallback must never invent a public domain, because a link that points at a
 * domain nobody controls is worse than one that is obviously local.
 */
export const LOCAL_ORIGIN = 'http://localhost:5173';

/** Packages the parts of AppConfig that origin resolution needs. */
export interface PublicOriginConfig {
  publicBaseUrl: string | undefined;
  security: { trustProxy: boolean };
}

/** Builds the resolution context from the app config. */
export function originContext(config: PublicOriginConfig): OriginContext {
  return { trustProxy: config.security.trustProxy, configuredBaseUrl: config.publicBaseUrl };
}
