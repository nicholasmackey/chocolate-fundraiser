const ORDERING_ENABLED_KEY = 'ordering_enabled';

export async function isOrderingEnabled(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .bind(ORDERING_ENABLED_KEY)
    .first<{ value: string }>();
  return row?.value === '1';
}

export async function setOrderingEnabled(db: D1Database, enabled: boolean): Promise<void> {
  await db
    .prepare(
      `INSERT INTO app_settings (key, value) VALUES (?1, ?2)
       ON CONFLICT (key) DO UPDATE SET value = ?2,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
    .bind(ORDERING_ENABLED_KEY, enabled ? '1' : '0')
    .run();
}

/** SQL fragment that is true only while public ordering is enabled. */
export const ORDERING_ENABLED_SQL = `EXISTS (SELECT 1 FROM app_settings WHERE key = '${ORDERING_ENABLED_KEY}' AND value = '1')`;
