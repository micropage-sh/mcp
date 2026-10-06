import type { CallToolResult, InputRequiredResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import * as z from "zod";

import { DESTRUCTIVE, OUT, RO, hints } from "../annotations.js";
import { MicropageError } from "../client/errors.js";
import {
  countActiveSubscribers,
  deletePost,
  formNamesById,
  getPostBySlug,
  listPosts,
  postContentFingerprint,
  postNotFound,
  postWillEmail,
  publishPost,
  resolveHeroUrl,
  resolveListFormId,
  slugify,
  unhostedBodyImages,
  unpublishPost,
  upsertPost,
  type PostListRow,
  type PostRow,
  type RebuildField,
  type UpsertPostPayload,
} from "../client/posts.js";
import { getMaxProjectDeployEventId } from "../client/deploy-events.js";
import { ProjectRef, resolveProject, type Project } from "../client/project-ref.js";
import type { ToolContext } from "../context.js";
import { DEFAULT_TOKEN_TTL_MS, elicitConfirmation, requireConfirm, requireConfirmationToken, type TokenPayload } from "../guards.js";
import { gateTool, structuredResult } from "./shared.js";

const SlugInput = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe('The post\'s slug, as list_posts shows it (e.g. "launching-new-dashboard"). Normalised like the CLI does.');

function normaliseSlug(raw: string): string {
  const slug = slugify(raw);
  if (!slug) {
    throw new MicropageError("INVALID_SLUG", `"${raw}" has no letters or digits, so it is not a valid slug. Call list_posts to see slugs.`);
  }
  return slug;
}

const ProjectBrief = z.object({
  id: z.number(),
  uuid: z.string(),
  live_url: z.string().nullable(),
});

function projectBrief(p: Project): z.infer<typeof ProjectBrief> {
  return { id: p.id, uuid: p.uuid, live_url: p.live_url };
}

/** Cursor for get_deploy_status, taken before a call that may queue a site rebuild; null when unreadable. */
async function projectCursor(ctx: ToolContext, project: Project): Promise<number | null> {
  return getMaxProjectDeployEventId(ctx.http, project.id).catch(() => null);
}

interface RebuildOutcome {
  rebuild_queued: boolean;
  build_id: number | null;
  after_event_id: number | null;
}

/**
 * Reads the server's rebuild_build_id (the live build it queued a rebuild of).
 * An older server leaves it out and rebuilds projects.active_build_id when
 * `legacyRebuilds`, so that is what is reported then.
 */
function rebuildOutcome(res: RebuildField, project: Project, legacyRebuilds: boolean, cursor: number | null): RebuildOutcome {
  const buildId =
    res.rebuild_build_id !== undefined
      ? typeof res.rebuild_build_id === "number"
        ? res.rebuild_build_id
        : null
      : legacyRebuilds
        ? project.active_build_id
        : null;
  return { rebuild_queued: buildId !== null, build_id: buildId, after_event_id: buildId !== null ? cursor : null };
}

const BuildIdOutput = z
  .number()
  .nullable()
  .describe("The build the site rebuild redeploys: the live one, not an unpublished page draft. Pass to get_deploy_status; null when nothing was rebuilt.");
const AfterEventIdOutput = z
  .number()
  .nullable()
  .describe("Pass to get_deploy_status with build_id to see only events from this rebuild.");

function followNote(o: RebuildOutcome): string {
  return o.after_event_id === null
    ? "The deploy cursor could not be read, so check the site or get_project in a few minutes instead of get_deploy_status."
    : `Follow it with get_deploy_status (build "id:${o.build_id}", after_event_id ${o.after_event_id}): it reports ` +
        "waiting_for_start until the rebuild begins and done only once the rebuild's own deploy event arrives.";
}

// ---------------------------------------------------------------------------
// list_posts
// ---------------------------------------------------------------------------

export const ListPostsInput = z
  .object({
    project: ProjectRef,
    slug: SlugInput.optional().describe(
      "Omit to list every post. Pass a slug to get that one post in full, including body_markdown and every field upsert_post takes.",
    ),
  })
  .strict();

const PostSummary = z.object({
  id: z.string(),
  slug: z.string().nullable(),
  title: z.string().nullable(),
  visibility: z.string().nullable().describe("listed (in the /content index), unlisted (own page only) or none (email only)."),
  published: z.boolean().describe("False means draft: not on the site and never emailed."),
  published_at: z.string().nullable(),
  email: z.boolean().describe("True when publishing emails the post to `list` (email enabled and a list set)."),
  list: z.string().nullable().describe("Newsletter form name the post is sent to."),
  send_status: z
    .string()
    .nullable()
    .describe("Email send lifecycle (queued, sending, sent, failed); null for web-only posts, where it means nothing."),
  recipient_count: z.number().nullable().describe("Recipients of the last send."),
  created_at: z.string().nullable(),
});
type PostSummary = z.infer<typeof PostSummary>;

const PostDetail = PostSummary.extend({
  description: z.string().nullable(),
  body_markdown: z.string(),
  hero: z.string().nullable().describe("Hero image URL."),
  subject: z.string().nullable().describe("Email subject (defaults to the title)."),
  preview: z.string().nullable().describe("Email preheader / inbox preview text."),
  sent_count: z.number().nullable(),
});
type PostDetail = z.infer<typeof PostDetail>;

export const ListPostsOutput = z.object({
  project: ProjectBrief,
  count: z.number().optional().describe("Number of posts (list mode)."),
  posts: z.array(PostSummary).optional().describe("Every post, newest first (list mode)."),
  post: PostDetail.optional().describe("The one post asked for (slug mode)."),
});
export type ListPostsResult = z.infer<typeof ListPostsOutput>;

function toSummary(row: PostListRow, lists: Map<string, string | null>): PostSummary {
  const email = postWillEmail(row);
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    visibility: row.web_visibility,
    published: row.published_at !== null,
    published_at: row.published_at,
    email,
    list: row.form_id ? (lists.get(row.form_id) ?? null) : null,
    send_status: email ? row.status : null,
    recipient_count: row.recipient_count,
    created_at: row.created_at,
  };
}

