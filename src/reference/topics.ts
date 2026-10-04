import type { CacheHint } from "@modelcontextprotocol/server";

import { AGENT_GUIDE, EXAMPLES, GRAMMAR, GRAMMAR_FULL, POSTS_FORMAT } from "../content/index.js";

/** A day. The reference changes when the docs ship, not per request. */
export const REFERENCE_TTL_MS = 86_400_000;

export const REFERENCE_CACHE_HINT: Readonly<CacheHint> = Object.freeze({
  ttlMs: REFERENCE_TTL_MS,
  cacheScope: "public",
});

export const EXAMPLE_NAMES: readonly string[] = Object.freeze(Object.keys(EXAMPLES).sort());

export const EXAMPLE_URI_PREFIX = "micropage://examples/";

export const exampleUri = (name: string): string => `${EXAMPLE_URI_PREFIX}${name}`;

/** "Title: description" from an example's [site] block, for listings. */
export function exampleSummary(name: string): string {
  const body = EXAMPLES[name] ?? "";
  const title = /^title:\s*(.+)$/m.exec(body)?.[1]?.trim();
  const description = /^description:\s*(.+)$/m.exec(body)?.[1]?.trim();
  return [title, description].filter(Boolean).join(": ") || name;
}

export function examplesIndex(): string {
  return [
    "# Micropage .page examples",
    "",
    "Complete, valid `.page` files. Copy their patterns rather than inventing markup. Read one with",
    "`get_markup_reference` (topic `example`, example `<name>`) or the resource `micropage://examples/<name>`.",
    "",
    ...EXAMPLE_NAMES.map((name) => `- \`${name}\` — ${exampleSummary(name)}`),
    "",
  ].join("\n");
}

/** Lists the valid names, so a wrong guess can be corrected in one step. */
export function unknownExampleMessage(name: string): string {
  return `Unknown example "${name}". Valid names: ${EXAMPLE_NAMES.join(", ")}.`;
}

export const DOC_TOPICS = ["grammar", "grammar_full", "posts_format", "agent_guide", "examples_index"] as const;
export type DocTopic = (typeof DOC_TOPICS)[number];

export interface DocResource {
  topic: DocTopic;
  name: string;
  uri: string;
  title: string;
  description: string;
  mimeType: string;
  text: () => string;
}

/**
 * One table drives both the resources and get_markup_reference, so the tool
 * can never serve something the resources don't (or vice versa).
 */
export const DOCS: readonly DocResource[] = Object.freeze([
  {
    topic: "grammar",
    name: "grammar",
    uri: "micropage://grammar",
    title: "Micropage .page grammar",
    description:
      "The short, canonical .page grammar (docs.micropage.sh/llms.txt): file shape, the closed set of section and element tags, and the rules for agents. Read before writing or editing markup.",
    mimeType: "text/markdown",
    text: () => GRAMMAR,
  },
  {
    topic: "grammar_full",
    name: "grammar-full",
    uri: "micropage://grammar/full",
    title: "Micropage .page grammar (full)",
    description:
      "The complete .page reference (docs.micropage.sh/llms-full.txt): every site key, element, form option and modifier with examples. Use when the short grammar does not answer the question.",
    mimeType: "text/markdown",
    text: () => GRAMMAR_FULL,
  },
  {
    topic: "posts_format",
    name: "posts-format",
    uri: "micropage://posts/format",
    title: "Posts format",
    description:
      "How a post is shaped (title, slug, description, visibility, hero, email list, subject, preview, Markdown body) and its lifecycle: draft, publish, live edits, unpublish, re-send on re-publish.",
    mimeType: "text/markdown",
    text: () => POSTS_FORMAT,
  },
  {
    topic: "agent_guide",
    name: "agent-guide",
    uri: "micropage://agent-guide",
    title: "Agent guide",
    description:
      "How to edit a micropage project safely: project layout, the closed tag vocabulary in brief, and the editing rules (edit in place, no invented tags, no inline colors, no markdown fences).",
    mimeType: "text/markdown",
    text: () => AGENT_GUIDE,
  },
  {
    topic: "examples_index",
    name: "examples",
    uri: "micropage://examples",
    title: "Example index",
    description:
      "The bundled example .page files by name with a one-line summary each (SaaS launch, portfolio, restaurant, conference, docs, blog, component references). Pick one to copy patterns from.",
    mimeType: "text/markdown",
    text: examplesIndex,
  },
]);

export function docFor(topic: DocTopic): DocResource {
  const doc = DOCS.find((d) => d.topic === topic);
  if (!doc) throw new Error(`no reference document for topic ${topic}`);
  return doc;
}
