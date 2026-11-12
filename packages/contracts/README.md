# confnote contracts

Language-neutral fixtures and schemas shared by the local Python app and the
Vercel Functions target.

The contracts ring is intentionally plain files only:

- `api/` holds JSON Schema for the REST boundary.
- `fixtures/` holds golden markdown cases for section parsing and merging.
- `prompts/` holds prompt text that runtime-specific agent harnesses will load.
- `tools.json` is the one Concierge tool set (`confnote.tools.v2`): each tool's name,
  purpose, parameters (JSON Schema) and result shape, plus the per-host `not_on`,
  `native` and `conditional` entries with their reasons. Both hosts build their
  model-facing tools from it: `packages/local-app/concierge_tools.py` (Claude and
  ChatGPT on the Mac) and `packages/web-app/lib/concierge-tools.ts` (hosted). The
  parity tests (`tests/test_tool_contract.py`,
  `packages/web-app/test/tool-contract.test.ts`) fail when a host drifts from it.
- `http/` holds the three-target HTTP conformance suite (`make contracts`); see its README.

Local Python tests and web Vitest tests both read `fixtures/` today so the two
backends cannot drift silently on markdown parsing; both read `tools.json` for the
Concierge's tools. `prompts/` is still the alignment target for a later harness
refactor: the runtimes define their operative system prompts in code.
