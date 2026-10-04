import { afterEach, describe, expect, it } from "vitest";
import { startServer, writeTasks } from "./helpers.js";

const TASKS = [
  { id: "T1", title: "Scaffold repo", priority: 1, reward_shares: 100, depends_on: [] },
  { id: "T2", title: "Add CI", priority: 2, reward_shares: 50, depends_on: ["T1"] },
  { id: "T3", title: "Write README", priority: 2, reward_shares: 80, depends_on: [] },
];
const SHA = "a".repeat(40);

let server: Awaited<ReturnType<typeof startServer>> | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

describe("public: M1 task board", () => {
  it("exposes the four tools", async () => {
    server = await startServer(writeTasks(TASKS));
    const { tools } = await server.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["claim", "list_tasks", "status", "submit"]);
  });

  it("lists ready tasks in order", async () => {
    server = await startServer(writeTasks(TASKS));
    const r = await server.call("list_tasks", {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.tasks.map((t: any) => t.id)).toEqual(["T1", "T3"]);
  });

  it("claims then submits a task", async () => {
    server = await startServer(writeTasks(TASKS));
    const c = await server.call("claim", { task_id: "T1", agent_id: "alice" });
    expect(c.ok).toBe(true);
    if (c.ok) expect(typeof c.data.lease_expires_at).toBe("string");
    const s = await server.call("submit", { task_id: "T1", agent_id: "alice", commit_hash: SHA });
    expect(s.ok).toBe(true);
    if (s.ok) expect(s.data).toMatchObject({ task_id: "T1", status: "submitted", submitted_by: "alice", commit_hash: SHA });
  });

  it("returns TASK_NOT_FOUND for unknown tasks", async () => {
    server = await startServer(writeTasks(TASKS));
    const r = await server.call("status", { task_id: "NOPE" });
    expect(r).toMatchObject({ ok: false, code: "TASK_NOT_FOUND" });
  });
});
