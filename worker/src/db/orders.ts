import type { Order, OrderItem, OrderStatus, PaymentStatus } from '../../../shared/types';
import { ORDER_STATUSES } from '../../../shared/types';
import { CANCELLABLE_STATUSES, STATUS_TRANSITIONS } from '../../../shared/order-status';
import { ApiError } from '../http';

interface OrderRow {
  id: string;
  order_number: string;
  customer_name: string;
  phone: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  delivery_instructions: string;
  total_bars: number;
  total_cents: number;
  status: OrderStatus;
  payment_status: PaymentStatus;
  created_at: string;
  updated_at: string;
  cancelled_at: string | null;
}

interface OrderItemRow {
  order_id: string;
  product_id: number;
  product_name: string;
  quantity: number;
  unit_price_cents: number;
  line_total_cents: number;
}

const NOW_SQL = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
const ORDER_COLUMNS = `id, order_number, customer_name, phone, street, city, state, zip,
  delivery_instructions, total_bars, total_cents, status, payment_status, created_at, updated_at,
  cancelled_at`;

function mapOrder(row: OrderRow, items: OrderItem[]): Order {
  return {
    id: row.id,
    orderNumber: row.order_number,
    customerName: row.customer_name,
    phone: row.phone,
    street: row.street,
    city: row.city,
    state: row.state,
    zip: row.zip,
    deliveryInstructions: row.delivery_instructions,
    totalBars: row.total_bars,
    totalCents: row.total_cents,
    status: row.status,
    paymentStatus: row.payment_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    cancelledAt: row.cancelled_at,
    items,
  };
}

async function attachItems(db: D1Database, rows: OrderRow[]): Promise<Order[]> {
  if (rows.length === 0) return [];
  const { results } = await db
    .prepare(
      `SELECT order_id, product_id, product_name, quantity, unit_price_cents, line_total_cents
       FROM order_items
       JOIN products ON products.id = order_items.product_id
       WHERE order_id IN (SELECT value FROM json_each(?))
       ORDER BY products.sort_order`,
    )
    .bind(JSON.stringify(rows.map((row) => row.id)))
    .all<OrderItemRow>();
  const itemsByOrder = new Map<string, OrderItem[]>();
  for (const item of results) {
    const items = itemsByOrder.get(item.order_id) ?? [];
    items.push({
      productId: item.product_id,
      productName: item.product_name,
      quantity: item.quantity,
      unitPriceCents: item.unit_price_cents,
      lineTotalCents: item.line_total_cents,
    });
    itemsByOrder.set(item.order_id, items);
  }
  return rows.map((row) => mapOrder(row, itemsByOrder.get(row.id) ?? []));
}