export async function runListPosts(ctx: ToolContext, args: z.infer<typeof ListPostsInput>): Promise<ListPostsResult> {
  await gateTool(ctx, "list_posts");
  const project = await resolveProject(ctx, args.project);

  if (args.slug === undefined) {
    const rows = await listPosts(ctx.http, project.id);
    const lists = await formNamesById(
      ctx.http,
      rows.map((r) => r.form_id).filter((id): id is string => !!id),
    );
    const posts = rows.map((r) => toSummary(r, lists));
    return { project: projectBrief(project), count: posts.length, posts };
  }

  const slug = normaliseSlug(args.slug);
  const row = await getPostBySlug(ctx.http, project.id, slug);
  if (!row) throw postNotFound(slug);
  const lists = await formNamesById(ctx.http, row.form_id ? [row.form_id] : []);
  const post: PostDetail = {
    ...toSummary(row, lists),
    description: row.description,
    body_markdown: row.body_markdown ?? "",
    hero: row.hero_image,
    subject: row.subject,
    preview: row.preheader,
    sent_count: row.sent_count,
  };
  return { project: projectBrief(project), post };
}

// ---------------------------------------------------------------------------
// upsert_post
// ---------------------------------------------------------------------------

export const UpsertPostInput = z
  .object({
    project: ProjectRef,
    title: z.string().trim().min(1).max(500).describe("Post title. Required."),
    slug: z
      .string()
      .trim()
      .max(200)
      .optional()
      .describe(
        "URL slug, unique per project; the post lives at /content/<slug>. Defaults to the slugified title. " +
          "The slug picks which post is updated: an existing slug updates that post, a new one creates a post.",
      ),
    body_markdown: z
      .string()
      .min(1)
      .max(500_000)
      .describe(
        "Post body in Markdown. Images must already be hosted URLs: upload each image with upload_asset, get its URL " +
          "with get_file_url, and write ![alt](https://...). Local paths are not uploaded here and would 404.",
      ),
    description: z
      .string()
      .max(2000)
      .optional()
      .describe("Web summary for the /content archive, meta description and og tags. Omitted clears it."),
    visibility: z
      .enum(["listed", "unlisted"])
      .optional()
      .describe("listed (default): shown in the site's /content index. unlisted: has a page but is not listed."),
    hero: z
      .string()
      .trim()
      .max(2000)
      .optional()
      .describe(
        "Hero image: an https URL, or the filename of an asset already uploaded to this project (call upload_asset first " +
          "for a new image). Omitted clears it.",
      ),
    email: z
      .boolean()
      .optional()
      .describe(
        "true makes the post an email to `list` when it is published (saving never sends). Default false: web only.",
      ),
    list: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe("Newsletter form name to send to (case-insensitive exact match). Required with email: true; only allowed with it."),
    subject: z.string().max(500).optional().describe("Email subject. Defaults to the title."),
    preview: z.string().max(500).optional().describe("Email preheader / inbox preview text."),
    confirm_live_update: z
      .boolean()
      .optional()
      .describe(
        "Required (true) when the post is already published: saving then changes the live page at once and rebuilds the site. " +
          "Ask the user before setting it.",
      ),
  })
  .strict();

