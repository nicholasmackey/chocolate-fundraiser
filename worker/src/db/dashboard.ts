import { listOrders } from './orders';
import { getInventory } from './inventory';
import { isOrderingEnabled } from './settings';

export async function getDashboard(db: D1Database) {
  const [totals, inventory, recentOrders, orderingEnabled] = await Promise.all([
    db
      .prepare(
        `SELECT
           COUNT(*) FILTER (WHERE status <> 'cancelled') AS total_orders,
           COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_orders,
           COUNT(*) FILTER (WHERE status IN ('new', 'packed')) AS awaiting_delivery,
           COALESCE(SUM(total_cents) FILTER (WHERE status <> 'cancelled'), 0) AS sales_cents,
           COALESCE(SUM(total_cents) FILTER (WHERE status <> 'cancelled' AND payment_status = 'paid'), 0) AS paid_cents,
           COALESCE(SUM(total_bars) FILTER (WHERE status <> 'cancelled'), 0) AS bars_sold
         FROM orders`,
      )
      .first<{
        total_orders: number;
        cancelled_orders: number;
        awaiting_delivery: number;
        sales_cents: number;
        paid_cents: number;
        bars_sold: number;
      }>(),
    getInventory(db),
    listOrders(db, { limit: 5 }),
    isOrderingEnabled(db),
  ]);

  return {
    metrics: {
      totalOrders: totals?.total_orders ?? 0,
      cancelledOrders: totals?.cancelled_orders ?? 0,
      awaitingDelivery: totals?.awaiting_delivery ?? 0,
      salesCents: totals?.sales_cents ?? 0,
      paidCents: totals?.paid_cents ?? 0,
      barsSold: totals?.bars_sold ?? 0,
      barsRemaining: inventory.reduce((sum, product) => sum + product.stockQuantity, 0),
    },
    orderingEnabled,
    inventory,
    lowStock: inventory.filter((product) => product.stockQuantity <= product.lowStockThreshold),
    recentOrders,
  };
}
