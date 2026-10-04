import type { CallToolResult, InputRequiredResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import * as z from "zod";

import { DESTRUCTIVE, OUT, RO, WRITE } from "../annotations.js";
import { BuildRefInput, findBuild, getBuildById, parseBuildRef, saveDraft, type SaveDraftResult } from "../client/builds.js";
import { MicropageError } from "../client/errors.js";
import { eq, inList } from "../client/http.js";
import { concatPages } from "../client/pages.js";
import {
  PROJECT_COLUMNS,
  ProjectRef,
  resolveProject,
  toProject,
  type Project,
  type ProjectRow,
} from "../client/project-ref.js";
import { EXAMPLES } from "../content/index.js";
import type { ToolContext } from "../context.js";
import { elicitConfirmation, requireConfirmMatch } from "../guards.js";
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
// get_page_source
// ---------------------------------------------------------------------------

export const GetPageSourceInput = z
  .object({
    project: ProjectRef,
    version: BuildRefInput.optional().describe(
      "Which build's source to read: a build number (\"v12\" or 12) or id (\"id:4567\"). Defaults to the active " +
        "build (the draft or published build the editor and CLI work on), else the latest build.",
    ),
  })
  .strict();

export const GetPageSourceOutput = z.object({
  project: ProjectSummary,
  build: z
    .object({
      id: z.number(),
      number: z.number().nullable(),
      status: z.string().nullable(),
      updated_at: z.string().nullable(),
      is_active: z.boolean().describe("True when this is the project's active build."),
    })
    .nullable()
    .describe("Null when the project has no builds yet."),
  source: z
    .string()
    .nullable()
    .describe("The raw .page markup. Several files were merged into one when saved; edit it as landing.page."),
  llms_txt: z.string().nullable().describe("The site's /llms.txt as stored on this build, if any."),
  assets: z
    .array(z.string())
    .nullable()
    .describe("Filenames uploaded to the project, usable as `img: <- filename`. Null if the list could not be read."),
});
export type GetPageSourceResult = z.infer<typeof GetPageSourceOutput>;

interface SourceBuildRow {
  id: number;
  number: number | null;
  status: string | null;
  updated_at: string | null;
  raw_content: string | null;
  llms_txt: string | null;
}

const SOURCE_COLUMNS = "id,number,status,updated_at,raw_content,llms_txt:json_content->site->>llms_txt";

async function listAssetNames(ctx: ToolContext, projectId: number): Promise<string[] | null> {
  try {
    const data = await ctx.http.invokeGet<{ files?: Array<{ filename?: unknown }> } | null>("list-files", {
      project_id: String(projectId),
    });
    const names = (data?.files ?? []).map((f) => f.filename).filter((n): n is string => typeof n === "string" && n !== "");
    return [...new Set(names)].sort();
  } catch {
    // The file list is a convenience here; list_files reports its own errors.
    return null;
  }
}

export async function runGetPageSource(
  ctx: ToolContext,
  args: z.infer<typeof GetPageSourceInput>,
): Promise<GetPageSourceResult> {
  await gateTool(ctx, "get_page_source");
  const project = await resolveProject(ctx, args.project);

  let build: SourceBuildRow | null;
  if (args.version !== undefined) {
    build = await findBuild<SourceBuildRow>(ctx.http, project.id, parseBuildRef(args.version), SOURCE_COLUMNS);
  } else {
    build =
      project.active_build_id === null
        ? null
        : await getBuildById<SourceBuildRow>(ctx.http, project.id, project.active_build_id, SOURCE_COLUMNS);
    build ??= await ctx.http.selectOne<SourceBuildRow>("builds", {
      select: SOURCE_COLUMNS,
      filters: { project_id: eq(project.id) },
      order: "number.desc",
    });
  }

  const assets = await listAssetNames(ctx, project.id);
  return {
    project: summarize(project),
    build: build
      ? {
          id: build.id,
          number: build.number ?? null,
          status: build.status ?? null,
          updated_at: build.updated_at ?? null,
          is_active: build.id === project.active_build_id,
        }
      : null,
    source: build?.raw_content ?? null,
    llms_txt: build?.llms_txt ?? null,
    assets,
  };
}

// ---------------------------------------------------------------------------
// create_project
// ---------------------------------------------------------------------------

/** Full-page example handed out as the starter (components-* files are fragments). */
export const STARTER_EXAMPLE = "startup-landing";

const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/;

export const CreateProjectInput = z
  .object({
    name: z.string().trim().min(1).max(100).describe("Project name shown in the editor, e.g. \"Acme waitlist\"."),
    domain: z
      .string()
      .trim()
      .toLowerCase()
      .max(80)
      .optional()
      .describe(
        "Optional micropage subdomain: \"acme\" serves at https://acme.micropage.sh. Lowercase letters, digits and " +
          "hyphens, up to 58 characters. Omit it to get one derived from the name plus a short random suffix.",
      ),
  })
  .strict();

export const CreateProjectOutput = z.object({
  project: ProjectSummary,
  starter: z.object({
    example: z.string().describe("Which bundled example the starter source is."),
    source: z.string().describe("A complete .page file to adapt and pass to save_page as landing.page."),
    referenced_files: z
      .array(z.string())
      .describe("Files the starter references with `<-`; upload them with upload_asset or remove those lines."),
    other_examples: z.array(z.string()).describe("More examples, readable with get_markup_reference."),
  }),
  next_steps: z.string(),
});
export type CreateProjectResult = z.infer<typeof CreateProjectOutput>;

export function normalizeDomain(input: string, baseDomain: string): string {
  let d = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const suffix = `.${baseDomain.toLowerCase()}`;
  if (d.endsWith(suffix)) d = d.slice(0, -suffix.length);
  if (!DOMAIN_RE.test(d)) {
    throw new MicropageError(
      "INVALID_DOMAIN",
      `"${input}" is not a valid micropage subdomain. Use 1-58 lowercase letters, digits and hyphens, not starting or ` +
        `ending with a hyphen (e.g. "acme-launch"), or omit domain to get one from the name. Nothing was created.`,
    );
  }
  return d;
}

function referencedFiles(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(/<-\s*([^\s<>]+\.[A-Za-z0-9]{1,8})\s*$/gm)) {
    if (!/^https?:/i.test(m[1]!)) out.add(m[1]!);
  }
  return [...out].sort();
}

