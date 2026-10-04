import { z } from "zod";
import { readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const identifier = z.string().refine(value => value.trim().length > 0, "Must be a nonempty string");
const taskSchema = z.object({
  id: identifier, title: identifier, priority: z.number().int(),
  reward_shares: z.number().int().positive(), depends_on: z.array(identifier),
});
export type Task = z.infer<typeof taskSchema>;
const entrySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("claimed"), agent: identifier, expires: z.number().finite() }),
  z.object({ status: z.literal("submitted"), agent: identifier, commit: z.string().regex(/^[0-9a-f]{40}$/) }),
]);
type Entry = z.infer<typeof entrySchema>;
const stateSchema = z.object({ version: z.literal(1), entries: z.array(z.tuple([identifier, entrySchema])) });
export const inputSchemas = {
  list_tasks: z.object({ agent_id: identifier.optional() }),
  claim: z.object({ task_id: identifier, agent_id: identifier }),
  submit: z.object({ task_id: identifier, agent_id: identifier, commit_hash: z.string().regex(/^[0-9a-f]{40}$/) }),
  status: z.object({ task_id: identifier }),
};
export class BoardError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

export class TaskBoard {
  private readonly tasks: Map<string, Task>;
  private entries = new Map<string, Entry>();
  private readonly stateFile: string;

  constructor(tasksFile: string, stateFile = `${tasksFile}.state.json`, private readonly leaseSeconds = 1800,
    private readonly now: () => number = Date.now) {
    if (!Number.isFinite(leaseSeconds) || leaseSeconds <= 0 || leaseSeconds * 1000 > 8.64e15 - Date.now()) {
      throw new Error("LEASE_SECONDS must be a positive, finite duration representable as an ISO timestamp");
    }
    this.stateFile = resolve(stateFile);
    if (this.stateFile === resolve(tasksFile)) throw new Error("STATE_FILE must differ from TASKS_FILE");
    const tasks = z.object({ tasks: z.array(taskSchema) }).parse(JSON.parse(readFileSync(tasksFile, "utf8"))).tasks;
    this.tasks = new Map(tasks.map(task => [task.id, task]));
    if (this.tasks.size !== tasks.length) throw new Error("Duplicate task IDs");
    for (const task of tasks) for (const dependency of task.depends_on) {
      if (!this.tasks.has(dependency)) throw new Error(`Unknown dependency ${dependency}`);
    }
    try {
      const state = stateSchema.parse(JSON.parse(readFileSync(this.stateFile, "utf8")));
      this.entries = new Map(state.entries);
      if (this.entries.size !== state.entries.length) throw new Error("Duplicate persisted task IDs");
      const holders = new Set<string>();
      for (const [id, entry] of this.entries) {
        if (!this.tasks.has(id)) throw new Error(`Unknown persisted task ${id}`);
        if (entry.status === "claimed") {
          new Date(entry.expires).toISOString();
          if (entry.expires > this.now()) {
            if (holders.has(entry.agent)) throw new Error("Persisted agent has multiple active leases");
            holders.add(entry.agent);
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  // Each request is a synchronous transaction: no other request can interleave its checks and write.
  // Replace durable state before publishing the new map in memory. Failed writes leave memory unchanged.
  private persist(next: Map<string, Entry>) {
    const temporary = `${this.stateFile}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, JSON.stringify({ version: 1, entries: [...next] }) + "\n");
      fsyncSync(fd);
      closeSync(fd); fd = undefined;
      renameSync(temporary, this.stateFile);
      this.entries = next;
      const directory = openSync(dirname(this.stateFile), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  private expire(now: number) {
    const next = new Map(this.entries);
    for (const [id, entry] of next) if (entry.status === "claimed" && entry.expires <= now) next.delete(id);
    if (next.size !== this.entries.size) this.persist(next);
  }
  private blocked(task: Task) { return task.depends_on.filter(id => this.entries.get(id)?.status !== "submitted"); }
  private summary(task: Task) {
    const entry = this.entries.get(task.id);
    return { id: task.id, title: task.title, priority: task.priority, reward_shares: task.reward_shares,
      status: entry?.status ?? "open", claimed_by: entry?.status === "claimed" ? entry.agent : null,
      lease_expires_at: entry?.status === "claimed" ? new Date(entry.expires).toISOString() : null };
  }

  execute(name: keyof typeof inputSchemas, input: unknown): unknown {
    const parsed = inputSchemas[name].safeParse(input);
    if (!parsed.success) throw new BoardError("INVALID_INPUT", parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; "));
    const args = parsed.data;
    const now = this.now();
    this.expire(now);
    if (name === "list_tasks") {
      const agent = (args as z.infer<typeof inputSchemas.list_tasks>).agent_id;
      return { tasks: [...this.tasks.values()].filter(task => {
        const entry = this.entries.get(task.id);
        return entry?.status === "claimed" ? entry.agent === agent : !entry && this.blocked(task).length === 0;
      }).sort((a, b) => a.priority - b.priority || b.reward_shares - a.reward_shares || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(task => this.summary(task)) };
    }
    const { task_id } = args as { task_id: string };
    const task = this.tasks.get(task_id);
    if (!task) throw new BoardError("TASK_NOT_FOUND", `Unknown task: ${task_id}`);
    const entry = this.entries.get(task_id);
    if (name === "status") return { ...this.summary(task), depends_on: [...task.depends_on], blocked_by: this.blocked(task),
      submitted_by: entry?.status === "submitted" ? entry.agent : null,
      commit_hash: entry?.status === "submitted" ? entry.commit : null };
    if (entry?.status === "submitted") throw new BoardError("ALREADY_SUBMITTED", "Task has already been submitted");
    const { agent_id } = args as { agent_id: string };
    const next = new Map(this.entries);
    if (name === "claim") {
      if (entry?.status === "claimed" && entry.agent !== agent_id) throw new BoardError("ALREADY_CLAIMED", "Task is leased by another agent");
      if (this.blocked(task).length) throw new BoardError("NOT_READY", "Task dependencies have not all been submitted");
      if ([...this.entries].some(([id, e]) => id !== task_id && e.status === "claimed" && e.agent === agent_id)) throw new BoardError("LEASE_LIMIT", "Agent already holds another task lease");
      const expires = now + this.leaseSeconds * 1000;
      const lease_expires_at = new Date(expires).toISOString();
      next.set(task_id, { status: "claimed", agent: agent_id, expires });
      this.persist(next);
      return { task_id, agent_id, lease_expires_at };
    }
    if (entry?.status !== "claimed" || entry.agent !== agent_id) throw new BoardError("NOT_CLAIMED", "Agent has no active lease on this task");
    const { commit_hash } = args as z.infer<typeof inputSchemas.submit>;
    next.set(task_id, { status: "submitted", agent: agent_id, commit: commit_hash });
    this.persist(next);
    return { task_id, status: "submitted", submitted_by: agent_id, commit_hash };
  }
}
