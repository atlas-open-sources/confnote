# Schedule adjustment validation

status: implemented; offline-tested; live UI and local delivery blocked

The local concierge (Claude and ChatGPT) can set an absolute whole-conference
schedule offset. The Schedule button applies the same operation. The sidebar
and open session metadata update immediately after a successful UI or concierge
change; independent changes are polled every five seconds. Updating the sidebar
does not remount the note editor. Original agenda timestamps, note filenames,
research, human notes and attachments remain associated.

Offsets are relative to the published agenda: +30 delays the day, 0 restores it.
The endpoint checks origin, request marker, expected offset and an optional
revision. Conflicts require rereading; repeated absolute +30 requests do not
compound the delay.

## Evidence on 2026-10-03

- 206 offline tests passed, including forward/restore cycles, stale revision
  conflicts, note saves while shifted, immutable attachments and a ChatGPT
  numeric tool roundtrip. Receipt: `/tmp/confnote-reschedule-offline.log`.
- Ruff checks and formatting pass; JavaScript syntax check passes. Biome reports
  warnings, with no errors.
- Full `make e2e` attempted: localhost socket binding is denied by the current
  execution sandbox. Receipt: `/tmp/confnote-reschedule-e2e.log`.
- The browser regression in `tests/e2e/test_reschedule.py` drives +30/0 twice,
  checks the open editor's identity and metadata, then changes the schedule via
  the endpoint and waits for automatic refresh. It has not executed successfully.
- The current installed applications have not received these changes. This
  session cannot replace `/Applications` bundles; Developer ID signing is also
  unavailable. The earlier build receipt is
  `/tmp/confnote-guidance-prod-build.log`; that candidate predates rescheduling.
- The real Berkeley agenda remains at offset 0. No real conference was recreated
  or shifted during these tests.

## Remaining acceptance

In a session with localhost, signing and installation access, run
`make app-deliver` to perform the repository's tests and both-channel delivery.
Then drive the installed app's Schedule control through +30, 0, +30, 0 while a
session editor is open. Confirm timeline times, live marker/status, header,
notes and research. Repeat an independent change to verify the five-second
refresh. Only after acceptance, leave the actual Berkeley conference at +30.
No paid inference or live OAuth acceptance has been established by these tests.
