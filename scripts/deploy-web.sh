#!/bin/sh
# Deploy the web app (packages/web-app) to Vercel from this checkout's HEAD.
#
#   scripts/deploy-web.sh staging                      # preview deploy, then alias staging.confnote.si
#   scripts/deploy-web.sh production --yes-production  # production deploy (confnote.si); refuses without the flag
#   scripts/deploy-web.sh staging --build-only         # build + verify the prebuilt output, upload nothing
#
# Flags: --yes-production (required for production), --build-only, --allow-dirty (staging only).
# Production also refuses unless HEAD is pushed and staging.confnote.si serves this exact commit.
#
# Inputs by env name; values never live in this repo (docs/release/README.md lists them):
#   CONFNOTE_CATALOGUE_DIR        required: the reviewed events-data dist holding index.json
#   CONFNOTE_DEMO_MEDIA_DIR       required: the /demo page's recorded video folder (versions.json + v*/)
#   CONFNOTE_BRYNTUM_LICENSE_KEY  else the login keychain item bryntum-trial-license / license_key
# Both hosts build Bryntum and tldraw for the PayPal AI Hackathon judging period (musa, 2026-11-13); each module
# shows a licence notice on the hosted site.
#   CONFNOTE_DEPLOY_LOG_DIR       npm/pull/build/deploy logs (default .vercel/deploy-logs)
#   CONFNOTE_STAGING_RUNTIME_ENV  staging only: space-separated KEY=value runtime env for this one deployment
#                                 (a feature flag such as CONFNOTE_CONCIERGE_ENGINE=agent-sdk); never stored in the
#                                 project's env, refused for production. Values are flags, not secrets.
# Runtime secrets (database, WorkOS, Router, PayPal) are Vercel project env, pulled per environment.
#
# Why prebuilt: the web app imports ../auth, ../events-model, ../catalogue-web, so the build has to see
# the whole repo. The Vercel project's Root Directory stays "."; the override to packages/web-app lives
# only in this checkout's .vercel/project.json and is rewritten after every pull.
set -eu
umask 077

SCOPE="atlascodes"
PROJECT="confnote-web-app"
STAGING_HOST="staging.confnote.si"
PRODUCTION_HOST="confnote.si"
DEPLOY_ATTEMPTS=3
SMOKE_ATTEMPTS=12
SMOKE_INTERVAL_SECONDS=5

usage() {
  sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//' >&2
}

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TARGET="${1-}"
[ $# -gt 0 ] && shift
YES_PRODUCTION=0
BUILD_ONLY=0
ALLOW_DIRTY=0
for arg in "$@"; do
  case "$arg" in
    --yes-production) YES_PRODUCTION=1 ;;
    --build-only) BUILD_ONLY=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    *) usage; exit 2 ;;
  esac
done

case "$TARGET" in
  staging) ENVIRONMENT=preview; HOST="$STAGING_HOST"; PROD_FLAG="" ;;
  production) ENVIRONMENT=production; HOST="$PRODUCTION_HOST"; PROD_FLAG="--prod" ;;
  *) usage; exit 2 ;;
esac

if [ "$TARGET" = production ]; then
  if [ "$YES_PRODUCTION" != 1 ]; then
    echo "refusing: production deploys $PRODUCTION_HOST and needs --yes-production" >&2
    exit 2
  fi
  if [ "$ALLOW_DIRTY" = 1 ]; then
    echo "refusing: production never deploys a dirty tree" >&2
    exit 2
  fi
fi

COMMIT="$(git rev-parse HEAD)"
SHORT="$(git rev-parse --short HEAD)"
# A deploy names a commit, so the tree must be that commit. The repo-root .vercel/ link is local state.
DIRTY="$(git status --porcelain --untracked-files=normal | grep -vE '^\?\? \.vercel/$' || true)"
if [ -n "$DIRTY" ] && [ "$ALLOW_DIRTY" != 1 ]; then
  echo "refusing: the tree has changes $SHORT does not hold (commit them, or --allow-dirty for staging):" >&2
  echo "$DIRTY" >&2
  exit 1
