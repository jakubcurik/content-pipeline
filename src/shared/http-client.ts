import type { AuthProvider } from './auth/types.js';

export interface ApiError extends Error {
  status?: number;
  body?: unknown;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  /**
   * Additional per-request headers. These override any keys returned by
   * `auth.extraHeaders()` on conflict (needed for per-call MCC overrides in
   * Google Ads).
   */
  headers?: Record<string, string>;
}

const MAX_RETRIES = 3;

function buildUrl(url: string, query?: RequestOptions['query']): string {
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') {
      params.set(k, String(v));
    }
  }
  const qs = params.toString();
  if (!qs) return url;
  return url.includes('?') ? `${url}&${qs}` : `${url}?${qs}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Make an authenticated request using the supplied `AuthProvider`.
 *
 * - Adds `Authorization: Bearer <token>` plus any headers from
 *   `auth.extraHeaders()` and the per-request `options.headers`.
 * - On 401: calls `auth.invalidate()` and retries once with forced refresh.
 * - On 429 / 5xx: retries with exponential backoff (500ms → 1500ms → 4500ms),
 *   up to 3 attempts total.
 * - On other errors: throws an `ApiError` with `status` and parsed `body`.
 */
export async function authenticatedRequest<T>(
  auth: AuthProvider,
  url: string,
  options: RequestOptions = {},
): Promise<T> {
  const { method = 'GET', body, query, headers: perRequestHeaders } = options;
  const fullUrl = buildUrl(url, query);
  let needsTokenRefresh = false;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const token = await auth.getAccessToken(needsTokenRefresh);
    needsTokenRefresh = false;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(auth.extraHeaders ? auth.extraHeaders() : {}),
      ...(perRequestHeaders ?? {}),
    };

    const response = await fetch(fullUrl, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (response.ok) {
      const text = await response.text();
      return (text ? JSON.parse(text) : ({} as T));
    }

    const status = response.status;
    const text = await response.text().catch(() => '');
    const isLastAttempt = attempt === MAX_RETRIES - 1;

    if (status === 401 && !isLastAttempt) {
      auth.invalidate();
      needsTokenRefresh = true;
      continue;
    }

    if ((status === 429 || status >= 500) && !isLastAttempt) {
      // Exponential backoff: 500ms → 1500ms → 4500ms
      await sleep(500 * Math.pow(3, attempt));
      continue;
    }

    const apiError: ApiError = new Error(
      `API error ${status}: ${text || response.statusText}`,
    );
    apiError.status = status;
    try {
      apiError.body = JSON.parse(text);
    } catch {
      apiError.body = text;
    }
    throw apiError;
  }

  throw new Error(`Request failed after ${MAX_RETRIES} attempts`);
}

/**
 * Hints that customize per-status error messages for a specific provider.
 * Google and Meta both nest their error detail under `{ error: { message } }`
 * so the default detail extraction works for both; what differs is the
 * remediation advice we surface on 401/403.
 */
export interface ErrorHints {
  /** Full message shown on 401 (e.g. "Re-run animato-oauth ..."). */
  unauthorized?: string;
  /** Extra advice appended after the detail on 403. */
  forbidden?: string;
  /** Short service name used in the "… is temporarily unavailable" 5xx message. */
  service?: string;
}

/** Convert any thrown error into an LLM-friendly, actionable message. */
export function handleApiError(error: unknown, hints: ErrorHints = {}): string {
  if (error instanceof Error) {
    const apiError = error as ApiError;
    if (apiError.status !== undefined) {
      const detail = extractErrorDetail(apiError.body) ?? apiError.message;
      const service = hints.service ?? 'API';
      switch (apiError.status) {
        case 400:
          return `Error: Bad request – ${detail}. Verify your parameters (date format YYYY-MM-DD, valid field names, etc.).`;
        case 401:
          return (
            hints.unauthorized ??
            'Error: Authentication failed. The access token may be invalid or revoked.'
          );
        case 403:
          return `Error: Permission denied – ${detail}.${hints.forbidden ? ' ' + hints.forbidden : ''}`;
        case 404:
          return `Error: Resource not found – ${detail}.`;
        case 429:
          return 'Error: Rate limit exceeded. Wait a moment before retrying or reduce request frequency.';
        case 500:
        case 502:
        case 503:
        case 504:
          return `Error: ${service} is temporarily unavailable (status ${apiError.status}). Try again in a moment.`;
        default:
          return `Error: ${detail}`;
      }
    }
    return `Error: ${error.message}`;
  }
  return `Error: ${String(error)}`;
}

/**
 * Extract the human-readable error message from a Google or Meta API error
 * body. Both follow the shape `{ error: { message: "..." } }`.
 *
 * Google Ads wraps the *real* reason inside `error.details[].errors[].message`
 * using the `GoogleAdsFailure` proto — the top-level `error.message` is usually
 * just the generic "Request contains an invalid argument." For those responses
 * we unwrap the nested detail and append the GAQL field path + errorCode so
 * the caller sees something actionable (e.g. "INVALID_FIELD_NAME: unrecognized
 * field 'customer.foo' in SELECT clause").
 */
function extractErrorDetail(body: unknown): string | null {
  if (!body || typeof body !== 'object' || !('error' in body)) return null;
  const e = (body as { error: unknown }).error;
  if (!e || typeof e !== 'object') return null;
  const err = e as { message?: unknown; details?: unknown };
  const topMessage = typeof err.message === 'string' ? err.message : null;

  // Walk error.details[] looking for a Google Ads or Google API structured
  // failure. Each entry's `errors[]` is the real list of per-field issues.
  const nested: string[] = [];
  if (Array.isArray(err.details)) {
    for (const detail of err.details as unknown[]) {
      if (!detail || typeof detail !== 'object') continue;
      const d = detail as {
        '@type'?: unknown;
        errors?: unknown;
        reason?: unknown;
        fieldViolations?: unknown;
      };
      // GoogleAdsFailure: { errors: [{ errorCode: { queryError: "..." }, message, location }] }
      if (Array.isArray(d.errors)) {
        for (const sub of d.errors as unknown[]) {
          if (!sub || typeof sub !== 'object') continue;
          const s = sub as { message?: unknown; errorCode?: unknown; location?: unknown };
          const codeObj = (s.errorCode && typeof s.errorCode === 'object')
            ? (s.errorCode as Record<string, unknown>)
            : null;
          const codeKey = codeObj ? Object.keys(codeObj).find((k) => codeObj[k]) : null;
          const codeVal = codeKey ? String(codeObj![codeKey]) : null;
          const fieldPath = (() => {
            const loc = s.location as { fieldPathElements?: unknown } | undefined;
            if (!loc || !Array.isArray(loc.fieldPathElements)) return null;
            return (loc.fieldPathElements as unknown[])
              .map((el) => {
                if (!el || typeof el !== 'object') return '';
                return String((el as { fieldName?: unknown }).fieldName ?? '');
              })
              .filter(Boolean)
              .join('.');
          })();
          const msg = typeof s.message === 'string' ? s.message : '';
          const parts: string[] = [];
          if (codeVal) parts.push(codeVal);
          if (fieldPath) parts.push(`at '${fieldPath}'`);
          if (msg) parts.push(msg);
          if (parts.length > 0) nested.push(parts.join(' '));
        }
      }
      // google.rpc.BadRequest: { fieldViolations: [{ field, description }] }
      if (Array.isArray(d.fieldViolations)) {
        for (const fv of d.fieldViolations as unknown[]) {
          if (!fv || typeof fv !== 'object') continue;
          const f = fv as { field?: unknown; description?: unknown };
          const field = typeof f.field === 'string' ? f.field : '';
          const desc = typeof f.description === 'string' ? f.description : '';
          if (field || desc) nested.push(`${field ? field + ': ' : ''}${desc}`);
        }
      }
    }
  }

  if (nested.length > 0) {
    // Prefer the nested details (actionable). Keep top message as prefix only
    // if it differs from the first nested entry (often the same verbatim).
    const joined = nested.join('; ');
    if (topMessage && !joined.startsWith(topMessage)) return `${topMessage} – ${joined}`;
    return joined;
  }
  return topMessage;
}
