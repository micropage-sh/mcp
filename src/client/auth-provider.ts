import { MicropageError } from "./errors.js";
import { decodeJwtClaims } from "./jwt.js";

export type AuthMode = "session" | "deploy_token" | "oauth" | "none";

export const LOGIN_HINT = "Run `micropage login` in a terminal, then retry.";

/**
 * Where access tokens come from. Injected into Http so the same client code
 * serves the stdio server (CLI session file or deploy token) and the remote
 * server (an OAuth bearer per request).
 */
export interface AuthProvider {
  readonly mode: AuthMode;
  /** Set in deploy-token mode: the only project this process may touch. */
  readonly pinnedProjectUuid?: string;
  /** Set in session mode: the CLI session file in use. */
  readonly sessionPath?: string;
  /**
   * A currently valid access token. With `forceRefresh` the provider must
   * not return its cached token without first trying to obtain a new one;
   * Http calls it that way exactly once after a 401.
   */
  getAccessToken(options?: { forceRefresh?: boolean }): Promise<string>;
}

/** The signed-in user's id, read from the current access token's `sub`. */
export async function currentUserId(auth: AuthProvider): Promise<string> {
  const sub = decodeJwtClaims(await auth.getAccessToken())?.sub;
  if (typeof sub !== "string" || !sub) {
    throw new MicropageError("SESSION_EXPIRED", "The micropage access token has no user id. Run `micropage login` in a terminal, then retry.");
  }
  return sub;
}

/** Placeholder used until a real provider is resolved: every call explains how to log in. */
export class NoAuthProvider implements AuthProvider {
  readonly mode = "none" as const;

  async getAccessToken(): Promise<string> {
    throw new MicropageError(
      "NOT_LOGGED_IN",
      "Not logged in to micropage. Ask the user to run `micropage login` in a terminal " +
        "(or set MICROPAGE_DEPLOY_TOKEN and MICROPAGE_DEPLOY_PROJECT), then retry.",
    );
  }
}
