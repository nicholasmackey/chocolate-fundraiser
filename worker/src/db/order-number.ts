// No 0/O, 1/I/L, so numbers are easy to read aloud over the phone.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateOrderNumber(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  // 256 % 31 introduces a negligible bias, acceptable for a non-secret identifier.
  const suffix = [...bytes].map((byte) => ALPHABET[byte % ALPHABET.length]).join('');
  return `WFC-${suffix}`;
}
