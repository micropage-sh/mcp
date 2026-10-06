import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";

import { RO } from "../annotations.js";
import { isMicropageError } from "../client/errors.js";
import { eq, inList } from "../client/http.js";
import { decodeJwtClaims } from "../client/jwt.js";
import { isPaidTier, type PlanTier } from "../client/tier.js";
import type { ToolContext } from "../context.js";
import { assertDeployTokenAllows } from "../guards.js";
import { structuredResult } from "./shared.js";

export const WhoamiInput = z.object({}).strict();

export const WhoamiOutput = z.object({
  logged_in: z.boolean(),
  auth_mode: z.enum(["session", "deploy_token", "oauth", "none"]),
  user_id: z.string().nullable(),
  email: z.string().nullable(),
  name: z.string().nullable(),
  plan_tier: z.enum(["free", "pro", "pro_plus"]).nullable().describe("Null when it could not be read."),
  paid_plan: z.boolean().nullable().describe("Every tool except whoami and get_markup_reference needs a paid plan."),
  subscription: z
    .object({
      status: z.string().nullable(),
      plan_tier: z.string().nullable(),
      provider: z.string().nullable(),
      product_name: z.string().nullable(),
      current_period_end: z.string().nullable(),
    })
    .nullable(),
  pinned_project_uuid: z.string().nullable().describe("Deploy-token mode only: the one project this server may touch."),
  config_path: z.string().nullable().describe("The CLI session file in use (session mode)."),
  note: z.string().nullable().describe("What to tell the user, when something needs their action."),
});
export type WhoamiResult = z.infer<typeof WhoamiOutput>;

interface AuthUser {
  id?: string;
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
}

interface SubscriptionRow {
  status: string | null;
  plan_tier: string | null;
  provider: string | null;
  product_name: string | null;
  current_period_end: string | null;
}

const AUTH_FAILURES = new Set(["NOT_LOGGED_IN", "SESSION_EXPIRED", "SESSION_UNREADABLE", "DEPLOY_TOKEN_INVALID", "AUTH_EXPIRED"]);

export async function runWhoami(ctx: ToolContext): Promise<WhoamiResult> {
  assertDeployTokenAllows(ctx.auth, "whoami", undefined, ctx.hints.deployTokenElsewhere);
  const configPath = ctx.auth.sessionPath ?? null;
  const base: WhoamiResult = {
    logged_in: false,
    auth_mode: ctx.auth.mode,
    user_id: null,
    email: null,
    name: null,
    plan_tier: null,
    paid_plan: null,
    subscription: null,
    pinned_project_uuid: ctx.auth.pinnedProjectUuid ?? null,
    config_path: configPath,
    note: null,
  };

  let token: string;
  try {
    token = await ctx.auth.getAccessToken();
  } catch (err) {
    if (isMicropageError(err) && AUTH_FAILURES.has(err.code)) {
      return { ...base, note: err.message };
    }
    throw err;
  }

  const claims = decodeJwtClaims(token);
  let user: AuthUser;
  if (ctx.auth.mode === "deploy_token") {
    // The minted deploy JWT has no auth session behind it, so read identity from its claims.
    user = { ...(claims?.sub ? { id: claims.sub } : {}), email: claims?.email ?? null };
  } else {
    try {
      user = await ctx.http.request<AuthUser>("GET", `${ctx.config.supabaseUrl}/auth/v1/user`);
    } catch (err) {
      if (isMicropageError(err) && AUTH_FAILURES.has(err.code)) {
        const note = err.code === "AUTH_EXPIRED" ? err.message : ctx.hints.loginInvalid;
        return { ...base, note };
      }
      throw err;
    }
  }
  const userId = user.id ?? claims?.sub ?? null;

  let tier: PlanTier | null = null;
  try {
    tier = await ctx.tier.getPlanTier();
  } catch {
    // Reported as null; the gate in other tools will surface the real error.
  }

  let subscription: SubscriptionRow | null = null;
  if (userId) {
    subscription = await ctx.http
      .selectOne<SubscriptionRow>("subscriptions", {
        select: "status,plan_tier,provider,product_name,current_period_end",
        filters: { user_id: eq(userId), status: inList(["active", "trialing", "paused"]) },
        order: "updated_at.desc",
      })
      .catch(() => null);
  }

  const meta = user.user_metadata ?? {};
  const name = [meta.full_name, meta.user_name, meta.name].find((v): v is string => typeof v === "string" && v !== "");
  const paid = tier === null ? null : isPaidTier(tier);

  return {
    ...base,
    logged_in: true,
    user_id: userId,
    email: user.email ?? null,
    name: name ?? null,
    plan_tier: tier,
    paid_plan: ctx.auth.mode === "deploy_token" ? true : paid,
    subscription,
    note: paid === false && ctx.auth.mode !== "deploy_token" ? ctx.hints.planRequiredNote : null,
  };
}

export function registerAccountTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "whoami",
    {
      title: "Show the micropage account in use",
      description: `Report which micropage account this server acts as: email, plan tier, subscription, and ${ctx.hints.whoamiModes}.

Call it first when a micropage tool fails with a login, session or plan error, or when the user asks which account is connected. It never fails for a missing login: it returns logged_in false and a note saying what the user must do (${ctx.hints.whoamiFix}). It does not log in, log out, or change anything.

Do not call it before every task; the other tools report login and plan problems themselves.`,
      inputSchema: WhoamiInput,
      outputSchema: WhoamiOutput,
      annotations: RO,
    },
    async () => {
      const result = await runWhoami(ctx);
      const summary = result.logged_in
        ? `Signed in as ${result.email ?? result.user_id ?? "(unknown)"} (${result.plan_tier ?? "plan unknown"}, ${result.auth_mode}).`
        : `Not signed in. ${result.note ?? ""}`.trim();
      return structuredResult(result, summary);
    },
  );
}