export async function runCreateProject(
  ctx: ToolContext,
  args: z.infer<typeof CreateProjectInput>,
): Promise<CreateProjectResult> {
  const domain = args.domain ? normalizeDomain(args.domain, ctx.config.baseDomain) : undefined;
  await gateTool(ctx, "create_project");

  let rows: ProjectRow[];
  try {
    rows = await ctx.http.insert<ProjectRow>("projects", { name: args.name, ...(domain ? { domain } : {}) });
  } catch (err) {
    if (err instanceof MicropageError && err.status === 409) {
      throw new MicropageError(
        "DOMAIN_TAKEN",
        `The subdomain "${domain ?? "(generated)"}" is already taken. Pick another domain, or omit it. Nothing was created.`,
        { status: 409, data: err.data, cause: err },
      );
    }
    if (err instanceof MicropageError && err.code === "PLAN_REQUIRED") throw err;
    if (err instanceof MicropageError && (err.status === 403 || err.status === 401)) {
      throw new MicropageError(
        "PROJECT_LIMIT",
        "micropage refused to create another project, most likely because the account is at its plan's project " +
          "limit (Pro: 5, Pro+: 20). Tell the user to delete an unused project or upgrade. Nothing was created.",
        { ...(err.status === undefined ? {} : { status: err.status }), data: err.data, cause: err },
      );
    }
    throw err;
  }
  const row = rows[0];
  if (!row) throw new MicropageError("CREATE_FAILED", "Creating the project returned no row. Call list_projects to check, then retry.");

  const project = toProject(
    {
      id: row.id,
      uuid: row.uuid,
      name: row.name ?? args.name,
      domain: row.domain ?? null,
      custom_domain: row.custom_domain ?? null,
      active_build_id: row.active_build_id ?? null,
      status: row.status ?? null,
      created_at: row.created_at ?? null,
    },
    ctx.config,
  );
  const source = EXAMPLES[STARTER_EXAMPLE] ?? Object.values(EXAMPLES)[0] ?? "";
  return {
    project: summarize(project),
    starter: {
      example: STARTER_EXAMPLE,
      source,
      referenced_files: referencedFiles(source),
      other_examples: Object.keys(EXAMPLES).filter((n) => n !== STARTER_EXAMPLE && !n.startsWith("components-")),
    },
    next_steps:
      "The project is empty and nothing is live yet. Rewrite the starter for the user's brief, call save_page with " +
      "pages: [{ name: \"landing.page\", content }], show the user the editor_url to preview, and call publish_build " +
      "only when the user asks to go live.",
  };
}

