import { z } from "zod";
import { defineTool, UserFacingError, type AppModule, type ModuleContext } from "../../core/types.js";
import {
  withDb, appleMsToIso, isoToAppleNs, DATE_MS, toMessage, handleClause, escapeLike,
  MESSAGE_SELECT, NOT_REACTION, CHATS_WITH_HANDLE, type MessageRow, type Message,
} from "./db.js";
import { redact, redactionEnabled } from "./redact.js";
import type { DatabaseSync } from "node:sqlite";

type P = string | number | bigint;
const isoDate = z.string().datetime({ offset: true });

/** Shared WHERE builder for every message-returning tool. */
function scope(a: { chatId?: number; handles?: string[]; since?: string; until?: string; includeReactions?: boolean }) {
  const where: string[] = [];
  const params: P[] = [];
  if (a.chatId !== undefined) { where.push("cmj.chat_id = ?"); params.push(a.chatId); }
  if (a.handles?.length) {
    // A contact usually has several handles (mobile + iCloud email); match any.
    const clauses = a.handles.map(handleClause);
    where.push(CHATS_WITH_HANDLE(`(${clauses.map((c) => c.sql).join(" OR ")})`));
    params.push(...clauses.map((c) => c.param));
  }
  if (a.since) { where.push("m.date >= ?"); params.push(isoToAppleNs(a.since)); }
  if (a.until) { where.push("m.date < ?"); params.push(isoToAppleNs(a.until)); }
  if (!a.includeReactions) where.push(NOT_REACTION);
  return { where, params };
}

interface Target { handles?: string[]; matched?: string; matchedBy?: "exact" | "only-match" | "recent-activity"; alsoMatched?: string[] }

const RECENT_DAYS = 90;

/** Most recent message exchanged with any of these handles, as ms since the Apple epoch. */
function lastActivityMs(db: DatabaseSync, handles: string[]): number {
  const clauses = handles.map((h) => { try { return handleClause(h); } catch { return null; } }).filter((c) => c !== null);
  if (!clauses.length) return 0;
  const row = db.prepare(
    `SELECT ${DATE_MS("MAX(m.date)")} AS ms FROM message m JOIN handle h2 ON h2.ROWID = m.handle_id WHERE ${clauses.map((c) => c.sql).join(" OR ")}`,
  ).get(...clauses.map((c) => c.param)) as { ms: number | null };
  return row?.ms ?? 0;
}

/**
 * Turns the caller's `handle` / `contact` into a handle list.
 *
 * Disambiguation order for a name: exact full-name match, then the only
 * candidate, then recent activity. The activity rule fires only when exactly
 * one candidate has exchanged messages in the last 90 days, so "Hope" picks the
 * person texted daily over a business card that merely contains the word.
 * If two candidates are both active, it refuses and lists them: a wrong guess
 * would return the wrong person's messages. Whatever rule decided is reported
 * back in `matchedBy` so the caller can say who was assumed.
 */
function resolveTarget(a: { handle?: string; contact?: string }, ctx: ModuleContext, db: DatabaseSync): Target {
  if (a.handle) return { handles: [a.handle] };
  if (!a.contact) return {};
  const r = ctx.services.handleResolver;
  if (!r) throw new UserFacingError("Lookup by contact name needs the contacts module, which is not enabled.", "Pass `handle` (phone or email) instead, or enable the contacts module.");
  const hits = r.findByName(a.contact).filter((c) => c.handles.length);
  if (!hits.length) throw new UserFacingError(`No contact with a phone or email matches "${a.contact}".`);
  const q = a.contact.trim().toLowerCase();
  const exact = hits.filter((c) => c.name.toLowerCase() === q);
  if (exact.length === 1) return { handles: exact[0]!.handles, matched: exact[0]!.name, matchedBy: "exact" };
  if (hits.length === 1) return { handles: hits[0]!.handles, matched: hits[0]!.name, matchedBy: "only-match" };

  const cutoffMs = Date.now() - 978_307_200_000 - RECENT_DAYS * 86_400_000;
  const withActivity = hits.map((c) => ({ c, last: lastActivityMs(db, c.handles) }));
  const active = withActivity.filter((x) => x.last >= cutoffMs);
  if (active.length === 1) {
    const w = active[0]!.c;
    return { handles: w.handles, matched: w.name, matchedBy: "recent-activity", alsoMatched: hits.filter((c) => c !== w).map((c) => c.name) };
  }
  const describe = (x: { c: { name: string }; last: number }) => `${x.c.name} (${x.last ? "last message " + appleMsToIso(x.last)!.slice(0, 10) : "no messages"})`;
  throw new UserFacingError(`"${a.contact}" is ambiguous: ${withActivity.map(describe).join(", ")}.`, "Retry with the full name, or pass `handle`.");
}

