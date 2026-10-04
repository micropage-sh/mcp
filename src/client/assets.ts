import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFile, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { extname, isAbsolute } from "node:path";

import { VERSION } from "../version.js";
import { MicropageError, isMicropageError } from "./errors.js";
import type { FetchLike, Http } from "./http.js";

/** Same extensions and types as the CLI (cli/src/mime.js); upload-file stores whatever type it is sent. */
export const ASSET_MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
});

export const MAX_ASSET_BYTES = 10 * 1024 * 1024;
export const URL_FETCH_TIMEOUT_MS = 20_000;

const MB = 1024 * 1024;
const formatMb = (bytes: number): string => `${(bytes / MB).toFixed(bytes < 10 * MB ? 2 : 1)} MB`;

// ---------------------------------------------------------------------------
// Filename
// ---------------------------------------------------------------------------

/**
 * The stored filename is what `.page` markup references (`img: <- logo.png`),
 * so it must be a bare name with an extension the CLI would upload.
 */
export function validateAssetFilename(raw: string): string {
  const name = raw.trim();
  const allowed = Object.keys(ASSET_MIME_TYPES).join(", ");
  if (!name || name === "." || name === "..") {
    throw new MicropageError("INVALID_FILENAME", "filename is empty. Pass a bare name such as \"logo.png\".");
  }
  if (/[/\\]/.test(name)) {
    throw new MicropageError(
      "INVALID_FILENAME",
      `filename "${raw}" contains a path separator. Pass the bare name only (e.g. "logo.png"); the source goes in \`source\`.`,
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new MicropageError("INVALID_FILENAME", "filename contains control characters. Use a plain name such as \"logo.png\".");
  }
  if (name.length > 200) {
    throw new MicropageError("INVALID_FILENAME", "filename is longer than 200 characters. Use a shorter name.");
  }
  const ext = extname(name).toLowerCase();
  if (!ext || !(ext in ASSET_MIME_TYPES) || name.toLowerCase() === ext) {
    throw new MicropageError(
      "UNSUPPORTED_FILE_TYPE",
      `"${name}" is not a supported asset type. micropage assets must be images with one of these extensions: ${allowed}. ` +
        "Convert the file (e.g. to .png or .webp) and upload it under a matching name.",
    );
  }
  return name;
}

export function mimeTypeFor(filename: string): string {
  return ASSET_MIME_TYPES[extname(filename).toLowerCase()] ?? "application/octet-stream";
}

// ---------------------------------------------------------------------------
// Content check
//
// The bytes must actually be the image type the extension claims. Besides
// catching honest mistakes, this keeps a prompt-injected "upload ~/.ssh/id_rsa
// as key.png" from publishing a local secret to a public bucket.
// ---------------------------------------------------------------------------

const startsWith = (bytes: Uint8Array, sig: ReadonlyArray<number>, offset = 0): boolean =>
  bytes.length >= offset + sig.length && sig.every((b, i) => bytes[offset + i] === b);
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

function looksLike(ext: string, bytes: Uint8Array): boolean {
  switch (ext) {
    case ".png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case ".jpg":
    case ".jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case ".gif":
      return startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"));
    case ".webp":
      return startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8);
    case ".ico":
      return startsWith(bytes, [0x00, 0x00, 0x01, 0x00]);
    case ".svg":
      return hasSvgRoot(Buffer.from(bytes).toString("utf8"));
    default:
      return false;
  }
}

/**
 * True when the document's root element is <svg>. Only an optional BOM,
 * whitespace, one <?xml ...?> declaration, comments and a <!DOCTYPE svg ...>
 * (without an internal subset) may come before it. Looking for "<svg"
 * anywhere would pass an HTML page with an inline icon, or any file that
 * merely mentions <svg> in a comment.
 */
export function hasSvgRoot(text: string): boolean {
  let rest = text.replace(/^\uFEFF/, "");
  let sawDecl = false;
  let sawDoctype = false;
  for (;;) {
    rest = rest.trimStart();
    if (/^<\?xml[\s?]/.test(rest) && !sawDecl) {
      const end = rest.indexOf("?>");
      if (end < 0) return false;
      rest = rest.slice(end + 2);
      sawDecl = true;
    } else if (rest.startsWith("<!--")) {
      const end = rest.indexOf("-->", 4);
      if (end < 0) return false;
      rest = rest.slice(end + 3);
    } else if (/^<!DOCTYPE\s+svg[\s>]/.test(rest) && !sawDoctype) {
      const end = rest.indexOf(">");
      // An internal subset ([...]) can declare entities; no real SVG needs one.
      if (end < 0 || rest.slice(0, end).includes("[")) return false;
      rest = rest.slice(end + 1);
      sawDoctype = true;
    } else {
      return /^<svg[\s>/]/.test(rest);
    }
  }
}

