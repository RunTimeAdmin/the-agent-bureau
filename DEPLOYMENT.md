# Deploy The Agent Bureau

## What you are deploying

The Agent Bureau is a React, Node.js, Express, tRPC, and MySQL application with local artwork. It is not a PHP website and cannot run completely from a basic `public_html` upload. Use a hosting plan that can run a Node.js app or Docker and provide a MySQL-compatible database. If your hosting only serves static files, the visual frontend can be served, but the game, the inquiry form and the operator inbox will not work without the backend. Do not treat that as a working deployment.

The repository holds no credentials, customer records, or database backup.

## Requirements

Node.js 22, pnpm 10.34.9, a MySQL-compatible database, HTTPS, and a process or container that stays running. Set environment variables in your hosting control panel. `.env.example` contains placeholders only.

## Standard Node.js setup

Use the directory containing `package.json` as the application root. Run:

```sh
corepack enable
corepack prepare pnpm@10.34.9 --activate
pnpm install --frozen-lockfile
```

Set `DATABASE_URL` to your own database connection string. The server applies pending migrations from `drizzle/` each time it starts, so hosts without shell access get the schema automatically; applied migrations are skipped. If a migration fails, the server logs `[Database] Migration failed` and keeps serving the public pages. You can also apply them by hand with:

```sh
pnpm db:migrate
```

On a fresh database this creates the tables `/api/ready` checks for: `agents`, `daily_usage`, `inquiries`, `outcome_events`, `outcome_reviews`, `play_questions`, `plays`, and `review_log_records`. (Migration `0000` creates a legacy `users` table and `0002` drops it again.) Do not point `DATABASE_URL` at an unrelated database without reviewing the migrations first.

Rebuild after changing source files or the public origin:

```sh
PUBLIC_SITE_URL=https://theagentbureau.xyz pnpm build
```

Start the application:

```sh
NODE_ENV=production PORT=3000 pnpm start
```

Your host may supply a different `PORT`; the app honors it. Route public HTTPS traffic to the Node process. Use `/api/health` as a liveness check and `/api/ready` (which checks the database answers and the Bureau tables are present, so a failed boot migration shows as not-ready) as the readiness check; it returns `{ status, checks: { db, schema } }`. The production server serves the frontend and API together.

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
| `DATABASE_URL` | Your MySQL database URL. Required for the game, inquiries, and outcome lines. On hosts where MySQL runs on the same server, connect to `127.0.0.1:3306`. |
| `ANTHROPIC_API_KEY` | Anthropic API key for the game, where Claude plays the suspects. Without it every question fails with a server error and is not counted. |
| `PUBLIC_SITE_URL` | Public origin used at build time for canonical URLs and the sitemap. Defaults to `https://theagentbureau.xyz`. |
| `OPERATOR_PASSWORD` | Password for the private `/inbox`. Use a long, unique passphrase. |
| `SESSION_SECRET` | At least 32 random characters, used to sign operator sessions. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. |

The operator intake script also reads `COUNTERAUDIT_API_URL`, `COUNTERAUDIT_ORG_ID`, `COUNTERAUDIT_INGEST_KEY`, `ARC_TESTNET_RPC_URL` and `ARC_TESTNET_EXPLORER_URL`, described in `docs/counteraudit-intake.md`, and `pnpm review sync` reads `COUNTERAUDIT_REVIEW_ORG_ID` and `COUNTERAUDIT_REVIEW_READ_KEY` (`docs/two-person-review.md`). The website itself does not need them.

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

The rate limiters are in-memory and keyed by the visitor's IP. Express trusts `X-Forwarded-For` only when the request arrives from a loopback or private-network address, which covers a reverse proxy on the same server or internal network (as on Hostinger). If your proxy connects from a public address, every visitor will share one limit; adjust `trust proxy` in `server/_core/index.ts` for that host.

## Final checks on your own host

Confirm `/api/health` returns success and `/api/ready` returns ready, artwork loads, the `inquiries` table exists, a real form submission is stored, `/inbox` rejects a wrong password and accepts the right one, and unknown paths return 404. Confirm the domain certificate and sitemap.
