import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ModuleContext } from "../../core/types.js";

/**
 * The "Urgent" toggle is private to Reminders.app: neither the AppleScript
 * dictionary nor public EventKit exposes it. It is stored in the app's Core
 * Data stores, one per account:
 *
 *   ~/Library/Group Containers/group.com.apple.reminders/Container_v1/Stores/Data-*.sqlite
 *   ZREMCDREMINDER.ZISURGENTSTATEENABLEDFORCURRENTUSER
 *
 * This module reads that one flag, read-only, and joins it onto reminders
 * fetched through JXA. JXA stays the source of truth for everything else.
 *
 * The schema is undocumented, so every step fails soft: if the store, table,
 * or column is missing, or an id cannot be matched, `urgent` is null
 * ("unknown"), never false. A sync must not read "could not tell" as "not urgent".
 */
const URGENT_COL = "ZISURGENTSTATEENABLEDFORCURRENTUSER";
/** Which column carries the UUID seen in x-apple-reminder:// ids is not documented, so all are indexed. */
const ID_COLS = ["ZCKIDENTIFIER", "ZIDENTIFIER", "ZDACALENDARITEMUNIQUEIDENTIFIER"];

export function storeDir(ctx: ModuleContext): string {
  return ctx.env.APPLE_MCP_REMINDERS_STORE_DIR
    ?? join(ctx.homeDir, "Library", "Group Containers", "group.com.apple.reminders", "Container_v1", "Stores");
}

/** "x-apple-reminder://EF49-..." | "EF49-..." | 16-byte blob -> 32 uppercase hex chars, or null. */
export function normalizeId(v: unknown): string | null {
  if (v instanceof Uint8Array) return v.length === 16 ? Buffer.from(v).toString("hex").toUpperCase() : null;
  if (typeof v !== "string") return null;
  const hex = v.replace(/^x-apple-reminder:\/\//i, "").replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  return hex.length === 32 ? hex : null;
}

export interface UrgencyIndex {
  /** normalized id -> urgent */
  byId: Map<string, boolean>;
  stores: number;
}

export function loadUrgency(ctx: ModuleContext): UrgencyIndex | null {
  try {
    const dir = storeDir(ctx);
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir).filter((f) => /^Data-.*\.sqlite$/.test(f)).sort();
    const byId = new Map<string, boolean>();
    let stores = 0;
    for (const f of files) {
      let db: DatabaseSync | null = null;
      try {
        db = new DatabaseSync(join(dir, f), { readOnly: true });
        const cols = new Set((db.prepare(`SELECT name FROM pragma_table_info('ZREMCDREMINDER')`).all() as { name: string }[]).map((c) => c.name));
        if (!cols.has(URGENT_COL)) continue;
        const idCols = ID_COLS.filter((c) => cols.has(c));
        if (!idCols.length) continue;
        const rows = db.prepare(`SELECT ${idCols.join(", ")}, ${URGENT_COL} AS urgent FROM ZREMCDREMINDER`).all() as Record<string, unknown>[];
        for (const r of rows) {
          const urgent = Number(r.urgent ?? 0) === 1;
          for (const c of idCols) {
            const k = normalizeId(r[c]);
            // The same reminder can exist in more than one store; urgent in any copy wins.
            if (k) byId.set(k, (byId.get(k) ?? false) || urgent);
          }
        }
        stores++;
      } catch { /* one unreadable store must not hide the others */ } finally { db?.close(); }
    }
    return stores ? { byId, stores } : null;
  } catch {
    return null;
  }
}

export function urgencyOf(index: UrgencyIndex | null, reminderId: string): boolean | null {
  if (!index) return null;
  const k = normalizeId(reminderId);
  if (!k) return null;
  return index.byId.has(k) ? index.byId.get(k)! : null;
}
