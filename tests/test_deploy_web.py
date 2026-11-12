"""Exercise scripts/deploy-web.sh against fake vercel/npm/curl: no network, no Vercel, no keychain."""

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/deploy-web.sh"
DEPLOY_URL = "https://confnote-web-new123-atlascodes.vercel.app"
PREVIOUS_URL = "https://confnote-web-old456-atlascodes.vercel.app"

# Each fake appends its argv to $CALLS. `vercel build` lays out what the real build output must hold.
FAKES = {
    "vercel": r"""
echo "vercel $*" >> "$CALLS"
case "$1" in
  link) mkdir -p .vercel && echo '{"settings":{}}' > .vercel/project.json ;;
  pull) echo '{"settings":{"rootDirectory":"."}}' > .vercel/project.json
        echo "SECRET=x" > ".vercel/.env.$(echo "$3" | sed 's/--environment=//').local" ;;
  build)
    echo "tldraw=${CONFNOTE_TLDRAW:-} demo=${CONFNOTE_PUBLIC_DEMO:-} key=${CONFNOTE_BRYNTUM_LICENSE_KEY:+set} bryntum=${CONFNOTE_BRYNTUM:-}" >> "$CALLS"
    f=.vercel/output/functions/api/index.func
    mkdir -p "$f/packages/web-app/catalogue-data" "$f/packages/auth/migrations" .vercel/output/static/modules
    cp "$CONFNOTE_CATALOGUE_DIR/index.json" "$f/packages/web-app/catalogue-data/"
    cp packages/auth/migrations/*.sql "$f/packages/auth/migrations/"
    if [ "${CONFNOTE_TLDRAW:-}" = 1 ]; then
      mkdir -p .vercel/output/static/modules/tldraw && echo '{}' > .vercel/output/static/modules/tldraw/manifest.json
    fi
    if [ -z "${FAKE_NO_MEDIA:-}" ]; then
      mkdir -p .vercel/output/static/media && cp "$CONFNOTE_DEMO_MEDIA_DIR/versions.json" .vercel/output/static/media/
    fi
    echo "<script>window.confnote.publicDemo = ${FAKE_PUBLIC_DEMO:-false};</script>" > .vercel/output/static/index.html
    if [ -z "${FAKE_NO_BRYNTUM:-}" ]; then echo "built bryntum island bundle"; fi ;;
  inspect) printf 'General\n    url\t\t%s\n' "$PREVIOUS_URL" ;;
  deploy)
    n=$(cat "$CALLS.deploys" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$CALLS.deploys"
    if [ "$n" -le "${DEPLOY_FAILS:-0}" ]; then echo "Preview: $DEPLOY_URL"; echo "Error: bad record mac"; exit 1; fi
    echo "Preview: $DEPLOY_URL" ;;
  alias) echo "Success!" ;;
esac
""",
    "npm": 'echo "npm $*" >> "$CALLS"',
    "security": 'echo "keychain-key"',
    "sleep": ":",
    # release.json answers STAGED_RELEASE for staging when set, else what the last build wrote.
    "curl": r"""
echo "curl $*" >> "$CALLS"
case "$*" in
  *-w*) printf 200 ;;
  *staging.confnote.si/release.json*)
    if [ -n "${STAGED_RELEASE:-}" ]; then echo "$STAGED_RELEASE"; else cat .vercel/output/static/release.json; fi ;;
  *release.json*) cat .vercel/output/static/release.json ;;
esac
""",
}


# A pre-commit hook exports GIT_INDEX_FILE and friends; the fixture repo must not inherit them.
CLEAN_ENV = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}


def git(repo, *args):
    return subprocess.run(
        ["git", "-C", str(repo), *args], check=True, capture_output=True, text=True, env=CLEAN_ENV
    ).stdout.strip()


