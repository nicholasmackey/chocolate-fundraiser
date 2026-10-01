const API_URL = (import.meta.env.PUBLIC_API_URL || 'http://localhost:8787').replace(/\/+$/, '');

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  token?: string | null;
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      // Cookies are never used; admin auth is an explicit bearer token.
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch {
    throw new ApiRequestError(
      0,
      'network_error',
      'We could not reach the server. Check your connection and try again.',
    );
  }
  if (!response.ok) {
    let payload: { error?: { code?: string; message?: string; details?: unknown } } = {};
    try {
      payload = await response.json();
    } catch {
      // Non-JSON error body; fall through to the generic message.
    }
    throw new ApiRequestError(
      response.status,
      payload.error?.code ?? 'error',
      payload.error?.message ?? 'Something went wrong. Please try again.',
      payload.error?.details,
    );
  }
  return response;
}

export async function apiJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await send(path, options);
  return (await response.json()) as T;
}

export async function apiDownload(path: string, token: string): Promise<void> {
  const response = await send(path, { token });
  const disposition = response.headers.get('Content-Disposition') ?? '';
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'download.csv';
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
