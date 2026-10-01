import { priceOrder } from '../../../shared/pricing';
import type { OrderConfirmation } from '../../../shared/types';
import type { CheckoutDetails, RequestedLine } from '../../../shared/validation';
import { ApiError } from '../http';
import { generateOrderNumber } from './order-number';
import { listProducts } from './products';
import { isOrderingEnabled, ORDERING_ENABLED_SQL } from './settings';

export interface CreateOrderInput {
  submissionId: string;
  details: CheckoutDetails;
  items: RequestedLine[];
}

export interface CreateOrderResult {
  confirmation: OrderConfirmation;
  /** False when an earlier submission with the same submissionId was returned. */
  created: boolean;
}

const NOW_SQL = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
const MAX_ORDER_NUMBER_ATTEMPTS = 4;

export async function getConfirmationBySubmissionId(
  db: D1Database,
  submissionId: string,
): Promise<OrderConfirmation | null> {
  const order = await db
    .prepare('SELECT id, order_number, total_bars, total_cents FROM orders WHERE submission_id = ?')
    .bind(submissionId)
    .first<{ id: string; order_number: string; total_bars: number; total_cents: number }>();
  if (!order) return null;
  const { results } = await db
    .prepare(
      `SELECT product_name, quantity, line_total_cents FROM order_items
       JOIN products ON products.id = order_items.product_id
       WHERE order_id = ? ORDER BY products.sort_order`,
    )
    .bind(order.id)
    .all<{ product_name: string; quantity: number; line_total_cents: number }>();
  return {
    orderNumber: order.order_number,
    totalBars: order.total_bars,
    totalCents: order.total_cents,
    items: results.map((row) => ({
      productName: row.product_name,
      quantity: row.quantity,
      lineTotalCents: row.line_total_cents,
    })),
  };
}

/** Pre-flight checks that produce friendly errors. The batch below re-checks atomically. */
async function assertOrderable(db: D1Database, items: RequestedLine[]) {
  const [orderingEnabled, products] = await Promise.all([isOrderingEnabled(db), listProducts(db)]);
  if (!orderingEnabled) {
    throw new ApiError(
      409,
      'ordering_closed',
      'Ordering is closed right now. Please check back soon.',
    );
  }
  const productsById = new Map(products.map((product) => [product.id, product]));
  const shortages: Array<{ productId: number; productName: string; available: number }> = [];
  for (const line of items) {
    const product = productsById.get(line.productId);
    if (!product) {
      throw new ApiError(
        400,
        'invalid_items',
        'Your order includes a flavor that is not available.',
      );
    }
    if (product.stockQuantity < line.quantity) {
      shortages.push({
        productId: product.id,
        productName: product.name,
        available: product.stockQuantity,
      });
    }
  }
  if (shortages.length > 0) {
    throw new ApiError(
      409,
      'insufficient_stock',
      'Some flavors no longer have enough bars. Please adjust your order.',
      shortages,
    );
  }
  return products;
}

/**
 * Creates an order and reserves its inventory in a single D1 batch, which
 * runs as one transaction. Every stock decrement is guarded by the
 * `stock_quantity >= 0` CHECK constraint, so if any flavor is short, or
 * ordering was closed between the pre-check and the write, the whole batch
 * fails and nothing is written.
 */
export async function createOrder(
  db: D1Database,
  input: CreateOrderInput,
): Promise<CreateOrderResult> {
  const existing = await getConfirmationBySubmissionId(db, input.submissionId);
  if (existing) return { confirmation: existing, created: false };

  const products = await assertOrderable(db, input.items);
  const priced = priceOrder(input.items, products);
  const { details } = input;

  for (let attempt = 1; attempt <= MAX_ORDER_NUMBER_ATTEMPTS; attempt++) {
    const orderId = crypto.randomUUID();
    const orderNumber = generateOrderNumber();

    const statements: D1PreparedStatement[] = [
      // Inserts nothing when ordering is disabled; the stock guard below then aborts the batch.
      db
        .prepare(
          `INSERT INTO orders (id, order_number, submission_id, customer_name, phone, street, city,
             state, zip, delivery_instructions, total_bars, total_cents)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${ORDERING_ENABLED_SQL}`,
        )
        .bind(
          orderId,
          orderNumber,
          input.submissionId,
          details.customerName,
          details.phone,
          details.street,
          details.city,
          details.state,
          details.zip,
          details.deliveryInstructions,
          priced.totalBars,
          priced.totalCents,
        ),
    ];

    for (const line of priced.lines) {
      statements.push(
        // Setting -1 when the order row is missing deliberately violates the CHECK constraint.
        db
          .prepare(
            `UPDATE products SET
               stock_quantity = CASE WHEN EXISTS (SELECT 1 FROM orders WHERE id = ?1)
                 THEN stock_quantity - ?2 ELSE -1 END,
               updated_at = ${NOW_SQL}
             WHERE id = ?3`,
          )
          .bind(orderId, line.quantity, line.productId),
        db
          .prepare(
            `INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price_cents,
               line_total_cents) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            orderId,
            line.productId,
            line.productName,
            line.quantity,
            line.unitPriceCents,
            line.lineTotalCents,
          ),
        db
          .prepare(
            `INSERT INTO stock_adjustments (product_id, quantity_change, quantity_after, reason, order_id)
             SELECT id, ?, stock_quantity, 'order', ? FROM products WHERE id = ?`,
          )
          .bind(-line.quantity, orderId, line.productId),
      );
    }

    try {
      await db.batch(statements);
      return {
        created: true,
        confirmation: {
          orderNumber,
          totalBars: priced.totalBars,
          totalCents: priced.totalCents,
          items: priced.lines.map((line) => ({
            productName: line.productName,
            quantity: line.quantity,
            lineTotalCents: line.lineTotalCents,
          })),
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('orders.order_number')) continue;
      if (message.includes('orders.submission_id')) {
        const duplicate = await getConfirmationBySubmissionId(db, input.submissionId);
        if (duplicate) return { confirmation: duplicate, created: false };
      }
      if (message.includes('CHECK constraint failed')) {
        // Stock or ordering state changed after the pre-check; report the current reason.
        await assertOrderable(db, input.items);
        throw new ApiError(
          409,
          'order_conflict',
          'Your order could not be placed. Please try again.',
        );
      }
      throw error;
    }
  }
  throw new Error('Could not allocate a unique order number');
}
