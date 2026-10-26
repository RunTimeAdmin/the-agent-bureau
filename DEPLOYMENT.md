# Deploy The Agent Bureau

## What this ZIP is

This is the full React, Node.js, Express, tRPC, and MySQL application, plus a prebuilt `dist/` folder and local artwork. It is not a PHP website and cannot run completely by uploading it into a basic `public_html` directory. Use a hosting plan that can run a Node.js app or Docker and provide a MySQL-compatible database. If your hosting only serves static files, the visual frontend can be served, but the inquiry form and operator inbox will not work without the backend. Do not treat that as a working deployment.

No credentials, existing customer records, database backup, `node_modules`, or Git history are included.

## Requirements

Use Node.js 22, pnpm 10.18.0, an available MySQL-compatible database, HTTPS, and a process or container that can stay running. Set the required environment variables in your hosting control panel. The `.env.example` file contains placeholders only.

## Standard Node.js setup

Extract the archive and use the directory containing `package.json` as the application root. Run:

```sh
corepack enable
corepack prepare pnpm@10.18.0 --activate
pnpm install --frozen-lockfile
```

Set `DATABASE_URL` to your own database connection string. On a new, empty database, run:

```sh
pnpm db:migrate
```

This creates the users and inquiries tables. The database attached to the Manus preview is not exported or reused automatically. Do not run migrations against an unrelated database without reviewing them first.

The ZIP includes a production build. Rebuild after changing source files or the public origin:

```sh
PUBLIC_SITE_URL=https://theagentbureau.xyz pnpm build
```

Start the application:

```sh
NODE_ENV=production PORT=3000 pnpm start
```

Your host may supply a different `PORT`; the app honors that value. Route public HTTPS traffic to the Node process. Use `/api/health` as the health check. Configure a restart policy or the host's normal app process manager. The production server serves the frontend and API together.

For a Node.js hosting control panel, use `pnpm install --frozen-lockfile && pnpm build` as the build command, `pnpm start` as the start command, and the environment variables listed below. If the host only accepts npm, install the pinned pnpm toolchain or use the included Dockerfile rather than discarding the lockfile.

## Docker setup

The included Dockerfile installs dependencies, builds the app, and starts the server. Configure your own environment values outside the image, then run:

```sh
docker build -t the-agent-bureau .
docker run --env-file .env -p 3000:3000 --restart unless-stopped the-agent-bureau
```

Do not put real credentials into the Dockerfile, source files, ZIP, or frontend code. A local `.env` used for deployment should never be published as a static file.

## Environment values

| Variable | Use |
| --- | --- |
| `NODE_ENV` | `production` on the deployed app. |
| `PORT` | App listener, normally supplied by the host. Default: 3000. |
| `DATABASE_URL` | Your own MySQL database URL. Required for storing inquiries and user records. |
| `PUBLIC_SITE_URL` | Your intended public origin when building, for canonical and sitemap values. Defaults to `https://theagentbureau.xyz` in this export. |
| `MANUS_PROJECT_ID` | Existing application identifier for the current Manus OAuth integration. |
| `MANUS_OAUTH_PORTAL_URL` | Authorized Manus browser sign-in portal URL. |
| `MANUS_OAUTH_API_URL` | Authorized Manus server-side token exchange and identity URL. |
| `MANUS_JWT_SECRET` | Required by the existing application session validation/signing integration. Do not invent or expose a project-managed secret. |
| `OWNER_OPEN_ID` | The authorized operator's identity used by the existing owner-role flow, if supplied by the integration. |

The public inquiry form can store submissions with the Node backend and database configured. The private `/inbox` additionally requires the existing Manus OAuth integration to be available and correctly configured for the deployed origin. HTTPS callback URL: `https://theagentbureau.xyz/api/oauth/callback`. Acceptance of a new origin is governed by the authentication provider. This ZIP does not automatically register or authorize it.

If your hosting cannot use that integration, keep the inbox private and have the authentication implementation deliberately replaced and reviewed before enabling operator access. There is no default admin password and no development-login bypass. Do not publish credentials or loosen authorization to make the inbox accessible. An authorized, securely configured database administration tool can inspect inquiry records while the application login is being configured.

## Files and artwork

The original website images are bundled in `client/public/images/` and copied into `dist/public/images/`. The exported site uses `/images/...` paths instead of Manus-only storage paths. Google Fonts still load from Google's public font service. The favicon and social-preview image are local assets.

The build emits real HTML for `/`, `/privacy`, and `/terms`, with a public-only sitemap and robots policy. The private inbox is noindex. The default origin is the requested domain; change `PUBLIC_SITE_URL` and rebuild for a different domain. Connect DNS using your hosting provider's exact instructions, not a guessed Manus IP or CNAME.

## Operating boundaries

A successful contact submission means an inquiry was stored, not that an email was sent, an agent was booked, or payment was taken. The operator inbox can mark records new, reviewed, or closed. No email delivery provider is configured. Service examples are illustrative. No token, wallet checkout, or Solana escrow is live.

The included limiter is in-memory and keyed by the Express-resolved connection IP. Before a higher-volume launch, configure trusted proxy identity and distributed anti-spam controls through your hosting stack. Shared proxy or NAT addresses can share a limit. Sensitive files and credentials must not be submitted through the inquiry form.

## Final checks on your own host

Confirm `/api/health` returns success, local artwork loads, the inquiry table exists, a real authorized form submission is stored, and the private inbox rejects unauthorized users. Confirm your own login callback, cookie behavior, domain certificate, public sitemap, and 404 responses. The exported build has been checked here without your external database or hosting credentials; your host and auth configuration still need validation.
