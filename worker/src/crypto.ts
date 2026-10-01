const encoder = new TextEncoder();

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function randomToken(byteLength = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Constant-time comparison of two byte arrays. */
export function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return bytesToHex(new Uint8Array(signature));
}

// Cloudflare Workers caps PBKDF2 at 100,000 iterations.
export const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_PREFIX = 'pbkdf2-sha256';

async function derivePbkdf2(password: string, salt: Uint8Array, iterations: number) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

/** Produces `pbkdf2-sha256:<iterations>:<salt b64>:<hash b64>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePbkdf2(password, salt, PBKDF2_ITERATIONS);
  return [PBKDF2_PREFIX, PBKDF2_ITERATIONS, bytesToBase64(salt), bytesToBase64(hash)].join(':');
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [prefix, iterationText, saltText, hashText] = storedHash.trim().split(':');
  const iterations = Number(iterationText);
  if (
    prefix !== PBKDF2_PREFIX ||
    !Number.isInteger(iterations) ||
    iterations < 10_000 ||
    iterations > PBKDF2_ITERATIONS ||
    !saltText ||
    !hashText
  ) {
    return false;
  }
  try {
    const expected = base64ToBytes(hashText);
    const actual = await derivePbkdf2(password, base64ToBytes(saltText), iterations);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
