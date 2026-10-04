import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";

import { RO } from "../annotations.js";
import { eq, inList } from "../client/http.js";
import {
  PROJECT_COLUMNS,
  ProjectRef,
  resolveProject,
  toProject,
  type Project,
  type ProjectRow,
} from "../client/project-ref.js";
import type { ToolContext } from "../context.js";
import { BUILD_SUMMARY_COLUMNS, BuildSummary, ProjectSummary, gateTool, structuredResult } from "./shared.js";

// ---------------------------------------------------------------------------
// list_projects
// ---------------------------------------------------------------------------

export const ListProjectsInput = z.object({}).strict();

export const ListProjectsOutput = z.object({
  projects: z.array(
    ProjectSummary.extend({
      active_build: BuildSummary.nullable().describe(
        "The build the editor and CLI work on (default publish target). May be a draft newer than what is live.",
      ),
    }),
  ),
  count: z.number(),
});
export type ListProjectsResult = z.infer<typeof ListProjectsOutput>;

function summarize(project: Project): z.infer<typeof ProjectSummary> {
  return {
    id: project.id,
    uuid: project.uuid,
    name: project.name,
    domain: project.domain,
    custom_domain: project.custom_domain,
    status: project.status,
    active_build_id: project.active_build_id,
    created_at: project.created_at,
    live_url: project.live_url,
    editor_url: project.editor_url,
  };
}

function toBuildSummary(row: BuildSummary): BuildSummary {
  return {
    id: row.id,
    number: row.number ?? null,
    status: row.status ?? null,
    updated_at: row.updated_at ?? null,
    failure_reason: row.failure_reason ?? null,
  };
}

export async function runListProjects(ctx: ToolContext): Promise<ListProjectsResult> {
  await gateTool(ctx, "list_projects");
  const rows = await ctx.http.select<ProjectRow>("projects", { select: PROJECT_COLUMNS, order: "id.desc" });
  const activeIds = rows.map((r) => r.active_build_id).filter((id): id is number => typeof id === "number");
  const builds =
    activeIds.length > 0
      ? await ctx.http.select<BuildSummary>("builds", {
          select: BUILD_SUMMARY_COLUMNS,
          filters: { id: inList(activeIds) },
        })
      : [];
  const byId = new Map(builds.map((b) => [b.id, toBuildSummary(b)]));

  const projects = rows.map((row) => ({
    ...summarize(toProject(row, ctx.config)),
    active_build: row.active_build_id === null ? null : (byId.get(row.active_build_id) ?? null),
  }));
  return { projects, count: projects.length };
}

// ---------------------------------------------------------------------------
// get_project
// ---------------------------------------------------------------------------

export const GetProjectInput = z.object({ project: ProjectRef }).strict();

const CustomDomainStatus = z.object({
  hostname: z.string(),
  attached: z.boolean().describe("True once the custom domain is wired to the site."),
  status: z.string().nullable().describe("Cloudflare custom hostname status: pending, active, blocked, failed, ..."),
  ssl_status: z
    .string()
    .nullable()
    .describe("Certificate state: initializing, pending_validation, pending_issuance, pending_deployment, active, ..."),
  verification_errors: z.unknown().nullable(),
  last_checked_at: z.string().nullable(),
  cname_target: z.string().describe("What the hostname must CNAME to."),
});

export const GetProjectOutput = z.object({
  project: ProjectSummary,
  active_build: BuildSummary.nullable().describe("The build the editor and CLI work on; publish_build's default."),
  latest_build: BuildSummary.nullable().describe("The highest-numbered build."),
  last_deployed_build: BuildSummary.nullable().describe("What is live right now, if anything was ever deployed."),
  failure_reason: z.string().nullable().describe("Why the active or latest build failed, when it did."),
  custom_domain: CustomDomainStatus.nullable(),
});
export type GetProjectResult = z.infer<typeof GetProjectOutput>;

interface CustomHostnameRow {
  domain_active: boolean | null;
  custom_hostname_status: string | null;
  custom_hostname_ssl_status: string | null;
  custom_hostname_verification_errors: unknown;
  custom_hostname_last_checked_at: string | null;
}

