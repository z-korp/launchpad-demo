import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export type Task = { id: string; title: string; priority: number; reward_shares: number; depends_on: string[] };
export type CallResult = { ok: true; data: any } | { ok: false; code: string; raw: any };

const SERVER_DIR = resolve(process.env.SERVER_DIR ?? process.cwd());

export function writeTasks(tasks: Task[]): string {
  const dir = mkdtempSync(join(tmpdir(), "m1-"));
  const file = join(dir, "tasks.json");
  writeFileSync(file, JSON.stringify({ tasks }, null, 2));
  return file;
}

export async function startServer(tasksFile: string, env: Record<string, string> = {}) {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", join(SERVER_DIR, "src/index.ts")],
    cwd: SERVER_DIR,
    env: { ...(process.env as Record<string, string>), TASKS_FILE: tasksFile, ...env },
    stderr: "ignore",
  });
  const client = new Client({ name: "m1-tests", version: "0.0.0" });
  await client.connect(transport);

  async function call(name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
    let res: any;
    try {
      res = await client.callTool({ name, arguments: args });
    } catch (e) {
      return { ok: false, code: "PROTOCOL_ERROR", raw: String(e) };
    }
    const text = res?.content?.[0]?.text;
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, code: "UNPARSEABLE", raw: res };
    }
    if (res.isError) return { ok: false, code: parsed?.error?.code ?? "NO_CODE", raw: parsed };
    return { ok: true, data: parsed };
  }

  return { client, call, close: () => client.close() };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
