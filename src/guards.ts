import { createHmac, timingSafeEqual } from "node:crypto";

import {
  inputRequired,
  inputResponse,
  type ClientCapabilities,
  type InputRequiredResult,
  type ServerContext,
} from "@modelcontextprotocol/server";

import type { AuthProvider } from "./client/auth-provider.js";
import { MicropageError } from "./client/errors.js";
import type { Permissions } from "./context.js";

// ---------------------------------------------------------------------------
// Env switches (stdio's source of Permissions)
// ---------------------------------------------------------------------------

const truthy = (v: string | undefined): boolean => /^(1|true|yes|on)$/i.test(v?.trim() ?? "");

export function envPermissions(env: Readonly<Record<string, string | undefined>> = process.env): Permissions {
  return {
    allowSend: truthy(env.MICROPAGE_MCP_ALLOW_SEND),
    allowDelete: truthy(env.MICROPAGE_MCP_ALLOW_DELETE),
    allowSubmissions: truthy(env.MICROPAGE_MCP_SUBMISSIONS),
  };
}

export const NO_PERMISSIONS: Readonly<Permissions> = Object.freeze({ allowSend: false, allowDelete: false, allowSubmissions: false });

// ---------------------------------------------------------------------------
// Confirm arguments
//
// The model can pass any of these on its own, so they are friction that
// forces a deliberate second step, not a security boundary. Every check runs
// before any network call so a refused action has no side effects.
// ---------------------------------------------------------------------------

export function requireConfirm(args: { confirm?: boolean | undefined }, action: string): void {
  if (args.confirm === true) return;
  throw new MicropageError(
    "CONFIRM_REQUIRED",
    `${action} is outward-facing, so it needs \`confirm: true\`. Ask the user to approve it first, ` +
      `then call this tool again with confirm: true. Nothing was changed.`,
  );
}

/** For confirmations that must echo a known value back (e.g. the project's domain before delete). */
export function requireConfirmMatch(
  given: string | undefined,
  expected: string,
  argName: string,
  action: string,
): void {
  if (given !== undefined && given.trim().toLowerCase() === expected.trim().toLowerCase()) return;
  throw new MicropageError(
    "CONFIRM_REQUIRED",
    `${action} needs \`${argName}: "${expected}"\`. Ask the user to confirm, then call this tool again ` +
      `with that exact value. Nothing was changed.`,
  );
}

// ---------------------------------------------------------------------------
// Confirmation tokens
//
// A token binds a preview to the state it was taken over and to the user it
// was shown to: the caller mints it for the user's `sub` over a payload (e.g.
// post id, updated_at, email_enabled, form_id), and on the follow-up call
// re-reads the current state and verifies against that. Any change in
// between, another user's token, a token signed with another key (another
// stdio process, or a rotated remote secret), or an edited token fails.
// ---------------------------------------------------------------------------

export type TokenPayload = Readonly<Record<string, unknown>>;

export type TokenCheck =
  | { ok: true }
  | { ok: false; reason: "malformed" | "expired" | "mismatch" };

export const DEFAULT_TOKEN_TTL_MS = 15 * 60 * 1000;

/** HMAC key: random bytes per stdio process, a Worker secret remotely. */
export type TokenKey = Uint8Array | string;

export class ConfirmationTokens {
  private readonly key: TokenKey;
  private readonly now: () => number;

  constructor(options: { key: TokenKey; now?: () => number }) {
    if (options.key.length < 32) throw new Error("ConfirmationTokens needs a key of at least 32 bytes.");
    this.key = options.key;
    this.now = options.now ?? Date.now;
  }

  mint(sub: string, payload: TokenPayload, ttlMs: number = DEFAULT_TOKEN_TTL_MS): string {
    const expiresAt = this.now() + ttlMs;
    return `${expiresAt.toString(36)}.${this.sign(expiresAt, sub, payload)}`;
  }

  verify(token: string, sub: string, payload: TokenPayload): TokenCheck {
    const match = /^([0-9a-z]+)\.([A-Za-z0-9_-]+)$/.exec(token.trim());
    if (!match) return { ok: false, reason: "malformed" };
    const expiresAt = Number.parseInt(match[1]!, 36);
    if (!Number.isSafeInteger(expiresAt)) return { ok: false, reason: "malformed" };

    const given = Buffer.from(match[2]!, "base64url");
    // Node's decoder ignores the trailing padding bits, so two different
    // strings can decode to the same bytes; only accept the canonical one.
    if (given.toString("base64url") !== match[2]) return { ok: false, reason: "mismatch" };
    const expected = Buffer.from(this.sign(expiresAt, sub, payload), "base64url");
    // Signature is checked before expiry so a forged timestamp reads as a
    // mismatch rather than leaking which part was wrong.
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return { ok: false, reason: "mismatch" };
    }
    if (this.now() > expiresAt) return { ok: false, reason: "expired" };
    return { ok: true };
  }

  private sign(expiresAt: number, sub: string, payload: TokenPayload): string {
    return createHmac("sha256", this.key)
      .update(`${expiresAt}\n${canonicalJson({ sub, payload })}`)
      .digest("base64url");
  }
}

