#!/usr/bin/env bash
# Local run for demo/screenshot: binds 127.0.0.1:8888 with Campux OAuth env.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f "$HOME/.hydro/config.json" ]]; then
  echo "error: ~/.hydro/config.json missing. Start Mongo first: scripts/start-mongo.sh" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source scripts/env.campux
set +a

node data/set-hydro-lan.js
node data/set-site-name.js || true
node data/set-domain-avatar.js || true
node data/apply-brand-settings.js

: "${CAMPUX_OAUTH_ENDPOINT:=https://kg.campux.top}"
: "${CAMPUX_OAUTH_SCOPE:=profile}"
: "${CAMPUX_ADMIN_QQ:=1692138502,2671016745}"

export CAMPUX_OAUTH_ENDPOINT CAMPUX_OAUTH_SCOPE CAMPUX_ADMIN_QQ

if [[ -z "${CAMPUX_OAUTH_CLIENT_ID:-}" || -z "${CAMPUX_OAUTH_CLIENT_SECRET:-}" ]]; then
  echo "error: CAMPUX_OAUTH_CLIENT_ID / CAMPUX_OAUTH_CLIENT_SECRET required." >&2
  exit 1
fi

exec node -r @hydrooj/register packages/hydrooj/bin/hydrooj.js \
  --host 127.0.0.1 --port 8888