export function assertContentMatchesExtension(filename: string, bytes: Uint8Array): void {
  if (bytes.length === 0) {
    throw new MicropageError("INVALID_ASSET", "The asset is empty (0 bytes). Nothing was uploaded.");
  }
  const ext = extname(filename).toLowerCase();
  if (!looksLike(ext, bytes)) {
    throw new MicropageError(
      "INVALID_ASSET",
      `The content is not a valid ${ext.slice(1).toUpperCase()} image, so it does not match "${filename}". ` +
        "Check the source, or rename the file to its real image type. Nothing was uploaded.",
    );
  }
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export type AssetSource = { path: string } | { url: string } | { base64: string };

export interface LoadSourceOptions {
  /** Used for `{url}` sources only; never sent micropage credentials. */
  fetch?: FetchLike;
  /** Resolves `{url}` hostnames before each fetch; defaults to urlHostLookup.current. */
  lookup?: HostLookup;
  maxBytes?: number;
  timeoutMs?: number;
}

function tooLarge(size: number | string, maxBytes: number): MicropageError {
  const shown = typeof size === "number" ? formatMb(size) : size;
  return new MicropageError(
    "ASSET_TOO_LARGE",
    `The asset is ${shown}; the limit is ${formatMb(maxBytes)}. Resize or recompress it (e.g. to WebP) and retry. Nothing was uploaded.`,
  );
}

export async function loadAssetSource(source: AssetSource, options: LoadSourceOptions = {}): Promise<Buffer> {
  const maxBytes = options.maxBytes ?? MAX_ASSET_BYTES;
  if ("path" in source) return loadPath(source.path, maxBytes);
  if ("url" in source) {
    return loadUrl(source.url, {
      maxBytes,
      timeoutMs: options.timeoutMs ?? URL_FETCH_TIMEOUT_MS,
      fetchImpl: options.fetch ?? ((i, init) => fetch(i, init)),
      lookup: options.lookup ?? urlHostLookup.current,
    });
  }
  return loadBase64(source.base64, maxBytes);
}

async function loadPath(path: string, maxBytes: number): Promise<Buffer> {
  if (!isAbsolute(path)) {
    throw new MicropageError(
      "INVALID_SOURCE",
      `source.path "${path}" is relative. Pass an absolute path; the server's working directory is not the user's.`,
    );
  }
  let info;
  try {
    info = await stat(path);
  } catch (err) {
    throw new MicropageError("INVALID_SOURCE", `Cannot read source.path "${path}": ${(err as NodeJS.ErrnoException).code ?? String(err)}.`, {
      cause: err,
    });
  }
  if (!info.isFile()) throw new MicropageError("INVALID_SOURCE", `source.path "${path}" is not a regular file.`);
  if (info.size > maxBytes) throw tooLarge(info.size, maxBytes);
  const bytes = await readFile(path);
  if (bytes.length > maxBytes) throw tooLarge(bytes.length, maxBytes);
  return bytes;
}

function loadBase64(raw: string, maxBytes: number): Buffer {
  // Accept a data: URL as well as bare base64, and ignore line wrapping.
  const body = raw.replace(/^data:[^,]*;base64,/i, "").replace(/\s+/g, "");
  if (!body || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(body)) {
    throw new MicropageError("INVALID_SOURCE", "source.base64 is not valid base64. Pass the file bytes base64-encoded (a data: URL is fine).");
  }
  // Checked before decoding so an oversized argument is never materialized twice.
  if (Math.floor((body.length * 3) / 4) > maxBytes + 2) throw tooLarge(Math.floor((body.length * 3) / 4), maxBytes);
  // Node's base64 decoder also accepts the URL-safe alphabet.
  const bytes = Buffer.from(body, "base64");
  if (bytes.length > maxBytes) throw tooLarge(bytes.length, maxBytes);
  return bytes;
}

// ---------------------------------------------------------------------------
// {url} sources: public https hosts only
//
// The server may run next to services that trust the local network (cloud
// metadata at 169.254.169.254, a router admin page, localhost dev servers),
// so a model-supplied URL must not reach them, directly or via a redirect.
// The check runs on every hop. fetch resolves the name again, so a DNS answer
// that changes in between is not caught; that needs a pinned-address agent.
// ---------------------------------------------------------------------------

export type HostLookup = (hostname: string) => Promise<ReadonlyArray<{ address: string; family: number }>>;

/** Swappable in tests so no real DNS query is made. */
export const urlHostLookup: { current: HostLookup } = {
  current: (hostname) => lookup(hostname, { all: true, verbatim: true }),
};

export const MAX_URL_REDIRECTS = 5;

function ipv4Bytes(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN));
  return bytes.every((b) => b >= 0 && b <= 255) ? bytes : null;
}

