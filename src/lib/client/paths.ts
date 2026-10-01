/** Joins a path onto the configured base path (e.g. /chocolate-fundraiser on GitHub Pages). */
export function withBase(path = ''): string {
  const base = import.meta.env.BASE_URL.replace(/\/+$/, '');
  return `${base}/${path.replace(/^\/+/, '')}`;
}