@pytest.fixture
def deploy(tmp_path):
    repo = tmp_path / "repo"
    (repo / "scripts").mkdir(parents=True)
    shutil.copyfile(SCRIPT, repo / "scripts" / SCRIPT.name)
    (repo / "packages/web-app").mkdir(parents=True)
    (repo / "packages/web-app/package.json").write_text("{}\n")
    (repo / "packages/auth/migrations").mkdir(parents=True)
    (repo / "packages/auth/migrations/0001_init.sql").write_text("select 1;\n")
    git(tmp_path, "init", "-q", "-b", "main", str(repo))
    git(repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "add", ".")
    git(repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "init")
    remote = tmp_path / "remote.git"
    git(tmp_path, "init", "-q", "--bare", str(remote))
    git(repo, "remote", "add", "origin", str(remote))

    catalogue = tmp_path / "events-data-dist" / "2026-11-09"
    catalogue.mkdir(parents=True)
    (catalogue / "index.json").write_text(
        json.dumps({"schema_version": "events.catalogue.v2", "events": [{"id": "a"}, {"id": "b"}]})
    )
    media = tmp_path / "site-media"
    media.mkdir()
    (media / "versions.json").write_text('{"latest": "v7", "versions": []}\n')

    binaries = tmp_path / "bin"
    binaries.mkdir()
    for name, text in FAKES.items():
        (binaries / name).write_text("#!/bin/sh\n" + text)
        (binaries / name).chmod(0o755)
    calls = tmp_path / "calls"
    env = {
        **CLEAN_ENV,
        "PATH": f"{binaries}:{os.environ['PATH']}",
        "CALLS": str(calls),
        "DEPLOY_URL": DEPLOY_URL,
        "PREVIOUS_URL": PREVIOUS_URL,
        "CONFNOTE_CATALOGUE_DIR": str(catalogue),
        "CONFNOTE_DEMO_MEDIA_DIR": str(media),
        "CONFNOTE_DEPLOY_LOG_DIR": str(tmp_path / "logs"),
    }
    for name in (
        "CONFNOTE_TLDRAW",
        "CONFNOTE_PUBLIC_DEMO",
        "CONFNOTE_BRYNTUM_LICENSE_KEY",
        "CONFNOTE_BRYNTUM",
    ):
        env.pop(name, None)

    def run(*args, **extra):
        result = subprocess.run(
            ["sh", str(repo / "scripts" / SCRIPT.name), *args],
            text=True,
            capture_output=True,
            cwd=tmp_path,
            env={**env, **extra},
        )
        lines = calls.read_text().splitlines() if calls.exists() else []
        return result, lines

    run.repo = repo
    return run


def vercel_calls(calls):
    return [c.split()[1] for c in calls if c.startswith("vercel ")]


def test_staging_builds_deploys_aliases_and_smokes(deploy):
    result, calls = deploy("staging")
    assert result.returncode == 0, result.stderr
    assert vercel_calls(calls) == ["link", "pull", "build", "inspect", "deploy", "alias"]
    assert "vercel pull --yes --environment=preview --scope atlascodes" in calls
    assert "tldraw=1 demo=0 key=set bryntum=1" in calls
    assert f"vercel alias set {DEPLOY_URL[8:]} staging.confnote.si --scope atlascodes" in calls
    assert not any("--prod" in c for c in calls)
    repo = deploy.repo
    assert not (repo / ".vercel/.env.preview.local").exists()
    project = json.loads((repo / ".vercel/project.json").read_text())
    assert project["settings"]["rootDirectory"] == "packages/web-app"
    release = json.loads((repo / ".vercel/output/static/release.json").read_text())
    assert release["commit"] == git(repo, "rev-parse", "HEAD")
    assert release["target"] == "staging"
    assert release["dirty"] is False
    assert release["catalogue"]["snapshot"] == "2026-11-09"
    assert release["catalogue"]["events"] == 2
    assert release["demo_media"] == "site-media"
    assert release["tldraw"] is True
    assert release["bryntum"] is True
    assert str(repo.parent) not in json.dumps(release)
    assert f"rollback: vercel alias set {PREVIOUS_URL[8:]} staging.confnote.si" in result.stdout


def test_staging_retries_the_upload(deploy):
    result, calls = deploy("staging", DEPLOY_FAILS="2")
    assert result.returncode == 0, result.stderr
    assert vercel_calls(calls).count("deploy") == 3
    assert "deploy attempt 2 failed: Error: bad record mac" in result.stderr


def test_staging_gives_up_after_three_uploads(deploy):
    result, calls = deploy("staging", DEPLOY_FAILS="3")
    assert result.returncode == 1
    assert "deploy failed 3 times" in result.stderr
    assert "alias" not in vercel_calls(calls)


def test_build_only_uploads_nothing(deploy):
    result, calls = deploy("staging", "--build-only")
    assert result.returncode == 0, result.stderr
    assert vercel_calls(calls) == ["link", "pull", "build"]


def test_refuses_a_dirty_tree_unless_staging_allows_it(deploy):
    (deploy.repo / "stray.txt").write_text("x")
    result, calls = deploy("staging")
    assert result.returncode == 1
    assert "stray.txt" in result.stderr
    assert calls == []
    result, _ = deploy("staging", "--allow-dirty", "--build-only")
    assert result.returncode == 0, result.stderr
    release = json.loads((deploy.repo / ".vercel/output/static/release.json").read_text())
    assert release["dirty"] is True


def test_refuses_without_a_catalogue(deploy):
    result, calls = deploy("staging", CONFNOTE_CATALOGUE_DIR="")
    assert result.returncode == 2
    assert "CONFNOTE_CATALOGUE_DIR" in result.stderr
    assert calls == []


@pytest.mark.parametrize(
    ("args", "extra", "message"),
    [
        ((), {}, "needs --yes-production"),
        (("--yes-production", "--allow-dirty"), {}, "never deploys a dirty tree"),
    ],
)
def test_production_refuses_before_touching_anything(deploy, args, extra, message):
    result, calls = deploy("production", *args, **extra)
    assert result.returncode == 2
    assert message in result.stderr
    assert calls == []


def test_production_refuses_an_unpushed_commit(deploy):
    result, calls = deploy("production", "--yes-production")
    assert result.returncode == 1
    assert "not on any remote branch" in result.stderr
    assert vercel_calls(calls) == []


