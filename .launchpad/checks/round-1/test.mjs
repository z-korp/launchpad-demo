// Round check of the end-to-end run: greet() in greet.mjs (report: {"tests": [...]}).
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const answer = (arg) => {
  const code = `const m = await import(${JSON.stringify(new URL("../../../greet.mjs", import.meta.url).href)}); process.stdout.write(JSON.stringify(m.greet?.(${JSON.stringify(arg)}) ?? null));`;
  try {
    return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 10_000 }));
  } catch {
    return undefined;
  }
};
const tests = [["Ada","Hello, Ada!"],["Grace Hopper","Hello, Grace Hopper!"]].map(([arg, want]) => ({ name: `greet(${JSON.stringify(arg)})`, status: answer(arg) === want ? "passed" : "failed" }));
if (process.env.LAUNCHPAD_GATE_OUT) writeFileSync(process.env.LAUNCHPAD_GATE_OUT, JSON.stringify({ tests }));
process.exit(tests.every((t) => t.status === "passed") ? 0 : 1);
