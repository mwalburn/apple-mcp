import { describe, it, expect } from "vitest";
import { filterReminders, remindersModule, type Reminder } from "../src/modules/reminders/index.js";
import { makeJxaRunner, wrapScript } from "../src/core/jxa.js";
import { LIST_LISTS, LIST_REMINDERS, GET_REMINDER, STATUS } from "../src/modules/reminders/scripts.js";
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
  it("accepts a calendar day as a due lower bound", () =>
    expect(filterReminders(data, { limit: 10, dueAfter: "2026-09-20" }).map((x) => x.id)).toEqual(["b", "a"]));
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
    // The wrapper osascript receives is itself valid JavaScript and round-trips args -> return value.
    const run = new Function(`${seen.args[3]}; return run;`)() as (argv: string[]) => string;
    expect(JSON.parse(run([seen.args[4]]))).toBe(1);
  });
  it("maps an empty or undefined script result to null", async () => {
    const jxa = makeJxaRunner(async () => ({ stdout: "", stderr: "" }));
    expect(await jxa("return;")).toBeNull();
    const run = new Function(`${wrapScript("const x = 1;")}; return run;`)() as (argv: string[]) => string;
    expect(run(["{}"])).toBe("null");
  });
  it("maps timeouts and missing osascript to actionable errors", async () => {
    const timedOut = makeJxaRunner(async () => { throw Object.assign(new Error("killed"), { killed: true, stderr: "" }); });
    await expect(timedOut("return 1;")).rejects.toMatchObject({ message: /did not respond/, hint: /Narrow the query/ });
    const noOsa = makeJxaRunner(async () => { throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT", stderr: "" }); });
    await expect(noOsa("return 1;")).rejects.toMatchObject({ message: /only runs on macOS/ });
  });
  it("maps the automation-denied error to an actionable hint", async () => {
    const jxa = makeJxaRunner(async () => { throw Object.assign(new Error("x"), { stderr: "execution error: Not authorized to send Apple events to Reminders. (-1743)" }); });
    await expect(jxa("return 1;")).rejects.toMatchObject({ hint: expect.stringMatching(/Automation/) });
  });
  it("every tool sends one of the exported script bodies, wrapped, and passes its input as args", async () => {
    const calls: { script: string; args: any }[] = [];
    // One fake serves tools that expect an array and tools that expect {scanned, items}.
    const ctx = fakeCtx({ env: { APPLE_MCP_REMINDERS_STORE_DIR: "/nonexistent" }, jxa: (async (s: string, a: unknown) => { calls.push({ script: s, args: a }); return Object.assign([], { scanned: [], items: [] }); }) as any });
    const tool = (n: string) => remindersModule.tools.find((t) => t.name === n)!;
    await tool("reminders_list_lists").handler({}, ctx);
    await tool("reminders_list").handler({ status: "all", flaggedOnly: false, limit: 1 }, ctx);
    await tool("reminders_search").handler({ query: "q", status: "incomplete", limit: 1 }, ctx);
    await tool("reminders_get").handler({ id: "x" }, ctx);
    await tool("reminders_status").handler({ ids: ["x"] }, ctx);
    expect(calls.map((c) => c.script)).toEqual([LIST_LISTS, LIST_REMINDERS, LIST_REMINDERS, GET_REMINDER, STATUS]);
    expect(calls[3]!.args).toEqual({ id: "x" });
    expect(calls[4]!.args).toEqual({ ids: ["x"] });
    for (const c of calls) expect(() => new Function(wrapScript(c.script))).not.toThrow();
  });
});
