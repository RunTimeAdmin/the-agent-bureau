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

On a fresh database this creates the tables `/api/ready` checks for: `agents`, `daily_usage`, `dispute_records`, `inquiries`, `outcome_events`, `outcome_reviews`, `play_questions`, `plays`, `review_log_records`, and `review_log_sync`. (Migration `0000` creates a legacy `users` table and `0002` drops it again.) Do not point `DATABASE_URL` at an unrelated database without reviewing the migrations first.

Rebuild after changing source files or the public origin:

```sh
PUBLIC_SITE_URL=https://theagentbureau.xyz pnpm build
```

Start the application:

```sh
NODE_ENV=production PORT=3000 pnpm start
```

Your host may supply a different `PORT`; the app honors it. Route public HTTPS traffic to the Node process. Use `/api/health` as a liveness check and `/api/ready` (which checks the database answers and the Bureau tables are present, so a failed boot migration shows as not-ready) as the readiness check; it returns `{ status, checks: { db, schema } }`. `/api/jobs` says how the commands the server runs on a timer last ended (`pnpm dispute settle` hourly, `pnpm lines expire` daily; `server/schedules.ts`): `{ status: "ok", jobs }`, or `status: "attention"` with a `problem` when a run failed or one is overdue. Watch it with the same monitor as `/api/ready`; a failed daily run is tried again after an hour. The production server serves the frontend and API together.

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
| `OPERATOR_PASSWORD` | Password for the private `/inbox`: 16 to 256 characters that zxcvbn estimates at 10^14 guesses or more, both as typed and with case, spaces, hyphens, underscores and dots taken out. Five or more random words, or 20 or more random characters from a password manager, pass; a name, a season, a year or the site's own name with symbols or spaces between does not. A weaker one keeps the inbox locked. |
| `SESSION_SECRET` | The hex of at least 32 random bytes, used to sign operator sessions. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Spaces or a newline around it are ignored; anything else keeps the inbox locked. |
| `OPERATOR_LOGIN_ADDRESSES` | Optional. The operator's own addresses or networks, comma-separated (`203.0.113.7, 2001:db8:5::/48`). Sign-in from them keeps its per-address limit but is left out of the limit for all addresses, so a flood of guesses from elsewhere cannot lock the operator out. |
| `COUNTERAUDIT_ORG_ID` | The Bureau's CounterAudit organization. The production server needs it for the daily `pnpm lines expire`; without it `/api/jobs` reports `attention`. |
| `COUNTERAUDIT_READ_KEY` | A read-role key of that organization. The production server needs it for the hourly `pnpm dispute sync`, which brings disputes sent to CounterAudit directly into the queue; without it `/api/jobs` reports `attention`. |

`pnpm file assemble` and `pnpm file verify --current`, run by the operator, also read `COUNTERAUDIT_READ_KEY`, a read-role key of the Bureau's organization, for the evidence seals (`docs/agent-file.md`). The production server does not need it.

The operator intake script also reads `COUNTERAUDIT_API_URL`, `COUNTERAUDIT_ORG_ID`, `COUNTERAUDIT_INGEST_KEY`, `ARC_TESTNET_RPC_URL` and `ARC_TESTNET_EXPLORER_URL`, described in `docs/counteraudit-intake.md`, and `pnpm review sync` reads `COUNTERAUDIT_REVIEW_ORG_ID` and `COUNTERAUDIT_REVIEW_READ_KEY` (`docs/two-person-review.md`), with `COUNTERAUDIT_REVIEW_MIN_HEAD` also read by `pnpm file verify --current` and `pnpm review head` when set. The production server needs `COUNTERAUDIT_ORG_ID` (and `COUNTERAUDIT_API_URL` if not the default) for the daily `pnpm lines expire`; without it `/api/jobs` reports `attention`. The rest are for the operator scripts.

## Operator inbox

`/inbox` is protected by a single operator password. Sign-in sets a signed, `HttpOnly`, `SameSite=Strict` session cookie that lasts seven days. If `OPERATOR_PASSWORD` or `SESSION_SECRET` is missing or too weak (see the table above), the inbox stays locked and shows a "not set up" message, and the server logs why at start. There is no default password.

- Sessions are signed with a key derived from both values, so changing either one and restarting signs everyone out.
- Sign-in attempts are limited to 10 per 15 minutes per client address (an IPv6 client by its /64 network) and 50 per 15 minutes from all addresses together. They are counted in the database (`login_attempts`), so the limits hold across restarts and across instances. With no `DATABASE_URL` the server counts in memory only; if the database is configured but cannot be reached, sign-in fails rather than going uncounted.
- Anyone can use up the 50 for all addresses, and while they do the operator is refused too. Set `OPERATOR_LOGIN_ADDRESSES` to the operator's own addresses to keep them out of that limit.
- There is no second factor yet. Before live operations, put the inbox behind a stronger identity provider or add one.

## Files and artwork

Website images are in `client/public/images/` and copied into `dist/public/images/`. Google Fonts load from Google's public font service. The favicon and social-preview image are local.

The build emits real HTML for `/`, `/bureau`, `/review-log`, `/agents`, each case (`/play` and `/play/002`), `/privacy`, `/terms`, `/inbox` and `/404`, with a public-only sitemap and robots policy. The private inbox is `noindex`. Connect DNS using your hosting provider's instructions.

## Operating boundaries

A successful contact submission means an inquiry was stored, not that an email was sent, an agent was booked, or payment was taken. No email delivery provider is configured. The example file and network graphic on `/bureau` are illustrative. No token, wallet checkout, or Solana escrow is live.

The inquiry and game rate limiters are in-memory and keyed by the visitor's address (an IPv6 visitor by its /64 network); operator sign-in is counted in the database as well (see Operator inbox). Express trusts `X-Forwarded-For` only when the request arrives from a loopback or private-network address, which covers a reverse proxy on the same server or internal network (as on Hostinger). If your proxy connects from a public address, every visitor will share one limit; adjust `trust proxy` in `server/_core/index.ts` for that host.

## Final checks on your own host

Confirm `/api/health` returns success and `/api/ready` returns ready, artwork loads, the `inquiries` table exists, a real form submission is stored, `/api/trpc/auth.me` reports `loginConfigured: true`, `/inbox` rejects a wrong password and accepts the right one, unknown paths return 404, and `/api/jobs` returns `ok`. Confirm the domain certificate and sitemap.
