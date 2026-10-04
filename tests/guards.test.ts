import { randomBytes } from "node:crypto";

import { isInputRequiredResult, type ServerContext } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";

import { MicropageError } from "../src/client/errors.js";
import {
  ConfirmationTokens,
  assertDeployTokenAllows,
  canonicalJson,
  elicitConfirmation,
  readEnvFlags,
  requireConfirm,
  requireConfirmMatch,
  requireConfirmationToken,
  supportsFormElicitation,
} from "../src/guards.js";
import { createFakeFetch, makeHttp } from "./helpers/fake-fetch.js";

describe("env flags", () => {
  it("default every switch off", () => {
    expect(readEnvFlags({})).toEqual({ allowSend: false, allowDelete: false, submissions: false });
  });

  it("accept the usual truthy spellings only", () => {
    expect(
      readEnvFlags({ MICROPAGE_MCP_ALLOW_SEND: "1", MICROPAGE_MCP_ALLOW_DELETE: "true", MICROPAGE_MCP_SUBMISSIONS: "0" }),
    ).toEqual({ allowSend: true, allowDelete: true, submissions: false });
  });
});

describe("requireConfirm", () => {
  // Stand-in for an outward-facing tool: guard first, then the network.
  async function publish(args: { confirm?: boolean }, fake = createFakeFetch({ body: {} })) {
    requireConfirm(args, "Publishing build 12");
    await makeHttp(fake).invoke("publish-build", { build_id: 12 });
    return fake;
  }

  it("throws a model-facing error and makes zero fetch calls when confirm is missing", async () => {
    const fake = createFakeFetch({ body: {} });
    const err = await publish({}, fake).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MicropageError);
    expect((err as MicropageError).code).toBe("CONFIRM_REQUIRED");
    expect((err as MicropageError).message).toMatch(/confirm: true/);
    expect(fake.calls).toHaveLength(0);
  });

  it("rejects confirm: false the same way", async () => {
    const fake = createFakeFetch({ body: {} });
    await expect(publish({ confirm: false }, fake)).rejects.toMatchObject({ code: "CONFIRM_REQUIRED" });
    expect(fake.calls).toHaveLength(0);
  });

  it("lets confirm: true through", async () => {
    const fake = await publish({ confirm: true });
    expect(fake.calls).toHaveLength(1);
  });

  it("requireConfirmMatch names the exact value it wants", () => {
    expect(() => requireConfirmMatch("wrong.micropage.sh", "acme", "confirm_domain", "Deleting acme")).toThrow(
      /confirm_domain: "acme"/,
    );
    expect(() => requireConfirmMatch(" ACME ", "acme", "confirm_domain", "Deleting acme")).not.toThrow();
  });
});

describe("confirmation tokens", () => {
  const payload = { post_id: 4, updated_at: "2026-10-04T10:00:00Z", email_enabled: true, form_id: 2, recipients: 31 };

  it("round-trips for the same payload regardless of key order", () => {
    const tokens = new ConfirmationTokens();
    const token = tokens.mint(payload);
    const reordered = { recipients: 31, form_id: 2, email_enabled: true, updated_at: payload.updated_at, post_id: 4 };
    expect(tokens.verify(token, reordered)).toEqual({ ok: true });
  });

  it("rejects a token whose signature was tampered with", () => {
    const tokens = new ConfirmationTokens();
    const token = tokens.mint(payload);
    const dot = token.indexOf(".");
    const i = dot + 10;
    const tampered = token.slice(0, i) + (token[i] === "A" ? "B" : "A") + token.slice(i + 1);
    expect(tokens.verify(tampered, payload)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects a non-canonical encoding of a valid signature", () => {
    const tokens = new ConfirmationTokens();
    const token = tokens.mint(payload);
    // Flip only the padding bits of the last char: same bytes, different string.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = alphabet.indexOf(token.at(-1)!);
    const twin = token.slice(0, -1) + alphabet[last ^ 1];
    expect(tokens.verify(twin, payload)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects a token whose expiry was pushed out", () => {
    const tokens = new ConfirmationTokens();
    const [, sig] = tokens.mint(payload).split(".");
    const forged = `${(Date.now() + 10 ** 9).toString(36)}.${sig}`;
    expect(tokens.verify(forged, payload)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects when the underlying state changed since the preview", () => {
    const tokens = new ConfirmationTokens();
    const token = tokens.mint(payload);
    expect(tokens.verify(token, { ...payload, updated_at: "2026-10-04T10:05:00Z" })).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("rejects a token minted by another process (different key)", () => {
    const token = new ConfirmationTokens({ key: randomBytes(32) }).mint(payload);
    expect(new ConfirmationTokens({ key: randomBytes(32) }).verify(token, payload).ok).toBe(false);
  });

  it("expires", () => {
    let now = 1_000_000;
    const tokens = new ConfirmationTokens({ now: () => now });
    const token = tokens.mint(payload, 60_000);
    now += 60_001;
    expect(tokens.verify(token, payload)).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects garbage", () => {
    expect(new ConfirmationTokens().verify("not a token", payload)).toEqual({ ok: false, reason: "malformed" });
  });

  it("requireConfirmationToken tells the model to preview again", () => {
    const tokens = new ConfirmationTokens();
    expect(() => requireConfirmationToken(tokens, undefined, payload, "preview_post_send")).toThrow(
      /Call preview_post_send again/,
    );
    expect(() => requireConfirmationToken(tokens, tokens.mint(payload), payload, "preview_post_send")).not.toThrow();
  });

  it("canonicalJson sorts nested keys", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [{ f: 1, e: 0 }] } })).toBe('{"a":{"c":[{"e":0,"f":1}],"d":2},"b":1}');
  });
});

