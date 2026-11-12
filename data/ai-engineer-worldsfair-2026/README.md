# AI Engineer World's Fair 2026 source data

Raw conference data downloaded from the public AI Engineer World's Fair agent
endpoints on 2026-06-28T00:37:28Z.

## Files

| File | Source | Notes |
| --- | --- | --- |
| `llms.md` | `https://www.ai.engineer/worldsfair/2026/llms.md` | Human/agent overview, schedule summary, and endpoint list. `llms.txt` redirects here. |
| `llms-full.md` | `https://www.ai.engineer/worldsfair/2026/llms-full.md` | Full markdown export of sessions and speakers. |
| `sessions.json` | `https://www.ai.engineer/worldsfair/2026/sessions.json` | 560 sessions. Top-level keys include `conference`, `dates`, `location`, `website`, `scheduleVersion`, `totalSessions`, `sessions`. |
| `speakers.json` | `https://www.ai.engineer/worldsfair/2026/speakers.json` | 539 speakers. Top-level keys include `conference`, `dates`, `location`, `website`, `scheduleVersion`, `totalSpeakers`, `speakers`. |
| `calendar.ics` | `https://www.ai.engineer/worldsfair/2026/calendar.ics` | Single all-conference calendar event. |
| `mcp.json` | `https://www.ai.engineer/worldsfair/2026/mcp` | GET metadata for the public MCP endpoint, including tool schemas. Runtime tool calls require JSON-RPC POST. |

Both `sessions.json` and `speakers.json` were validated with
`python3 -m json.tool`.

## ConfNote import path

The source JSON is close to, but not the same as, `confnote.agenda.v1`.
Likely adapter work:

- Build `conference` from the shared top-level metadata plus venue details in
  `llms.md` or `calendar.ics`.
- Normalize session IDs from title/day/time/room, unless the upstream data later
  exposes stable IDs.
- Parse source `time` values like `9:00am-11:00am` into ISO datetimes using the
  `day` label and the conference timezone.
- Convert `room` and `track` values into first-class `rooms` and `tracks`.
- Map session `speakers` to stable speaker IDs derived from `speakers.json`.
- Preserve source links and `scheduleVersion` in `sources`.

## Product thought

This is a strong demo target for ConfNote because the data is public,
developer-friendly, and exactly the kind of schedule an attendee wants to turn
into a personal working notebook.

Practical wedge:

1. Add an import adapter for these endpoints and generate a full ConfNote vault:
   agenda, speaker dossiers, per-session markdown notes, and action sections.
2. Add a lightweight "AI Engineer World's Fair" preset in the web target that
   loads this data without requiring users to paste JSON.
3. Let users sign up for a hosted copy, then personalize it: starred sessions,
   notes, questions to ask speakers, follow-up actions, and post-session
   summaries.
4. Advertise the value as "your private AI-native conference notebook", not a
   replacement for the official schedule.

External/public actions still need explicit approval before posting,
publishing, outreach, or deployment.
