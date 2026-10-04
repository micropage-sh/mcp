import { IN_PROGRESS_STATUSES } from "./builds.js";
import { MicropageError } from "./errors.js";
import { eq, gt, type Http } from "./http.js";

/** Same set as the CLI's stream (cli/src/supabase.js). */
export const TERMINAL_DEPLOY_EVENTS: ReadonlySet<string> = new Set([
  "build.failed",
  "deployment.completed",
  "archive.completed",
  "archive.failed",
]);

export interface DeployEventRow {
  id: number;
  event_type: string | null;
  payload: unknown;
  created_at: string | null;
}

export interface DeployEvent {
  id: number;
  type: string;
  message: string;
  created_at: string | null;
}

function truncate(str: unknown, max = 200): string {
  const oneLine = String(str).replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** Port of the CLI's formatDeployEventForConsole, so both read the same. */
export function formatDeployEvent(ev: Pick<DeployEventRow, "event_type" | "payload">): string {
  const eventType = ev.event_type ?? "";
  const payload =
    ev.payload && typeof ev.payload === "object" && !Array.isArray(ev.payload)
      ? (ev.payload as Record<string, unknown>)
      : null;
  if (eventType === "deployment.domain_wiring" && payload) {
    const host = typeof payload.hostname === "string" ? payload.hostname : "";
    const https = host ? `https://${host}` : "";
    switch (payload.step) {
      case "started":
        return `${eventType}: preparing ${host || "platform hostname"}`;
      case "dns_ok":
        return `${eventType}: DNS CNAME ready (${host})`;
      case "dns_resolve_ok":
        return payload.skipped ? `${eventType}: skipped public DNS wait` : `${eventType}: hostname resolves (${host})`;
      case "attach_ok":
        return `${eventType}: registered on Cloudflare Pages (${host})`;
      case "polling":
        return `${eventType}: Pages status "${typeof payload.pages_status === "string" && payload.pages_status ? payload.pages_status : "…"}" (${host})`;
      case "active":
        return `${eventType}: live — ${https}`;
      case "failed":
        return `${eventType}: failed — ${truncate(payload.error ?? "unknown", 160)}`;
      case "timeout":
        return `${eventType}: still pending after wait (try ${https || "URL"} shortly)`;
      default:
        break;
    }
  }
  const extra = ev.payload ? ` ${truncate(JSON.stringify(ev.payload))}` : "";
  return `${eventType}${extra}`;
}

export function toDeployEvent(row: DeployEventRow): DeployEvent {
  return { id: row.id, type: row.event_type ?? "", message: formatDeployEvent(row), created_at: row.created_at ?? null };
}

/** Highest build_deploy_events.id for the build, 0 when none: the cursor taken before publishing. */
export async function getMaxDeployEventId(http: Http, buildId: number): Promise<number> {
  const row = await http.selectOne<{ id: number | string }>("build_deploy_events", {
    select: "id",
    filters: { build_id: eq(buildId) },
    order: "id.desc",
  });
  const n = Number(row?.id);
  return Number.isFinite(n) ? n : 0;
}

export const EVENTS_PAGE = 100;

export async function fetchDeployEventsAfter(http: Http, buildId: number, afterId: number): Promise<DeployEventRow[]> {
  return http.select<DeployEventRow>("build_deploy_events", {
    select: "id,event_type,payload,created_at",
    filters: { build_id: eq(buildId), id: gt(afterId) },
    order: "id.asc",
    limit: EVENTS_PAGE,
  });
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export const POLL_INTERVAL_MS = 2_000;

export interface BuildStatusRow {
  id: number;
  number: number | null;
  status: string | null;
  failure_reason: string | null;
  updated_at: string | null;
}

export interface PollOptions {
  http: Http;
  projectId: number;
  buildId: number;
  afterId: number;
  waitMs: number;
  intervalMs?: number;
  clock?: Clock;
  /**
   * When false, terminal events do not end the wait and only the build status
   * decides. For callers without a cursor, whose event history may include
   * the end of an earlier publish of the same build.
   */
  trustEvents?: boolean;
  /** Called after every poll; a throw here is swallowed. */
  onPoll?: ((state: { elapsedMs: number; status: string | null; newEvents: DeployEvent[] }) => void | Promise<void>) | undefined;
}

export interface PollResult {
  build: BuildStatusRow;
  events: DeployEvent[];
  after_event_id: number;
  /** True once a terminal event arrived or the build is no longer publishing. */
  done: boolean;
  terminal_event: DeployEvent | null;
  /** True when wait ran out before done. */
  timed_out: boolean;
}

/**
 * Polls builds.status and build_deploy_events (id > cursor) until a terminal
 * event, a status that is no longer in progress, or waitMs. Always polls at
 * least once, so waitMs 0 is a single snapshot.
 */
export async function pollDeployStatus(options: PollOptions): Promise<PollResult> {
  const { http, projectId, buildId } = options;
  const clock = options.clock ?? realClock;
  const interval = options.intervalMs ?? POLL_INTERVAL_MS;
  const start = clock.now();
  const deadline = start + Math.max(0, options.waitMs);
  let cursor = options.afterId;
  const events: DeployEvent[] = [];
  let terminal: DeployEvent | null = null;

  for (;;) {
    // Status before events: the publisher writes the status first, so the
    // event that goes with a terminal status is normally already visible.
    const build = await http.selectOne<BuildStatusRow>("builds", {
      select: "id,number,status,failure_reason,updated_at",
      filters: { id: eq(buildId), project_id: eq(projectId) },
    });
    if (!build) {
      throw new MicropageError("BUILD_NOT_FOUND", `Build id ${buildId} is not in this project. Call list_builds to see its builds.`);
    }
    const rows = await fetchDeployEventsAfter(http, buildId, cursor);
    const fresh = rows.map(toDeployEvent);
    for (const ev of fresh) cursor = Math.max(cursor, ev.id);
    events.push(...fresh);

    if (options.trustEvents !== false) {
      terminal = fresh.find((e) => TERMINAL_DEPLOY_EVENTS.has(e.type)) ?? terminal;
    }
    const done = terminal !== null || !IN_PROGRESS_STATUSES.has(build.status ?? "");

    if (options.onPoll) {
      try {
        await options.onPoll({ elapsedMs: clock.now() - start, status: build.status, newEvents: fresh });
      } catch {
        // progress is best effort
      }
    }

    // A full page means more events are waiting: drain them before returning.
    const more = rows.length >= EVENTS_PAGE;
    const now = clock.now();
    if (!more && (done || now >= deadline)) {
      return { build, events, after_event_id: cursor, done, terminal_event: terminal, timed_out: !done };
    }
    if (!more) await clock.sleep(Math.min(interval, deadline - now));
  }
}