fi

RUNTIME_ENV_ARGS=""
if [ -n "${CONFNOTE_STAGING_RUNTIME_ENV:-}" ]; then
  if [ "$TARGET" != staging ]; then
    echo "refusing: CONFNOTE_STAGING_RUNTIME_ENV is for staging deployments only" >&2
    exit 2
  fi
  for pair in $CONFNOTE_STAGING_RUNTIME_ENV; do
    if ! printf '%s' "$pair" | grep -qE '^[A-Z][A-Z0-9_]*=[A-Za-z0-9._:/-]+$'; then
      echo "refusing: CONFNOTE_STAGING_RUNTIME_ENV entry is not KEY=value: $pair" >&2
      exit 2
    fi
    RUNTIME_ENV_ARGS="$RUNTIME_ENV_ARGS --env $pair"
  done
fi

CATALOGUE="${CONFNOTE_CATALOGUE_DIR:-}"
if [ -z "$CATALOGUE" ] || [ ! -f "$CATALOGUE/index.json" ]; then
  echo "refusing: CONFNOTE_CATALOGUE_DIR must name the events-data dist holding index.json" >&2
  exit 2
fi
# 2026-11-13: deploys without it shipped an empty /demo on both hosts, so it is required, not a warning.
if [ -z "${CONFNOTE_DEMO_MEDIA_DIR:-}" ] || [ ! -f "$CONFNOTE_DEMO_MEDIA_DIR/versions.json" ]; then
  echo "refusing: CONFNOTE_DEMO_MEDIA_DIR must name the /demo media folder holding versions.json" >&2
  exit 2
fi

if [ "$TARGET" = production ]; then
  # Remote-tracking refs can outlive a deleted branch; ask the remote now.
  git fetch -q --prune origin || { echo "refusing: git fetch origin failed" >&2; exit 1; }
  if [ -z "$(git branch -r --contains HEAD)" ]; then
    echo "refusing: $SHORT is not on any remote branch; push it and stage it first" >&2
    exit 1
  fi
  # Production ships only what staging already serves from a clean tree (and what e2e-web checked there).
  STAGED="$(curl -fsS -m 15 "https://$STAGING_HOST/release.json" 2>/dev/null \
    | python3 -I -c 'import json, sys; d = json.load(sys.stdin); print("dirty" if d.get("dirty", True) else d.get("commit", ""))' \
      2>/dev/null || true)"
  if [ "$STAGED" != "$COMMIT" ]; then
    echo "refusing: $STAGING_HOST serves '${STAGED:-nothing}', not a clean $COMMIT; deploy staging first" >&2
    exit 1
  fi
fi

LOGS="${CONFNOTE_DEPLOY_LOG_DIR:-$ROOT/.vercel/deploy-logs}"
mkdir -p "$LOGS"
echo "deploying $SHORT to $TARGET ($HOST); logs in $LOGS"

(cd packages/web-app && npm ci --no-audit --no-fund) >"$LOGS/npm.log" 2>&1 \
  || { echo "npm ci failed: $LOGS/npm.log" >&2; exit 1; }
for check in typecheck test; do
  npm --prefix packages/web-app run "$check" >"$LOGS/$check.log" 2>&1 \
    || { echo "web $check failed: $LOGS/$check.log" >&2; exit 1; }
done

if [ ! -f .vercel/project.json ]; then
  vercel link --yes --project "$PROJECT" --scope "$SCOPE" >"$LOGS/link.log" 2>&1 \
    || { echo "vercel link failed: $LOGS/link.log" >&2; exit 1; }
fi
# The pulled env file holds secrets; it lives only for this run.
trap 'rm -f "$ROOT/.vercel/.env.$ENVIRONMENT.local"' EXIT
vercel pull --yes --environment="$ENVIRONMENT" --scope "$SCOPE" >"$LOGS/pull.log" 2>&1 \
  || { echo "vercel pull failed: $LOGS/pull.log" >&2; exit 1; }
