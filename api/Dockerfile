# syntax=docker/dockerfile:1.7
#
# Container image for the LazyWait CodePush server.
#
# WHY THIS FILE EXISTS
# --------------------
# Until now this fork shipped exactly one way: `npm run deploy`, which zips
# ./bin + package.json and pushes it at an Azure App Service with the `az` CLI
# (package.json "deploy"). That couples the only deployment path to a single
# Azure subscription, an interactive `az login`, and a laptop -- which is the
# thing the migration off Azure is undoing. This image is built by CI, pushed to
# GHCR, and PULLED by a cron poller on the VPS (deploy/poll-ghcr-codepush.sh),
# exactly like the Internal API next door.
#
# Stage 1 (builder): full deps (dev included, `shx` and `typescript` are both
#   devDependencies and both are needed by `npm run build`), compile, then prune
#   dev deps in place so the runner can copy node_modules whole.
# Stage 2 (runner): production node_modules + ./bin only. No compiler, no
#   registry access, no secrets.
#
# There is NO build secret here, unlike functions/Dockerfile in the API repo:
# this project has no private git dependencies, so `npm ci` runs against the
# public registry alone.

ARG NODE_VERSION=20

# ----------------------------------------------------------------
# Stage 1 — builder
# ----------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS builder

ENV NODE_ENV=development \
    CI=true

WORKDIR /app

# Deps first, cached independently of source. `npm ci` (not `npm install`)
# because package-lock.json is committed and CI must not silently resolve a
# different tree than the lockfile pins -- this fork sits on pinned-by-necessity
# versions (shortid 2.2.2, redis ^2.4.2, yauzl 2.6.0) whose transitive graphs
# have moved on considerably.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# Source + build config. Copied as three explicit paths rather than `COPY . .`
# so that api/.env -- which is present in working copies and carries live Azure
# storage credentials -- can never end up in a layer. .dockerignore is the belt;
# this is the suspenders.
COPY tsconfig.json ./
COPY script ./script

# `npm run build` is `tsc && shx cp -r ./script/views ./bin/script`.
#
# THE COPY IS NOT OPTIONAL. tsc emits only .js, so the EJS templates under
# script/views (and script/views/images, served as static assets at
# /auth/images/) never reach ./bin on their own. default-server.ts sets
# `app.set("views", __dirname + "/views")` and mounts the passport auth router
# unconditionally, so an image without them answers every /auth/* route with a
# view-lookup 500 -- including the OAuth callback a developer needs to obtain a
# CLI access key. The auth router is scheduled for deletion in a later phase;
# until then this line is load-bearing.
RUN npm run build

# FAIL THE BUILD HERE, NOT AT CONTAINER START.
#
# The emit layout depends on tsconfig.json's rootDir, and this stage copies only
# script/ while a working copy also has test/ -- so an inferred rootDir puts the
# entry point at ./bin/server.js here and ./bin/script/server.js on a laptop.
# tsconfig.json now pins rootDir for exactly that reason, but the failure mode it
# closes is silent (a clean build, a green CI run, and a container that exits with
# MODULE_NOT_FOUND on a path that exists everywhere else), so it is worth two
# lines to assert the shape rather than trust it. The views check is the same
# argument: tsc emits no .ejs, so a missing copy step is invisible until the first
# /auth/* request 500s.
RUN test -f ./bin/script/server.js \
 || (echo "BUILD LAYOUT ERROR: ./bin/script/server.js missing -- check tsconfig rootDir" && ls -R ./bin | head -50 && exit 1)
RUN test -f ./bin/script/views/authenticate.ejs \
 || (echo "BUILD LAYOUT ERROR: EJS views missing from ./bin/script/views -- check the build script" && exit 1)

# Drop dev deps from the tree the runner will copy. Safe after the build: the
# compiler, shx and the test tooling have all done their work by this point.
RUN --mount=type=cache,target=/root/.npm \
    npm prune --omit=dev

# ----------------------------------------------------------------
# Stage 2 — runner
# ----------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS runner

# Build identity, stamped by CI (--build-arg) and served on GET /version.
#
# WHY: the VPS PULLS its image with a cron poller rather than being pushed to,
# so a green CI run and a running container are two separate facts. In the API
# repo, telling them apart once meant probing for a route only a new build has
# and reading a 404 from the catch-all handler; a shipped feature spent an
# afternoon looking broken for exactly that reason.
#
# Declared in the RUNNER stage only: these change on every commit, so putting
# them any earlier would bust the layer cache for the whole dependency install.
ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown

# PORT 9002 is the LazyWait VPS allocation: 9000 is the prod API, 9001 the dev
# API, both already bound on that box. Overridable at runtime; the compose file
# sets it explicitly anyway so the value is visible where the port is published.
#
# HTTPS IS DELIBERATELY NOT SET, AND MUST NEVER BE. server.ts:15 reads it as
# `Boolean(process.env.HTTPS)`, which is true for the string "false" -- and true
# for the string `true# Set to 'true'...` that api/.env actually contains, since
# dotenv keeps everything after the value when no space precedes the `#`. Any
# value at all makes the process read ./certs/cert.key at boot and die. TLS is
# terminated by Caddy one hop upstream; this process serves plain HTTP on the
# docker network and nothing else.
ENV NODE_ENV=production \
    PORT=9002 \
    GIT_SHA=${GIT_SHA} \
    BUILD_TIME=${BUILD_TIME}

WORKDIR /app

# tini: proper signal forwarding so SIGTERM reaches node and `docker compose up
# -d` swaps the container gracefully instead of waiting out the 10s kill timer.
# ca-certificates: the server itself makes outbound HTTPS calls -- the package
# differ re-fetches previously released bundles by URL weeks later
# (utils/package-diffing.ts) and the Supabase backend talks to PostgREST. Without
# a trust store both fail with UNABLE_TO_GET_ISSUER_CERT_LOCALLY.
#
# Nothing else. Note in particular that there is NO wget and NO curl in
# node:slim, which is why the healthcheck in deploy/docker-compose.codepush.yml
# uses node's own http module: the API's prod container has used a `wget --spider`
# probe for months and has therefore reported (unhealthy) the entire time while
# serving 200s.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

# Production-pruned deps + compiled output. package.json comes along because
# `npm start` reads it and because the runtime resolves "main"/type from it.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/bin ./bin

# Drop privileges. node:slim ships a non-root `node` user.
#
# The process needs a WRITABLE TEMP DIR, not a writable /app: every release
# streams its zip through os.tmpdir() (file-upload-manager.ts) and the differ
# does its work under $TEMP/$TMPDIR/codepush-temp (environment.ts), creating it
# with mkdirSync recursive. /tmp is world-writable in the base image, so `node`
# is fine there -- do not "harden" this with a read-only rootfs unless you also
# mount a tmpfs at /tmp.
RUN chown -R node:node /app
USER node

EXPOSE 9002

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "./bin/script/server.js"]
