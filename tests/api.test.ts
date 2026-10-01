import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handleRequest, type Dependencies } from '../worker/src/index';
import type { OrderNotice } from '../worker/src/telegram';
import {
  createTestContext,
  CUSTOMER,
  TEST_ORIGIN,
  TEST_PASSWORD,
  type TestContext,
} from './helpers';

let context: TestContext;
let turnstileResult = true;
let notifications: OrderNotice[] = [];
let pending: Promise<unknown>[] = [];
const deps: Dependencies = {
  verifyTurnstile: async () => turnstileResult,
  notifyNewOrder: async (_config, notice) => {
    notifications.push(notice);
  },
  waitUntil: (promise) => pending.push(promise),
};

beforeAll(async () => {
  context = await createTestContext();
});
afterAll(async () => {
  await context.proxy.dispose();
});
beforeEach(async () => {
  turnstileResult = true;
  notifications = [];
  pending = [];
  await context.reset();
});

interface RequestOptions {
  method?: string;
  body?: unknown;
  token?: string;
  origin?: string | null;
  ip?: string;
}

function call(path: string, options: RequestOptions = {}) {
  const headers = new Headers({ 'CF-Connecting-IP': options.ip ?? '203.0.113.7' });
  if (options.origin !== null) headers.set('Origin', options.origin ?? TEST_ORIGIN);
  if (options.token) headers.set('Authorization', `Bearer ${options.token}`);
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  const request = new Request(`https://api.example${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return handleRequest(request, context.env, deps);
}

async function signIn(): Promise<string> {
  const response = await call('/api/admin/login', { body: { password: TEST_PASSWORD } });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { token: string };
  return body.token;
}

const PROTECTED_ENDPOINTS: Array<[method: string, path: string]> = [
  ['GET', '/api/admin/session'],
  ['GET', '/api/admin/dashboard'],
  ['GET', '/api/admin/orders'],
  ['GET', '/api/admin/orders.csv'],
  ['GET', '/api/admin/inventory'],
  ['POST', '/api/admin/logout'],
  ['POST', '/api/admin/orders/00000000-0000-4000-8000-000000000000/status'],
  ['POST', '/api/admin/orders/00000000-0000-4000-8000-000000000000/payment'],
  ['POST', '/api/admin/orders/00000000-0000-4000-8000-000000000000/cancel'],
  ['POST', '/api/admin/inventory/1/set'],
  ['POST', '/api/admin/inventory/1/adjust'],
  ['POST', '/api/admin/inventory/1/threshold'],
  ['POST', '/api/admin/settings/ordering'],
  ['POST', '/api/admin/data/purge'],
];

describe('admin authorization', () => {
  it.each(PROTECTED_ENDPOINTS)('%s %s requires a session', async (method, path) => {
    const response = await call(path, { method, body: method === 'POST' ? {} : undefined });
    expect(response.status).toBe(401);
  });

  it.each(PROTECTED_ENDPOINTS)('%s %s rejects a forged token', async (method, path) => {
    const response = await call(path, {
      method,
      body: method === 'POST' ? {} : undefined,
      token: 'forged-token-forged-token-forged-token',
    });
    expect(response.status).toBe(401);
  });

  it('rejects a wrong password', async () => {
    const response = await call('/api/admin/login', { body: { password: 'nope' } });
    expect(response.status).toBe(401);
  });

  it('signs in, uses the session, and revokes it on logout', async () => {
    const token = await signIn();
    expect((await call('/api/admin/dashboard', { token })).status).toBe(200);
    expect((await call('/api/admin/logout', { method: 'POST', body: {}, token })).status).toBe(200);
    expect((await call('/api/admin/dashboard', { token })).status).toBe(401);
  });

  it('stores only a hash of the session token', async () => {
    const token = await signIn();
    const row = await context.db
      .prepare('SELECT token_hash FROM admin_sessions')
      .first<{ token_hash: string }>();
    expect(row?.token_hash).not.toContain(token);
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects expired sessions', async () => {
    const token = await signIn();
    await context.db
      .prepare(`UPDATE admin_sessions SET expires_at = '2000-01-01T00:00:00.000Z'`)
      .run();
    expect((await call('/api/admin/dashboard', { token })).status).toBe(401);
  });

  it('rate-limits repeated sign-in attempts', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt++) {
      statuses.push((await call('/api/admin/login', { body: { password: 'wrong' } })).status);
    }
    expect(statuses.slice(0, 10).every((status) => status === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('rejects state-changing requests from other origins', async () => {
    const token = await signIn();
    const response = await call('/api/admin/settings/ordering', {
      body: { enabled: true },
      token,
      origin: 'https://evil.example',
    });
    expect(response.status).toBe(403);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('exports CSV with formula injection neutralized', async () => {
    await context.openOrdering();
    await context.setStockDirect('caramel', 10);
    const caramelId = await context.productId('caramel');
    await call('/api/orders', {
      body: {
        submissionId: crypto.randomUUID(),
        turnstileToken: 'ok',
        details: { ...CUSTOMER, deliveryInstructions: '=HYPERLINK("http://evil")' },
        items: [{ productId: caramelId, quantity: 2 }],
      },
    });
    const token = await signIn();
    const response = await call('/api/admin/orders.csv', { token });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/csv');
    const csv = await response.text();
    expect(csv).toContain('Maria Gonzalez');
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`);
  });

  it('purges customer data only with explicit confirmation', async () => {
    await context.openOrdering();
    await context.setStockDirect('caramel', 10);
    await call('/api/orders', {
      body: {
        submissionId: crypto.randomUUID(),
        turnstileToken: 'ok',
        details: CUSTOMER,
        items: [{ productId: await context.productId('caramel'), quantity: 1 }],
      },
    });
    const token = await signIn();
    expect((await call('/api/admin/data/purge', { body: { confirm: 'yes' }, token })).status).toBe(
      400,
    );
    expect(await context.count('orders')).toBe(1);
    const response = await call('/api/admin/data/purge', {
      body: { confirm: 'DELETE ALL ORDERS' },
      token,
    });
    expect(response.status).toBe(200);
    expect(await context.count('orders')).toBe(0);
    expect(await context.stockOf('caramel')).toBe(9);
  });
});

