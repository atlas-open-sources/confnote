# Local dev and prod delivery

Use this procedure to update the installed macOS apps after changing the local
backend, shared UI or tools. The repository entry point is `make app-deliver`,
which runs [`scripts/local-delivery.sh`](../scripts/local-delivery.sh).
The whole release flow (web staging and production, the notarized download, the
catalogue and the Cat) is in [`docs/release/`](release/README.md).

## Run

From the repository root (the directory containing `Makefile`):

```sh
make app-deliver
```

The default dev tag is `local`. To use a different dev identity:

```sh
make app-deliver DEV_TAG=schedule-check
```

Run this in a terminal or agent execution environment with the host access
listed below. Existing authorization to deliver locally does not change a
restricted agent session's filesystem, network or Keychain permissions.

## Dev first, then prod

```sh
make app-dev-then-prod
```

[`scripts/dev-then-prod.sh`](../scripts/dev-then-prod.sh) runs the automated
checks, builds/installs dev, HTTP-verifies it and opens it. Test the UI, save
work, then type `prod` at the prompt to build/install, HTTP-verify and open prod.
Any other response or end-of-input stops after dev. A failing check or dev
build prevents production delivery. There is no unattended acceptance flag.
This script uses the existing per-channel installers; save work before starting
because those installers terminate their channel's running app. It does not
change the conference schedule or publish anything.

## Prerequisites

- macOS with the project's Python virtualenv and Node/npm dependencies available.
- Ability to bind and connect to localhost: tests and candidate HTTP smoke checks
  start temporary servers. Fixtures use temporary vaults rather than real notes.
- Network access for uncached npm/Python dependencies used by lint and packaging.
- The Developer ID certificate **and its private key** available to `codesign`.
  `security find-identity -v -p codesigning` must show the configured identity.
  An empty result in an agent sandbox does not prove the certificate is absent
  from the normal host session. Do not substitute ad-hoc signing for delivery.
- Write access to `/Applications`, and permission to stop the exact installed
  confnote processes. Save current work before running the installer.
- Read/write access to the app's selected vault for subsequent product testing.
  The default is `~/Documents/confnote`; dev and prod can select different vaults.

## What the script does

1. Runs lint/format checks, unit tests, the browser suite and web checks.
2. Builds signed prod and dev candidates with installation disabled.
3. Runs `make app-smoke` on both candidates: codesign, Info.plist, first launch
   without a GUI, HTTP/static serving and a Playwright UI smoke.
4. Stops each exact installed bundle, waits for it to exit, then installs its
   candidate into `/Applications` and repeats HTTP verification.

Validation and both candidate smoke checks precede replacement of installed
apps. Installation is sequential; it is not an atomic two-app transaction.
The script stops on failures. Its final success line is:

```text
Installed and HTTP-verified: /Applications/confnote.app and /Applications/confnote dev.app
```

That line proves local installation and HTTP verification. It does not prove
native UI acceptance, OAuth account access, notarization or public distribution.

## Existing commands and scope

| Command | Purpose |
| --- | --- |
| `packages/local-app/run.sh` | Run source on localhost; not an installed-app update |
| `make app-prod` | Build, sign and install prod only |
| `make app-dev` | Build, sign and install dev only |
| `make app-install` | Build and install both; does not run the full delivery gates |
| `make app-dev-then-prod` | Validated dev delivery, manual UI checkpoint, then prod |
| `make app-deliver` | Preferred validated local delivery for both channels |
| `make app-release` | Build/sign/notarize prod with installation disabled; not public publishing |

## If delivery stops

- npm `ENOTFOUND`: the execution environment cannot resolve the registry. Restore
  dependency network access or use an environment with the required dependencies
  cached. Do not mark lint complete merely because a download failed.
- Localhost `PermissionError: Operation not permitted`: the environment denies
  socket binding. Use a host execution environment that permits local servers;
  do not skip HTTP/browser tests to force installation.
- No signing identity: check certificate/private-key visibility in the host
  session. Do not replace the signed installed apps with an ad-hoc candidate.
- `/Applications` permission denied: run the delivery command in an environment
  authorized to update those installed bundles.
- App still running: the script leaves that bundle in place. Save work, quit the
  identified app normally and rerun.

`AGENTS.md` and `CLAUDE.md` describe authorization and workflow; they cannot grant
sandbox or operating-system access. Failed delivery must be reported as pending,
not installed.

## Schedule UI acceptance after delivery

The agenda is JSON in the selected notes vault; session content is Markdown.
Installing an app updates its behavior, not the conference's published times.
Use the supported Schedule control or concierge operation rather than changing
original event timestamps, which participate in existing note filenames.

In a disposable test conference, open a session and apply +30, 0, +30, 0.
Verify the timeline, session header and live status update without reloading,
and that existing notes, research, attachments and the open editor are preserved.
Change the schedule from another client and confirm it refreshes within five
seconds. Then apply the user's intended offset to the real conference once.
See [rescheduling validation](rescheduling-validation.md) for the current evidence
and remaining acceptance work.
