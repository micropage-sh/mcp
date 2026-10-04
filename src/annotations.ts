import type { ToolAnnotations } from "@modelcontextprotocol/server";

/**
 * Annotation presets. Every preset sets all four hints explicitly: the spec
 * defaults an absent destructiveHint to true and an absent openWorldHint to
 * true, so leaving one out silently changes how hosts prompt.
 */
export type ToolHints = Required<
  Pick<ToolAnnotations, "readOnlyHint" | "destructiveHint" | "idempotentHint" | "openWorldHint">
>;

/** Reads micropage state; never changes anything. */
export const RO: Readonly<ToolHints> = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
});

/** Writes drafts or files nobody outside the account sees yet. */
export const WRITE: Readonly<ToolHints> = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
});

/** Overwrites or removes existing state (including a live post's content). */
export const DESTRUCTIVE: Readonly<ToolHints> = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
});

/**
 * Outward-facing: changes what the public sees or sends email. Same wire
 * hints as DESTRUCTIVE, kept as its own preset so code and tests can tell
 * the tools that also require a server-checked confirmation apart.
 */
export const OUT: Readonly<ToolHints> = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
});

export function hints(base: Readonly<ToolHints>, overrides: Partial<ToolHints> = {}): ToolHints {
  return { ...base, ...overrides };
}
