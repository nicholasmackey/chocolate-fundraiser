import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPlatformProxy } from 'wrangler';
import { hashPassword } from '../worker/src/crypto';
import type { AppEnv } from '../worker/src/env';
import type { CheckoutDetails } from '../shared/validation';

const root = join(import.meta.dirname, '..');

function splitStatements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(/;\s*(?:\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function readSql(path: string): string[] {
  return splitStatements(readFileSync(path, 'utf8'));
}

export const TEST_ORIGIN = 'https://fundraiser.example';
export const TEST_PASSWORD = 'correct horse battery staple';

/**
 * Starts an isolated, in-memory D1 database (persist: false). Tests never
 * touch the local development database or any remote Cloudflare resource.
 */
export async function createTestContext() {
  const proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: join(root, 'wrangler.jsonc'),
    persist: false,
    environment: undefined,
  });
  const db = proxy.env.DB;

  const migrationsDir = join(root, 'migrations');
  for (const file of readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    await db.batch(readSql(join(migrationsDir, file)).map((statement) => db.prepare(statement)));
  }

  const env: AppEnv = {
    DB: db,
    ALLOWED_ORIGINS: TEST_ORIGIN,
    TURNSTILE_EXPECTED_HOSTNAME: '',
    ADMIN_PASSWORD_HASH: await hashPassword(TEST_PASSWORD),
    SESSION_SECRET: 'test-session-secret-that-is-long-enough-123',
    TURNSTILE_SECRET_KEY: 'test-turnstile-secret',
  };

  async function reset() {
    await db.batch(
      [
        'DELETE FROM stock_adjustments',
        'DELETE FROM order_items',
        'DELETE FROM orders',
        'DELETE FROM admin_sessions',
        'DELETE FROM rate_limits',
        'DELETE FROM app_settings',
        'DELETE FROM products',
      ].map((statement) => db.prepare(statement)),
    );
    await db.batch(
      readSql(join(root, 'seed', 'seed.sql')).map((statement) => db.prepare(statement)),
    );
  }

  async function productId(slug: string): Promise<number> {
    const row = await db
      .prepare('SELECT id FROM products WHERE slug = ?')
      .bind(slug)
      .first<{ id: number }>();
    if (!row) throw new Error(`Missing product ${slug}`);
    return row.id;
  }

  async function stockOf(slug: string): Promise<number> {
    const row = await db
      .prepare('SELECT stock_quantity FROM products WHERE slug = ?')
      .bind(slug)
      .first<{ stock_quantity: number }>();
    return row!.stock_quantity;
  }

  async function setStockDirect(slug: string, quantity: number) {
    await db
      .prepare('UPDATE products SET stock_quantity = ? WHERE slug = ?')
      .bind(quantity, slug)
      .run();
  }

  async function openOrdering() {
    await db.prepare(`UPDATE app_settings SET value = '1' WHERE key = 'ordering_enabled'`).run();
  }

  async function count(table: string): Promise<number> {
    const row = await db
      .prepare(`SELECT COUNT(*) AS total FROM ${table}`)
      .first<{ total: number }>();
    return row!.total;
  }

  return { proxy, db, env, reset, productId, stockOf, setStockDirect, openOrdering, count };
}

export type TestContext = Awaited<ReturnType<typeof createTestContext>>;

export const CUSTOMER: CheckoutDetails = {
  customerName: 'Maria Gonzalez',
  phone: '(512) 555-0142',
  street: '418 Maple Grove Ln',
  city: 'Austin',
  state: 'TX',
  zip: '78704',
  deliveryInstructions: 'Leave by the side gate, please.',
};
