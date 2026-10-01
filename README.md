# Chocolate Fundraiser

A small storefront for a family-run school fundraiser selling World’s Finest® Chocolate bars, plus a
private admin area for orders and inventory.

## How it fits together

| Part                                      | Where it runs      | What it is                                    |
| ----------------------------------------- | ------------------ | --------------------------------------------- |
| Storefront (`/`) and admin UI (`/admin/`) | GitHub Pages       | Static Astro + Tailwind site (`src/`)         |
| API                                       | Cloudflare Workers | Plain TypeScript Worker (`worker/`)           |
| Database                                  | Cloudflare D1      | SQLite, binding `DB` (`migrations/`, `seed/`) |

Code shared by both sides (pricing, validation, types) is in `shared/`. The static pages call the API
with `fetch`. All prices, stock checks, and order totals are calculated on the server.

### Admin sign-in across two domains

GitHub Pages (`*.github.io`) and Workers (`*.workers.dev`) are different sites. Safari and other
privacy-focused browsers block third-party cookies, so a cookie set by the API would not reliably reach
the admin pages. The admin area uses a **bearer token** instead:

- Signing in checks the shared password against a PBKDF2 hash and creates a server-side session in D1.
  Only an HMAC of the token (keyed with `SESSION_SECRET`) is stored.
- The browser keeps the token in `sessionStorage`. It belongs to that tab only and is cleared when the
  tab closes. It is sent explicitly in an `Authorization` header and never automatically, which rules
  out CSRF.
- Sessions expire after 8 hours. Signing out deletes the session on the server.
- CORS allows only the origins listed in `ALLOWED_ORIGINS`, never with credentials. Every state-changing
  request must come from one of those origins. Sign-in attempts are rate-limited.
- A strict Content-Security-Policy is built into every page to reduce XSS risk. Customer data is always
  rendered as text, never as HTML.

The admin HTML pages are public static files, but they contain no data. Everything they show comes from
the authenticated API. Admin pages are marked `noindex`.

## Local development

You need Node 22+ and pnpm 10.

```sh
pnpm install
cp .dev.vars.example .dev.vars   # API secrets for local development
cp .env.example .env             # site settings (API URL, Turnstile site key)
pnpm hash-password               # paste the output into ADMIN_PASSWORD_HASH in .dev.vars
openssl rand -base64 48          # paste into SESSION_SECRET in .dev.vars
pnpm db:setup:local              # create local D1 tables and seed the six flavors
```

Run the API and the site in two terminals:

```sh
pnpm api:dev    # API at http://localhost:8787, using a local D1 database in .wrangler/
pnpm dev        # site at http://localhost:4321
```

The examples use Cloudflare’s documented Turnstile **test keys**, which always pass. If Astro starts
on a port other than 4321, add that origin to `ALLOWED_ORIGINS` in `.dev.vars`.

Every flavor starts with 0 stock and ordering starts **closed**. Sign in at `/admin/`, enter stock
counts on the Inventory page, then open ordering from the Dashboard.

## Scripts

| Command                                          | Purpose                                      |
| ------------------------------------------------ | -------------------------------------------- |
| `pnpm dev` / `pnpm build` / `pnpm preview`       | Astro site                                   |
| `pnpm api:dev` / `pnpm api:deploy`               | API Worker                                   |
| `pnpm test`                                      | Vitest suite (uses a throwaway in-memory D1) |
| `pnpm typecheck`                                 | `astro check` plus a Worker type check       |
| `pnpm format` / `pnpm format:check`              | Prettier                                     |
| `pnpm db:setup:local`                            | Local migrations and seed                    |
| `pnpm db:migrate:remote` / `pnpm db:seed:remote` | Production migrations and seed               |
| `pnpm hash-password`                             | Generate `ADMIN_PASSWORD_HASH`               |

The seed never overwrites existing data. It inserts missing flavors and default settings only, so it
is safe to run again.

## Deploying

### 1. Cloudflare: database and API

```sh
pnpm exec wrangler login
pnpm exec wrangler d1 create chocolate-fundraiser
```

Copy the printed `database_id` into `wrangler.jsonc`. It is not a secret, so commit it. In the same
file, set `ALLOWED_ORIGINS` to your Pages origin, for example `https://your-username.github.io` (scheme
and host only, no path). Optionally set `TURNSTILE_EXPECTED_HOSTNAME` to `your-username.github.io`.

```sh
pnpm db:migrate:remote
pnpm db:seed:remote
pnpm hash-password | pnpm exec wrangler secret put ADMIN_PASSWORD_HASH
openssl rand -base64 48 | pnpm exec wrangler secret put SESSION_SECRET
pnpm exec wrangler secret put TURNSTILE_SECRET_KEY
pnpm api:deploy
```

Note the Worker URL it prints (e.g. `https://chocolate-fundraiser-api.<subdomain>.workers.dev`).

**Turnstile:** in the Cloudflare dashboard, go to Turnstile and add a widget. Add your Pages hostname
(e.g. `your-username.github.io`) and `localhost`. It gives you a site key (public) and a secret key
(stored with `wrangler secret put` above).

Later API deploys can run from GitHub instead: add the `CLOUDFLARE_API_TOKEN` (with the “Edit Cloudflare
Workers” template plus D1 edit) and `CLOUDFLARE_ACCOUNT_ID` repository secrets, then run the
**Deploy API Worker** workflow manually.

### 2. GitHub Pages: site

1. Under **Settings → Pages**, set **Source** to **GitHub Actions**.
2. Under **Settings → Secrets and variables → Actions → Variables**, add:
   - `PUBLIC_API_URL`: the Worker URL from step 1
   - `PUBLIC_TURNSTILE_SITE_KEY`: the Turnstile site key
3. Push to `main`. The **Deploy site to GitHub Pages** workflow runs the tests, builds the site with the
   correct base path (e.g. `/chocolate-fundraiser`), and publishes it.

## Running the fundraiser

- **Inventory:** set counts as boxes arrive, add or remove bars, and adjust each flavor’s “Going Fast”
  threshold (default 10). Every change is logged in Stock history.
- **Orders:** an order reserves its bars the moment it is placed. Mark orders Packed and then Delivered,
  and Paid separately. Cancelling a New or Packed order returns its bars to stock exactly once.
  Delivered orders cannot be cancelled.
- **Ordering open/closed:** use the Dashboard toggle. If every flavor is at zero, the storefront shows
  “Ordering opens soon”.

## After the fundraiser: export and delete customer data

1. Admin → **Data** → **Download CSV**. Keep the file private. CSV cells are escaped to block
   spreadsheet formula injection.
2. On the same page, type `DELETE ALL ORDERS` to permanently remove every order, name, phone number, and
   address. Inventory counts and an anonymous stock history are kept.
3. Optionally delete everything: `pnpm exec wrangler delete` (API) and
   `pnpm exec wrangler d1 delete chocolate-fundraiser` (database).

## Tests

`pnpm test` covers pricing, validation, atomic order creation, insufficient-stock rollback, concurrent
oversell protection, exactly-once cancellation, delivery and payment transitions, admin authorization,
CORS and origin checks, Turnstile rejection, rate limits, and CSV escaping. Tests run against an
in-memory D1 (`persist: false`), so they never touch local or production data.
