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
  | "PLAN_REQUIRED"
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

export const PRICING_URL = "https://micropage.sh/pricing";

/**
 * Server tier refusals carry `code: "plan_required"` in the body while reusing
 * 402/403, which also mean "not yours" or "invalid token". Returns the
 * PLAN_REQUIRED error for such a body, or null so callers fall back to the
 * status code.
 */
export function planRequiredError(data: unknown, options: MicropageErrorOptions = {}): MicropageError | null {
  if (!data || typeof data !== "object") return null;
  const body = data as Record<string, unknown>;
  if (body.code !== "plan_required") return null;
  const tierLabel = body.required_tier === "pro_plus" ? "Pro+" : body.required_tier === "pro" ? "Pro" : null;
  const reason =
    (typeof body.error === "string" && body.error.trim()) ||
    `This needs ${tierLabel ? `the ${tierLabel} plan` : "a higher micropage plan"}.`;
  const url = (typeof body.upgrade_url === "string" && body.upgrade_url) || PRICING_URL;
  const sentence = /[.!?]$/.test(reason) ? reason : `${reason}.`;
  return new MicropageError("PLAN_REQUIRED", `${sentence} Upgrade at ${url}.`, { ...options, data });
}
