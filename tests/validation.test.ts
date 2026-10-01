import { describe, expect, it } from 'vitest';
import { MAX_BARS_PER_ORDER } from '../shared/pricing';
import {
  normalizePhone,
  validateCheckoutDetails,
  validateRequestedItems,
} from '../shared/validation';
import { CUSTOMER } from './helpers';

describe('checkout details validation', () => {
  it('accepts and normalizes a valid address', () => {
    const result = validateCheckoutDetails({
      ...CUSTOMER,
      customerName: '  Maria   Gonzalez ',
      phone: '512.555.0142',
      state: 'tx',
    });
    expect(result).toEqual({
      ok: true,
      value: { ...CUSTOMER, customerName: 'Maria Gonzalez', phone: '(512) 555-0142', state: 'TX' },
    });
  });

  it('reports every invalid field', () => {
    const result = validateCheckoutDetails({
      customerName: 'M',
      phone: '123',
      state: 'ZZ',
      zip: '7870',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.keys(result.errors).sort()).toEqual([
        'city',
        'customerName',
        'phone',
        'state',
        'street',
        'zip',
      ]);
    }
  });

  it('strips control characters', () => {
    const result = validateCheckoutDetails({
      ...CUSTOMER,
      street: '418 Maple\u0000 Grove\u0007 Ln',
    });
    expect(result.ok && result.value.street).toBe('418 Maple Grove Ln');
  });

  it('normalizes US phone numbers', () => {
    expect(normalizePhone('+1 (512) 555-0142')).toBe('(512) 555-0142');
    expect(normalizePhone('012-555-0142')).toBeNull();
  });
});

describe('requested items validation', () => {
  it('drops zero lines and keeps positive integers', () => {
    expect(
      validateRequestedItems([
        { productId: 1, quantity: 2 },
        { productId: 2, quantity: 0 },
      ]),
    ).toEqual({ ok: true, value: [{ productId: 1, quantity: 2 }] });
  });

  it.each([
    [[]],
    [[{ productId: 1, quantity: 0 }]],
    [[{ productId: 1, quantity: -1 }]],
    [[{ productId: 1, quantity: 1.5 }]],
    [[{ productId: 1, quantity: '2' }]],
    [
      [
        { productId: 1, quantity: 1 },
        { productId: 1, quantity: 1 },
      ],
    ],
    [[{ productId: 1, quantity: MAX_BARS_PER_ORDER + 1 }]],
    ['not-an-array'],
  ])('rejects %j', (input) => {
    expect(validateRequestedItems(input).ok).toBe(false);
  });
});
