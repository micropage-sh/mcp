#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createDeps } from "./node/deps.js";
import { createServerFactory } from "./server.js";

// stdout carries the protocol; diagnostics must go to stderr or the client
// sees a corrupted JSON-RPC stream.
const logError = (err: unknown): void => {
  console.error("[micropage-mcp]", err);
};

try {
  serveStdio(createServerFactory(createDeps()), { onerror: logError });
} catch (err) {
  console.error("[micropage-mcp] fatal:", err);
  process.exit(1);
}
