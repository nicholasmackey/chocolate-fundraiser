import { formatCents } from '../../../shared/pricing';
import { ORDER_STATUS_LABELS, PAYMENT_STATUS_LABELS } from '../../../shared/types';
import { cleanText } from '../../../shared/validation';
import { requireAdmin, signIn, signOut } from '../auth';
import { toCsv } from '../csv';
import { getDashboard } from '../db/dashboard';
import {
  adjustStock,
  getInventory,
  listStockAdjustments,
  setLowStockThreshold,
  setStock,
} from '../db/inventory';
import { purgeCustomerData } from '../db/maintenance';
import {
  cancelOrder,
  isOrderStatus,
  listOrders,
  updateOrderStatus,
  updatePaymentStatus,
} from '../db/orders';
import { listProducts } from '../db/products';
import { setOrderingEnabled } from '../db/settings';
import type { AppEnv } from '../env';
import { ApiError, getClientIp, jsonResponse, readJsonObject, textResponse } from '../http';
import { logger } from '../logger';
import { consumeRateLimit, LOGIN_RATE_LIMIT, pruneRateLimits } from '../rate-limit';

export const PURGE_CONFIRMATION = 'DELETE ALL ORDERS';

async function login(request: Request, env: AppEnv): Promise<Response> {
  const allowed = await consumeRateLimit(
    env.DB,
    LOGIN_RATE_LIMIT,
    getClientIp(request),
    env.SESSION_SECRET,
  );
  if (!allowed) {
    logger.warn('admin_login_rate_limited');
    throw new ApiError(
      429,
      'rate_limited',
      'Too many sign-in attempts. Please wait and try again.',
    );
  }
  const body = await readJsonObject(request);
  const password = typeof body.password === 'string' ? body.password.slice(0, 200) : '';
  const session = await signIn(env.DB, {
    password,
    passwordHash: env.ADMIN_PASSWORD_HASH,
    sessionSecret: env.SESSION_SECRET,
  });
  if (!session) {
    logger.warn('admin_login_failed');
    throw new ApiError(401, 'invalid_password', 'That password is not correct.');
  }
  logger.info('admin_login');
  return jsonResponse(session);
}

function readNote(body: Record<string, unknown>): string {
  return cleanText(body.note).slice(0, 200);
}

function readInteger(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new ApiError(400, 'invalid_quantity', 'Please enter a whole number.');
  }
  return value;
}

async function exportOrdersCsv(env: AppEnv): Promise<Response> {
  const [orders, products] = await Promise.all([
    listOrders(env.DB, { status: 'all', limit: 1000 }),
    listProducts(env.DB),
  ]);
  const header = [
    'Order Number',
    'Submitted (UTC)',
    'Order Status',
    'Payment Status',
    'Customer Name',
    'Phone',
    'Street',
    'City',
    'State',
    'ZIP',
    'Delivery Instructions',
    ...products.map((product) => product.name),
    'Total Bars',
    'Total',
  ];
  const rows = orders
    .slice()
    .reverse()
    .map((order) => {
      const quantities = new Map(order.items.map((item) => [item.productId, item.quantity]));
      return [
        order.orderNumber,
        order.createdAt,
        ORDER_STATUS_LABELS[order.status],
        PAYMENT_STATUS_LABELS[order.paymentStatus],
        order.customerName,
        order.phone,
        order.street,
        order.city,
        order.state,
        order.zip,
        order.deliveryInstructions,
        ...products.map((product) => quantities.get(product.id) ?? 0),
        order.totalBars,
        formatCents(order.totalCents),
      ];
    });
  const date = new Date().toISOString().slice(0, 10);
  return textResponse(toCsv([header, ...rows]), 'text/csv; charset=utf-8', {
    'Content-Disposition': `attachment; filename="chocolate-orders-${date}.csv"`,
  });
}

const ORDER_ACTION_PATTERN = /^\/api\/admin\/orders\/([0-9a-f-]{36})\/(status|payment|cancel)$/;
const INVENTORY_ACTION_PATTERN = /^\/api\/admin\/inventory\/(\d{1,9})\/(set|adjust|threshold)$/;