python3 -I -c '
import json
p = ".vercel/project.json"
d = json.load(open(p))
d.setdefault("settings", {})["rootDirectory"] = "packages/web-app"
json.dump(d, open(p, "w"))'

export CONFNOTE_CATALOGUE_DIR="$CATALOGUE"
# Both hosts are the signed-in hosted app (no public demo mode) with the Planner and the tldraw board.
export CONFNOTE_PUBLIC_DEMO=0 CONFNOTE_TLDRAW=1 CONFNOTE_BRYNTUM=1
BRYNTUM_KEY="${CONFNOTE_BRYNTUM_LICENSE_KEY:-}"
if [ -z "$BRYNTUM_KEY" ]; then
  BRYNTUM_KEY="$(security find-generic-password -s bryntum-trial-license -a license_key -w 2>/dev/null || true)"
fi
[ -n "$BRYNTUM_KEY" ] || echo "warning: no Bryntum licence key; the Planner builds in trial mode" >&2

CONFNOTE_BRYNTUM_LICENSE_KEY="$BRYNTUM_KEY" vercel build --yes $PROD_FLAG >"$LOGS/build.log" 2>&1 \
  || { echo "vercel build failed: $LOGS/build.log" >&2; grep -m5 -iE 'error' "$LOGS/build.log" >&2 || true; exit 1; }
BRYNTUM_KEY=""

OUT=.vercel/output
FUNC="$OUT/functions/api/index.func"
grep -q "built bryntum island bundle" "$LOGS/build.log" \
  || { echo "Bryntum bundle did not build: $LOGS/build.log" >&2; exit 1; }
[ -f "$FUNC/packages/web-app/catalogue-data/index.json" ] || { echo "catalogue not bundled" >&2; exit 1; }
# Both hosts are the signed-in app. `vercel pull` returns sensitive env values empty, and build-static reads an
# empty CONFNOTE_PUBLIC_DEMO as demo on (2026-11-12: confnote.si shipped "saved in this browser" for signed-in users).
grep -q 'window.confnote.publicDemo = false' "$OUT/static/index.html" \
  || { echo "the build baked publicDemo on; set CONFNOTE_PUBLIC_DEMO=0 as a non-sensitive $ENVIRONMENT env value" >&2; exit 1; }