/** 16 bytes of an IPv6 address (zone id dropped), or null when it does not parse. */
function ipv6Bytes(raw: string): number[] | null {
  let ip = raw.split("%")[0]!;
  let tail: number[] = [];
  const lastColon = ip.lastIndexOf(":");
  if (ip.slice(lastColon + 1).includes(".")) {
    const v4 = ipv4Bytes(ip.slice(lastColon + 1));
    if (!v4) return null;
    tail = v4;
    ip = `${ip.slice(0, lastColon + 1)}0:0`;
  }
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const groups = (h: string): string[] => (h === "" ? [] : h.split(":"));
  const head = groups(halves[0]!);
  const back = halves.length === 2 ? groups(halves[1]!) : [];
  const fill = 8 - head.length - back.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...back];
  const bytes: number[] = [];
  for (const g of all) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push(n >> 8, n & 0xff);
  }
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}

function blockedV4([a, b]: number[]): boolean {
  return (
    a === 0 || // 0.0.0.0/8 "this network"
    a === 10 ||
    a === 127 ||
    (a === 100 && b! >= 64 && b! <= 127) || // CGNAT 100.64/10
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    a! >= 224 // multicast 224/4 and reserved 240/4, incl. broadcast
  );
}

/** True for loopback, private, link-local, CGNAT, ULA, multicast and unspecified addresses, in any notation. */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip.split("%")[0]!);
  if (family === 4) return blockedV4(ipv4Bytes(ip)!);
  if (family !== 6) return true;
  const b = ipv6Bytes(ip);
  if (!b) return true;
  const zeros = (n: number): boolean => b.slice(0, n).every((x) => x === 0);
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible, which also covers :: and ::1).
  if ((zeros(10) && b[10] === 0xff && b[11] === 0xff) || zeros(12)) return blockedV4(b.slice(12));
  return (
    (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) || // fe80::/10 link-local
    (b[0]! & 0xfe) === 0xfc || // fc00::/7 unique local
    b[0] === 0xff // ff00::/8 multicast
  );
}

async function assertPublicHost(url: URL, lookupHost: HostLookup, redirected: boolean): Promise<void> {
  if (url.protocol !== "https:") {
    throw new MicropageError(
      "INVALID_SOURCE",
      redirected
        ? `source.url redirected to a non-https URL (${url.toString()}). Nothing was uploaded.`
        : `source.url must use https:// (got ${url.protocol}//). Nothing was fetched.`,
    );
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const refuse = (address: string): MicropageError =>
    new MicropageError(
      "INVALID_SOURCE",
      `source.url host ${url.hostname} is a private, local or reserved address (${address}). Only public https hosts are ` +
        "fetched; upload a local file with source.path or source.base64 instead. Nothing was fetched.",
    );
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw refuse(host);
    return;
  }
  let addresses: ReadonlyArray<{ address: string }>;
  try {
    addresses = await lookupHost(host);
  } catch (err) {
    throw new MicropageError("NETWORK", `Could not resolve ${host}: ${err instanceof Error ? err.message : String(err)}. Check the URL.`, {
      cause: err,
    });
  }
  if (addresses.length === 0) throw new MicropageError("NETWORK", `${host} has no addresses. Check the URL.`);
  const bad = addresses.find((a) => isPrivateAddress(a.address));
  if (bad) throw refuse(bad.address);
}

