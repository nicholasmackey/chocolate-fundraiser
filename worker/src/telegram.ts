// Explicit .ts extensions let scripts/telegram-setup.ts run this file directly under Node.
import { formatCents } from '../../shared/pricing.ts';
import type { OrderConfirmation } from '../../shared/types.ts';
import type { CheckoutDetails } from '../../shared/validation.ts';
import { logger } from './logger.ts';

export interface OrderNotice {
  confirmation: OrderConfirmation;
  details: CheckoutDetails;
}

export interface TelegramConfig {
  botToken?: string;
  chatId?: string;
  /** Base URL of the admin UI, e.g. https://user.github.io/chocolate-fundraiser/admin */
  adminUrl?: string;
}

export interface TelegramSendResult {
  ok: boolean;
  /** HTTP status from Telegram, or 0 when the request never got a response. */
  status: number;
  /** Entity types Telegram detected (e.g. "phone_number"). Never contains message text. */
  entityTypes: string[];
}

const SEND_TIMEOUT_MS = 8_000;
const RETRY_DELAY_MS = 1_500;

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** "(512) 555-0142" → "+1 512-555-0142", a format Telegram turns into a tappable phone link. */
export function internationalPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '').slice(-10);
  return `+1 ${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
}

export function adminOrderLink(adminUrl: string, orderNumber: string): string {
  const params = new URLSearchParams({ status: 'all', q: orderNumber });
  return `${adminUrl.replace(/\/+$/, '')}/orders?${params}`;
}

/** Formats the notification as Telegram HTML. Every customer-supplied value is escaped. */
export function formatOrderMessage(notice: OrderNotice, adminUrl?: string): string {
  const { confirmation: order, details } = notice;
  const lines = [
    `🍫 <b>New order ${escapeHtml(order.orderNumber)}</b>`,
    '',
    `<b>${escapeHtml(details.customerName)}</b>`,
    `📞 ${internationalPhone(details.phone)}`,
    `📍 ${escapeHtml(details.street)}, ${escapeHtml(details.city)}, ${escapeHtml(details.state)} ${escapeHtml(details.zip)}`,
  ];
  if (details.deliveryInstructions) {
    lines.push(`📝 <i>${escapeHtml(details.deliveryInstructions)}</i>`);
  }
  lines.push('');
  for (const item of order.items) {
    lines.push(`${item.quantity} × ${escapeHtml(item.productName)}`);
  }
  lines.push(
    '',
    `<b>Total: ${formatCents(order.totalCents)}</b> (${order.totalBars} bar${order.totalBars === 1 ? '' : 's'})`,
  );
  if (adminUrl) {
    lines.push(
      '',
      `<a href="${escapeHtml(adminOrderLink(adminUrl, order.orderNumber))}">Open in Admin</a>`,
    );
  }
  return lines.join('\n');
}

/**
 * Sends one message, retrying once on rate limits, server errors, and network failures.
 * Never throws. Never logs the bot token, the request URL, or the message text.
 */
export async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string,
  fetcher: typeof fetch = fetch,
): Promise<TelegramSendResult> {
  let status = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    try {
      const response = await fetcher(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      status = response.status;
      const body = (await response.json().catch(() => null)) as {
        ok?: boolean;
        result?: { entities?: Array<{ type: string }> };
      } | null;
      if (response.ok && body?.ok) {
        return { ok: true, status, entityTypes: (body.result?.entities ?? []).map((e) => e.type) };
      }
      // Bad token, unknown chat, malformed message: retrying will not help.
      if (status !== 429 && status < 500) break;
    } catch {
      // Network failure or timeout. The error message is not logged: it can include the URL.
      status = 0;
    }
  }
  return { ok: false, status, entityTypes: [] };
}

/** Sends the new-order notification. Never throws; logs only the order number and status. */
export async function notifyNewOrder(
  config: TelegramConfig,
  notice: OrderNotice,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const orderNumber = notice.confirmation.orderNumber;
  try {
    if (!config.botToken || !config.chatId) {
      logger.warn('telegram_not_configured', { orderNumber });
      return;
    }
    const text = formatOrderMessage(notice, config.adminUrl);
    const result = await sendTelegramMessage(config.botToken, config.chatId, text, fetcher);
    if (result.ok) logger.info('telegram_sent', { orderNumber });
    else logger.warn('telegram_failed', { orderNumber, status: result.status });
  } catch {
    logger.warn('telegram_failed', { orderNumber, status: -1 });
  }
}
