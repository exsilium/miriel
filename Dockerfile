# syntax=docker/dockerfile:1
#
# Targets:
#   runtime  node:22-alpine with shared + indexer + api (used by the migrate, indexer and api services)
#   web      nginx:alpine serving the Vite build and proxying /api to the api service
#   retake   Debian + Python (uv) + ocrmypdf/tesseract/ghostscript/qpdf + the indexer, for scripts/retake.py
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
# Thumbnail cache (named volume in compose); created here so the volume inherits node ownership.
RUN mkdir -p /cache/thumbs && chown -R node:node /cache
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "packages/api/dist/main.js"]

# ---------------------------------------------------------------- indexer deps on glibc (for the retake image)
FROM node:22-trixie-slim AS retake-node-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/indexer/package.json packages/indexer/
COPY packages/api/package.json packages/api/
COPY packages/web/package.json packages/web/
RUN npm ci --omit=dev --ignore-scripts --workspace @miriel/shared --workspace @miriel/indexer

# ---------------------------------------------------------------- retake (scripts/retake.py: page retakes)
# Debian, because the book PDFs were made with Debian's ocrmypdf + tesseract 5.5. Python deps come from the
# uv `retake` group (ocrmypdf pinned to the version that built the books); binaries from apt. Node + the
# indexer are included so a retake can re-ingest its pages. data/ and out/ are mounted read-write.
FROM node:22-trixie-slim AS retake
RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng ghostscript qpdf tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.9 /uv /usr/local/bin/uv
ENV UV_PROJECT_ENVIRONMENT=/opt/venv UV_PYTHON_INSTALL_DIR=/opt/python UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy \
    PATH=/opt/venv/bin:$PATH PYTHONUNBUFFERED=1
WORKDIR /app
COPY pyproject.toml uv.lock .python-version ./
RUN uv sync --frozen --no-install-project --no-default-groups --group retake \
 && chmod -R a+rX /opt/python /opt/venv
COPY --from=retake-node-deps /app/node_modules ./node_modules
COPY --from=retake-node-deps /app/package.json ./
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/indexer/package.json packages/indexer/
COPY --from=build /app/packages/indexer/dist packages/indexer/dist
COPY config ./config
COPY db/migrations ./db/migrations
COPY prompts ./prompts
COPY scripts ./scripts
# out/ and the thumbnail cache are mounts; created here so the node user owns them when they are empty volumes.
RUN mkdir -p /app/out /cache/thumbs && chown node:node /app/out /cache /cache/thumbs
USER node
ENTRYPOINT ["/usr/bin/tini", "--", "python", "scripts/retake.py"]
CMD ["--help"]

# ---------------------------------------------------------------- web
FROM nginx:alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/packages/web/dist /usr/share/nginx/html