describe('public API', () => {
  it('answers CORS preflight only for the allowed origin', async () => {
    const allowed = await call('/api/orders', { method: 'OPTIONS' });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe(TEST_ORIGIN);
    expect(allowed.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    const denied = await call('/api/orders', { method: 'OPTIONS', origin: 'https://evil.example' });
    expect(denied.status).toBe(403);
  });

  it('reports a coming-soon storefront when everything is at zero', async () => {
    await context.openOrdering();
    const response = await call('/api/storefront');
    const body = (await response.json()) as {
      state: string;
      products: Array<Record<string, unknown>>;
    };
    expect(body.state).toBe('coming_soon');
    expect(body.products).toHaveLength(6);
    expect(body.products[0]).not.toHaveProperty('lowStockThreshold');
  });

  it('creates an order through the API and ignores submitted prices', async () => {
    await context.openOrdering();
    await context.setStockDirect('almond', 30);
    const response = await call('/api/orders', {
      body: {
        submissionId: crypto.randomUUID(),
        turnstileToken: 'ok',
        details: CUSTOMER,
        items: [{ productId: await context.productId('almond'), quantity: 4, priceCents: 1 }],
        totalCents: 1,
      },
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { order: Record<string, unknown> };
    expect(body.order.totalCents).toBe(800);
    expect(body.order).not.toHaveProperty('customerName');
    expect(await context.stockOf('almond')).toBe(26);
  });

  it('sends one notification per new order, after the order is saved', async () => {
    await context.openOrdering();
    await context.setStockDirect('almond', 30);
    const order = {
      submissionId: crypto.randomUUID(),
      turnstileToken: 'ok',
      details: CUSTOMER,
      items: [{ productId: await context.productId('almond'), quantity: 2 }],
    };
    expect((await call('/api/orders', { body: order })).status).toBe(201);
    // A retried submission returns the original order without notifying again.
    expect((await call('/api/orders', { body: order })).status).toBe(200);
    await Promise.all(pending);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.details.phone).toBe(CUSTOMER.phone);
    expect(notifications[0]!.confirmation.items).toEqual([
      { productName: 'Almond', quantity: 2, lineTotalCents: 400 },
    ]);
  });

  it('keeps the order and inventory when the notification fails', async () => {
    await context.openOrdering();
    await context.setStockDirect('almond', 30);
    const failingDeps: Dependencies = {
      ...deps,
      notifyNewOrder: () => Promise.reject(new Error('Telegram is down')),
      waitUntil: (promise) => pending.push(promise.catch(() => undefined)),
    };
    const request = new Request('https://api.example/api/orders', {
      method: 'POST',
      headers: { Origin: TEST_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        submissionId: crypto.randomUUID(),
        turnstileToken: 'ok',
        details: CUSTOMER,
        items: [{ productId: await context.productId('almond'), quantity: 3 }],
      }),
    });
    const response = await handleRequest(request, context.env, failingDeps);
    await Promise.all(pending);
    expect(response.status).toBe(201);
    expect(await context.stockOf('almond')).toBe(27);
    expect(await context.count('orders')).toBe(1);
  });

  it('requires a valid phone number', async () => {
    for (const phone of ['', '555-0142', '(012) 555-0142']) {
      const response = await call('/api/orders', {
        body: {
          submissionId: crypto.randomUUID(),
          details: { ...CUSTOMER, phone },
          items: [{ productId: await context.productId('almond'), quantity: 1 }],
        },
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { details: Record<string, string> } };
      expect(body.error.details).toHaveProperty('phone');
    }
    expect(notifications).toHaveLength(0);
  });

  it('rejects orders that fail Turnstile', async () => {
    await context.openOrdering();
    await context.setStockDirect('almond', 30);
    turnstileResult = false;
    const response = await call('/api/orders', {
      body: {
        submissionId: crypto.randomUUID(),
        turnstileToken: 'bad',
        details: CUSTOMER,
        items: [{ productId: await context.productId('almond'), quantity: 1 }],
      },
    });
    expect(response.status).toBe(400);
    expect(await context.stockOf('almond')).toBe(30);
  });

  it('returns field errors for invalid checkout details', async () => {
    const response = await call('/api/orders', {
      body: { submissionId: crypto.randomUUID(), details: { ...CUSTOMER, zip: 'abc' }, items: [] },
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { details: Record<string, string> } };
    expect(Object.keys(body.error.details).sort()).toEqual(['items', 'zip']);
  });

  it('rate-limits order submissions per client', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      statuses.push(
        (await call('/api/orders', { body: { submissionId: 'x' }, ip: '198.51.100.9' })).status,
      );
    }
    expect(statuses.slice(0, 5).every((status) => status === 400)).toBe(true);
    expect(statuses[5]).toBe(429);
  });
});
