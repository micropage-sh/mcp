import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";

import { RO, WRITE, hints } from "../annotations.js";
import {
  ASSET_MIME_TYPES,
  MAX_ASSET_BYTES,
  assertContentMatchesExtension,
  getFileUrl,
  listFiles,
  loadAssetSource,
  mimeTypeFor,
  uploadAsset,
  validateAssetFilename,
  type AssetSource,
} from "../client/assets.js";
import { MicropageError } from "../client/errors.js";
import { ProjectRef, resolveProject } from "../client/project-ref.js";
import type { ToolContext } from "../context.js";
import { gateTool, structuredResult } from "./shared.js";

const EXTENSIONS = Object.keys(ASSET_MIME_TYPES).join(", ");
const maxMb = (maxBytes: number): number => maxBytes / (1024 * 1024);

const AssetFilename = z
  .string()
  .min(1)
  .max(200)
  .describe(
    `Name to store the asset under, e.g. "hero.webp". A bare name (no folders) with one of: ${EXTENSIONS}. ` +
      "This is the name .page markup references, as in `img: <- hero.webp`.",
  );

// ---------------------------------------------------------------------------
// upload_asset
// ---------------------------------------------------------------------------

const PathSource = z
  .object({
    path: z
      .string()
      .min(1)
      .max(4096)
      .describe("Absolute path to an image file on the machine running this server (local stdio installs only)."),
  })
  .strict();

const UrlSource = z
  .object({
    url: z
      .string()
      .min(1)
      .max(4096)
      .describe("A public https:// URL of the image. Fetched once, without micropage credentials, with a 20 s timeout."),
  })
  .strict();

const base64Source = (maxBytes: number) =>
  z
    .object({
      base64: z
        .string()
        .min(1)
        // 4/3 chars per byte, rounded up to a whole million (14 M for 10 MB); the decoded size is checked exactly later.
        .max(Math.ceil((maxBytes * 4) / 3 / 1_000_000) * 1_000_000)
        .describe("The image bytes, base64-encoded. A data: URL (data:image/png;base64,...) also works."),
    })
    .strict();

const sourceRules = (maxBytes: number): string =>
  `Max ${maxMb(maxBytes)} MB. The content must really be the image type the filename's extension says.`;

/** With {path}: a server that can read the user's files. */
const assetSourceInput = (maxBytes: number) =>
  z
    .union([PathSource, UrlSource, base64Source(maxBytes)])
    .describe(`Where the bytes come from: exactly one of {path}, {url} or {base64}. ${sourceRules(maxBytes)}`);

/** Without {path}: a hosted server, so the schema never offers what it cannot do. */
const remoteAssetSourceInput = (maxBytes: number) =>
  z.union([UrlSource, base64Source(maxBytes)]).describe(`Where the bytes come from: exactly one of {url} or {base64}. ${sourceRules(maxBytes)}`);

export const AssetSourceInput = assetSourceInput(MAX_ASSET_BYTES);
export const RemoteAssetSourceInput = remoteAssetSourceInput(MAX_ASSET_BYTES);

const uploadAssetInput = <S extends typeof AssetSourceInput | typeof RemoteAssetSourceInput>(source: S) =>
  z.object({ project: ProjectRef, filename: AssetFilename, source }).strict();

export const UploadAssetInput = uploadAssetInput(AssetSourceInput);
export const RemoteUploadAssetInput = uploadAssetInput(RemoteAssetSourceInput);

const UploadAssetOutput = z.object({
  filename: z.string().describe("Stored name. Reference it in .page markup as `img: <- <filename>`."),
  markup: z.string().describe("Ready-to-use markup line, e.g. `img: <- hero.webp`."),
  url: z.string().describe("Where the stored file is served from."),
  deduped: z.boolean().describe("True when an identical file was already stored under this name; nothing was uploaded."),
  replaced: z
    .boolean()
    .describe("True when a different file with this name was deleted and replaced. A live page keeps the old reference until republished."),
  file_id: z.string(),
  size_bytes: z.number(),
  mime_type: z.string(),
  content_hash: z.string().describe("SHA-256 of the bytes, used for dedupe."),
});
export type UploadAssetResult = z.infer<typeof UploadAssetOutput>;

