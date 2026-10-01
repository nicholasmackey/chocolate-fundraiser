// @ts-check
import { defineConfig, fontProviders } from 'astro/config';
import { loadEnv } from 'vite';
import tailwindcss from '@tailwindcss/vite';

// SITE_URL and BASE_PATH are provided by the GitHub Pages workflow
// (actions/configure-pages). Locally the site is served from the root.
const { SITE_URL, BASE_PATH, PUBLIC_API_URL } = loadEnv(
  process.env.NODE_ENV ?? 'production',
  process.cwd(),
  '',
);
const apiUrl = PUBLIC_API_URL || 'http://localhost:8787';
const apiOrigin = new URL(apiUrl).origin;

// https://astro.build/config
export default defineConfig({
  output: 'static',
  site: SITE_URL || 'http://localhost:4321',
  base: BASE_PATH || '/',
  trailingSlash: 'ignore',
  // No Markdown code blocks are used; disabling Shiki keeps the strict CSP warning-free.
  markdown: { syntaxHighlight: false },
  security: {
    csp: {
      directives: [
        "default-src 'self'",
        `connect-src 'self' ${apiOrigin} https://challenges.cloudflare.com`,
        "img-src 'self' data:",
        "font-src 'self'",
        'frame-src https://challenges.cloudflare.com',
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ],
      scriptDirective: {
        resources: ["'self'", 'https://challenges.cloudflare.com'],
      },
    },
  },
  fonts: [
    {
      provider: fontProviders.google(),
      name: 'Fredoka',
      cssVariable: '--font-fredoka',
      weights: ['400 700'],
      fallbacks: ['ui-rounded', 'system-ui', 'sans-serif'],
    },
    {
      provider: fontProviders.google(),
      name: 'Nunito',
      cssVariable: '--font-nunito',
      weights: ['400 800'],
      fallbacks: ['system-ui', 'sans-serif'],
    },
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
