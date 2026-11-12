# Bundled and refreshed catalogue

Distribution builds supply `CONFNOTE_CATALOGUE_DIR=/path/to/events-data/dist`
to `build-macos.sh`. The reviewed `index.json` is copied into the application
bundle. Cat builds accept the same variable and embed the same index. Users do
not need an environment variable or an account to browse that build's snapshot.
The Upcoming view displays the snapshot's update date and filters by event-local
dates. Opening the view only reads local data.

The optional `CONFNOTE_CATALOGUE_URL` is unset by default. Once a public data
endpoint exists, configure that one HTTPS URL. The Mac process checks it at
startup and once daily, sends `If-None-Match`, handles 304 without changing the
catalogue date, and atomically caches valid data under the channel's
`Library/Application Support/confnote/<channel>/catalogue/` folder. Bad responses
leave the last good cache/snapshot in place. The explicit Refresh catalogue
button forces a check. No credentials or accounts are involved.

For development, `CONFNOTE_CATALOGUE_DIR` overrides the bundled snapshot at
runtime. Tests can isolate the cache with `CONFNOTE_CATALOGUE_CACHE_DIR`.

Cat has no network capability: its host may refresh `catalogue/index.json` in
the granted project folder. That refreshed file overrides the embedded snapshot.
Add `catalogue_updated_at` (ISO timestamp) to the refreshed envelope so the view
can show its age. A future host-level background refresh should use the same
single source URL and ETag rules; this repository does not modify the Cat host
or expand its network grant.
