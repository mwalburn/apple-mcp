import { z } from "zod";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** ISO 8601 instant, or a calendar day (YYYY-MM-DD) meaning local midnight of that day. */
export const isoInstant = z.string().refine((s) => DAY.test(s) || z.string().datetime({ offset: true }).safeParse(s).success, "Expected an ISO 8601 datetime or YYYY-MM-DD date");

export function parseInstant(s: string): number {
  if (!DAY.test(s)) return Date.parse(s);
  const [y, mo, d] = s.split("-").map(Number);
  return new Date(y!, mo! - 1, d!).getTime();
}