// ---------------------------------------------------------------------------
// save_page
// ---------------------------------------------------------------------------

export const MAX_PAGE_FILES = 50;

export const SavePageInput = z
  .object({
    project: ProjectRef,
    pages: z
      .array(
        z
          .object({
            name: z
              .string()
              .trim()
              .min(1)
              .max(100)
              .describe("File name ending in .page. landing.page is merged first; the rest follow sorted by name."),
            content: z.string().describe("The complete .page markup of this file (not a diff)."),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_PAGE_FILES)
      .describe(
        "The whole site source as one or more .page files, merged like the CLI does (landing.page first, then the " +
          "others by name, a blank line between). Pass every file each time: this replaces the source, it does not patch it.",
      ),
    llms_txt: z
      .string()
      .optional()
      .describe(
        "The site's /llms.txt, stored verbatim. Omit to keep the current build's llms.txt; pass an empty string to remove it.",
      ),
  })
  .strict();

export const SavePageOutput = z.object({
  project: ProjectSummary,
  build: z.object({
    id: z.number().describe("Build id; pass it to publish_build as build \"id:<id>\" to publish exactly this draft."),
    number: z.number().nullable(),
    status: z.string().nullable(),
  }),
  action: z
    .enum(["updated_draft", "created_draft"])
    .describe("updated_draft: the active draft (or failed build) was overwritten. created_draft: a new draft was made active."),
  previous_active_build_id: z.number().nullable(),
  issues: z
    .array(z.string())
    .describe("Problems the compiler flagged, e.g. a referenced file that does not exist. Fix them before publishing."),
  page_count: z.number(),
  llms_txt: z.enum(["kept", "set", "removed", "none"]),
  live: z.literal(false).describe("Always false: save_page never changes the live site; the draft goes live only with publish_build."),
  preview_url: z.string().describe("Where the user can preview this draft: the project in the micropage editor."),
  live_url: z.string().nullable().describe("The public URL; it still shows the last published build."),
  next: z.string(),
});
export type SavePageResult = z.infer<typeof SavePageOutput>;

export async function runSavePage(ctx: ToolContext, args: z.infer<typeof SavePageInput>): Promise<SavePageResult> {
  const text = concatPages(args.pages);
  await gateTool(ctx, "save_page");
  const project = await resolveProject(ctx, args.project);

  const saved: SaveDraftResult = await saveDraft(ctx.http, ctx.config, {
    projectId: project.id,
    activeBuildId: project.active_build_id,
    text,
    llmsTxt: args.llms_txt,
  });

  return {
    project: summarize({ ...project, active_build_id: saved.build.id }),
    build: saved.build,
    action: saved.action,
    previous_active_build_id: saved.previous_active_build_id,
    issues: saved.issues,
    page_count: saved.page_count,
    llms_txt: saved.llms_txt,
    live: false,
    preview_url: project.editor_url,
    live_url: project.live_url,
    next:
      "Saved as a draft: it never goes live until publish_build. Show the user the preview_url" +
      (saved.issues.length > 0 ? " and fix the issues listed" : "") +
      `, and call publish_build (build "id:${saved.build.id}", confirm: true) only when the user asks to publish.`,
  };
}

// ---------------------------------------------------------------------------
// delete_project (registered only with MICROPAGE_MCP_ALLOW_DELETE=1)
// ---------------------------------------------------------------------------

export const DeleteProjectInput = z
  .object({
    project: ProjectRef,
    confirm_domain: z
      .string()
      .trim()
      .max(300)
      .optional()
      .describe(
        "The project's micropage domain, typed back to confirm (e.g. \"acme-3f9a1c\" or \"acme-3f9a1c.micropage.sh\"). " +
          "Ask the user to confirm the deletion first; get_project shows the domain.",
      ),
  })
  .strict();

export const DeleteProjectOutput = z.object({
  deleted: z.boolean(),
  already_removed: z.boolean().describe("True when the server reported the project as already gone (HTTP 404)."),
  project_id: z.number(),
  uuid: z.string(),
  domain: z.string().nullable(),
  note: z.string(),
});
export type DeleteProjectResult = z.infer<typeof DeleteProjectOutput>;

export const DELETE_ELICIT_KEY = "confirm_delete_project";

export async function runDeleteProject(
  ctx: ToolContext,
  args: z.infer<typeof DeleteProjectInput>,
  handlerCtx: ServerContext,
): Promise<DeleteProjectResult | InputRequiredResult> {
  await gateTool(ctx, "delete_project");
  const project = await resolveProject(ctx, args.project);
  const expected = project.domain ?? project.uuid;
  const suffix = `.${ctx.config.baseDomain.toLowerCase()}`;
  const given = args.confirm_domain?.toLowerCase().endsWith(suffix)
    ? args.confirm_domain.slice(0, -suffix.length)
    : args.confirm_domain;
  requireConfirmMatch(given, expected, "confirm_domain", `Deleting project "${project.name ?? expected}"`);

  const outcome = elicitConfirmation(handlerCtx, ctx.clientCapabilities(handlerCtx), {
    key: DELETE_ELICIT_KEY,
    message:
      `Permanently delete the micropage project "${project.name ?? expected}" (${project.live_url ?? expected})? ` +
      "Its site goes offline and the project and its builds are removed. This cannot be undone.",
  });
  if (outcome.status === "pending") return outcome.result;
  if (outcome.status === "declined") {
    throw new MicropageError("DECLINED", "The user declined the deletion in the confirmation prompt. Nothing was deleted.");
  }

  // delete-project answers 403 both for "not yours" and for a project that is
  // gone, so only a 404 is read as already removed. The project was resolved
  // above, so a 403 here is a real refusal or a race, and is reported as such.
  let alreadyRemoved = false;
  try {
    await ctx.http.invoke("delete-project", { projectId: project.id });
  } catch (err) {
    if (err instanceof MicropageError && err.status === 404) alreadyRemoved = true;
    else if (err instanceof MicropageError && err.code === "PLAN_REQUIRED") throw err;
    else if (err instanceof MicropageError && err.status === 403) {
      throw new MicropageError(
        "DELETE_REFUSED",
        `micropage refused to delete "${project.name ?? expected}" (HTTP 403: project not found or access denied). It may have ` +
          "been deleted meanwhile; call get_project to check. Nothing else was changed.",
        { status: 403, data: err.data, cause: err },
      );
    } else throw err;
  }
  return {
    deleted: true,
    already_removed: alreadyRemoved,
    project_id: project.id,
    uuid: project.uuid,
    domain: project.domain,
    note: alreadyRemoved
      ? "The project was already removed on the server."
      : "Deletion started. The site, its Cloudflare Pages project and DNS are cleaned up in the background over the next minutes.",
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

  server.registerTool(
    "get_page_source",
    {
      title: "Read a project's .page source",
      description: `Return the raw .page markup of a micropage project's active build (or of a given build number), plus its stored llms.txt and the filenames uploaded to the project.

Call it before editing an existing site: change the returned source and send the whole file back with save_page as landing.page. Pass \`version\` to read an older build, e.g. to restore it. The source was merged from all .page files when saved, so it comes back as one file.

Read-only; it does not show what is live (get_project tells you which build is deployed) and does not download images.`,
      inputSchema: GetPageSourceInput,
      outputSchema: GetPageSourceOutput,
      annotations: RO,
    },
    async (args) => {
      const result = await runGetPageSource(ctx, args);
      const b = result.build;
      return structuredResult(
        result,
        b ? `Source of build v${b.number ?? "?"} (${b.status ?? "unknown"}${b.is_active ? ", active" : ""}).` : "This project has no builds yet.",
      );
    },
  );

  server.registerTool(
    "create_project",
    {
      title: "Create a micropage project",
      description: `Create a new, empty micropage project in the signed-in account and return it together with a complete starter .page file (one of the bundled examples) to adapt.

Use it when the user wants a new site. Each call creates another project and counts against the plan's project limit (Pro: 5, Pro+: 20), so check list_projects first when the user may mean an existing site. Nothing is published: write the page, call save_page, and publish only on request.

It does not write local files (it is not \`micropage projects create\`) and cannot set a custom domain; that is done in the editor.`,
      inputSchema: CreateProjectInput,
      outputSchema: CreateProjectOutput,
      annotations: WRITE,
    },
    async (args) => {
      const result = await runCreateProject(ctx, args);
      return structuredResult(result, `Created ${result.project.name ?? result.project.uuid} (${result.project.domain ?? "no domain"}). Not live yet.`);
    },
  );

  server.registerTool(
    "save_page",
    {
      title: "Save .page source as a draft",
      description: `Compile .page markup and save it as the project's draft build. It never goes live until publish_build deploys it: call publish_build only when the user asks. Post changes rebuild the live site, not this draft.

Pass the whole site source each time (pages: [{ name: "landing.page", content }], extra .page files are merged after it by name). If the project's active build is a draft or a failed build it is overwritten; otherwise a new draft is created and made active. Returns the build id and number, compiler issues (such as a missing image file) and the editor URL where the user can preview the draft; drafts have no public URL.

Images are not uploaded here: call upload_asset first, then reference the file with \`img: <- filename\`. Call get_markup_reference before writing markup you are unsure of. Saving also registers the source's forms on the project.`,
      inputSchema: SavePageInput,
      outputSchema: SavePageOutput,
      // Overwrites the active draft (or failed build) in place.
      annotations: DESTRUCTIVE,
    },
    async (args) => {
      const result = await runSavePage(ctx, args);
      const verb = result.action === "updated_draft" ? "Updated" : "Created";
      return structuredResult(
        result,
        `${verb} draft v${result.build.number ?? "?"} (id ${result.build.id}); not live.` +
          (result.issues.length > 0 ? ` ${result.issues.length} issue(s) to fix.` : ""),
      );
    },
  );

  if (ctx.flags.allowDelete) {
    server.registerTool(
      "delete_project",
      {
        title: "Delete a micropage project",
        description: `Permanently delete a micropage project: its live site goes offline, and its Cloudflare Pages project, DNS record and the project record with its builds are removed. It cannot be undone.

Only call it when the user explicitly asks to delete this specific project. Pass \`confirm_domain\` with the project's micropage domain (from get_project) after the user has confirmed; a mismatch is refused without changing anything. Clients that support it also show the user a confirmation prompt, and declining aborts.

Never use it to "reset" a site; save_page and publish_build replace the content instead. Available only because MICROPAGE_MCP_ALLOW_DELETE is set.`,
        inputSchema: DeleteProjectInput,
        outputSchema: DeleteProjectOutput,
        annotations: OUT,
      },
      async (args, handlerCtx): Promise<CallToolResult | InputRequiredResult> => {
        const result = await runDeleteProject(ctx, args, handlerCtx);
        if (!("deleted" in result)) return result;
        return structuredResult(result, `Deleted ${result.domain ?? result.uuid}.`);
      },
    );
  }
}
