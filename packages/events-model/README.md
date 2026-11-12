# Events model v2

Generic MIT-licensed event contracts. The JSON Schema (2020-12) is authoritative;
TypeScript and Python validators add ordering, timezone and uniqueness checks.
Catalogue envelope: `{schema_version: "events.catalogue.v2", events: Event[]}`.
Optional series, sessions, people, orgs and venues are independent entity collections.
IDs are safe immutable lowercase slugs. References may point to separately published files.
Date-only ranges use inclusive end dates. Timed ranges use offset ISO timestamps.
Unknown timezone is explicitly null; never infer a timezone from a country.
Taxonomy values, including format, are suggestions. Entities support an open
`extensions` object; `level` and `region` are optional facets.
Empty provenance is permitted for local drafts/migrations; the publisher must require
checked evidence and an independent agreeing review for published facts.

Python: add `python/` to PYTHONPATH, install jsonschema, call validate_event or
validate_catalogue (raises ValueError). TS exports types and validateEvent/validateCatalogue.
Run `npm ci && npm test && npm run typecheck`; Python tests are in the repo suite.

## Vault migration

Quit the app before migrating to avoid concurrent schedule edits. First copy an event directory. Run `PYTHONPATH=packages/events-model/python python3
-m events_model /path/to/copied/event`, or from this package run `npx tsx
src/migrate-cli.ts /path/to/copied/event`. Both add `session_id`, `day`, explicit
`note_file`, and a multi-day conference range. They leave every markdown and asset
byte in place. Repeat runs are idempotent, unsafe paths/duplicate identities fail
before the agenda replacement, and a pre-existing temporary file is refused.
New v2 imports use `session-<id>.md`; re-imports retain the prior mapping even when
times change. Day is metadata rather than part of the path, so moving a session to
another day does not disconnect notes. The World's Fair converter freezes IDs on
first import; matching renamed talks in later source snapshots is separate work.

If a crashed migration leaves `.agenda-v2.tmp`, inspect it against `agenda.json`,
keep a backup, then remove that temporary file before retrying. New v2 note paths
require the updated app; older installed versions cannot read `session-*.md`.
