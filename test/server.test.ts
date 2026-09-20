import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/core/server.js";
import { loadConfig } from "../src/core/config.js";
import { modules } from "../src/modules/index.js";
import { defineTool, type AppModule } from "../src/core/types.js";
import { makeChatDb, fakeCtx } from "./fixtures.js";

async function connect(mods: AppModule[], env: Record<string, string> = {}) {
  const ctx = fakeCtx({ env });
  const server = buildServer(mods, loadConfig(env), ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

describe("MCP server end to end", () => {
  it("exposes every v1 tool, all flagged read-only", async () => {
    const { tools } = await (await connect(modules)).listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "contacts_resolve", "contacts_search",
      "messages_get_chat", "messages_list_chats", "messages_recent", "messages_search", "messages_since",
      "reminders_get", "reminders_list", "reminders_list_lists", "reminders_search", "reminders_status",
    ]);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });

  it("serves a real tool call over the protocol, applying schema defaults", async () => {
    const client = await connect(modules, { APPLE_MCP_MESSAGES_DB: makeChatDb() });
    const res: any = await client.callTool({ name: "messages_list_chats", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0].text).count).toBe(2);
  });

  it("returns failures as tool errors with the hint, not protocol crashes", async () => {
    const res: any = await (await connect(modules)).callTool({ name: "messages_recent", arguments: {} });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Full Disk Access/);
  });

  it("rejects invalid input at the schema", async () => {
    const res: any = await (await connect(modules)).callTool({ name: "messages_search", arguments: { query: "a" } });
    expect(res.isError).toBe(true);
  });

  it("APPLE_MCP_MODULES limits what loads; unknown ids fail fast", async () => {
    const { tools } = await (await connect(modules, { APPLE_MCP_MODULES: "reminders" })).listTools();
    expect(tools.every((t) => t.name.startsWith("reminders_"))).toBe(true);
    await expect(connect(modules, { APPLE_MCP_MODULES: "nope" })).rejects.toThrow(/Unknown module/);
  });

  it("write-tier tools stay unregistered unless access is raised", async () => {
    const future: AppModule = {
      id: "future", description: "", permissions: [],
      tools: [
        defineTool({ name: "future_read", title: "r", description: "d", access: "read", input: {}, handler: async () => "ok" }),
        defineTool({ name: "future_create", title: "c", description: "d", access: "write", input: { x: z.string() }, handler: async () => "ok" }),
      ],
    };
    const names = async (env = {}) => (await (await connect([future], env)).listTools()).tools.map((t) => t.name);
    expect(await names()).toEqual(["future_read"]);
    expect(await names({ APPLE_MCP_ACCESS: "write" })).toEqual(["future_read", "future_create"]);
  });
});
