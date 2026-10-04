export type MicropageErrorCode =
  | "NOT_LOGGED_IN"
  | "SESSION_EXPIRED"
  | "HTTP"
  | "TIMEOUT"
  | "NETWORK"
  | "CONFIRM_REQUIRED"
  | "CONFIRM_INVALID"
  | "DISABLED"
  | "NOT_ALLOWED_IN_DEPLOY_TOKEN_MODE"
  | (string & {});

export interface MicropageErrorOptions {
  status?: number;
  data?: unknown;
  cause?: unknown;
}

/**
 * The one error type the client and guards throw. `message` is written for
 * the model: it says what went wrong and names the call or argument that
 * fixes it, because the model sees nothing else.
 */
export class MicropageError extends Error {
  readonly code: MicropageErrorCode;
  readonly status: number | undefined;
  readonly data: unknown;

  constructor(code: MicropageErrorCode, message: string, options: MicropageErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "MicropageError";
    this.code = code;
    this.status = options.status;
    this.data = options.data;
  }
}

export function isMicropageError(err: unknown): err is MicropageError {
  return err instanceof MicropageError;
}
