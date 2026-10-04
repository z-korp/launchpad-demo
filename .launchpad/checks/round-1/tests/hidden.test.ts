import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sleep, startServer, writeTasks, type Task } from "./helpers.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const SHA2 = "fedcba9876543210fedcba9876543210fedcba98";
const T = (id: string, priority: number, reward_shares: number, depends_on: string[] = []): Task =>
  ({ id, title: `Task ${id}`, priority, reward_shares, depends_on });
const BASE = [T("T1", 1, 100), T("T2", 2, 50, ["T1"]), T("T3", 2, 80), T("T4", 3, 10, ["T1", "T3"])];

let servers: Awaited<ReturnType<typeof startServer>>[] = [];
async function start(tasks: Task[] | string = BASE, env: Record<string, string> = {}) {
  const file = typeof tasks === "string" ? tasks : writeTasks(tasks);
  const s = await startServer(file, env);
  servers.push(s);
  return { ...s, file };
}
afterEach(async () => { for (const s of servers) await s.close().catch(() => {}); servers = []; });
const ids = (r: any) => (r.ok ? r.data.tasks.map((t: any) => t.id) : r);

describe("list_tasks", () => {
  it("orders by priority asc, reward desc, id asc", async () => {
    const s = await start([T("B", 2, 50), T("A", 2, 50), T("C", 1, 1), T("D", 2, 90)]);
    expect(ids(await s.call("list_tasks"))).toEqual(["C", "D", "A", "B"]);
  });

  it("hides tasks whose dependencies are not submitted, shows them once they are", async () => {
    const s = await start();
    expect(ids(await s.call("list_tasks"))).toEqual(["T1", "T3"]);
    await s.call("claim", { task_id: "T1", agent_id: "a" });
    await s.call("submit", { task_id: "T1", agent_id: "a", commit_hash: SHA });
    expect(ids(await s.call("list_tasks"))).toEqual(["T3", "T2"]);
  });

  it("hides tasks leased by others and includes the caller lease", async () => {
    const s = await start();
    await s.call("claim", { task_id: "T3", agent_id: "bob" });
    expect(ids(await s.call("list_tasks"))).toEqual(["T1"]);
    expect(ids(await s.call("list_tasks", { agent_id: "alice" }))).toEqual(["T1"]);
    const mine = await s.call("list_tasks", { agent_id: "bob" });
    expect(ids(mine)).toEqual(["T1", "T3"]);
    if (mine.ok) {
      const t3 = mine.data.tasks.find((t: any) => t.id === "T3");
      expect(t3).toMatchObject({ status: "claimed", claimed_by: "bob" });
      expect(typeof t3.lease_expires_at).toBe("string");
    }
  });

  it("sorts the caller lease together with the ready tasks", async () => {
    const s = await start([T("A", 1, 100), T("B", 2, 50), T("C", 3, 10)]);
    await s.call("claim", { task_id: "A", agent_id: "bob" });
    expect(ids(await s.call("list_tasks", { agent_id: "bob" }))).toEqual(["A", "B", "C"]);
  });

  it("returns task summaries with exactly the specified fields", async () => {
    const s = await start();
    const r = await s.call("list_tasks");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.keys(r.data.tasks[0]).sort()).toEqual(
        ["claimed_by", "id", "lease_expires_at", "priority", "reward_shares", "status", "title"]);
      expect(r.data.tasks[0]).toMatchObject({ id: "T1", status: "open", claimed_by: null, lease_expires_at: null });
    }
  });
});

