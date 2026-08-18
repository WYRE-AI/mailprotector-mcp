/**
 * tools/call dispatch. The SDK client is bound per request by the caller
 * (mcp-server.ts); this module maps tool names to handlers and normalizes
 * every failure into an isError text result — errors are never thrown out.
 */
import { MailprotectorError, type MailprotectorClient } from "@wyre-technology/node-mailprotector";
import { NO_ELICITATION, type ElicitationContext } from "../elicitation.js";
import { DISCOVERY_HANDLERS } from "./discovery.js";
import { PROMOTED_HANDLERS } from "./promoted.js";
import { errorResult, ToolInputError } from "./results.js";
import type { HandlerResult, ToolHandler } from "./types.js";

const HANDLERS: Record<string, ToolHandler> = {
  ...PROMOTED_HANDLERS,
  ...DISCOVERY_HANDLERS,
};

function describeVendorError(error: MailprotectorError): string {
  let body = "";
  if (error.response !== undefined && error.response !== null && error.response !== "") {
    try {
      body = ` Response: ${JSON.stringify(error.response)}`;
    } catch {
      body = "";
    }
  }
  return `Mailprotector error (HTTP ${error.statusCode}): ${error.message}.${body}`;
}

export async function handleToolCall(
  client: MailprotectorClient,
  resellerId: number,
  name: string,
  args: Record<string, unknown>,
  elicitation: ElicitationContext = NO_ELICITATION
): Promise<HandlerResult> {
  const handler = HANDLERS[name];
  if (!handler) {
    return errorResult(`Unknown tool: ${name}`);
  }
  try {
    return await handler({ client, resellerId, elicitation }, args);
  } catch (error) {
    if (error instanceof ToolInputError) {
      return errorResult(`Invalid arguments for ${name}: ${error.message}`);
    }
    if (error instanceof MailprotectorError) {
      return errorResult(describeVendorError(error));
    }
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(`Error calling ${name}: ${message}`);
  }
}
