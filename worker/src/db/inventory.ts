import { ApiError } from '../http';
import { getProduct, listProducts } from './products';
import type { Product } from '../../../shared/types';

export const MAX_STOCK_QUANTITY = 100_000;
const NOW_SQL = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

export interface InventoryRow extends Product {
  /** Bars in orders that are New or Packed. Already deducted from stockQuantity. */
  reservedQuantity: number;
  deliveredQuantity: number;
}

export interface StockAdjustment {
  id: number;
  productId: number;
  productName: string;
  quantityChange: number;
  quantityAfter: number;
  reason: string;
  note: string;
  orderNumber: string | null;
  createdAt: string;
}

export async function getInventory(db: D1Database): Promise<InventoryRow[]> {
  const [products, { results }] = await Promise.all([
    listProducts(db),
    db
      .prepare(
        `SELECT oi.product_id,
           SUM(CASE WHEN o.status IN ('new', 'packed') THEN oi.quantity ELSE 0 END) AS reserved,
           SUM(CASE WHEN o.status = 'delivered' THEN oi.quantity ELSE 0 END) AS delivered
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
         GROUP BY oi.product_id`,
      )
      .all<{ product_id: number; reserved: number; delivered: number }>(),
  ]);
  const totals = new Map(results.map((row) => [row.product_id, row]));
  return products.map((product) => ({
    ...product,
    reservedQuantity: totals.get(product.id)?.reserved ?? 0,
    deliveredQuantity: totals.get(product.id)?.delivered ?? 0,
  }));
}

export async function listStockAdjustments(db: D1Database, limit = 50): Promise<StockAdjustment[]> {
  const { results } = await db
    .prepare(
      `SELECT sa.id, sa.product_id, p.name AS product_name, sa.quantity_change, sa.quantity_after,
         sa.reason, sa.note, o.order_number, sa.created_at
       FROM stock_adjustments sa
       JOIN products p ON p.id = sa.product_id
       LEFT JOIN orders o ON o.id = sa.order_id
       ORDER BY sa.id DESC LIMIT ?`,
    )
    .bind(Math.min(Math.max(limit, 1), 500))
    .all<{
      id: number;
      product_id: number;
      product_name: string;
      quantity_change: number;
      quantity_after: number;
      reason: string;
      note: string;
      order_number: string | null;
      created_at: string;
    }>();
  return results.map((row) => ({
    id: row.id,
    productId: row.product_id,
    productName: row.product_name,
    quantityChange: row.quantity_change,
    quantityAfter: row.quantity_after,
    reason: row.reason,
    note: row.note,
    orderNumber: row.order_number,
    createdAt: row.created_at,
  }));
}

async function requireProduct(db: D1Database, productId: number): Promise<Product> {
  const product = await getProduct(db, productId);
  if (!product) throw new ApiError(404, 'not_found', 'Flavor not found.');
  return product;
}

function assertQuantity(value: number, label: string, { allowNegative = false } = {}): void {
  const minimum = allowNegative ? -MAX_STOCK_QUANTITY : 0;
  if (!Number.isSafeInteger(value) || value < minimum || value > MAX_STOCK_QUANTITY) {
    throw new ApiError(400, 'invalid_quantity', `${label} must be a whole number.`);
  }
}

/** Sets available stock to an exact count (e.g. after counting boxes) and records the change. */
export async function setStock(
  db: D1Database,
  productId: number,
  quantity: number,
  note = '',
): Promise<Product> {
  assertQuantity(quantity, 'Stock');
  await requireProduct(db, productId);
  await db.batch([
    db
      .prepare(
        `INSERT INTO stock_adjustments (product_id, quantity_change, quantity_after, reason, note)
         SELECT id, ?1 - stock_quantity, ?1, 'admin_set', ?2 FROM products
         WHERE id = ?3 AND stock_quantity <> ?1`,
      )
      .bind(quantity, note, productId),
    db
      .prepare(`UPDATE products SET stock_quantity = ?, updated_at = ${NOW_SQL} WHERE id = ?`)
      .bind(quantity, productId),
  ]);
  return requireProduct(db, productId);
}

/** Adds or removes bars. Rejected if it would make stock negative. */
export async function adjustStock(
  db: D1Database,
  productId: number,
  delta: number,
  note = '',
): Promise<Product> {
  assertQuantity(delta, 'Adjustment', { allowNegative: true });
  if (delta === 0) throw new ApiError(400, 'invalid_quantity', 'Adjustment cannot be zero.');
  await requireProduct(db, productId);
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO stock_adjustments (product_id, quantity_change, quantity_after, reason, note)
         SELECT id, ?1, stock_quantity + ?1, 'admin_adjust', ?2 FROM products
         WHERE id = ?3 AND stock_quantity + ?1 BETWEEN 0 AND ?4`,
      )
      .bind(delta, note, productId, MAX_STOCK_QUANTITY),
    db
      .prepare(
        `UPDATE products SET stock_quantity = stock_quantity + ?1, updated_at = ${NOW_SQL}
         WHERE id = ?2 AND stock_quantity + ?1 BETWEEN 0 AND ?3`,
      )
      .bind(delta, productId, MAX_STOCK_QUANTITY),
  ]);
  if (results[1]?.meta.changes !== 1) {
    throw new ApiError(409, 'insufficient_stock', 'That would make stock negative.');
  }
  return requireProduct(db, productId);
}

export async function setLowStockThreshold(
  db: D1Database,
  productId: number,
  threshold: number,
): Promise<Product> {
  if (!Number.isSafeInteger(threshold) || threshold < 0 || threshold > 10_000) {
    throw new ApiError(400, 'invalid_quantity', 'Threshold must be a whole number.');
  }
  await requireProduct(db, productId);
  await db
    .prepare(`UPDATE products SET low_stock_threshold = ?, updated_at = ${NOW_SQL} WHERE id = ?`)
    .bind(threshold, productId)
    .run();
  return requireProduct(db, productId);
}
