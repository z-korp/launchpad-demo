import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { BoardError, TaskBoard, inputSchemas } from "./board.js";

const text = (payload: unknown) => [{ type: "text" as const, text: JSON.stringify(payload) }];
const string = { type: "string", minLength: 1 };
const tools = [
  { name: "list_tasks", description: "List ready tasks and optionally the agent's active lease", inputSchema: { type: "object" as const, properties: { agent_id: string } } },
  { name: "claim", description: "Claim a ready task or renew its active lease", inputSchema: { type: "object" as const, properties: { task_id: string, agent_id: string }, required: ["task_id", "agent_id"] } },
  { name: "submit", description: "Submit a leased task with its git commit", inputSchema: { type: "object" as const, properties: { task_id: string, agent_id: string, commit_hash: { type: "string", pattern: "^[0-9a-f]{40}$" } }, required: ["task_id", "agent_id", "commit_hash"] } },
  { name: "status", description: "Read task status and blocking dependencies", inputSchema: { type: "object" as const, properties: { task_id: string }, required: ["task_id"] } },
];

async function main() {
  const tasksFile = process.env.TASKS_FILE;
  if (!tasksFile) throw new Error("TASKS_FILE is required");
  const board = new TaskBoard(tasksFile, process.env.STATE_FILE, Number(process.env.LEASE_SECONDS ?? 1800));
  const server = new Server({ name: "task-board", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  // The low-level handler preserves the brief's tool error format for invalid arguments.
  server.setRequestHandler(CallToolRequestSchema, request => {
    try {
      if (!Object.hasOwn(inputSchemas, request.params.name)) throw new BoardError("INVALID_INPUT", "Unknown tool");
      return { content: text(board.execute(request.params.name as keyof typeof inputSchemas, request.params.arguments ?? {})) };
    } catch (error) {
      if (error instanceof BoardError) return { isError: true, content: text({ error: { code: error.code, message: error.message } }) };
      console.error("Task board operation failed:", error);
      return { isError: true, content: text({ error: { code: "INTERNAL_ERROR", message: "Task state operation failed" } }) };
    }
  });
  await server.connect(new StdioServerTransport());
}
main().catch(error => { console.error(error); process.exitCode = 1; });
