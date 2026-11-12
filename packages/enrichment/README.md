# Evidence-first events enrichment

Generic Python pipeline consuming `packages/events-model`, independent of app shells, auth and billing. Catalogue output is `events.catalogue.v2`; `dist/index.json` is the shared web/Mac/Cat input.

## Run locally

Install the exact dependencies in `pyproject.toml` into the project environment. Supply a saved GeoNames admin1CodesASCII mirror file; it is deliberately not fetched during lookup.

```sh
export PYTHONPATH=packages/enrichment:packages/events-model/python
packages/local-app/.venv/bin/python -m pytest packages/enrichment/tests
packages/local-app/.venv/bin/python -m enrichment first-wave \
  --work /path/to/private-run --repo /path/to/local-events-data \
  --admin1 /path/to/admin1CodesASCII.txt --batch-size 25
packages/local-app/.venv/bin/python -m enrichment submit https://example.org/event --queue /path/to/private-run
packages/local-app/.venv/bin/python -m enrichment review-submission submission_0123456789abcdef01234567 --queue /path/to/private-run
```

`first-wave` processes **every candidate** from Claude Community, Codex Community and Hugging Face London public Luma iCal subscriptions; every MIT confs.tech topic file for 2026 and 2027 (listed through the GitHub contents API at run time, one conference listed under several topics becomes one event with every topic); the Linux Foundation events feed (one request); and Devpost's upcoming hackathons (paged from its first page). The Linux Foundation and Devpost imports keep facts and links only. developers.events and dev.events are discovery-only by licence and are not imported. The python.org Python Events Google Calendar is not imported: it redirects to calendar.google.com, whose robots.txt disallows it, so the fetcher fails closed. Batch size controls model request size, never total coverage. Extraction and independent review run in batches; failures get one further review attempt, then an explicit hold. Partial output cannot label missing records reviewed. A run exits 2 if fewer than ten records publish. The pretalx adapter is fixture-tested separately; expanding the source registry remains explicit.

The runners use existing local Claude and Codex CLI sign-ins. No auth file is read by the pipeline. Claude tools/plugins/MCP are disabled. Codex runs in an empty temporary directory, read-only, without user configuration, shell or web; emitted tool calls reject review. Both receive public source data via stdin, never as shell code. Each call has a ten-minute timeout. Private run files retain exact batch inputs, extraction, review, retries, and errors.

## Evidence and publication

1. Fetch only credential-free public HTTP(S), pin validated DNS at connection time, ignore environment proxies, honor robots on every origin/redirect and throttle at least two seconds (or longer crawl delay). Robots failures fail closed. Sources have an 8 MiB limit.
2. Save immutable source bytes represented by text/encoding, SHA-256 and fetch time. iCal physical line folding is preserved for verbatim quotes.
3. Deterministic adapters copy structured core fields. Their provenance remains `extractor.agent=deterministic-importer`; it is not falsely relabelled as model extraction. Claude checks every candidate and interprets location only from that event's source context and supplied offline gazetteer rows.
4. Codex independently reviews every prepared event, including structured facts. A passing record receives `review.agent=codex, verdict=agree`. Required name/date contradictions hold the event. Rejected optional geography is removed together; an incomplete location does not hold otherwise supported facts.
5. Validate schema, dates, quote membership, source/hash identity. Check event/application destinations through the same guarded fetcher. Unavailable optional links are omitted and the failure saved in `optional-omissions/`; required facts remain publishable. Per-run `links.json` caches those results.
6. Publish checked and independently reviewed records into a **local git repository** only. No remote or push. Layout: `events/<year>/`, schema/taxonomy, generated dist, and reserved entity directories for series/sessions/people/orgs/venues.

Exports include JSON index, NDJSON, applications JSON, RFC 5545 iCal and llms.txt. Source attribution/licence notices and the GeoNames source manifest accompany the dist directory. Date-only end is inclusive internally and exclusive in iCal. Dist validates the whole catalogue and uses stable ordering. Stale/held IDs are withdrawn.

## Geography

`gazetteer.py` uses the pinned `geonamescache==3.0.2` mirror's real cities1000 and countryInfo-derived countries, plus supplied GeoNames admin1 names. City records include alternate names, ISO countries, IANA zones and admin codes. Lookup is entirely offline. Candidate suggestions retain ambiguous names; population ranks alternatives but never establishes a fact. Claude selects a source-supported row and Codex independently checks the interpretation. Country-only and region-only results are retained as such: Shiga prefecture is a region, Jamaica may be a country; neither is falsely called a city. Online events omit physical geography. Unknown timezone stays null and UTC instants stay unchanged.

GeoNames is attributed under CC-BY-4.0 in data `ATTRIBUTION.md`; package software is MIT. `taxonomy/geonames-sources.json` records mirror URLs, version, counts and exact data hashes. Mirrors can lag current boundaries. Official download.geonames.org robots disallows automated fetching; the recorded run uses permitted package acquisition and an accessible admin1 mirror instead. No robots bypass occurs. The small legacy `geography.py` table remains for standalone adapters and submission tests; complete first-wave publication replaces those suggestions with the real gazetteer/model result.

## Assumptions and repeat runs

- Configured category/format/program/topic facets are registry metadata, explicitly identified in prompts. They do not claim source extraction.
- Status preserves cancellation/postponement; otherwise an injectable timezone-aware clock marks past end completed and future end scheduled (including TENTATIVE). Date-only end expires at local midnight after the last day, UTC if unknown.
- Luma registration approval/status are unknown. confs.tech only explicit CFP URLs become application entries, never inferred registration links.
- Published facts and short evidence quotes retain upstream notices; no full descriptions, bios, guest lists or attendee data publish. Full snapshots/model audit remain private.
- `--replay` reuses saved real source snapshots. Batch results reuse only when all source/candidate bytes have the same signature. Use a new work folder after changing prompt/gazetteer code; no old bounded-review budget exists.
- Single writer per run/data repo. URL submissions remain explicitly queued/reviewed; Partiful/Eventbrite/Meetup/Tech Week are link-only. No public submission endpoint, scheduler or API billing is configured.
