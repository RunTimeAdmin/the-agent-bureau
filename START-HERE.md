# The Agent Bureau upload package

The archive root contains `package.json`, full application source, local artwork, database migrations, the production `dist/` build, and `DEPLOYMENT.md`. Use the extracted application root on Node.js and MySQL-capable hosting. This is not a complete PHP or static-only `public_html` upload. Read the deployment instructions before uploading or enabling the inquiry flow.

The `x-branding/` folder contains the 512 by 512 PNG profile image and the 1500 by 500 PNG banner. The header preserves all of the generated artwork with subtle dark side framing. A 2688 by 1152 master is included for future crop adjustments.

No live account secrets, database contents, dependency folder, logs, or Git history are included. The private inbox uses the current Manus OAuth implementation, which must be configured and authorized for the external hosting origin. There is no default admin password or login bypass.

A successful website contact submission means an inquiry was stored, not that an email was sent, an agent was booked, or payment was taken. Solana payments, escrow, and token features are not live.
