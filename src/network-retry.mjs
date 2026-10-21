const transientStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);
const transientCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH',
  'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'DOWNLOAD_INCOMPLETE_RANGE',
  'ftp-network-error', 'media-network-error']);

export function supportsNetworkRetry(job) {
  return job.method === 'GET' && (!job.kind || ['ftp', 'media'].includes(job.kind)) && !job.needsRecapture && !job.needsCredentials;
}

export const DEFAULT_NETWORK_RETRY_POLICY = Object.freeze({ baseDelayMs: 2000, maxDelayMs: 30000, jitterMs: 1000, maxAttempts: 60, maxElapsedMs: 30 * 60 * 1000 });

export function networkRetryPolicy(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid network retry policy');
  const policy = { ...DEFAULT_NETWORK_RETRY_POLICY, ...input };
  if (Object.keys(input).some(key => !Object.hasOwn(DEFAULT_NETWORK_RETRY_POLICY, key)) ||
      !Object.values(policy).every(Number.isSafeInteger) || policy.baseDelayMs < 10 || policy.maxDelayMs < policy.baseDelayMs ||
      policy.maxDelayMs > 30000 || policy.jitterMs < 0 || policy.jitterMs > 1000 ||
      policy.maxAttempts < 1 || policy.maxAttempts > 60 || policy.maxElapsedMs < 1 || policy.maxElapsedMs > 1800000) throw new Error('Invalid network retry policy');
  return Object.freeze(policy);
}

export function isTransientNetworkError(error) {
  if (Number.isInteger(error?.status)) return transientStatuses.has(error.status);
  const visit = (value, depth) => {
    if (!value || depth > 3) return false;
    if (transientCodes.has(value.code) || value.name === 'TimeoutError') return true;
    if (visit(value.cause, depth + 1)) return true;
    return Array.isArray(value.errors) && value.errors.slice(0, 16).some(nested => visit(nested, depth + 1));
  };
  return visit(error, 0);
}

export function retryAfterMilliseconds(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const text = value.trim();
  if (/^\d+$/.test(text)) {
    const milliseconds = Number(text) * 1000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : Number.MAX_SAFE_INTEGER;
  }
  if (!/[a-z]{3}/i.test(text)) return undefined;
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

export function validNetworkRetry(state, policy, now = Date.now()) {
  return !!state && Number.isSafeInteger(state.attempt) && state.attempt >= 1 && state.attempt <= policy.maxAttempts &&
    Number.isSafeInteger(state.startedAt) && state.startedAt >= 0 && state.startedAt <= now &&
    Number.isSafeInteger(state.nextAt) && state.nextAt >= state.startedAt &&
    state.nextAt <= state.startedAt + policy.maxElapsedMs && now <= state.startedAt + policy.maxElapsedMs;
}

export function nextNetworkRetry(previous, id, error, policy, now = Date.now()) {
  const attempt = (previous?.attempt || 0) + 1, startedAt = previous?.startedAt ?? now;
  if (attempt > policy.maxAttempts || now >= startedAt + policy.maxElapsedMs) return null;
  let seed = 0; for (const character of id) seed = (seed * 31 + character.charCodeAt(0)) >>> 0;
  const jitter = seed % (policy.jitterMs + 1);
  const backoff = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.min(attempt - 1, 20) + jitter);
  const nextAt = now + Math.max(backoff, error.retryAfterMs || 0);
  if (!Number.isSafeInteger(nextAt) || nextAt > startedAt + policy.maxElapsedMs) return null;
  return { attempt, startedAt, nextAt };
}