export async function runUploadAsset(ctx: ToolContext, args: z.infer<typeof UploadAssetInput>): Promise<UploadAssetResult> {
  await gateTool(ctx, "upload_asset");
  // Validated before any network call or file read.
  const filename = validateAssetFilename(args.filename);
  const project = await resolveProject(ctx, args.project);
  const { pathLoader, lookupHost, deniedHosts, fetchExternal, maxBytes } = ctx.uploads;
  const bytes = await loadAssetSource(args.source as AssetSource, {
    lookup: lookupHost,
    maxBytes: maxBytes ?? MAX_ASSET_BYTES,
    ...(pathLoader ? { pathLoader } : {}),
    ...(deniedHosts ? { deniedHosts } : {}),
    ...(fetchExternal ? { fetch: fetchExternal } : {}),
  });
  assertContentMatchesExtension(filename, bytes);

  const result = await uploadAsset(ctx.http, project.id, filename, bytes, ctx.hints);
  return {
    filename: result.file.filename ?? filename,
    markup: `img: <- ${result.file.filename ?? filename}`,
    url: result.url,
    deduped: result.deduped,
    replaced: result.replaced,
    file_id: result.file.id,
    size_bytes: result.file.size_bytes ?? bytes.length,
    mime_type: result.file.mime_type ?? mimeTypeFor(filename),
    content_hash: result.content_hash,
  };
}

// ---------------------------------------------------------------------------
// list_files
// ---------------------------------------------------------------------------

export const ListFilesInput = z.object({ project: ProjectRef }).strict();

const FileEntry = z.object({
  id: z.string(),
  filename: z.string().nullable(),
  mime_type: z.string().nullable(),
  size_bytes: z.number().nullable(),
  content_hash: z.string().nullable(),
  created_at: z.string().nullable(),
});

const ListFilesOutput = z.object({
  files: z.array(FileEntry).describe("Newest first."),
  count: z.number(),
  used_bytes: z.number(),
  limit_mb: z.number().describe("The plan's storage limit for this project."),
  limit_bytes: z.number(),
});
export type ListFilesResult = z.infer<typeof ListFilesOutput>;

export async function runListFiles(ctx: ToolContext, args: z.infer<typeof ListFilesInput>): Promise<ListFilesResult> {
  await gateTool(ctx, "list_files");
  const project = await resolveProject(ctx, args.project);
  const listing = await listFiles(ctx.http, project.id);
  return {
    files: listing.files.map((f) => ({
      id: f.id,
      filename: f.filename ?? null,
      mime_type: f.mime_type ?? null,
      size_bytes: f.size_bytes ?? null,
      content_hash: f.content_hash ?? null,
      created_at: f.created_at ?? null,
    })),
    count: listing.files.length,
    used_bytes: listing.total_bytes,
    limit_mb: listing.space_available_mb,
    limit_bytes: listing.space_available_mb * 1024 * 1024,
  };
}

// ---------------------------------------------------------------------------
// get_file_url
// ---------------------------------------------------------------------------

export const GetFileUrlInput = z
  .object({
    project: ProjectRef,
    filename: z.string().trim().min(1).max(200).describe('Stored filename exactly as list_files reports it, e.g. "hero.webp".'),
  })
  .strict();

const GetFileUrlOutput = z.object({
  filename: z.string(),
  file_id: z.string(),
  url: z.string(),
});
export type GetFileUrlResult = z.infer<typeof GetFileUrlOutput>;

export async function runGetFileUrl(ctx: ToolContext, args: z.infer<typeof GetFileUrlInput>): Promise<GetFileUrlResult> {
  await gateTool(ctx, "get_file_url");
  const project = await resolveProject(ctx, args.project);
  const listing = await listFiles(ctx.http, project.id);
  const file = listing.files.find((f) => f.filename === args.filename);
  if (!file) {
    const names = listing.files.map((f) => f.filename).filter((n): n is string => Boolean(n));
    const shown = names.slice(0, 20).join(", ");
    throw new MicropageError(
      "NOT_FOUND",
      `No file named "${args.filename}" in this project. ` +
        (names.length ? `Stored files: ${shown}${names.length > 20 ? ", ..." : ""}.` : "The project has no files yet; use upload_asset."),
    );
  }
  return { filename: args.filename, file_id: file.id, url: await getFileUrl(ctx.http, file.id) };
}

