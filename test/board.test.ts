import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TaskBoard } from "../src/board.js";
import { loadConfig } from "../src/config.js";
import { callTool } from "../src/server.js";
import { emptyState, FileStateStore, type BoardState, type StateStore } from "../src/state.js";
import { parseTasks, type Task } from "../src/tasks.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const T = (id: string, priority: number, reward_shares: number, depends_on: string[] = []): Task =>
  ({ id, title: `Task ${id}`, priority, reward_shares, depends_on });
const TASKS = [T("T1", 1, 100), T("T2", 2, 50, ["T1"]), T("T3", 2, 80)];

class MemoryStore implements StateStore {
  saves = 0;
  failNext = false;
  constructor(public state: BoardState = emptyState()) {}
  load() { return structuredClone(this.state); }
  save(state: BoardState) {
    if (this.failNext) { this.failNext = false; throw new Error("disk full"); }
    this.saves++;
    this.state = structuredClone(state);
  }
}

function board(opts: { store?: StateStore; leaseMs?: number } = {}) {
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  const store = opts.store ?? new MemoryStore();
  const b = new TaskBoard(TASKS, { leaseMs: opts.leaseMs ?? 60_000, store, now: () => now });
  return { b, store, advance: (ms: number) => { now += ms; } };
}

describe("TaskBoard leases", () => {
  it("expires a lease exactly at its expiry time", () => {
    const { b, advance } = board();
    b.claim("T1", "a");
    advance(59_999);
    expect(b.status("T1").claimed_by).toBe("a");
    advance(1);
    expect(b.status("T1")).toMatchObject({ status: "open", claimed_by: null, lease_expires_at: null });
  });

  it("renews from now, not from the previous expiry", () => {
    const { b, advance } = board();
    b.claim("T1", "a");
    advance(30_000);
    expect(b.claim("T1", "a").lease_expires_at).toBe("2026-01-01T00:01:30.000Z");
  });

  it("drops expired leases from the persisted state on the next write", () => {
    const store = new MemoryStore();
    const { b, advance } = board({ store });
    b.claim("T1", "a");
    advance(60_000);
    b.claim("T3", "b");
    expect(Object.keys(store.state.leases)).toEqual(["T3"]);
  });
});

describe("TaskBoard task ids", () => {
  it("treats ids that shadow Object.prototype as ordinary tasks", () => {
    const b = new TaskBoard([T("constructor", 1, 1), T("toString", 1, 1, ["constructor"])], { leaseMs: 60_000, store: new MemoryStore() });
    expect(b.listTasks().tasks.map((t) => t.id)).toEqual(["constructor"]);
    expect(b.status("toString")).toMatchObject({ status: "open", blocked_by: ["constructor"], submitted_by: null });
    b.claim("constructor", "a");
    b.submit("constructor", "a", SHA);
    expect(b.listTasks().tasks.map((t) => t.id)).toEqual(["toString"]);
  });
});

describe("TaskBoard persistence", () => {
  it("leaves the board unchanged when saving fails", () => {
    const store = new MemoryStore();
    const { b } = board({ store });
    store.failNext = true;
    expect(() => b.claim("T1", "a")).toThrow("disk full");
    expect(b.status("T1").status).toBe("open");
    expect(b.claim("T1", "b").agent_id).toBe("b");
  });

  it("reports an unexpected failure as an INTERNAL_ERROR tool result", () => {
    const store = new MemoryStore();
    const { b } = board({ store });
    store.failNext = true;
    const res = callTool(b, "claim", { task_id: "T1", agent_id: "a" });
    expect(res.isError).toBe(true);
    expect(JSON.parse((res.content[0] as { text: string }).text).error.code).toBe("INTERNAL_ERROR");
  });

  it("round-trips through the state file and leaves no temporary file", () => {
    const dir = mkdtempSync(join(tmpdir(), "board-"));
    const file = join(dir, "state.json");
    const { b } = board({ store: new FileStateStore(file) });
    b.claim("T1", "a");
    b.submit("T1", "a", SHA);
    const reloaded = board({ store: new FileStateStore(file) }).b;
    expect(reloaded.status("T1")).toMatchObject({ status: "submitted", submitted_by: "a", commit_hash: SHA });
    expect(readFileSync(file, "utf8")).toContain(SHA);
    expect(() => readFileSync(`${file}.${process.pid}.tmp`)).toThrow();
  });

  it("refuses to start on a corrupt state file instead of overwriting it", () => {
    const file = join(mkdtempSync(join(tmpdir(), "board-")), "state.json");
    writeFileSync(file, "{not json");
    expect(() => new FileStateStore(file).load()).toThrow(/not valid JSON/);
  });
});

describe("configuration", () => {
  it("defaults STATE_FILE and LEASE_SECONDS", () => {
    expect(loadConfig({ TASKS_FILE: "/x/tasks.json" })).toEqual({
      tasksFile: "/x/tasks.json", stateFile: "/x/tasks.json.state.json", leaseMs: 1_800_000,
    });
  });

  it("rejects a missing TASKS_FILE and a bad LEASE_SECONDS", () => {
    expect(() => loadConfig({})).toThrow(/TASKS_FILE/);
    expect(() => loadConfig({ TASKS_FILE: "t.json", LEASE_SECONDS: "0" })).toThrow(/LEASE_SECONDS/);
    expect(() => loadConfig({ TASKS_FILE: "t.json", LEASE_SECONDS: "soon" })).toThrow(/LEASE_SECONDS/);
  });

  it("rejects duplicate ids and unknown dependencies in the tasks file", () => {
    expect(() => parseTasks({ tasks: [T("A", 1, 1), T("A", 2, 1)] })).toThrow(/duplicate/);
    expect(() => parseTasks({ tasks: [T("A", 1, 1, ["B"])] })).toThrow(/unknown task/);
    expect(() => parseTasks({ tasks: [{ ...T("A", 1, 1), reward_shares: 0 }] })).toThrow(/reward_shares/);
  });
});
