import type { MicropageConfig } from "./config.js";
import { MicropageError } from "./errors.js";
import type { Http } from "./http.js";

/** The CLI's primary file: always merged first. */
export const PRIMARY_PAGE = "landing.page";

/** Total merged source cap. Real sites are a few KB; this only stops runaway input. */
export const MAX_SOURCE_BYTES = 1_000_000;

/** llms.txt cap; the CLI has none, but it is read from disk rather than a tool argument. */
export const MAX_LLMS_TXT_BYTES = 200_000;

export interface PageFile {
  name: string;
  content: string;
}

const PAGE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.page$/;

/**
 * Merges inline page files exactly like the CLI's readPageFilesFromDir
 * (cli/src/parser.js): landing.page first (trimmed, kept even when empty),
 * then every other file sorted by name, trimmed, empty ones skipped, joined
 * by one blank line. Validates names and size before anything is sent.
 */
export function concatPages(pages: readonly PageFile[]): string {
  if (pages.length === 0) {
    throw new MicropageError("INVALID_PAGES", "Pass at least one page, e.g. pages: [{ name: \"landing.page\", content: \"...\" }].");
  }
  const seen = new Set<string>();
  for (const p of pages) {
    if (!PAGE_NAME_RE.test(p.name)) {
      throw new MicropageError(
        "INVALID_PAGES",
        `Page name "${p.name}" is not valid. Use a plain file name ending in .page (letters, digits, ".", "_", "-"), ` +
          `e.g. "landing.page" or "about.page". Nothing was saved.`,
      );
    }
    if (seen.has(p.name)) {
      throw new MicropageError("INVALID_PAGES", `Page name "${p.name}" appears twice. Each name must be unique. Nothing was saved.`);
    }
    seen.add(p.name);
  }

  const primary = pages.find((p) => p.name === PRIMARY_PAGE);
  const others = pages
    .filter((p) => p.name !== PRIMARY_PAGE)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const parts: string[] = [];
  if (primary) parts.push(primary.content.trim());
  for (const p of others) {
    const content = p.content.trim();
    if (content) parts.push(content);
  }
  const text = parts.join("\n\n");

  if (!text.trim()) {
    throw new MicropageError("INVALID_PAGES", "Every page is empty. Write the .page markup into `content`. Nothing was saved.");
  }
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_SOURCE_BYTES) {
    throw new MicropageError(
      "INVALID_PAGES",
      `The merged source is ${bytes} bytes; the limit is ${MAX_SOURCE_BYTES}. Shorten the pages. Nothing was saved.`,
    );
  }
  return text;
}

/** llms.txt as the CLI stores it: verbatim minus one trailing newline; blank means none. */
export function normalizeLlmsTxt(value: string): string | null {
  if (!value.trim()) return null;
  const out = value.replace(/\n$/, "");
  const bytes = Buffer.byteLength(out, "utf8");
  if (bytes > MAX_LLMS_TXT_BYTES) {
    throw new MicropageError(
      "INVALID_PAGES",
      `llms_txt is ${bytes} bytes; the limit is ${MAX_LLMS_TXT_BYTES}. Shorten it. Nothing was saved.`,
    );
  }
  return out;
}

export type BuildJson = Record<string, unknown> & { site?: Record<string, unknown>; pages?: unknown[] };

export interface ParseRequest {
  text: string;
  projectId: number;
  /** The build the result will be stored on, when known (it is stamped into each page). */
  buildId: number | null;
}

/**
 * POST {buildCompilerUrl}/parse with the user's bearer, same body as the CLI.
 * Not read-only: the compiler registers the source's forms on the project.
 */
export async function parsePageSource(
  http: Http,
  config: Pick<MicropageConfig, "buildCompilerUrl">,
  req: ParseRequest,
): Promise<BuildJson> {
  const url = `${config.buildCompilerUrl.replace(/\/+$/, "")}/parse`;
  let json: unknown;
  try {
    json = await http.request("POST", url, {
      body: { text: req.text, project_id: req.projectId, build_id: req.buildId, version: "2" },
    });
  } catch (err) {
    if (err instanceof MicropageError && err.code === "HTTP") {
      if (err.status === 403) {
        throw new MicropageError(
          "PARSE_FORBIDDEN",
          "The build compiler refused this project for the signed-in account (it does not own it). Nothing was saved.",
          { status: 403, data: err.data, cause: err },
        );
      }
      throw new MicropageError(
        "PARSE_FAILED",
        `The build compiler could not parse the source: ${err.message}. Check the markup against get_markup_reference. Nothing was saved.`,
        { ...(err.status === undefined ? {} : { status: err.status }), data: err.data, cause: err },
      );
    }
    throw err;
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new MicropageError("PARSE_FAILED", "The build compiler returned an unexpected response. Retry shortly. Nothing was saved.");
  }
  return json as BuildJson;
}

/** Same placement as the CLI's push: json_content.site.llms_txt. */
export function injectLlmsTxt(json: BuildJson, llmsTxt: string | null): BuildJson {
  if (llmsTxt === null) return json;
  const site = json.site && typeof json.site === "object" ? json.site : {};
  return { ...json, site: { ...site, llms_txt: llmsTxt } };
}

export const MAX_PARSE_ISSUES = 50;

/**
 * The compiler has no separate warnings list: an element it could not
 * resolve (a missing file, a failed image search) carries an `error` string
 * in place. Collects those, plus a site with no pages, so the model can fix
 * them before publishing.
 */
export function collectParseIssues(json: BuildJson): string[] {
  const issues: string[] = [];
  const pages = Array.isArray(json.pages) ? json.pages : [];
  if (pages.length === 0) {
    issues.push("No pages were produced. Add a page block such as `[Home -> /]` followed by `/// hero` or `/// section`.");
  }
  const walk = (node: unknown, depth: number): void => {
    if (issues.length >= MAX_PARSE_ISSUES || depth > 40 || !node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (typeof obj.error === "string" && obj.error) issues.push(obj.error);
    for (const [key, value] of Object.entries(obj)) {
      if (key !== "error") walk(value, depth + 1);
    }
  };
  walk(json, 0);
  return [...new Set(issues)].slice(0, MAX_PARSE_ISSUES);
}

export function countPages(json: BuildJson): number {
  return Array.isArray(json.pages) ? json.pages.length : 0;
}
