# confnote agenda manifest v1

`confnote.agenda.v1` is the headless conference creation contract.

Every creation surface targets this manifest first:

- manual UI form
- pasted JSON
- pasted text
- URL extraction through the concierge
- agent-created agenda drafts

The importer then validates the manifest and writes the local-first markdown
vault. User notes, research, summaries, actions, transcripts, and chat history
do not live in this file.

## Required shape

```json
{
  "schema_version": "confnote.agenda.v1",
  "conference": {
    "id": "example-conf-2026",
    "name": "Example Conf",
    "date": "2026-09-01",
    "timezone": "Europe/London",
    "url": "https://example.com",
    "description": "A short event description.",
    "organiser": "Example Org",
    "venue": {
      "name": "Main Hall",
      "address": "1 Example Street",
      "city": "London",
      "country": "GB"
    }
  },
  "rooms": [
    { "id": "main-stage", "name": "Main Stage" }
  ],
  "tracks": [
    { "id": "ai-engineering", "name": "AI Engineering" }
  ],
  "speakers": {
    "jane-smith": {
      "name": "Jane Smith",
      "role": "Founder",
      "company": "Example Labs",
      "bio": "Short bio.",
      "url": "https://example.com/jane",
      "social": {}
    }
  },
  "events": [
    {
      "id": "opening-keynote",
      "type": "keynote",
      "title": "Opening Keynote",
      "description": "Welcome and framing.",
      "start": "2026-09-01T09:30:00+01:00",
      "end": "2026-09-01T10:00:00+01:00",
      "room": "main-stage",
      "track": "ai-engineering",
      "speakers": ["jane-smith"],
      "tags": ["keynote"],
      "links": [{ "url": "https://example.com/session", "label": "Session page" }]
    }
  ],
  "sources": [
    {
      "url": "https://example.com/agenda",
      "retrieved_at": "2026-05-26T15:00:00Z"
    }
  ]
}
```

## Rules

- `conference.name`, `conference.date`, `events[].id`, `events[].title`,
  `events[].start`, and `events[].end` are required before import.
- `conference.date` is `YYYY-MM-DD`.
- `events[].start` and `events[].end` are ISO datetimes with offsets whenever
  possible.
- `timezone` is strongly recommended because live status depends on correct
  local event time.
- `rooms` and `tracks` are first-class even when a conference is single-track.
  They support future schedule/grid views without changing note storage.
- `events[].speakers` references keys in `speakers`.
- Existing note files are never overwritten by import or re-import.

## Storage boundary

This manifest describes the conference structure. The markdown vault remains
the source of truth for user-owned and agent-owned content:

- `## Human notes`
- `## Summary`
- `## Research`
- `## AI notes`
- `## Transcript`
- `## Actions`
- `## Links`
- `## Scratchpad`
