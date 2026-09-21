import { describe, it, expect } from "vitest";
import { normalizeId, loadUrgency, urgencyOf } from "../src/modules/reminders/store.js";
import { remindersModule } from "../src/modules/reminders/index.js";
import { INCOMPLETE_IDS } from "../src/modules/reminders/scripts.js";
import { makeRemindersStoreDir, fakeCtx } from "./fixtures.js";

const id = (n: number) => `x-apple-reminder://${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const rem = (n: string, a: any, ctx: any) => remindersModule.tools.find((t) => t.name === n)!.handler(a, ctx) as Promise<any>;
const item = (n: number) => ({ id: id(n), list: "Home", name: `r${n}`, notes: null, completed: false, dueDate: null, priority: 0, flagged: false, completionDate: null, modifiedAt: null });

describe("id normalisation", () => {
  it("reduces every encoding to the same 32-char key", () => {
    const want = "EF490510CA22446296F69C44C6C44EF9";
    expect(normalizeId("x-apple-reminder://EF490510-CA22-4462-96F6-9C44C6C44EF9")).toBe(want);
    expect(normalizeId("ef490510-ca22-4462-96f6-9c44c6c44ef9")).toBe(want);
    expect(normalizeId(Buffer.from(want, "hex"))).toBe(want);
  });
  it("rejects things that are not reminder ids", () => {
    for (const v of ["bogus-id", "", null, 42, Buffer.from("short")]) expect(normalizeId(v)).toBeNull();
  });
});

describe("urgency index against a fixture store", () => {
  const ctx = fakeCtx({ env: { APPLE_MCP_REMINDERS_STORE_DIR: makeRemindersStoreDir() } });
  const index = loadUrgency(ctx);

  it("reads usable stores and skips the column-less and corrupt ones", () => expect(index!.stores).toBe(2));
  it("matches ids stored as text, as a 16-byte blob, or in the DA column", () => {
    expect(urgencyOf(index, id(1))).toBe(true);
    expect(urgencyOf(index, id(2))).toBe(true);
    expect(urgencyOf(index, id(3))).toBe(false);
  });
  it("treats a NULL flag as not urgent", () => expect(urgencyOf(index, id(4))).toBe(false));
  it("urgent in any store wins when a reminder exists in several", () => expect(urgencyOf(index, id(5))).toBe(true));
  it("returns null, not false, for an id it cannot find", () => expect(urgencyOf(index, id(9))).toBeNull());
});

describe("urgent on tool output", () => {
  const jxaList = (async () => ({ scanned: ["Home"], items: [item(1), item(3), item(9)] })) as any;

  it("reminders_list carries urgent: true / false / null", async () => {
    const ctx = fakeCtx({ env: { APPLE_MCP_REMINDERS_STORE_DIR: makeRemindersStoreDir() }, jxa: jxaList });
    const r = await rem("reminders_list", { status: "incomplete", flaggedOnly: false, limit: 100 }, ctx);
    expect(Object.fromEntries(r.items.map((x: any) => [x.name, x.urgent]))).toEqual({ r1: true, r3: false, r9: null });
  });

  it("no store at all: everything still works and urgent is null across the board", async () => {
    const ctx = fakeCtx({ env: { APPLE_MCP_REMINDERS_STORE_DIR: "/nonexistent" }, jxa: jxaList });
    const r = await rem("reminders_list", { status: "incomplete", flaggedOnly: false, limit: 100 }, ctx);
    expect(r.count).toBe(3);
    expect(r.items.every((x: any) => x.urgent === null)).toBe(true);
  });

  it("reminders_status adds urgent to found reminders only", async () => {
    const ctx = fakeCtx({ env: { APPLE_MCP_REMINDERS_STORE_DIR: makeRemindersStoreDir() },
      jxa: (async () => [{ id: id(2), found: true, completed: false }, { id: "gone", found: false }]) as any });
    const r = await rem("reminders_status", { ids: [id(2), "gone"] }, ctx);
    expect(r.results).toEqual([{ id: id(2), found: true, completed: false, urgent: true }, { id: "gone", found: false }]);
  });

  it("doctor reports the join rate so a silent mismatch is visible", async () => {
    const ctx = fakeCtx({ env: { APPLE_MCP_REMINDERS_STORE_DIR: makeRemindersStoreDir() },
      jxa: (async (s: string) => (s === INCOMPLETE_IDS ? [id(1), id(3), id(9)] : [1, 2])) as any });
    expect(await remindersModule.check!(ctx)).toBe("2 list(s) visible; urgent flag: matched 2/3 reminders across 2 store(s), 1 urgent");
  });

  it("the store is opened read-only", async () => {
    const dir = makeRemindersStoreDir();
    const { DatabaseSync } = await import("node:sqlite");
    const { join } = await import("node:path");
    const db = new DatabaseSync(join(dir, "Data-AAAA.sqlite"), { readOnly: true });
    expect(() => db.exec("UPDATE ZREMCDREMINDER SET ZISURGENTSTATEENABLEDFORCURRENTUSER = 0")).toThrow(/readonly|read-only/i);
    db.close();
  });
});
