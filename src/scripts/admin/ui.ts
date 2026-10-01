import type { OrderStatus, PaymentStatus } from '../../../shared/types';
import { ORDER_STATUS_LABELS, PAYMENT_STATUS_LABELS } from '../../../shared/types';
import { ApiRequestError } from '../../lib/client/api';
import { h } from '../../lib/client/dom';

const STATUS_STYLES: Record<OrderStatus, string> = {
  new: 'bg-berry/10 text-berry-dark',
  packed: 'bg-honey-soft text-cocoa',
  delivered: 'bg-emerald-100 text-emerald-800',
  cancelled: 'bg-cocoa/10 text-cocoa-soft line-through',
};

export function statusBadge(status: OrderStatus): HTMLElement {
  return h('span', {
    className: `badge ${STATUS_STYLES[status]}`,
    text: ORDER_STATUS_LABELS[status],
  });
}

export function paymentBadge(status: PaymentStatus): HTMLElement {
  return h('span', {
    className: `badge ${status === 'paid' ? 'bg-emerald-100 text-emerald-800' : 'bg-cocoa/10 text-cocoa'}`,
    text: PAYMENT_STATUS_LABELS[status],
  });
}

export function errorMessage(error: unknown): string {
  return error instanceof ApiRequestError
    ? error.message
    : 'Something went wrong. Please try again.';
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

/** Brief status message in the shared live region. */
export function toast(message: string, tone: 'success' | 'error' = 'success'): void {
  const region = document.getElementById('admin-toast');
  if (!region) return;
  region.textContent = message;
  region.className = `fixed inset-x-4 bottom-4 z-20 mx-auto max-w-md rounded-2xl px-4 py-3 text-center font-bold shadow-lg ${
    tone === 'success' ? 'bg-cocoa text-white' : 'bg-berry text-white'
  }`;
  region.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    region.hidden = true;
  }, 3500);
}

/** Runs an action with the button disabled, reporting errors as a toast. */
export async function withButton(
  button: HTMLButtonElement,
  action: () => Promise<void>,
): Promise<void> {
  if (button.disabled) return;
  button.disabled = true;
  try {
    await action();
  } catch (error) {
    toast(errorMessage(error), 'error');
  } finally {
    button.disabled = false;
  }
}
