import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { UserFacingError, type ModuleContext, type HandleResolver, type ResolvedContact } from "../../core/types.js";

/**
 * Reads the AddressBook Core Data stores directly (read-only), for the same
 * reasons as Messages: a bulk load takes milliseconds, where Contacts.app over
 * Apple Events takes seconds and would make inline name resolution on every
 * message impractical. The schema is undocumented but has been stable for
 * over a decade.
 *
 * Contacts live in one store per account:
 *   ~/Library/Application Support/AddressBook/Sources/<UUID>/AddressBook-v22.abcddb
 * plus a top-level store for on-device contacts. All are merged.
 */
const DB_NAME = "AddressBook-v22.abcddb";

export interface Contact {
  name: string;
  nickname: string | null;
  organization: string | null;
  phones: { label: string | null; value: string }[];
  emails: { label: string | null; value: string }[];
  /**
   * True when the card has a real first AND last name made only of letters.
   * Used to pick a display name when several cards share a number: a family
   * member's synced card often labels the same person "Mom💖".
   */
  formalName: boolean;
}

export function contactsDir(ctx: ModuleContext): string {
  return ctx.env.APPLE_MCP_CONTACTS_DIR ?? join(ctx.homeDir, "Library", "Application Support", "AddressBook");
}

export function findStores(dir: string): string[] {
  const out: string[] = [];
  const top = join(dir, DB_NAME);
  if (existsSync(top)) out.push(top);
  const sources = join(dir, "Sources");
  if (existsSync(sources))
    for (const d of readdirSync(sources).sort()) {
      const p = join(sources, d, DB_NAME);
      if (existsSync(p)) out.push(p);
    }
  return out;
}

/** Apple stores labels as `_$!<Mobile>!$_`; custom labels are plain text. */
export function cleanLabel(l: string | null): string | null {
  if (!l) return null;
  const m = /^_\$!<(.+)>!\$_$/.exec(l);
  return (m ? m[1]! : l).toLowerCase();
}

/**
 * Canonical lookup key. Phones compare on their last 10 digits so that
 * "+1 (651) 555-0100", "6515550100" and "1-651-555-0100" are one key.
 * Known trade-off: two numbers that differ only in country code collide.
 */
export function handleKey(h: string): string | null {
  const t = h.trim();
  if (!t) return null;
  if (t.includes("@")) return t.toLowerCase();
  const digits = t.replace(/\D/g, "");
  return digits.length >= 7 ? digits.slice(-10) : null;
}

const LETTERS_ONLY = /^[\p{L}\p{M}'’.\- ]+$/u;
function isFormal(r: { first: string | null; last: string | null }): boolean {
  return !!r.first && !!r.last && LETTERS_ONLY.test(r.first) && LETTERS_ONLY.test(r.last);
}

function displayName(r: { first: string | null; last: string | null; nick: string | null; org: string | null }): string | null {
  const full = [r.first, r.last].filter(Boolean).join(" ").trim();
  return full || r.nick || r.org || null;
}

function readStore(path: string): Contact[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const people = db.prepare(
      `SELECT Z_PK AS pk, ZFIRSTNAME AS first, ZLASTNAME AS last, ZNICKNAME AS nick, ZORGANIZATION AS org FROM ZABCDRECORD`,
    ).all() as any[];
    const phones = db.prepare(`SELECT ZOWNER AS owner, ZFULLNUMBER AS value, ZLABEL AS label FROM ZABCDPHONENUMBER WHERE ZFULLNUMBER IS NOT NULL`).all() as any[];
    const emails = db.prepare(`SELECT ZOWNER AS owner, ZADDRESS AS value, ZLABEL AS label FROM ZABCDEMAILADDRESS WHERE ZADDRESS IS NOT NULL`).all() as any[];

    const byPk = new Map<number, Contact>();
    for (const p of people) {
      const name = displayName(p);
      if (name) byPk.set(p.pk, { name, nickname: p.nick ?? null, organization: p.org ?? null, phones: [], emails: [], formalName: isFormal(p) });
    }
    for (const ph of phones) byPk.get(ph.owner)?.phones.push({ label: cleanLabel(ph.label), value: ph.value });
    for (const em of emails) byPk.get(em.owner)?.emails.push({ label: cleanLabel(em.label), value: em.value });
    return [...byPk.values()];
  } finally {
    db.close();
  }
}

