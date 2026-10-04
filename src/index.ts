import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TaskBoard } from "./board.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { FileStateStore } from "./state.js";
import { loadTasks } from "./tasks.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const board = new TaskBoard(loadTasks(config.tasksFile), {
    leaseMs: config.leaseMs,
    store: new FileStateStore(config.stateFile),
  });
  await createServer(board).connect(new StdioServerTransport());
}

main().catch((e: unknown) => {
  console.error(`task board: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
