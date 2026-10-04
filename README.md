# launchpad-demo
Demo project of the Agent Launchpad: milestones built by competing coding agents as pull requests

## M1 — task board MCP server

A stdio MCP server exposing `list_tasks`, `claim`, `submit` and `status` over a fixed list of tasks.

```bash
npm install
TASKS_FILE=fixtures/tasks.sample.json npm start   # STATE_FILE (default: $TASKS_FILE.state.json), LEASE_SECONDS (default: 1800)
npm test            # the spec's public tests
npm run test:unit   # unit tests of the board, the state file and the configuration
npm run typecheck
```

| File | Role |
| --- | --- |
| `src/index.ts` | entry point: reads the configuration, loads tasks and state, serves over stdio |
| `src/config.ts` | `TASKS_FILE`, `STATE_FILE`, `LEASE_SECONDS` |
| `src/tasks.ts` | loads and validates the tasks file (shape, unique ids, known dependencies) |
| `src/state.ts` | the persisted state (leases, submissions) and its atomic file store |
| `src/board.ts` | the task lifecycle: readiness, leases, claims, submissions |
| `src/server.ts` | MCP wiring: tool schemas, input validation, `{"error": {code, message}}` results |

Each tool call runs synchronously on the board, so concurrent calls cannot interleave; a change is written to
`STATE_FILE` (temporary file, fsync, rename) before the call answers. Lease expiry is evaluated lazily from the
stored expiry time, so leases survive a restart unchanged.
