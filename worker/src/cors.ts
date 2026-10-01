export function parseAllowedOrigins(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((origin) => origin.trim().replace(/\/+$/, ''))
      .filter(Boolean),
  );
}

export function isAllowedOrigin(origin: string | null, allowedOrigins: Set<string>): boolean {
  return origin !== null && allowedOrigins.has(origin);
}

/**
 * Adds CORS headers for an allowed origin. Credentials are never allowed:
 * admin authentication uses an Authorization bearer token, not cookies.
 */
export function withCors(response: Response, origin: string | null, allowed: boolean): Response {
  const headers = new Headers(response.headers);
  headers.append('Vary', 'Origin');
  if (allowed && origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Expose-Headers', 'Content-Disposition');
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function preflightResponse(origin: string | null, allowed: boolean): Response {
  if (!allowed || !origin) {
    return new Response(null, { status: 403, headers: { Vary: 'Origin' } });
  }
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    },
  });
}
