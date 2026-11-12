import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { createStorage } from "../lib/storage.js";
import { importAgenda } from "../lib/importAgenda.js";
import type { AgendaData } from "../lib/types.js";
import { noteFileForEvent } from "../lib/agenda.js";

test("v2 import and moved re-import preserve the same markdown note", async () => {
  const dir = await mkdtemp(path.join(tmpdir(),"confnote-import-"));
  process.env.CONFNOTE_STORAGE = "fs";
  process.env.CONFNOTE_WEB_DATA_DIR = dir;
  const storage = createStorage();
  const data: AgendaData = {schema_version:"confnote.agenda.v2",conference:{name:"Example",date:"2026-11-01"},events:[{id:"talk",title:"Talk",start:"2026-11-02T09:00:00Z",end:"2026-11-02T10:00:00Z"}]};
  const result = await importAgenda(storage,"migration-test",data);
  const key = `migration-test/${result.slug}/notes/session-talk.md`;
  const note = await storage.readText(key);
  expect(note?.text).toContain("day: 2026-11-02");
  await storage.writeText(key,"Human notes remain\n");
  data.events[0].start = "2026-11-03T11:00:00Z";
  data.events[0].end = "2026-11-03T12:00:00Z";
  expect((await importAgenda(storage,"migration-test",data)).skipped).toBe(1);
  expect((await storage.readText(key))?.text).toBe("Human notes remain\n");
  expect(noteFileForEvent({id:"talk",note_file:"session-talk.md"})).toBe("session-talk.md");
  expect(() => noteFileForEvent({id:"talk",note_file:"../escape.md"})).toThrow();
});

test("imports reject aliasing, duplicate ids, unsafe ids and derive the conference-local day", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "confnote-owned-"));
  process.env.CONFNOTE_STORAGE = "fs";
  process.env.CONFNOTE_WEB_DATA_DIR = dir;
  const storage = createStorage();
  const data: AgendaData = { schema_version: "confnote.agenda.v2", conference: { name: "Ownership", date: "2026-11-01", timezone: "America/Los_Angeles" }, events: [{ id: "talk", title: "Talk", start: "2026-11-02T02:00:00Z", end: "2026-11-02T03:00:00Z" }] };
  const aliased = structuredClone(data); aliased.events[0].note_file = "session-other.md";
  await expect(importAgenda(storage, "ownership", aliased)).rejects.toThrow("belong");
  const duplicate = structuredClone(data); duplicate.events.push({ ...duplicate.events[0], id: "other", note_file: "session-talk.md" }); duplicate.events[0].note_file = "session-talk.md";
  await expect(importAgenda(storage, "ownership", duplicate)).rejects.toThrow("duplicated");
  const unsafe = structuredClone(data); unsafe.events[0].id = "Lunch";
  await expect(importAgenda(storage, "ownership", unsafe)).rejects.toThrow("lowercase");
  const result = await importAgenda(storage, "ownership", data);
  expect((await storage.readText(`ownership/${result.slug}/agenda.json`))?.text).toContain('"day": "2026-11-01"');
  expect((await storage.readText(`ownership/${result.slug}/notes/session-talk.md`))?.text).toContain("day: 2026-11-01");
  expect((await storage.readText(`ownership/${result.slug}/notes/session-talk.md`))?.text).toContain("18:00–19:00 (America/Los_Angeles)");
});
