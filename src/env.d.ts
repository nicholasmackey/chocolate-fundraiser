interface ImportMetaEnv {
  /** Public URL of the API Worker, e.g. https://chocolate-fundraiser-api.example.workers.dev */
  readonly PUBLIC_API_URL?: string;
  /** Public Cloudflare Turnstile site key. */
  readonly PUBLIC_TURNSTILE_SITE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface TurnstileRenderOptions {
  sitekey: string;
  callback?: (token: string) => void;
  'expired-callback'?: () => void;
  'error-callback'?: () => void;
  theme?: 'light' | 'dark' | 'auto';
  size?: 'normal' | 'flexible' | 'compact';
}

interface Window {
  turnstile?: {
    render(container: HTMLElement, options: TurnstileRenderOptions): string;
    reset(widgetId?: string): void;
    remove(widgetId?: string): void;
  };
}
