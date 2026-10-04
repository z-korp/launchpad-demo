import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskBoard } from "../src/board.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "board-unit-"));
  const tasksFile = join(directory, "tasks.json");
  writeFileSync(tasksFile, JSON.stringify({ tasks: [
    { id: "__proto__", title: "First", priority: 1, reward_shares: 1, depends_on: [] },
    { id: "constructor", title: "Second", priority: 2, reward_shares: 2, depends_on: ["__proto__"] },
  ] }));
  return { directory, tasksFile };
}

describe("transaction boundaries", () => {
  it("expires at the exact boundary, persists expiry, and survives restart", () => {
    const f = fixture(); let now = 1000;
    try {
      const board = new TaskBoard(f.tasksFile, undefined, 1, () => now);
      board.execute("claim", { task_id: "__proto__", agent_id: "alice" });
      now = 1999;
      expect(board.execute("status", { task_id: "__proto__" })).toMatchObject({ status: "claimed" });
      now = 2000;
      expect(board.execute("status", { task_id: "__proto__" })).toMatchObject({ status: "open", claimed_by: null });
      const restarted = new TaskBoard(f.tasksFile, undefined, 1, () => now);
      restarted.execute("claim", { task_id: "__proto__", agent_id: "bob" });
      restarted.execute("submit", { task_id: "__proto__", agent_id: "bob", commit_hash: "a".repeat(40) });
      expect(restarted.execute("list_tasks", {})).toMatchObject({ tasks: [{ id: "constructor" }] });
    } finally { rmSync(f.directory, { recursive: true }); }
  });

  it("does not publish a claim when durable storage fails", () => {
    const f = fixture(); const state = join(f.directory, "missing", "state.json");
    try {
      const board = new TaskBoard(f.tasksFile, state);
      expect(() => board.execute("claim", { task_id: "__proto__", agent_id: "a" })).toThrow();
      expect(board.execute("status", { task_id: "__proto__" })).toMatchObject({ status: "open" });
      mkdirSync(join(f.directory, "missing"));
      board.execute("claim", { task_id: "__proto__", agent_id: "b" });
      expect(new TaskBoard(f.tasksFile, state).execute("status", { task_id: "__proto__" })).toMatchObject({ claimed_by: "b" });
    } finally { rmSync(f.directory, { recursive: true }); }
  });

  it("checks directory access before committing a transaction", () => {
    const f = fixture(); const directory = join(f.directory, "write-only");
    mkdirSync(directory, 0o300);
    try {
      const board = new TaskBoard(f.tasksFile, join(directory, "state.json"));
      expect(() => board.execute("claim", { task_id: "__proto__", agent_id: "a" })).toThrow();
      expect(board.execute("status", { task_id: "__proto__" })).toMatchObject({ status: "open" });
    } finally { chmodSync(directory, 0o700); rmSync(f.directory, { recursive: true }); }
  });

  it("refuses malformed persisted state without overwriting it", () => {
    const f = fixture(); const state = `${f.tasksFile}.state.json`;
    try {
      writeFileSync(state, "broken");
      expect(() => new TaskBoard(f.tasksFile)).toThrow();
      expect(readFileSync(state, "utf8")).toBe("broken");
      expect(() => new TaskBoard(f.tasksFile, f.tasksFile)).toThrow("must differ");
    } finally { rmSync(f.directory, { recursive: true }); }
  });
});