interface LoadUrlOptions {
  maxBytes: number;
  timeoutMs: number;
  fetchImpl: FetchLike;
  lookup: HostLookup;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

async function loadUrl(raw: string, { maxBytes, timeoutMs, fetchImpl, lookup: lookupHost }: LoadUrlOptions): Promise<Buffer> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MicropageError("INVALID_SOURCE", `source.url "${raw}" is not a valid URL.`);
  }

  const signal = AbortSignal.timeout(timeoutMs);
  let res: Response;
  for (let hop = 0; ; hop++) {
    await assertPublicHost(url, lookupHost, hop > 0);
    try {
      res = await fetchImpl(url.toString(), {
        method: "GET",
        // Followed by hand so every hop gets the host check.
        redirect: "manual",
        signal,
        headers: { "User-Agent": `micropage-mcp/${VERSION}`, Accept: "image/*" },
      });
    } catch (err) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new MicropageError("TIMEOUT", `Fetching ${url.host} timed out after ${Math.round(timeoutMs / 1000)}s.`, { cause: err });
      }
      throw new MicropageError("NETWORK", `Fetching ${url.toString()} failed: ${err instanceof Error ? err.message : String(err)}.`, {
        cause: err,
      });
    }
    if (!REDIRECT_STATUSES.has(res.status)) break;
    await res.body?.cancel().catch(() => undefined);
    const location = res.headers.get("location");
    if (!location) {
      throw new MicropageError("HTTP", `Fetching ${url.toString()} returned a redirect (HTTP ${res.status}) without a Location.`, {
        status: res.status,
      });
    }
    if (hop >= MAX_URL_REDIRECTS) {
      throw new MicropageError("INVALID_SOURCE", `source.url redirected more than ${MAX_URL_REDIRECTS} times. Pass the final image URL.`);
    }
    try {
      url = new URL(location, url);
    } catch {
      throw new MicropageError("INVALID_SOURCE", `source.url redirected to an invalid URL (${location}). Nothing was uploaded.`);
    }
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new MicropageError("HTTP", `Fetching ${url.toString()} failed (HTTP ${res.status}). Check the URL is a public, direct image link.`, {
      status: res.status,
    });
  }
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw tooLarge(declared, maxBytes);
  }

  // Content-Length can be absent or wrong, so the cap is enforced while reading.
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body?.getReader();
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw tooLarge(`over ${formatMb(maxBytes)}`, maxBytes);
        }
        chunks.push(value);
      }
    } catch (err) {
      if (isMicropageError(err)) throw err;
      throw new MicropageError("NETWORK", `Reading ${url.toString()} failed: ${err instanceof Error ? err.message : String(err)}.`, {
        cause: err,
      });
    }
  }
  return Buffer.concat(chunks);
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------------------
// Edge functions: list-files, get-file-url, delete-file, upload-file
// ---------------------------------------------------------------------------

export interface UserFile {
  id: string;
  filename: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  content_hash: string | null;
  created_at: string | null;
}

export interface FileListing {
  files: UserFile[];
  total_bytes: number;
  /** Plan storage limit (upload-file's spaceMbForPlan). */
  space_available_mb: number;
}

export async function listFiles(http: Http, projectId: number): Promise<FileListing> {
  const data = await http.invokeGet<{ files?: UserFile[]; total_bytes?: number; space_available_mb?: number } | null>("list-files", {
    project_id: String(projectId),
  });
  const files = Array.isArray(data?.files) ? data.files : [];
  return {
    files,
    total_bytes: typeof data?.total_bytes === "number" ? data.total_bytes : files.reduce((s, f) => s + (f.size_bytes ?? 0), 0),
    // The CLI shows 100 MB when the field is missing.
    space_available_mb: typeof data?.space_available_mb === "number" ? data.space_available_mb : 100,
  };
}

export async function getFileUrl(http: Http, fileId: string): Promise<string> {
  const data = await http.invokeGet<{ url?: string } | null>("get-file-url", { file_id: fileId });
  if (!data?.url) throw new MicropageError("HTTP", "get-file-url returned no URL for this file. Retry, or check the file in the editor.");
  return data.url;
}

export async function deleteFile(http: Http, fileId: string): Promise<void> {
  await http.invoke("delete-file", { file_id: fileId });
}

