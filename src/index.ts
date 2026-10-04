import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

type Task = { id: string; title: string; priority: number; reward_shares: number; depends_on: string[] };
type State = {
  leases: Record<string, { agent_id: string; expires_at: number }>;
  submissions: Record<string, { submitted_by: string; commit_hash: string }>;
};

class ToolError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const TASKS_FILE = process.env.TASKS_FILE;
if (!TASKS_FILE) {
  console.error("TASKS_FILE is required");
  process.exit(1);
}
const STATE_FILE = process.env.STATE_FILE || `${TASKS_FILE}.state.json`;
const parsedLease = Number(process.env.LEASE_SECONDS);
const LEASE_MS = (process.env.LEASE_SECONDS && Number.isFinite(parsedLease) && parsedLease > 0 ? parsedLease : 1800) * 1000;

const tasks: Task[] = JSON.parse(readFileSync(TASKS_FILE, "utf8")).tasks ?? [];
const byId = new Map(tasks.map((t) => [t.id, t]));

const state: State = { leases: {}, submissions: {} };
if (existsSync(STATE_FILE)) {
  try {
    const saved = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    state.leases = saved.leases ?? {};
    state.submissions = saved.submissions ?? {};
  } catch (e) {
    console.error("could not read state file, starting empty:", e);
  }
}

function persist() {
  const tmp = `${STATE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, STATE_FILE);
}

// Lazy expiry: drop leases whose time has passed. Returns whether anything changed.
function expire(now: number) {
  let changed = false;
  for (const [id, l] of Object.entries(state.leases)) {
    if (l.expires_at <= now) {
      delete state.leases[id];
      changed = true;
    }
  }
  if (changed) persist();
}

const isSubmitted = (id: string) => id in state.submissions;
const isReady = (t: Task) => !isSubmitted(t.id) && !state.leases[t.id] && t.depends_on.every(isSubmitted);
const iso = (ms: number) => new Date(ms).toISOString();

function summary(t: Task) {
  const l = state.leases[t.id];
  return {
    id: t.id,
    title: t.title,
    priority: t.priority,
    reward_shares: t.reward_shares,
    status: isSubmitted(t.id) ? "submitted" : l ? "claimed" : "open",
    claimed_by: l ? l.agent_id : null,
    lease_expires_at: l ? iso(l.expires_at) : null,
  };
}

function str(args: any, key: string, optional = false): string | undefined {
  const v = args?.[key];
  if (v === undefined && optional) return undefined;
  if (typeof v !== "string" || v === "") throw new ToolError("INVALID_INPUT", `${key} must be a non-empty string`);
  return v;
}

const handlers: Record<string, (args: any) => unknown> = {
  list_tasks(args) {
    const agent = str(args, "agent_id", true);
    const now = Date.now();
    expire(now);
    const out = tasks.filter((t) => isReady(t) || (agent !== undefined && state.leases[t.id]?.agent_id === agent));
    out.sort((a, b) => a.priority - b.priority || b.reward_shares - a.reward_shares || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { tasks: out.map(summary) };
  },

  claim(args) {
    const task_id = str(args, "task_id")!;
    const agent_id = str(args, "agent_id")!;
    const now = Date.now();
    expire(now);
    const t = byId.get(task_id);
    if (!t) throw new ToolError("TASK_NOT_FOUND", `unknown task ${task_id}`);
    if (isSubmitted(task_id)) throw new ToolError("ALREADY_SUBMITTED", `task ${task_id} is already submitted`);
    const lease = state.leases[task_id];
    if (lease && lease.agent_id !== agent_id) throw new ToolError("ALREADY_CLAIMED", `task ${task_id} is leased by another agent`);
    const blocked = t.depends_on.filter((d) => !isSubmitted(d));
    if (blocked.length) throw new ToolError("NOT_READY", `task ${task_id} is blocked by ${blocked.join(", ")}`);
    const other = Object.entries(state.leases).find(([id, l]) => l.agent_id === agent_id && id !== task_id);
    if (other) throw new ToolError("LEASE_LIMIT", `agent ${agent_id} already holds a lease on ${other[0]}`);
    const expires_at = now + LEASE_MS;
    state.leases[task_id] = { agent_id, expires_at };
    persist();
    return { task_id, agent_id, lease_expires_at: iso(expires_at) };
  },

  submit(args) {
    const task_id = str(args, "task_id")!;
    const agent_id = str(args, "agent_id")!;
    const commit_hash = str(args, "commit_hash")!;
    if (!/^[0-9a-f]{40}$/.test(commit_hash)) throw new ToolError("INVALID_INPUT", "commit_hash must be 40 lowercase hex characters");
    expire(Date.now());
    if (!byId.has(task_id)) throw new ToolError("TASK_NOT_FOUND", `unknown task ${task_id}`);
    if (isSubmitted(task_id)) throw new ToolError("ALREADY_SUBMITTED", `task ${task_id} is already submitted`);
    if (state.leases[task_id]?.agent_id !== agent_id) throw new ToolError("NOT_CLAIMED", `agent ${agent_id} has no active lease on ${task_id}`);
    delete state.leases[task_id];
    state.submissions[task_id] = { submitted_by: agent_id, commit_hash };
    persist();
    return { task_id, status: "submitted", submitted_by: agent_id, commit_hash };
  },

  status(args) {
    const task_id = str(args, "task_id")!;
    expire(Date.now());
    const t = byId.get(task_id);
    if (!t) throw new ToolError("TASK_NOT_FOUND", `unknown task ${task_id}`);
    const s = summary(t);
    const sub = state.submissions[task_id];
    return {
      id: t.id,
      title: t.title,
      status: s.status,
      priority: t.priority,
      reward_shares: t.reward_shares,
      depends_on: t.depends_on,
      blocked_by: t.depends_on.filter((d) => !isSubmitted(d)),
      claimed_by: s.claimed_by,
      lease_expires_at: s.lease_expires_at,
      submitted_by: sub ? sub.submitted_by : null,
      commit_hash: sub ? sub.commit_hash : null,
    };
  },
};

const str_ = (description: string) => ({ type: "string", description });
const tools = [
  { name: "list_tasks", description: "List ready tasks, plus the task leased by agent_id if given.",
    inputSchema: { type: "object", properties: { agent_id: str_("optional agent id") } } },
  { name: "claim", description: "Claim (or renew) a lease on a task.",
    inputSchema: { type: "object", properties: { task_id: str_("task id"), agent_id: str_("agent id") }, required: ["task_id", "agent_id"] } },
  { name: "submit", description: "Submit a claimed task with a 40-char lowercase git SHA.",
    inputSchema: { type: "object", properties: { task_id: str_("task id"), agent_id: str_("agent id"), commit_hash: str_("full git sha") }, required: ["task_id", "agent_id", "commit_hash"] } },
  { name: "status", description: "Full status of one task.",
    inputSchema: { type: "object", properties: { task_id: str_("task id") }, required: ["task_id"] } },
];

const server = new Server({ name: "task-board", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const handler = handlers[req.params.name];
  if (!handler) {
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code: "UNKNOWN_TOOL", message: `unknown tool ${req.params.name}` } }) }] };
  }
  try {
    const args = req.params.arguments;
    return { content: [{ type: "text", text: JSON.stringify(handler(args && typeof args === "object" ? args : {})) }] };
  } catch (e) {
    const code = e instanceof ToolError ? e.code : "INTERNAL";
    const message = e instanceof Error ? e.message : String(e);
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }] };
  }
});

await server.connect(new StdioServerTransport());
