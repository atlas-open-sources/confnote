#!/bin/sh
# Local export only: no network, git push, or repository creation.
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec python3 "${SCRIPT_DIR:?}/oss_export.py" "$@"
