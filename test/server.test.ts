import { describe, it, expect } from "vitest";
import { z } from "zod";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildServer } from "../src/core/server.js";
import { loadConfig } from "../src/core/config.js";
import { adoptClaudeEnv } from "../src/core/claude-env.js";
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

  it("accepts calendar days for message windows and rejects malformed dates", async () => {
    const client = await connect(modules, { APPLE_MCP_MESSAGES_DB: makeChatDb() });
    try {
      const all: any = await client.callTool({ name: "messages_get_chat", arguments: { chatId: 1 } });
      const message = JSON.parse(all.content[0].text).messages.find((m: any) => m.id === 1);
      const day = message.date.slice(0, 10);
      const filtered: any = await client.callTool({ name: "messages_get_chat", arguments: { chatId: 1, since: day } });
      expect(JSON.parse(filtered.content[0].text).messages.some((m: any) => m.id === 1)).toBe(true);
      const malformed: any = await client.callTool({ name: "messages_get_chat", arguments: { chatId: 1, since: "2026-9-20" } });
      expect(malformed.isError).toBe(true);
    } finally {
      await client.close();
    }
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

  it("rejects an unknown access tier and duplicate tool names at startup", async () => {
    expect(() => loadConfig({ APPLE_MCP_ACCESS: "admin" })).toThrow(/APPLE_MCP_ACCESS must be read\|write\|delete, got "admin"/);
    expect(loadConfig({ APPLE_MCP_ACCESS: "READ" }).access).toBe("read");
    expect(loadConfig({ APPLE_MCP_MODULES: " , " }).enabledModules).toBeNull();
    const dup = (id: string): AppModule => ({
      id, description: "", permissions: [],
      tools: [defineTool({ name: "same_name", title: "t", description: "d", access: "read", input: {}, handler: async () => "ok" })],
    });
    await expect(connect([dup("a"), dup("b")])).rejects.toThrow(/Duplicate tool name: same_name/);
  });

  it("wraps non-UserFacingError throws with the tool name and no hint", async () => {
    const broken: AppModule = {
      id: "broken", description: "", permissions: [],
      tools: [defineTool({ name: "broken_tool", title: "t", description: "d", access: "read", input: {}, handler: async () => { throw new TypeError("boom"); } })],
    };
    const res: any = await (await connect([broken])).callTool({ name: "broken_tool", arguments: {} });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe("Unexpected error in broken_tool: boom");
  });
});

describe("MCP server over real stdio", () => {
  const entry = resolve("dist/index.js");
  // CI runs `npm run build` first; locally a missing dist should fail loudly rather than pass vacuously.
  it("spawns dist/index.js, keeps stdout clean for the protocol, and serves a tool call", async () => {
    expect(existsSync(entry), "run `npm run build` before the test suite").toBe(true);
    const transport = new StdioClientTransport({
      command: process.execPath, args: [entry],
      env: { ...process.env, APPLE_MCP_MODULES: "messages", APPLE_MCP_MESSAGES_DB: makeChatDb() } as Record<string, string>,
      stderr: "pipe",
    });
    const client = new Client({ name: "stdio-test", version: "0" });
    const stderr: Buffer[] = [];
    // The SDK reports non-JSON stdout lines through onerror and carries on, so they must be captured to be caught.
    const protocolErrors: Error[] = [];
    client.onerror = (e) => protocolErrors.push(e);
    try {
      await client.connect(transport);
      transport.stderr?.on("data", (d: Buffer) => stderr.push(d));
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["messages_list_chats", "messages_get_chat", "messages_recent", "messages_search", "messages_since"]);
      const res: any = await client.callTool({ name: "messages_list_chats", arguments: {} });
      expect(res.isError).toBeFalsy();
      expect(JSON.parse(res.content[0].text).count).toBe(2);
    } finally {
      await client.close();
    }
    expect(protocolErrors).toEqual([]);
    expect(Buffer.concat(stderr).toString()).toMatch(/\[apple-mcp\] ready\. access=read modules=messages/);
  }, 15_000);
});

describe("doctor: adoptClaudeEnv", () => {
  const cfgFile = (mcpServers: unknown) => {
    const p = join(mkdtempSync(join(tmpdir(), "applemcp-claude-")), "claude_desktop_config.json");
    writeFileSync(p, JSON.stringify({ mcpServers }));
    return p;
  };
  const servers = {
    other: { command: "npx", args: ["some-other-mcp"], env: { APPLE_MCP_ACCESS: "delete" } },
    apple: { command: "node", args: ["/Users/me/apple-mcp/dist/index.js"], env: { APPLE_MCP_REMINDERS_EXCLUDE: "Groceries", APPLE_MCP_ACCESS: "write", PATH: "/evil", HOME: "/tmp" } },
  };

  it("adopts only APPLE_MCP_* from the apple-mcp entry and reports what it took", () => {
    const env: NodeJS.ProcessEnv = {};
    const adopted = adoptClaudeEnv(env, cfgFile(servers));
    expect(adopted.sort()).toEqual(["APPLE_MCP_ACCESS=write", "APPLE_MCP_REMINDERS_EXCLUDE=Groceries"]);
    expect(env).toEqual({ APPLE_MCP_ACCESS: "write", APPLE_MCP_REMINDERS_EXCLUDE: "Groceries" });
  });

  it("variables already set in the shell win", () => {
    const env: NodeJS.ProcessEnv = { APPLE_MCP_ACCESS: "read" };
    expect(adoptClaudeEnv(env, cfgFile(servers))).toEqual(["APPLE_MCP_REMINDERS_EXCLUDE=Groceries"]);
    expect(env.APPLE_MCP_ACCESS).toBe("read");
  });

  it("is a no-op when the config is missing, malformed, or has no apple-mcp entry", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(adoptClaudeEnv(env, "/nonexistent/claude_desktop_config.json")).toEqual([]);
    const bad = cfgFile(null); writeFileSync(bad, "{ not json");
    expect(adoptClaudeEnv(env, bad)).toEqual([]);
    expect(adoptClaudeEnv(env, cfgFile({ other: servers.other }))).toEqual([]);
    expect(env).toEqual({});
  });
});
