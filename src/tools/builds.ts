import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import * as z from "zod";

import { OUT, RO } from "../annotations.js";
import {
  BUILD_ROW_COLUMNS,
  BuildRefInput,
  IN_PROGRESS_STATUSES,
  findBuild,
  findPublishingBuild,
  getBuildById,
  invokePublishBuild,
  parseBuildRef,
  setActiveBuild,
  type BuildRow,
} from "../client/builds.js";
import {
  getLatestDeployEventAt,
  getMaxDeployEventId,
  pollDeployStatus,
  realClock,
  type Clock,
  type DeployEvent,
} from "../client/deploy-events.js";
import { MicropageError } from "../client/errors.js";
import { eq } from "../client/http.js";
import { ProjectRef, resolveProject, type Project } from "../client/project-ref.js";
import type { PlanTier } from "../client/tier.js";
import type { ToolContext } from "../context.js";
import { requireConfirm } from "../guards.js";
import { reportProgress } from "../progress.js";
import { gateTool, structuredResult } from "./shared.js";

/** Swappable in tests so the poll loop runs on a fake clock. */
export const buildToolsClock: { current: Clock } = { current: realClock };

const DEPLOY_GOTCHAS =
  "Right after deployment.completed the URL can still serve the previous version for a minute or so while Cloudflare " +
  "updates its alias, and page paths redirect (308) to a trailing slash, so fetch with redirects followed (curl -L).";

async function resolveTargetBuild(
  ctx: ToolContext,
  project: Project,
  ref: string | number | undefined,
): Promise<BuildRow> {
  if (ref !== undefined) return findBuild<BuildRow>(ctx.http, project.id, parseBuildRef(ref));
  if (project.active_build_id === null) {
    throw new MicropageError(
      "NO_BUILD",
      "This project has no active build yet. Call save_page to create a draft first.",
    );
  }
  const row = await getBuildById<BuildRow>(ctx.http, project.id, project.active_build_id, BUILD_ROW_COLUMNS);
  if (!row) {
    throw new MicropageError("BUILD_NOT_FOUND", "The project's active build no longer exists. Call list_builds and pass `build`.");
  }
  return row;
}

// ---------------------------------------------------------------------------
// publish_build
// ---------------------------------------------------------------------------

export const PublishBuildInput = z
  .object({
    project: ProjectRef,
    build: BuildRefInput.optional().describe(
      "Which build to publish: the id save_page returned (\"id:4567\") or a build number (\"v12\" or 12). Defaults to " +
        "the project's active build. Naming an older build republishes that snapshot and makes it the active build.",
    ),
    confirm: z
      .boolean()
      .optional()
      .describe("Must be true. Publishing changes the public site; ask the user before setting it."),
  })
  .strict();

export const PublishBuildOutput = z.object({
  project_id: z.number(),
  build: z.object({
    id: z.number(),
    number: z.number().nullable(),
    previous_status: z.string().nullable().describe("The build's status before this publish."),
  }),
  status: z.literal("publishing"),
  active_build_changed: z.boolean().describe("True when the named build was not the active build and was made active."),
  previous_active_build_id: z.number().nullable(),
  after_event_id: z.number().describe("Pass to get_deploy_status so it only reports events from this publish."),
  plan_tier: z.enum(["free", "pro", "pro_plus"]).nullable(),
  eta_seconds: z.number().describe("Rough time until the site is live."),
  eta: z.string(),
  live_url: z.string().nullable(),
  next: z.string(),
});
export type PublishBuildResult = z.infer<typeof PublishBuildOutput>;

function etaFor(tier: PlanTier | null): { eta_seconds: number; eta: string } {
  if (tier === "pro_plus") {
    return { eta_seconds: 90, eta: "Pro+ builds start right away; usually live in 1-2 minutes." };
  }
  return {
    eta_seconds: 270,
    eta:
      "Builds wait about 3 minutes in the queue on this plan (Pro+ skips the wait), then take 1-2 minutes; " +
      "expect the site in about 4-5 minutes.",
  };
}

/**
 * Puts the previous active build back after a publish that did not start, so
 * a failed publish_build leaves the project as it found it. Best effort: the
 * returned error says whether the restore worked.
 */
