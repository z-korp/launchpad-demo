import { readFileSync } from "node:fs";
import { z } from "zod";

export type Task = {
  id: string;
  title: string;
  priority: number;
  reward_shares: number;
  depends_on: string[];
};

const nonBlank = z.string().refine((s) => s.trim().length > 0, "must be a non-empty string");

const TasksFileSchema = z.object({
  tasks: z.array(
    z.object({
      id: nonBlank,
      title: z.string(),
      priority: z.number().int(),
      reward_shares: z.number().int().positive(),
      depends_on: z.array(nonBlank).default([]),
    }),
  ),
});

/** Validates a parsed tasks file: shape, unique ids, and dependencies on known tasks only. */
export function parseTasks(raw: unknown): Task[] {
  const parsed = TasksFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`invalid tasks file at ${issue.path.join(".") || "<root>"}: ${issue.message}`);
  }
  const tasks = parsed.data.tasks;
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) throw new Error(`invalid tasks file: duplicate task id ${JSON.stringify(task.id)}`);
    ids.add(task.id);
  }
  for (const task of tasks) {
    for (const dep of task.depends_on) {
      if (!ids.has(dep)) throw new Error(`invalid tasks file: task ${JSON.stringify(task.id)} depends on unknown task ${JSON.stringify(dep)}`);
    }
  }
  const cycle = findCycle(tasks);
  if (cycle) throw new Error(`invalid tasks file: dependency cycle ${cycle.join(" -> ")}: these tasks could never be claimed`);
  return tasks;
}

/** Returns one dependency cycle as a list of ids (first id repeated at the end), or undefined. */
function findCycle(tasks: Task[]): string[] | undefined {
  const deps = new Map(tasks.map((t) => [t.id, t.depends_on]));
  const done = new Set<string>();
  const path: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (done.has(id)) return undefined;
    const at = path.indexOf(id);
    if (at >= 0) return [...path.slice(at), id];
    path.push(id);
    for (const dep of deps.get(id) ?? []) {
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    path.pop();
    done.add(id);
    return undefined;
  };
  for (const task of tasks) {
    const cycle = visit(task.id);
    if (cycle) return cycle;
  }
  return undefined;
}

export function loadTasks(file: string): Task[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    throw new Error(`cannot read TASKS_FILE ${file}: ${(e as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`TASKS_FILE ${file} is not valid JSON: ${(e as Error).message}`);
  }
  return parseTasks(raw);
}
