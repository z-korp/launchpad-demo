export type Config = {
  tasksFile: string;
  stateFile: string;
  leaseMs: number;
};

const DEFAULT_LEASE_SECONDS = 1800;

/** Reads the server configuration from the environment; throws on a missing or invalid value. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const tasksFile = env.TASKS_FILE?.trim();
  if (!tasksFile) throw new Error("TASKS_FILE is required: the path to the tasks JSON file");

  const stateFile = env.STATE_FILE?.trim() || `${tasksFile}.state.json`;
  if (stateFile === tasksFile) throw new Error("STATE_FILE must differ from TASKS_FILE: the tasks file is read-only");

  let leaseSeconds = DEFAULT_LEASE_SECONDS;
  const rawLease = env.LEASE_SECONDS?.trim();
  if (rawLease) {
    leaseSeconds = Number(rawLease);
    if (!Number.isFinite(leaseSeconds) || leaseSeconds <= 0) {
      throw new Error(`LEASE_SECONDS must be a positive number of seconds, got ${JSON.stringify(env.LEASE_SECONDS)}`);
    }
  }

  return { tasksFile, stateFile, leaseMs: leaseSeconds * 1000 };
}
