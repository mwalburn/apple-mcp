import { describe, it, expect, beforeAll } from "vitest";
import { decodeAttributedBody, encodeAttributedBodyForTest } from "../src/modules/messages/decode.js";
import { appleMsToIso, isoToAppleNs, handleClause, escapeLike } from "../src/modules/messages/db.js";
import { messagesModule } from "../src/modules/messages/index.js";
import { contactsModule } from "../src/modules/contacts/index.js";
import { makeChatDb, makeContactsDir, fakeCtx } from "./fixtures.js";
import type { ModuleContext } from "../src/core/types.js";

const tool = (n: string) => messagesModule.tools.find((t) => t.name === n)!;
const call = (n: string, args: any, ctx: any) => tool(n).handler(args, ctx) as Promise<any>;
const msg = (n: string, args: any, ctx: any) => tool(n).handler(args, ctx) as Promise<any>;
function wired(env: Record<string, string>): ModuleContext {
  const ctx = fakeCtx({ env });
  Object.assign(ctx.services, contactsModule.provide!(ctx));
  return ctx;
}

describe("attributedBody decoder", () => {
  it("decodes short, 16-bit-length and unicode bodies", () => {
    expect(decodeAttributedBody(encodeAttributedBodyForTest("hi"))).toBe("hi");
    const long = "é".repeat(500);
    expect(decodeAttributedBody(encodeAttributedBodyForTest(long))).toBe(long);
    expect(decodeAttributedBody(encodeAttributedBodyForTest("plain NSString", false))).toBe("plain NSString");
  });
  it("decodes the 32-bit (0x82) length prefix used for bodies over 64 KiB", () => {
    const huge = "ab".repeat(40_000); // 80,000 bytes > 0xffff
    const blob = encodeAttributedBodyForTest(huge);
    expect(blob.indexOf(Buffer.from([0x2b, 0x82]))).toBeGreaterThan(0);
    expect(decodeAttributedBody(blob)).toBe(huge);
    // A declared length that overruns the buffer is rejected, not read out of bounds.
    expect(decodeAttributedBody(blob.subarray(0, blob.length - 10))).toBeNull();
  });
  it("returns null on garbage instead of throwing", () => {
    expect(decodeAttributedBody(null)).toBeNull();
    expect(decodeAttributedBody(Buffer.from("no markers here"))).toBeNull();
    expect(decodeAttributedBody(Buffer.from("NSString\x01\x2b\xff"))).toBeNull();
  });
  it("strips attachment placeholders", () => {
    expect(decodeAttributedBody(encodeAttributedBodyForTest("\uFFFCphoto caption"))).toBe("photo caption");
  });
});

describe("helpers", () => {
  it("round-trips Apple time and handles legacy seconds", () => {
    const iso = "2026-09-19T15:00:00.000Z";
    expect(appleMsToIso(Number(isoToAppleNs(iso) / 1_000_000n))).toBe(iso);
    expect(appleMsToIso(0)).toBeNull();
    expect(isoToAppleNs(iso) > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true); // why BigInt is required
  });
  it("normalises handles", () => {
    expect(handleClause("(651) 555-0100").param).toBe("%6515550100");
    expect(handleClause("+1 651 555 0100").param).toBe("%6515550100");
    expect(handleClause("Pat@Example.com").param).toBe("pat@example.com");
    expect(() => handleClause("12")).toThrow();
  });
  it("escapes LIKE wildcards", () => expect(escapeLike("100%_a\\")).toBe("100\\%\\_a\\\\"));
});

