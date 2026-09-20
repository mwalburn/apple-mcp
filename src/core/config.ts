import { ACCESS_ORDER, type AccessLevel } from "./types.js";

export interface ServerConfig {
  access: AccessLevel;
  /** null = all registered modules */
  enabledModules: string[] | null;
}

export function loadConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const rawAccess = (env.APPLE_MCP_ACCESS ?? "read").toLowerCase();
  if (!(rawAccess in ACCESS_ORDER))
    throw new Error(`APPLE_MCP_ACCESS must be read|write|delete, got "${rawAccess}"`);
  const mods = env.APPLE_MCP_MODULES?.split(",").map((s) => s.trim()).filter(Boolean);
  return { access: rawAccess as AccessLevel, enabledModules: mods?.length ? mods : null };
}
