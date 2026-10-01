import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOrder } from '../worker/src/db/create-order';
import {
  cancelOrder,
  getOrder,
  updateOrderStatus,
  updatePaymentStatus,
} from '../worker/src/db/orders';
import { setOrderingEnabled } from '../worker/src/db/settings';
import { ApiError } from '../worker/src/http';
import { createTestContext, CUSTOMER, type TestContext } from './helpers';

let context: TestContext;

beforeAll(async () => {
  context = await createTestContext();
});
afterAll(async () => {
  await context.proxy.dispose();
});
beforeEach(async () => {
  await context.reset();
  await context.openOrdering();
});

async function placeOrder(
  lines: Array<[slug: string, quantity: number]>,
  submissionId = crypto.randomUUID(),
) {
  const items = await Promise.all(
    lines.map(async ([slug, quantity]) => ({ productId: await context.productId(slug), quantity })),
  );
  return createOrder(context.db, { submissionId, details: CUSTOMER, items });
}

async function orderIdFor(orderNumber: string): Promise<string> {
  const row = await context.db
    .prepare('SELECT id FROM orders WHERE order_number = ?')
    .bind(orderNumber)
    .first<{ id: string }>();
  return row!.id;
}

async function expectApiError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).code).toBe(code);
}

describe('seed', () => {
  it('creates the six flavors at $2 with zero stock, closed by default', async () => {
    await context.reset();
    const { results } = await context.db
      .prepare('SELECT name, price_cents, stock_quantity FROM products ORDER BY sort_order')
      .all<{ name: string; price_cents: number; stock_quantity: number }>();
    expect(results.map((row) => row.name)).toEqual([
      'Milk Chocolate',
      'Caramel',
      'Crisp',
      'Wafer',
      'Almond',
      'Pretzel',
    ]);
    expect(results.every((row) => row.price_cents === 200 && row.stock_quantity === 0)).toBe(true);
    const setting = await context.db
      .prepare(`SELECT value FROM app_settings WHERE key = 'ordering_enabled'`)
      .first<{ value: string }>();
    expect(setting?.value).toBe('0');
  });

  it('does not overwrite existing inventory when re-run', async () => {
    await context.setStockDirect('caramel', 55);
    const { readFileSync } = await import('node:fs');
    const seedSql = readFileSync(new URL('../seed/seed.sql', import.meta.url), 'utf8');
    const statements = seedSql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .split(/;\s*(?:\n|$)/)
      .map((statement) => statement.trim())
      .filter(Boolean);
    await context.db.batch(statements.map((statement) => context.db.prepare(statement)));
    expect(await context.stockOf('caramel')).toBe(55);
    expect(await context.count('products')).toBe(6);
  });
});

