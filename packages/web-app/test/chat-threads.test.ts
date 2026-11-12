import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { databaseAdapter } from "../lib/auth-runtime.js";
import { PostgresChatThreads, type ChatOwner } from "../lib/chat-threads.js";
import { applyMigrations } from "../lib/database.js";

const adminUrl = process.env.CONFNOTE_TEST_DATABASE_URL;

// Each run makes its own database on the test server and drops it afterwards.
async function withStore(run: (store: PostgresChatThreads, owners: { alice: ChatOwner; bob: ChatOwner; aliceTeam: ChatOwner }) => Promise<void>): Promise<void> {
  const admin = postgres(adminUrl || "", { max: 1, onnotice: () => {} });
  const name = `confnote_chat_${randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = new URL(adminUrl || ""); url.pathname = `/${name}`;
  const sql = postgres(url.toString(), { max: 3, onnotice: () => {} });
  try {
    await applyMigrations(sql);
    const alice = randomUUID(); const bob = randomUUID(); const team = randomUUID();
    await sql`insert into confnote_users (id, email) values (${alice}, 'alice@example.test'), (${bob}, 'bob@example.test')`;
    await sql`insert into confnote_workspaces (id, name, owner_id) values (${alice}, 'Alice', ${alice}), (${bob}, 'Bob', ${bob}), (${team}, 'Team', ${alice})`;
    await run(new PostgresChatThreads(databaseAdapter(sql)), {
      alice: { workspaceId: alice, userId: alice },
      bob: { workspaceId: bob, userId: bob },
      aliceTeam: { workspaceId: team, userId: alice },
    });
  } finally {
    await sql.end();
    await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end();
  }
}

describe.skipIf(!adminUrl)("PostgresChatThreads", () => {
  it("keeps one active thread, archives it on + new and resumes an archived one (Mac contract)", async () => {
    await withStore(async (store, { alice }) => {
      expect(await store.list(alice)).toEqual({ active: null, archived: [] });
      expect(await store.archive(alice)).toBeNull();

      await store.append(alice, "user", "What is on day two?\nMore detail", "conf-a");
      await store.append(alice, "assistant", "Talks on agents.", "conf-a");
      await store.append(alice, "user", "   ", "conf-a");
      const history = await store.history(alice);
      expect(history.map(({ role, text, scope }) => ({ role, text, scope }))).toEqual([
        { role: "user", text: "What is on day two?\nMore detail", scope: "conf-a" },
        { role: "assistant", text: "Talks on agents.", scope: "conf-a" },
      ]);
      expect(history[0].ts).toMatch(/^\d{4}-\d\d-\d\dT/);
      expect((await store.history(alice, 1)).map((turn) => turn.text)).toEqual(["Talks on agents."]);

      const first = (await store.list(alice)).active;
      expect(first).toMatchObject({ title: "What is on day two?", turns: 2, scope: "conf-a" });

      const archived = await store.archive(alice);
      expect(archived).toMatchObject({ id: first?.id, title: "What is on day two?", turns: 2 });
      expect(await store.history(alice)).toEqual([]);
      expect(await store.list(alice)).toMatchObject({ active: null, archived: [{ id: first?.id }] });

      await store.append(alice, "user", "Second thread", "");
      const second = (await store.list(alice)).active;
      expect(second).toMatchObject({ title: "Second thread", turns: 1 });

      const resumed = await store.resume(alice, first?.id || "");
      expect(resumed).toMatchObject({ id: first?.id, turns: 2 });
      expect((await store.history(alice)).map((turn) => turn.text)).toEqual(["What is on day two?\nMore detail", "Talks on agents."]);
      const after = await store.list(alice);
      expect(after.active?.id).toBe(first?.id);
      expect(after.archived.map((thread) => thread.id)).toEqual([second?.id]);

      expect(await store.resume(alice, "not-a-uuid")).toBeNull();
      expect(await store.resume(alice, randomUUID())).toBeNull();
      expect(await store.resume(alice, first?.id || "")).toBeNull(); // already active
    });
  });

  it("never shows or resumes another person's or another workspace's thread", async () => {
    await withStore(async (store, { alice, bob, aliceTeam }) => {
      await store.append(alice, "user", "Alice private question", "conf-a");
      const aliceThread = await store.archive(alice);
      await store.append(alice, "user", "Alice active", "conf-a");

      expect(await store.list(bob)).toEqual({ active: null, archived: [] });
      expect(await store.history(bob)).toEqual([]);
      expect(await store.resume(bob, aliceThread?.id || "")).toBeNull();
      expect(await store.archive(bob)).toBeNull();
      expect(await store.list(aliceTeam)).toEqual({ active: null, archived: [] });
      expect(await store.resume(aliceTeam, aliceThread?.id || "")).toBeNull();

      await store.append(bob, "user", "Bob question", "");
      expect((await store.history(alice)).map((turn) => turn.text)).toEqual(["Alice active"]);
      expect((await store.history(bob)).map((turn) => turn.text)).toEqual(["Bob question"]);
      expect((await store.list(alice)).archived.map((thread) => thread.id)).toEqual([aliceThread?.id]);
    });
  });

  it("creates exactly one active thread when first turns race", async () => {
    await withStore(async (store, { alice }) => {
      await Promise.all(Array.from({ length: 5 }, (_, index) => store.append(alice, "user", `turn ${index}`, "")));
      const listed = await store.list(alice);
      expect(listed.active?.turns).toBe(5);
      expect(listed.archived).toEqual([]);
    });
  });
});
