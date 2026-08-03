const BASE = '';

/** Error carrying the HTTP status so callers/retry logic can branch on it. */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export function getCsrfToken(): string | undefined {
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options.headers as Record<string, string>,
  };

  // Attach CSRF token on state-changing requests
  const method = options.method?.toUpperCase();
  if (method && method !== 'GET' && method !== 'HEAD') {
    const csrf = getCsrfToken();
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }

  const res = await fetch(`${BASE}${path}`, {
    ...options,
    credentials: 'include',
    headers,
  });

  return parseEnvelope<T>(res);
}

/**
 * Reads a { success, data, message } envelope off a Response, guarding against
 * non-JSON bodies (e.g. a 502/504 HTML page from the proxy) that would
 * otherwise throw an opaque SyntaxError. Exported so raw-fetch call sites
 * (multipart uploads, blob downloads) share the same guard as request().
 */
export async function parseEnvelope<T>(res: Response): Promise<T> {
  let json: { success?: boolean; message?: string; data?: T } | null = null;
  try {
    json = await res.json();
  } catch {
    /* not JSON */
  }

  if (!res.ok || !json || json.success === false) {
    throw new ApiError(json?.message || res.statusText || 'Request failed', res.status);
  }
  return json.data as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