// ---------------------------------------------------------------------------

export function registerFileTools(server: McpServer, ctx: ToolContext): void {
  const local = ctx.uploads.pathLoader !== undefined;
  const sources = local ? "from a local file path, a public https URL, or base64 bytes" : "from a public https URL or base64 bytes";
  const maxBytes = ctx.uploads.maxBytes ?? MAX_ASSET_BYTES;
  const sourceNote = ctx.hints.uploadSourceNote ? ` ${ctx.hints.uploadSourceNote}` : "";
  const uploadConfig = {
    title: "Upload an image asset",
    description: `Upload one image (${EXTENSIONS}; max ${maxMb(maxBytes)} MB) to a micropage project's file storage, ${sources}.${sourceNote} Returns the stored filename, the markup to reference it (\`img: <- hero.webp\`) and its URL.

Use it BEFORE save_page or upsert_post reference the image: page markup like \`img: <- hero.webp\` and a post's \`hero: hero.webp\` only resolve to files already stored in the project, and a missing name renders no image. Upload each asset once; calling again with identical content is a no-op (deduped: true, same SHA-256 as the CLI uses).

Uploading different content under an existing name deletes the old file and stores the new one. A page that is already live keeps pointing at the old file until it is saved and published again, so re-run save_page and publish_build after replacing an image on a live site. Prefer a new filename to avoid that.

Do not use it for non-image files (unsupported), for images already hosted elsewhere that markup can reference by full https URL, or to look up existing files (use list_files). Fails with the plan's storage limit when the project is full.`,
    outputSchema: UploadAssetOutput,
    annotations: hints(WRITE, { idempotentHint: true, destructiveHint: true }),
  };
  const uploadHandler = async (args: z.infer<typeof UploadAssetInput>) => {
    const result = await runUploadAsset(ctx, args);
    const what = result.deduped ? "Already stored (identical content)" : result.replaced ? "Replaced" : "Uploaded";
    return structuredResult(result, `${what}: ${result.filename}. Reference it as \`${result.markup}\`.`);
  };
  // Two calls rather than a conditional schema so each keeps its inferred argument type.
  if (local) {
    server.registerTool("upload_asset", { ...uploadConfig, inputSchema: uploadAssetInput(assetSourceInput(maxBytes)) }, uploadHandler);
  } else {
    server.registerTool("upload_asset", { ...uploadConfig, inputSchema: uploadAssetInput(remoteAssetSourceInput(maxBytes)) }, uploadHandler);
  }

  server.registerTool(
    "list_files",
    {
      title: "List a project's files",
      description: `List the files stored in a micropage project (images uploaded by upload_asset, the editor or the CLI), newest first: filename, type, size, SHA-256 and upload date, plus storage used and the plan's storage limit.

Use it to see which filenames .page markup can reference with \`img: <- name\`, to check whether an image is already uploaded, or to check remaining storage before uploading large images.

It does not return file URLs (use get_file_url for one) or upload anything (use upload_asset). Read-only.`,
      inputSchema: ListFilesInput,
      outputSchema: ListFilesOutput,
      annotations: RO,
    },
    async (args) => {
      const result = await runListFiles(ctx, args);
      const usedMb = (result.used_bytes / (1024 * 1024)).toFixed(2);
      return structuredResult(result, `${result.count} file(s); ${usedMb} MB of ${result.limit_mb} MB used.`);
    },
  );

  server.registerTool(
    "get_file_url",
    {
      title: "Get a stored file's URL",
      description: `Get the URL a stored project file is served from, by its filename (as list_files reports it).

Use it when the user wants a link to an uploaded image, or a full URL is needed somewhere a bare filename does not work (for example a post's hero image or an external page). Inside .page markup, prefer the bare filename (\`img: <- hero.webp\`), which survives re-uploads.

It does not upload or list files (use upload_asset / list_files). Read-only.`,
      inputSchema: GetFileUrlInput,
      outputSchema: GetFileUrlOutput,
      annotations: RO,
    },
    async (args) => {
      const result = await runGetFileUrl(ctx, args);
      return structuredResult(result, result.url);
    },
  );
}
