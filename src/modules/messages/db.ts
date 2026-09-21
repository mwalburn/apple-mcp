import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { UserFacingError, type ModuleContext } from "../../core/types.js";
import { decodeAttributedBody } from "./decode.js";

const APPLE_EPOCH_OFFSET_S = 978_307_200; // 2001-01-01T00:00:00Z

export function dbPath(ctx: ModuleContext): string {
  return ctx.env.APPLE_MCP_MESSAGES_DB ?? join(ctx.homeDir, "Library", "Messages", "chat.db");
}

/**
 * Opened read-only per call and closed immediately: always-fresh data, no
 * lingering handle on a database Messages.app is actively writing, and the
 * readOnly flag makes writes impossible at the SQLite layer regardless of
 * what SQL this module contains.
 */
export function withDb<T>(ctx: ModuleContext, fn: (db: DatabaseSync) => T): T {
  const path = dbPath(ctx);
  if (!existsSync(path))
    throw new UserFacingError(
      `Messages database not found or not readable at ${path}.`,
      "Grant Full Disk Access to the host app (System Settings > Privacy & Security > Full Disk Access), then restart it.",
    );
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (e: any) {
    throw new UserFacingError(
      `Could not open the Messages database: ${e?.message ?? e}`,
      "This is almost always missing Full Disk Access for the host app (Claude, Terminal, etc.). Grant it and restart the app.",
    );
  }
  try {
    return fn(db);
  } catch (e: any) {
    if (/authorization denied|unable to open|not authorized/i.test(String(e?.message)))
      throw new UserFacingError("macOS denied access to the Messages database.", "Grant Full Disk Access to the host app and restart it.");
    throw e;
  } finally {
    db.close();
  }
}

/**
 * Modern macOS stores nanoseconds since 2001-01-01, which overflows JS's safe
 * integer range (node:sqlite throws on read). So SQL converts to milliseconds
 * before values reach JS (DATE_MS), and bounds are bound as BigInt going in.
 * Older rows stored plain seconds; DATE_MS handles both.
 */
/** Values above this are nanoseconds; at or below, legacy seconds. */
const NS_THRESHOLD = 100_000_000_000n;

export const DATE_MS = (col: string) =>
  `CASE WHEN ${col} > ${NS_THRESHOLD} THEN ${col} / 1000000 ELSE ${col} * 1000 END`;

/** WHERE fragment bounding an Apple-epoch column by an instant, for both ns rows and legacy seconds rows. */
export function dateBound(col: string, op: ">=" | "<", iso: string): { sql: string; params: bigint[] } {
  const ns = isoToAppleNs(iso);
  const s = ns >= 0n ? (ns + 999_999_999n) / 1_000_000_000n : ns / 1_000_000_000n;
  return op === ">="
    ? { sql: `(${col} >= ? OR ${col} BETWEEN ? AND ${NS_THRESHOLD})`, params: [ns, s] }
    : { sql: `(${col} < ? AND (${col} > ${NS_THRESHOLD} OR ${col} < ?))`, params: [ns, s] };
}

export function appleMsToIso(ms: number | null): string | null {
  if (!ms) return null;
  return new Date(ms + APPLE_EPOCH_OFFSET_S * 1000).toISOString();
}
export function isoToAppleNs(iso: string): bigint {
  return (BigInt(Date.parse(iso)) - BigInt(APPLE_EPOCH_OFFSET_S) * 1000n) * 1_000_000n;
}

export interface MessageRow {
  id: number; guid: string; text: string | null; attributedBody: Uint8Array | null;
  date_ms: number; is_from_me: number; service: string | null; cache_has_attachments: number;
  amt: number | null; handle: string | null; chat_id: number;
}
export interface Message {
  /** ROWID. Monotonic on this Mac: use as a watermark. Not stable across a database rebuild. */
  id: number;
  /** Globally stable message identifier: use as a dedup key. */
  guid: string;
  chatId: number; date: string | null; fromMe: boolean; sender: string;
  /** Contact name for `sender`, when the contacts module can resolve it. */
  senderName?: string;
  /** Present when secret-looking content was masked in `text`. */
  redacted?: true;
  text: string | null; service: string | null; hasAttachments: boolean; reaction?: string;
}

const REACTIONS: Record<number, string> = {
  2000: "loved", 2001: "liked", 2002: "disliked", 2003: "laughed", 2004: "emphasized", 2005: "questioned",
  2006: "emoji", 2007: "sticker",
};

export function toMessage(r: MessageRow): Message {
  const text = r.text && r.text.trim().length ? r.text.replace(/\uFFFC/g, "").trim() || null : decodeAttributedBody(r.attributedBody);
  const amt = r.amt ?? 0;
  const m: Message = {
    id: r.id, guid: r.guid, chatId: r.chat_id, date: appleMsToIso(r.date_ms), fromMe: !!r.is_from_me,
    sender: r.is_from_me ? "me" : r.handle ?? "unknown",
    text, service: r.service, hasAttachments: !!r.cache_has_attachments,
  };
  if (amt >= 2000 && amt < 3000) m.reaction = REACTIONS[amt] ?? `reaction_${amt}`;
  else if (amt >= 3000 && amt < 4000) m.reaction = `removed_${REACTIONS[amt - 1000] ?? amt}`;
  return m;
}

export const MESSAGE_SELECT = `
  SELECT m.ROWID AS id, m.guid, m.text, m.attributedBody, ${DATE_MS("m.date")} AS date_ms, m.is_from_me, m.service,
         m.cache_has_attachments, m.associated_message_type AS amt, h.id AS handle, cmj.chat_id
  FROM message m
  JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  LEFT JOIN handle h ON h.ROWID = m.handle_id`;

export const NOT_REACTION = `(m.associated_message_type IS NULL OR m.associated_message_type < 2000 OR m.associated_message_type >= 4000)`;

/**
 * Handles are stored as E.164 numbers or lowercase emails. Callers rarely
 * know the exact stored form, so numbers match on their last 10 digits.
 */
export function handleClause(handle: string): { sql: string; param: string } {
  if (handle.includes("@")) return { sql: `LOWER(h2.id) = ?`, param: handle.trim().toLowerCase() };
  const digits = handle.replace(/\D/g, "");
  if (digits.length < 7) throw new UserFacingError(`"${handle}" is not a usable phone number or email.`);
  return { sql: `h2.id LIKE ?`, param: `%${digits.slice(-10)}` };
}
export const CHATS_WITH_HANDLE = (clause: string) =>
  `cmj.chat_id IN (SELECT chj.chat_id FROM chat_handle_join chj JOIN handle h2 ON h2.ROWID = chj.handle_id WHERE ${clause})`;

export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