export async function handleAdmin(request: Request, env: AppEnv, url: URL): Promise<Response> {
  const { pathname } = url;
  const method = request.method;

  if (pathname === '/api/admin/login' && method === 'POST') return login(request, env);

  // Everything below requires a valid admin session.
  const session = await requireAdmin(env.DB, request, env.SESSION_SECRET);

  if (pathname === '/api/admin/session' && method === 'GET') {
    return jsonResponse({ expiresAt: session.expiresAt });
  }
  if (pathname === '/api/admin/logout' && method === 'POST') {
    await signOut(env.DB, session);
    return jsonResponse({ ok: true });
  }
  if (pathname === '/api/admin/dashboard' && method === 'GET') {
    return jsonResponse(await getDashboard(env.DB));
  }
  if (pathname === '/api/admin/orders' && method === 'GET') {
    const status = url.searchParams.get('status') ?? 'all';
    if (status !== 'all' && status !== 'open' && !isOrderStatus(status)) {
      throw new ApiError(400, 'invalid_status', 'Unknown status filter.');
    }
    const orders = await listOrders(env.DB, { query: url.searchParams.get('q') ?? '', status });
    return jsonResponse({ orders });
  }
  if (pathname === '/api/admin/orders.csv' && method === 'GET') {
    logger.info('orders_exported');
    return exportOrdersCsv(env);
  }

  const orderMatch = ORDER_ACTION_PATTERN.exec(pathname);
  if (orderMatch && method === 'POST') {
    const [, orderId, action] = orderMatch as unknown as [string, string, string];
    if (action === 'cancel') {
      const result = await cancelOrder(env.DB, orderId);
      logger.info('order_cancelled', { orderId, restored: result.restored });
      return jsonResponse(result);
    }
    const body = await readJsonObject(request);
    if (action === 'status') {
      if (!isOrderStatus(body.status)) throw new ApiError(400, 'invalid_status', 'Unknown status.');
      return jsonResponse({ order: await updateOrderStatus(env.DB, orderId, body.status) });
    }
    if (body.paymentStatus !== 'paid' && body.paymentStatus !== 'unpaid') {
      throw new ApiError(400, 'invalid_status', 'Unknown payment status.');
    }
    return jsonResponse({ order: await updatePaymentStatus(env.DB, orderId, body.paymentStatus) });
  }

  if (pathname === '/api/admin/inventory' && method === 'GET') {
    const [inventory, adjustments] = await Promise.all([
      getInventory(env.DB),
      listStockAdjustments(env.DB, 100),
    ]);
    return jsonResponse({ inventory, adjustments });
  }

  const inventoryMatch = INVENTORY_ACTION_PATTERN.exec(pathname);
  if (inventoryMatch && method === 'POST') {
    const productId = Number(inventoryMatch[1]);
    const action = inventoryMatch[2];
    const body = await readJsonObject(request);
    if (action === 'set') {
      return jsonResponse({
        product: await setStock(env.DB, productId, readInteger(body, 'quantity'), readNote(body)),
      });
    }
    if (action === 'adjust') {
      return jsonResponse({
        product: await adjustStock(env.DB, productId, readInteger(body, 'delta'), readNote(body)),
      });
    }
    return jsonResponse({
      product: await setLowStockThreshold(env.DB, productId, readInteger(body, 'threshold')),
    });
  }

  if (pathname === '/api/admin/settings/ordering' && method === 'POST') {
    const body = await readJsonObject(request);
    if (typeof body.enabled !== 'boolean') {
      throw new ApiError(400, 'invalid_request', 'Expected enabled to be true or false.');
    }
    await setOrderingEnabled(env.DB, body.enabled);
    logger.info('ordering_toggled', { enabled: body.enabled });
    return jsonResponse({ orderingEnabled: body.enabled });
  }

  if (pathname === '/api/admin/data/purge' && method === 'POST') {
    const body = await readJsonObject(request);
    if (body.confirm !== PURGE_CONFIRMATION) {
      throw new ApiError(400, 'confirmation_required', `Type "${PURGE_CONFIRMATION}" to confirm.`);
    }
    const result = await purgeCustomerData(env.DB);
    await pruneRateLimits(env.DB);
    logger.warn('customer_data_purged', { deletedOrders: result.deletedOrders });
    return jsonResponse(result);
  }

  throw new ApiError(404, 'not_found', 'Not found.');
}
