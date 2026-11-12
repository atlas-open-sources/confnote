# confnote docs

## Build, run and ship

| Doc | What it answers |
|---|---|
| [Release flow](release/README.md) | How a commit reaches staging, production and the Mac download; versioning and update proposals |
| [Local delivery](local-delivery.md) | Rebuilding and installing the dev and prod Mac apps (`make app-deliver`) |
| [OSS release readiness](oss-release-readiness.md) | What still blocks a public source and binary release |
| [Rescheduling validation](rescheduling-validation.md) | Evidence for the Concierge's schedule-shift tool |

## Build on it

| Doc | What it answers |
|---|---|
| [Design system](design-system.md) | Tokens, themes, components and which file holds each module's CSS |
| [Writing a module](MODULE.md) | The drawer module contract: manifest, `register()`, optional backend, config |
| [Agenda manifest v1](schema/confnote-agenda-v1.md) | The `confnote.agenda.v1` creation contract ([JSON Schema](schema/confnote-agenda-v1.schema.json)) |
| [Local AI Cat transcription](integration/local-ai-cat-transcription.md) | Not pursued (2026-11-11): what the Cat would have had to allow for hosted transcription from the browser; hosted transcription is now locked (paste only), on-device is the Mac app's |
| [Contracts](../packages/contracts/README.md) | Shared REST schemas, fixtures and the [HTTP conformance suite](../packages/contracts/http/README.md) |

## PayPal AI Hackathon (drafts, nothing submitted)

| Doc | What it is |
|---|---|
| [Devpost entry](hackathon/devpost.md) | Submission text draft |
| [How to judge](hackathon/judging.md) | Judge walkthrough draft |
| [README section](hackathon/README-section.md) | Text for the public README once exported |
| [Clean export checklist](hackathon/oss-export-checklist.md) | Secret scan, what stays out, licence and Router choices |

## Internal (never exported)

[`internal/`](internal/README.md) holds the product backlog, strategy, research and the archive of finished plans.
`scripts/oss_export.py` drops the whole folder.
