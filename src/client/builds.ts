import * as z from "zod";

import type { MicropageConfig } from "./config.js";
import { MicropageError } from "./errors.js";
import { eq, inList, type Http } from "./http.js";
import {
  collectParseIssues,
  countPages,
  injectLlmsTxt,
  normalizeLlmsTxt,
  parsePageSource,
} from "./pages.js";

/** Values of the builds.status enum that mean a publish is under way. */
export const IN_PROGRESS_STATUSES: ReadonlySet<string> = new Set(["publishing", "in_progress"]);

/** A build in one of these states is still a working copy and may be overwritten. */
export const EDITABLE_STATUSES: readonly string[] = ["draft", "failed"];

export const isEditable = (status: string | null | undefined): boolean => EDITABLE_STATUSES.includes(status ?? "");

/**
 * A publishing build older than this is treated as stuck, not in flight.
 * The publisher's per-project build semaphore expires after 15 minutes, so a
 * real build cannot still be running by then.
 */
export const STALE_PUBLISHING_MS = 30 * 60 * 1000;

export interface BuildRow {
  id: number;
  number: number | null;
  status: string | null;
  created_at?: string | null;
  updated_at: string | null;
  failure_reason: string | null;
}

export const BUILD_ROW_COLUMNS = "id,number,status,created_at,updated_at,failure_reason";

// ---------------------------------------------------------------------------
// Build references
// ---------------------------------------------------------------------------

/** The `build` / `version` input build-scoped tools take. */
export const BuildRefInput = z
  .union([z.number().int().nonnegative(), z.string().trim().min(1).max(40)])
  .describe(
    'Which build: its number ("v12" or 12, as list_builds shows) or its id ("id:4567", as save_page returns). ' +
      "A bare number is read as a build number first, then as an id.",
  );

export type BuildRef =
  /** `id:123`: the global builds.id. */
  | { kind: "id"; value: number }
  /** `v12` or `12`: the per-project build number; a bare number falls back to an id. */
  | { kind: "number"; value: number; idFallback: boolean };

