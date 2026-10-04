import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { z } from "zod";

const LeaseSchema = z.object({ agent_id: z.string(), expires_at: z.string() });
const SubmissionSchema = z.object({ agent_id: z.string(), commit_hash: z.string(), submitted_at: z.string() });

const StateSchema = z.object({
  version: z.literal(1),
  leases: z.record(LeaseSchema),
  submissions: z.record(SubmissionSchema),
});

export type Lease = z.infer<typeof LeaseSchema>;
export type Submission = z.infer<typeof SubmissionSchema>;
/** The mutable part of the board, keyed by task id. Leases may be expired: expiry is evaluated lazily. */
export type BoardState = z.infer<typeof StateSchema>;

export const emptyState = (): BoardState => ({ version: 1, leases: {}, submissions: {} });

/** Persists the board state to one JSON file. */
export interface StateStore {
  load(): BoardState;
  save(state: BoardState): void;
}

export class FileStateStore implements StateStore {
  constructor(private readonly file: string) {}

  /** A missing file is an empty board; an unreadable or corrupt one stops the server rather than being overwritten. */
  load(): BoardState {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw new Error(`cannot read STATE_FILE ${this.file}: ${(e as Error).message}`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      throw new Error(`STATE_FILE ${this.file} is not valid JSON: ${(e as Error).message}`);
    }
    const parsed = StateSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`STATE_FILE ${this.file} has an unexpected shape: ${parsed.error.issues[0].message}`);
    return parsed.data;
  }

  /**
   * Writes atomically and durably: a temporary file in the same directory is written and fsynced, then renamed
   * over the state file, so a crash leaves either the old state or the new one, never a truncated file.
   * Synchronous on purpose: a tool call answers only once its change is on disk.
   */
  save(state: BoardState): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      const fd = openSync(tmp, "w", 0o600);
      try {
        writeSync(fd, JSON.stringify(state, null, 2) + "\n");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, this.file);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  }
}
