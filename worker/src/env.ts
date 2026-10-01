export interface AppEnv {
  DB: D1Database;
  /** Comma-separated list of browser origins allowed to call the API. */
  ALLOWED_ORIGINS: string;
  /** Optional hostname that Turnstile tokens must have been issued for. */
  TURNSTILE_EXPECTED_HOSTNAME?: string;
  /** Secret: PBKDF2 hash produced by `pnpm hash-password`. */
  ADMIN_PASSWORD_HASH: string;
  /** Secret: key used to hash session tokens and rate-limit buckets. */
  SESSION_SECRET: string;
  /** Secret: Turnstile server-side secret key. */
  TURNSTILE_SECRET_KEY: string;
}
