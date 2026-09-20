import { describe, it, expect, beforeAll } from "vitest";
import { decodeAttributedBody, encodeAttributedBodyForTest } from "../src/modules/messages/decode.js";
import { appleMsToIso, isoToAppleNs, handleClause, escapeLike } from "../src/modules/messages/db.js";
import { messagesModule } from "../src/modules/messages/index.js";
import { makeChatDb, fakeCtx } from "./fixtures.js";

const tool = (n: string) => messagesModule.tools.find((t) => t.name === n)!;
const call = (n: string, args: any, ctx: any) => tool(n).handler(args, ctx) as Promise<any>;

describe("attributedBody decoder", () => {
  it("decodes short, 16-bit-length and unicode bodies", () => {
    expect(decodeAttributedBody(encodeAttributedBodyForTest("hi"))).toBe("hi");
    const long = "é".repeat(500);
    expect(decodeAttributedBody(encodeAttributedBodyForTest(long))).toBe(long);
    expect(decodeAttributedBody(encodeAttributedBodyForTest("plain NSString", false))).toBe("plain NSString");
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
