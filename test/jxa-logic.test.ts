import { describe, it, expect } from "vitest";
import { remindersModule } from "../src/modules/reminders/index.js";
import { fakeCtx } from "./fixtures.js";

/**
 * The JXA bodies cannot run off-Mac, but their logic is plain JavaScript.
 * These tests lift the real function source out of the script and run it
 * against a fake Reminders object model that counts Apple Events, so both the
 * result and the cost are checked.
 */
async function scriptSource(tool: string, args: any): Promise<string> {
  let src = "";
  const ctx = fakeCtx({ jxa: (async (s: string) => { src = s; return Object.assign([], { scanned: [], items: [] }); }) as any });
  await remindersModule.tools.find((t) => t.name === tool)!.handler(args, ctx);
  return src;
}

function fakeList(name: string, rows: { id: string; name: string; completed: boolean; due?: string }[]) {
  const events = { n: 0, whose: 0 };
  const bulk = (f: (r: any) => any) => () => { events.n++; return rows.map(f); };
  const reminders = {
    completed: bulk((r) => r.completed), id: bulk((r) => r.id), name: bulk((r) => r.name),
    body: bulk(() => ""), dueDate: bulk((r) => (r.due ? new Date(r.due) : null)), priority: bulk(() => 0),
    flagged: bulk(() => false), completionDate: bulk(() => null), modificationDate: bulk(() => null),
    whose: () => { events.whose++; throw new Error("whose() must not be used: it rescans per property"); },
  };
  return { list: { name: () => name, id: () => name + "-id", reminders }, events };
}

describe("fetchFrom", () => {
  const load = async () => {
    const src = await scriptSource("reminders_list", { status: "incomplete", flaggedOnly: false, limit: 1 });
    const fn = src.slice(src.indexOf("function fetchFrom"), src.indexOf("function pickLists"));
    return new Function(`${fn}; return fetchFrom;`)() as (list: any, status: string) => any[];
  };
  const rows = [
    { id: "a", name: "Milk", completed: true },
    { id: "b", name: "Call plumber", completed: false, due: "2026-09-21T01:00:00Z" },
    { id: "c", name: "Eggs", completed: true },
    { id: "d", name: "Renew tabs", completed: false },
  ];

  it("returns only incomplete rows, with fields aligned to the right reminder", async () => {
    const { list } = fakeList("Home", rows);
    const out = (await load())(list, "incomplete");
    expect(out.map((r) => [r.id, r.name, r.completed])).toEqual([["b", "Call plumber", false], ["d", "Renew tabs", false]]);
    expect(out[0].dueDate).toBe("2026-09-21T01:00:00.000Z");
    expect(out[0].list).toBe("Home");
  });

  it("handles completed and all", async () => {
    const f = await load();
    expect(f(fakeList("L", rows).list, "completed").map((r) => r.id)).toEqual(["a", "c"]);
    expect(f(fakeList("L", rows).list, "all").map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("a list with nothing wanted costs exactly one Apple Event (the Groceries case)", async () => {
    const big = Array.from({ length: 5000 }, (_, i) => ({ id: `g${i}`, name: `item ${i}`, completed: true }));
    const { list, events } = fakeList("Groceries", big);
    expect((await load())(list, "incomplete")).toEqual([]);
    expect(events).toEqual({ n: 1, whose: 0 });
  });

  it("never uses whose(), and costs a fixed 9 events regardless of list size", async () => {
    const big = Array.from({ length: 5000 }, (_, i) => ({ id: `m${i}`, name: `item ${i}`, completed: i % 250 !== 0 }));
    const { list, events } = fakeList("Mela", big);
    expect((await load())(list, "incomplete")).toHaveLength(20);
    expect(events).toEqual({ n: 9, whose: 0 });
  });
});

describe("doctor id scan", () => {
  it("collects incomplete ids in two events per list, one for lists with none, honouring the denylist", async () => {
    let src = "";
    const ctx = fakeCtx({ env: { APPLE_MCP_REMINDERS_STORE_DIR: "/nonexistent" },
      jxa: (async (s: string) => { if (s.includes("let ids = []")) src = s; return []; }) as any });
    await remindersModule.check!(ctx);
    const a = fakeList("Home", [{ id: "h1", name: "x", completed: false }, { id: "h2", name: "y", completed: true }]);
    const b = fakeList("Groceries", [{ id: "g1", name: "z", completed: true }]);
    const c = fakeList("Mela", [{ id: "m1", name: "q", completed: false }]);
    const lists = [a.list, b.list, c.list];
    const app = { lists: Object.assign(() => lists, { whose: () => () => [] }) };
    const body = src.slice(src.indexOf("function fetchFrom"));
    const run = new Function("args", "Application", body.replace(/\}\)\(\);return JSON\.stringify[\s\S]*$/, ""));
    expect(run({ exclude: ["Mela"] }, () => app)).toEqual(["h1"]);
    expect([a.events.n, b.events.n, c.events.n]).toEqual([2, 1, 0]);
  });
});
