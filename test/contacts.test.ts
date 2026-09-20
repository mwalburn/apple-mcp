import { describe, it, expect, beforeAll } from "vitest";
import { handleKey, cleanLabel, loadContacts, searchContacts, makeResolver } from "../src/modules/contacts/directory.js";
import { contactsModule } from "../src/modules/contacts/index.js";
import { messagesModule } from "../src/modules/messages/index.js";
import { makeChatDb, makeContactsDir, fakeCtx } from "./fixtures.js";
import type { ModuleContext } from "../src/core/types.js";

const msg = (n: string, a: any, ctx: any) => messagesModule.tools.find((t) => t.name === n)!.handler(a, ctx) as Promise<any>;

function wiredCtx(env: Record<string, string>): ModuleContext {
  const ctx = fakeCtx({ env });
  Object.assign(ctx.services, contactsModule.provide!(ctx));
  return ctx;
}

describe("contacts primitives", () => {
  it("keys phones on last 10 digits and emails case-insensitively", () => {
    for (const v of ["+1 (651) 555-0100", "6515550100", "1-651-555-0100"]) expect(handleKey(v)).toBe("6515550100");
    expect(handleKey("Pat@Example.COM")).toBe("pat@example.com");
    expect(handleKey("12")).toBeNull();
  });
  it("cleans Apple's label encoding", () => {
    expect(cleanLabel("_$!<Mobile>!$_")).toBe("mobile");
    expect(cleanLabel("iPhone")).toBe("iphone");
    expect(cleanLabel(null)).toBeNull();
  });
});

describe("contacts directory against a fixture AddressBook", () => {
  let ctx: ModuleContext;
  beforeAll(() => { ctx = wiredCtx({ APPLE_MCP_CONTACTS_DIR: makeContactsDir() }); });

  it("merges stores, dedupes handles, drops nameless records, falls back to organization", () => {
    const all = loadContacts(ctx);
    expect(all.map((c) => c.name)).toEqual(["Acme Plumbing", "Alex Chen", "Alex Rivera", "Alexandria Dental", "Dad💖", "Pat Oldfriend", "Pat Rivera"]);
    const alex = all.find((c) => c.name === "Alex Rivera")!;
    // Two stores hold the same mobile in different formats: one survives. Which format wins is store-order dependent.
    expect(alex.phones.map((p) => handleKey(p.value)).sort()).toEqual(["6515550100", "6515550177"]);
    expect(alex.phones.find((p) => handleKey(p.value) === "6515550100")!.label).toBe("mobile");
    expect(alex.emails.map((e) => e.value)).toEqual(["alex@example.com"]); // only in the iCloud store, still merged in
  });

  it("ranks exact and whole-word name matches first; finds by nickname, org, phone, email", () => {
    const all = loadContacts(ctx);
    const names = (q: string) => searchContacts(all, q, 10).map((c) => c.name);
    expect(names("alex rivera")[0]).toBe("Alex Rivera");
    expect(names("Rivera")).toEqual(["Alex Rivera", "Pat Rivera"]);
    expect(names("alex")).toContain("Alexandria Dental"); // contacts_search stays broad; only disambiguation is tiered
    expect(names("patty")).toEqual(["Pat Rivera"]);
    expect(names("plumb")).toEqual(["Acme Plumbing"]);
    expect(names("612.555.0199")).toEqual(["Acme Plumbing"]);
    expect(names("PAT@example.com")).toEqual(["Pat Rivera"]);
    expect(names("zzz")).toEqual([]);
  });

  it("contacts_resolve maps handles in whatever format they arrive", async () => {
    const t = contactsModule.tools.find((x) => x.name === "contacts_resolve")!;
    const r: any = await t.handler({ handles: ["+16515550100", "pat@example.com", "+19995550000"] }, ctx);
    expect(r.results).toEqual([
      { handle: "+16515550100", name: "Alex Rivera" },
      { handle: "pat@example.com", name: "Pat Rivera" },
      { handle: "+19995550000", name: null },
    ]);
  });

  it("caches within the TTL and reloads after it", () => {
    let loads = 0;
    const counting = { ...ctx, env: new Proxy(ctx.env, { get: (t, k) => { if (k === "APPLE_MCP_CONTACTS_DIR") loads++; return (t as any)[k]; } }) };
    const r = makeResolver(counting, 10_000);
    r.resolve(["+16515550100"]); r.resolve(["+16515550100"]);
    const afterTwo = loads;
    r.resolve(["pat@example.com"]);
    expect(loads).toBe(afterTwo); // no further reads
    const r0 = makeResolver(counting, 0);
    r0.resolve(["x@y.z"]); const a = loads; r0.resolve(["x@y.z"]);
    expect(loads).toBeGreaterThan(a);
  });

  it("reports unreadable contacts as a permissions problem", () => {
    expect(() => loadContacts(fakeCtx({ env: { APPLE_MCP_CONTACTS_DIR: "/nonexistent" } }))).toThrow(/No Contacts database/);
  });
});