describe("messages tools against a fixture chat.db", () => {
  let ctx: any;
  beforeAll(() => { ctx = fakeCtx({ env: { APPLE_MCP_MESSAGES_DB: makeChatDb() } }); });

  it("lists chats newest-first with participants", async () => {
    const r = await call("messages_list_chats", { limit: 25, sinceDays: 90 }, ctx);
    expect(r.chats.map((c: any) => c.chatId)).toEqual([2, 1]);
    expect(r.chats[0]).toMatchObject({ name: "Trip planning", isGroup: true, messagesInWindow: 3 });
    expect(r.chats[0].participants.map((p: any) => p.handle).sort()).toEqual(["+16125550199", "pat@example.com"]);
    expect(r.chats[0].participants.every((p: any) => p.name === null)).toBe(true); // no contacts module wired
  });

  it("reads a chat by loosely formatted handle, chronological, reactions hidden by default", async () => {
    const r = await call("messages_get_chat", { handle: "651-555-0100", limit: 50, includeReactions: false }, ctx);
    expect(r.messages.map((m: any) => m.id)).toEqual([8, 1, 2, 3, 9]);
    expect(r.messages[2].text).toBe("Body only in attributedBody");
    expect(r.messages[3]).toMatchObject({ fromMe: true, sender: "me", text: "Reply from me — with unicode ✓" });
  });

  it("pages backwards with until and treats since/until as a half-open window", async () => {
    const all = await call("messages_get_chat", { chatId: 1, limit: 50, includeReactions: false }, ctx);
    const dateOf = (id: number) => all.messages.find((m: any) => m.id === id).date;
    const ids = async (a: any) => (await call("messages_get_chat", { chatId: 1, limit: 50, includeReactions: false, ...a }, ctx)).messages.map((m: any) => m.id);
    expect(await ids({ until: dateOf(3) })).toEqual([8, 1, 2]);              // until is exclusive
    expect(await ids({ since: dateOf(2), until: dateOf(9) })).toEqual([2, 3]); // since is inclusive
    expect(await ids({ since: dateOf(9) })).toEqual([9]);
    expect(await ids({ since: dateOf(9), until: dateOf(9) })).toEqual([]);
  });

  it("labels reactions when asked", async () => {
    const r = await call("messages_get_chat", { chatId: 1, limit: 50, includeReactions: true }, ctx);
    expect(r.messages.find((m: any) => m.id === 4).reaction).toBe("loved");
  });

  it("requires chatId or handle", async () => {
    await expect(call("messages_get_chat", { limit: 5, includeReactions: false }, ctx)).rejects.toThrow(/chatId, handle, or contact/);
  });

  it("recent respects the window and incomingOnly", async () => {
    const r = await call("messages_recent", { sinceHours: 24, incomingOnly: true, limit: 100 }, ctx);
    expect(r.messages.map((m: any) => m.id)).toEqual([10, 6, 5, 2, 1]);
  });

  it("searches both the text column and decoded blobs", async () => {
    const base = { limit: 25, scanLimit: 50_000 };
    expect((await call("messages_search", { ...base, query: "needle-in-long" }, ctx)).messages[0].id).toBe(5);
    expect((await call("messages_search", { ...base, query: "PLAIN TEXT" }, ctx)).messages[0].id).toBe(1);
    // '%' and '_' must be literal, not wildcards
    expect((await call("messages_search", { ...base, query: "100%" }, ctx)).count).toBe(1);
    expect((await call("messages_search", { ...base, query: "sure_" }, ctx)).count).toBe(1);
    expect((await call("messages_search", { ...base, query: "zzz" }, ctx)).count).toBe(0);
  });

  it("reports scanned and truncated when scanLimit is exhausted before the window", async () => {
    const big = fakeCtx({ env: { APPLE_MCP_MESSAGES_DB: makeChatDb({ filler: 150 }) } });
    // 150 filler rows are newer than every base row, so a limit of 100 never reaches them.
    const cut = await call("messages_search", { query: "Plain text", limit: 25, scanLimit: 100 }, big);
    expect(cut).toMatchObject({ count: 0, scanned: 100, truncated: true });
    // Once `limit` hits are found the scan stops early and is not reported as truncated.
    const full = await call("messages_search", { query: "filler", limit: 5, scanLimit: 100 }, big);
    expect(full).toMatchObject({ count: 5, scanned: 5, truncated: false });
    // Exhausting the window under scanLimit is not truncation either.
    const done = await call("messages_search", { query: "Plain text", limit: 25, scanLimit: 1000 }, big);
    expect(done).toMatchObject({ count: 1, truncated: false });
    expect(done.scanned).toBeLessThan(1000);
  });

  it("scopes search by chat and date", async () => {
    const r = await call("messages_search", { query: "message", limit: 25, scanLimit: 50_000, chatId: 2, since: new Date(Date.now() - 86_400_000).toISOString() }, ctx);
    expect(r.count).toBe(0); // "Old message" is outside the window
  });

  it("rejects SQL injection via handle as a plain non-match", async () => {
    const r = await call("messages_get_chat", { handle: "x@y.com' OR '1'='1", limit: 50, includeReactions: false }, ctx);
    expect(r.count).toBe(0);
  });

  it("cannot write: the connection is read-only", async () => {
    const { withDb } = await import("../src/modules/messages/db.js");
    expect(() => withDb(ctx, (db) => db.exec("DELETE FROM message"))).toThrow(/readonly|read-only/i);
  });

  it("gives a Full Disk Access hint when the db is missing", async () => {
    await expect(call("messages_recent", { sinceHours: 1, incomingOnly: false, limit: 1 }, fakeCtx())).rejects.toMatchObject({ hint: expect.stringMatching(/Full Disk Access/) });
  });
});

describe("legacy date handling", () => {
  it("reads rows stored as seconds", async () => {
    const ctx = fakeCtx({ env: { APPLE_MCP_MESSAGES_DB: makeChatDb() } });
    const r = await call("messages_get_chat", { chatId: 1, limit: 50, includeReactions: false }, ctx);
    expect(r.messages[0]).toMatchObject({ id: 8, date: "2016-11-05T00:53:20.000Z" });
  });
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
    expect(seen).toEqual([1, 2, 3, 5, 6, 7, 8, 9, 10]);
  });

  it("filters to an allowlist, still advances the watermark past everyone else's chatter", async () => {
    const r = await msg("messages_since", { ...base, afterId: 0, contacts: ["Alex Rivera"] }, ctx);
    expect(new Set(r.messages.map((m: any) => m.chatId))).toEqual(new Set([1]));
    expect(r.nextAfterId).toBe(10);
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
    expect(r.messages.map((m: any) => m.id)).toEqual([5, 6, 7, 10]);
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
