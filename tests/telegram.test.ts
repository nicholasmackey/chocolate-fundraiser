import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatOrderMessage,
  notifyNewOrder,
  sendTelegramMessage,
  type OrderNotice,
} from '../worker/src/telegram';
import { CUSTOMER } from './helpers';

const NOTICE: OrderNotice = {
  details: CUSTOMER,
  confirmation: {
    orderNumber: 'WFC-ABC234',
    totalBars: 5,
    totalCents: 1000,
    items: [
      { productName: 'Caramel', quantity: 3, lineTotalCents: 600 },
      { productName: 'Almond', quantity: 2, lineTotalCents: 400 },
    ],
  },
};

function telegramResponse(status: number, body: unknown = { ok: status === 200, result: {} }) {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('formatOrderMessage', () => {
  it('includes every order detail and an admin link', () => {
    const text = formatOrderMessage(NOTICE, 'https://example.github.io/fundraiser/admin/');
    expect(text).toContain('WFC-ABC234');
    expect(text).toContain('Maria Gonzalez');
    expect(text).toContain('+1 512-555-0142');
    expect(text).toContain('418 Maple Grove Ln, Austin, TX 78704');
    expect(text).toContain('Leave by the side gate, please.');
    expect(text).toContain('3 × Caramel');
    expect(text).toContain('2 × Almond');
    expect(text).toContain('Total: $10.00</b> (5 bars)');
    expect(text).toContain(
      '<a href="https://example.github.io/fundraiser/admin/orders?status=all&amp;q=WFC-ABC234">',
    );
  });

  it('escapes customer-supplied HTML', () => {
    const text = formatOrderMessage({
      ...NOTICE,
      details: { ...CUSTOMER, customerName: '<b>Eve</b> & co', deliveryInstructions: '</i><a>' },
    });
    expect(text).toContain('&lt;b&gt;Eve&lt;/b&gt; &amp; co');
    expect(text).toContain('&lt;/i&gt;&lt;a&gt;');
    expect(text).not.toContain('Open in Admin');
  });
});

describe('sendTelegramMessage', () => {
  it('retries once on server errors and returns detected entities', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(telegramResponse(502))
      .mockResolvedValueOnce(
        telegramResponse(200, { ok: true, result: { entities: [{ type: 'phone_number' }] } }),
      );
    const result = await sendTelegramMessage('token', '42', 'hi', fetcher);
    expect(result).toEqual({ ok: true, status: 200, entityTypes: ['phone_number'] });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect(body).toMatchObject({ chat_id: '42', text: 'hi', parse_mode: 'HTML' });
  });

  it('does not retry client errors', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(telegramResponse(400));
    expect((await sendTelegramMessage('token', '42', 'hi', fetcher)).ok).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('notifyNewOrder', () => {
  it('never throws and never logs customer details or the token', async () => {
    const logs: string[] = [];
    for (const method of ['log', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((line: string) => logs.push(line));
    }
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('failed https://api.telegram.org/botSECRET-TOKEN/sendMessage'));
    await notifyNewOrder({ botToken: 'SECRET-TOKEN', chatId: '42' }, NOTICE, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const output = logs.join('\n');
    expect(output).toContain('telegram_failed');
    expect(output).toContain('WFC-ABC234');
    for (const secret of ['SECRET-TOKEN', 'Maria', '555', 'Maple', 'Caramel']) {
      expect(output).not.toContain(secret);
    }
  });

  it('skips sending when not configured', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetcher = vi.fn<typeof fetch>();
    await notifyNewOrder({}, NOTICE, fetcher);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
