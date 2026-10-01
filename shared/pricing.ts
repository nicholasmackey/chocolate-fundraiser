import type { Availability } from './types';

export const BAR_PRICE_CENTS = 200;
export const BOX_SIZE = 40;
export const BOX_PRICE_CENTS = BAR_PRICE_CENTS * BOX_SIZE;

/** Upper bound for a single order, to stop absurd or abusive requests. */
export const MAX_BARS_PER_ORDER = 400;

const currencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
});

export function formatCents(cents: number): string {
  return currencyFormatter.format(cents / 100);
}

export interface PricedLine {
  productId: number;
  productName: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

export interface PricedOrder {
  lines: PricedLine[];
  totalBars: number;
  totalCents: number;
}

/**
 * Prices an order using trusted product prices only. Quantities must already
 * be validated as positive integers.
 */
export function priceOrder(
  requested: ReadonlyArray<{ productId: number; quantity: number }>,
  products: ReadonlyArray<{ id: number; name: string; priceCents: number }>,
): PricedOrder {
  const productsById = new Map(products.map((product) => [product.id, product]));
  const lines = requested.map((line) => {
    const product = productsById.get(line.productId);
    if (!product) {
      throw new Error(`Unknown product ${line.productId}`);
    }
    return {
      productId: product.id,
      productName: product.name,
      quantity: line.quantity,
      unitPriceCents: product.priceCents,
      lineTotalCents: product.priceCents * line.quantity,
    };
  });
  return {
    lines,
    totalBars: lines.reduce((sum, line) => sum + line.quantity, 0),
    totalCents: lines.reduce((sum, line) => sum + line.lineTotalCents, 0),
  };
}

export function getAvailability(stockQuantity: number, lowStockThreshold: number): Availability {
  if (stockQuantity <= 0) return 'sold_out';
  if (stockQuantity <= lowStockThreshold) return 'going_fast';
  return 'available';
}
