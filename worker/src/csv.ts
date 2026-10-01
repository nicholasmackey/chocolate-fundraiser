const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/**
 * Escapes one CSV cell. Text that a spreadsheet could interpret as a formula
 * is prefixed with an apostrophe so it is displayed as plain text.
 */
export function escapeCsvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  const safeText = FORMULA_PREFIX.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safeText) ? `"${safeText.replace(/"/g, '""')}"` : safeText;
}

export function toCsv(
  rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>,
): string {
  return rows.map((row) => row.map(escapeCsvCell).join(',')).join('\r\n') + '\r\n';
}
