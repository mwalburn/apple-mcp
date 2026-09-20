import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CLAUDE_CONFIG_PATH = join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");

/**
 * Picks the APPLE_MCP_* env vars Claude Desktop would pass to this server, so
 * a Terminal run (the doctor) tests what Claude will actually run.
 * Variables already present in `env` win; only the newly adopted ones are returned.
 */
export function adoptClaudeEnv(env: NodeJS.ProcessEnv = process.env, configPath = CLAUDE_CONFIG_PATH): string[] {
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    const servers = cfg?.mcpServers ?? {};
    const entry: any = Object.values(servers).find((s: any) => (s?.args ?? []).some((a: string) => /apple-mcp/.test(String(a))));
    const adopted: string[] = [];
    for (const [k, v] of Object.entries(entry?.env ?? {}))
      if (k.startsWith("APPLE_MCP_") && env[k] === undefined) { env[k] = String(v); adopted.push(`${k}=${v}`); }
    return adopted;
  } catch { return []; }
}
