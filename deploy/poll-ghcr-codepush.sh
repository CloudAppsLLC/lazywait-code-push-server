#!/usr/bin/env bash
# poll-ghcr-codepush.sh — pull and restart the lazywait-codepush container when
# GHCR has a new :latest digest. Runs every 60s from cron (install-poller-codepush.sh).
#
# GitHub Actions cannot reach this VPS (the Aliyun security group cannot
# allowlist GitHub's ~3000 rotating egress CIDRs), so the box pulls instead of
# being pushed to. Same shape as the Internal API's poll-ghcr-dev.sh, with three
# deliberate differences, all of which matter here and not there:
#
#   1. `up -d` IS SCOPED TO ONE SERVICE. Never a bare project-wide `up -d`
#      (which the prod API poller does) and NEVER --remove-orphans: this compose
#      file attaches to the API stack's EXTERNAL network, and an unscoped
#      operation on a project that doesn't own it is how you find out what else
#      it can touch.
#   2. A PINNED TAG WINS. If CODEPUSH_TAG names anything but `latest`, someone
#      has deliberately rolled back and this script exits without pulling.
#      Otherwise the first tick after a rollback would drag the box straight
#      back onto the broken build, which makes the documented revert a lie.
#   3. A RELEASE HOLD FILE STOPS IT. Restarting this container is not free the
#      way restarting a stateless API is: the update-check response cache is an
#      in-process Map at exactly one replica, so a restart sends the whole
#      fleet's next check to the database at once, and a restart mid-release
#      also destroys the temp file the release is streaming through. Touch
#      .deploy-hold before a release, remove it after.
#
# All output goes to /var/log/lazywait-deploy/poll-codepush.log — the same
# directory the API pollers use, so one `tail -f /var/log/lazywait-deploy/*.log`
# watches every deploy on the box.
#
# Manual trigger (skip cron, force a check): just run this script.

set -euo pipefail

# The compose file's own directory: `docker compose` resolves both the
# `env_file: ./.env.codepush` path and the `.env` that supplies CODEPUSH_TAG
# relative to it.
VPS_DIR="${VPS_DIR:-/opt/lazywait-codepush/deploy}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.codepush.yml}"
SERVICE="${SERVICE:-codepush}"
IMAGE="${IMAGE:-ghcr.io/cloudappsllc/lazywait-code-push-server:latest}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:9002/health}"
VERSION_URL="${VERSION_URL:-http://127.0.0.1:9002/version}"
LOG_DIR="${LOG_DIR:-/var/log/lazywait-deploy}"
LOG="$LOG_DIR/poll-codepush.log"
LOCK="/var/lock/lazywait-poll-ghcr-codepush.lock"
HOLD_FILE="${HOLD_FILE:-$VPS_DIR/.deploy-hold}"

mkdir -p "$LOG_DIR"
touch "$LOG"

# Single-instance guard, on its own lock file so it never contends with the two
# API pollers. `flock -n` exits immediately rather than queueing a second tick
# behind a slow pull.
exec 9>"$LOCK"
if ! flock -n 9; then
	exit 0
fi

log() {
	printf '[%s] %s\n' "$(date -Iseconds)" "$*" >> "$LOG"
}

cd "$VPS_DIR" || { log "ERR: cd $VPS_DIR failed"; exit 1; }

# Release hold. Loud, because a hold left in place silently stops deploys and
# the symptom ("my fix didn't land") points everywhere except here.
if [[ -e "$HOLD_FILE" ]]; then
	log "HOLD: $HOLD_FILE exists — skipping. Remove it to resume auto-deploys."
	exit 0
fi

# Deliberate rollback pin. `docker compose config` is the authority rather than
# grepping .env, because the variable can also come from the environment.
EFFECTIVE_IMAGE="$(docker compose -f "$COMPOSE_FILE" config --images 2>/dev/null | head -n1 || echo '')"
if [[ -n "$EFFECTIVE_IMAGE" && "$EFFECTIVE_IMAGE" != *":latest" ]]; then
	log "PINNED: compose resolves to $EFFECTIVE_IMAGE — not :latest. Skipping (deliberate rollback)."
	exit 0
fi

# Re-assert the GHCR login. Normally a no-op (the credential persists in
# /root/.docker/config.json); if it ever clears, the pull below fails with a
# less friendly message than this one. Reuses the same token the API stack
# already has on the box.
GHCR_TOKEN_FILE="${GHCR_TOKEN_FILE:-/opt/lazywait/.github_token}"
if [[ -s "$GHCR_TOKEN_FILE" ]]; then
	tr -d '\r\n' < "$GHCR_TOKEN_FILE" | docker login ghcr.io -u USERNAME --password-stdin >/dev/null 2>&1 || true
fi

# Snapshot what is running BEFORE the pull, so a no-change tick is detectable.
CURRENT_IMG_ID="$(docker compose -f "$COMPOSE_FILE" ps -q "$SERVICE" 2>/dev/null | xargs -r docker inspect --format '{{.Image}}' 2>/dev/null || echo '')"

if ! PULL_OUT="$(docker compose -f "$COMPOSE_FILE" pull "$SERVICE" 2>&1)"; then
	log "ERR: docker compose pull $SERVICE failed"
	echo "$PULL_OUT" >> "$LOG"
	exit 1
fi

LATEST_IMG_ID="$(docker inspect "$IMAGE" --format '{{.Id}}' 2>/dev/null || echo '')"

if [[ -z "$LATEST_IMG_ID" ]]; then
	log "ERR: could not inspect $IMAGE after pull"
	echo "$PULL_OUT" >> "$LOG"
	exit 1
fi

# Already on the newest image — quiet. This is the common case, once a minute,
# forever; anything printed here would drown the log it shares with two other
# pollers.
if [[ "$CURRENT_IMG_ID" == "$LATEST_IMG_ID" ]]; then
	exit 0
fi

short_old="${CURRENT_IMG_ID#sha256:}"; short_old="${short_old:0:12}"
short_new="${LATEST_IMG_ID#sha256:}"; short_new="${short_new:0:12}"
log "new image: $short_new (was ${short_old:-none}). Restarting $SERVICE (this flushes the update-check cache)."

if ! UP_OUT="$(docker compose -f "$COMPOSE_FILE" up -d "$SERVICE" 2>&1)"; then
	log "ERR: docker compose up -d $SERVICE failed"
	echo "$UP_OUT" >> "$LOG"
	exit 1
fi
echo "$UP_OUT" >> "$LOG"

# Reclaim the disk the previous image held. The root filesystem on this box is
# 40 GB and has been filled once already.
docker image prune -f >> "$LOG" 2>&1 || true

# Health + identity probe. curl is absent from the CONTAINER, not from the host,
# so it is fine here. Logging the build stamp is the point: it is the line that
# proves the swap actually happened, which a green CI run does not.
sleep 5
if curl -fsS -m 5 "$HEALTH_URL" >/dev/null 2>&1; then
	STAMP="$(curl -fsS -m 5 "$VERSION_URL" 2>/dev/null || echo '{}')"
	log "✓ codepush deploy live ($short_new) $STAMP"
else
	log "✗ codepush health check FAILED after deploy ($short_new) — see 'docker compose -f $COMPOSE_FILE logs $SERVICE'"
fi
