import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  adjustStock,
  getInventory,
  listStockAdjustments,
  setLowStockThreshold,
  setStock,
} from '../worker/src/db/inventory';
import { ApiError } from '../worker/src/http';
import { createTestContext, type TestContext } from './helpers';

let context: TestContext;

beforeAll(async () => {
  context = await createTestContext();
});
afterAll(async () => {
  await context.proxy.dispose();
});
beforeEach(async () => {
  await context.reset();
});

describe('inventory management', () => {
  it('sets initial stock and records an audit entry', async () => {
    const caramelId = await context.productId('caramel');
    await setStock(context.db, caramelId, 120, 'Initial count');
    expect(await context.stockOf('caramel')).toBe(120);
    const [adjustment] = await listStockAdjustments(context.db);
    expect(adjustment).toMatchObject({
      productName: 'Caramel',
      quantityChange: 120,
      quantityAfter: 120,
      reason: 'admin_set',
      note: 'Initial count',
    });
  });

  it('increases and decreases stock', async () => {
    const almondId = await context.productId('almond');
    await setStock(context.db, almondId, 10);
    await adjustStock(context.db, almondId, 40);
    await adjustStock(context.db, almondId, -15);
    expect(await context.stockOf('almond')).toBe(35);
    expect(await context.count('stock_adjustments')).toBe(3);
  });

  it('refuses adjustments that would make stock negative', async () => {
    const almondId = await context.productId('almond');
    await setStock(context.db, almondId, 3);
    await expect(adjustStock(context.db, almondId, -4)).rejects.toBeInstanceOf(ApiError);
    await expect(setStock(context.db, almondId, -1)).rejects.toBeInstanceOf(ApiError);
    expect(await context.stockOf('almond')).toBe(3);
    expect(await context.count('stock_adjustments')).toBe(1);
  });

  it('configures low-stock thresholds', async () => {
    const wafer = await setLowStockThreshold(context.db, await context.productId('wafer'), 25);
    expect(wafer.lowStockThreshold).toBe(25);
    const inventory = await getInventory(context.db);
    expect(inventory.find((product) => product.slug === 'wafer')?.lowStockThreshold).toBe(25);
  });
});