# The function applies these on first database use; without them it answers 503.
for migration in packages/auth/migrations/*.sql; do
  [ -f "$FUNC/$migration" ] || { echo "$migration not bundled" >&2; exit 1; }
done
[ -f "$OUT/static/modules/tldraw/manifest.json" ] || { echo "tldraw module not in the $TARGET build" >&2; exit 1; }
[ -f "$OUT/static/media/versions.json" ] || { echo "demo media not in the build" >&2; exit 1; }

# /release.json says what is live: production checks staging's before it ships. No paths, no secrets.
python3 -I - "$OUT/static/release.json" "$TARGET" "$COMMIT" "$CATALOGUE" "${CONFNOTE_DEMO_MEDIA_DIR:-}" \
  "${CONFNOTE_TLDRAW:-0}" "$([ -n "$DIRTY" ] && echo 1 || echo 0)" "${CONFNOTE_BRYNTUM:-1}" <<'PY'
import hashlib, json, os, sys
from datetime import datetime, timezone

out, target, commit, catalogue, media, tldraw, dirty, bryntum = sys.argv[1:]
index = os.path.join(catalogue, "index.json")
with open(index, "rb") as f:
    raw = f.read()
data = json.loads(raw)
release = {
    "name": "confnote-web",
    "target": target,
    "commit": commit,
    "dirty": dirty == "1",
    "built_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "catalogue": {
        "snapshot": os.path.basename(os.path.normpath(catalogue)),
        "schema_version": data.get("schema_version"),
        "events": len(data.get("events", [])),
        "sha256": hashlib.sha256(raw).hexdigest(),
    },
    "demo_media": os.path.basename(os.path.normpath(media)) if media else None,
    "tldraw": tldraw == "1",
    "bryntum": bryntum == "1",
}
with open(out, "w") as f:
    json.dump(release, f, indent=2)
    f.write("\n")
PY

if [ "$BUILD_ONLY" = 1 ]; then
  echo "built $SHORT for $TARGET in $OUT; nothing uploaded (--build-only)"
  exit 0
fi

PREVIOUS="$(vercel inspect "$HOST" --scope "$SCOPE" 2>&1 | grep -m1 -oE 'https://[a-z0-9-]+\.vercel\.app' || true)"

# Vercel's file upload sometimes fails with a TLS "bad record mac"; the prebuilt output is reusable, so retry.
URL=""
attempt=1
while [ "$attempt" -le "$DEPLOY_ATTEMPTS" ]; do
  # Vercel prints the URL before the deployment is ready, so only a zero exit counts.
  if vercel deploy --prebuilt --yes $PROD_FLAG $RUNTIME_ENV_ARGS --scope "$SCOPE" >"$LOGS/deploy.log" 2>&1; then
    URL="$(grep -m1 -oE "https://confnote-web-[a-z0-9]+-$SCOPE\.vercel\.app" "$LOGS/deploy.log" || true)"
    [ -n "$URL" ] && break
  fi
  echo "deploy attempt $attempt failed: $(grep -m1 -oE 'Error:.{0,90}' "$LOGS/deploy.log" || echo 'no URL in the log')" >&2
  attempt=$((attempt + 1))
done
[ -n "$URL" ] || { echo "deploy failed $DEPLOY_ATTEMPTS times: $LOGS/deploy.log" >&2; exit 1; }
echo "deployed $URL"

if [ "$TARGET" = staging ]; then
  vercel alias set "${URL#https://}" "$HOST" --scope "$SCOPE" >"$LOGS/alias.log" 2>&1 \
    || { echo "alias failed: $LOGS/alias.log" >&2; exit 1; }
  ROLLBACK="vercel alias set ${PREVIOUS#https://} $HOST --scope $SCOPE"
else
  # A --prod deploy takes the production domains itself.
  ROLLBACK="vercel rollback ${PREVIOUS#https://} --scope $SCOPE"
fi

# Smoke: the host serves this commit, the pages and module manifests load, the function answers.
live=""
attempt=1
while [ "$attempt" -le "$SMOKE_ATTEMPTS" ]; do
  live="$(curl -fsS -m 15 "https://$HOST/release.json" 2>/dev/null \
    | python3 -I -c 'import json, sys; print(json.load(sys.stdin).get("commit", ""))' 2>/dev/null || true)"
  [ "$live" = "$COMMIT" ] && break
  sleep "$SMOKE_INTERVAL_SECONDS"
  attempt=$((attempt + 1))
done
failed=0
if [ "$live" != "$COMMIT" ]; then
  echo "smoke: $HOST serves '${live:-nothing}', not $COMMIT" >&2
  failed=1
fi
SMOKE_PATHS="/ /catalogue/ /download /demo /media/versions.json /modules/aggrid/manifest.json /modules/bryntum/manifest.json /modules/tldraw/manifest.json /llms.txt"
for path in $SMOKE_PATHS; do
  code="$(curl -s -o /dev/null -m 20 -w '%{http_code}' "https://$HOST$path" || true)"
  echo "smoke: $code $path"
  [ "$code" = 200 ] || failed=1
done

if [ -n "$PREVIOUS" ]; then
  echo "rollback: $ROLLBACK"
else
  echo "rollback: vercel inspect $HOST found no previous deployment; pick one with: vercel ls $PROJECT --scope $SCOPE" >&2
fi
if [ "$failed" != 0 ]; then
  echo "smoke failed on $HOST; check it, then roll back with the line above" >&2
  exit 1
fi
echo "$TARGET serves $SHORT. Next: WEB_BASE_URL=https://$HOST make e2e-web"
