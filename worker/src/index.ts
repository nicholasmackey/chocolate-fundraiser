import { isAllowedOrigin, parseAllowedOrigins, preflightResponse, withCors } from './cors';
import type { AppEnv } from './env';
import { ApiError, errorResponse, jsonResponse } from './http';
import { logger } from './logger';
import { handleAdmin } from './routes/admin';
import { getStorefront, postOrder } from './routes/public';
import { notifyNewOrder, type OrderNotice, type TelegramConfig } from './telegram';
import { verifyTurnstile, type TurnstileVerifier } from './turnstile';

export interface Dependencies {
  verifyTurnstile: TurnstileVerifier;
  notifyNewOrder: (config: TelegramConfig, notice: OrderNotice) => Promise<void>;
  /** Runs work after the response is sent (ExecutionContext.waitUntil in production). */
  waitUntil: (promise: Promise<unknown>) => void;
}

async function route(request: Request, env: AppEnv, url: URL, deps: Dependencies) {
  const { pathname } = url;
  if (pathname === '/api/health' && request.method === 'GET') return jsonResponse({ ok: true });
  if (pathname === '/api/storefront' && request.method === 'GET') return getStorefront(env);
  if (pathname === '/api/orders' && request.method === 'POST') {
    return postOrder(request, env, deps);
  }
  if (pathname.startsWith('/api/admin/')) return handleAdmin(request, env, url);
  throw new ApiError(404, 'not_found', 'Not found.');
}

export async function handleRequest(
  request: Request,
  env: AppEnv,
  deps: Dependencies,
): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  const allowed = isAllowedOrigin(origin, parseAllowedOrigins(env.ALLOWED_ORIGINS));

  if (request.method === 'OPTIONS') return preflightResponse(origin, allowed);

  let response: Response;
  try {
    // State-changing requests must come from the storefront/admin origin.
    // Browsers always send Origin on cross-origin POSTs.
    if (request.method !== 'GET' && !allowed) {
      throw new ApiError(403, 'forbidden_origin', 'Requests from this site are not allowed.');
    }
    response = await route(request, env, url, deps);
  } catch (error) {
    if (error instanceof ApiError) {
      response = errorResponse(error);
    } else {
      logger.error('unhandled_error', error, { path: url.pathname, method: request.method });
      response = errorResponse(
        new ApiError(500, 'server_error', 'Something went wrong. Please try again.'),
      );
    }
  }
  return withCors(response, origin, allowed);
}

export default {
  fetch(request, env, ctx) {
    return handleRequest(request, env, {
      verifyTurnstile,
      notifyNewOrder,
      waitUntil: (promise) => ctx.waitUntil(promise),
    });
  },
} satisfies ExportedHandler<AppEnv>;
