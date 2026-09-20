import { z } from "zod";
import { defineTool, type AppModule } from "../../core/types.js";
import { loadContacts, searchContacts, makeResolver, findStores, contactsDir } from "./directory.js";

export const contactsModule: AppModule = {
  id: "contacts",
  description: "Apple Contacts (read-only) via direct SQLite reads; also resolves names for other modules",
  permissions: ["Full Disk Access for the node binary (same grant Messages uses)"],
  provide: (ctx) => ({ handleResolver: makeResolver(ctx) }),
  check: async (ctx) => {
    const n = loadContacts(ctx).length;
    return `${n} contact(s) across ${findStores(contactsDir(ctx)).length} store(s)`;
  },
  tools: [
    defineTool({
      name: "contacts_search",
      title: "Search contacts",
      description:
        "Find contacts by name, nickname, organization, phone number or email. Returns phone numbers and emails, usable as `handle` in the messages tools.",
      access: "read",
      input: {
        query: z.string().min(2),
        limit: z.number().int().min(1).max(100).default(10),
      },
      handler: async (a, ctx) => {
        const items = searchContacts(loadContacts(ctx), a.query, a.limit).map(({ formalName: _f, ...c }) => c);
        return { count: items.length, contacts: items };
      },
    }),
    defineTool({
      name: "contacts_resolve",
      title: "Resolve handles to names",
      description: "Map phone numbers / emails to contact names. Messages tools already do this inline; use this for handles from elsewhere.",
      access: "read",
      input: { handles: z.array(z.string().min(3)).min(1).max(200) },
      handler: async (a, ctx) => {
        loadContacts(ctx); // surface permission problems as an error rather than an all-null result
        const m = ctx.services.handleResolver?.resolve(a.handles) ?? new Map<string, string>();
        return { results: a.handles.map((h) => ({ handle: h, name: m.get(h) ?? null })) };
      },
    }),
  ],
};
