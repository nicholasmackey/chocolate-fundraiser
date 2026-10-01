export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

const BASE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export function errorResponse(error: ApiError): Response {
  return jsonResponse(
    { error: { code: error.code, message: error.message, details: error.details } },
    error.status,
  );
}

export function textResponse(body: string, contentType: string, extraHeaders: HeadersInit = {}) {
  return new Response(body, {
    status: 200,
    headers: { ...BASE_HEADERS, 'Content-Type': contentType, ...extraHeaders },
  });
}

const MAX_JSON_BYTES = 16 * 1024;

/** Reads a small JSON object body. Requiring application/json forces a CORS preflight. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('Content-Type') ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new ApiError(415, 'unsupported_media_type', 'Expected a JSON request body.');
  }
  const text = await request.text();
  if (text.length > MAX_JSON_BYTES) {
    throw new ApiError(413, 'payload_too_large', 'Request body is too large.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(400, 'invalid_json', 'Request body is not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ApiError(400, 'invalid_json', 'Request body must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

export function getClientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown';
}
