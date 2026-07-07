export type ErrorCode =
  | "BAD_REQUEST"
  | "SQL_FORBIDDEN"
  | "APP_DENIED"
  | "CAPABILITY_DENIED"
  | "THROTTLED"
  | "QUERY_TIMEOUT"
  | "RESULT_TOO_LARGE"
  | "SQL_ERROR"
  | "TX_NOT_FOUND"
  | "TX_EXPIRED"
  | "UNAVAILABLE"
  | "INTERNAL";

const STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  SQL_FORBIDDEN: 400,
  APP_DENIED: 403,
  CAPABILITY_DENIED: 403,
  THROTTLED: 429,
  QUERY_TIMEOUT: 408,
  RESULT_TOO_LARGE: 413,
  SQL_ERROR: 400,
  TX_NOT_FOUND: 409,
  TX_EXPIRED: 409,
  UNAVAILABLE: 503,
  INTERNAL: 500,
};

export class ServiceError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
    this.status = STATUS[code];
  }
}

export function toServiceError(err: unknown): ServiceError {
  if (err instanceof ServiceError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new ServiceError("INTERNAL", message);
}