async function restoreActiveBuild(ctx: ToolContext, project: Project, cause: unknown): Promise<MicropageError> {
  const previous = project.active_build_id;
  const base = cause instanceof MicropageError ? cause : null;
  const reason = cause instanceof Error ? cause.message : String(cause);
  let note: string;
  try {
    await setActiveBuild(ctx.http, project.id, previous);
    note =
      previous === null
        ? "The project's active build was reset to none, as before. Nothing was published."
        : `The project's active build was restored to id ${previous}, as before. Nothing was published.`;
  } catch {
    note =
      `Restoring the previous active build (id ${previous ?? "none"}) also failed, so the build named here is still ` +
      "the active build. Call list_builds to check, and publish_build again or pick the build to keep.";
  }
  return new MicropageError(base?.code ?? "PUBLISH_FAILED", `Starting the publish failed: ${reason} ${note}`, {
    ...(base?.status === undefined ? {} : { status: base.status }),
    data: base?.data,
    cause,
  });
}

export async function runPublishBuild(
  ctx: ToolContext,
  args: z.infer<typeof PublishBuildInput>,
  nowMs: number = Date.now(),
): Promise<PublishBuildResult> {
  requireConfirm(args, "Publishing a build");
  await gateTool(ctx, "publish_build");
  const project = await resolveProject(ctx, args.project);
  const target = await resolveTargetBuild(ctx, project, args.build);

  const running = await findPublishingBuild(ctx.http, project.id, nowMs);
  if (running) {
    throw new MicropageError(
      "PUBLISH_IN_PROGRESS",
      `Build v${running.number ?? "?"} (id ${running.id}) of this project is still publishing. Wait for it: call ` +
        `get_deploy_status with build "id:${running.id}", then retry. Nothing was changed.`,
    );
  }
  if (!target.status) {
    throw new MicropageError("BUILD_NOT_FOUND", `Build id ${target.id} has no status. Call list_builds and pick another build.`);
  }

  const activeChanged = target.id !== project.active_build_id;
  if (activeChanged) await setActiveBuild(ctx.http, project.id, target.id);

  let afterEventId: number;
  try {
    afterEventId = await getMaxDeployEventId(ctx.http, target.id);
    await invokePublishBuild(ctx.http, project.id, target.id);
  } catch (err) {
    if (!activeChanged) throw err;
    throw await restoreActiveBuild(ctx, project, err);
  }

  let tier: PlanTier | null = null;
  try {
    tier = await ctx.tier.getPlanTier();
  } catch {
    // Only feeds the ETA.
  }

  return {
    project_id: project.id,
    build: { id: target.id, number: target.number ?? null, previous_status: target.status },
    status: "publishing",
    active_build_changed: activeChanged,
    previous_active_build_id: activeChanged ? project.active_build_id : null,
    after_event_id: afterEventId,
    plan_tier: tier,
    ...etaFor(tier),
    live_url: project.live_url,
    next:
      `Publishing started; it is not live yet. Call get_deploy_status with build "id:${target.id}" and ` +
      `after_event_id ${afterEventId} to follow it until done is true.`,
  };
}

// ---------------------------------------------------------------------------
// get_deploy_status
// ---------------------------------------------------------------------------

/** Kept well under the 60 s request timeout most MCP clients apply. */
export const MAX_WAIT_SECONDS = 45;
export const DEFAULT_WAIT_SECONDS = 20;
export const MAX_RETURNED_EVENTS = 100;

export const GetDeployStatusInput = z
  .object({
    project: ProjectRef,
    build: BuildRefInput.optional().describe(
      "The build being published (publish_build returns it as \"id:<id>\"). Defaults to the project's active build.",
    ),
    after_event_id: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Only report events after this id: pass publish_build's after_event_id, then the after_event_id this tool " +
          "returned on the previous call. Omit it to see the build's whole event history; completion is then judged from the build status alone.",
      ),
    wait_seconds: z
      .number()
      .int()
      .min(0)
      .max(MAX_WAIT_SECONDS)
      .optional()
      .describe(`How long to wait for the deploy to finish before returning, 0-${MAX_WAIT_SECONDS} (default ${DEFAULT_WAIT_SECONDS}). 0 returns a snapshot at once.`),
  })
  .strict();