/** Last step before output: attach contact names, then mask secrets. Search matches masked text when redaction is enabled. */
function finalize<T extends Message>(msgs: T[], ctx: ModuleContext): T[] {
  const r = ctx.services.handleResolver;
  if (r) {
    const names = r.resolve([...new Set(msgs.filter((m) => !m.fromMe).map((m) => m.sender))]);
    for (const m of msgs) { const n = names.get(m.sender); if (n) m.senderName = n; }
  }
  if (redactionEnabled(ctx.env))
    for (const m of msgs) { const x = redact(m.text); if (x.redacted) { m.text = x.text; m.redacted = true; } }
  return msgs;
}

const targetMeta = (t: Target) => (t.matched ? { contact: t.matched, matchedBy: t.matchedBy, ...(t.alsoMatched?.length ? { alsoMatched: t.alsoMatched } : {}) } : {});

const targetInput = {
  handle: z.string().optional().describe("Phone number or email. Phones match on last 10 digits."),
  contact: z.string().optional().describe("Contact name, e.g. \"Hope\". Resolved via the contacts module; ambiguous names return the candidates."),
};

export const messagesModule: AppModule = {
  id: "messages",
  description: "iMessage/SMS history (read-only) via direct SQLite reads of chat.db",
  permissions: ["Full Disk Access for the host app (Claude, Terminal, ...)"],
  check: async (ctx) =>
    withDb(ctx, (db) => {
      const r = db.prepare("SELECT COUNT(*) AS n FROM message").get() as { n: number };
      return `${r.n} message(s) readable`;
    }),
  tools: [
    defineTool({
      name: "messages_list_chats",
      title: "List conversations",
      description:
        "Conversations ordered by most recent activity, with participants (handle plus contact name when known) and chatId for follow-up calls.",
      access: "read",
      input: {
        limit: z.number().int().min(1).max(200).default(25),
        sinceDays: z.number().int().min(1).max(3650).default(90).describe("Only chats active in this window. Bounds the scan."),
      },
      handler: async (a, ctx) =>
        withDb(ctx, (db) => {
          const since = isoToAppleNs(new Date(Date.now() - a.sinceDays * 86_400_000).toISOString());
          const chats = db.prepare(`
            SELECT c.ROWID AS id, c.chat_identifier, c.display_name, c.service_name, c.style,
                   ${DATE_MS("MAX(m.date)")} AS last_ms, COUNT(m.ROWID) AS n
            FROM chat c
            JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
            JOIN message m ON m.ROWID = cmj.message_id
            WHERE m.date >= ?
            GROUP BY c.ROWID ORDER BY MAX(m.date) DESC LIMIT ?`).all(since, a.limit) as any[];
          if (!chats.length) return { count: 0, chats: [] };
          const ids = chats.map((c) => c.id as number);
          const parts = db.prepare(`
            SELECT chj.chat_id, h.id AS handle FROM chat_handle_join chj
            JOIN handle h ON h.ROWID = chj.handle_id
            WHERE chj.chat_id IN (${ids.map(() => "?").join(",")})`).all(...ids) as any[];
          const byChat = new Map<number, string[]>();
          for (const p of parts) (byChat.get(p.chat_id) ?? byChat.set(p.chat_id, []).get(p.chat_id)!).push(p.handle);
          const names = ctx.services.handleResolver?.resolve([...new Set(parts.map((p) => p.handle as string))]) ?? new Map<string, string>();
          return {
            count: chats.length,
            chats: chats.map((c) => ({
              chatId: c.id, name: c.display_name || null, identifier: c.chat_identifier,
              isGroup: c.style === 43, service: c.service_name,
              participants: (byChat.get(c.id) ?? []).map((h) => ({ handle: h, name: names.get(h) ?? null })),
              lastMessageAt: appleMsToIso(c.last_ms),
              messagesInWindow: Number(c.n),
            })),
          };
        }),
    }),

    defineTool({
      name: "messages_get_chat",
      title: "Read a conversation",
      description:
        "Messages from a conversation, oldest to newest. Identify it by chatId, by handle (phone/email), or by contact name. A handle or contact also matches group chats that person is in; use chatId to isolate one thread. Page backwards with `until`.",
      access: "read",
      input: {
        chatId: z.number().int().optional(),
        ...targetInput,
        since: isoDate.optional(), until: isoDate.optional(),
        limit: z.number().int().min(1).max(500).default(50).describe("Most recent N within the window"),
        includeReactions: z.boolean().default(false).describe("Include tapbacks as separate entries"),
      },
      handler: async (a, ctx) => {
        if (a.chatId === undefined && !a.handle && !a.contact) throw new UserFacingError("Provide chatId, handle, or contact.");
        return withDb(ctx, (db) => {
          const target = resolveTarget(a, ctx, db);
          const { where, params } = scope({ ...a, handles: target.handles });
          const rows = db.prepare(`${MESSAGE_SELECT} WHERE ${where.join(" AND ")} ORDER BY m.date DESC LIMIT ?`)
            .all(...params, a.limit) as unknown as MessageRow[];
          const messages = finalize(rows.map(toMessage).reverse(), ctx);
          return { count: messages.length, ...targetMeta(target), oldest: messages[0]?.date ?? null, messages };
        });
      },
    }),

    defineTool({
      name: "messages_recent",
      title: "Recent messages across all chats",
      description: "Latest messages across every conversation, newest first. Good for 'what came in today'.",
      access: "read",
      input: {
        sinceHours: z.number().min(0.1).max(24 * 90).default(24),
        incomingOnly: z.boolean().default(false),
        limit: z.number().int().min(1).max(500).default(100),
      },
      handler: async (a, ctx) =>
        withDb(ctx, (db) => {
          const { where, params } = scope({ since: new Date(Date.now() - a.sinceHours * 3_600_000).toISOString() });
          if (a.incomingOnly) where.push("m.is_from_me = 0");
          const rows = db.prepare(`${MESSAGE_SELECT} WHERE ${where.join(" AND ")} ORDER BY m.date DESC LIMIT ?`)
            .all(...params, a.limit) as unknown as MessageRow[];
          const messages = finalize(rows.map(toMessage), ctx);
          return { count: messages.length, messages };
        }),
    }),

    defineTool({
      name: "messages_search",
      title: "Search message text",
      description:
        "Case-insensitive substring search, newest first. Most message bodies are stored in a binary column SQL cannot search, so this decodes and scans rows in Node; bound it with since/until, handle, or chatId. `truncated: true` means scanLimit was hit before the window was exhausted.",
      access: "read",
      input: {
        query: z.string().min(2),
        chatId: z.number().int().optional(),
        ...targetInput,
        since: isoDate.optional(), until: isoDate.optional(),
        limit: z.number().int().min(1).max(200).default(25),
        scanLimit: z.number().int().min(100).max(500_000).default(50_000),
      },
      handler: async (a, ctx) => {
        return withDb(ctx, (db) => {
          const target = resolveTarget(a, ctx, db);
          const { where, params } = scope({ ...a, handles: target.handles });
          // Rows whose plain-text column exists but does not match can be dropped in SQL.
          where.push(`((m.text IS NOT NULL AND m.text LIKE ? ESCAPE '\\') OR (m.text IS NULL AND m.attributedBody IS NOT NULL))`);
          params.push(`%${escapeLike(a.query)}%`);
          const stmt = db.prepare(`${MESSAGE_SELECT} WHERE ${where.join(" AND ")} ORDER BY m.date DESC LIMIT ?`);
          const needle = a.query.toLowerCase();
          const mask = redactionEnabled(ctx.env);
          const hits: Message[] = [];
          let scanned = 0;
          for (const row of stmt.iterate(...params, a.scanLimit) as Iterable<unknown>) {
            scanned++;
            const msg = toMessage(row as MessageRow);
            const hay = mask ? redact(msg.text).text : msg.text;
            if (hay?.toLowerCase().includes(needle)) {
              hits.push(msg);
              if (hits.length >= a.limit) break;
            }
          }
          return { count: hits.length, ...targetMeta(target), scanned, truncated: scanned >= a.scanLimit && hits.length < a.limit, messages: finalize(hits, ctx) };
        });
      },
    }),

    defineTool({
      name: "messages_since",
      title: "New messages since a watermark",
      description:
        "Incremental fetch for scheduled routines. Returns messages with id greater than `afterId`, oldest first, optionally limited to certain people, plus `nextAfterId` to store as the next watermark. Includes your own outgoing messages, since those are what show an ask was handled. Call with no `afterId` to get the current watermark without reading any messages (first-run bootstrap). Dedup on `guid`, not `id`.",
      access: "read",
      input: {
        afterId: z.number().int().min(0).optional().describe("Watermark from the previous run. Omit to bootstrap."),
        contacts: z.array(z.string().min(1)).max(50).optional().describe("Contact names to include. Unresolvable names are reported, not fatal."),
        handles: z.array(z.string().min(3)).max(100).optional().describe("Phone numbers / emails to include."),
        limit: z.number().int().min(1).max(2000).default(500),
        includeReactions: z.boolean().default(false),
      },
      handler: async (a, ctx) =>
        withDb(ctx, (db) => {
          // Read the ceiling first and bound the query by it, so a message that
          // arrives mid-query cannot be skipped by the watermark.
          const dbMaxId = Number((db.prepare("SELECT COALESCE(MAX(ROWID), 0) AS n FROM message").get() as { n: number }).n);
          if (a.afterId === undefined) return { bootstrap: true, nextAfterId: dbMaxId, count: 0, messages: [] };

          const handles = [...(a.handles ?? [])];
          const resolved: { contact: string; matched: string; matchedBy?: string }[] = [];
          const unresolved: { contact: string; reason: string }[] = [];
          for (const name of a.contacts ?? []) {
            try {
              const t = resolveTarget({ contact: name }, ctx, db);
              handles.push(...(t.handles ?? []));
              resolved.push({ contact: name, matched: t.matched!, matchedBy: t.matchedBy });
            } catch (e: any) { unresolved.push({ contact: name, reason: e.message }); }
          }
          const filtering = (a.contacts?.length ?? 0) + (a.handles?.length ?? 0) > 0;
          if (filtering && !handles.length) return { count: 0, nextAfterId: a.afterId, resolved, unresolved, hasMore: false, messages: [] };

          const { where, params } = scope({ handles, includeReactions: a.includeReactions });
          where.push("m.ROWID > ?", "m.ROWID <= ?");
          const rows = db.prepare(`${MESSAGE_SELECT} WHERE ${where.join(" AND ")} ORDER BY m.ROWID ASC LIMIT ?`)
            .all(...params, a.afterId, dbMaxId, a.limit + 1) as unknown as MessageRow[];
          const hasMore = rows.length > a.limit;
          const page = hasMore ? rows.slice(0, a.limit) : rows;
          const messages = finalize(page.map(toMessage), ctx);
          return {
            count: messages.length,
            // Truncated page: resume from the last row returned. Complete page: jump to
            // the ceiling, so filtered-out chatter is not rescanned next run.
            nextAfterId: hasMore ? page[page.length - 1]!.id : dbMaxId,
            hasMore, resolved, unresolved, messages,
          };
        }),
    }),
  ],
};
