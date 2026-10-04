import { MicropageError, isMicropageError } from "./errors.js";
import { eq, is, type Filters, type Http } from "./http.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Forms (cli/src/commands/forms.js)
// ---------------------------------------------------------------------------

const FORM_COLUMNS = "id,form_name,page_url,is_footer,created_at";

interface FormRow {
  id: string;
  form_name: string;
  page_url: string | null;
  is_footer: boolean | null;
  created_at: string | null;
  form_ordinal?: number | null;
}

export interface FormWithCount {
  id: string;
  form_name: string;
  /** form_name, plus "(n)" for the nth same-named form on one page, as the CLI prints it. */
  label: string;
  page_url: string | null;
  is_footer: boolean;
  form_ordinal: number;
  created_at: string | null;
  submission_count: number;
}

/** Occurrence number among same-named forms on the same page, 1-based. */
export function formLabel(form: { form_name: string; form_ordinal?: number | null }): string {
  const ordinal = Number(form.form_ordinal) || 0;
  return ordinal > 0 ? `${form.form_name} (${ordinal + 1})` : form.form_name;
}

function fetchForms(http: Http, projectId: number, withOrdinal: boolean): Promise<FormRow[]> {
  return http.select<FormRow>("forms", {
    select: withOrdinal ? `${FORM_COLUMNS},form_ordinal` : FORM_COLUMNS,
    filters: { project_id: eq(projectId) },
    // Same order strings the CLI's query builder produces.
    order: withOrdinal ? "page_url,form_ordinal.asc" : "created_at.asc",
  });
}

/**
 * Forms with non-spam submission counts. form_ordinal is newer than some
 * deployed databases and selecting a missing column fails the whole request,
 * so an HTTP error on the first shape retries without it, as the CLI does.
 */
export async function listFormsWithCounts(http: Http, projectId: number): Promise<FormWithCount[]> {
  let forms: FormRow[];
  try {
    forms = await fetchForms(http, projectId, true);
  } catch (err) {
    if (!isMicropageError(err) || err.code !== "HTTP") throw err;
    forms = await fetchForms(http, projectId, false);
  }
  if (forms.length === 0) return [];

  // One exact count per form: selecting the rows would stop at PostgREST's max_rows.
  const totals = await Promise.all(
    forms.map((f) => http.count("form_submissions", { project_id: eq(projectId), form_id: eq(f.id), flagged_at: is("null") })),
  );
  const counts = new Map(forms.map((f, i) => [f.id, totals[i]!]));

  return forms.map((f) => ({
    id: f.id,
    form_name: f.form_name,
    label: formLabel(f),
    page_url: f.page_url ?? null,
    is_footer: Boolean(f.is_footer),
    form_ordinal: Number(f.form_ordinal) || 0,
    created_at: f.created_at ?? null,
    submission_count: counts.get(f.id) ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// Submissions (cli/src/commands/submissions.js)
// ---------------------------------------------------------------------------

export const MAX_SUBMISSIONS = 50;
export const DEFAULT_SUBMISSIONS = 20;

const SUBMISSION_COLUMNS = "id,form_id,form_name,page_url,form_index,build_id,created_at,payload,spam_reason,flagged_at,flagged_by";

export interface SubmissionRow {
  id: string;
  form_id: string | null;
  form_name: string | null;
  page_url: string | null;
  form_index: number | null;
  build_id: number | null;
  created_at: string | null;
  /** Visitor-typed data: untrusted, and personal data. */
  payload: unknown;
  spam_reason: string | null;
  flagged_at: string | null;
  flagged_by: string | null;
}

/**
 * The CLI's applySpamFilter for the inbox: spam is `flagged_at IS NOT NULL`,
 * so the default view is `flagged_at IS NULL`. Including spam drops the
 * filter (inbox and spam together) rather than switching to spam only.
 */
export function spamFilter(includeSpam: boolean): Filters {
  return includeSpam ? {} : { flagged_at: is("null") };
}

export interface ListSubmissionsOptions {
  /** A form uuid (matches form_id) or a form name (matches form_name). */
  form?: string | undefined;
  includeSpam?: boolean | undefined;
  limit?: number | undefined;
}

export async function listSubmissions(http: Http, projectId: number, options: ListSubmissionsOptions = {}): Promise<SubmissionRow[]> {
  const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? DEFAULT_SUBMISSIONS)), MAX_SUBMISSIONS);
  const filters: Filters = { project_id: eq(projectId), ...spamFilter(Boolean(options.includeSpam)) };
  const form = options.form?.trim();
  if (form) {
    if (UUID_RE.test(form)) filters.form_id = eq(form.toLowerCase());
    else filters.form_name = eq(form);
  }
  return http.select<SubmissionRow>("form_submissions", {
    select: SUBMISSION_COLUMNS,
    filters,
    order: "created_at.desc",
    limit,
  });
}

/** One submission, scoped to the project so an id from another project reads as not found. */
export async function getSubmission(http: Http, projectId: number, id: string): Promise<SubmissionRow> {
  const trimmed = id.trim();
  if (!UUID_RE.test(trimmed)) {
    throw new MicropageError("INVALID_ARGUMENT", `"${id}" is not a submission id (a uuid). Call list_submissions to get ids.`);
  }
  const row = await http.selectOne<SubmissionRow>("form_submissions", {
    select: SUBMISSION_COLUMNS,
    filters: { id: eq(trimmed.toLowerCase()), project_id: eq(projectId) },
  });
  if (!row) {
    throw new MicropageError("NOT_FOUND", `No submission ${trimmed} in this project. Call list_submissions to see valid ids.`);
  }
  return row;
}

/** The label/value pairs of a payload: `payload.fields` as submit-form stores it, else the raw keys of older rows. */
export function submissionFields(payload: unknown): Array<{ label: string; value: unknown }> {
  if (!payload || typeof payload !== "object") return [];
  const fields = (payload as { fields?: unknown }).fields;
  if (Array.isArray(fields)) {
    return fields.map((f: unknown) => {
      const o = (f && typeof f === "object" ? f : {}) as { label?: unknown; name?: unknown; value?: unknown };
      return { label: String(o.label ?? o.name ?? ""), value: o.value ?? null };
    });
  }
  return Object.entries(payload as Record<string, unknown>).map(([label, value]) => ({ label, value }));
}
