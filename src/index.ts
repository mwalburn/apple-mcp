#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./core/server.js";
import { loadConfig } from "./core/config.js";
import { modules } from "./modules/index.js";
import { realContext } from "./context.js";

// stdout carries the MCP protocol. All logging must go to stderr.
process.removeAllListeners("warning");
process.on("warning", (w) => { if (w.name !== "ExperimentalWarning") console.error(w); });

if (process.platform !== "darwin") console.error("[apple-mcp] warning: not macOS; every tool call will fail.");

const cfg = loadConfig(process.env);
const server = buildServer(modules, cfg, realContext());
await server.connect(new StdioServerTransport());
console.error(`[apple-mcp] ready. access=${cfg.access} modules=${cfg.enabledModules?.join(",") ?? "all"}`);
