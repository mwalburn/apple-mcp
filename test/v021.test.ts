import { describe, it, expect, beforeAll } from "vitest";
import { redact } from "../src/modules/messages/redact.js";
import { messagesModule } from "../src/modules/messages/index.js";
import { contactsModule } from "../src/modules/contacts/index.js";
import { remindersModule, filterReminders, excludedLists, type Reminder } from "../src/modules/reminders/index.js";
import { loadContacts, candidatesForName } from "../src/modules/contacts/directory.js";
import { makeChatDb, makeContactsDir, fakeCtx } from "./fixtures.js";
import type { ModuleContext } from "../src/core/types.js";

const msg = (n: string, a: any, ctx: any) => messagesModule.tools.find((t) => t.name === n)!.handler(a, ctx) as Promise<any>;
const rem = (n: string, a: any, ctx: any) => remindersModule.tools.find((t) => t.name === n)!.handler(a, ctx) as Promise<any>;
function wired(env: Record<string, string>): ModuleContext {
  const ctx = fakeCtx({ env }); Object.assign(ctx.services, contactsModule.provide!(ctx)); return ctx;
}

describe("redaction", () => {
  const cases: [string, string][] = [
    ["Username: walburns\npassword: hunter2!x", "Username: walburns\npassword: [redacted]"],
    ["the wifi Password is CorrectHorse9", "the wifi Password is [redacted]"],
    ["PIN - 4821", "PIN - [redacted]"],
    ["Your Chase verification code is 482913. Do not share it.", "Your Chase verification code is [redacted]. Do not share it."],
    ["Use 30419 as your Apple ID code", "Use [redacted] as your Apple ID code"],
    ["2FA: 8841", "2FA: [redacted]"],
    ["Your one-time passcode is 5566 7788", "Your one-time passcode is [redacted] [redacted]"],
    ["Your Uber code is 1234. Reply STOP to unsubscribe", "Your Uber code is [redacted]. Reply STOP to unsubscribe"],
    ["OTP 482913 expires in 10 minutes", "OTP [redacted] expires in 10 minutes"],
    ["card 4111 1111 1111 1111 exp 04/29", "card [redacted] exp 04/29"],
    ["ssn 123-45-6789", "ssn [redacted]"],
    ["https://share.1password.com/s#AbC-dEf_123456", "https://share.1password.com/[redacted]"],
    ["here: https://send.bitwarden.com/#xYz/abc thanks", "here: https://send.bitwarden.com/[redacted] thanks"],
  ];
  it.each(cases)("masks %j", (input, want) => expect(redact(input)).toEqual({ text: want, redacted: true }));

  const untouched = [
    "Pick him up at 5:30, 3175 Century Ave S",          // times and street numbers are not codes
    "Tuition is $11,200 due 9/21",                      // money and dates
    "Call me at 651-555-0100",                          // phone numbers
    "I passed the exam! Got 1450",                      // "pass" inside a word, number not a code context
    "Can you please send me the password once you reset it?", // asks about a password, contains none
    "https://www.icloud.com/notes/0a7OBCKKiu1Y#Costco",         // ordinary shared links are not secrets
    "https://www.masterboltz.com/user/login",
    "Login is at 1600 Pennsylvania Ave, see you in 2026", // "login" alone is not a code context
    "Can you verify the invoice total is 12500?",        // nor is "verify"
    "Sign in opens at 0900",
    "Flight code is DL1234, gate B12",                    // digits glued to letters are not codes
    "The discount code saves you $1500",                  // currency is not a code
  ];
  it.each(untouched)("leaves %j alone", (t) => expect(redact(t)).toEqual({ text: t, redacted: false }));
});

