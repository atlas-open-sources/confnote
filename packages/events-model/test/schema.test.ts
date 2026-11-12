import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { validateCatalogue, validateEvent } from "../src/index.js";
const fixture = JSON.parse(readFileSync(new URL("../fixtures/catalogue.json", import.meta.url),"utf8"));
test("catalogue validates and rejects unsafe IDs, reversed dates and duplicate entities", () => {
  validateCatalogue(fixture);
  assert.throws(() => validateEvent({...fixture.events[0],id:"../escape"}));
  assert.throws(() => validateEvent({...fixture.events[0],end:"2026-10-01"}));
  assert.throws(() => validateEvent({...fixture.events[0],timezone:"Nowhere/City"}));
  assert.throws(() => validateCatalogue({...fixture,events:[...fixture.events,...fixture.events]}));
  assert.throws(() => validateEvent({...fixture.events[0],start:"2026-02-30"}));
});

test("extension namespace and session day use event timezone", () => {
  const data = structuredClone(fixture);
  Object.assign(data.events[0], {timezone:"America/Los_Angeles", format:"concert", level:"advanced", region:"west", extensions:{future:true}});
  data.sessions = [{id:"evening",kind:"session",title:"Evening",event:data.events[0].id,start:"2026-11-02T01:00:00Z",end:"2026-11-02T02:00:00Z",day:"2026-11-01"}];
  validateCatalogue(data);
  data.sessions![0].day = "2026-11-02";
  assert.throws(() => validateCatalogue(data), /day/);
});
