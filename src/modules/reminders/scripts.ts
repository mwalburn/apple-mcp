/**
 * Reminders via JXA. Performance note: every property access on an Apple
 * Events object is an IPC round trip, so scripts below fetch properties in
 * bulk (`collection.name()` returns an array in one call) instead of looping
 * over individual reminders.
 */

export const FETCH = `
function fetchFrom(list, status) {
  // Deliberately no whose() filter. Reminders re-evaluates a whose clause for
  // every property fetched from it, which on a list with thousands of completed
  // items turns 9 property reads into 9 full scans and can exceed a minute.
  // Instead: read completion once, decide which rows are wanted, and skip the
  // list entirely when none are. Each call below is a single Apple Event.
  const all = list.reminders;
  const done = all.completed();
  const want = [];
  for (let i = 0; i < done.length; i++)
    if (status === "all" || (status === "completed") === !!done[i]) want.push(i);
  if (!want.length) return [];
  const ids = all.id(), names = all.name(), bodies = all.body(), due = all.dueDate(),
        prio = all.priority(), flagged = all.flagged(), compl = all.completionDate(),
        mod = all.modificationDate();
  const listName = list.name();
  const iso = (d) => (d ? new Date(d).toISOString() : null);
  return want.map((i) => ({
    id: ids[i], list: listName, name: names[i], notes: bodies[i] || null,
    completed: !!done[i], dueDate: iso(due[i]), priority: prio[i], flagged: flagged[i],
    completionDate: iso(compl[i]), modifiedAt: iso(mod[i]),
  }));
}
function pickLists(app, listName, exclude) {
  if (listName) {
    // An explicit request always wins over the denylist: "what's on Groceries" still works.
    const m = app.lists.whose({ name: listName })();
    if (!m.length) throw new Error("No Reminders list named: " + listName);
    return m;
  }
  const ex = (exclude || []).map((x) => String(x).toLowerCase());
  return app.lists().filter((l) => !ex.includes(l.name().toLowerCase()) && !ex.includes(String(l.id()).toLowerCase()));
}
`;

export const LIST_LISTS = `
const app = Application("Reminders");
const lists = app.lists;
const ids = lists.id(), names = lists.name();
return ids.map((id, i) => ({
  id, name: names[i],
  incomplete: lists[i].reminders.completed().filter((d) => !d).length,
}));
`;

export const LIST_REMINDERS = `
${FETCH}
const app = Application("Reminders");
let items = [];
const scanned = [];
for (const l of pickLists(app, args.list, args.exclude)) { scanned.push(l.name()); items = items.concat(fetchFrom(l, args.status)); }
return { scanned, items };
`;

/** Ids of incomplete reminders only: two Apple Events per list. Used by the doctor cross-check. */
export const INCOMPLETE_IDS = `
${FETCH}
const app = Application("Reminders");
let ids = [];
for (const l of pickLists(app, undefined, args.exclude)) {
  const all = l.reminders, done = all.completed();
  if (!done.some((d) => !d)) continue;
  const lid = all.id();
  done.forEach((d, i) => { if (!d) ids.push(lid[i]); });
}
return ids;
`;

/**
 * Bulk lookup by id for sync ledgers. Cost is per list, not per id.
 * A missing id is reported, not thrown: "deleted" is a state the caller
 * has to handle differently from "completed".
 */
export const STATUS = `
const app = Application("Reminders");
const iso = (d) => (d ? new Date(d).toISOString() : null);
const wanted = new Set(args.ids);
const found = {};
// One event per list to read ids; five more only for lists holding a tracked id.
for (const l of app.lists()) {
  const all = l.reminders;
  const ids = all.id();
  const hit = [];
  for (let i = 0; i < ids.length; i++) if (wanted.has(ids[i])) hit.push(i);
  if (!hit.length) continue;
  const listName = l.name();
  const names = all.name(), done = all.completed(), compl = all.completionDate(),
        due = all.dueDate(), mod = all.modificationDate();
  for (const i of hit)
    found[ids[i]] = { id: ids[i], found: true, name: names[i], list: listName, completed: !!done[i],
                      completionDate: iso(compl[i]), dueDate: iso(due[i]), modifiedAt: iso(mod[i]) };
}
return args.ids.map((id) => found[id] || { id, found: false });
`;

export const GET_REMINDER = `
const app = Application("Reminders");
const m = app.reminders.whose({ id: args.id })();
if (!m.length) throw new Error("No reminder with id: " + args.id);
const r = m[0];
const iso = (d) => (d ? new Date(d).toISOString() : null);
return {
  id: r.id(), list: r.container().name(), name: r.name(), notes: r.body() || null,
  completed: r.completed(), dueDate: iso(r.dueDate()), alldayDueDate: iso(r.alldayDueDate()),
  remindMeDate: iso(r.remindMeDate()), priority: r.priority(), flagged: r.flagged(),
  completionDate: iso(r.completionDate()), createdAt: iso(r.creationDate()),
  modifiedAt: iso(r.modificationDate()),
};
`;
