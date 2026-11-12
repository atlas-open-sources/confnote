# confnote developer tasks.
# `make lint` is report-only; `make fix` rewrites files in place.

.DEFAULT_GOAL := help
.PHONY: contracts help lint fix test hooks bryntum e2e e2e-web e2e-install test-web tldraw-eval app-prod app-dev app-install app-smoke app-deliver app-dev-then-prod app-release app-publish app-publish-dry-run release-check web-staging web-production release-both
DEV_TAG ?= local
PYTHON ?= packages/local-app/.venv/bin/python

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  %-10s %s\n", $$1, $$2}'

lint: ## Run ruff + ruff-format check + biome check + pytest (report only)
	./scripts/lint.sh check

fix: ## Auto-fix: ruff --fix, ruff format, biome format
	./scripts/lint.sh fix

test: ## Run the unit test suite
	$(PYTHON) -m pytest -q tests/

hooks: ## Install the pre-commit git hook
	packages/local-app/.venv/bin/pre-commit install

e2e-install: bryntum ## One-time: pytest-playwright + chromium binaries + the Bryntum bundle
	$(PYTHON) -m pip install --quiet -r packages/local-app/requirements-ci.txt
	$(PYTHON) -m playwright install chromium

bryntum: ## Build the Planner's Bryntum bundle from Bryntum's public npm trial package (never committed)
	npm ci --ignore-scripts --no-audit --no-fund --prefix packages/core-ui/static/modules/bryntum/build
	npm run build --prefix packages/core-ui/static/modules/bryntum/build

e2e: ## Playwright e2e suite (HEADED=1 for a visible browser)
	@if [ "$$HEADED" = "1" ]; then \
		$(PYTHON) -m pytest -q tests/e2e --headed ; \
	else \
		$(PYTHON) -m pytest -q tests/e2e ; \
	fi

test-web: ## Vercel web target build + typecheck + vitest
	npm --prefix packages/web-app run check

e2e-web: ## Playwright web-target smoke against WEB_BASE_URL (private preview or local vercel dev)
	@if [ -z "$$WEB_BASE_URL" ]; then \
		echo "WEB_BASE_URL is required, e.g. WEB_BASE_URL=https://preview.vercel.app make e2e-web"; \
		exit 2; \
	fi
	CONFNOTE_E2E_BASE_URL="$$WEB_BASE_URL" $(PYTHON) -m pytest -q tests/e2e/test_web_target.py

tldraw-eval: ## Headless eval of the tldraw drawing controls (loads the real island; writes screenshots to tests/e2e/_tldraw_eval/)
	CONFNOTE_REAL_ISLAND=1 $(PYTHON) -m pytest -q \
		tests/e2e/test_tldraw_drawing.py tests/e2e/test_tldraw_bridge.py

app-prod: ## Build/sign/install /Applications/confnote.app
	packages/local-app/build-macos.sh

app-dev: ## Build/sign/install /Applications/confnote dev.app (DEV_TAG=local by default)
	packages/local-app/build-macos.sh dev $(DEV_TAG)

app-install: app-prod app-dev ## Build/sign/install both prod and dev apps

# ':'-separated, because "confnote dev.app" has a space.
APP_SMOKE_BUNDLES ?= packages/local-app/dist/confnote.app:packages/local-app/dist/confnote dev.app
app-smoke: ## Smoke the built bundles headless: codesign, Info.plist, first launch, Playwright UI (no window, no install)
	@set -e; bundles='$(APP_SMOKE_BUNDLES)'; IFS=':'; for app in $$bundles; do \
		case "$$app" in /*) ;; *) app="$$PWD/$$app" ;; esac; \
		[ -d "$$app" ] || { echo "app-smoke: no bundle at $$app; build it first" >&2; exit 1; }; \
		echo "==> $$app"; \
		CONFNOTE_TEST_APP="$$app" $(PYTHON) -m pytest -q tests/test_static_serving.py tests/e2e/test_mac_bundle.py; \
	done

app-deliver: ## Validate, build, smoke-test and install both local channels
	sh scripts/local-delivery.sh

app-dev-then-prod: ## Validate, install dev, pause for UI acceptance, then install prod
	DEV_TAG="$(DEV_TAG)" sh scripts/dev-then-prod.sh

app-release: ## Build/sign/notarize prod app into dist/ (NO_INSTALL=1)
	NOTARIZE=1 NO_INSTALL=1 packages/local-app/build-macos.sh

app-publish: ## Build, notarize, staple, DMG, sha256, deploy the downloads site, check it as a stranger
	python3 scripts/publish_mac.py

app-publish-dry-run: ## Package the existing dist app as a DMG and print what app-publish would deploy
	python3 scripts/publish_mac.py --dry-run
release-check: lint e2e test-web contracts ## Every gate a release candidate passes before staging (docs/release/README.md)

web-staging: ## Deploy HEAD to staging.confnote.si (Vercel preview, prebuilt); needs CONFNOTE_CATALOGUE_DIR
	sh scripts/deploy-web.sh staging

web-production: ## Deploy HEAD to confnote.si; refuses unless CONFIRM_PRODUCTION=confnote.si and staging serves HEAD
	@if [ "$$CONFIRM_PRODUCTION" != "confnote.si" ]; then \
		echo "production deploy needs CONFIRM_PRODUCTION=confnote.si (see docs/release/README.md)"; \
		exit 2; \
	fi
	sh scripts/deploy-web.sh production --yes-production

release-both: ## Last-minute fix: HEAD to staging, its checks, then production; CONFIRM_PRODUCTION=confnote.si, optional DEPLOY_BRANCH
	@if [ "$$CONFIRM_PRODUCTION" != "confnote.si" ]; then \
		echo "release-both deploys production and needs CONFIRM_PRODUCTION=confnote.si (see docs/release/README.md)"; \
		exit 2; \
	fi
	PYTHON="$(PYTHON)" sh scripts/release-both.sh --yes-production

contracts: ## Shared HTTP contracts against Python, web and Cat mock
	npm --prefix packages/web-app test -- --run test/contracts.test.ts
	npm --prefix packages/cat-app test -- --run test/contracts.test.ts
