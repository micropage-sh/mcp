import { McpServer, ResourceNotFoundError, ResourceTemplate } from "@modelcontextprotocol/server";

import { EXAMPLES } from "../content/index.js";
import {
  DOCS,
  EXAMPLE_NAMES,
  REFERENCE_CACHE_HINT,
  exampleSummary,
  exampleUri,
  unknownExampleMessage,
} from "./topics.js";

const EXAMPLE_MIME = "text/plain";

export function registerResources(server: McpServer): void {
  for (const doc of DOCS) {
    server.registerResource(
      doc.name,
      doc.uri,
      {
        title: doc.title,
        description: doc.description,
        mimeType: doc.mimeType,
        cacheHint: REFERENCE_CACHE_HINT,
      },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: doc.mimeType, text: doc.text() }] }),
    );
  }

  server.registerResource(
    "example",
    new ResourceTemplate("micropage://examples/{name}", {
      list: () => ({
        resources: EXAMPLE_NAMES.map((name) => ({
          uri: exampleUri(name),
          name: `example-${name}`,
          title: `Example: ${name}`,
          description: `${exampleSummary(name)}. A complete, valid .page example file to copy section layout and tag patterns from when writing markup.`,
          mimeType: EXAMPLE_MIME,
        })),
      }),
      complete: {
        name: (value) => EXAMPLE_NAMES.filter((n) => n.startsWith(value)),
      },
    }),
    {
      title: "Example .page file",
      description:
        "A complete, valid .page file to copy patterns from. {name} is one of the names in micropage://examples (e.g. startup-landing, portfolio, components-pricing-and-forms).",
      mimeType: EXAMPLE_MIME,
      cacheHint: REFERENCE_CACHE_HINT,
    },
    async (uri, variables) => {
      const raw = variables.name;
      const name = Array.isArray(raw) ? raw[0] : raw;
      const text = name === undefined ? undefined : EXAMPLES[name];
      if (text === undefined) throw new ResourceNotFoundError(uri.href, unknownExampleMessage(name ?? ""));
      return { contents: [{ uri: uri.href, mimeType: EXAMPLE_MIME, text }] };
    },
  );
}