describe('order creation', () => {
  it('creates an order, prices it server-side, and reserves stock', async () => {
    await context.setStockDirect('caramel', 20);
    await context.setStockDirect('almond', 5);

    const result = await placeOrder([
      ['caramel', 3],
      ['almond', 2],
    ]);

    expect(result.created).toBe(true);
    expect(result.confirmation.orderNumber).toMatch(/^WFC-[A-HJ-NP-Z2-9]{6}$/);
    expect(result.confirmation.totalBars).toBe(5);
    expect(result.confirmation.totalCents).toBe(1000);
    expect(await context.stockOf('caramel')).toBe(17);
    expect(await context.stockOf('almond')).toBe(3);

    const order = await getOrder(context.db, await orderIdFor(result.confirmation.orderNumber));
    expect(order?.status).toBe('new');
    expect(order?.paymentStatus).toBe('unpaid');
    expect(
      order?.items.map((item) => [item.productName, item.quantity, item.unitPriceCents]),
    ).toEqual([
      ['Caramel', 3, 200],
      ['Almond', 2, 200],
    ]);
    expect(await context.count('stock_adjustments')).toBe(2);
  });

  it('allows ordering exactly the remaining stock', async () => {
    await context.setStockDirect('wafer', 4);
    await placeOrder([['wafer', 4]]);
    expect(await context.stockOf('wafer')).toBe(0);
  });

  it('rejects insufficient stock without writing anything', async () => {
    await context.setStockDirect('crisp', 2);
    await expectApiError(placeOrder([['crisp', 3]]), 'insufficient_stock');
    expect(await context.stockOf('crisp')).toBe(2);
    expect(await context.count('orders')).toBe(0);
  });

  it('is atomic across lines: one short flavor rejects the whole order', async () => {
    await context.setStockDirect('caramel', 10);
    await context.setStockDirect('pretzel', 1);
    await expectApiError(
      placeOrder([
        ['caramel', 5],
        ['pretzel', 2],
      ]),
      'insufficient_stock',
    );
    expect(await context.stockOf('caramel')).toBe(10);
    expect(await context.stockOf('pretzel')).toBe(1);
    expect(await context.count('orders')).toBe(0);
    expect(await context.count('order_items')).toBe(0);
    expect(await context.count('stock_adjustments')).toBe(0);
  });

  it('rejects orders while ordering is closed', async () => {
    await context.setStockDirect('caramel', 10);
    await setOrderingEnabled(context.db, false);
    await expectApiError(placeOrder([['caramel', 1]]), 'ordering_closed');
    expect(await context.stockOf('caramel')).toBe(10);
  });

  it('rolls back if ordering closes between the pre-check and the write', async () => {
    await context.setStockDirect('caramel', 10);
    const caramelId = await context.productId('caramel');
    // Simulate the race by closing ordering inside the same batch the order would use.
    const db = context.db;
    const racingDb = {
      prepare: (query: string) => db.prepare(query),
      batch: async (statements: D1PreparedStatement[]) => {
        await setOrderingEnabled(db, false);
        return db.batch(statements);
      },
    } as unknown as D1Database;
    await expectApiError(
      createOrder(racingDb, {
        submissionId: crypto.randomUUID(),
        details: CUSTOMER,
        items: [{ productId: caramelId, quantity: 1 }],
      }),
      'ordering_closed',
    );
    expect(await context.stockOf('caramel')).toBe(10);
    expect(await context.count('orders')).toBe(0);
  });

  it('returns the original order for a duplicate submission', async () => {
    await context.setStockDirect('caramel', 10);
    const submissionId = crypto.randomUUID();
    const first = await placeOrder([['caramel', 2]], submissionId);
    const second = await placeOrder([['caramel', 2]], submissionId);
    expect(second.created).toBe(false);
    expect(second.confirmation.orderNumber).toBe(first.confirmation.orderNumber);
    expect(await context.stockOf('caramel')).toBe(8);
    expect(await context.count('orders')).toBe(1);
  });

  it('never oversells under concurrent submissions', async () => {
    await context.setStockDirect('milk-chocolate', 10);
    const attempts = await Promise.allSettled(
      Array.from({ length: 12 }, () => placeOrder([['milk-chocolate', 3]])),
    );
    const succeeded = attempts.filter((attempt) => attempt.status === 'fulfilled').length;
    expect(succeeded).toBe(3);
    expect(await context.stockOf('milk-chocolate')).toBe(1);
    const reserved = await context.db
      .prepare('SELECT COALESCE(SUM(quantity), 0) AS total FROM order_items')
      .first<{ total: number }>();
    expect(reserved?.total).toBe(9);
    for (const attempt of attempts) {
      if (attempt.status === 'rejected') expect(attempt.reason).toBeInstanceOf(ApiError);
    }
  });
});