describe("elicitation helper", () => {
  const ctxWith = (inputResponses?: Record<string, unknown>) =>
    ({ mcpReq: inputResponses ? { inputResponses } : {} }) as unknown as ServerContext;
  const ask = { key: "confirm_send", message: "Email 31 subscribers?" };

  it("detects form support, including the pre-modes empty object", () => {
    expect(supportsFormElicitation(undefined)).toBe(false);
    expect(supportsFormElicitation({})).toBe(false);
    expect(supportsFormElicitation({ elicitation: {} })).toBe(true);
    expect(supportsFormElicitation({ elicitation: { form: {} } })).toBe(true);
    expect(supportsFormElicitation({ elicitation: { url: {} } })).toBe(false);
  });

  it("reports unsupported when the client cannot elicit", () => {
    expect(elicitConfirmation(ctxWith(), {}, ask)).toEqual({ status: "unsupported" });
  });

  it("returns an input-required result when the client can elicit and has not answered", () => {
    const outcome = elicitConfirmation(ctxWith(), { elicitation: {} }, ask);
    expect(outcome.status).toBe("pending");
    if (outcome.status !== "pending") return;
    expect(isInputRequiredResult(outcome.result)).toBe(true);
    expect(Object.keys(outcome.result.inputRequests ?? {})).toEqual(["confirm_send"]);
  });

  it("reads an accepted answer on the retried request", () => {
    const outcome = elicitConfirmation(
      ctxWith({ confirm_send: { action: "accept", content: { confirm: true } } }),
      { elicitation: {} },
      ask,
    );
    expect(outcome).toEqual({ status: "accepted", content: { confirm: true } });
  });

  it("treats decline, cancel and an unticked box as declined", () => {
    for (const answer of [
      { action: "decline" },
      { action: "cancel" },
      { action: "accept", content: { confirm: false } },
    ]) {
      expect(elicitConfirmation(ctxWith({ confirm_send: answer }), { elicitation: {} }, ask)).toEqual({
        status: "declined",
      });
    }
  });
});

describe("deploy-token allowlist", () => {
  const pinned = { mode: "deploy_token" as const, pinnedProjectUuid: "11111111-1111-1111-1111-111111111111" };

  it("ignores session mode", () => {
    expect(() => assertDeployTokenAllows({ mode: "session" }, "delete_project", "other")).not.toThrow();
  });

  it("rejects tools outside the allowlist", () => {
    expect(() => assertDeployTokenAllows(pinned, "publish_post")).toThrow(/not available with a deploy token/);
  });

  it("rejects other projects and allows the pinned one", () => {
    expect(() => assertDeployTokenAllows(pinned, "publish_build", "22222222-2222-2222-2222-222222222222")).toThrow(
      /pinned to project/,
    );
    expect(() => assertDeployTokenAllows(pinned, "publish_build", pinned.pinnedProjectUuid)).not.toThrow();
  });
});
