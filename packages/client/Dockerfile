# ── Stage 1: Install dependencies ────────────────────────────────────
FROM node:24-bookworm-slim AS deps
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/invoice-pdf/package.json packages/invoice-pdf/
COPY packages/server/package.json packages/server/
COPY packages/core/package.json packages/core/
COPY packages/client/package.json packages/client/
COPY docs-site/package.json docs-site/
# Install all workspace deps (build stage is discarded)
RUN pnpm install --frozen-lockfile

# ── Stage 2: Build ───────────────────────────────────────────────────
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/invoice-pdf packages/invoice-pdf
COPY packages/server packages/server
COPY packages/core packages/core
COPY packages/client packages/client
# The docs site is built into out/docs/ below. Its config and llms plugin import
# from scripts/llms, and scripts/docs holds the copy-and-check step.
COPY docs-site docs-site
COPY scripts/llms scripts/llms
COPY scripts/docs scripts/docs
COPY scripts/write-version-json.mjs scripts/write-version-json.mjs

# Next.js inlines NEXT_PUBLIC_* into the browser bundle at BUILD time —
# runtime env on the deployed container has no effect on browser code.
# CI passes these as --build-arg (see .github/workflows/build-and-deploy.yml),
# where the api.<domain> literals live.
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_WS_URL
ARG NEXT_PUBLIC_OPENPANEL_CLIENT_ID
ARG NEXT_PUBLIC_PLAUSIBLE_DOMAIN
ARG NEXT_PUBLIC_PLAUSIBLE_SCRIPT_URL
ARG NEXT_PUBLIC_SENTRY_DSN
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL \
    NEXT_PUBLIC_OPENPANEL_CLIENT_ID=$NEXT_PUBLIC_OPENPANEL_CLIENT_ID \
    NEXT_PUBLIC_PLAUSIBLE_DOMAIN=$NEXT_PUBLIC_PLAUSIBLE_DOMAIN \
    NEXT_PUBLIC_PLAUSIBLE_SCRIPT_URL=$NEXT_PUBLIC_PLAUSIBLE_SCRIPT_URL \
    NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN

ARG COMMIT_SHA
# NEXT_PUBLIC_BUILD_COMMIT is the bundle's own copy of the commit, compared
# against /version.json by an open tab to notice a newer deploy
# (packages/client/src/lib/deploy-version.ts). Empty disables that check.
ENV COMMIT_SHA=$COMMIT_SHA \
    NEXT_PUBLIC_BUILD_COMMIT=$COMMIT_SHA

RUN pnpm --filter @starter/shared run build
# The client type-checks through @starter/server/trpc into the invoice router,
# which imports @starter/invoice-pdf; its dist has to exist to resolve, like
# shared's and core's.
RUN pnpm --filter @starter/invoice-pdf run build
RUN pnpm --filter @starter/core run build
RUN pnpm --filter @starter/client run build

# Prove the build arg actually reached the bundle, and fail the image if it
# did not. NEXT_PUBLIC_* is inlined at build time, so a missing or misspelled
# arg produces an image that builds perfectly, starts healthy, and talks to
# the wrong API — or to nothing. That shipped twice: every image before
# 2026-09-08 was built with an EMPTY api url (the workflow read a repo
# variable nobody had set), and the domain migration then went out against a
# stale one. Neither was caught by a test, because both artefacts were fine
# in every way a test looked at them.
RUN test -n "$NEXT_PUBLIC_API_URL" \
      || (echo "NEXT_PUBLIC_API_URL build arg is empty" >&2; exit 1); \
    grep -rqF "$NEXT_PUBLIC_API_URL" packages/client/out/_next/static \
      || (echo "NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL never made it into the bundle" >&2; exit 1)

# The docs, at https://trackyourtime.dev/docs/. Built here and not in the
# client's own `build` script, because that script also feeds the Electron,
# Capacitor and E2E builds, none of which should carry them. The script exits
# non-zero if any page would ship noindex or a canonical link to another host.
# No git in this stage and no .git in the context: the docs sitemap therefore
# carries no lastmod (docs-site/docusaurus.config.ts explains).
RUN node scripts/docs/build-into-client.mjs

# Stamp the commit and release version next to the export so the deployed
# artefact can be asked what it is: CI polls it after a deploy, and open tabs
# poll it to offer a reload. serve.mjs sends it with no-cache.
RUN node scripts/write-version-json.mjs packages/client/out/version.json

# ── Stage 3: Production runtime ─────────────────────────────────────
FROM node:24-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=6477

# The client is `output: "export"` — there is no `.next/standalone` and no
# `server.js`, because the desktop and mobile shells load this same bundle from
# file:// and from the Capacitor container. What ships to the web is therefore
# the exported tree plus a static file server.
#
# serve.mjs resolves its root relative to itself, so /app/serve.mjs finds
# /app/out here exactly as packages/client/serve.mjs finds packages/client/out
# in the repo. It is also what the E2E suite runs, so the deployed server and
# the tested server cannot drift apart.
COPY --from=build /app/packages/client/out ./out
COPY --from=build /app/packages/client/serve.mjs ./serve.mjs

USER node
EXPOSE 6477

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||'6477')).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "serve.mjs"]