describe('cancellation', () => {
  it('restores reserved inventory exactly once', async () => {
    await context.setStockDirect('caramel', 10);
    await context.setStockDirect('almond', 10);
    const { confirmation } = await placeOrder([
      ['caramel', 4],
      ['almond', 1],
    ]);
    const orderId = await orderIdFor(confirmation.orderNumber);

    const first = await cancelOrder(context.db, orderId);
    expect(first.restored).toBe(true);
    expect(first.order.status).toBe('cancelled');
    expect(first.order.cancelledAt).not.toBeNull();
    expect(await context.stockOf('caramel')).toBe(10);
    expect(await context.stockOf('almond')).toBe(10);

    const second = await cancelOrder(context.db, orderId);
    expect(second.restored).toBe(false);
    expect(await context.stockOf('caramel')).toBe(10);
    expect(await context.stockOf('almond')).toBe(10);
  });

  it('restores once even when cancelled concurrently', async () => {
    await context.setStockDirect('crisp', 10);
    const { confirmation } = await placeOrder([['crisp', 6]]);
    const orderId = await orderIdFor(confirmation.orderNumber);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => cancelOrder(context.db, orderId)),
    );
    expect(results.filter((result) => result.restored)).toHaveLength(1);
    expect(await context.stockOf('crisp')).toBe(10);
    const restocks = await context.db
      .prepare(`SELECT COUNT(*) AS total FROM stock_adjustments WHERE reason = 'cancellation'`)
      .first<{ total: number }>();
    expect(restocks?.total).toBe(1);
  });

  it('can cancel a packed order', async () => {
    await context.setStockDirect('crisp', 5);
    const { confirmation } = await placeOrder([['crisp', 5]]);
    const orderId = await orderIdFor(confirmation.orderNumber);
    await updateOrderStatus(context.db, orderId, 'packed');
    expect((await cancelOrder(context.db, orderId)).restored).toBe(true);
    expect(await context.stockOf('crisp')).toBe(5);
  });

  it('does not restore inventory for delivered orders', async () => {
    await context.setStockDirect('wafer', 5);
    const { confirmation } = await placeOrder([['wafer', 2]]);
    const orderId = await orderIdFor(confirmation.orderNumber);
    await updateOrderStatus(context.db, orderId, 'delivered');
    expect(await context.stockOf('wafer')).toBe(3);
    await expectApiError(cancelOrder(context.db, orderId), 'invalid_transition');
    expect(await context.stockOf('wafer')).toBe(3);
  });
});

describe('delivery and payment states', () => {
  async function newOrderId() {
    await context.setStockDirect('pretzel', 10);
    const { confirmation } = await placeOrder([['pretzel', 1]]);
    return orderIdFor(confirmation.orderNumber);
  }

  it('moves through new → packed → delivered', async () => {
    const orderId = await newOrderId();
    expect((await updateOrderStatus(context.db, orderId, 'packed')).status).toBe('packed');
    expect((await updateOrderStatus(context.db, orderId, 'delivered')).status).toBe('delivered');
    // Undo a mistaken "delivered" tap.
    expect((await updateOrderStatus(context.db, orderId, 'packed')).status).toBe('packed');
  });

  it('rejects invalid transitions', async () => {
    const orderId = await newOrderId();
    await updateOrderStatus(context.db, orderId, 'delivered');
    await expectApiError(updateOrderStatus(context.db, orderId, 'new'), 'invalid_transition');
    await expectApiError(updateOrderStatus(context.db, orderId, 'cancelled'), 'use_cancel');

    const cancelledId = await newOrderId();
    await cancelOrder(context.db, cancelledId);
    await expectApiError(
      updateOrderStatus(context.db, cancelledId, 'packed'),
      'invalid_transition',
    );
  });

  it('tracks payment independently of delivery', async () => {
    const orderId = await newOrderId();
    const paid = await updatePaymentStatus(context.db, orderId, 'paid');
    expect(paid.paymentStatus).toBe('paid');
    expect(paid.status).toBe('new');
    const delivered = await updateOrderStatus(context.db, orderId, 'delivered');
    expect(delivered.paymentStatus).toBe('paid');
    expect((await updatePaymentStatus(context.db, orderId, 'unpaid')).status).toBe('delivered');
  });
});