export function parseBuildRef(input: string | number): BuildRef {
  if (typeof input === "number") {
    if (!Number.isSafeInteger(input) || input < 0) throw invalidBuildRef(String(input));
    return { kind: "number", value: input, idFallback: true };
  }
  const s = input.trim();
  let m = /^id[:#\s]*(\d+)$/i.exec(s);
  if (m) return { kind: "id", value: Number(m[1]) };
  m = /^v\s*(\d+)$/i.exec(s);
  if (m) return { kind: "number", value: Number(m[1]), idFallback: false };
  m = /^(\d+)$/.exec(s);
  if (m) return { kind: "number", value: Number(m[1]), idFallback: true };
  throw invalidBuildRef(s);
}

function invalidBuildRef(s: string): MicropageError {
  return new MicropageError(
    "INVALID_BUILD",
    `"${s}" is not a build reference. Use a build number ("v12" or 12) or a build id ("id:4567"); list_builds shows both.`,
  );
}

/** Finds one build of the project; a bare number matches the build number first, then the id. */
export async function findBuild<T extends { id: number; number: number | null }>(
  http: Http,
  projectId: number,
  ref: BuildRef,
  columns: string = BUILD_ROW_COLUMNS,
): Promise<T> {
  const byProject = { project_id: eq(projectId) };
  let row: T | null = null;
  if (ref.kind === "id") {
    row = await http.selectOne<T>("builds", { select: columns, filters: { ...byProject, id: eq(ref.value) } });
  } else {
    row = await http.selectOne<T>("builds", { select: columns, filters: { ...byProject, number: eq(ref.value) } });
    if (!row && ref.idFallback) {
      row = await http.selectOne<T>("builds", { select: columns, filters: { ...byProject, id: eq(ref.value) } });
    }
  }
  if (!row) {
    const label = ref.kind === "id" ? `id ${ref.value}` : `v${ref.value}`;
    throw new MicropageError("BUILD_NOT_FOUND", `This project has no build ${label}. Call list_builds to see its builds.`);
  }
  return row;
}

export async function getBuildById<T>(http: Http, projectId: number, buildId: number, columns: string): Promise<T | null> {
  return http.selectOne<T>("builds", { select: columns, filters: { id: eq(buildId), project_id: eq(projectId) } });
}

/** Same write as the CLI's setActiveBuildId. */
export async function setActiveBuild(http: Http, projectId: number, buildId: number): Promise<void> {
  const rows = await http.patch("projects", { id: eq(projectId) }, { active_build_id: buildId });
  if (rows.length === 0) {
    throw new MicropageError("PROJECT_NOT_FOUND", "Could not update the project's active build (project not found or not yours).");
  }
}

/** A build of the project whose publish is still running, ignoring ones stuck for over STALE_PUBLISHING_MS. */
export async function findPublishingBuild(http: Http, projectId: number, nowMs: number): Promise<BuildRow | null> {
  const rows = await http.select<BuildRow>("builds", {
    select: BUILD_ROW_COLUMNS,
    filters: { project_id: eq(projectId), status: inList([...IN_PROGRESS_STATUSES]) },
    order: "updated_at.desc",
    limit: 5,
  });
  return (
    rows.find((r) => {
      const at = r.updated_at ? Date.parse(r.updated_at) : Number.NaN;
      return Number.isNaN(at) || nowMs - at < STALE_PUBLISHING_MS;
    }) ?? null
  );
}

/** Same call as the CLI's publish: sets the build to publishing and queues the publisher. */
export async function invokePublishBuild(http: Http, projectId: number, buildId: number): Promise<void> {
  await http.invoke("publish-build", { buildId, projectId });
}

// ---------------------------------------------------------------------------
// save_page: the editor's draft rule
// ---------------------------------------------------------------------------

interface ActiveBuildRow {
  id: number;
  number: number | null;
  status: string | null;
  llms_txt: string | null;
}

export interface SaveDraftInput {
  projectId: number;
  activeBuildId: number | null;
  /** Merged .page source (concatPages). */
  text: string;
  /** undefined keeps the active build's llms.txt; "" removes it; anything else replaces it. */
  llmsTxt?: string | undefined;
}

export interface SaveDraftResult {
  build: { id: number; number: number | null; status: string | null };
  action: "updated_draft" | "created_draft";
  /** The build this one replaced as active, when a new draft was created. */
  previous_active_build_id: number | null;
  issues: string[];
  page_count: number;
  llms_txt: "kept" | "set" | "removed" | "none";
}

/**
 * The editor's rule (editor/app/controllers/editor.js), not the CLI's: the
 * project's active build is overwritten while it is a draft or failed;
 * otherwise a new draft is inserted with the CLI's payload and made active.
 *
 * The publisher reads json_content when the job starts, which can be minutes
 * after publish-build flipped the status, so the status is re-read right
 * before the PATCH and the PATCH itself is filtered on an editable status:
 * a build that started publishing in between is never overwritten.
 */
export async function saveDraft(
  http: Http,
  config: Pick<MicropageConfig, "buildCompilerUrl">,
  input: SaveDraftInput,
): Promise<SaveDraftResult> {
  const active =
    input.activeBuildId === null
      ? null
      : await getBuildById<ActiveBuildRow>(
          http,
          input.projectId,
          input.activeBuildId,
          "id,number,status,llms_txt:json_content->site->>llms_txt",
        );
  const reuse = active !== null && isEditable(active.status);

  let llms: string | null;
  let llmsState: SaveDraftResult["llms_txt"];
  if (input.llmsTxt === undefined) {
    llms = active?.llms_txt ?? null;
    llmsState = llms === null ? "none" : "kept";
  } else {
    llms = normalizeLlmsTxt(input.llmsTxt);
    llmsState = llms === null ? (active?.llms_txt ? "removed" : "none") : "set";
  }

  const parsed = await parsePageSource(http, config, {
    text: input.text,
    projectId: input.projectId,
    buildId: reuse ? active.id : null,
  });
  const json = injectLlmsTxt(parsed, llms);
  const issues = collectParseIssues(json);
  const page_count = countPages(json);

  if (reuse) {
    const current = await getBuildById<{ id: number; status: string | null }>(http, input.projectId, active.id, "id,status");
    if (!current || !isEditable(current.status)) throw draftMoved(active.number, current?.status ?? "deleted");

    const rows = await http.patch<{ id: number; number: number | null; status: string | null }>(
      "builds",
      { id: eq(active.id), project_id: eq(input.projectId), status: inList(EDITABLE_STATUSES) },
      { raw_content: input.text, json_content: json },
    );
    const row = rows[0];
    if (!row) throw draftMoved(active.number, "no longer a draft");
    return {
      build: { id: row.id, number: row.number ?? active.number, status: row.status ?? current.status },
      action: "updated_draft",
      previous_active_build_id: null,
      issues,
      page_count,
      llms_txt: llmsState,
    };
  }

  const inserted = await http.insert<{ id: number; number: number | null; status: string | null }>("builds", {
    project_id: input.projectId,
    raw_content: input.text,
    json_content: json,
    status: "draft",
    parser_version: "2",
  });
  const row = inserted[0];
  if (!row) throw new MicropageError("SAVE_FAILED", "Creating the draft build returned no row. Retry; if it persists, check list_builds.");
  await setActiveBuild(http, input.projectId, row.id);
  return {
    build: { id: row.id, number: row.number ?? null, status: row.status ?? "draft" },
    action: "created_draft",
    previous_active_build_id: input.activeBuildId,
    issues,
    page_count,
    llms_txt: llmsState,
  };
}

function draftMoved(number: number | null, status: string): MicropageError {
  return new MicropageError(
    "BUILD_STATE_CHANGED",
    `Draft v${number ?? "?"} changed to "${status}" while saving (a publish started), so it was not overwritten. ` +
      `Nothing was saved. Call get_deploy_status to follow that publish, then call save_page again; it will create a new draft.`,
  );
}
