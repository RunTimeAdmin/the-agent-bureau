# Deploy The Agent Bureau

## What this package is

This is the full React, Node.js, Express, tRPC, and MySQL application, plus a prebuilt `dist/` folder and local artwork. It is not a PHP website and cannot run completely from a basic `public_html` upload. Use a hosting plan that can run a Node.js app or Docker and provide a MySQL-compatible database. If your hosting only serves static files, the visual frontend can be served, but the inquiry form and operator inbox will not work without the backend. Do not treat that as a working deployment.

No credentials, customer records, database backup, or `node_modules` are included.

## Requirements

Node.js 22, pnpm 10.18.0, a MySQL-compatible database, HTTPS, and a process or container that stays running. Set environment variables in your hosting control panel. `.env.example` contains placeholders only.

## Standard Node.js setup

Use the directory containing `package.json` as the application root. Run:

```sh
corepack enable
corepack prepare pnpm@10.18.0 --activate
pnpm install --frozen-lockfile
```

Set `DATABASE_URL` to your own database connection string. On a new, empty database, run:

```sh
pnpm db:migrate
```

This creates the `inquiries` table. (Migration `0000` creates a legacy `users` table and `0002` drops it again, so a fresh database ends with `inquiries` only.) Do not run migrations against an unrelated database without reviewing them first.

Rebuild after changing source files or the public origin:

```sh
PUBLIC_SITE_URL=https://theagentbureau.xyz pnpm build
```

Start the application:

```sh
NODE_ENV=production PORT=3000 pnpm start
```

Your host may supply a different `PORT`; the app honors it. Route public HTTPS traffic to the Node process and use `/api/health` as the health check. The production server serves the frontend and API together.

For a Node.js hosting control panel, use `pnpm install --frozen-lockfile && pnpm build` as the build command, `pnpm start` as the start command, and the environment variables below. If the host only accepts npm, install the pinned pnpm toolchain or use the Dockerfile rather than discarding the lockfile.

## Docker setup

```sh
docker build -t the-agent-bureau .
docker run --env-file .env -p 3000:3000 --restart unless-stopped the-agent-bureau
```

Keep real credentials out of the Dockerfile, source files, archive, and frontend code. Never publish a deployment `.env` as a static file.

## Environment values

| Variable | Use |
| --- | --- |
| `NODE_ENV` | `production` on the deployed app. Session cookies are marked `Secure` only in production. |
| `PORT` | App listener, normally supplied by the host. Default: 3000. |
| `DATABASE_URL` | Your MySQL database URL. Required for storing and reading inquiries. On hosts where MySQL runs on the same server, connect to `127.0.0.1:3306`. |
| `PUBLIC_SITE_URL` | Public origin used at build time for canonical URLs and the sitemap. Defaults to `https://theagentbureau.xyz`. |
| `OPERATOR_PASSWORD` | Password for the private `/inbox`. Use a long, unique passphrase. |
| `SESSION_SECRET` | At least 32 random characters, used to sign operator sessions. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. |

## Operator inbox

`/inbox` is protected by a single operator password. Sign-in sets a signed, `HttpOnly`, `SameSite=Strict` session cookie that lasts seven days. If either `OPERATOR_PASSWORD` or `SESSION_SECRET` is missing (or the secret is shorter than 32 characters), the inbox stays locked and shows a "not set up" message. There is no default password.

- To sign everyone out, change `SESSION_SECRET` and restart.
- Changing `OPERATOR_PASSWORD` alone does not end existing sessions.
- Sign-in attempts are limited to 10 per 15 minutes per client address.

## Files and artwork

Website images are in `client/public/images/` and copied into `dist/public/images/`. Google Fonts load from Google's public font service. The favicon and social-preview image are local.

The build emits real HTML for `/`, `/privacy`, and `/terms`, with a public-only sitemap and robots policy. The private inbox is `noindex`. Connect DNS using your hosting provider's instructions.

## Operating boundaries

A successful contact submission means an inquiry was stored, not that an email was sent, an agent was booked, or payment was taken. No email delivery provider is configured. Service examples are illustrative. No token, wallet checkout, or Solana escrow is live.

The rate limiters are in-memory and keyed by the Express-resolved connection IP. Behind a reverse proxy, every visitor may appear to come from the proxy's address and share one limit. Configure Express `trust proxy` for your host's proxy before relying on per-visitor limits.

## Final checks on your own host

Confirm `/api/health` returns success, artwork loads, the `inquiries` table exists, a real form submission is stored, `/inbox` rejects a wrong password and accepts the right one, and unknown paths return 404. Confirm the domain certificate and sitemap.
