export const ORDER_STATUSES = ['new', 'packed', 'delivered', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const PAYMENT_STATUSES = ['unpaid', 'paid'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  new: 'New',
  packed: 'Packed',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  unpaid: 'Unpaid',
  paid: 'Paid',
};

export interface Product {
  id: number;
  slug: string;
  name: string;
  description: string;
  priceCents: number;
  stockQuantity: number;
  lowStockThreshold: number;
  sortOrder: number;
}

export type Availability = 'available' | 'going_fast' | 'sold_out';

/** Product fields that are safe to send to the public storefront. */
export interface PublicProduct {
  id: number;
  slug: string;
  name: string;
  description: string;
  priceCents: number;
  available: number;
  availability: Availability;
}

export interface OrderItem {
  productId: number;
  productName: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

export interface Order {
  id: string;
  orderNumber: string;
  customerName: string;
  phone: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  deliveryInstructions: string;
  totalBars: number;
  totalCents: number;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  createdAt: string;
  updatedAt: string;
  cancelledAt: string | null;
  items: OrderItem[];
}

/** What the customer sees after submitting. Contains no personal details. */
export interface OrderConfirmation {
  orderNumber: string;
  items: Array<{ productName: string; quantity: number; lineTotalCents: number }>;
  totalBars: number;
  totalCents: number;
}