describe("messages + contacts integration", () => {
  let ctx: ModuleContext;
  beforeAll(() => { ctx = wiredCtx({ APPLE_MCP_MESSAGES_DB: makeChatDb(), APPLE_MCP_CONTACTS_DIR: makeContactsDir() }); });

  it("adds senderName inline, never on my own messages, and leaves unknowns raw", async () => {
    const r = await msg("messages_recent", { sinceHours: 24, incomingOnly: false, limit: 100 }, ctx);
    const by = (id: number) => r.messages.find((m: any) => m.id === id);
    expect(by(1)).toMatchObject({ sender: "+16515550100", senderName: "Alex Rivera" });
    expect(by(5)).toMatchObject({ sender: "pat@example.com", senderName: "Pat Rivera" });
    expect(by(6)).toMatchObject({ sender: "+16125550199", senderName: "Acme Plumbing" });
    expect(by(3).senderName).toBeUndefined();
  });

  it("names participants in the chat list", async () => {
    const r = await msg("messages_list_chats", { limit: 25, sinceDays: 90 }, ctx);
    expect(r.chats.find((c: any) => c.chatId === 1).participants).toEqual([{ handle: "+16515550100", name: "Alex Rivera" }]);
  });

  it("reads a conversation by contact name, across all of that contact's handles", async () => {
    const r = await msg("messages_get_chat", { contact: "alex rivera", limit: 50, includeReactions: false }, ctx);
    expect(r.contact).toBe("Alex Rivera");
    expect(r.messages.map((m: any) => m.id)).toEqual([8, 1, 2, 3, 9]);
  });

  it("an exact full-name match wins over partial matches", async () => {
    const r = await msg("messages_search", { query: "needle", contact: "Pat Rivera", limit: 5, scanLimit: 1000 }, ctx);
    expect(r).toMatchObject({ contact: "Pat Rivera", count: 1 });
  });

  it("errors clearly for an unknown contact", async () => {
    await expect(msg("messages_get_chat", { contact: "Nobody Here", limit: 5, includeReactions: false }, ctx)).rejects.toThrow(/No contact/);
  });

  it("fails soft: unreadable contacts never break messages", async () => {
    const broken = wiredCtx({ APPLE_MCP_MESSAGES_DB: makeChatDb(), APPLE_MCP_CONTACTS_DIR: "/nonexistent" });
    const r = await msg("messages_recent", { sinceHours: 24, incomingOnly: false, limit: 100 }, broken);
    expect(r.count).toBeGreaterThan(0);
    expect(r.messages.every((m: any) => m.senderName === undefined)).toBe(true);
  });

  it("without the contacts module, contact lookup says so and handle lookup still works", async () => {
    const bare = fakeCtx({ env: { APPLE_MCP_MESSAGES_DB: makeChatDb() } });
    await expect(msg("messages_get_chat", { contact: "Alex", limit: 5, includeReactions: false }, bare)).rejects.toThrow(/contacts module/);
    expect((await msg("messages_get_chat", { handle: "6515550100", limit: 5, includeReactions: false }, bare)).count).toBeGreaterThan(0);
  });
});
