import { createHash } from "node:crypto";

import { MicropageError } from "./errors.js";
import { eq, gt, inList, is, type Http } from "./http.js";

/** Same rule as supabase/functions/_shared/slug.ts and the CLI's slugify. */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export type WebVisibility = "listed" | "unlisted" | "none";

/** Columns for the list view (cli posts list, plus form_id to name the list). */
export const POST_LIST_COLUMNS =
  "id,slug,title,web_visibility,email_enabled,form_id,status,published_at,created_at,recipient_count";

/** Everything posts pull reads, plus the email fields upsert_post writes. */
export const POST_FULL_COLUMNS =
  "id,slug,title,description,body_markdown,web_visibility,email_enabled,form_id,hero_image,subject,preheader," +
  "status,published_at,created_at,recipient_count,sent_count";

export interface PostListRow {
  id: string;
  slug: string | null;
  title: string | null;
  web_visibility: WebVisibility | null;
  email_enabled: boolean | null;
  form_id: string | null;
  status: string | null;
  published_at: string | null;
  created_at: string | null;
  recipient_count: number | null;
}

export interface PostRow extends PostListRow {
  description: string | null;
  body_markdown: string | null;
  hero_image: string | null;
  subject: string | null;
  preheader: string | null;
  sent_count: number | null;
}

export async function listPosts(http: Http, projectId: number): Promise<PostListRow[]> {
  return http.select<PostListRow>("posts", {
    select: POST_LIST_COLUMNS,
    filters: { project_id: eq(projectId) },
    order: "created_at.desc",
  });
}

export async function getPostBySlug(http: Http, projectId: number, slug: string): Promise<PostRow | null> {
  return http.selectOne<PostRow>("posts", {
    select: POST_FULL_COLUMNS,
    filters: { project_id: eq(projectId), slug: eq(slug) },
  });
}

export function postNotFound(slug: string): MicropageError {
  return new MicropageError(
    "POST_NOT_FOUND",
    `No post with slug "${slug}" in this project. Call list_posts to see the project's posts, or upsert_post to create it.`,
  );
}

/** publish-post's condition for sending (supabase/functions/publish-post/index.ts). */
export function postWillEmail(post: Pick<PostRow, "email_enabled" | "form_id">): boolean {
  return post.email_enabled === true && post.form_id != null;
}

// ---------------------------------------------------------------------------
// Newsletter lists (forms)
// ---------------------------------------------------------------------------

export interface FormNameRow {
  id: string;
  form_name: string | null;
}

/**
 * `list: <form name>` -> form_id, as cli/src/commands/posts.js resolveFormId:
 * case-insensitive exact name among the project's newsletter forms.
 */
export async function resolveListFormId(http: Http, projectId: number, listName: string): Promise<string> {
  const name = listName.trim();
  const forms = await http.select<FormNameRow & { is_newsletter: boolean }>("forms", {
    select: "id,form_name,is_newsletter",
    filters: { project_id: eq(projectId), is_newsletter: eq(true) },
  });
  const matches = forms.filter((f) => (f.form_name ?? "").toLowerCase() === name.toLowerCase());
  if (matches.length === 0) {
    const known = forms.map((f) => f.form_name).filter((n): n is string => !!n);
    throw new MicropageError(
      "LIST_NOT_FOUND",
      `No newsletter form named "${name}" in this project.` +
        (known.length > 0
          ? ` Newsletter forms here: ${known.map((n) => `"${n}"`).join(", ")}.`
          : " The project has no newsletter forms; one is created by publishing a page with a newsletter form.") +
        " Nothing was saved.",
    );
  }
  if (matches.length > 1) {
    throw new MicropageError(
      "LIST_AMBIGUOUS",
      `More than one newsletter form is named "${name}". Ask the user to rename one in the editor. Nothing was saved.`,
    );
  }
  return matches[0]!.id;
}

export async function formNamesById(http: Http, ids: ReadonlyArray<string>): Promise<Map<string, string | null>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await http.select<FormNameRow>("forms", {
    select: "id,form_name",
    filters: { id: inList(unique) },
  });
  return new Map(rows.map((r) => [r.id, r.form_name]));
}

/**
 * Active subscribers on a list, with the filter publish-post sends to
 * (form_id, unsubscribed_at is null). The owner can read the table under RLS
 * ("Users can select newsletter_subscribers for own projects").
 */
export async function countActiveSubscribers(http: Http, formId: string): Promise<number> {
  return http.count("newsletter_subscribers", { form_id: eq(formId), unsubscribed_at: is("null") });
}

// ---------------------------------------------------------------------------
// Hero image
// ---------------------------------------------------------------------------

interface RemoteFile {
  id: string;
  filename: string | null;
}

export function isAbsoluteUrl(s: string): boolean {
  return /^https?:\/\//i.test(s.trim());
}

/**
 * The hero as cli/src/posts-assets.js resolveHeroImage resolves it, minus the
 * local-file upload branch: an absolute URL passes through, anything else must
 * be the filename of an asset already uploaded to the project.
 */
