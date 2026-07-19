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

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
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