export async function runGetProject(ctx: ToolContext, args: z.infer<typeof GetProjectInput>): Promise<GetProjectResult> {
  await gateTool(ctx, "get_project");
  const project = await resolveProject(ctx, args.project);
  const byProject = { project_id: eq(project.id) };

  const [latest, deployed, active, ch] = await Promise.all([
    ctx.http.selectOne<BuildSummary>("builds", {
      select: BUILD_SUMMARY_COLUMNS,
      filters: byProject,
      order: "number.desc",
    }),
    ctx.http.selectOne<BuildSummary>("builds", {
      select: BUILD_SUMMARY_COLUMNS,
      filters: { ...byProject, status: eq("deployed") },
      order: "number.desc",
    }),
    project.active_build_id === null
      ? Promise.resolve(null)
      : ctx.http.selectOne<BuildSummary>("builds", {
          select: BUILD_SUMMARY_COLUMNS,
          filters: { id: eq(project.active_build_id) },
        }),
    project.custom_domain
      ? ctx.http.selectOne<CustomHostnameRow>("projects", {
          select:
            "domain_active,custom_hostname_status,custom_hostname_ssl_status,custom_hostname_verification_errors,custom_hostname_last_checked_at",
          filters: { id: eq(project.id) },
        })
      : Promise.resolve(null),
  ]);

  const activeBuild = active ? toBuildSummary(active) : null;
  const latestBuild = latest ? toBuildSummary(latest) : null;
  const failed = [activeBuild, latestBuild].find((b) => b?.status === "failed");

  return {
    project: summarize(project),
    active_build: activeBuild,
    latest_build: latestBuild,
    last_deployed_build: deployed ? toBuildSummary(deployed) : null,
    failure_reason: failed?.failure_reason ?? null,
    custom_domain: project.custom_domain
      ? {
          hostname: project.custom_domain,
          attached: ch?.domain_active ?? false,
          status: ch?.custom_hostname_status ?? null,
          ssl_status: ch?.custom_hostname_ssl_status ?? null,
          verification_errors: ch?.custom_hostname_verification_errors ?? null,
          last_checked_at: ch?.custom_hostname_last_checked_at ?? null,
          cname_target: `cname.${ctx.config.baseDomain}`,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------

export function registerProjectTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "list_projects",
    {
      title: "List micropage projects",
      description: `List every micropage project in the signed-in account: uuid, numeric id, name, micropage domain, custom domain, live URL, editor URL, and the status and number of each project's active build.

Use it to find the \`project\` value other tools need (uuid, id or domain all work), or when the user refers to a site by name and you do not know which project it is. The active build is the one the editor and CLI work on; it can be a draft newer than what is live, so call get_project for what is actually deployed, failure reasons and custom-domain status.

Read-only. Not available with a deploy token, which is limited to its one project.`,
      inputSchema: ListProjectsInput,
      outputSchema: ListProjectsOutput,
      annotations: RO,
    },
    async () => {
      const result = await runListProjects(ctx);
      return structuredResult(result, `${result.count} project(s).`);
    },
  );

  server.registerTool(
    "get_project",
    {
      title: "Show one micropage project",
      description: `Show one micropage project in detail: live URL, editor URL, the active build (the default publish target), the latest build, the build that is live now, the failure reason if a build failed, and read-only custom-domain status (Cloudflare hostname and certificate state, and the CNAME target).

Use it to check what is live versus drafted before publishing, to explain why a build failed, or to answer "is my custom domain working?". Accepts the project's uuid, numeric id, micropage domain ("acme" or "acme.micropage.sh") or custom domain.

It does not return the page source (use get_page_source) or follow a deploy in progress (use get_deploy_status), and it cannot change the custom domain; that is done in the micropage editor.`,
      inputSchema: GetProjectInput,
      outputSchema: GetProjectOutput,
      annotations: RO,
    },
    async (args) => {
      const result = await runGetProject(ctx, args);
      const p = result.project;
      return structuredResult(result, `${p.name ?? p.uuid}: ${p.live_url ?? "no live URL yet"}.`);
    },
  );
}
