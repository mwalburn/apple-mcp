import { afterAll } from "vitest";
import { rmSync } from "node:fs";
import { TEMP_DIRS } from "./fixtures.js";

afterAll(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
});