export async function resolveHeroUrl(http: Http, projectId: number, hero: string | undefined): Promise<string | null> {
  const value = hero?.trim() ?? "";
  if (!value) return null;
  if (isAbsoluteUrl(value)) return value;

  const data = await http.invokeGet<{ files?: RemoteFile[] } | null>("list-files", { project_id: String(projectId) });
  const files = data?.files ?? [];
  const base = value.split(/[\\/]/).pop() ?? value;
  const file = files.find((f) => f.filename === value) ?? files.find((f) => f.filename === base);
  if (!file) {
    throw new MicropageError(
      "HERO_NOT_FOUND",
      `hero "${value}" is not an https URL and no uploaded asset in this project has that filename. ` +
        "Upload the image with upload_asset first and pass the filename it returns (list_files shows existing ones). Nothing was saved.",
    );
  }
  const urlData = await http.invokeGet<{ url?: string } | null>("get-file-url", { file_id: file.id });
  if (!urlData?.url) {
    throw new MicropageError("HTTP", `get-file-url returned no URL for "${file.filename}". Retry shortly. Nothing was saved.`);
  }
  return urlData.url;
}

// Same pattern as posts-assets.js: ![alt](path "title").
const MD_IMAGE_RE = /!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;

/** Body image refs that are not hosted URLs; they would 404 on the live page. */
export function unhostedBodyImages(markdown: string): string[] {
  const out: string[] = [];
  for (const match of markdown.matchAll(MD_IMAGE_RE)) {
    const ref = match[2]!;
    if (isAbsoluteUrl(ref) || ref.startsWith("/") || ref.startsWith("#") || ref.startsWith("data:")) continue;
    if (!out.includes(ref)) out.push(ref);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fingerprint for preview tokens
// ---------------------------------------------------------------------------

/**
 * posts has no updated_at, so a preview is bound to a hash of every field a
 * save can change. Fixed field order keeps it stable without key sorting.
 */
export function postContentFingerprint(post: PostRow): string {
  const fields = [
    post.title,
    post.slug,
    post.subject,
    post.preheader,
    post.description,
    post.body_markdown,
    post.hero_image,
    post.web_visibility,
  ];
  return createHash("sha256").update(JSON.stringify(fields)).digest("base64url");
}

// ---------------------------------------------------------------------------
// Edge functions
// ---------------------------------------------------------------------------

/** Body of upsert-post, field for field what `micropage posts push` sends. */
export interface UpsertPostPayload {
  project_id: number;
  title: string;
  slug: string;
  body_markdown: string;
  description: string | null;
  web_visibility: "listed" | "unlisted";
  hero_image: string | null;
  form_id: string | null;
  subject: string | null;
  preheader: string | null;
}

/**
 * The build a post change queued a site rebuild of: the live build, never a
 * page draft. null when nothing was rebuilt. Absent from servers older than
 * the live-build rebuild, which redeployed projects.active_build_id instead.
 */
export interface RebuildField {
  rebuild_build_id?: number | null;
}

export interface UpsertPostResponse extends RebuildField {
  post_id: string;
  action: "created" | "updated";
  published: boolean;
}

export async function upsertPost(http: Http, payload: UpsertPostPayload): Promise<UpsertPostResponse> {
  try {
    return await http.invoke<UpsertPostResponse>("upsert-post", payload);
  } catch (err) {
    if (err instanceof MicropageError && err.status === 409) {
      throw new MicropageError(
        "SLUG_CONFLICT",
        `The slug "${payload.slug}" is already used by another post in this project. Pass a different \`slug\`, ` +
          "or call list_posts to find the existing post and edit that one. Nothing was saved.",
        { status: 409, data: err.data, cause: err },
      );
    }
    throw err;
  }
}

export interface PublishPostResponse extends RebuildField {
  post_id: string;
  published_at: string;
  emailed: boolean;
  recipient_count: number;
}

export async function publishPost(http: Http, projectId: number, slug: string): Promise<PublishPostResponse> {
  try {
    return await http.invoke<PublishPostResponse>("publish-post", { project_id: projectId, slug });
  } catch (err) {
    if (err instanceof MicropageError && err.code === "PLAN_REQUIRED") {
      throw new MicropageError(
        "PLAN_REQUIRED",
        `micropage refused to send this post: ${err.message} Tell the user. No email went out and the site was not ` +
          "rebuilt, but the post may now be marked published; check with list_posts.",
        { ...(err.status === undefined ? {} : { status: err.status }), data: err.data, cause: err },
      );
    }
    if (err instanceof MicropageError && err.status === 402) {
      throw new MicropageError(
        "PLAN_LIMIT",
        `micropage refused to send this post: ${serverMessage(err) ?? "the plan does not allow it"}. ` +
          "Newsletter sends need a Pro plan and count against a monthly recipient limit; " +
          "tell the user (upgrade at https://micropage.sh/pricing). No email went out and the site was not rebuilt, " +
          "but the post may now be marked published; check with list_posts.",
        { status: 402, data: err.data, cause: err },
      );
    }
    if (err instanceof MicropageError && err.status === 404) throw postNotFound(slug);
    throw err;
  }
}

export interface UnpublishPostResponse extends RebuildField {
  post_id: string;
  unpublished: boolean;
}

export async function unpublishPost(http: Http, projectId: number, slug: string): Promise<UnpublishPostResponse> {
  try {
    return await http.invoke("unpublish-post", { project_id: projectId, slug });
  } catch (err) {
    if (err instanceof MicropageError && err.status === 404) throw postNotFound(slug);
    throw err;
  }
}

export interface DeletePostResponse extends RebuildField {
  deleted: boolean;
  slug: string | null;
}

export async function deletePost(http: Http, projectId: number, slug: string): Promise<DeletePostResponse> {
  return http.invoke("delete-post", { project_id: projectId, slug });
}

function serverMessage(err: MicropageError): string | null {
  const data = err.data as { error?: unknown; message?: unknown } | null | undefined;
  const msg = data?.error ?? data?.message;
  return typeof msg === "string" && msg ? msg : null;
}
