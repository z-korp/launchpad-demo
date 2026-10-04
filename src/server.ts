import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { TaskBoard } from "./board.js";
import { BoardError } from "./errors.js";

const id = z
  .string({ required_error: "is required", invalid_type_error: "must be a string" })
  .refine((s) => s.trim().length > 0, "must be a non-empty string");
const commitHash = z
  .string({ required_error: "is required", invalid_type_error: "must be a string" })
  .regex(/^[0-9a-f]{40}$/, "must be a full 40-character lowercase hexadecimal git SHA");

const inputs = {
  list_tasks: z.object({ agent_id: id.optional() }),
  claim: z.object({ task_id: id, agent_id: id }),
  submit: z.object({ task_id: id, agent_id: id, commit_hash: commitHash }),
  status: z.object({ task_id: id }),
};

type ToolName = keyof typeof inputs;

const idSchema = { type: "string", minLength: 1 };
const TOOLS: { name: ToolName; description: string; inputSchema: { type: "object"; properties: Record<string, object>; required?: string[] } }[] = [
  {
    name: "list_tasks",
    description: "List the tasks ready to be claimed, ordered by priority, then reward, then id. With agent_id, also the task that agent currently leases.",
    inputSchema: { type: "object", properties: { agent_id: idSchema } },
  },
  {
    name: "claim",
    description: "Take a lease on a ready task, or renew your lease on it. An agent holds at most one active lease.",
    inputSchema: { type: "object", properties: { task_id: idSchema, agent_id: idSchema }, required: ["task_id", "agent_id"] },
  },
  {
    name: "submit",
    description: "Submit a task you hold an active lease on, with the full git SHA of your work. Final; releases the lease.",
    inputSchema: {
      type: "object",
      properties: { task_id: idSchema, agent_id: idSchema, commit_hash: { type: "string", pattern: "^[0-9a-f]{40}$" } },
      required: ["task_id", "agent_id", "commit_hash"],
    },
  },
  {
    name: "status",
    description: "Show one task: its status, lease, submission and the dependencies still blocking it.",
    inputSchema: { type: "object", properties: { task_id: idSchema }, required: ["task_id"] },
  },
];

const ok = (payload: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });
const fail = (code: string, message: string): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }],
  isError: true,
});

function parseInput<T extends ToolName>(tool: T, args: unknown): z.infer<(typeof inputs)[T]> {
  const parsed = inputs[tool].safeParse(args ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue.path.join(".");
    throw new BoardError("INVALID_INPUT", field ? `${field} ${issue.message}` : `arguments ${issue.message}`);
  }
  return parsed.data as z.infer<(typeof inputs)[T]>;
}

/** Runs one tool call. Every failure, expected or not, becomes a tool error result rather than a protocol error. */
export function callTool(board: TaskBoard, name: string, args: unknown): CallToolResult {
  try {
    switch (name) {
      case "list_tasks":
        return ok(board.listTasks(parseInput("list_tasks", args).agent_id));
      case "claim": {
        const input = parseInput("claim", args);
        return ok(board.claim(input.task_id, input.agent_id));
      }
      case "submit": {
        const input = parseInput("submit", args);
        return ok(board.submit(input.task_id, input.agent_id, input.commit_hash));
      }
      case "status":
        return ok(board.status(parseInput("status", args).task_id));
      default:
        return fail("UNKNOWN_TOOL", `no tool named ${JSON.stringify(name)}`);
    }
  } catch (e) {
    if (e instanceof BoardError) return fail(e.code, e.message);
    console.error(e);
    return fail("INTERNAL_ERROR", "the server could not complete the call; nothing was changed");
  }
}

export function createServer(board: TaskBoard): Server {
  const server = new Server({ name: "launchpad-task-board", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => callTool(board, request.params.name, request.params.arguments));
  return server;
}
