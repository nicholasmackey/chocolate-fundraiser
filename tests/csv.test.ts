import { describe, expect, it } from 'vitest';
import { escapeCsvCell, toCsv } from '../worker/src/csv';

describe('CSV escaping', () => {
  it('quotes commas, quotes, and newlines', () => {
    expect(escapeCsvCell('Smith, Jo')).toBe('"Smith, Jo"');
    expect(escapeCsvCell('Say "hi"')).toBe('"Say ""hi"""');
    expect(escapeCsvCell('Line 1\nLine 2')).toBe('"Line 1\nLine 2"');
  });

  it('neutralizes spreadsheet formulas', () => {
    expect(escapeCsvCell('=HYPERLINK("http://evil")')).toBe(`"'=HYPERLINK(""http://evil"")"`);
    expect(escapeCsvCell('+1234')).toBe("'+1234");
    expect(escapeCsvCell('-2')).toBe("'-2");
    expect(escapeCsvCell('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  it('leaves numbers and plain text alone', () => {
    expect(escapeCsvCell(42)).toBe('42');
    expect(
      toCsv([
        ['a', 1],
        ['b', null],
      ]),
    ).toBe('a,1\r\nb,\r\n');
  });
});
