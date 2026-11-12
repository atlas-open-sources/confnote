# Three-target HTTP contract

`make contracts` runs the same `runHttpConformance` assertions against the real
Python loopback HTTP server, the web Vercel handler, and the mocked Cat bridge.
Only storage and verified web identity are fixtures; import and note operations
run through each target's real routes and service code. All test vaults are
throwaway directories or in-memory grants.

Shared capabilities: conference import (201), list/detail, note read/write,
read-only section preservation, optimistic revisions (409 with current note),
concurrent same-note writers (one winner), picks (`GET`/`PUT /api/picks`: `attending:
true` in the note frontmatter, `attending` on each conference event, 400 for a file
that is not a session note), and missing/traversal rejection (404).
Target-specific auth, payments, agents and attachment APIs are intentionally not
asserted as equal to the Cat's offline capability set. The Cat returns 501 for
unsupported agent/network capabilities.

Local non-browser mutation clients send a loopback Origin matching Host. Web
clients use the explicitly configured public origin and verified identity.

The TS note lock serializes writes within one process (and the Cat bridge). A
multi-instance hosted storage adapter still needs backend conditional writes or
an equivalent distributed lock before claiming cross-instance linearizability.
