import { homedir } from "node:os";
import { makeJxaRunner } from "./core/jxa.js";
import type { ModuleContext } from "./core/types.js";

export function realContext(): ModuleContext {
  return { jxa: makeJxaRunner(undefined, Number(process.env.APPLE_MCP_JXA_TIMEOUT_MS) || 60_000), env: process.env, homeDir: homedir(), services: {} };
}
