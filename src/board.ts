import { BoardError } from "./errors.js";
import type { BoardState, Lease, StateStore, Submission } from "./state.js";
import type { Task } from "./tasks.js";

export type TaskStatus = "open" | "claimed" | "submitted";

export type TaskSummary = {
  id: string;
  title: string;
  priority: number;
  reward_shares: number;
  status: TaskStatus;
  claimed_by: string | null;
  lease_expires_at: string | null;
};

export type TaskDetails = {
  id: string;
  title: string;
  status: TaskStatus;
  priority: number;
  reward_shares: number;
  depends_on: string[];
  blocked_by: string[];
  claimed_by: string | null;
  lease_expires_at: string | null;
  submitted_by: string | null;
  commit_hash: string | null;
};

export type ClaimResult = { task_id: string; agent_id: string; lease_expires_at: string };
export type SubmitResult = { task_id: string; status: "submitted"; submitted_by: string; commit_hash: string };

export type BoardOptions = {
  leaseMs: number;
  store: StateStore;
  now?: () => number;
};

/** priority ascending, then reward_shares descending, then id ascending. */
function compareTasks(a: Task, b: Task): number {
  return a.priority - b.priority || b.reward_shares - a.reward_shares || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * The task board. Every method is synchronous, so on Node's single thread each tool call is applied atomically:
 * concurrent calls on one server cannot interleave between a check and the write it guards.
 * A change is persisted before it becomes visible; if persisting fails, the in-memory state is left untouched.
 */
export class TaskBoard {
  private readonly tasks: Map<string, Task>;
  private readonly leaseMs: number;
  private readonly store: StateStore;
  private readonly now: () => number;
  private state: BoardState;

  constructor(tasks: Task[], options: BoardOptions) {
    this.tasks = new Map(tasks.map((t) => [t.id, t]));
    this.leaseMs = options.leaseMs;
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.state = options.store.load();
  }

  listTasks(agentId?: string): { tasks: TaskSummary[] } {
    const now = this.now();
    const visible = [...this.tasks.values()].filter((task) => {
      const lease = this.activeLease(task.id, now);
      if (lease) return agentId !== undefined && lease.agent_id === agentId;
      return this.isReady(task, now);
    });
    return { tasks: visible.sort(compareTasks).map((task) => this.summary(task, now)) };
  }

  status(taskId: string): TaskDetails {
    const task = this.getTask(taskId);
    const lease = this.activeLease(task.id, this.now());
    const submission = this.submission(task.id);
    return {
      id: task.id,
      title: task.title,
      status: this.statusOf(task.id, lease),
      priority: task.priority,
      reward_shares: task.reward_shares,
      depends_on: [...task.depends_on],
      blocked_by: task.depends_on.filter((dep) => !this.isSubmitted(dep)),
      claimed_by: lease?.agent_id ?? null,
      lease_expires_at: lease?.expires_at ?? null,
      submitted_by: submission?.agent_id ?? null,
      commit_hash: submission?.commit_hash ?? null,
    };
  }

  claim(taskId: string, agentId: string): ClaimResult {
    const now = this.now();
    const task = this.getTask(taskId);
    if (this.isSubmitted(task.id)) throw new BoardError("ALREADY_SUBMITTED", `task ${task.id} is already submitted`);
    const lease = this.activeLease(task.id, now);
    if (lease && lease.agent_id !== agentId) {
      throw new BoardError("ALREADY_CLAIMED", `task ${task.id} is leased by another agent until ${lease.expires_at}`);
    }
    const blockedBy = task.depends_on.filter((dep) => !this.isSubmitted(dep));
    if (blockedBy.length > 0) {
      throw new BoardError("NOT_READY", `task ${task.id} depends on tasks not submitted yet: ${blockedBy.join(", ")}`);
    }
    const held = this.leaseHeldBy(agentId, now);
    if (held && held !== task.id) {
      throw new BoardError("LEASE_LIMIT", `agent ${agentId} already holds an active lease on task ${held}`);
    }

    // A new claim or a renewal: either way the lease runs LEASE_SECONDS from now.
    const expiresAt = new Date(now + this.leaseMs).toISOString();
    this.commit((leases, submissions) => ({
      leases: { ...leases, [task.id]: { agent_id: agentId, expires_at: expiresAt } },
      submissions,
    }), now);
    return { task_id: task.id, agent_id: agentId, lease_expires_at: expiresAt };
  }

  submit(taskId: string, agentId: string, commitHash: string): SubmitResult {
    const now = this.now();
    const task = this.getTask(taskId);
    if (this.isSubmitted(task.id)) throw new BoardError("ALREADY_SUBMITTED", `task ${task.id} is already submitted`);
    const lease = this.activeLease(task.id, now);
    if (!lease || lease.agent_id !== agentId) {
      throw new BoardError("NOT_CLAIMED", `agent ${agentId} has no active lease on task ${task.id}`);
    }

    this.commit((leases, submissions) => {
      const { [task.id]: _released, ...rest } = leases;
      return {
        leases: rest,
        submissions: {
          ...submissions,
          [task.id]: { agent_id: agentId, commit_hash: commitHash, submitted_at: new Date(now).toISOString() },
        },
      };
    }, now);
    return { task_id: task.id, status: "submitted", submitted_by: agentId, commit_hash: commitHash };
  }

  private getTask(taskId: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) throw new BoardError("TASK_NOT_FOUND", `no task with id ${JSON.stringify(taskId)}`);
    return task;
  }

  // Own-property lookups only: a task id such as "constructor" must not match Object.prototype.
  private submission(taskId: string): Submission | undefined {
    return Object.hasOwn(this.state.submissions, taskId) ? this.state.submissions[taskId] : undefined;
  }

  private isSubmitted(taskId: string): boolean {
    return this.submission(taskId) !== undefined;
  }

  /** Not submitted, no active lease, and every dependency submitted. */
  private isReady(task: Task, now: number): boolean {
    return !this.isSubmitted(task.id) && !this.activeLease(task.id, now) && task.depends_on.every((dep) => this.isSubmitted(dep));
  }

  private activeLease(taskId: string, now: number): Lease | undefined {
    const lease = Object.hasOwn(this.state.leases, taskId) ? this.state.leases[taskId] : undefined;
    return lease && Date.parse(lease.expires_at) > now ? lease : undefined;
  }

  /** The id of the task on which the agent holds an active lease, if any. */
  private leaseHeldBy(agentId: string, now: number): string | undefined {
    return Object.keys(this.state.leases).find((taskId) => this.activeLease(taskId, now)?.agent_id === agentId);
  }

  private statusOf(taskId: string, lease: Lease | undefined): TaskStatus {
    if (this.isSubmitted(taskId)) return "submitted";
    return lease ? "claimed" : "open";
  }

  private summary(task: Task, now: number): TaskSummary {
    const lease = this.activeLease(task.id, now);
    return {
      id: task.id,
      title: task.title,
      priority: task.priority,
      reward_shares: task.reward_shares,
      status: this.statusOf(task.id, lease),
      claimed_by: lease?.agent_id ?? null,
      lease_expires_at: lease?.expires_at ?? null,
    };
  }

  /** Applies a change to a copy of the state with expired leases pruned, persists it, then makes it current. */
  private commit(change: (leases: BoardState["leases"], submissions: BoardState["submissions"]) => Omit<BoardState, "version">, now: number): void {
    const live = Object.fromEntries(Object.entries(this.state.leases).filter(([taskId]) => this.activeLease(taskId, now)));
    const next: BoardState = { version: 1, ...change(live, this.state.submissions) };
    this.store.save(next);
    this.state = next;
  }
}
