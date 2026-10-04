/** Unverified JWT claims. Only used to read `exp`, `sub` and `email` of tokens we already trust. */
export interface JwtClaims {
  exp?: number;
  sub?: string;
  email?: string;
  [claim: string]: unknown;
}

export function decodeJwtClaims(token: string): JwtClaims | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return claims && typeof claims === "object" ? (claims as JwtClaims) : null;
  } catch {
    return null;
  }
}

/**
 * True when the token expires within `skewSeconds` (default 60, as the CLI).
 * An unreadable token counts as expired so it gets refreshed rather than sent.
 */
export function isJwtExpiring(token: string, nowMs: number, skewSeconds = 60): boolean {
  const exp = decodeJwtClaims(token)?.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return true;
  return exp < Math.floor(nowMs / 1000) + skewSeconds;
}
