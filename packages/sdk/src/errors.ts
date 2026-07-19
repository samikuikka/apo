import { Data } from "effect";

export type ClientErrorCode =
  | "VALIDATION"
  | "HTTP"
  | "NETWORK"
  | "TIMEOUT"
  | "DECODE"
  | "UNKNOWN";

export class ClientError extends Data.TaggedError("ClientError")<{
  code: ClientErrorCode;
  message: string;
  status?: number;
  body?: string;
  retryable?: boolean;
  cause?: unknown;
}> {}

export class ValidationError extends Data.TaggedError("ValidationError")<{}> {}

export class NetworkError extends Data.TaggedError("NetworkError")<{
  message: string;
  cause?: unknown;
}> {}

export class DecodeError extends Data.TaggedError("DecodeError")<{
  message: string;
  cause?: unknown;
}> {}

export class TimeoutError extends Data.TaggedError("TimeoutError")<{
  message: string;
  cause?: unknown;
}> {}

export class RegisterParametersError extends Data.TaggedError(
  "RegisterParametersError"
)<{
  status: number;
  body: string;
}> {}

export class ConfigurationError extends Data.TaggedError("ConfigurationError")<{
  message: string;
  suggestion?: string;
}> {}

const asMessage = (e: unknown): string =>
  e instanceof Error
    ? e.message
    : typeof e === "string"
    ? e
    : JSON.stringify(e);

export const normalizeError = (e: unknown): ClientError => {
  if (e instanceof ValidationError) {
    return new ClientError({
      code: "VALIDATION",
      message: "Invalid parameter definitions (flowName mismatch / missing).",
      cause: e,
    });
  }

  if (e instanceof ConfigurationError) {
    return new ClientError({
      code: "VALIDATION",
      message: e.message,
      cause: e,
    });
  }

  if (e instanceof RegisterParametersError) {
    return new ClientError({
      code: "HTTP",
      message: `Parameter registration failed (HTTP ${e.status}).`,
      status: e.status,
      body: e.body,
      retryable: e.status >= 500 || e.status === 429,
      cause: e,
    });
  }

  if (e instanceof NetworkError) {
    return new ClientError({
      code: "NETWORK",
      message: e.message,
      retryable: true,
      cause: e,
    });
  }

  if (e instanceof DecodeError) {
    return new ClientError({
      code: "DECODE",
      message: e.message,
      retryable: false,
      cause: e,
    });
  }

  if (e instanceof TimeoutError) {
    return new ClientError({
      code: "TIMEOUT",
      message: e.message,
      retryable: true,
      cause: e,
    });
  }

  return new ClientError({
    code: "UNKNOWN",
    message: asMessage(e) || "Unknown error.",
    retryable: false,
    cause: e,
  });
};

export class RenderParameterError extends Data.TaggedError("RenderParameterError")<{
  message: string;
}> {}
