# The Agent Bureau upload package

The archive root contains `package.json`, the full application source, local artwork, database migrations, the production `dist/` build, and `DEPLOYMENT.md`. Use the extracted application root on Node.js and MySQL hosting. This is not a PHP or static-only `public_html` upload. Read the deployment instructions before uploading.

The `x-branding/` folder contains the 512 by 512 profile image, the 1500 by 500 banner, and a 2688 by 1152 master for future crops.

No secrets, database contents, or dependency folder are included. The private inbox signs in with `OPERATOR_PASSWORD` and `SESSION_SECRET`, which you set on the server. There is no default password.

A successful contact submission means an inquiry was stored, not that an email was sent, an agent was booked, or payment was taken. Solana payments, escrow, and token features are not live.
