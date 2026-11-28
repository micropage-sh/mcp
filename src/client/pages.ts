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

/** Where one file's trimmed content sits in the merged source. */
export interface PageMapEntry {
  name: string;
  /** 1-based merged line of the file's first kept line. */
  startLine: number;
  /** Lines of the trimmed content ("\n" count + 1). */
  lineCount: number;
  /** Lines dropped from the top of the file by the trim. */
  leadingLines: number;
}

export interface PageSourceMap {
  files: PageMapEntry[];
}

const countNewlines = (s: string): number => {
  let n = 0;
  for (let i = s.indexOf("\n"); i !== -1; i = s.indexOf("\n", i + 1)) n++;
  return n;
};

/**
 * Merges inline page files exactly like the CLI's readPageFilesFromDir
 * (cli/src/parser.js): landing.page first (trimmed, kept even when empty),
 * then every other file sorted by name, trimmed, empty ones skipped, joined
 * by one blank line. Validates names and size before anything is sent.
 */
export function concatPages(pages: readonly PageFile[]): string {
  return concatPagesWithMap(pages).text;
}

/** concatPages plus the map from merged source lines back to file lines. */
export function concatPagesWithMap(pages: readonly PageFile[]): { text: string; map: PageSourceMap } {
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
  const files: PageMapEntry[] = [];
  let nextLine = 1;
  const keep = (p: PageFile, content: string): void => {
    const lineCount = countNewlines(content) + 1;
    const leading = content ? p.content.slice(0, p.content.length - p.content.trimStart().length) : "";
    files.push({ name: p.name, startLine: nextLine, lineCount, leadingLines: countNewlines(leading) });
    parts.push(content);
    // The "\n\n" join leaves one blank separator line between files.
    nextLine += lineCount + 1;
  };
  if (primary) keep(primary, primary.content.trim());
  for (const p of others) {
    const content = p.content.trim();
    if (content) keep(p, content);
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
  return { text, map: { files } };
}

/** The file and 1-based file line behind a merged source line; null for a separator line or past the end. */
export function mapLine(map: PageSourceMap, line: number): { file: string; line: number } | null {
  for (const f of map.files) {
    if (line >= f.startLine && line < f.startLine + f.lineCount) {
      return { file: f.name, line: line - f.startLine + 1 + f.leadingLines };
    }
  }
  return null;
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

export type DiagnosticSeverity = "error" | "warning" | "hint";

/** One entry of the compiler's `diagnostics`, as sent: lines count in the merged source. */
export interface RawDiagnostic {
  line?: number;
  column?: number;
  severity: string;
  code: string;
  message: string;
  fix?: { line: number; replace: string };
}

export interface ParseResult {
  /** The build JSON without the `diagnostics` key, ready for json_content. */
  json: BuildJson;
  /** null when the compiler sent no `diagnostics` array (an older compiler). */
  diagnostics: RawDiagnostic[] | null;
}

/**
 * POST {buildCompilerUrl}/parse with the user's bearer, same body as the CLI.
 * Not read-only: the compiler registers the source's forms on the project.
 */
export async function parsePageSource(
  http: Http,
  config: Pick<MicropageConfig, "buildCompilerUrl">,
  req: ParseRequest,
): Promise<ParseResult> {
  const url = `${config.buildCompilerUrl.replace(/\/+$/, "")}/parse`;
  let json: unknown;
  try {
    json = await http.request("POST", url, {
      body: { text: req.text, project_id: req.projectId, build_id: req.buildId, version: "2", diagnostics: true },
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
  const { diagnostics, ...rest } = json as BuildJson;
  return { json: rest, diagnostics: Array.isArray(diagnostics) ? (diagnostics as RawDiagnostic[]) : null };
}

/**
 * POST {buildCompilerUrl}/check with the user's bearer. Read-only on the
 * server: no build, no form registration, no remote image fetch. Returns the
 * raw diagnostics array; anything else in the response is ignored.
 */
export async function checkPageSource(
  http: Http,
  config: Pick<MicropageConfig, "buildCompilerUrl">,
  req: { text: string; projectId: number },
): Promise<unknown[]> {
  const url = `${config.buildCompilerUrl.replace(/\/+$/, "")}/check`;
  let json: unknown;
  try {
    json = await http.request("POST", url, { body: { text: req.text, project_id: req.projectId } });
  } catch (err) {
    if (err instanceof MicropageError && err.code === "HTTP") {
      if (err.status === 404) {
        throw new MicropageError(
          "CHECK_UNAVAILABLE",
          "The build compiler does not support checking yet. save_page also returns diagnostics; use it instead. Nothing was saved.",
          { status: 404, data: err.data, cause: err },
        );
      }
      if (err.status === 403) {
        throw new MicropageError(
          "PARSE_FORBIDDEN",
          "The build compiler refused this project for the signed-in account (it does not own it). Nothing was saved.",
          { status: 403, data: err.data, cause: err },
        );
      }
      throw new MicropageError(
        "CHECK_FAILED",
        `The build compiler could not check the source: ${err.message}. Nothing was saved.`,
        { ...(err.status === undefined ? {} : { status: err.status }), data: err.data, cause: err },
      );
    }
    throw err;
  }
  const diagnostics =
    json && typeof json === "object" && !Array.isArray(json) ? (json as { diagnostics?: unknown }).diagnostics : undefined;
  if (!Array.isArray(diagnostics)) {
    throw new MicropageError("CHECK_FAILED", "The build compiler returned an unexpected response. Retry shortly. Nothing was saved.");
  }
  return diagnostics;
}

/** The compiler caps at 50 plus one "more not shown" summary. */
export const MAX_DIAGNOSTICS = 51;

export interface MappedDiagnostic {
  /** The .page file the line is in; omitted when the line is outside every file (then `line` counts in the merged source). */
  file?: string;
  line?: number;
  column?: number;
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  fix?: { file: string; line: number; replace: string };
}

const isLine = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1;
const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, max) : s);

/**
 * Translates merged-source lines to file lines and drops anything malformed,
 * so a compiler bug can never break save_page. Unknown severities read as hints.
 */
export function mapDiagnostics(raw: readonly unknown[], map: PageSourceMap): MappedDiagnostic[] {
  const out: MappedDiagnostic[] = [];
  for (const entry of raw) {
    if (out.length >= MAX_DIAGNOSTICS) break;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const d = entry as Record<string, unknown>;
    if (typeof d.code !== "string" || typeof d.message !== "string") continue;
    const mapped: MappedDiagnostic = {} as MappedDiagnostic;
    if (isLine(d.line)) {
      const at = mapLine(map, d.line);
      if (at) mapped.file = at.file;
      mapped.line = at ? at.line : d.line;
      if (isLine(d.column)) mapped.column = d.column;
    }
    mapped.severity = d.severity === "error" || d.severity === "warning" ? d.severity : "hint";
    mapped.code = clip(d.code, 100);
    mapped.message = clip(d.message, 300);
    const fix = d.fix;
    if (fix && typeof fix === "object" && !Array.isArray(fix)) {
      const f = fix as Record<string, unknown>;
      if (isLine(f.line) && typeof f.replace === "string" && f.replace.length <= 500 && !f.replace.includes("\n")) {
        const at = mapLine(map, f.line);
        // A fix that maps to no file line could be applied to the wrong file; drop it.
        if (at) mapped.fix = { file: at.file, line: at.line, replace: f.replace };
      }
    }
    out.push(mapped);
  }
  return out;
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
