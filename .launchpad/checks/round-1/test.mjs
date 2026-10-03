// Round check of the end-to-end run: greet() in greet.mjs (report: {"tests": [...]}).
import { writeFileSync } from "node:fs";
const m = await import(new URL("../../../greet.mjs", import.meta.url)).catch(() => ({}));
const tests = [["Ada","Hello, Ada!"],["Grace Hopper","Hello, Grace Hopper!"]].map(([arg, want]) => {
  let got;
  try {
    got = m.greet?.(arg);
  } catch {}
  return { name: `greet(${JSON.stringify(arg)})`, status: got === want ? "passed" : "failed" };
});
if (process.env.LAUNCHPAD_GATE_OUT) writeFileSync(process.env.LAUNCHPAD_GATE_OUT, JSON.stringify({ tests }));
process.exit(tests.every((t) => t.status === "passed") ? 0 : 1);
