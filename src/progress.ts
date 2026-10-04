import type { ServerContext } from "@modelcontextprotocol/server";

/**
 * Sends notifications/progress for the current request when the client asked
 * for it (a progressToken in _meta); a no-op otherwise. Never throws: a
 * dropped progress notification must not fail the tool call.
 */
export async function reportProgress(
  handlerCtx: ServerContext,
  progress: number,
  total?: number,
  message?: string,
): Promise<void> {
  const progressToken = handlerCtx.mcpReq._meta?.progressToken;
  if (progressToken === undefined) return;
  try {
    await handlerCtx.mcpReq.notify({
      method: "notifications/progress",
      params: {
        progressToken,
        progress,
        ...(total === undefined ? {} : { total }),
        ...(message === undefined ? {} : { message }),
      },
    });
  } catch {
    // best effort
  }
}
