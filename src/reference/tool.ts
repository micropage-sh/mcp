import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";

import { RO, hints } from "../annotations.js";
import { EXAMPLES } from "../content/index.js";
import { DOC_TOPICS, EXAMPLE_NAMES, docFor, unknownExampleMessage } from "./topics.js";

export const TOPICS = [...DOC_TOPICS, "example"] as const;

export const GetMarkupReferenceInput = z
  .object({
    topic: z
      .enum(TOPICS)
      .optional()
      .describe(
        "What to return. grammar: the short .page grammar (start here). grammar_full: the complete reference. " +
          "posts_format: post fields and lifecycle. agent_guide: editing rules. examples_index: example names. " +
          "example: one example file (set `example`). Defaults to grammar, or to example when `example` is set.",
      ),
    example: z
      .string()
      .optional()
      .describe(`Example name, used with topic "example". One of: ${EXAMPLE_NAMES.join(", ")}.`),
  })
  .strict();

export type GetMarkupReferenceArgs = z.infer<typeof GetMarkupReferenceInput>;

const text = (t: string, isError = false): CallToolResult => ({
  content: [{ type: "text", text: t }],
  ...(isError ? { isError: true } : {}),
});

export function runGetMarkupReference(args: GetMarkupReferenceArgs): CallToolResult {
  const topic = args.topic ?? (args.example !== undefined ? "example" : "grammar");
  if (topic !== "example") return text(docFor(topic).text());

  const name = args.example?.trim().replace(/\.page$/, "");
  if (!name) return text(`topic "example" needs \`example\`: one of ${EXAMPLE_NAMES.join(", ")}.`, true);
  const body = EXAMPLES[name];
  return body === undefined ? text(unknownExampleMessage(name), true) : text(body);
}

/**
 * The same text the micropage:// resources serve. It exists because many MCP
 * hosts never read resources, and a model without the grammar invents tags.
 */
export function registerReferenceTool(server: McpServer): void {
  server.registerTool(
    "get_markup_reference",
    {
      title: "Get the .page markup reference",
      description: `Return micropage reference text: the .page grammar, the full reference, the posts format, the agent editing guide, the example index, or one complete example file.

Call this before writing or editing .page markup (and before drafting a post), unless you already have the grammar in context. The vocabulary is closed: tags that are not in the grammar are not rendered, so never guess. Start with topic "grammar"; use "examples_index" then "example" to copy a layout close to what the user wants.

This mirrors the micropage://grammar, micropage://grammar/full, micropage://posts/format, micropage://agent-guide and micropage://examples/{name} resources, for hosts that do not read resources. Local and read-only: no network call, no account needed.`,
      inputSchema: GetMarkupReferenceInput,
      annotations: hints(RO, { openWorldHint: false }),
    },
    async (args) => runGetMarkupReference(args),
  );
}
