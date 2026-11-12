/** One transport-neutral HTTP contract, exercised against local, web and Cat. */
export type HttpCall = (path: string, init?: RequestInit) => Promise<Response>;

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export async function runHttpConformance(call: HttpCall, agenda: unknown): Promise<void> {
  async function request(path: string, method = "GET", body?: unknown): Promise<{ status: number; body: any }> {
    const response = await call(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  const imported = await request("/api/conferences", "POST", { agenda });
  check(imported.status === 201 && imported.body.ok, `import: ${JSON.stringify(imported)}`);
  const slug = imported.body.slug;
  const listed = await request("/api/conferences");
  check(listed.status === 200 && listed.body.some((item: any) => item.slug === slug), "imported conference missing from list");
  const conference = await request(`/api/conference?slug=${slug}`);
  check(conference.status === 200 && conference.body.events.length > 0, "conference payload missing");
  const file = conference.body.events.find((event: any) => event.note)?.note;
  check(file, "notable session lacks note filename");
  const url = `/api/note?slug=${slug}&file=${file}`;
  const original = await request(url);
  check(original.status === 200 && Number.isFinite(original.body.mtime), "note missing numeric revision");
  check(typeof original.body.sections["Human notes"] === "string", "canonical sections missing");
  const saved = await request(url, "PUT", { mtime: original.body.mtime, sections: { "Human notes": "Shared contract saved text.", Brief: "must remain read-only" } });
  check(saved.status === 200 && saved.body.ok, `note save: ${JSON.stringify(saved)}`);
  const current = await request(url);
  check(current.body.sections["Human notes"] === "Shared contract saved text.", "save did not persist");
  check(current.body.sections.Brief === original.body.sections.Brief, "read-only Brief was overwritten");
  const stale = await request(url, "PUT", { mtime: original.body.mtime, sections: { "Human notes": "stale edit" } });
  check(stale.status === 409 && stale.body.conflict === true, `stale write: ${JSON.stringify(stale)}`);
  check(stale.body.note.sections["Human notes"] === "Shared contract saved text.", "conflict lacks latest note");
  check((await request(url)).body.sections["Human notes"] === "Shared contract saved text.", "stale write mutated note");
  const revision = (await request(url)).body.mtime;
  const writes = await Promise.all([
    request(url, "PUT", { mtime: revision, sections: { "Human notes": "Concurrent first" } }),
    request(url, "PUT", { mtime: revision, sections: { "Human notes": "Concurrent second" } }),
  ]);
  check(writes.map((result) => result.status).sort().join(",") === "200,409", "concurrent writes require one winner and one conflict");
  const actions = await request(`/api/actions?slug=${slug}`);
  check(actions.status === 200 && Array.isArray(actions.body.sessions) && Number.isFinite(actions.body.open), "actions payload shape differs");
  const docs = await request(`/api/conf-doc?slug=${slug}`);
  check(docs.status === 200 && typeof docs.body.brief === "string" && typeof docs.body.debrief === "string", "conference documents differ");
  const validation = await request("/api/conference/validate", "POST", { agenda });
  check(validation.status === 200 && Array.isArray(validation.body.errors) && validation.body.errors.length === 0, "validation rejected shared fixture");
  // Picks: "attending" in the note's frontmatter, the same shape on every target.
  const noPicks = await request(`/api/picks?slug=${slug}`);
  check(noPicks.status === 200 && Array.isArray(noPicks.body.notes) && !noPicks.body.notes.length, `picks: ${JSON.stringify(noPicks)}`);
  const picked = await request(`/api/picks?slug=${slug}`, "PUT", { picks: { [file]: true } });
  check(picked.status === 200 && picked.body.notes.join() === file, `pick: ${JSON.stringify(picked)}`);
  const pickedEvent = (await request(`/api/conference?slug=${slug}`)).body.events.find((event: any) => event.note === file);
  check(pickedEvent?.attending === true, "conference payload must carry attending");
  check((await request(url)).body.frontmatter.attending === "true", "pick must live in the note frontmatter");
  check((await request(url)).body.sections["Human notes"].startsWith("Concurrent"), "a pick must not touch note sections");
  const badPick = await request(`/api/picks?slug=${slug}`, "PUT", { picks: { "../agenda.json": true } });
  check(badPick.status === 400, "unknown pick file must return 400");
  const unpicked = await request(`/api/picks?slug=${slug}`, "PUT", { picks: { [file]: false } });
  check(unpicked.status === 200 && !unpicked.body.notes.length, "unpick");
  check((await request("/api/picks?slug=2026-01-01-missing")).status === 404, "missing conference picks must return 404");
  const missing = await request("/api/note?slug=2026-01-01-missing&file=0900-missing.md");
  check(missing.status === 404, "missing note must return 404");
  const traversal = await request(`/api/note?slug=${slug}&file=..%2Fagenda.json`);
  check(traversal.status === 404, "note traversal must return 404");
  const traversalWrite = await request(`/api/note?slug=${slug}&file=..%2Fagenda.json`, "PUT", { sections: {} });
  check(traversalWrite.status === 404, "note write traversal must return 404");
}