/** Multipart body exactly as the CLI's uploadAssetWithToken builds it. */
export function buildUploadForm(projectId: number, filename: string, bytes: Uint8Array, contentHash: string): FormData {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: mimeTypeFor(filename) }), filename);
  form.append("project_id", String(projectId));
  form.append("content_hash", contentHash);
  return form;
}

export async function uploadFile(
  http: Http,
  projectId: number,
  filename: string,
  bytes: Uint8Array,
  contentHash: string,
): Promise<UserFile> {
  try {
    const data = await http.request<{ file?: UserFile } | null>("POST", http.functionUrl("upload-file"), {
      rawBody: buildUploadForm(projectId, filename, bytes, contentHash),
    });
    if (!data?.file?.id) throw new MicropageError("HTTP", "upload-file returned no file record. Call list_files to check whether it landed.");
    return data.file;
  } catch (err) {
    if (isMicropageError(err) && err.status === 413) throw quotaError(err.data, bytes.length);
    throw err;
  }
}

function quotaError(data: unknown, fileSize: number): MicropageError {
  const d = (data && typeof data === "object" ? data : {}) as { current_usage?: number; max_bytes?: number; file_size?: number };
  const used = typeof d.current_usage === "number" ? formatMb(d.current_usage) : "unknown";
  const limit = typeof d.max_bytes === "number" ? formatMb(d.max_bytes) : "the plan limit";
  return quotaMessage(used, limit, formatMb(typeof d.file_size === "number" ? d.file_size : fileSize), data);
}

function quotaMessage(used: string, limit: string, size: string, data?: unknown): MicropageError {
  return new MicropageError(
    "QUOTA_EXCEEDED",
    `Storage quota exceeded: this project uses ${used} of its ${limit} plan limit and the file is ${size}. ` +
      "Tell the user to delete unused files in the micropage editor or upgrade at https://micropage.sh/pricing, or upload a smaller file.",
    { status: 413, data },
  );
}

export interface UploadAssetResult {
  file: UserFile;
  url: string;
  /** Same name and same SHA-256 already stored: nothing was uploaded. */
  deduped: boolean;
  /** A file with this name but different (or unknown) content was deleted and replaced. */
  replaced: boolean;
  content_hash: string;
}

/**
 * The CLI's per-file dedupe (uploadAssetsWithToken): one list-files call;
 * same name + same content_hash is skipped; a changed or NULL hash (rows from
 * before hashing) is deleted and re-uploaded with content_hash. A list-files
 * failure is fatal, as in the CLI, since uploading blind would leave
 * duplicate rows under one name.
 */
export async function uploadAsset(http: Http, projectId: number, filename: string, bytes: Uint8Array): Promise<UploadAssetResult> {
  const hash = sha256Hex(bytes);
  const listing = await listFiles(http, projectId);
  // Map semantics match the CLI: with duplicate names, the last row wins.
  const byName = new Map(listing.files.map((f) => [f.filename, f]));
  const existing = byName.get(filename);

  if (existing && existing.content_hash === hash) {
    return { file: existing, url: await getFileUrl(http, existing.id), deduped: true, replaced: false, content_hash: hash };
  }

  // Checked before the delete: upload-file enforces the quota only after the
  // old row is gone, so failing there would lose the old file for nothing.
  const limitBytes = listing.space_available_mb * MB;
  const usedAfterDelete = listing.total_bytes - (existing?.size_bytes ?? 0);
  if (usedAfterDelete + bytes.length > limitBytes) {
    throw quotaMessage(formatMb(listing.total_bytes), `${listing.space_available_mb} MB`, formatMb(bytes.length));
  }

  if (existing) await deleteFile(http, existing.id);
  let file: UserFile;
  try {
    file = await uploadFile(http, projectId, filename, bytes, hash);
  } catch (err) {
    if (existing && isMicropageError(err)) {
      throw new MicropageError(
        err.code,
        `${err.message} The previous "${filename}" had already been deleted, so the project has no file by that name now; retry upload_asset.`,
        { ...(err.status === undefined ? {} : { status: err.status }), data: err.data, cause: err },
      );
    }
    throw err;
  }
  return { file, url: await getFileUrl(http, file.id), deduped: false, replaced: Boolean(existing), content_hash: hash };
}
