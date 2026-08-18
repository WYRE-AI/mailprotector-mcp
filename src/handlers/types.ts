import type { InputRequiredResult } from "@modelcontextprotocol/server";
import type { MailprotectorClient } from "@wyre-technology/node-mailprotector";
import type { ElicitationContext } from "../elicitation.js";
import type { ToolResult } from "./results.js";

/** Per-request handler context — client and reseller binding are per request. */
export interface HandlerContext {
  client: MailprotectorClient;
  /** The bound reseller id — the default `scope_id` when `scope` is "reseller". */
  resellerId: number;
  /** MRTR elicitation context, threaded in by the tools/call handler. */
  elicitation: ElicitationContext;
}

export type HandlerResult = ToolResult | InputRequiredResult;

export type ToolHandler = (
  ctx: HandlerContext,
  args: Record<string, unknown>
) => Promise<HandlerResult>;
