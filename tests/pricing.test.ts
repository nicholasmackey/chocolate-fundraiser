import { describe, expect, it } from 'vitest';
import {
  BAR_PRICE_CENTS,
  BOX_PRICE_CENTS,
  BOX_SIZE,
  formatCents,
  getAvailability,
  priceOrder,
} from '../shared/pricing';

const products = [
  { id: 1, name: 'Milk Chocolate', priceCents: 200 },
  { id: 2, name: 'Caramel', priceCents: 200 },
];

describe('pricing', () => {
  it('uses $2 bars and an informational $80 box of 40', () => {
    expect(BAR_PRICE_CENTS).toBe(200);
    expect(BOX_SIZE).toBe(40);
    expect(BOX_PRICE_CENTS).toBe(8000);
    expect(formatCents(BOX_PRICE_CENTS)).toBe('$80.00');
  });

  it('prices lines from trusted product prices in integer cents', () => {
    const priced = priceOrder(
      [
        { productId: 1, quantity: 3 },
        { productId: 2, quantity: 37 },
      ],
      products,
    );
    expect(priced.totalBars).toBe(40);
    expect(priced.totalCents).toBe(8000);
    expect(priced.lines.map((line) => line.lineTotalCents)).toEqual([600, 7400]);
  });

  it('applies no box discount above 40 bars', () => {
    expect(priceOrder([{ productId: 1, quantity: 41 }], products).totalCents).toBe(8200);
  });

  it('rejects unknown products', () => {
    expect(() => priceOrder([{ productId: 99, quantity: 1 }], products)).toThrow();
  });

  it('formats cents as dollars', () => {
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(1250)).toBe('$12.50');
  });
});

describe('availability', () => {
  it('is sold out at zero', () => expect(getAvailability(0, 10)).toBe('sold_out'));
  it('is going fast at or below the threshold', () => {
    expect(getAvailability(10, 10)).toBe('going_fast');
    expect(getAvailability(1, 10)).toBe('going_fast');
  });
  it('is available above the threshold', () => expect(getAvailability(11, 10)).toBe('available'));
});