const DeployEventOut = z.object({
  id: z.number(),
  type: z.string().describe("e.g. build.enqueued, deployment.started, deployment.domain_wiring, deployment.completed, build.failed."),
  message: z.string(),
  created_at: z.string().nullable(),
});

export const GetDeployStatusOutput = z.object({
  project_id: z.number(),
  build: z.object({
    id: z.number(),
    number: z.number().nullable(),
    status: z.string().nullable().describe("draft, publishing, deployed or failed."),
    failure_reason: z.string().nullable(),
    updated_at: z.string().nullable(),
  }),
  events: z.array(DeployEventOut).describe("New events since after_event_id, oldest first."),
  events_truncated: z.boolean().describe("True when older events were left out to keep the reply short."),
  after_event_id: z.number().describe("Cursor for the next call."),
  done: z
    .boolean()
    .describe(
      "True when the publish finished (deployed or failed). With after_event_id only a deploy event after it counts; " +
        "without, true also when the build is simply not publishing.",
    ),
  succeeded: z.boolean().nullable().describe("True when deployed, false when failed, null while still running."),
  waiting_for_start: z
    .boolean()
    .describe(
      "True when after_event_id was given but the deploy has not started yet: a site rebuild after a post change is " +
        "queued (up to about 3 minutes unless the account is Pro+) and only then shows events.",
    ),
  possibly_stuck: z
    .boolean()
    .describe("True when the build has been publishing with no deploy events for much longer than a deploy takes."),
  live_url: z.string().nullable(),
  next: z.string(),
});
export type GetDeployStatusResult = z.infer<typeof GetDeployStatusOutput>;

/** Grace on top of the queue delay before a silent publish is called possibly stuck. */
export const STUCK_GRACE_MS = 5 * 60 * 1000;
const QUEUE_DELAY_MS = 3 * 60 * 1000;

/**
 * A build sitting in publishing with no deploy event for longer than the
 * queue delay plus STUCK_GRACE_MS: most likely the publisher webhook never
 * arrived, which nothing on the server retries.
 */
async function looksStuck(ctx: ToolContext, build: { id: number; updated_at: string | null }, nowMs: number): Promise<boolean> {
  let tier: PlanTier | null = null;
  try {
    tier = await ctx.tier.getPlanTier();
  } catch {
    // Unknown plan: assume the queue delay applies.
  }
  const threshold = (tier === "pro_plus" ? 0 : QUEUE_DELAY_MS) + STUCK_GRACE_MS;
  const lastEventAt = await getLatestDeployEventAt(ctx.http, build.id).catch(() => null);
  const times = [build.updated_at, lastEventAt].map((t) => (t ? Date.parse(t) : Number.NaN)).filter((t) => !Number.isNaN(t));
  if (times.length === 0) return false;
  return nowMs - Math.max(...times) > threshold;
}

