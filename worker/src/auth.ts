import { hmacSha256Hex, randomToken, verifyPassword } from './crypto';
import { ApiError } from './http';

export const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;
const MIN_SESSION_SECRET_LENGTH = 32;

export interface AdminSession {
  tokenHash: string;
  expiresAt: string;
}

function assertSessionSecret(sessionSecret: string): void {
  if (!sessionSecret || sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new ApiError(500, 'server_misconfigured', 'Admin sign-in is not configured.');
  }
}

async function hashToken(sessionSecret: string, token: string): Promise<string> {
  return hmacSha256Hex(sessionSecret, `admin-session:${token}`);
}

/**
 * Verifies the shared admin password and creates a server-side session.
 * Returns the raw bearer token; only its keyed hash is stored.
 */
export async function signIn(
  db: D1Database,
  options: { password: string; passwordHash: string; sessionSecret: string; now?: Date },
): Promise<{ token: string; expiresAt: string } | null> {
  assertSessionSecret(options.sessionSecret);
  if (!options.passwordHash) {
    throw new ApiError(500, 'server_misconfigured', 'Admin sign-in is not configured.');
  }
  const passwordMatches = await verifyPassword(options.password, options.passwordHash);
  if (!passwordMatches) return null;

  const now = options.now ?? new Date();
  const token = randomToken();
  const expiresAt = new Date(now.getTime() + SESSION_DURATION_MS).toISOString();
  await db.batch([
    db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').bind(now.toISOString()),
    db
      .prepare('INSERT INTO admin_sessions (token_hash, expires_at) VALUES (?, ?)')
      .bind(await hashToken(options.sessionSecret, token), expiresAt),
  ]);
  return { token, expiresAt };
}

export function readBearerToken(request: Request): string | null {
  const header = request.headers.get('Authorization') ?? '';
  const match = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(header);
  return match ? match[1]! : null;
}

export async function getSession(
  db: D1Database,
  token: string | null,
  sessionSecret: string,
  now = new Date(),
): Promise<AdminSession | null> {
  if (!token) return null;
  assertSessionSecret(sessionSecret);
  const row = await db
    .prepare(
      'SELECT token_hash, expires_at FROM admin_sessions WHERE token_hash = ? AND expires_at > ?',
    )
    .bind(await hashToken(sessionSecret, token), now.toISOString())
    .first<{ token_hash: string; expires_at: string }>();
  return row ? { tokenHash: row.token_hash, expiresAt: row.expires_at } : null;
}

export async function requireAdmin(
  db: D1Database,
  request: Request,
  sessionSecret: string,
): Promise<AdminSession> {
  const session = await getSession(db, readBearerToken(request), sessionSecret);
  if (!session) {
    throw new ApiError(401, 'unauthorized', 'Please sign in again.');
  }
  return session;
}

export async function signOut(db: D1Database, session: AdminSession): Promise<void> {
  await db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').bind(session.tokenHash).run();
}
