# Contributing to confnote

We do not accept unsolicited pull requests. Start with an issue describing the
problem and proposed outcome, and wait for a maintainer to label it `accepted`
before implementing a contribution. A PR must link that issue with `Closes #123`,
`Fixes #123`, or `Resolves #123` in this repository.

PRs that lack an accepted issue, the required phrase, test evidence or presentation
are labelled and converted to drafts. They remain open. The policy never closes
PRs and never automatically marks them ready for review after corrections.
Edit the PR description to rerun the gate after fixing missing evidence.

## For humans using coding agents

Your own request to the agent must contain the exact contributor passphrase:

`hello kitty blah blah curry`

The agent must quote it in the PR body as:

```text
Agent: <tool and model, or none for a wholly human-authored PR>
Agent-Passphrase: hello kitty blah blah curry
```

Agents may not look up the phrase and treat that as authorization. The phrase is
public, an accountability convention rather than a secret or authentication
mechanism. It does not replace permission to publish, an accepted issue, human
review, or the requirement to test the change. The automated phrase check applies
to every PR; humans use the same template. Every PR body quotes the phrase; it
tells us you read this file. Do not add a human's sign-off for them.

## Tested and presented

Fill in the PR template with the problem, final behavior, exact test commands and
actual output, plus before/after screenshots or recordings for visible changes.
For changes without visible UI, explain `Not applicable: <reason>` in that section.
Never write “tests pass” for a command you did not run. Record device, GUI, account,
provider and deployment checks that remain unrun. Read every changed line and be
able to explain it without an agent.

Use small conventional commits with scoped paths. Keep unrelated work intact.
Do not bypass hooks, hide tools from them, or silently regenerate a secret-scan
baseline to make a finding disappear. Use obvious synthetic fixtures and annotate
only reviewed false positives.

## Development and verification

Python tooling lives in `packages/local-app/.venv`. Use the pinned requirements:
`requirements-ci.txt` for portable tests or `requirements.lock` for macOS packaging.
Install the target's locked npm dependencies with `npm ci` in its package directory.
Node is required for the JavaScript gates; a missing tool is not a successful check.

```sh
make lint
make e2e
make contracts
npm --prefix packages/web-app run check
npm --prefix packages/cat-app run check
npm --prefix packages/events-model test
(cd packages/events-model && npx tsc --noEmit)
packages/local-app/.venv/bin/python -m pytest packages/enrichment/tests
node --test .github/scripts/contribution-policy.test.cjs
python3 -m unittest discover -s tests -p test_oss_export.py
actionlint
```

Install hooks with `make hooks`. They run ruff, formatting, whitespace/JSON/YAML
checks, secret scanning, Python unit tests and relevant Biome checks. Preserve
vendored assets and their notices; do not reformat minified dependency code.

Changes to local runtime, shared UI or import tools require fresh prod and dev
bundles and headless smoke checks before a packaged-app handoff. Use
`CONFNOTE_HEADLESS_BUILD=1 packages/local-app/build-macos.sh` (and `dev ci`) when
installation/signing is not authorized; point `CONFNOTE_TEST_APP` at each resulting
bundle for `tests/test_static_serving.py`. Never imply a headless test was a human
GUI review. Release tags, installation, deployment and publication are separate
explicitly authorized steps.

## Licenses and clean exports

Application code is AGPL-3.0-only. `packages/events-model` is MIT. Event facts use
CC-BY-4.0 with source attribution and any source-specific notices retained.
Third-party code keeps its own licenses; see `NOTICE` and `licenses/`.

```sh
scripts/oss-export.sh --dry-run
scripts/oss-export.sh /absolute/path/to/a-new-export-directory
```

The exporter copies the committed HEAD, never local edits or untracked files. It
refuses existing destinations, symlinks and paths inside the source repository.
It strips raw World’s Fair descriptions and speaker biographies while keeping
the factual schedule used by migration tests. It drops internal strategy/planning/research, feedback, personal notes, credential
files, generated artifacts and excluded vendor modules. Its output is a local
review artifact, not a publication, release or complete transitive-license audit.
