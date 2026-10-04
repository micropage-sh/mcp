/**
 * End-to-end over real MCP: spawn the stdio server, list what it advertises,
 * and check the invariants every tool must keep. Offline by default;
 * MICROPAGE_SMOKE_LIVE=1 also calls the read-only whoami and list_projects.
 *
 *   npm run smoke
 *   MICROPAGE_SMOKE_LIVE=1 npm run smoke
 */
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// A server with nothing registered in a category answers its list method
// with "method not found"; that is an empty list, not a failure.
async function listOrEmpty<T>(label: string, list: () => Promise<T[]>): Promise<T[]> {
  try {
    return await list();
  } catch (err) {
    console.log(`info  ${label}: none registered (${err instanceof Error ? err.message : String(err)})`);
    return [];
  }
}

const client = new Client({ name: "micropage-smoke", version: "0.0.0" });
await client.connect(
  new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/index.ts"],
    env: { ...process.env } as Record<string, string>,
  }),
);

const tools = await listOrEmpty("tools", async () => (await client.listTools()).tools);
const resources = await listOrEmpty("resources", async () => (await client.listResources()).resources);
const prompts = await listOrEmpty("prompts", async () => (await client.listPrompts()).prompts);

console.log(`tools (${tools.length}): ${tools.map((t) => t.name).join(", ") || "-"}`);
console.log(`resources (${resources.length}): ${resources.map((r) => r.uri).join(", ") || "-"}`);
console.log(`prompts (${prompts.length}): ${prompts.map((p) => p.name).join(", ") || "-"}`);

const shortDescriptions = tools.filter((t) => (t.description ?? "").length <= 120).map((t) => t.name);
check("every tool has a description over 120 chars", shortDescriptions.length === 0, shortDescriptions.join(", "));

const CONFIRM_INPUTS = ["confirm", "confirm_domain", "confirm_live_update", "confirmation_token"];
const unflagged = tools
  .filter((t) => {
    const props = Object.keys((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
    return props.some((p) => CONFIRM_INPUTS.includes(p));
  })
  .filter((t) => t.annotations?.destructiveHint !== true)
  .map((t) => t.name);
check("every tool with a confirm input is marked destructive", unflagged.length === 0, unflagged.join(", "));

const unannotated = tools
  .filter((t) => {
    const a = t.annotations ?? {};
    return [a.readOnlyHint, a.destructiveHint, a.idempotentHint, a.openWorldHint].some((h) => typeof h !== "boolean");
  })
  .map((t) => t.name);
check("every tool sets all four annotation hints", unannotated.length === 0, unannotated.join(", "));

// Opt-in: read-only calls against the account in the local CLI session.
if (process.env.MICROPAGE_SMOKE_LIVE === "1") {
  for (const name of ["whoami", "list_projects"]) {
    try {
      const res = await client.callTool({ name, arguments: {} });
      const detail = res.isError ? JSON.stringify(res.content).slice(0, 300) : "";
      check(`live: ${name} returns without isError`, res.isError !== true, detail);
    } catch (err) {
      check(`live: ${name} returns without isError`, false, err instanceof Error ? err.message : String(err));
    }
  }
} else {
  console.log("info  live calls skipped (set MICROPAGE_SMOKE_LIVE=1 to call whoami and list_projects)");
}

await client.close();
console.log(failures === 0 ? "\nOK" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
