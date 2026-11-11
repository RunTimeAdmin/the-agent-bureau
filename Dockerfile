# Pinned by digest (the multi-platform index for node:22-bookworm-slim on 11 November 2026),
# so a rebuild gets the image that was reviewed. Move the tag and the digest together.
FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.34.9 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN CI=1 pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
# Drop from the image's default root to the unprivileged node user.
USER node
CMD ["node", "dist/index.js"]
