import { z } from "zod";
import { defineTool, type AppModule, type ModuleContext } from "../../core/types.js";
import { loadUrgency, urgencyOf } from "./store.js";
import { LIST_LISTS, LIST_REMINDERS, INCOMPLETE_IDS, STATUS, GET_REMINDER } from "./scripts.js";

export interface Reminder {
  id: string; list: string; name: string; notes: string | null; completed: boolean;
  dueDate: string | null; priority: number; flagged: boolean;
  completionDate: string | null; modifiedAt: string | null;
  /**
   * Reminders.app's private "Urgent" toggle, read from the app's local store.
   * null means unknown (store unreadable or id not matched), which is not the same as false.
   */
  urgent?: boolean | null;
}

const statusSchema = z.enum(["incomplete", "completed", "all"]).default("incomplete");

/** Filtering and sorting happen in Node, not JXA: testable, and cheap once the bulk fetch is done. */
export function filterReminders(
  items: Reminder[],
  f: { dueBefore?: string; dueAfter?: string; modifiedAfter?: string; query?: string; flaggedOnly?: boolean; limit: number },
): Reminder[] {
  const before = f.dueBefore ? Date.parse(f.dueBefore) : null;
  const after = f.dueAfter ? Date.parse(f.dueAfter) : null;
  const q = f.query?.toLowerCase();
  const modAfter = f.modifiedAfter ? Date.parse(f.modifiedAfter) : null;
  return items
    .filter((r) => {
      if (f.flaggedOnly && !r.flagged) return false;
      // No modification date means we cannot prove it is unchanged: include it.
      if (modAfter !== null && r.modifiedAt && Date.parse(r.modifiedAt) <= modAfter) return false;
      if (before !== null || after !== null) {
        if (!r.dueDate) return false;
        const t = Date.parse(r.dueDate);
        if (before !== null && t >= before) return false;
        if (after !== null && t < after) return false;
      }
      if (q && !`${r.name}\n${r.notes ?? ""}`.toLowerCase().includes(q)) return false;
      return true;
    })
    .sort((a, b) => {
      if (a.dueDate && b.dueDate) return Date.parse(a.dueDate) - Date.parse(b.dueDate);
      if (a.dueDate) return -1;
      if (b.dueDate) return 1;
      return a.name.localeCompare(b.name);
    })
    .slice(0, f.limit);
}

/**
 * Denylist, not allowlist: every list is in scope unless named here, so a list
 * created next month is picked up with no config change. Names or ids,
 * comma-separated, case-insensitive. Applies only to all-list scans.
 */
export function excludedLists(env: NodeJS.ProcessEnv): string[] {
  return (env.APPLE_MCP_REMINDERS_EXCLUDE ?? "").split(",").map((x) => x.trim()).filter(Boolean);
}
const isExcluded = (l: { id: string; name: string }, ex: string[]) =>
  ex.some((x) => x.toLowerCase() === l.name.toLowerCase() || x.toLowerCase() === l.id.toLowerCase());

interface Fetched { scanned: string[]; items: Reminder[] }

/** Joins the urgent flag onto anything carrying a reminder `id`. One store read per call. */
function withUrgency<T extends { id: string }>(items: T[], ctx: ModuleContext): (T & { urgent: boolean | null })[] {
  const index = loadUrgency(ctx);
  return items.map((r) => ({ ...r, urgent: urgencyOf(index, r.id) }));
}

