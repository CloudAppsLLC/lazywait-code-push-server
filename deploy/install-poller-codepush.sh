#!/usr/bin/env bash
# install-poller-codepush.sh — install the GHCR poller for the CodePush
# container on the VPS. One-time, idempotent, root-only.
#
#   sudo bash /opt/lazywait-codepush/deploy/install-poller-codepush.sh
#
# What it does:
#   1. chmod +x the poller.
#   2. Writes /etc/cron.d/lazywait-poll-ghcr-codepush (every 60s, root).
#   3. Ensures /var/log/lazywait-deploy exists — the SAME directory the two API
#      pollers log to, so the existing logrotate rule there
#      (/etc/logrotate.d/lazywait-deploy, installed by the API repo's
#      install-poller.sh) already covers this log too. If that file is missing,
#      run the API's installer as well; an uncapped log on this box has form.
#   4. Runs the poller once to validate.
#
# Cron lives in /etc/cron.d and not in root's crontab because root on this box
# has no personal crontab at all — an entry added there runs nowhere, which is a
# failure mode with no error message.
#
# Stop auto-deploys permanently:  sudo rm /etc/cron.d/lazywait-poll-ghcr-codepush
# Stop them for one release:      touch /opt/lazywait-codepush/deploy/.deploy-hold

set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/lazywait-codepush}"
SCRIPT="$INSTALL_DIR/deploy/poll-ghcr-codepush.sh"
CRON_FILE="/etc/cron.d/lazywait-poll-ghcr-codepush"
LOG_DIR="/var/log/lazywait-deploy"

if [[ "$EUID" -ne 0 ]]; then
	echo "ERR: must run as root (cron under /etc/cron.d and the docker socket both require it)."
	exit 1
fi

if [[ ! -f "$SCRIPT" ]]; then
	echo "ERR: $SCRIPT not found. Did you clone the repo to $INSTALL_DIR and 'git pull' first?"
	exit 1
fi

echo "==> chmod +x $SCRIPT"
chmod +x "$SCRIPT"

echo "==> mkdir -p $LOG_DIR"
mkdir -p "$LOG_DIR"
touch "$LOG_DIR/poll-codepush.log"
chmod 644 "$LOG_DIR/poll-codepush.log"

if [[ ! -f /etc/logrotate.d/lazywait-deploy ]]; then
	echo "WARN: /etc/logrotate.d/lazywait-deploy is missing — $LOG_DIR will grow unbounded."
	echo "      Run /opt/lazywait/deploy/vps/install-poller.sh (API repo) to create it."
fi

echo "==> writing $CRON_FILE"
cat > "$CRON_FILE" <<EOF
# LazyWait CodePush GHCR poller — installed by deploy/install-poller-codepush.sh
# Every 60s, check whether ghcr.io/cloudappsllc/lazywait-code-push-server:latest
# has a new digest; pull + recreate the codepush service if so. Skips while
# $INSTALL_DIR/deploy/.deploy-hold exists, and skips entirely when CODEPUSH_TAG
# pins a non-latest tag. See poll-ghcr-codepush.sh.
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
* * * * * root $SCRIPT
EOF
chmod 644 "$CRON_FILE"

echo "==> reloading cron"
systemctl reload cron 2>/dev/null || systemctl reload crond 2>/dev/null || service cron reload 2>/dev/null || true

echo ""
echo "==> first run (foreground, to validate setup)"
# Non-fatal: the very first install can run before any image exists at :latest.
# Cron is already in place, so the next tick retries.
if "$SCRIPT"; then
	echo "✓ poller ran cleanly"
else
	echo "⚠ poller first-run exited non-zero (likely no image at :latest yet)."
	echo "  Cron is installed — the next tick will retry. Logs: $LOG_DIR/poll-codepush.log"
fi

echo ""
echo "──────────────────────────────────────────────"
echo " ✓ CodePush GHCR poller installed."
echo "   Tail log:    tail -f $LOG_DIR/poll-codepush.log"
echo "   Force check: bash $SCRIPT"
echo "   Hold:        touch $INSTALL_DIR/deploy/.deploy-hold"
echo "   Disable:     sudo rm $CRON_FILE"
echo "──────────────────────────────────────────────"
