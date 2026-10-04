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
      if (dep === task.id) throw new Error(`invalid tasks file: task ${JSON.stringify(task.id)} depends on itself`);
    }
  }
  return tasks;
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