export async function runGetDeployStatus(
  ctx: ToolContext,
  args: z.infer<typeof GetDeployStatusInput>,
  handlerCtx?: ServerContext,
  clock: Clock = buildToolsClock.current,
): Promise<GetDeployStatusResult> {
  await gateTool(ctx, "get_deploy_status");
  const project = await resolveProject(ctx, args.project);
  const target = await resolveTargetBuild(ctx, project, args.build);
  const waitSeconds = Math.min(args.wait_seconds ?? DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS);
  const cursorGiven = args.after_event_id !== undefined;

  const poll = await pollDeployStatus({
    http: ctx.http,
    projectId: project.id,
    buildId: target.id,
    afterId: args.after_event_id ?? 0,
    waitMs: waitSeconds * 1000,
    clock,
    // Without a cursor, a terminal event from an earlier publish of the same
    // build would look like this one finishing; trust the status instead.
    trustEvents: cursorGiven,
    onPoll: handlerCtx
      ? async ({ elapsedMs, status, newEvents }) => {
          const last = newEvents[newEvents.length - 1];
          await reportProgress(
            handlerCtx,
            Math.min(waitSeconds, Math.round(elapsedMs / 1000)),
            waitSeconds,
            last ? last.message : `status: ${status ?? "unknown"}`,
          );
        }
      : undefined,
  });

  const events: DeployEvent[] = poll.events.slice(-MAX_RETURNED_EVENTS);
  const b = poll.build;
  const terminalType = poll.terminal_event?.type;
  const succeeded = !poll.done
    ? null
    : terminalType === "build.failed" || (!terminalType && b.status === "failed")
      ? false
      : terminalType === "deployment.completed" || b.status === "deployed"
        ? true
        : null;

  const inProgress = IN_PROGRESS_STATUSES.has(b.status ?? "");
  const possiblyStuck = !poll.done && inProgress && (await looksStuck(ctx, b, Date.now()));
  const again = `Call get_deploy_status again with build "id:${b.id}" and after_event_id ${poll.after_event_id}.`;

  let next: string;
  if (poll.waiting_for_start) {
    next =
      `Waiting for the rebuild to start: build v${b.number ?? "?"} is ${b.status ?? "in an unknown state"} and no deploy ` +
      "event has arrived since after_event_id. Site rebuilds are queued for up to about 3 minutes unless the account is " +
      `Pro+, so this is expected at first. Nothing is live from this change yet. ${again}`;
  } else if (!poll.done) {
    next = possiblyStuck
      ? `Build v${b.number ?? "?"} has been publishing with no deploy events for much longer than a deploy takes, so it is ` +
        "possibly stuck (the publisher webhook may have failed). Tell the user and retry with publish_build; it accepts " +
        `the retry once the build has been publishing for 30 minutes. Until then, ${again[0]!.toLowerCase()}${again.slice(1)}`
      : `Still publishing. ${again}`;
  } else if (succeeded === true) {
    next = `Deployed${project.live_url ? ` to ${project.live_url}` : ""}. ${DEPLOY_GOTCHAS}`;
  } else if (succeeded === false) {
    next = `The publish failed${b.failure_reason ? `: ${b.failure_reason}` : ""}. Fix the source with save_page, then publish again.`;
  } else if (cursorGiven) {
    next = `Build v${b.number ?? "?"} is ${b.status ?? "in an unknown state"}; the publish ended without a deploy event. Call list_builds or get_project to check what is live.`;
  } else {
    next = `Build v${b.number ?? "?"} is ${b.status ?? "in an unknown state"}, not publishing. Call publish_build to publish it.`;
  }

  return {
    project_id: project.id,
    build: {
      id: b.id,
      number: b.number ?? null,
      status: b.status ?? null,
      failure_reason: b.failure_reason ?? null,
      updated_at: b.updated_at ?? null,
    },
    events,
    events_truncated: poll.events.length > events.length,
    after_event_id: poll.after_event_id,
    done: poll.done,
    succeeded,
    waiting_for_start: poll.waiting_for_start,
    possibly_stuck: possiblyStuck,
    live_url: project.live_url,
    next,
  };
}

// ---------------------------------------------------------------------------
// list_builds
// ---------------------------------------------------------------------------

export const ListBuildsInput = z
  .object({
    project: ProjectRef,
    limit: z.number().int().min(1).max(100).optional().describe("How many builds to return, newest first (default 20, max 100)."),
  })
  .strict();

export const ListBuildsOutput = z.object({
  project_id: z.number(),
  active_build_id: z.number().nullable(),
  builds: z.array(
    z.object({
      id: z.number(),
      number: z.number().nullable(),
      status: z.string().nullable().describe("draft, publishing, deployed or failed."),
      created_at: z.string().nullable(),
      updated_at: z.string().nullable(),
      failure_reason: z.string().nullable(),
      active: z.boolean().describe("The project's active build: what the editor shows and publish_build defaults to."),
    }),
  ),
  count: z.number(),
});
export type ListBuildsResult = z.infer<typeof ListBuildsOutput>;

