---
name: conference-operations
description: Handles conference schedule changes, interrupted writes, and completion checks without losing notes. Use when a user reports a delay, asks to adjust an existing agenda, or questions whether research or changes were saved.
---

# Conference operations

## Match the requested outcome

- "Everything is delayed 30 minutes; update the schedule" requests a change
  to agenda start/end times and the live/next display. A Brief notice or note
  annotation does not complete that request.
- Ask only for genuinely missing direction or scope. Once the user confirms
  "all sessions, 30 minutes later", do not ask for that confirmation again.
- Use the current turn's clock and status. Previously stated times, note
  annotations and chat recollections do not override the live agenda.

## Check capabilities before proposing a workaround

- Check the tools actually supplied for this turn. Tool descriptions define
  available capabilities; this skill does not grant filesystem or shell access.
- When `set_schedule_offset` is supplied, use it for an explicitly requested
  whole-conference delay. `offset_minutes` is the absolute delay relative to
  the published agenda; +30 delays every session by 30 minutes, 0 restores the
  published times. "Another 30 minutes" adds to the current offset. Pass the
  current context's `SCHEDULE_OFFSET_MINUTES` as `expected_offset`. Never
  guess it or silently retry a conflict. The tool preserves existing notes.
- If no schedule-edit tool is supplied, state that limitation once and name
  the unmet outcome: the live schedule
  still uses the original times. Do not describe it as a harmless bookkeeping
  nuisance or claim the requested adjustment is complete.
- Never recommend recreating a conference, duplicating it, overwriting research,
  or repeating completed research to work around a missing schedule-edit tool.
- `add_conference` is an import tool, not a supported rescheduling operation.
  Do not assume it always creates a new slug or necessarily deletes notes.
- Every rescheduling operation must preserve note identity, attachments,
  research, human notes and links. Current note paths include the event's
  original start time; changing timestamps alone can disconnect existing notes.
- Offer an annotation only as an explicitly identified partial alternative.
  If the user already asked to fix the schedule, report the missing capability
  rather than repeatedly asking them to approve a different outcome.

## Recover interrupted writes

1. An interrupted tool result means the outcome is unknown. It does not prove
   that the write failed or that the server is down.
2. Read back the exact affected note or document before retrying. Checking one
   note does not establish what happened to other writes.
3. Retry only missing or incomplete changes, preserving existing content.
   After two consecutive attempts with no progress, stop retrying and report
   the affected files and unresolved results.
4. Completed research and persisted research are separate milestones. Verify
   each expected dossier and the Brief before claiming all work is saved.
   Read full notes when the digest omits Research.

## Completion evidence

- State what changed, where, what was read back, and what remains unchanged
  that matters to the user's request. Do not substitute a successful tool call
  for evidence that the requested screen or schedule changed.
- For a schedule change, verify agenda times, existing note associations and
  the live/next display. For research, verify the relevant Research sections.
- Distinguish source edits, tests, built bundles, installed bundles and live
  acceptance. Updating this skill does not update an already running app.
