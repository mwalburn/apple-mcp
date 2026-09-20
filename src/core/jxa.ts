import { execFile } from "node:child_process";
import { UserFacingError } from "./types.js";

export type ExecFn = (
  file: string,
  args: string[],
  opts: { timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: ExecFn = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(file, args, opts, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }));
      else resolve({ stdout, stderr });
    });
  });

/**
 * Runs a JXA script body. The body is wrapped in `run(argv)`; `args` arrive as
 * a parsed object named `args`, and the body must `return` a JSON-serialisable
 * value. Arguments travel via argv (execFile, no shell), never by string
 * interpolation into the script, so there is no injection path.
 */
export function makeJxaRunner(exec: ExecFn = defaultExec, timeoutMs = 60_000) {
  return async function jxa<T = unknown>(body: string, args: unknown = {}): Promise<T> {
    const script = `function run(argv){const args=JSON.parse(argv[0]);const out=(function(){${body}\n})();return JSON.stringify(out===undefined?null:out);}`;
    try {
      const { stdout } = await exec(
        "/usr/bin/osascript",
        ["-l", "JavaScript", "-e", script, JSON.stringify(args)],
        { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      );
      const trimmed = stdout.trim();
      return (trimmed ? JSON.parse(trimmed) : null) as T;
    } catch (e: any) {
      throw translateOsascriptError(e);
    }
  };
}

function translateOsascriptError(e: any): Error {
  const msg = `${e?.stderr ?? ""} ${e?.message ?? ""}`;
  if (e?.code === "ENOENT")
    return new UserFacingError("osascript not found. This server only runs on macOS.");
  if (/-1743|not authorized to send Apple events/i.test(msg))
    return new UserFacingError(
      "macOS blocked automation access.",
      "System Settings > Privacy & Security > Automation: allow the host app (Claude, Terminal, etc.) to control the target app.",
    );
  if (/-1728|-1719/.test(msg))
    return new UserFacingError("The requested object was not found in the app.", msg.trim());
  if (e?.killed || /ETIMEDOUT|timed out/i.test(msg))
    return new UserFacingError(
      "The Apple app did not respond in time.",
      "Large libraries are slow over Apple Events. Narrow the query (list, date range, limit).",
    );
  return new Error(`osascript failed: ${msg.trim()}`);
}
