import { AuthError } from "./api.ts";
import { dim } from "./format.ts";
import { UnresolvedIdError } from "./prefix.ts";

/** Exit code for a command that failed before producing output. */
export const COMMAND_ERROR_EXIT_CODE = 2;

/**
 * Report a failed command uniformly and return its exit code.
 *
 * Errors the backend (or the CLI's own request layer) communicated
 * deliberately — auth, HTTP failures, timeouts, ambiguous ID prefixes —
 * print their message verbatim. Anything else is a surprise from the
 * network stack, so it's reported as a connectivity problem with the
 * raw message shown dimmed underneath for diagnosis.
 */
export function reportCommandError(error: unknown, backendUrl: string): number {
  const message = error instanceof Error ? error.message : String(error);
  if (isDeliberateError(error, message)) {
    console.error(message);
  } else {
    console.error(`Cannot connect to backend at ${backendUrl}`);
    console.error(dim(message));
  }
  return COMMAND_ERROR_EXIT_CODE;
}

function isDeliberateError(error: unknown, message: string): boolean {
  return (
    error instanceof AuthError ||
    error instanceof UnresolvedIdError ||
    message.startsWith("Backend error") ||
    message.includes("timed out") ||
    message.includes("Cannot connect") ||
    message.includes("matches multiple")
  );
}
