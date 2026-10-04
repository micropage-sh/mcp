import { MicropageError } from "./errors.js";

export type AuthMode = "session" | "deploy_token" | "none";

/**
 * Where access tokens come from. Injected into Http so the same client code
 * serves the stdio server (CLI session file or deploy token) and a future
 * remote server (OAuth bearer per request).
 */
export interface AuthProvider {
  readonly mode: AuthMode;
  /** Set in deploy-token mode: the only project this process may touch. */
  readonly pinnedProjectUuid?: string;
  /**
   * A currently valid access token. With `forceRefresh` the provider must
   * not return its cached token without first trying to obtain a new one;
   * Http calls it that way exactly once after a 401.
   */
  getAccessToken(options?: { forceRefresh?: boolean }): Promise<string>;
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
