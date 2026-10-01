import type { OrderStatus } from './types';

/**
 * Delivery-status changes allowed through the one-tap actions. Cancellation
 * has its own path because it restores inventory. Cancelled is final, and
 * delivered orders cannot be cancelled (the bars have left the house).
 */
export const STATUS_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  new: ['packed', 'delivered'],
  packed: ['new', 'delivered'],
  delivered: ['packed'],
  cancelled: [],
};

export const CANCELLABLE_STATUSES: readonly OrderStatus[] = ['new', 'packed'];

export function transitionLabel(from: OrderStatus, to: OrderStatus): string {
  if (to === 'packed') return from === 'delivered' ? 'Undo delivered' : 'Mark packed';
  if (to === 'delivered') return 'Mark delivered';
  if (to === 'new') return 'Back to new';
  return to;
}