export interface OrderSearch {
  query?: string;
  status?: OrderStatus | 'open' | 'all';
  limit?: number;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export async function listOrders(db: D1Database, search: OrderSearch = {}): Promise<Order[]> {
  const conditions: string[] = [];
  const bindings: unknown[] = [];

  const query = (search.query ?? '').trim().slice(0, 100);
  if (query) {
    const pattern = `%${escapeLike(query.toLowerCase())}%`;
    const digits = query.replace(/\D/g, '');
    const searchable = ['order_number', 'customer_name', 'street', 'city', 'zip']
      .map((column) => `lower(${column}) LIKE ? ESCAPE '\\'`)
      .join(' OR ');
    bindings.push(...Array(5).fill(pattern));
    if (digits.length >= 3) {
      conditions.push(
        `(${searchable} OR replace(replace(replace(replace(phone, '(', ''), ')', ''), '-', ''), ' ', '') LIKE ?)`,
      );
      bindings.push(`%${digits}%`);
    } else {
      conditions.push(`(${searchable})`);
    }
  }

  if (search.status === 'open') {
    conditions.push(`status IN ('new', 'packed')`);
  } else if (search.status && search.status !== 'all') {
    conditions.push('status = ?');
    bindings.push(search.status);
  }

  const limit = Math.min(Math.max(search.limit ?? 500, 1), 1000);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const { results } = await db
    .prepare(`SELECT ${ORDER_COLUMNS} FROM orders ${where} ORDER BY created_at DESC LIMIT ${limit}`)
    .bind(...bindings)
    .all<OrderRow>();
  return attachItems(db, results);
}

export async function getOrder(db: D1Database, orderId: string): Promise<Order | null> {
  const row = await db
    .prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = ?`)
    .bind(orderId)
    .first<OrderRow>();
  if (!row) return null;
  const [order] = await attachItems(db, [row]);
  return order ?? null;
}

async function requireOrder(db: D1Database, orderId: string): Promise<Order> {
  const order = await getOrder(db, orderId);
  if (!order) throw new ApiError(404, 'not_found', 'Order not found.');
  return order;
}

export function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === 'string' && (ORDER_STATUSES as readonly string[]).includes(value);
}

export async function updateOrderStatus(
  db: D1Database,
  orderId: string,
  nextStatus: OrderStatus,
): Promise<Order> {
  const order = await requireOrder(db, orderId);
  if (order.status === nextStatus) return order;
  if (nextStatus === 'cancelled') {
    throw new ApiError(400, 'use_cancel', 'Use the cancel action to cancel an order.');
  }
  if (!STATUS_TRANSITIONS[order.status].includes(nextStatus)) {
    throw new ApiError(
      409,
      'invalid_transition',
      `A ${order.status} order cannot be marked ${nextStatus}.`,
    );
  }
  // Conditional on the status we validated against, so concurrent taps cannot skip a check.
  const result = await db
    .prepare(`UPDATE orders SET status = ?, updated_at = ${NOW_SQL} WHERE id = ? AND status = ?`)
    .bind(nextStatus, orderId, order.status)
    .run();
  if (result.meta.changes !== 1) {
    throw new ApiError(409, 'conflict', 'This order was just updated. Please refresh.');
  }
  return requireOrder(db, orderId);
}

export async function updatePaymentStatus(
  db: D1Database,
  orderId: string,
  paymentStatus: PaymentStatus,
): Promise<Order> {
  await requireOrder(db, orderId);
  await db
    .prepare(`UPDATE orders SET payment_status = ?, updated_at = ${NOW_SQL} WHERE id = ?`)
    .bind(paymentStatus, orderId)
    .run();
  return requireOrder(db, orderId);
}

/**
 * Cancels an order and restores its reserved inventory exactly once. Every
 * statement is conditional on the order still being cancellable, and the
 * batch runs as a single transaction, so repeated or concurrent cancellations
 * restore stock only the first time.
 */
export async function cancelOrder(
  db: D1Database,
  orderId: string,
): Promise<{ order: Order; restored: boolean }> {
  const order = await requireOrder(db, orderId);
  if (order.status === 'cancelled') return { order, restored: false };
  if (!CANCELLABLE_STATUSES.includes(order.status)) {
    throw new ApiError(409, 'invalid_transition', 'Delivered orders cannot be cancelled.');
  }

  const cancellableSql = `EXISTS (SELECT 1 FROM orders WHERE id = ?1 AND status IN ('new', 'packed'))`;
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO stock_adjustments (product_id, quantity_change, quantity_after, reason, order_id)
         SELECT oi.product_id, oi.quantity, p.stock_quantity + oi.quantity, 'cancellation', ?1
         FROM order_items oi JOIN products p ON p.id = oi.product_id
         WHERE oi.order_id = ?1 AND ${cancellableSql}`,
      )
      .bind(orderId),
    db
      .prepare(
        `UPDATE products SET
           stock_quantity = stock_quantity +
             (SELECT quantity FROM order_items WHERE order_id = ?1 AND product_id = products.id),
           updated_at = ${NOW_SQL}
         WHERE id IN (SELECT product_id FROM order_items WHERE order_id = ?1) AND ${cancellableSql}`,
      )
      .bind(orderId),
    db
      .prepare(
        `UPDATE orders SET status = 'cancelled', cancelled_at = ${NOW_SQL}, updated_at = ${NOW_SQL}
         WHERE id = ?1 AND status IN ('new', 'packed')`,
      )
      .bind(orderId),
  ]);
  const restored = results[2]?.meta.changes === 1;
  return { order: await requireOrder(db, orderId), restored };
}
