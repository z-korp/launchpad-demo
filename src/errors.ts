export type ErrorCode =
  | "INVALID_INPUT"
  | "TASK_NOT_FOUND"
  | "ALREADY_SUBMITTED"
  | "ALREADY_CLAIMED"
  | "NOT_READY"
  | "LEASE_LIMIT"
  | "NOT_CLAIMED"
  | "UNKNOWN_TOOL"
  | "INTERNAL_ERROR";

/** An expected failure of a tool call, reported to the client as `{"error": {code, message}}`. */
export class BoardError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BoardError";
  }
}