export const UpsertPostOutput = z.object({
  project: ProjectBrief,
  post_id: z.string(),
  slug: z.string(),
  action: z.enum(["created", "updated"]),
  published: z.boolean().describe("True when the post was already live, so this save changed the live page."),
  rebuild_queued: z.boolean().describe("True when the save queued a site rebuild (only for published posts)."),
  build_id: BuildIdOutput,
  after_event_id: AfterEventIdOutput,
  email: z.boolean(),
  list: z.string().nullable(),
  hero: z.string().nullable(),
  warnings: z.array(z.string()),
});
export type UpsertPostResult = z.infer<typeof UpsertPostOutput>;

export async function runUpsertPost(ctx: ToolContext, args: z.infer<typeof UpsertPostInput>): Promise<UpsertPostResult> {
  await gateTool(ctx, "upsert_post");

  const email = args.email === true;
  if (email && !args.list) {
    throw new MicropageError("INVALID_ARGS", "email: true needs `list` (a newsletter form name; list_forms shows them). Nothing was saved.");
  }
  if (!email && args.list) {
    throw new MicropageError(
      "INVALID_ARGS",
      "`list` is only used with email: true. Pass email: true to make this post an email to that list, or drop `list`. Nothing was saved.",
    );
  }
  const slug = args.slug ? normaliseSlug(args.slug) : slugify(args.title) || "post";

  const project = await resolveProject(ctx, args.project);
  const existing = await getPostBySlug(ctx.http, project.id, slug);
  if (existing?.published_at && args.confirm_live_update !== true) {
    throw new MicropageError(
      "CONFIRM_REQUIRED",
      `The post "${slug}" is published (since ${existing.published_at}), so saving changes the live page immediately and ` +
        "rebuilds the site. Ask the user to approve the live update, then call upsert_post again with confirm_live_update: true. " +
        "Nothing was saved.",
    );
  }

  const formId = email ? await resolveListFormId(ctx.http, project.id, args.list!) : null;
  const heroUrl = await resolveHeroUrl(ctx.http, project.id, args.hero);

  const payload: UpsertPostPayload = {
    project_id: project.id,
    title: args.title,
    slug,
    body_markdown: args.body_markdown,
    description: args.description || null,
    web_visibility: args.visibility ?? "listed",
    hero_image: heroUrl,
    form_id: formId,
    subject: args.subject || null,
    preheader: args.preview || null,
  };
  const cursor = existing?.published_at ? await projectCursor(ctx, project) : null;
  const res = await upsertPost(ctx.http, payload);
  // An older upsert-post rebuilds active_build_id for every published save; a
  // newer one reports the live build it rebuilt.
  const rebuild = rebuildOutcome(res, project, res.published, cursor);

  const warnings: string[] = [];
  const unhosted = unhostedBodyImages(args.body_markdown);
  if (unhosted.length > 0) {
    warnings.push(
      `${unhosted.length} body image(s) are not hosted URLs and will 404 on the page: ${unhosted.join(", ")}. ` +
        "Upload them with upload_asset, swap in the URLs from get_file_url and save again.",
    );
  }
  if (!res.published) warnings.push("Saved as a draft: not on the site and not emailed. preview_post_send then publish_post makes it live.");

  return {
    project: projectBrief(project),
    post_id: res.post_id,
    slug,
    action: res.action,
    published: res.published,
    rebuild_queued: res.rebuild_build_id !== undefined ? rebuild.rebuild_queued : res.published,
    build_id: rebuild.build_id,
    after_event_id: rebuild.after_event_id,
    email,
    list: email ? args.list!.trim() : null,
    hero: heroUrl,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// preview_post_send / publish_post shared state
// ---------------------------------------------------------------------------

interface SendFacts {
  willEmail: boolean;
  alreadyPublished: boolean;
  tokenPayload: TokenPayload;
}

function sendFacts(project: Project, post: PostRow): SendFacts {
  const willEmail = postWillEmail(post);
  const alreadyPublished = post.published_at !== null;
  return {
    willEmail,
    alreadyPublished,
    tokenPayload: {
      purpose: "publish_post",
      project_id: project.id,
      post_id: post.id,
      content: postContentFingerprint(post),
      email_enabled: post.email_enabled === true,
      form_id: post.form_id,
      already_published: alreadyPublished,
    },
  };
}

const RESEND_WARNING =
  "This post is already published, so publishing again RE-SENDS the email to everyone on the list and resets its click-through stats.";

async function loadPost(ctx: ToolContext, project: Project, rawSlug: string): Promise<PostRow> {
  const slug = normaliseSlug(rawSlug);
  const post = await getPostBySlug(ctx.http, project.id, slug);
  if (!post) throw postNotFound(slug);
  return post;
}

// ---------------------------------------------------------------------------
// preview_post_send
// ---------------------------------------------------------------------------

export const PreviewPostSendInput = z.object({ project: ProjectRef, slug: SlugInput }).strict();

export const PreviewPostSendOutput = z.object({
  project: ProjectBrief,
  post: z.object({
    id: z.string(),
    slug: z.string().nullable(),
    title: z.string().nullable(),
    subject: z.string().nullable(),
    preview: z.string().nullable(),
    visibility: z.string().nullable(),
  }),
  will_email: z.boolean().describe("True when publishing emails the list (email enabled and a list set)."),
  list: z.string().nullable(),
  recipient_count: z.number().nullable().describe("Active subscribers on the list right now; 0 when nothing is emailed."),
  already_published: z.boolean(),
  resend_warning: z.string().nullable(),
  send_allowed: z.boolean().describe("MICROPAGE_MCP_ALLOW_SEND is set, so this server may email subscribers."),
  publish_allowed: z.boolean().describe("Whether publish_post will go ahead for this post on this server."),
  blocked_reason: z.string().nullable(),
  confirmation_token: z.string().describe("Pass to publish_post. Invalid once the post changes, or after expires_in_seconds."),
  expires_in_seconds: z.number(),
});
export type PreviewPostSendResult = z.infer<typeof PreviewPostSendOutput>;

export async function runPreviewPostSend(ctx: ToolContext, args: z.infer<typeof PreviewPostSendInput>): Promise<PreviewPostSendResult> {
  await gateTool(ctx, "preview_post_send");
  const project = await resolveProject(ctx, args.project);
  const post = await loadPost(ctx, project, args.slug);
  const facts = sendFacts(project, post);

  const [lists, recipients] = await Promise.all([
    formNamesById(ctx.http, post.form_id ? [post.form_id] : []),
    facts.willEmail ? countActiveSubscribers(ctx.http, post.form_id!) : Promise.resolve(0),
  ]);

  const sub = await ctx.tier.currentUserId();
  const blocked = facts.willEmail && !ctx.permissions.allowSend;
  return {
    project: projectBrief(project),
    post: {
      id: post.id,
      slug: post.slug,
      title: post.title,
      subject: post.subject,
      preview: post.preheader,
      visibility: post.web_visibility,
    },
    will_email: facts.willEmail,
    list: post.form_id ? (lists.get(post.form_id) ?? null) : null,
    recipient_count: recipients,
    already_published: facts.alreadyPublished,
    resend_warning: facts.willEmail && facts.alreadyPublished ? RESEND_WARNING : null,
    send_allowed: ctx.permissions.allowSend,
    publish_allowed: !blocked,
    blocked_reason: blocked ? ctx.hints.sendDisabled : null,
    confirmation_token: ctx.confirmationTokens.mint(sub, facts.tokenPayload),
    expires_in_seconds: Math.round(DEFAULT_TOKEN_TTL_MS / 1000),
  };
}

// ---------------------------------------------------------------------------
// publish_post
// ---------------------------------------------------------------------------

export const PublishPostInput = z
  .object({
    project: ProjectRef,
    slug: SlugInput,
    confirmation_token: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe("The confirmation_token from preview_post_send for this post, taken after its last change and shown to the user."),
  })
  .strict();

export const PublishPostOutput = z.object({
  project: ProjectBrief,
  post_id: z.string(),
  slug: z.string(),
  published_at: z.string(),
  emailed: z.boolean(),
  recipient_count: z.number().nullable(),
  rebuild_queued: z.boolean().describe("True when a site rebuild was queued so the post appears under /content."),
  build_id: BuildIdOutput,
  after_event_id: AfterEventIdOutput,
  note: z.string(),
});
export type PublishPostResult = z.infer<typeof PublishPostOutput>;

export type PublishPostOutcome = { kind: "done"; result: PublishPostResult } | { kind: "input"; result: InputRequiredResult };

export async function runPublishPost(
  ctx: ToolContext,
  args: z.infer<typeof PublishPostInput>,
  handlerCtx?: ServerContext,
): Promise<PublishPostOutcome> {
  await gateTool(ctx, "publish_post");
  const project = await resolveProject(ctx, args.project);
  const post = await loadPost(ctx, project, args.slug);
  const facts = sendFacts(project, post);

  if (facts.willEmail && !ctx.permissions.allowSend) {
    throw new MicropageError("SEND_DISABLED", `"${post.slug}" is set to email its list when published. ${ctx.hints.sendDisabled} Nothing was changed.`);
  }
  const sub = await ctx.tier.currentUserId();
  requireConfirmationToken(ctx.confirmationTokens, args.confirmation_token, sub, facts.tokenPayload, "preview_post_send");

  if (facts.willEmail && handlerCtx) {
    const [lists, recipients] = await Promise.all([
      formNamesById(ctx.http, [post.form_id!]),
      countActiveSubscribers(ctx.http, post.form_id!),
    ]);
    const listName = lists.get(post.form_id!) ?? "newsletter";
    const outcome = elicitConfirmation(handlerCtx, ctx.clientCapabilities(handlerCtx), {
      key: "confirm_post_send",
      message:
        `Publish "${post.title ?? post.slug}" and email it to ${recipients} subscriber(s) on the "${listName}" list?` +
        (facts.alreadyPublished ? " It was already published, so this RE-SENDS it." : ""),
    });
    if (outcome.status === "pending") return { kind: "input", result: outcome.result };
    if (outcome.status === "declined") {
      throw new MicropageError("DECLINED", "The user declined sending this post. Nothing was published or emailed.");
    }
  }

  const cursor = post.web_visibility !== "none" ? await projectCursor(ctx, project) : null;
  const res = await publishPost(ctx.http, project.id, post.slug!, ctx.hints);
  const rebuild = rebuildOutcome(res, project, post.web_visibility !== "none" && project.active_build_id !== null, cursor);
  const notes = [
    res.emailed ? `Emailed to ${res.recipient_count} recipient(s); sending runs in the background.` : "Published on the web only; no email.",
    rebuild.rebuild_queued
      ? "A site rebuild of the live build was queued; the post appears under /content once it deploys. It starts after up to " +
        `about 3 minutes in the queue unless the account is Pro+, then takes 1-2 minutes. ${followNote(rebuild)}`
      : post.web_visibility === "none"
        ? "The post has visibility none, so no web page changes."
        : "The project has no published build yet, so the post is not on a site until the page is published with publish_build.",
  ];
  return {
    kind: "done",
    result: {
      project: projectBrief(project),
      post_id: res.post_id,
      slug: post.slug!,
      published_at: res.published_at,
      emailed: res.emailed,
      recipient_count: typeof res.recipient_count === "number" ? res.recipient_count : null,
      rebuild_queued: rebuild.rebuild_queued,
      build_id: rebuild.build_id,
      after_event_id: rebuild.after_event_id,
      note: notes.join(" "),
    },
  };
}

// ---------------------------------------------------------------------------
// unpublish_post / delete_post
// ---------------------------------------------------------------------------

const ConfirmInput = z
  .boolean()
  .optional()
  .describe("Must be true. Ask the user first: this changes the live site.");

export const UnpublishPostInput = z
  .object({ project: ProjectRef, slug: SlugInput, confirm: ConfirmInput })
  .strict();

export const UnpublishPostOutput = z.object({
  project: ProjectBrief,
  post_id: z.string().nullable(),
  slug: z.string(),
  unpublished: z.boolean(),
  rebuild_queued: z.boolean().describe("True when a site rebuild of the live build was queued to take the post down."),
  build_id: BuildIdOutput,
  after_event_id: AfterEventIdOutput,
});
export type UnpublishPostResult = z.infer<typeof UnpublishPostOutput>;

export async function runUnpublishPost(ctx: ToolContext, args: z.infer<typeof UnpublishPostInput>): Promise<UnpublishPostResult> {
  const slug = normaliseSlug(args.slug);
  requireConfirm(args, `Unpublishing the post "${slug}"`);
  await gateTool(ctx, "unpublish_post");
  const project = await resolveProject(ctx, args.project);
  const cursor = await projectCursor(ctx, project);
  const res = await unpublishPost(ctx.http, project.id, slug);
  const rebuild = rebuildOutcome(res, project, res.unpublished === true && project.active_build_id !== null, cursor);
  return {
    project: projectBrief(project),
    post_id: res.post_id ?? null,
    slug,
    unpublished: res.unpublished === true,
    ...rebuild,
  };
}

export const DeletePostInput = z
  .object({
    project: ProjectRef,
    slug: SlugInput,
    confirm: ConfirmInput.describe("Must be true. Ask the user first: the post is deleted for good and leaves the live site."),
  })
  .strict();

export const DeletePostOutput = z.object({
  project: ProjectBrief,
  slug: z.string(),
  deleted: z.boolean().describe("False when no post had that slug (nothing to delete)."),
  rebuild_queued: z.boolean().describe("True when a site rebuild of the live build was queued to take the post down."),
  build_id: BuildIdOutput,
  after_event_id: AfterEventIdOutput,
});
export type DeletePostResult = z.infer<typeof DeletePostOutput>;

export async function runDeletePost(ctx: ToolContext, args: z.infer<typeof DeletePostInput>): Promise<DeletePostResult> {
  const slug = normaliseSlug(args.slug);
  requireConfirm(args, `Deleting the post "${slug}"`);
  await gateTool(ctx, "delete_post");
  const project = await resolveProject(ctx, args.project);
  const cursor = await projectCursor(ctx, project);
  const res = await deletePost(ctx.http, project.id, slug);
  const rebuild = rebuildOutcome(res, project, res.deleted === true && project.active_build_id !== null, cursor);
  return {
    project: projectBrief(project),
    slug,
    deleted: res.deleted === true,
    ...rebuild,
  };
}

// ---------------------------------------------------------------------------

const REBUILD_NOTE =
  "The site rebuild redeploys the live build, so an unpublished page draft left by save_page or the editor stays a draft. " +
  "It returns build_id and after_event_id to follow the rebuild with get_deploy_status.";

export function registerPostTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "list_posts",
    {
      title: "List or read micropage posts",
      description: `List a project's posts (blog posts and newsletter emails), or read one in full.

Without \`slug\`: every post, newest first, with slug, title, visibility, whether it is published and when, whether publishing emails it, and the newsletter list name. With \`slug\`: that post in full, including body_markdown and every field under the same names upsert_post takes (title, description, visibility, hero, email, list, subject, preview).

Call it with a slug before editing a post: upsert_post replaces every field, so start from the current values. It does not say who will receive an email; preview_post_send does that. Read-only.`,
      inputSchema: ListPostsInput,
      outputSchema: ListPostsOutput,
      annotations: RO,
    },
    async (args) => {
      const result = await runListPosts(ctx, args);
      const summary = result.post
        ? `Post "${result.post.slug}" (${result.post.published ? "published" : "draft"}).`
        : `${result.count ?? 0} post(s).`;
      return structuredResult(result, summary);
    },
  );

  server.registerTool(
    "upsert_post",
    {
      title: "Create or update a micropage post",
      description: `Create or update one post (a blog post under /content and/or a newsletter email), keyed by slug: an existing slug is updated, a new one is created as a draft. Same as \`micropage posts push\` for one file; the arguments are the post front-matter fields plus body_markdown (see the micropage://posts/format resource).

Every call replaces the whole post: an omitted optional field (description, hero, subject, preview, email/list) is cleared. To edit, read the post with list_posts(slug) first and pass everything back.

Saving never sends email and never publishes a draft. But if the post is already published, the save changes the live page at once and rebuilds the site, so it needs confirm_live_update: true after the user agrees. ${REBUILD_NOTE}

Images are not uploaded here. For the hero pass an https URL or the filename of an asset uploaded with upload_asset; inside body_markdown use hosted URLs only (upload_asset, then get_file_url). To publish afterwards use preview_post_send, then publish_post.`,
      inputSchema: UpsertPostInput,
      outputSchema: UpsertPostOutput,
      annotations: DESTRUCTIVE,
    },
    async (args) => {
      const result = await runUpsertPost(ctx, args);
      const state = result.published ? "live page updated, site rebuild queued" : "draft";
      return structuredResult(result, `Post "${result.slug}" ${result.action} (${state}).`);
    },
  );

  server.registerTool(
    "preview_post_send",
    {
      title: "Preview publishing a post",
      description: `Show what publish_post would do for one post, and get the confirmation_token publish_post requires. Call it before every publish and show the user the result.

Reports whether publishing emails the newsletter list, the list name, the number of active subscribers it would go to, whether the post is already published (publishing again re-sends the email to the whole list), and whether this server is allowed to send email (${ctx.hints.sendSwitchName}).

The token is tied to the post as it is now: any edit to the post (upsert_post) or to its list invalidates it, and it expires after 15 minutes or when the server restarts. Read-only: nothing is published or sent.`,
      inputSchema: PreviewPostSendInput,
      outputSchema: PreviewPostSendOutput.extend({ send_allowed: z.boolean().describe(ctx.hints.sendAllowedField) }),
      annotations: RO,
    },
    async (args) => {
      const result = await runPreviewPostSend(ctx, args);
      const what = result.will_email
        ? `Publishing emails ${result.recipient_count ?? "?"} subscriber(s) on "${result.list ?? "?"}"${result.already_published ? " AGAIN (re-send)" : ""}.`
        : "Publishing puts the post on the web only; no email.";
      return structuredResult(result, result.publish_allowed ? what : `${what} Blocked: ${result.blocked_reason}`);
    },
  );

  server.registerTool(
    "publish_post",
    {
      title: "Publish a micropage post (may send email)",
      description: `Publish a post: put it live on the site under /content and, if it has email enabled with a list, email it to every active subscriber on that list. Re-publishing an already-published post re-sends the email to the whole list. Same as \`micropage posts publish <slug>\`.

Needs the confirmation_token from preview_post_send, taken after the post's last change; show the user that preview and get their go-ahead first. A stale or missing token is refused with nothing changed.

Posts that would send email are refused unless ${ctx.hints.sendEnabledBy}; there is no web-only override, so to publish such a post on the web only, save it with email: false first. When the client supports it the user is also asked to confirm the send directly. ${REBUILD_NOTE} Use unpublish_post to take a post down.`,
      inputSchema: PublishPostInput,
      outputSchema: PublishPostOutput,
      annotations: OUT,
    },
    async (args, handlerCtx): Promise<CallToolResult | InputRequiredResult> => {
      const outcome = await runPublishPost(ctx, args, handlerCtx);
      if (outcome.kind === "input") return outcome.result;
      const r = outcome.result;
      return structuredResult(r, `Published "${r.slug}"${r.emailed ? `, emailed ${r.recipient_count ?? "?"} recipient(s)` : ""}.`);
    },
  );

  server.registerTool(
    "unpublish_post",
    {
      title: "Unpublish a micropage post",
      description: `Take a published post off the site: its page 404s and it goes back to draft. The post itself is kept and can be published again later; emails already sent are not recalled. Same as \`micropage posts unpublish <slug>\`.

Needs confirm: true, which you should only pass after the user has agreed. Queues a site rebuild when the project has been published. ${REBUILD_NOTE} To remove a post for good use delete_post instead.`,
      inputSchema: UnpublishPostInput,
      outputSchema: UnpublishPostOutput,
      annotations: OUT,
    },
    async (args) => {
      const result = await runUnpublishPost(ctx, args);
      return structuredResult(result, `Unpublished "${result.slug}"; it is a draft now.`);
    },
  );

  server.registerTool(
    "delete_post",
    {
      title: "Delete a micropage post",
      description: `Delete a post for good, removing it from the site if it was published. There is no undo; to only take it off the site use unpublish_post. Same as \`micropage posts rm <slug>\`.

Needs confirm: true, which you should only pass after the user has agreed. Deleting a slug that does not exist is not an error (deleted: false). Queues a site rebuild when a post was removed and the project has been published. ${REBUILD_NOTE}`,
      inputSchema: DeletePostInput,
      outputSchema: DeletePostOutput,
      annotations: hints(OUT, { idempotentHint: true }),
    },
    async (args) => {
      const result = await runDeletePost(ctx, args);
      return structuredResult(result, result.deleted ? `Deleted "${result.slug}".` : `No post "${result.slug}"; nothing deleted.`);
    },
  );
}
