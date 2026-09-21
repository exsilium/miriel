# syntax=docker/dockerfile:1
#
# Targets:
#   runtime  node:22-alpine with shared + indexer + api (used by the migrate, indexer and api services)
#   web      nginx:alpine serving the Vite build and proxying /api to the api service
#
# The PDF, page images, out/ and .env never enter an image (see .dockerignore);
# they are mounted read-only at run time.

# ---------------------------------------------------------------- deps (all, for building)
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/indexer/package.json packages/indexer/
COPY packages/api/package.json packages/api/
COPY packages/web/package.json packages/web/
RUN npm ci --ignore-scripts && npm rebuild esbuild

# ---------------------------------------------------------------- build
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages ./packages
RUN npm run build && npm run build:web \
 && find packages -path '*/dist/*' -name '*.map' -delete

# ---------------------------------------------------------------- production deps only (no web, no dev)
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/indexer/package.json packages/indexer/
COPY packages/api/package.json packages/api/
RUN npm ci --omit=dev --ignore-scripts --workspace @miriel/shared --workspace @miriel/indexer --workspace @miriel/api

# ---------------------------------------------------------------- runtime (migrate / indexer / api)
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache tini
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/package.json ./
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/indexer/package.json packages/indexer/
COPY --from=build /app/packages/indexer/dist packages/indexer/dist
COPY --from=build /app/packages/api/package.json packages/api/
COPY --from=build /app/packages/api/dist packages/api/dist
COPY packages/api/prompts packages/api/prompts
COPY config ./config
COPY db/migrations ./db/migrations
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "packages/api/dist/main.js"]

# ---------------------------------------------------------------- web
FROM nginx:alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/packages/web/dist /usr/share/nginx/html