describe("messages v0.2.1", () => {
  let ctx: ModuleContext;
  beforeAll(() => { ctx = wired({ APPLE_MCP_MESSAGES_DB: makeChatDb(), APPLE_MCP_CONTACTS_DIR: makeContactsDir() }); });

  it("exposes guid and masks secrets on output, flagging that it did", async () => {
    const r = await msg("messages_get_chat", { chatId: 1, limit: 50, includeReactions: false }, ctx);
    const pw = r.messages.find((m: any) => m.id === 9);
    expect(pw).toMatchObject({ guid: "m9", redacted: true });
    expect(pw.text).toBe("Username: walburns\npassword: [redacted]");
    expect(r.messages.find((m: any) => m.id === 1).redacted).toBeUndefined();
  });

  it("masks one-time codes that live in the binary body column", async () => {
    const r = await msg("messages_get_chat", { chatId: 2, limit: 50, includeReactions: false }, ctx);
    expect(r.messages.find((m: any) => m.id === 10).text).toContain("code is [redacted]");
  });

  it("search matches on raw text but never returns the secret", async () => {
    const r = await msg("messages_search", { query: "hunter2", limit: 5, scanLimit: 1000 }, ctx);
    expect(r.count).toBe(1);
    expect(JSON.stringify(r)).not.toContain("hunter2");
  });

  it("APPLE_MCP_REDACT=off disables masking", async () => {
    const off = wired({ APPLE_MCP_MESSAGES_DB: makeChatDb(), APPLE_MCP_REDACT: "off" });
    const r = await msg("messages_get_chat", { chatId: 1, limit: 50, includeReactions: false }, off);
    expect(r.messages.find((m: any) => m.id === 9).text).toContain("hunter2");
  });

  it("prefers the formal name when a pet-name card shares the number", async () => {
    const r = await msg("messages_get_chat", { chatId: 1, limit: 50, includeReactions: false }, ctx);
    expect(r.messages.find((m: any) => m.id === 1).senderName).toBe("Alex Rivera"); // not "Alex Rivera / Dad💖"
  });

  it("whole-word matches suppress substring noise", () => {
    const names = candidatesForName(loadContacts(ctx), "alex").map((c) => c.name);
    expect(names).toEqual(["Alex Chen", "Alex Rivera"]); // "Alexandria Dental" dropped
    // with no whole-word match, substring hits are still offered
    expect(candidatesForName(loadContacts(ctx), "alexand").map((c) => c.name)).toEqual(["Alexandria Dental"]);
  });

  it("breaks a tie by recent activity and says so", async () => {
    // Alex Rivera has recent messages; Alex Chen has none.
    const r = await msg("messages_get_chat", { contact: "Alex", limit: 5, includeReactions: false }, ctx);
    expect(r).toMatchObject({ contact: "Alex Rivera", matchedBy: "recent-activity", alsoMatched: ["Alex Chen"] });
  });

  it("still refuses when two candidates are both active, and shows last-contact dates", async () => {
    // "Pat Rivera" (email, recent) and "Pat Oldfriend" need both to be active: give Oldfriend a recent message.
    const path = makeChatDb();
    const { DatabaseSync } = await import("node:sqlite");
    const { isoToAppleNs } = await import("../src/modules/messages/db.js");
    const db = new DatabaseSync(path);
    db.exec("INSERT INTO handle VALUES (9,'+17635550123')");
    db.prepare("INSERT INTO message (ROWID,guid,text,handle_id,date,is_from_me,service) VALUES (99,'m99','hi',9,?,0,'iMessage')").run(isoToAppleNs(new Date().toISOString()));
    db.exec("INSERT INTO chat VALUES (9,'g9','+17635550123',NULL,'iMessage',45); INSERT INTO chat_handle_join VALUES (9,9); INSERT INTO chat_message_join VALUES (9,99)");
    db.close();
    const both = wired({ APPLE_MCP_MESSAGES_DB: path, APPLE_MCP_CONTACTS_DIR: makeContactsDir() });
    await expect(msg("messages_get_chat", { contact: "Pat", limit: 5, includeReactions: false }, both))
      .rejects.toThrow(/ambiguous: Pat Oldfriend \(last message \d{4}-\d{2}-\d{2}\), Pat Rivera \(last message/);
  });
});

describe("messages_since", () => {
  let ctx: ModuleContext;
  beforeAll(() => { ctx = wired({ APPLE_MCP_MESSAGES_DB: makeChatDb(), APPLE_MCP_CONTACTS_DIR: makeContactsDir() }); });
  const base = { limit: 500, includeReactions: false };

  it("bootstraps to the current ceiling without reading anything", async () => {
    expect(await msg("messages_since", base, ctx)).toEqual({ bootstrap: true, nextAfterId: 10, count: 0, messages: [] });
  });

  it("returns only rows above the watermark, oldest first, including my own replies", async () => {
    const r = await msg("messages_since", { ...base, afterId: 5 }, ctx);
    expect(r.messages.map((m: any) => m.id)).toEqual([6, 7, 8, 9, 10]);
    expect(r.messages.find((m: any) => m.id === 9).fromMe).toBe(true);
    expect(r).toMatchObject({ nextAfterId: 10, hasMore: false });
  });

  it("is idempotent: feeding nextAfterId back yields nothing", async () => {
    const r = await msg("messages_since", { ...base, afterId: 10 }, ctx);
    expect(r).toMatchObject({ count: 0, nextAfterId: 10, hasMore: false });
  });

  it("pages without loss: a truncated page resumes from its last row, not the ceiling", async () => {
    const p1 = await msg("messages_since", { ...base, afterId: 0, limit: 3 }, ctx);
    expect(p1).toMatchObject({ hasMore: true, nextAfterId: 3 });
    const seen = [...p1.messages.map((m: any) => m.id)];
    let after = p1.nextAfterId, more = true;
    while (more) { const p = await msg("messages_since", { ...base, afterId: after, limit: 3 }, ctx); seen.push(...p.messages.map((m: any) => m.id)); after = p.nextAfterId; more = p.hasMore; }
    expect(seen).toEqual([1, 2, 3, 5, 6, 7, 8, 9, 10]); // 4 is a tapback
  });

  it("filters to an allowlist, still advances the watermark past everyone else's chatter", async () => {
    const r = await msg("messages_since", { ...base, afterId: 0, contacts: ["Alex Rivera"] }, ctx);
    expect(new Set(r.messages.map((m: any) => m.chatId))).toEqual(new Set([1]));
    expect(r.nextAfterId).toBe(10); // ceiling, even though the last matching row is 9
    expect(r.resolved).toEqual([{ contact: "Alex Rivera", matched: "Alex Rivera", matchedBy: "exact" }]);
  });

  it("an unresolvable name is reported, not fatal, so one typo cannot break a scheduled run", async () => {
    const r = await msg("messages_since", { ...base, afterId: 0, contacts: ["Alex Rivera", "Nobody Here"] }, ctx);
    expect(r.count).toBeGreaterThan(0);
    expect(r.unresolved).toEqual([{ contact: "Nobody Here", reason: expect.stringMatching(/No contact/) }]);
  });

  it("filters by raw handles without touching Contacts, and merges them with resolved contacts", async () => {
    const noContacts = fakeCtx({ env: { APPLE_MCP_MESSAGES_DB: makeChatDb() } });
    const r = await msg("messages_since", { ...base, afterId: 0, handles: ["(612) 555-0199"] }, noContacts);
    expect(r.messages.map((m: any) => m.id)).toEqual([5, 6, 7, 10]); // whole chat 2, not just that handle's rows
    expect(r).toMatchObject({ nextAfterId: 10, resolved: [], unresolved: [] });
    const both = await msg("messages_since", { ...base, afterId: 0, handles: ["+16125550199"], contacts: ["Alex Rivera"] }, ctx);
    expect(both.messages.map((m: any) => m.id)).toEqual([1, 2, 3, 5, 6, 7, 8, 9, 10]);
  });

  it("includes tapbacks only when includeReactions is set", async () => {
    const r = await msg("messages_since", { ...base, afterId: 3, includeReactions: true }, ctx);
    expect(r.messages.map((m: any) => m.id)).toEqual([4, 5, 6, 7, 8, 9, 10]);
    expect(r.messages[0]).toMatchObject({ id: 4, reaction: "loved" });
  });

  it("if NO allowlisted name resolves, returns nothing and holds the watermark rather than dumping every chat", async () => {
    const r = await msg("messages_since", { ...base, afterId: 3, contacts: ["Nobody Here"] }, ctx);
    expect(r).toMatchObject({ count: 0, nextAfterId: 3 });
  });
});

describe("reminders v0.2.1", () => {
  const mk = (o: Partial<Reminder>): Reminder => ({ id: "x", list: "Home", name: "n", notes: null, completed: false, dueDate: null, priority: 0, flagged: false, completionDate: null, modifiedAt: null, ...o });

  it("parses the denylist", () => {
    expect(excludedLists({ APPLE_MCP_REMINDERS_EXCLUDE: " Mela, Groceries ,," })).toEqual(["Mela", "Groceries"]);
    expect(excludedLists({})).toEqual([]);
  });

  it("modifiedAfter keeps changed items and anything without a modification date", () => {
    const items = [mk({ id: "old", modifiedAt: "2026-09-19T00:00:00.000Z" }), mk({ id: "new", modifiedAt: "2026-09-20T12:00:00.000Z" }), mk({ id: "unknown" })];
    expect(filterReminders(items, { limit: 10, modifiedAfter: "2026-09-20T00:00:00Z" }).map((r) => r.id).sort()).toEqual(["new", "unknown"]);
  });

  it("passes the denylist to JXA only as data, and reports which lists were scanned", async () => {
    const calls: any[] = [];
    const ctx = fakeCtx({ env: { APPLE_MCP_REMINDERS_EXCLUDE: "Mela,Groceries" }, jxa: (async (_s: string, args: any) => { calls.push(args); return { scanned: ["Inbox", "Home", "Brand New List"], items: [] }; }) as any });
    const r = await rem("reminders_list", { status: "incomplete", flaggedOnly: false, limit: 100 }, ctx);
    expect(calls[0]).toEqual({ list: undefined, status: "incomplete", exclude: ["Mela", "Groceries"] });
    expect(r.listsScanned).toContain("Brand New List"); // a list nobody configured is covered
  });

  it("list_lists flags excluded lists", async () => {
    const ctx = fakeCtx({ env: { APPLE_MCP_REMINDERS_EXCLUDE: "mela" }, jxa: (async () => [{ id: "1", name: "Inbox", incomplete: 1 }, { id: "2", name: "Mela", incomplete: 19 }]) as any });
    expect((await rem("reminders_list_lists", {}, ctx)).map((l: any) => l.excluded)).toEqual([false, true]);
  });

  it("reminders_status separates completed from deleted", async () => {
    const ctx = fakeCtx({ jxa: (async () => [{ id: "a", found: true, completed: true }, { id: "b", found: true, completed: false }, { id: "c", found: false }]) as any });
    expect(await rem("reminders_status", { ids: ["a", "b", "c"] }, ctx)).toMatchObject({ count: 3, completed: 1, missing: 1 });
  });
});
