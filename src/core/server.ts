import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ACCESS_ORDER, UserFacingError, type AppModule, type ModuleContext } from "./types.js";
import type { ServerConfig } from "./config.js";
import { VERSION } from "./version.js";

export function selectModules(all: AppModule[], cfg: ServerConfig): AppModule[] {
  if (!cfg.enabledModules) return all;
  const unknown = cfg.enabledModules.filter((id) => !all.some((m) => m.id === id));
  if (unknown.length) throw new Error(`Unknown module(s) in APPLE_MCP_MODULES: ${unknown.join(", ")}`);
  return all.filter((m) => cfg.enabledModules!.includes(m.id));
}

export function buildServer(modules: AppModule[], cfg: ServerConfig, ctx: ModuleContext): McpServer {
  const server = new McpServer({ name: "apple-mcp", version: VERSION });
  const seen = new Set<string>();
  const selected = selectModules(modules, cfg);

  // Wire services before any handler can run, so module order is irrelevant.
  for (const mod of selected) if (mod.provide) Object.assign(ctx.services, mod.provide(ctx));

  for (const mod of selected) {
    for (const tool of mod.tools) {
      if (seen.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
      seen.add(tool.name);
      // Tools above the configured tier are never registered, so a client
      // cannot call them even if it guesses the name.
      if (ACCESS_ORDER[tool.access] > ACCESS_ORDER[cfg.access]) continue;

      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: tool.input,
          annotations: {
            readOnlyHint: tool.access === "read",
            destructiveHint: tool.access === "delete",
            openWorldHint: false,
          },
        },
        async (args: any) => {
          try {
            const result = await tool.handler(args, ctx);
            return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
          } catch (e: any) {
            const text =
              e instanceof UserFacingError
                ? [e.message, e.hint].filter(Boolean).join("\n")
                : `Unexpected error in ${tool.name}: ${e?.message ?? e}`;
            return { isError: true, content: [{ type: "text" as const, text }] };
          }
        },
      );
    }
  }
  return server;
}
