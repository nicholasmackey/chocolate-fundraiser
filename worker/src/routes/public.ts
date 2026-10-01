import { validateCheckoutDetails, validateRequestedItems } from '../../../shared/validation';
import { createOrder, getConfirmationBySubmissionId } from '../db/create-order';
import { listProducts, toPublicProduct } from '../db/products';
import { isOrderingEnabled } from '../db/settings';
import type { AppEnv } from '../env';
import { ApiError, getClientIp, jsonResponse, readJsonObject } from '../http';
import { logger } from '../logger';
import { consumeRateLimit, ORDER_RATE_LIMIT } from '../rate-limit';
import type { Dependencies } from '../index';

const SUBMISSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export async function getStorefront(env: AppEnv): Promise<Response> {
  const [orderingEnabled, products] = await Promise.all([
    isOrderingEnabled(env.DB),
    listProducts(env.DB),
  ]);
  const publicProducts = products.map(toPublicProduct);
  const anyInStock = publicProducts.some((product) => product.available > 0);
  return jsonResponse({
    state: orderingEnabled && anyInStock ? 'open' : orderingEnabled ? 'coming_soon' : 'closed',
    products: publicProducts,
  });
}

export async function postOrder(
  request: Request,
  env: AppEnv,
  deps: Dependencies,
): Promise<Response> {
  const body = await readJsonObject(request);
  const clientIp = getClientIp(request);

  const allowed = await consumeRateLimit(env.DB, ORDER_RATE_LIMIT, clientIp, env.SESSION_SECRET);
  if (!allowed) {
    logger.warn('order_rate_limited');
    throw new ApiError(
      429,
      'rate_limited',
      'Too many orders from this connection. Please try again later.',
    );
  }

  const submissionId = typeof body.submissionId === 'string' ? body.submissionId.toLowerCase() : '';
  if (!SUBMISSION_ID_PATTERN.test(submissionId)) {
    throw new ApiError(400, 'invalid_request', 'Please refresh the page and try again.');
  }

  const details = validateCheckoutDetails((body.details ?? {}) as Record<string, unknown>);
  const items = validateRequestedItems(body.items);
  if (!details.ok || !items.ok) {
    throw new ApiError(400, 'validation_failed', 'Please check the highlighted fields.', {
      ...(details.ok ? {} : details.errors),
      ...(items.ok ? {} : items.errors),
    });
  }

  // A retried submission (e.g. after a dropped connection) returns the original order.
  const existing = await getConfirmationBySubmissionId(env.DB, submissionId);
  if (existing) return jsonResponse({ order: existing });

  const turnstileToken = typeof body.turnstileToken === 'string' ? body.turnstileToken : '';
  const human = await deps.verifyTurnstile({
    token: turnstileToken,
    secretKey: env.TURNSTILE_SECRET_KEY,
    remoteIp: clientIp,
    expectedHostname: env.TURNSTILE_EXPECTED_HOSTNAME || undefined,
  });
  if (!human) {
    throw new ApiError(
      400,
      'turnstile_failed',
      'We could not verify you are human. Please try again.',
    );
  }

  const result = await createOrder(env.DB, {
    submissionId,
    details: details.value,
    items: items.value,
  });
  if (result.created) {
    logger.info('order_created', {
      orderNumber: result.confirmation.orderNumber,
      totalBars: result.confirmation.totalBars,
    });
    // The order and inventory are already committed. The notification runs after the
    // response is sent, and notifyNewOrder never throws, so it cannot affect the order.
    deps.waitUntil(
      deps.notifyNewOrder(
        {
          botToken: env.TELEGRAM_BOT_TOKEN,
          chatId: env.TELEGRAM_CHAT_ID,
          adminUrl: env.ADMIN_URL,
        },
        { confirmation: result.confirmation, details: details.value },
      ),
    );
  }
  return jsonResponse({ order: result.confirmation }, result.created ? 201 : 200);
}