export function requireConfirmationToken(
  tokens: ConfirmationTokens,
  token: string | undefined,
  sub: string,
  payload: TokenPayload,
  previewTool: string,
): void {
  const check: TokenCheck = token ? tokens.verify(token, sub, payload) : { ok: false, reason: "malformed" };
  if (check.ok) return;
  const why =
    !token
      ? "No confirmation_token was given."
      : check.reason === "expired"
        ? "The confirmation_token has expired."
        : check.reason === "mismatch"
          ? "The confirmation_token does not match the current state (it changed since the preview, or the token came from another session or account)."
          : "The confirmation_token is not one this server issued.";
  throw new MicropageError(
    "CONFIRM_INVALID",
    `${why} Call ${previewTool} again, show the user what it reports, and pass its new confirmation_token. Nothing was changed.`,
  );
}

/** Stable JSON: object keys sorted at every depth, so equal payloads sign equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Elicitation
//
// Advisory: a yes from the user here is good evidence, but a client without
// elicitation support must not block the action, so "unsupported" is a normal
// outcome and the caller falls back to its confirm argument. Uses the
// multi-round-trip inputRequired() return, which the SDK serves on both eras
// (natively on 2026-07-28, through its legacy shim on 2025-era connections);
// ctx.mcpReq.elicitInput() is deprecated and throws on 2026-era requests.
// ---------------------------------------------------------------------------

export type ElicitOutcome =
  | { status: "accepted"; content: Record<string, unknown> }
  | { status: "declined" }
  | { status: "unsupported" }
  /** Return `result` from the tool handler; the client re-calls with the user's answer. */
  | { status: "pending"; result: InputRequiredResult };

export interface ConfirmElicitation {
  /** Key the answer comes back under; unique per tool. */
  key: string;
  message: string;
}

export function supportsFormElicitation(caps: ClientCapabilities | undefined): boolean {
  const elicitation = (caps as { elicitation?: Record<string, unknown> } | undefined)?.elicitation;
  if (!elicitation || typeof elicitation !== "object") return false;
  // An empty `elicitation: {}` predates modes and means form support.
  return Object.keys(elicitation).length === 0 || "form" in elicitation;
}

export function elicitConfirmation(
  handlerCtx: ServerContext,
  caps: ClientCapabilities | undefined,
  request: ConfirmElicitation,
): ElicitOutcome {
  const answer = inputResponse(handlerCtx.mcpReq.inputResponses, request.key);
  if (answer.kind === "elicit") {
    if (answer.action === "accept" && answer.content?.confirm === true) {
      return { status: "accepted", content: answer.content };
    }
    return { status: "declined" };
  }
  if (!supportsFormElicitation(caps)) return { status: "unsupported" };
  return {
    status: "pending",
    result: inputRequired({
      inputRequests: {
        [request.key]: inputRequired.elicit({
          message: request.message,
          requestedSchema: {
            type: "object",
            properties: {
              confirm: { type: "boolean", title: "Confirm", description: "Tick to go ahead." },
            },
            required: ["confirm"],
          },
        }),
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// Deploy-token project pin
//
// A deploy-token JWT is a full owner JWT server-side, so this allowlist is
// not real scoping. It bounds what a prompt-injected agent can reach in CI.
// ---------------------------------------------------------------------------

export const DEPLOY_TOKEN_TOOLS: ReadonlySet<string> = new Set([
  "whoami",
  "get_project",
  "get_page_source",
  "save_page",
  "upload_asset",
  "publish_build",
  "get_deploy_status",
  "list_builds",
  "list_files",
]);

export function assertDeployTokenAllows(
  auth: Pick<AuthProvider, "mode" | "pinnedProjectUuid">,
  tool: string,
  projectUuid?: string,
): void {
  if (auth.mode !== "deploy_token") return;
  if (!DEPLOY_TOKEN_TOOLS.has(tool)) {
    throw new MicropageError(
      "NOT_ALLOWED_IN_DEPLOY_TOKEN_MODE",
      `${tool} is not available with a deploy token. This server is limited to: ` +
        `${[...DEPLOY_TOKEN_TOOLS].join(", ")}. Use a full \`micropage login\` session for anything else.`,
    );
  }
  if (projectUuid !== undefined && projectUuid !== auth.pinnedProjectUuid) {
    throw new MicropageError(
      "NOT_ALLOWED_IN_DEPLOY_TOKEN_MODE",
      `This deploy token is pinned to project ${auth.pinnedProjectUuid ?? "(unset)"}; ` +
        `it cannot act on ${projectUuid}. Omit the project or pass the pinned one.`,
    );
  }
}
