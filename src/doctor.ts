#!/usr/bin/env node
/** `npm run doctor`: exercises each module once so permission prompts and failures surface outside an MCP client. */
import { modules } from "./modules/index.js";
import { realContext } from "./context.js";
import { adoptClaudeEnv } from "./core/claude-env.js";

process.removeAllListeners("warning");

// Settings such as the Reminders denylist live in Claude's config, which a Terminal run never sees.
const adopted = adoptClaudeEnv();
const ctx = realContext();
for (const m of modules) if (m.provide) Object.assign(ctx.services, m.provide(ctx));

let failed = false;
console.log(`node ${process.version} on ${process.platform}`);
console.log(adopted.length ? `env from Claude config: ${adopted.join(", ")}\n` : "env from Claude config: none found\n");
for (const m of modules) {
  process.stdout.write(`${m.id.padEnd(12)} `);
  const t0 = Date.now();
  try {
    const out = m.check ? await m.check(ctx) : "(no check)";
    console.log(`OK    ${out}  [${((Date.now() - t0) / 1000).toFixed(1)}s]`);
  } catch (e: any) {
    failed = true;
    console.log(`FAIL  ${e.message}  [${((Date.now() - t0) / 1000).toFixed(1)}s]`);
    if (e.hint) console.log(`${" ".repeat(19)}${e.hint}`);
    console.log(`${" ".repeat(19)}needs: ${m.permissions.join("; ")}`);
  }
}
process.exit(failed ? 1 : 0);
