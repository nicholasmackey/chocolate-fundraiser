import { MAX_BARS_PER_ORDER } from './pricing';

export const US_STATES = [
  'AL',
  'AK',
  'AZ',
  'AR',
  'CA',
  'CO',
  'CT',
  'DE',
  'DC',
  'FL',
  'GA',
  'HI',
  'ID',
  'IL',
  'IN',
  'IA',
  'KS',
  'KY',
  'LA',
  'ME',
  'MD',
  'MA',
  'MI',
  'MN',
  'MS',
  'MO',
  'MT',
  'NE',
  'NV',
  'NH',
  'NJ',
  'NM',
  'NY',
  'NC',
  'ND',
  'OH',
  'OK',
  'OR',
  'PA',
  'RI',
  'SC',
  'SD',
  'TN',
  'TX',
  'UT',
  'VT',
  'VA',
  'WA',
  'WV',
  'WI',
  'WY',
] as const;

export const FIELD_LIMITS = {
  customerName: 100,
  phone: 30,
  street: 200,
  city: 100,
  zip: 10,
  deliveryInstructions: 500,
} as const;

export interface CheckoutDetails {
  customerName: string;
  phone: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  deliveryInstructions: string;
}

export interface RequestedLine {
  productId: number;
  quantity: number;
}

export type FieldErrors = Partial<Record<keyof CheckoutDetails | 'items', string>>;

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: FieldErrors };

/** Trims, collapses whitespace, and removes control characters. */
export function cleanText(value: unknown, { multiline = false } = {}): string {
  if (typeof value !== 'string') return '';
  const withoutControls = value.replace(
    multiline ? /[\u0000-\u0009\u000B-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g,
    multiline ? '' : ' ',
  );
  if (multiline) {
    return withoutControls
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  return withoutControls.replace(/\s+/g, ' ').trim();
}

/** Returns a normalized (XXX) XXX-XXXX phone number, or null if invalid. */
export function normalizePhone(value: string): string | null {
  let digits = value.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (digits.length !== 10 || /^[01]/.test(digits)) return null;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

export function validateCheckoutDetails(
  input: Record<string, unknown>,
): ValidationResult<CheckoutDetails> {
  const errors: FieldErrors = {};

  const customerName = cleanText(input.customerName);
  if (customerName.length < 2) errors.customerName = 'Please enter your full name.';
  else if (customerName.length > FIELD_LIMITS.customerName)
    errors.customerName = 'Name is too long.';

  const rawPhone = cleanText(input.phone);
  const phone = rawPhone.length <= FIELD_LIMITS.phone ? normalizePhone(rawPhone) : null;
  if (!phone) errors.phone = 'Please enter a valid 10-digit phone number.';

  const street = cleanText(input.street);
  if (street.length < 3) errors.street = 'Please enter a street address.';
  else if (street.length > FIELD_LIMITS.street) errors.street = 'Street address is too long.';

  const city = cleanText(input.city);
  if (city.length < 2) errors.city = 'Please enter a city.';
  else if (city.length > FIELD_LIMITS.city) errors.city = 'City is too long.';

  const state = cleanText(input.state).toUpperCase();
  if (!(US_STATES as readonly string[]).includes(state)) errors.state = 'Please choose a state.';

  const zip = cleanText(input.zip);
  if (!/^\d{5}(-\d{4})?$/.test(zip)) errors.zip = 'Please enter a 5-digit ZIP code.';

  const deliveryInstructions = cleanText(input.deliveryInstructions, { multiline: true });
  if (deliveryInstructions.length > FIELD_LIMITS.deliveryInstructions) {
    errors.deliveryInstructions = `Please keep instructions under ${FIELD_LIMITS.deliveryInstructions} characters.`;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { customerName, phone: phone!, street, city, state, zip, deliveryInstructions },
  };
}

/**
 * Validates the shape of requested quantities. Unknown keys, non-integers,
 * negatives, and duplicates are rejected. Zero-quantity lines are dropped.
 */
export function validateRequestedItems(input: unknown): ValidationResult<RequestedLine[]> {
  if (!Array.isArray(input) || input.length === 0 || input.length > 50) {
    return { ok: false, errors: { items: 'Please choose at least one bar.' } };
  }
  const quantitiesByProduct = new Map<number, number>();
  for (const entry of input) {
    if (typeof entry !== 'object' || entry === null) {
      return { ok: false, errors: { items: 'Your order could not be read.' } };
    }
    const { productId, quantity } = entry as Record<string, unknown>;
    if (
      !Number.isSafeInteger(productId) ||
      (productId as number) <= 0 ||
      !Number.isSafeInteger(quantity) ||
      (quantity as number) < 0 ||
      quantitiesByProduct.has(productId as number)
    ) {
      return { ok: false, errors: { items: 'Your order could not be read.' } };
    }
    quantitiesByProduct.set(productId as number, quantity as number);
  }
  const lines = [...quantitiesByProduct]
    .filter(([, quantity]) => quantity > 0)
    .map(([productId, quantity]) => ({ productId, quantity }));
  const totalBars = lines.reduce((sum, line) => sum + line.quantity, 0);
  if (lines.length === 0) {
    return { ok: false, errors: { items: 'Please choose at least one bar.' } };
  }
  if (totalBars > MAX_BARS_PER_ORDER) {
    return {
      ok: false,
      errors: {
        items: `Orders are limited to ${MAX_BARS_PER_ORDER} bars. Please contact us for larger orders.`,
      },
    };
  }
  return { ok: true, value: lines };
}
