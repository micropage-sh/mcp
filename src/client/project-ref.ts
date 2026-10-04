import * as z from "zod";

import type { AuthProvider } from "./auth-provider.js";
import { projectUrl, type MicropageConfig } from "./config.js";
import { MicropageError } from "./errors.js";
import { eq, type Filters, type Http } from "./http.js";

const PROJECT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isProjectUuid(s: string): boolean {
  return PROJECT_UUID_RE.test(s.trim());
}

export function isNumericProjectId(s: string): boolean {
  return /^\d+$/.test(s.trim());
}

/** The `project` input every project-scoped tool takes. */
export const ProjectRef = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .describe(
    'Which project: its uuid, its numeric id, its micropage hostname ("acme" or "acme.micropage.sh") or its ' +
      "custom domain (\"www.acme.com\"). A full URL also works. Get valid values from list_projects.",
  );

/** Columns read for every resolved project. */
export const PROJECT_COLUMNS = "id,uuid,name,domain,custom_domain,active_build_id,status,created_at";

export interface ProjectRow {
  id: number;
  uuid: string;
  name: string | null;
  domain: string | null;
  custom_domain: string | null;
  active_build_id: number | null;
  status: string | null;
  created_at: string | null;
}

export interface Project extends ProjectRow {
  /** Public URL: the custom domain when set, else https://<domain>.<baseDomain>. */
  live_url: string | null;
  /** The project in the web editor. */
  editor_url: string;
}

/** What resolveProject needs; ToolContext satisfies it. */
export interface ProjectRefDeps {
  http: Http;
  auth: Pick<AuthProvider, "mode" | "pinnedProjectUuid">;
  config: Pick<MicropageConfig, "baseDomain" | "appUrl">;
}

export function toProject(row: ProjectRow, config: ProjectRefDeps["config"]): Project {
  return {
    ...row,
    live_url: projectUrl(config, row.domain, row.custom_domain),
    editor_url: `${config.appUrl.replace(/\/+$/, "")}/editor/${row.id}`,
  };
}

export type ParsedProjectRef =
  | { kind: "uuid"; value: string }
  | { kind: "id"; value: number }
  /** `{slug}.<baseDomain>` or a bare slug: matches projects.domain. */
  | { kind: "slug"; value: string }
  /** Any other hostname: a custom domain (or, as the CLI allows, a domain stored verbatim). */
  | { kind: "host"; value: string };

/**
 * Classifies a user-supplied ref the way cli/src/project-ref.js does, plus
 * URL/hostname handling. Throws PROJECT_NOT_FOUND for something that cannot
 * be any of them.
 */
export function parseProjectRef(ref: string, baseDomain: string): ParsedProjectRef {
  const raw = ref.trim();
  if (isProjectUuid(raw)) return { kind: "uuid", value: raw.toLowerCase() };
  if (isNumericProjectId(raw)) return { kind: "id", value: Number(raw) };

  const host = raw
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "")
    .replace(/\.$/, "")
    .toLowerCase();
  // Also keeps the value safe to splice into the PostgREST `or=(...)` filter below.
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host)) {
    throw new MicropageError(
      "PROJECT_NOT_FOUND",
      `"${ref}" is not a project uuid, numeric id or hostname. Call list_projects to see valid projects.`,
    );
  }

  const base = baseDomain.toLowerCase();
  if (host.endsWith(`.${base}`)) {
    const slug = host.slice(0, -(base.length + 1));
    if (slug && !slug.includes(".")) return { kind: "slug", value: slug };
  }
  if (!host.includes(".")) return { kind: "slug", value: host };
  return { kind: "host", value: host };
}

function filtersFor(parsed: ParsedProjectRef): Filters {
  switch (parsed.kind) {
    case "uuid":
      return { uuid: eq(parsed.value) };
    case "id":
      return { id: eq(parsed.value) };
    case "slug":
      return { domain: eq(parsed.value) };
    case "host":
      return { or: `(custom_domain.eq.${parsed.value},domain.eq.${parsed.value})` };
  }
}

/**
 * The pin a deploy token carries. The minted JWT can reach every project the
 * owner has, so this check is what keeps a deploy-token session on one project.
 */
export function assertPinnedProject(auth: ProjectRefDeps["auth"], projectUuid: string): void {
  if (auth.mode !== "deploy_token") return;
  if (projectUuid.toLowerCase() === auth.pinnedProjectUuid?.toLowerCase()) return;
  throw new MicropageError(
    "NOT_ALLOWED_IN_DEPLOY_TOKEN_MODE",
    `This deploy token is pinned to project ${auth.pinnedProjectUuid ?? "(unset)"}; ` +
      `it cannot act on ${projectUuid}. Omit the project or pass the pinned one.`,
  );
}

/**
 * Loads one of the user's projects from a uuid, numeric id, micropage
 * hostname or custom domain. In deploy-token mode an omitted ref means the
 * pinned project and any other project is refused. Throws PROJECT_NOT_FOUND
 * (RLS hides other users' projects, so "not yours" reads the same).
 */
export async function resolveProject(deps: ProjectRefDeps, ref: string | undefined): Promise<Project> {
  const pinned = deps.auth.mode === "deploy_token" ? deps.auth.pinnedProjectUuid : undefined;
  const given = ref?.trim() ?? "";
  if (!given) {
    if (!pinned) {
      throw new MicropageError(
        "PROJECT_REQUIRED",
        "Pass `project` (a uuid, numeric id or domain). Call list_projects to see the user's projects.",
      );
    }
  }

  const parsed: ParsedProjectRef = given
    ? parseProjectRef(given, deps.config.baseDomain)
    : { kind: "uuid", value: pinned! };
  // Refuse a foreign uuid before any network call.
  if (parsed.kind === "uuid") assertPinnedProject(deps.auth, parsed.value);

  const rows = await deps.http.select<ProjectRow>("projects", {
    select: PROJECT_COLUMNS,
    filters: filtersFor(parsed),
    order: "id.asc",
    limit: 2,
  });
  // A host can match one project's custom_domain and another's domain; the custom domain wins.
  const row =
    parsed.kind === "host" ? (rows.find((r) => r.custom_domain?.toLowerCase() === parsed.value) ?? rows[0]) : rows[0];
  if (!row) {
    throw new MicropageError(
      "PROJECT_NOT_FOUND",
      `No project matching "${given || pinned}" in this micropage account. Call list_projects to see valid projects.`,
    );
  }
  assertPinnedProject(deps.auth, row.uuid);
  return toProject(row, deps.config);
}
