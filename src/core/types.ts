import type { z } from "zod";

/**
 * Access tiers. The server registers only tools at or below the configured
 * tier (APPLE_MCP_ACCESS, default "read"). v1 ships read tools only; the tier
 * exists so write/delete tools can be added later without being exposed by
 * default.
 */
export type AccessLevel = "read" | "write" | "delete";
export const ACCESS_ORDER: Record<AccessLevel, number> = { read: 0, write: 1, delete: 2 };

export interface ToolDef<Shape extends z.ZodRawShape = z.ZodRawShape> {
  /** Globally unique. Convention: `<module>_<verb>`. */
  name: string;
  title: string;
  description: string;
  access: AccessLevel;
  /** Zod raw shape; the SDK turns it into JSON Schema and validates input. */
  input: Shape;
  handler: (args: z.infer<z.ZodObject<Shape>>, ctx: ModuleContext) => Promise<unknown>;
}

export interface AppModule {
  /** Short id used in APPLE_MCP_MODULES, e.g. "reminders". */
  id: string;
  description: string;
  /** macOS permissions the module needs. Shown by `npm run doctor`. */
  permissions: string[];
  tools: ToolDef<any>[];
  /** Optional self-check used by the doctor command. */
  check?: (ctx: ModuleContext) => Promise<string>;
  /** Optional: publish services for other modules. Called once at startup. */
  provide?: (ctx: ModuleContext) => Partial<Services>;
}

/**
 * Cross-module services. A module publishes one via `AppModule.provide`;
 * consumers must treat every entry as optional, because the providing module
 * may be disabled or lack permission. No module imports another module.
 */
export interface Services {
  handleResolver?: HandleResolver;
}
export interface ResolvedContact { name: string; handles: string[] }
export interface HandleResolver {
  /** handle (phone/email, any formatting) -> display name. Unknown handles are absent. Never throws. */
  resolve(handles: string[]): Map<string, string>;
  /** Contacts whose name matches. Throws UserFacingError if contacts are unreadable. */
  findByName(query: string): ResolvedContact[];
}

/** Everything a module may touch. Injected so tests can fake it. */
export interface ModuleContext {
  jxa: <T = unknown>(script: string, args?: unknown) => Promise<T>;
  env: NodeJS.ProcessEnv;
  homeDir: string;
  services: Services;
}

/** Helper that preserves input typing for handlers. */
export function defineTool<Shape extends z.ZodRawShape>(t: ToolDef<Shape>): ToolDef<Shape> {
  return t;
}

export class UserFacingError extends Error {
  constructor(message: string, public hint?: string) {
    super(message);
  }
}