def test_production_refuses_what_staging_does_not_serve(deploy):
    git(deploy.repo, "push", "-q", "origin", "main")
    staged = json.dumps({"commit": "0" * 40})
    result, calls = deploy("production", "--yes-production", STAGED_RELEASE=staged)
    assert result.returncode == 1
    assert "deploy staging first" in result.stderr
    assert vercel_calls(calls) == []


def test_production_refuses_a_commit_staged_from_a_dirty_tree(deploy):
    git(deploy.repo, "push", "-q", "origin", "main")
    staged = json.dumps({"commit": git(deploy.repo, "rev-parse", "HEAD"), "dirty": True})
    result, calls = deploy("production", "--yes-production", STAGED_RELEASE=staged)
    assert result.returncode == 1
    assert "serves 'dirty'" in result.stderr
    assert vercel_calls(calls) == []


def test_production_ships_the_staged_commit(deploy):
    git(deploy.repo, "push", "-q", "origin", "main")
    staged = json.dumps({"commit": git(deploy.repo, "rev-parse", "HEAD"), "dirty": False})
    result, calls = deploy("production", "--yes-production", STAGED_RELEASE=staged)
    assert result.returncode == 0, result.stderr
    assert vercel_calls(calls) == ["link", "pull", "build", "inspect", "deploy"]
    assert "vercel pull --yes --environment=production --scope atlascodes" in calls
    assert "vercel build --yes --prod" in calls
    assert "vercel deploy --prebuilt --yes --prod --scope atlascodes" in calls
    # Production builds Bryntum and tldraw like staging for the hackathon judging (musa, 2026-11-13).
    assert "tldraw=1 demo=0 key=set bryntum=1" in calls
    release = json.loads((deploy.repo / ".vercel/output/static/release.json").read_text())
    assert release["bryntum"] is True
    assert release["tldraw"] is True
    smoked = [c for c in calls if c.startswith("curl ")]
    for path in ("/modules/bryntum/", "/modules/tldraw/", "/media/versions.json", "/demo"):
        assert any(f"confnote.si{path}" in c for c in smoked), path
    assert not (deploy.repo / ".vercel/.env.production.local").exists()
    assert f"rollback: vercel rollback {PREVIOUS_URL[8:]} --scope atlascodes" in result.stdout


def test_production_refuses_a_build_without_bryntum(deploy):
    git(deploy.repo, "push", "-q", "origin", "main")
    staged = json.dumps({"commit": git(deploy.repo, "rev-parse", "HEAD"), "dirty": False})
    result, calls = deploy(
        "production", "--yes-production", STAGED_RELEASE=staged, FAKE_NO_BRYNTUM="1"
    )
    assert result.returncode == 1
    assert "Bryntum bundle did not build" in result.stderr
    assert "deploy" not in vercel_calls(calls)


@pytest.mark.parametrize("target", ["staging", "production"])
def test_refuses_without_the_demo_media(deploy, target):
    # 2026-11-13: deploys without it shipped an empty /demo on both hosts.
    args = ("--yes-production",) if target == "production" else ()
    result, calls = deploy(target, *args, CONFNOTE_DEMO_MEDIA_DIR="")
    assert result.returncode == 2
    assert "CONFNOTE_DEMO_MEDIA_DIR" in result.stderr
    assert calls == []


def test_refuses_a_build_missing_the_demo_media(deploy):
    result, calls = deploy("staging", FAKE_NO_MEDIA="1")
    assert result.returncode == 1
    assert "demo media not in the build" in result.stderr
    assert "deploy" not in vercel_calls(calls)


def test_refuses_a_build_that_baked_the_public_demo_on(deploy):
    # A sensitive CONFNOTE_PUBLIC_DEMO pulls as "" and build-static reads that as demo on (2026-11-12).
    result, calls = deploy("staging", FAKE_PUBLIC_DEMO="true")
    assert result.returncode == 1
    assert "baked publicDemo on" in result.stderr
    assert "deploy" not in vercel_calls(calls)


def test_staging_runtime_env_goes_to_this_deployment_only(deploy):
    result, calls = deploy(
        "staging", CONFNOTE_STAGING_RUNTIME_ENV="CONFNOTE_CONCIERGE_ENGINE=agent-sdk"
    )
    assert result.returncode == 0, result.stderr
    deploys = [c for c in calls if c.startswith("vercel deploy")]
    assert all("--env CONFNOTE_CONCIERGE_ENGINE=agent-sdk" in c for c in deploys)


@pytest.mark.parametrize(
    ("target", "value", "message"),
    [
        ("production", "CONFNOTE_CONCIERGE_ENGINE=agent-sdk", "staging deployments only"),
        ("staging", "x=$(id)", "not KEY=value"),
    ],
)
def test_staging_runtime_env_refusals(deploy, target, value, message):
    args = ("--yes-production",) if target == "production" else ()
    result, calls = deploy(target, *args, CONFNOTE_STAGING_RUNTIME_ENV=value)
    assert result.returncode == 2
    assert message in result.stderr
    assert calls == []