/** The same person often exists in several accounts. Merge on name, union the handles. */
export function mergeContacts(all: Contact[]): Contact[] {
  const byName = new Map<string, Contact>();
  for (const c of all) {
    const k = c.name.toLowerCase();
    const cur = byName.get(k);
    if (!cur) { byName.set(k, { ...c, phones: [...c.phones], emails: [...c.emails] }); continue; }
    for (const p of c.phones) if (!cur.phones.some((x) => handleKey(x.value) === handleKey(p.value))) cur.phones.push(p);
    for (const e of c.emails) if (!cur.emails.some((x) => handleKey(x.value) === handleKey(e.value))) cur.emails.push(e);
    cur.formalName ||= c.formalName;
    cur.nickname ??= c.nickname;
    cur.organization ??= c.organization;
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function loadContacts(ctx: ModuleContext): Contact[] {
  const dir = contactsDir(ctx);
  const stores = findStores(dir);
  if (!stores.length)
    throw new UserFacingError(
      `No Contacts database found under ${dir}.`,
      "Grant Full Disk Access to the node binary that runs this server, then restart the host app.",
    );
  const all: Contact[] = [];
  let lastErr: unknown = null;
  let opened = 0;
  for (const s of stores) {
    try { all.push(...readStore(s)); opened++; } catch (e) { lastErr = e; }
  }
  if (!opened)
    throw new UserFacingError(
      `Could not open any Contacts database: ${(lastErr as any)?.message ?? lastErr}`,
      "Grant Full Disk Access to the node binary that runs this server, then restart the host app.",
    );
  return mergeContacts(all);
}

/** Scores at or above this are exact or whole-word name matches, as opposed to substring hits. */
export const STRONG_MATCH = 80;

export function scoreContacts(contacts: Contact[], query: string): { c: Contact; score: number }[] {
  const q = query.trim().toLowerCase();
  const qKey = handleKey(query);
  const qDigits = query.replace(/\D/g, "");
  const scored: { c: Contact; score: number }[] = [];
  for (const c of contacts) {
    const name = c.name.toLowerCase();
    let score = 0;
    if (name === q || c.nickname?.toLowerCase() === q) score = 100;
    else if (name.split(/[\s\-]+/).some((w) => w === q)) score = 80;       // whole first or last name
    else if (name.startsWith(q)) score = 60;
    else if (name.includes(q) || c.nickname?.toLowerCase().includes(q)) score = 40;
    else if (c.organization?.toLowerCase().includes(q)) score = 20;
    else if (qKey && [...c.phones, ...c.emails].some((h) => handleKey(h.value) === qKey)) score = 90;
    else if (qDigits.length >= 4 && c.phones.some((p) => p.value.replace(/\D/g, "").includes(qDigits))) score = 30;
    if (score) scored.push({ c, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.c.name.localeCompare(b.c.name));
}

export function searchContacts(contacts: Contact[], query: string, limit: number): Contact[] {
  return scoreContacts(contacts, query).slice(0, limit).map((s) => s.c);
}

/**
 * For "which person did they mean", substring hits are noise once a real name
 * match exists: "Hope" must not pull in "Summit Ort-hope-dics". If any strong
 * match exists, only strong matches are candidates.
 */
export function candidatesForName(contacts: Contact[], query: string): Contact[] {
  const scored = scoreContacts(contacts, query);
  const strong = scored.filter((s) => s.score >= STRONG_MATCH);
  return (strong.length ? strong : scored).slice(0, 10).map((s) => s.c);
}

/**
 * The service other modules consume. Cached briefly: a conversation makes
 * many tool calls in a burst, and contacts rarely change mid-conversation.
 */
export function makeResolver(ctx: ModuleContext, ttlMs = 60_000): HandleResolver {
  let cache: { at: number; contacts: Contact[]; index: Map<string, string> } | null = null;
  const load = () => {
    if (cache && Date.now() - cache.at < ttlMs) return cache;
    const contacts = loadContacts(ctx);
    const names = new Map<string, { formal: Set<string>; other: Set<string> }>();
    for (const c of contacts)
      for (const h of [...c.phones, ...c.emails]) {
        const k = handleKey(h.value);
        if (!k) continue;
        const e = names.get(k) ?? names.set(k, { formal: new Set(), other: new Set() }).get(k)!;
        (c.formalName ? e.formal : e.other).add(c.name);
      }
    // Formal names win over pet names for the same number. Several formal names
    // on one number is legitimate (a household landline), so those stay joined.
    const index = new Map([...names].map(([k, v]) => [k, [...(v.formal.size ? v.formal : v.other)].join(" / ")] as const));
    return (cache = { at: Date.now(), contacts, index });
  };
  return {
    resolve(handles) {
      const out = new Map<string, string>();
      let index: Map<string, string>;
      try { index = load().index; } catch { return out; } // fail soft: callers fall back to raw handles
      for (const h of handles) {
        const k = handleKey(h);
        const n = k ? index.get(k) : undefined;
        if (n) out.set(h, n);
      }
      return out;
    },
    findByName(query): ResolvedContact[] {
      return candidatesForName(load().contacts, query)
        .map((c) => ({ name: c.name, handles: [...c.phones, ...c.emails].map((h) => h.value) }));
    },
  };
}
