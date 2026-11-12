#!/bin/sh
# Ship HEAD to staging and then the same commit to production, stopping at the first failure.
#
#   scripts/release-both.sh --yes-production    # `make release-both CONFIRM_PRODUCTION=confnote.si`
#
# For a last-minute fix that already passed `make release-check`. Steps, each must pass:
#   1. scripts/deploy-web.sh staging (its own guards and smoke: staging serves HEAD, pages answer)
#   2. staging: the host checks below, then `make e2e-web` against it
#   3. push HEAD to DEPLOY_BRANCH when it is set (production refuses a commit on no remote branch)
#   4. scripts/deploy-web.sh production --yes-production (refuses unless staging serves this clean commit)
#   5. production: the same host checks, then `make e2e-web`
#   6. staging.confnote.si back on the staging (preview) deployment: it is a production domain of the project
#      (as a branch domain it would sit behind Vercel's preview protection), so the production deploy takes it;
#      the staging host must serve the Preview env (staging Router, database, PayPal sandbox), never production.
# Host checks: publicDemo is off, /release.json says tldraw and Bryntum on (the hackathon judging period,
# musa 2026-11-13), and /demo's media answers: /media/versions.json 200, its latest video 206 to a range request.
# A failure prints the rollback line the deploy step printed for that host.
#
# Inputs: what deploy-web.sh needs (CONFNOTE_CATALOGUE_DIR, ...), plus
#   DEPLOY_BRANCH            optional: a deploy branch on origin to push HEAD to before production
#   CONFNOTE_DEPLOY_LOG_DIR  where both deploys write their logs (default .vercel/deploy-logs)
#   CONFNOTE_DEMO_MEDIA_DIR  required (deploy-web.sh refuses without it): the /demo media folder
set -eu
STAGING_HOST="staging.confnote.si"
PRODUCTION_HOST="confnote.si"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ "${1-}" != --yes-production ]; then
  sed -n '2,4p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
fi

SHORT="$(git rev-parse --short HEAD)"
LOGS="${CONFNOTE_DEPLOY_LOG_DIR:-$ROOT/.vercel/deploy-logs}"
mkdir -p "$LOGS"
STAGING_OUT="$LOGS/release-both-staging-$SHORT.txt"
PRODUCTION_OUT="$LOGS/release-both-production-$SHORT.txt"
PYTHON="${PYTHON:-packages/local-app/.venv/bin/python}"

# The rollback line a deploy printed, or a note that there is none yet.
rollback_from() {
  grep -m1 '^rollback:' "$1" 2>/dev/null || echo "rollback: nothing deployed to this host by this run"
}

stop() {
  echo "release-both stopped: $1" >&2
  [ -n "${2-}" ] && rollback_from "$2" >&2
  exit 1
}

# The page the host serves must carry publicDemo = false (the account build, not the read-only demo).
check_not_demo() {
  curl -fsS -m 20 "https://$1/" 2>/dev/null | grep -q 'window.confnote.publicDemo = false'
}

# The modules are built in, and /demo has its video: versions.json and a range of its latest video.
check_host() {
  curl -fsS -m 15 "https://$1/release.json" \
    | python3 -I -c 'import json, sys; d = json.load(sys.stdin); sys.exit(0 if d.get("tldraw") and d.get("bryntum") else 1)' \
    || { echo "$1 release.json does not say tldraw and Bryntum on" >&2; return 1; }
  video="$(curl -fsS -m 15 "https://$1/media/versions.json" \
    | python3 -I -c 'import json, sys; d = json.load(sys.stdin); print(next(v["video"] for v in d["versions"] if v["id"] == d["latest"]))')" \
    || { echo "$1/media/versions.json does not answer with a latest video" >&2; return 1; }
  code="$(curl -s -o /dev/null -m 20 -r 0-1023 -w '%{http_code}' "https://$1$video")"
  [ "$code" = 206 ] || { echo "$1$video answered $code to a range request, not 206" >&2; return 1; }
  echo "checked $1: publicDemo off, tldraw and Bryntum on, $video 206"
}

e2e_web() {
  CONFNOTE_E2E_BASE_URL="https://$1" "$PYTHON" -m pytest -q tests/e2e/test_web_target.py
}

echo "== 1/5 staging: deploying $SHORT"
sh scripts/deploy-web.sh staging 2>&1 | tee "$STAGING_OUT"
# POSIX sh has no pipefail: the deploy's own last line says whether it finished.
grep -q "^staging serves $SHORT\." "$STAGING_OUT" || stop "staging deploy failed (log: $STAGING_OUT)" "$STAGING_OUT"

echo "== 2/5 staging: host checks, e2e-web"
check_not_demo "$STAGING_HOST" || stop "$STAGING_HOST does not serve publicDemo = false" "$STAGING_OUT"
check_host "$STAGING_HOST" || stop "host checks failed on $STAGING_HOST" "$STAGING_OUT"
e2e_web "$STAGING_HOST" || stop "e2e-web failed on $STAGING_HOST" "$STAGING_OUT"

if [ -n "${DEPLOY_BRANCH:-}" ]; then
  echo "== 3/5 pushing $SHORT to origin/$DEPLOY_BRANCH"
  git push origin "HEAD:refs/heads/$DEPLOY_BRANCH" || stop "push to origin/$DEPLOY_BRANCH failed" "$STAGING_OUT"
else
  echo "== 3/5 no DEPLOY_BRANCH; production checks $SHORT is already on a remote branch"
fi

echo "== 4/5 production: deploying $SHORT"
sh scripts/deploy-web.sh production --yes-production 2>&1 | tee "$PRODUCTION_OUT"
grep -q "^production serves $SHORT\." "$PRODUCTION_OUT" \
  || stop "production deploy failed (log: $PRODUCTION_OUT)" "$PRODUCTION_OUT"

echo "== 5/5 production: host checks, e2e-web"
check_not_demo "$PRODUCTION_HOST" || stop "$PRODUCTION_HOST does not serve publicDemo = false" "$PRODUCTION_OUT"
check_host "$PRODUCTION_HOST" || stop "host checks failed on $PRODUCTION_HOST" "$PRODUCTION_OUT"
e2e_web "$PRODUCTION_HOST" || stop "e2e-web failed on $PRODUCTION_HOST" "$PRODUCTION_OUT"

echo "== 6/6 staging.confnote.si back on the staging deployment"
STAGING_URL="$(grep -m1 '^deployed https://' "$STAGING_OUT" | sed 's/^deployed https:\/\///')"
[ -n "$STAGING_URL" ] || stop "no staging deployment URL in $STAGING_OUT" "$PRODUCTION_OUT"
vercel alias set "$STAGING_URL" "$STAGING_HOST" --scope atlascodes \
  || stop "could not alias $STAGING_HOST back to $STAGING_URL" "$PRODUCTION_OUT"
target=""
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  target="$(curl -fsS -m 15 "https://$STAGING_HOST/release.json" 2>/dev/null \
    | python3 -I -c 'import json, sys; print(json.load(sys.stdin).get("target", ""))' 2>/dev/null || true)"
  [ "$target" = staging ] && break
  sleep 5
done
[ "$target" = staging ] || stop "$STAGING_HOST serves target '${target:-nothing}', not the staging build" "$PRODUCTION_OUT"

echo "staging and production serve $SHORT (staging on the Preview env, production on the Production env)."
rollback_from "$STAGING_OUT" | sed 's/^rollback:/rollback staging:/'
rollback_from "$PRODUCTION_OUT" | sed 's/^rollback:/rollback production:/'
