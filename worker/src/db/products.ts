import { getAvailability } from '../../../shared/pricing';
import type { Product, PublicProduct } from '../../../shared/types';

interface ProductRow {
  id: number;
  slug: string;
  name: string;
  description: string;
  price_cents: number;
  stock_quantity: number;
  low_stock_threshold: number;
  sort_order: number;
}

function mapProduct(row: ProductRow): Product {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    priceCents: row.price_cents,
    stockQuantity: row.stock_quantity,
    lowStockThreshold: row.low_stock_threshold,
    sortOrder: row.sort_order,
  };
}

export async function listProducts(db: D1Database): Promise<Product[]> {
  const { results } = await db
    .prepare(
      `SELECT id, slug, name, description, price_cents, stock_quantity, low_stock_threshold, sort_order
       FROM products ORDER BY sort_order, id`,
    )
    .all<ProductRow>();
  return results.map(mapProduct);
}

export async function getProduct(db: D1Database, productId: number): Promise<Product | null> {
  const row = await db
    .prepare(
      `SELECT id, slug, name, description, price_cents, stock_quantity, low_stock_threshold, sort_order
       FROM products WHERE id = ?`,
    )
    .bind(productId)
    .first<ProductRow>();
  return row ? mapProduct(row) : null;
}

export function toPublicProduct(product: Product): PublicProduct {
  return {
    id: product.id,
    slug: product.slug,
    name: product.name,
    description: product.description,
    priceCents: product.priceCents,
    available: product.stockQuantity,
    availability: getAvailability(product.stockQuantity, product.lowStockThreshold),
  };
}
