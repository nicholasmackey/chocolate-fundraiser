/**
 * Permanently deletes all customer and order data after the fundraiser.
 * Product inventory and the (anonymous) stock-adjustment history are kept.
 */
export async function purgeCustomerData(db: D1Database): Promise<{ deletedOrders: number }> {
  const results = await db.batch([
    db.prepare('UPDATE stock_adjustments SET order_id = NULL WHERE order_id IS NOT NULL'),
    db.prepare('DELETE FROM order_items'),
    db.prepare('DELETE FROM orders'),
    db.prepare('DELETE FROM rate_limits'),
  ]);
  return { deletedOrders: results[2]?.meta.changes ?? 0 };
}
