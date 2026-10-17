/**
 * Typed HTTP error for backend API calls.
 *
 * The API client helpers historically threw plain {@link Error} instances whose
 * only signal was a status code buried in the message string. Callers that
 * needed to branch on status (e.g. 403 vs 404) resorted to fragile
 * `message.includes("403")` checks. {@link ApiError} carries the status as a
 * structured field so access/permission logic can be expressed precisely.
 */
export class ApiError extends Error {
  readonly status: number;
  /**
   * The FastAPI `detail` field as parsed from the JSON body — a string for
   * plain refusals, an object (`{kind, msg}`) for structured ones — so
   * callers can branch on the machine-readable `kind` instead of matching
   * message substrings. Undefined when the body carried no JSON detail.
   */
  readonly detail: unknown;

  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

/** Guard for {@link ApiError.detail} objects with a machine-readable `kind`. */
export function errorDetailKind(error: unknown): string | null {
  if (!isApiError(error)) return null;
  const detail = error.detail;
  if (detail === null || typeof detail !== "object") return null;
  const kind = (detail as Record<string, unknown>).kind;
  return typeof kind === "string" && kind ? kind : null;
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** `true` when the backend rejected the request because the caller lacks access. */
export function isForbidden(error: unknown): boolean {
  return isApiError(error) && error.status === 403;
}

/** `true` when the backend could not find the target resource. */
export function isNotFoundStatus(error: unknown): boolean {
  return isApiError(error) && error.status === 404;
}

/** `true` when the backend rejected the request because the caller is not authenticated. */
export function isUnauthorized(error: unknown): boolean {
  return isApiError(error) && error.status === 401;
}
