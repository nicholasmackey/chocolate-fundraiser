import { ApiRequestError, apiDownload, apiJson } from '../../lib/client/api';
import { withBase } from '../../lib/client/paths';

/**
 * The admin bearer token lives in sessionStorage: it is scoped to this tab,
 * cleared when the tab closes, and never sent automatically by the browser
 * (so there is no CSRF exposure). Sessions are also revoked server-side on
 * sign-out and expire after 8 hours.
 */
const STORAGE_KEY = 'wfc-admin-session';

interface StoredSession {
  token: string;
  expiresAt: string;
}

export function readSession(): StoredSession | null {
  try {
    const session = JSON.parse(
      sessionStorage.getItem(STORAGE_KEY) ?? 'null',
    ) as StoredSession | null;
    if (!session || new Date(session.expiresAt).getTime() <= Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

export function saveSession(session: StoredSession): void {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
}

export function redirectToLogin(): never {
  clearSession();
  const next = encodeURIComponent(location.pathname + location.search);
  location.replace(`${withBase('admin/login/')}?next=${next}`);
  throw new Error('Redirecting to sign in');
}

function requireToken(): string {
  return readSession()?.token ?? redirectToLogin();
}

async function withAuthHandling<T>(request: (token: string) => Promise<T>): Promise<T> {
  try {
    return await request(requireToken());
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 401) redirectToLogin();
    throw error;
  }
}

export function adminGet<T>(path: string): Promise<T> {
  return withAuthHandling((token) => apiJson<T>(path, { token }));
}

export function adminPost<T>(path: string, body: unknown = {}): Promise<T> {
  return withAuthHandling((token) => apiJson<T>(path, { token, body }));
}

export function adminDownload(path: string): Promise<void> {
  return withAuthHandling((token) => apiDownload(path, token));
}

export async function signOut(): Promise<void> {
  const session = readSession();
  if (session) {
    try {
      await apiJson('/api/admin/logout', { token: session.token, body: {} });
    } catch {
      // The local token is cleared regardless.
    }
  }
  clearSession();
  location.replace(withBase('admin/login/'));
}
