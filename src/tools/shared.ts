import type { CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod";

import type { DiagnosticSeverity } from "../client/pages.js";
import type { ToolContext } from "../context.js";
import { assertDeployTokenAllows } from "../guards.js";

/**
 * Every tool handler except whoami calls this first, before any other
 * network call: the deploy-token tool allowlist, then the paid-plan gate
 * (cached 5 min; skipped in deploy-token mode, since only Pro+ can mint one).
 */
export async function gateTool(ctx: Pick<ToolContext, "auth" | "tier" | "hints">, tool: string): Promise<void> {
  assertDeployTokenAllows(ctx.auth, tool, undefined, ctx.hints.deployTokenElsewhere);
  await ctx.tier.requirePaidPlan();
}

/** A result carrying structuredContent plus the same data as text for hosts that only read content. */
export function structuredResult<T extends Record<string, unknown>>(data: T, summary?: string): CallToolResult {
  const json = JSON.stringify(data, null, 2);
  return {
    structuredContent: data,
    content: [{ type: "text", text: summary ? `${summary}\n\n${json}` : json }],
  };
}

/** Build summary shared by project and build tools. */
export const BuildSummary = z.object({
  id: z.number(),
  number: z.number().nullable(),
  status: z.string().nullable().describe("draft, in_progress, publishing, deployed or failed."),
  updated_at: z.string().nullable(),
  failure_reason: z.string().nullable(),
});
export type BuildSummary = z.infer<typeof BuildSummary>;

export const BUILD_SUMMARY_COLUMNS = "id,number,status,updated_at,failure_reason";

export const ProjectSummary = z.object({
  id: z.number().describe("Numeric project id."),
  uuid: z.string(),
  name: z.string().nullable(),
  domain: z.string().nullable().describe("micropage slug: the site lives at https://<domain>.micropage.live."),
  custom_domain: z.string().nullable(),
  status: z.string().nullable(),
  active_build_id: z.number().nullable(),
  created_at: z.string().nullable(),
  live_url: z.string().nullable(),
  editor_url: z.string(),
});

type SeverityAndCode = { severity: DiagnosticSeverity; code: string };

/** Per-severity counts, leaving out the compiler's "more not shown" summary entry. */
export function countDiagnostics(diagnostics: readonly SeverityAndCode[] | null): Record<DiagnosticSeverity, number> {
  const counts = { error: 0, warning: 0, hint: 0 };
  for (const d of diagnostics ?? []) if (d.code !== "too-many-diagnostics") counts[d.severity]++;
  return counts;
}

/** " Diagnostics: 2 error(s), 1 hint(s)." for the text summary; "" when there are none or none were reported. */
export function diagnosticsSummary(diagnostics: readonly SeverityAndCode[] | null): string {
  const c = countDiagnostics(diagnostics);
  const parts = (["error", "warning", "hint"] as const).filter((k) => c[k] > 0).map((k) => `${c[k]} ${k}(s)`);
  if (parts.length === 0) return "";
  const more = diagnostics?.some((d) => d.code === "too-many-diagnostics") ? ", more not shown" : "";
  return ` Diagnostics: ${parts.join(", ")}${more}.`;
}
