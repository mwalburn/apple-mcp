import { describe, it, expect } from "vitest";
import { filterReminders, remindersModule, type Reminder } from "../src/modules/reminders/index.js";
import { makeJxaRunner } from "../src/core/jxa.js";
import { fakeCtx } from "./fixtures.js";

const r = (o: Partial<Reminder>): Reminder => ({
  id: "x", list: "Home", name: "n", notes: null, completed: false, dueDate: null,
  priority: 0, flagged: false, completionDate: null, modifiedAt: null, ...o,
});
const data = [
  r({ id: "a", name: "Renew tabs", dueDate: "2026-09-25T14:00:00.000Z" }),
  r({ id: "b", name: "Call plumber", notes: "about the WATER heater", dueDate: "2026-09-20T14:00:00.000Z", flagged: true }),
  r({ id: "c", name: "Someday" }),
];

describe("filterReminders", () => {
  it("sorts by due date, undated last", () =>
    expect(filterReminders(data, { limit: 10 }).map((x) => x.id)).toEqual(["b", "a", "c"]));
  it("applies a half-open due window and drops undated items", () =>
    expect(filterReminders(data, { limit: 10, dueAfter: "2026-09-20T14:00:00Z", dueBefore: "2026-09-25T14:00:00Z" }).map((x) => x.id)).toEqual(["b"]));
  it("searches title and notes case-insensitively", () =>
    expect(filterReminders(data, { limit: 10, query: "water" }).map((x) => x.id)).toEqual(["b"]));
  it("honours flaggedOnly and limit", () => {
    expect(filterReminders(data, { limit: 10, flaggedOnly: true })).toHaveLength(1);
    expect(filterReminders(data, { limit: 2 })).toHaveLength(2);
  });
});

describe("reminders tools", () => {
  it("passes scope to JXA as data, never as script text", async () => {
    const calls: any[] = [];
    const ctx = fakeCtx({ jxa: (async (script: string, args: unknown) => { calls.push({ script, args }); return { scanned: ["Home"], items: data }; }) as any });
    const tool = remindersModule.tools.find((t) => t.name === "reminders_list")!;
    const evil = `Home"}); app.quit(); //`;
    const out: any = await tool.handler({ list: evil, status: "incomplete", flaggedOnly: false, limit: 100 }, ctx);
    expect(calls[0].args).toEqual({ list: evil, status: "incomplete", exclude: [] });
    expect(calls[0].script).not.toContain("app.quit");
    expect(out.count).toBe(3);
  });
});

describe("JXA runner", () => {
  it("invokes osascript without a shell and parses JSON output", async () => {
    let seen: any;
    const jxa = makeJxaRunner(async (file, args) => { seen = { file, args }; return { stdout: '{"ok":true}\n', stderr: "" }; });
    expect(await jxa("return 1;", { a: "b'\"$(rm -rf)" })).toEqual({ ok: true });
    expect(seen.file).toBe("/usr/bin/osascript");
    expect(seen.args.slice(0, 3)).toEqual(["-l", "JavaScript", "-e"]);
    expect(JSON.parse(seen.args[4])).toEqual({ a: "b'\"$(rm -rf)" });
  });
  it("maps the automation-denied error to an actionable hint", async () => {
    const jxa = makeJxaRunner(async () => { throw Object.assign(new Error("x"), { stderr: "execution error: Not authorized to send Apple events to Reminders. (-1743)" }); });
    await expect(jxa("return 1;")).rejects.toMatchObject({ hint: expect.stringMatching(/Automation/) });
  });
  it("wrapped script is valid JavaScript", () => {
    // Syntax-check every JXA body by compiling (not running) it.
    const bodies: string[] = [];
    // One fake serves tools that expect an array and tools that expect {scanned, items}.
    const ctx = fakeCtx({ jxa: (async (s: string) => { bodies.push(s); return Object.assign([], { scanned: [], items: [] }); }) as any });
    return Promise.all([
      remindersModule.tools[0]!.handler({}, ctx),
      remindersModule.tools[1]!.handler({ status: "all", flaggedOnly: false, limit: 1 }, ctx),
      remindersModule.tools[3]!.handler({ id: "x" }, ctx),
      remindersModule.tools.find((t) => t.name === "reminders_status")!.handler({ ids: ["x"] }, ctx),
    ]).then(() => { expect(bodies).toHaveLength(4);
      for (const b of bodies) expect(() => new Function("args", "Application", b)).not.toThrow(); });
  });
});
