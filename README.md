# Task board MCP server

A TypeScript stdio MCP server implementing the M1 task lifecycle.

## Run

Install dependencies with `npm ci`, then run:

```sh
TASKS_FILE=fixtures/tasks.sample.json npm start
```

`TASKS_FILE` is read only. `STATE_FILE` defaults to `${TASKS_FILE}.state.json`.
`LEASE_SECONDS` defaults to 1800 and must be a positive finite number.
The state file's parent directory must exist and be writable. Use one server
process per state file; cross-process coordination is not provided.

The tools are `list_tasks`, `claim`, `submit`, and `status`. Each returns one text
item containing JSON. Application errors have `isError: true` and an
`error` object containing `code` and `message`. Diagnostics go to stderr.

## State and concurrency

Requests run as synchronous transactions within the server process. Expired
leases are removed at the next valid tool call. Each change writes a temporary
file beside the state file, flushes it, renames it over the state file, and
flushes the directory. In-memory state changes after the rename. Corrupt state
fails startup rather than silently losing submissions. Keep the tasks file
unchanged when restarting an existing board.

## Development

```sh
npm test
npx tsc --noEmit
npx vitest run checks
```

`src/board.ts` holds validation, task operations, and storage. `src/index.ts`
adapts these operations to the MCP transport. Board tests use an injected clock
for exact lease boundaries and exercise storage failures.
