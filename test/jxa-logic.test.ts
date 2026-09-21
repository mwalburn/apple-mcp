import { describe, it, expect } from "vitest";
import { wrapScript } from "../src/core/jxa.js";
import { FETCH, LIST_LISTS, LIST_REMINDERS, INCOMPLETE_IDS, STATUS, GET_REMINDER } from "../src/modules/reminders/scripts.js";

/**
 * The JXA bodies cannot run off-Mac, but their logic is plain JavaScript.
 * These tests run the real script source, wrapped exactly as osascript would
 * receive it, against a fake Reminders object model that counts Apple Events,
 * so both the result and the cost are checked.
 */

/** Compiles the osascript wrapper and invokes `run(argv)` the way osascript does, with `Application` faked. */
function runScript<T = any>(body: string, args: unknown, Application: (name: string) => unknown): T {
  const run = new Function("Application", `${wrapScript(body)}; return run;`)(Application) as (argv: string[]) => string;
  return JSON.parse(run([JSON.stringify(args)]));
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

/** Minimal `Application("Reminders")` with `lists` as JXA exposes it: callable, indexable, with whose(). */
function fakeApp(lists: ReturnType<typeof fakeList>["list"][]) {
  const listsRef: any = () => lists;
  // Function.name/length are read-only, so define rather than assign.
  Object.defineProperties(listsRef, {
    id: { value: () => lists.map((l) => l.id()) },
    name: { value: () => lists.map((l) => l.name()) },
    whose: { value: ({ name }: { name: string }) => () => lists.filter((l) => l.name() === name) },
  });
  for (let i = 0; i < lists.length; i++) listsRef[i] = lists[i];
  return { lists: listsRef };
}

const rows = [
  { id: "a", name: "Milk", completed: true },
  { id: "b", name: "Call plumber", completed: false, due: "2026-09-21T01:00:00Z" },
  { id: "c", name: "Eggs", completed: true },
  { id: "d", name: "Renew tabs", completed: false },
];

describe("fetchFrom", () => {
  const fetchFrom = new Function(`${FETCH}; return fetchFrom;`)() as (list: any, status: string) => any[];

  it("returns only incomplete rows, with fields aligned to the right reminder", () => {
    const { list } = fakeList("Home", rows);
    const out = fetchFrom(list, "incomplete");
    expect(out.map((r) => [r.id, r.name, r.completed])).toEqual([["b", "Call plumber", false], ["d", "Renew tabs", false]]);
    expect(out[0].dueDate).toBe("2026-09-21T01:00:00.000Z");
    expect(out[0].list).toBe("Home");
  });

  it("handles completed and all", () => {
    expect(fetchFrom(fakeList("L", rows).list, "completed").map((r) => r.id)).toEqual(["a", "c"]);
    expect(fetchFrom(fakeList("L", rows).list, "all").map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("a list with nothing wanted costs exactly one Apple Event (the Groceries case)", () => {
    const big = Array.from({ length: 5000 }, (_, i) => ({ id: `g${i}`, name: `item ${i}`, completed: true }));
    const { list, events } = fakeList("Groceries", big);
    expect(fetchFrom(list, "incomplete")).toEqual([]);
    expect(events).toEqual({ n: 1, whose: 0 });
  });

  it("never uses whose(), and costs a fixed 9 events regardless of list size", () => {
    const big = Array.from({ length: 5000 }, (_, i) => ({ id: `m${i}`, name: `item ${i}`, completed: i % 250 !== 0 }));
    const { list, events } = fakeList("Mela", big);
    expect(fetchFrom(list, "incomplete")).toHaveLength(20);
    expect(events).toEqual({ n: 9, whose: 0 });
  });
});

describe("pickLists", () => {
  const pickLists = new Function(`${FETCH}; return pickLists;`)() as (app: any, listName: string | undefined, exclude: string[]) => any[];
  const L = (id: string, name: string) => ({ id: () => id, name: () => name });
  const all = [L("A1", "Inbox"), L("B2", "Mela"), L("C3", "Groceries"), L("D4", "New List")];
  const app = { lists: Object.assign(() => all, { whose: ({ name }: any) => () => all.filter((l) => l.name() === name) }) };

  it("excludes by name or id, case-insensitively; an explicit list overrides the denylist", () => {
    expect(pickLists(app, undefined, ["mela", "c3"]).map((l) => l.name())).toEqual(["Inbox", "New List"]);
    expect(pickLists(app, "Groceries", ["Groceries"]).map((l) => l.name())).toEqual(["Groceries"]);
    expect(() => pickLists(app, "Nope", [])).toThrow(/No Reminders list/);
  });
});

describe("full scripts through the osascript wrapper", () => {
  const home = fakeList("Home", rows);
  const groceries = fakeList("Groceries", [{ id: "g1", name: "z", completed: true }]);
  const mela = fakeList("Mela", [{ id: "m1", name: "q", completed: false }]);
  const app = fakeApp([home.list, groceries.list, mela.list]);
  const Application = (name: string) => { expect(name).toBe("Reminders"); return app; };

  it("LIST_LISTS returns id, name and incomplete count per list", () => {
    expect(runScript(LIST_LISTS, {}, Application)).toEqual([
      { id: "Home-id", name: "Home", incomplete: 2 },
      { id: "Groceries-id", name: "Groceries", incomplete: 0 },
      { id: "Mela-id", name: "Mela", incomplete: 1 },
    ]);
  });

  it("LIST_REMINDERS reports the lists it scanned and honours the denylist", () => {
    const out = runScript(LIST_REMINDERS, { list: undefined, status: "incomplete", exclude: ["Mela"] }, Application);
    expect(out.scanned).toEqual(["Home", "Groceries"]);
    expect(out.items.map((r: any) => r.id)).toEqual(["b", "d"]);
  });

  it("INCOMPLETE_IDS costs two events for lists with incomplete items, one otherwise, zero when excluded", () => {
    const a = fakeList("Home", [{ id: "h1", name: "x", completed: false }, { id: "h2", name: "y", completed: true }]);
    const b = fakeList("Groceries", [{ id: "g1", name: "z", completed: true }]);
    const c = fakeList("Mela", [{ id: "m1", name: "q", completed: false }]);
    const ids = runScript(INCOMPLETE_IDS, { exclude: ["Mela"] }, () => fakeApp([a.list, b.list, c.list]));
    expect(ids).toEqual(["h1"]);
    expect([a.events.n, b.events.n, c.events.n]).toEqual([2, 1, 0]);
  });

  it("STATUS scans every list once and preserves input order", () => {
    const home = fakeList("Home", rows);
    const groceries = fakeList("Groceries", [{ id: "g1", name: "Bread", completed: true }]);
    const mela = fakeList("Mela", [{ id: "m1", name: "Other", completed: false }]);
    const statusApp = fakeApp([home.list, groceries.list, mela.list]);
    expect(runScript(STATUS, { ids: ["b", "gone", "g1"] }, () => statusApp)).toEqual([
      { id: "b", found: true, name: "Call plumber", list: "Home", completed: false, completionDate: null, dueDate: "2026-09-21T01:00:00.000Z", modifiedAt: null },
      { id: "gone", found: false },
      { id: "g1", found: true, name: "Bread", list: "Groceries", completed: true, completionDate: null, dueDate: null, modifiedAt: null },
    ]);
    expect([home.events.n, groceries.events.n, mela.events.n]).toEqual([6, 6, 1]);
    expect([home.events.whose, groceries.events.whose, mela.events.whose]).toEqual([0, 0, 0]);
  });

  it("GET_REMINDER returns every field and throws for an unknown id", () => {
    const d = new Date("2026-09-21T01:00:00Z");
    const rem = {
      id: () => "b", container: () => ({ name: () => "Home" }), name: () => "Call plumber", body: () => "",
      completed: () => false, dueDate: () => d, alldayDueDate: () => null, remindMeDate: () => d, priority: () => 5,
      flagged: () => true, completionDate: () => null, creationDate: () => d, modificationDate: () => d,
    };
    const getApp = { reminders: { whose: ({ id }: { id: string }) => () => (id === "b" ? [rem] : []) } };
    expect(runScript(GET_REMINDER, { id: "b" }, () => getApp)).toEqual({
      id: "b", list: "Home", name: "Call plumber", notes: null, completed: false,
      dueDate: d.toISOString(), alldayDueDate: null, remindMeDate: d.toISOString(), priority: 5, flagged: true,
      completionDate: null, createdAt: d.toISOString(), modifiedAt: d.toISOString(),
    });
    expect(() => runScript(GET_REMINDER, { id: "zzz" }, () => getApp)).toThrow(/No reminder with id/);
  });
});