export async function runListBuilds(ctx: ToolContext, args: z.infer<typeof ListBuildsInput>): Promise<ListBuildsResult> {
  await gateTool(ctx, "list_builds");
  const project = await resolveProject(ctx, args.project);
  const rows = await ctx.http.select<BuildRow>("builds", {
    select: BUILD_ROW_COLUMNS,
    filters: { project_id: eq(project.id) },
    order: "number.desc",
    limit: args.limit ?? 20,
  });
  const builds = rows.map((r) => ({
    id: r.id,
    number: r.number ?? null,
    status: r.status ?? null,
    created_at: r.created_at ?? null,
    updated_at: r.updated_at ?? null,
    failure_reason: r.failure_reason ?? null,
    active: r.id === project.active_build_id,
  }));
  return { project_id: project.id, active_build_id: project.active_build_id, builds, count: builds.length };
}

// ---------------------------------------------------------------------------

export function registerBuildTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "publish_build",
    {
      title: "Publish a build to the live site",
      description: `Deploy a micropage build to the project's public URL. This changes what visitors see, so only call it when the user explicitly asks to publish, and pass confirm: true.

Defaults to the active build (the draft save_page just wrote); pass \`build\` with the id save_page returned to be exact, or an older build number to roll back to it (that build becomes active). Refused while another build of the project is still publishing.

It returns at once with status publishing, after_event_id and an ETA (builds wait about 3 minutes in the queue unless the account is Pro+). Then call get_deploy_status with that build and after_event_id to follow it to the end. It does not save source; call save_page first.`,
      inputSchema: PublishBuildInput,
      outputSchema: PublishBuildOutput,
      annotations: OUT,
    },
    async (args) => {
      const result = await runPublishBuild(ctx, args);
      return structuredResult(
        result,
        `Publishing build v${result.build.number ?? "?"} (id ${result.build.id}). ${result.eta} Follow it with get_deploy_status.`,
      );
    },
  );

  server.registerTool(
    "get_deploy_status",
    {
      title: "Follow a micropage deploy",
      description: `Report the progress of a publish: the build status, the deploy events since after_event_id (queued, built, uploaded, domain wiring, completed or failed), whether it is done, and the live URL.

Call it after publish_build or publish_post, passing the build and after_event_id they returned, and keep calling it with the returned after_event_id until done is true. With after_event_id, only a deploy event after it ends the wait: a site rebuild after a post change is queued (up to about 3 minutes unless the account is Pro+) and reports waiting_for_start until it begins. It waits up to wait_seconds (default ${DEFAULT_WAIT_SECONDS}, max ${MAX_WAIT_SECONDS}) per call, sending progress notifications meanwhile. possibly_stuck flags a publish with no events for far longer than a deploy takes.

When it reports success: ${DEPLOY_GOTCHAS} Read-only; it never starts or cancels a deploy.`,
      inputSchema: GetDeployStatusInput,
      outputSchema: GetDeployStatusOutput,
      annotations: RO,
    },
    async (args, handlerCtx) => {
      const result = await runGetDeployStatus(ctx, args, handlerCtx);
      const state = result.waiting_for_start
        ? "waiting for the rebuild to start"
        : result.possibly_stuck
          ? "publishing, possibly stuck"
          : !result.done
            ? "still publishing"
            : result.succeeded === true ? "deployed" : result.succeeded === false ? "failed" : result.build.status ?? "idle";
      return structuredResult(result, `Build v${result.build.number ?? "?"}: ${state}.`);
    },
  );

  server.registerTool(
    "list_builds",
    {
      title: "List a project's builds",
      description: `List a micropage project's builds, newest first: number, id, status (draft, publishing, deployed, failed), created and updated times, failure reason, and which build is active.

Use it to find a build to roll back to with publish_build, to see why a publish failed, or to check whether a publish is still running. Each save_page that cannot overwrite a draft adds a build; publishing reuses the build.

Read-only. To read a build's source use get_page_source with its number; for what is live right now use get_project.`,
      inputSchema: ListBuildsInput,
      outputSchema: ListBuildsOutput,
      annotations: RO,
    },
    async (args) => {
      const result = await runListBuilds(ctx, args);
      return structuredResult(result, `${result.count} build(s).`);
    },
  );
}