export const remindersModule: AppModule = {
  id: "reminders",
  description: "Apple Reminders (read-only) via JXA",
  permissions: ["Automation: host app -> Reminders", "Reminders access", "Full Disk Access for node (urgent flag only; everything else works without it)"],
  check: async (ctx) => {
    const lists = await ctx.jxa<unknown[]>(LIST_LISTS);
    // Cross-check the undocumented store join against ids JXA actually returns.
    const ids = await ctx.jxa<string[]>(INCOMPLETE_IDS, { exclude: excludedLists(ctx.env) });
    const index = loadUrgency(ctx);
    if (!index) return `${lists.length} list(s) visible; urgent flag: store NOT readable (urgent will be null)`;
    const known = ids.map((id) => urgencyOf(index, id));
    const matched = known.filter((u) => u !== null).length;
    return `${lists.length} list(s) visible; urgent flag: matched ${matched}/${ids.length} reminders across ${index.stores} store(s), ${known.filter((u) => u === true).length} urgent`;
  },
  tools: [
    defineTool({
      name: "reminders_list_lists",
      title: "List Reminders lists",
      description: "All Reminders lists with their incomplete counts. `excluded: true` marks lists skipped by all-list scans (APPLE_MCP_REMINDERS_EXCLUDE); they can still be read by name.",
      access: "read",
      input: {},
      handler: async (_a, ctx) => {
        const ex = excludedLists(ctx.env);
        const lists = await ctx.jxa<{ id: string; name: string; incomplete: number }[]>(LIST_LISTS);
        return lists.map((l) => ({ ...l, excluded: isExcluded(l, ex) }));
      },
    }),
    defineTool({
      name: "reminders_list",
      title: "List reminders",
      description:
        "Reminders with priority (1 high, 5 medium, 9 low, 0 none), flagged, and urgent (Reminders' Urgent toggle; null = unknown). Optionally scoped to one list, a status, a due-date window, and/or changed-since. With no `list`, scans every list except those in the server's denylist, so newly created lists are included automatically; `listsScanned` shows what was covered. Sorted by due date. Dates are ISO 8601.",
      access: "read",
      input: {
        list: z.string().optional().describe("Exact list name. Omit for all lists."),
        status: statusSchema,
        dueBefore: z.string().datetime({ offset: true }).optional().describe("Exclusive upper bound"),
        dueAfter: z.string().datetime({ offset: true }).optional().describe("Inclusive lower bound"),
        modifiedAfter: z.string().datetime({ offset: true }).optional().describe("Only reminders created or changed after this instant. For incremental sync."),
        flaggedOnly: z.boolean().default(false),
        limit: z.number().int().min(1).max(500).default(100),
      },
      handler: async (a, ctx) => {
        const got = await ctx.jxa<Fetched>(LIST_REMINDERS, { list: a.list, status: a.status, exclude: excludedLists(ctx.env) });
        const items = withUrgency(filterReminders(got.items, a), ctx);
        return { count: items.length, scanned: got.items.length, listsScanned: got.scanned, items };
      },
    }),
    defineTool({
      name: "reminders_search",
      title: "Search reminders",
      description: "Case-insensitive substring search over reminder titles and notes.",
      access: "read",
      input: {
        query: z.string().min(1),
        list: z.string().optional(),
        status: statusSchema,
        limit: z.number().int().min(1).max(200).default(50),
      },
      handler: async (a, ctx) => {
        const got = await ctx.jxa<Fetched>(LIST_REMINDERS, { list: a.list, status: a.status, exclude: excludedLists(ctx.env) });
        const items = withUrgency(filterReminders(got.items, { query: a.query, limit: a.limit }), ctx);
        return { count: items.length, scanned: got.items.length, listsScanned: got.scanned, items };
      },
    }),
    defineTool({
      name: "reminders_get",
      title: "Get one reminder",
      description: "Full detail for one reminder by id (from reminders_list or reminders_search).",
      access: "read",
      input: { id: z.string().min(1) },
      handler: async (a, ctx) => withUrgency([await ctx.jxa<{ id: string }>(GET_REMINDER, { id: a.id })], ctx)[0],
    }),
    defineTool({
      name: "reminders_status",
      title: "Status of known reminders",
      description:
        "Bulk status for reminder ids a sync routine is tracking: completed, due date, last modified. An id that no longer exists returns `found: false` (deleted), which is not the same as completed.",
      access: "read",
      input: { ids: z.array(z.string().min(1)).min(1).max(200) },
      handler: async (a, ctx) => {
        const raw = await ctx.jxa<{ id: string; found: boolean; completed?: boolean }[]>(STATUS, { ids: a.ids });
        const index = loadUrgency(ctx);
        const results = raw.map((r) => (r.found ? { ...r, urgent: urgencyOf(index, r.id) } : r));
        return {
          count: results.length,
          completed: results.filter((r) => r.found && r.completed).length,
          missing: results.filter((r) => !r.found).length,
          results,
        };
      },
    }),
  ],
};
