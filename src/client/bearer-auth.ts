import type { AuthProvider } from "./auth-provider.js";
import { MicropageError } from "./errors.js";

export const REAUTH_MESSAGE =
  "The micropage authorization for this connection has expired or was revoked. Ask the user to reconnect " +
  "(re-authenticate) the micropage connector in their MCP client, then retry. Nothing was changed by the failed call.";

/**
 * Serves one access token that the caller already verified (the remote
 * server checks each request's bearer before building deps). It cannot
 * refresh: the refresh token belongs to the MCP client, so a token the API
 * rejects ends the request with AUTH_EXPIRED and the client re-authenticates.
 */
export class BearerAuthProvider implements AuthProvider {
  readonly mode = "oauth" as const;
  private readonly accessToken: string;

  constructor(accessToken: string) {
    if (!accessToken.trim()) throw new MicropageError("AUTH_EXPIRED", REAUTH_MESSAGE);
    this.accessToken = accessToken;
  }

  async getAccessToken(options: { forceRefresh?: boolean } = {}): Promise<string> {
    if (options.forceRefresh) throw new MicropageError("AUTH_EXPIRED", REAUTH_MESSAGE, { status: 401 });
    return this.accessToken;
  }
}