describe("claim", () => {
  it("sets a lease of LEASE_SECONDS", async () => {
    const s = await start(BASE, { LEASE_SECONDS: "120" });
    const before = Date.now();
    const r = await s.call("claim", { task_id: "T1", agent_id: "a" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const exp = Date.parse(r.data.lease_expires_at);
      expect(r.data.lease_expires_at).toBe(new Date(exp).toISOString());
      expect(Math.abs(exp - (before + 120_000))).toBeLessThan(5000);
      expect(r.data).toMatchObject({ task_id: "T1", agent_id: "a" });
    }
  });

  it("rejects a claim on a task leased by another agent", async () => {
    const s = await start();
    await s.call("claim", { task_id: "T1", agent_id: "a" });
    expect(await s.call("claim", { task_id: "T1", agent_id: "b" })).toMatchObject({ ok: false, code: "ALREADY_CLAIMED" });
  });

  it("renews the lease when the holder claims again", async () => {
    const s = await start(BASE, { LEASE_SECONDS: "3" });
    const r1 = await s.call("claim", { task_id: "T1", agent_id: "a" });
    await sleep(1200);
    const r2 = await s.call("claim", { task_id: "T1", agent_id: "a" });
    expect(r1.ok && r2.ok).toBe(true);
    if (r1.ok && r2.ok) expect(Date.parse(r2.data.lease_expires_at)).toBeGreaterThan(Date.parse(r1.data.lease_expires_at) + 800);
  });

  it("rejects NOT_READY when a dependency is not submitted", async () => {
    const s = await start();
    expect(await s.call("claim", { task_id: "T2", agent_id: "a" })).toMatchObject({ ok: false, code: "NOT_READY" });
  });

  it("enforces one active lease per agent", async () => {
    const s = await start();
    await s.call("claim", { task_id: "T1", agent_id: "a" });
    expect(await s.call("claim", { task_id: "T3", agent_id: "a" })).toMatchObject({ ok: false, code: "LEASE_LIMIT" });
  });

  it("checks errors in the specified order", async () => {
    const s = await start();
    expect(await s.call("claim", { task_id: "NOPE", agent_id: "a" })).toMatchObject({ code: "TASK_NOT_FOUND" });
    await s.call("claim", { task_id: "T1", agent_id: "alice" });
    await s.call("claim", { task_id: "T3", agent_id: "bob" });
    // bob already holds a lease, but T1 being held by alice comes first
    expect(await s.call("claim", { task_id: "T1", agent_id: "bob" })).toMatchObject({ code: "ALREADY_CLAIMED" });
    // bob holds a lease and T2 is not ready: NOT_READY comes before LEASE_LIMIT
    expect(await s.call("claim", { task_id: "T2", agent_id: "bob" })).toMatchObject({ code: "NOT_READY" });
    await s.call("submit", { task_id: "T1", agent_id: "alice", commit_hash: SHA });
    // submitted beats everything else
    expect(await s.call("claim", { task_id: "T1", agent_id: "bob" })).toMatchObject({ code: "ALREADY_SUBMITTED" });
  });

  it("frees the agent lease slot after a submit", async () => {
    const s = await start();
    await s.call("claim", { task_id: "T1", agent_id: "a" });
    await s.call("submit", { task_id: "T1", agent_id: "a", commit_hash: SHA });
    expect((await s.call("claim", { task_id: "T3", agent_id: "a" })).ok).toBe(true);
  });
});

describe("lease expiry", () => {
  it("reopens an expired task and blocks the old holder from submitting", async () => {
    const s = await start(BASE, { LEASE_SECONDS: "1" });
    await s.call("claim", { task_id: "T1", agent_id: "a" });
    await sleep(1600);
    const st = await s.call("status", { task_id: "T1" });
    expect(st).toMatchObject({ ok: true, data: { status: "open", claimed_by: null, lease_expires_at: null } });
    expect(ids(await s.call("list_tasks"))).toContain("T1");
    expect(await s.call("submit", { task_id: "T1", agent_id: "a", commit_hash: SHA })).toMatchObject({ code: "NOT_CLAIMED" });
    expect((await s.call("claim", { task_id: "T1", agent_id: "b" })).ok).toBe(true);
  });

  it("does not count an expired lease against the agent limit", async () => {
    const s = await start(BASE, { LEASE_SECONDS: "1" });
    await s.call("claim", { task_id: "T1", agent_id: "a" });
    await sleep(1600);
    expect((await s.call("claim", { task_id: "T3", agent_id: "a" })).ok).toBe(true);
  });
});

describe("submit", () => {
  it("rejects agents without an active lease", async () => {
    const s = await start();
    expect(await s.call("submit", { task_id: "T1", agent_id: "a", commit_hash: SHA })).toMatchObject({ code: "NOT_CLAIMED" });
    await s.call("claim", { task_id: "T1", agent_id: "b" });
    expect(await s.call("submit", { task_id: "T1", agent_id: "a", commit_hash: SHA })).toMatchObject({ code: "NOT_CLAIMED" });
  });

  it("validates the commit hash before anything else", async () => {
    const s = await start();
    await s.call("claim", { task_id: "T1", agent_id: "a" });
    for (const bad of ["abc123", SHA.toUpperCase(), SHA + "0", "g".repeat(40), ""]) {
      expect(await s.call("submit", { task_id: "T1", agent_id: "a", commit_hash: bad }), bad).toMatchObject({ code: "INVALID_INPUT" });
    }
    expect(await s.call("submit", { task_id: "NOPE", agent_id: "a", commit_hash: "bad" })).toMatchObject({ code: "INVALID_INPUT" });
  });

  it("is final", async () => {
    const s = await start();
    await s.call("claim", { task_id: "T1", agent_id: "a" });
    await s.call("submit", { task_id: "T1", agent_id: "a", commit_hash: SHA });
    expect(await s.call("submit", { task_id: "T1", agent_id: "a", commit_hash: SHA2 })).toMatchObject({ code: "ALREADY_SUBMITTED" });
    expect(await s.call("status", { task_id: "T1" })).toMatchObject({ ok: true, data: { status: "submitted", commit_hash: SHA, submitted_by: "a" } });
  });
});

describe("status", () => {
  it("reports all fields with nulls and blocked_by in dependency order", async () => {
    const s = await start();
    const r = await s.call("status", { task_id: "T4" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.keys(r.data).sort()).toEqual(["blocked_by", "claimed_by", "commit_hash", "depends_on", "id",
        "lease_expires_at", "priority", "reward_shares", "status", "submitted_by", "title"]);
      expect(r.data).toMatchObject({ id: "T4", status: "open", depends_on: ["T1", "T3"], blocked_by: ["T1", "T3"],
        claimed_by: null, lease_expires_at: null, submitted_by: null, commit_hash: null, priority: 3, reward_shares: 10 });
    }
    await s.call("claim", { task_id: "T3", agent_id: "a" });
    await s.call("submit", { task_id: "T3", agent_id: "a", commit_hash: SHA });
    expect(await s.call("status", { task_id: "T4" })).toMatchObject({ data: { blocked_by: ["T1"] } });
    expect(await s.call("status", { task_id: "T3" })).toMatchObject({ data: { status: "submitted", claimed_by: null, lease_expires_at: null } });
  });
});

describe("input validation", () => {
  it("returns INVALID_INPUT in the tool error format", async () => {
    const s = await start();
    const cases: [string, Record<string, unknown>][] = [
      ["claim", { task_id: "T1" }],
      ["claim", { task_id: "", agent_id: "a" }],
      ["claim", { task_id: "T1", agent_id: 42 }],
      ["submit", { task_id: "T1", agent_id: "a" }],
      ["status", {}],
      ["list_tasks", { agent_id: 5 }],
      ["list_tasks", { agent_id: "" }],
    ];
    for (const [tool, args] of cases) {
      expect(await s.call(tool, args), `${tool} ${JSON.stringify(args)}`).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    }
  });
});

describe("concurrency", () => {
  it("lets exactly one of many concurrent claims win", async () => {
    const s = await start();
    const rs = await Promise.all(["a", "b", "c", "d", "e"].map((agent_id) => s.call("claim", { task_id: "T1", agent_id })));
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(rs.filter((r) => !r.ok && r.code === "ALREADY_CLAIMED")).toHaveLength(4);
  });

  it("enforces the lease limit under concurrent claims by one agent", async () => {
    const s = await start();
    const rs = await Promise.all(["T1", "T3"].map((task_id) => s.call("claim", { task_id, agent_id: "a" })));
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(rs.filter((r) => !r.ok && r.code === "LEASE_LIMIT")).toHaveLength(1);
  });
});

describe("persistence", () => {
  it("keeps leases and submissions across a restart", async () => {
    const s1 = await start(BASE, { LEASE_SECONDS: "600" });
    await s1.call("claim", { task_id: "T1", agent_id: "a" });
    await s1.call("submit", { task_id: "T1", agent_id: "a", commit_hash: SHA });
    await s1.call("claim", { task_id: "T3", agent_id: "b" });
    await s1.close();
    const s2 = await start(s1.file, { LEASE_SECONDS: "600" });
    expect(await s2.call("status", { task_id: "T1" })).toMatchObject({ data: { status: "submitted", commit_hash: SHA } });
    expect(await s2.call("status", { task_id: "T3" })).toMatchObject({ data: { status: "claimed", claimed_by: "b" } });
    expect(await s2.call("claim", { task_id: "T3", agent_id: "c" })).toMatchObject({ code: "ALREADY_CLAIMED" });
  });

  it("honours STATE_FILE and never writes the tasks file", async () => {
    const file = writeTasks(BASE);
    const original = readFileSync(file, "utf8");
    const stateFile = join(dirname(file), "custom-state.json");
    const s = await start(file, { STATE_FILE: stateFile });
    await s.call("claim", { task_id: "T1", agent_id: "a" });
    await s.call("submit", { task_id: "T1", agent_id: "a", commit_hash: SHA });
    await sleep(200);
    expect(existsSync(stateFile)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  it("uses TASKS_FILE.state.json by default", async () => {
    const s = await start();
    await s.call("claim", { task_id: "T1", agent_id: "a" });
    await sleep(200);
    expect(existsSync(`${s.file}.state.json`)).toBe(true);
  });
});
